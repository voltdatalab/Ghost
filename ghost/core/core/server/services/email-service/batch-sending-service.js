const logging = require('@tryghost/logging');
const ObjectID = require('bson-objectid').default;
const crypto = require('node:crypto');
const errors = require('@tryghost/errors');
const {canonicalizeLegacyProofPayload, hashStringList, verifyLegacyProof} = require('./legacy-partial-resume-proof');
const tpl = require('@tryghost/tpl');
const messages = {
    emailErrorPartialFailure: 'An error occurred, and your newsletter was only partially sent. Please retry sending the remaining emails.',
    emailError: 'An unexpected error occurred, please retry sending your newsletter.'
};

const MAX_SENDING_CONCURRENCY = 2;
const SHUTDOWN_CODE = 'BULK_EMAIL_SHUTDOWN_IN_PROGRESS';
const LEGACY_PROXY_PUBLIC_KEY_CONFIG = 'bulkEmail:partialResume:legacyProxyPublicKey';
const LEGACY_PROOF_REVALIDATION_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Serializes a render contract by value rather than Bookshelf's relation/attribute
 * insertion order. Arrays intentionally preserve their order because segment order
 * is part of the send contract.
 *
 * @param {unknown} value
 * @returns {unknown}
 */
function canonicalizeRenderContract(value) {
    if (Array.isArray(value)) {
        return value.map(canonicalizeRenderContract);
    }
    if (value && typeof value === 'object') {
        if (typeof value.toJSON === 'function') {
            return canonicalizeRenderContract(value.toJSON());
        }
        return Object.fromEntries(Object.entries(value)
            .filter(([, entryValue]) => entryValue !== undefined)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, entryValue]) => [key, canonicalizeRenderContract(entryValue)]));
    }
    return value;
}

/**
 * @typedef {import('./sending-service')} SendingService
 * @typedef {import('./email-segmenter')} EmailSegmenter
 * @typedef {import('./email-renderer')} EmailRenderer
 * @typedef {import('./domain-warming-service').DomainWarmingService} DomainWarmingService
 * @typedef {import('./email-renderer').MemberLike} MemberLike
 * @typedef {object} JobsService
 * @typedef {object} Email
 * @typedef {object} Newsletter
 * @typedef {object} Post
 * @typedef {object} EmailBatch
 */

class BatchSendingService {
    #emailRenderer;
    #sendingService;
    #emailSegmenter;
    #domainWarmingService;
    #jobsService;
    #models;
    #db;
    #config;
    #sentry;
    #debugStorageFilePath;
    #getRequiredUrlRelations;
    #shuttingDown = false;
    #inFlight = new Set();

    // Retry database queries happening before sending the email
    #BEFORE_RETRY_CONFIG = {maxRetries: 10, maxTime: 10 * 60 * 1000, sleep: 2000};
    #AFTER_RETRY_CONFIG = {maxRetries: 20, maxTime: 30 * 60 * 1000, sleep: 2000};
    #MAILGUN_API_RETRY_CONFIG = {sleep: 10 * 1000, maxRetries: 6};

    /**
     * @param {Object} dependencies
     * @param {EmailRenderer} dependencies.emailRenderer
     * @param {SendingService} dependencies.sendingService
     * @param {JobsService} dependencies.jobsService
     * @param {EmailSegmenter} dependencies.emailSegmenter
     * @param {DomainWarmingService} dependencies.domainWarmingService
     * @param {object} dependencies.models
     * @param {object} dependencies.models.EmailRecipient
     * @param {EmailBatch} dependencies.models.EmailBatch
     * @param {Email} dependencies.models.Email
     * @param {object} dependencies.models.Member
     * @param {object} dependencies.db
     * @param {object} [dependencies.config]
     * @param {() => string[]} [dependencies.getRequiredUrlRelations] Post relations the live routes need loaded to generate URLs (lazy routing); defaults to none
     * @param {object} [dependencies.sentry]
     * @param {object} [dependencies.BEFORE_RETRY_CONFIG]
     * @param {object} [dependencies.AFTER_RETRY_CONFIG]
     * @param {object} [dependencies.MAILGUN_API_RETRY_CONFIG]
     * @param {string} [dependencies.debugStorageFilePath]
     */
    constructor({
        emailRenderer,
        sendingService,
        jobsService,
        emailSegmenter,
        domainWarmingService,
        models,
        db,
        config,
        sentry,
        getRequiredUrlRelations = () => [],
        BEFORE_RETRY_CONFIG,
        AFTER_RETRY_CONFIG,
        MAILGUN_API_RETRY_CONFIG,
        debugStorageFilePath
    }) {
        this.#emailRenderer = emailRenderer;
        this.#sendingService = sendingService;
        this.#jobsService = jobsService;
        this.#emailSegmenter = emailSegmenter;
        this.#domainWarmingService = domainWarmingService;
        this.#models = models;
        this.#db = db;
        this.#config = config;
        this.#sentry = sentry;
        this.#debugStorageFilePath = debugStorageFilePath;
        this.#getRequiredUrlRelations = getRequiredUrlRelations;

        if (BEFORE_RETRY_CONFIG) {
            this.#BEFORE_RETRY_CONFIG = BEFORE_RETRY_CONFIG;
        } else {
            if (process.env.NODE_ENV.startsWith('test') || process.env.NODE_ENV === 'development') {
                this.#BEFORE_RETRY_CONFIG = {maxRetries: 0};
            }
        }
        if (AFTER_RETRY_CONFIG) {
            this.#AFTER_RETRY_CONFIG = AFTER_RETRY_CONFIG;
        } else {
            if (process.env.NODE_ENV.startsWith('test') || process.env.NODE_ENV === 'development') {
                this.#AFTER_RETRY_CONFIG = {maxRetries: 0};
            }
        }

        if (MAILGUN_API_RETRY_CONFIG) {
            this.#MAILGUN_API_RETRY_CONFIG = MAILGUN_API_RETRY_CONFIG;
        } else {
            if (process.env.NODE_ENV.startsWith('test') || process.env.NODE_ENV === 'development') {
                this.#MAILGUN_API_RETRY_CONFIG = {maxRetries: 0};
            }
        }
    }

    #getBeforeRetryConfig(email) {
        if (email._retryCutOffTime) {
            return {...this.#BEFORE_RETRY_CONFIG, stopAfterDate: email._retryCutOffTime};
        }
        return this.#BEFORE_RETRY_CONFIG;
    }

    /**
     * Stops the batch workers and waits for any in-flight sends to finish.
     * Called by the cleanup pipeline when the container is shutting down. Idempotent.
     */
    async onShutdown() {
        this.#shuttingDown = true;
        if (this.#inFlight.size > 0) {
            logging.warn(`Email send shutdown: awaiting ${this.#inFlight.size} in-flight sendBatches call(s) to settle`);
        }
        await Promise.allSettled([...this.#inFlight]);
        logging.warn(`Email send shutdown: drain complete`);
    }

    /**
     * Schedules a background job that sends the email in the background.
     * Strict partial-resume jobs may only claim a durable pending partial
     * continuation; they deliberately never use the normal failed-email retry path.
     * @param {Email} email
     * @param {{partialResume?: boolean, partialResumeClaimed?: boolean, partialResumeClaim?: string}} [options]
     * @returns {Promise<unknown>}
     */
    scheduleEmail(email, {partialResume = false, partialResumeClaimed = false, partialResumeClaim} = {}) {
        // partialResumeClaimed remains readable for jobs serialized by the earlier
        // recovery protocol; both partial job forms stay out of normal retries.
        const data = {emailId: email.id, partialResume, partialResumeClaimed};
        if (typeof partialResumeClaim === 'string' && partialResumeClaim.length > 0) {
            data.partialResumeClaim = partialResumeClaim;
        }
        return this.#jobsService.addJob({
            name: 'batch-sending-service-job',
            job: this.emailJob.bind(this),
            data,
            offloaded: false
        });
    }

    /**
     * @private
     * @param {{emailId: string, partialResume?: boolean, partialResumeClaimed?: boolean, partialResumeClaim?: string}} data Data passed from the job service. The flags select the durable CAS contract before the email is refetched and locked.
     */
    async emailJob({emailId, partialResume = false, partialResumeClaimed = false, partialResumeClaim}) {
        logging.info(`Starting email job for email ${emailId}`);

        const startTime = Date.now();
        const isPartialResumeJob = partialResume || partialResumeClaimed;
        const allowedStatuses = partialResumeClaimed
            ? ['submitting']
            : ['pending'];
        // A claimed recovery job carries the fresh enqueue token written by the
        // scanner. Older serialized claimed jobs have no token and can only adopt
        // the pre-token state (both internal claim and error are null).
        const expectedError = isPartialResumeJob ? null : undefined;
        const expectedPartialResumeEnqueueClaim = partialResumeClaimed
            ? (typeof partialResumeClaim === 'string' && partialResumeClaim.length > 0 ? partialResumeClaim : null)
            : (partialResume ? null : undefined);
        const lockOptions = isPartialResumeJob
            ? {
                expectedPartialResume: true,
                expectedError,
                expectedPartialResumeEnqueueClaim
            }
            : undefined;
        // Replace the enqueue token with a distinct worker-owned token before
        // dispatch. Recovery will not requeue a submitting partial row while a
        // non-null token says that a job owns it.
        const lockData = isPartialResumeJob
            ? {
                error: null,
                partial_resume_enqueue_claim: crypto.randomUUID()
            }
            : {};

        // Strict partial jobs always claim the exact durable state. A boot scanner
        // may schedule the same row more than once, but only the job holding the
        // marker can clear it and send; an ambiguously queued job cannot retry
        // from failed or steal a live worker's claim.
        let email = await this.retryDb(
            async () => {
                return await this.updateStatusLock(
                    this.#models.Email,
                    emailId,
                    'submitting',
                    allowedStatuses,
                    lockData,
                    lockOptions
                );
            },
            {...this.#BEFORE_RETRY_CONFIG, description: `updateStatusLock email ${emailId} ${partialResumeClaimed ? '(partial already claimed)' : '-> submitting'}`}
        );
        if (!email) {
            const expectedState = partialResumeClaimed
                ? 'was not in the expected claimed state'
                : (partialResume ? 'was not a pending partial continuation' : 'is not pending');
            logging.error(`Tried sending email that ${expectedState} ${emailId}`);
            return;
        }
        if (isPartialResumeJob && email.get('partial_resume') !== true) {
            logging.error(`Tried running an already-claimed partial continuation for a non-partial email ${emailId}`);
            return;
        }

        // We'll stop all automatic DB retries after this date
        const expectedBatchCount = Math.ceil(email.get('email_count') / 1000);
        const minimumSecondsPerBatch = 26; // In case of database issues, we make sure we expand the retry window relative to the amount of batches
        const stopAfter = Math.max(expectedBatchCount * minimumSecondsPerBatch * 1000, this.#BEFORE_RETRY_CONFIG.maxTime);
        const retryCutOffTime = new Date(startTime + stopAfter);

        // Save a strict cutoff time for retries
        email._retryCutOffTime = retryCutOffTime;

        const isPartialResume = email.get('partial_resume') === true;
        // Partial workers always install a fresh token in the CAS above. Terminal
        // writes must retain that ownership predicate: a stale scanner may have
        // already failed the row while a slow worker was still winding down.
        const partialResumeWorkerClaim = isPartialResume
            ? email.get('partial_resume_enqueue_claim')
            : undefined;

        try {
            if (isPartialResume) {
                await this.sendPartialEmail(email);
            } else {
                await this.sendEmail(email);
            }
            if (isPartialResume) {
                const completed = await this.retryDb(async () => {
                    return await this.updateStatusLock(
                        this.#models.Email,
                        emailId,
                        'submitted',
                        ['submitting'],
                        {
                            submitted_at: new Date(),
                            error: null,
                            partial_resume: false,
                            partial_resume_enqueue_claim: null
                        },
                        {
                            expectedPartialResume: true,
                            expectedError: null,
                            expectedPartialResumeEnqueueClaim: partialResumeWorkerClaim
                        }
                    );
                }, {...this.#AFTER_RETRY_CONFIG, description: `partial email ${emailId} -> submitted`});
                if (!completed) {
                    logging.warn('Partial email completion claim was already changed; leaving it for fail-closed recovery');
                }
            } else {
                await this.retryDb(async () => {
                    await email.save({
                        status: 'submitted',
                        submitted_at: new Date(),
                        error: null,
                        partial_resume: false,
                        partial_resume_enqueue_claim: null
                    }, {patch: true, autoRefresh: false});
                }, {...this.#AFTER_RETRY_CONFIG, description: `email ${emailId} -> submitted`});
            }
        } catch (e) {
            if (e && e.code === SHUTDOWN_CODE) {
                // A partial worker owns a generation-specific token while it is
                // dispatching. Before an orderly shutdown leaves the row in
                // `submitting`, release only that exact token. The next boot can
                // then claim and resume it; a failed release remains fail-closed
                // because recovery will never adopt an unknown live token.
                if (isPartialResume) {
                    const workerClaim = email.get('partial_resume_enqueue_claim');
                    try {
                        const released = await this.retryDb(async () => {
                            return await this.updateStatusLock(
                                this.#models.Email,
                                emailId,
                                'submitting',
                                ['submitting'],
                                {partial_resume_enqueue_claim: null},
                                {
                                    expectedPartialResume: true,
                                    expectedError: null,
                                    expectedPartialResumeEnqueueClaim: workerClaim
                                }
                            );
                        }, {...this.#AFTER_RETRY_CONFIG, description: `release partial email ${emailId} claim for shutdown`});
                        if (!released) {
                            logging.warn('Partial email shutdown claim was already changed; leaving it for fail-closed recovery');
                        }
                    } catch (releaseError) {
                        logging.error('Could not release partial email shutdown claim; leaving it for fail-closed recovery');
                    }
                }
                logging.info(`Email ${email.id} send stopped because the container is shutting down — leaving status=submitting so it can resume on next boot`);
                return;
            }
            const ghostError = new errors.EmailError({
                err: e,
                code: 'BULK_EMAIL_SEND_FAILED',
                message: `Error sending email ${email.id}`
            });

            logging.error(ghostError);
            if (this.#sentry) {
                // Log the original error to Sentry
                this.#sentry.captureException(e);
            }

            // Store error and status in email model. A partial worker must still
            // own its exact generation; otherwise a stale scanner's fail-closed
            // state wins and this late worker cannot resurrect it.
            if (isPartialResume) {
                const failed = await this.retryDb(async () => {
                    return await this.updateStatusLock(
                        this.#models.Email,
                        emailId,
                        'failed',
                        ['submitting'],
                        {
                            error: e.message || 'Something went wrong while sending the email',
                            partial_resume_enqueue_claim: null
                        },
                        {
                            expectedPartialResume: true,
                            expectedError: null,
                            expectedPartialResumeEnqueueClaim: partialResumeWorkerClaim
                        }
                    );
                }, {...this.#AFTER_RETRY_CONFIG, description: `partial email ${emailId} -> failed`});
                if (!failed) {
                    logging.warn('Partial email failure claim was already changed; leaving it for fail-closed recovery');
                }
            } else {
                await this.retryDb(async () => {
                    await email.save({
                        status: 'failed',
                        error: e.message || 'Something went wrong while sending the email',
                        partial_resume_enqueue_claim: null
                    }, {patch: true, autoRefresh: false});
                }, {...this.#AFTER_RETRY_CONFIG, description: `email ${emailId} -> failed`});
            }
        }
    }

    /**
     * @private
     * @param {Email} email
     * @throws {errors.EmailError} If one of the batches fails
     */
    async sendEmail(email) {
        logging.info(`Sending email ${email.id}`);

        const {newsletter, post} = await this.#getEmailRelations(email);

        let batches = await this.retryDb(async () => {
            return await this.getBatches(email);
        }, {...this.#getBeforeRetryConfig(email), description: `getBatches for email ${email.id}`});

        if (batches.length === 0) {
            batches = await this.createBatches({email, newsletter, post});
        }
        await this.sendBatches({email, batches, post, newsletter});
    }

    /**
     * Returns only after the current state is a safe candidate for an explicit
     * partial continuation. This is deliberately separate from retryEmail: a
     * partial continuation may start only from an already-submitted email.
     *
     * @param {Email} email
     * @returns {Promise<{missingRecipientCount: number, renderHash: string}>}
     */
    async assertCanStartPartialResume(email) {
        const {newsletter, post} = await this.#getEmailRelations(email);
        this.#assertPartialResumeRelationsAreSafe(email, newsletter, post);
        const batches = await this.getBatches(email);
        await this.#assertPartialResumeBatchesAreSafe(email, batches);
        const snapshot = await this.#createPartialResumeRenderSnapshot(email, newsletter, post);
        this.#assertPartialResumeRenderHashIsSafe(email, snapshot.renderHash);

        const missingRecipientCount = await this.getMissingRecipientCount({email, newsletter, post: snapshot.post});
        if (missingRecipientCount === 0) {
            throw new errors.BadRequestError({
                message: `Email ${email.id} has no eligible recipients left to resume`
            });
        }

        return {missingRecipientCount, renderHash: snapshot.renderHash};
    }

    /**
     * Continues an explicitly-marked partial email. The marker is persisted on
     * the email before this job runs, so a clean shutdown can return through this
     * same anti-join path on the next boot.
     *
     * @param {Email} email
     */
    async sendPartialEmail(email) {
        logging.info(`Continuing partial email ${email.id}`);

        const {newsletter, post} = await this.#getEmailRelations(email);
        this.#assertPartialResumeRelationsAreSafe(email, newsletter, post);
        const existingBatches = await this.retryDb(async () => {
            return await this.getBatches(email);
        }, {...this.#getBeforeRetryConfig(email), description: `get existing batches for partial email ${email.id}`});
        await this.#assertPartialResumeBatchesAreSafe(email, existingBatches);
        const snapshot = await this.#createPartialResumeRenderSnapshot(email, newsletter, post);
        this.#assertPartialResumeRenderHashIsSafe(email, snapshot.renderHash);

        const existingRecipientCount = await this.retryDb(async () => {
            return await this.getRecipientCount(email);
        }, {...this.#getBeforeRetryConfig(email), description: `get existing recipient count for partial email ${email.id}`});

        // This query is an anti-join against the persistent recipient ledger. It
        // creates only rows that are absent from this email, never an entire
        // audience replacement.
        await this.createBatches({
            email,
            newsletter,
            post: snapshot.post,
            excludeExistingRecipients: true,
            existingRecipientCount
        });

        const currentBatches = await this.retryDb(async () => {
            return await this.getBatches(email);
        }, {...this.#getBeforeRetryConfig(email), description: `get continuation batches for partial email ${email.id}`});

        // `pending` + no provider id is the only state that is unambiguously safe
        // to send. Submitted batches remain part of the ledger but are never put
        // back into the send queue; ambiguous and failed states were rejected above.
        const batchesToSend = currentBatches.filter((batch) => {
            return batch.get('status') === 'pending' && !batch.get('provider_id');
        });
        if (batchesToSend.length === 0) {
            logging.info(`Partial email ${email.id} has no safely unsent batches after materialization`);
            return;
        }

        await this.sendBatches({email, batches: batchesToSend, post: snapshot.post, newsletter, emailSnapshot: snapshot.emailSnapshot});
    }

    /**
     * @private
     * @param {Email} email
     * @returns {Promise<{newsletter: Newsletter, post: Post}>}
     */
    async #getEmailRelations(email) {
        const newsletter = await this.retryDb(async () => {
            return await email.getLazyRelation('newsletter', {require: true});
        }, {...this.#getBeforeRetryConfig(email), description: `getLazyRelation newsletter for email ${email.id}`});

        // 'tiers' is required by the email tier-gating logic (renderer/segmenter), not for URL generation
        const postRelations = [...new Set(['posts_meta', 'authors', 'tiers', ...this.#getRequiredUrlRelations()])];
        const post = await this.retryDb(async () => {
            return await email.getLazyRelation('post', {require: true, withRelated: postRelations});
        }, {...this.#getBeforeRetryConfig(email), description: `getLazyRelation post for email ${email.id}`});

        return {newsletter, post};
    }

    /**
     * @private
     * @param {Email} email
     * @param {Newsletter} newsletter
     * @param {Post} post
     */
    #assertPartialResumeRelationsAreSafe(email, newsletter, post) {
        const postStatus = post.get('status');
        if (postStatus !== 'published' && postStatus !== 'sent') {
            throw new errors.BadRequestError({
                message: `Email ${email.id} belongs to a post with non-sendable status=${postStatus}`
            });
        }
        if (newsletter.get('status') !== 'active') {
            throw new errors.BadRequestError({
                message: `Email ${email.id} belongs to an inactive newsletter`
            });
        }
    }

    #partialResumeSafetyError(email) {
        return new errors.BadRequestError({
            message: `Email ${email.id} cannot be safely continued; reconcile its immutable partial-resume evidence before continuing`
        });
    }

    #assertPartialResumeRenderHashIsSafe(email, renderHash) {
        if (typeof renderHash !== 'string' || !/^[a-f0-9]{64}$/.test(renderHash)) {
            throw this.#partialResumeSafetyError(email);
        }

        const storedRenderHash = email.get('partial_resume_render_hash');
        if (email.get('partial_resume') === true) {
            if (storedRenderHash !== renderHash) {
                throw this.#partialResumeSafetyError(email);
            }
        } else if (storedRenderHash !== null && storedRenderHash !== undefined) {
            // A completed partial continuation retains its hash. It must never be
            // silently re-opened as a fresh continuation with a different contract.
            throw this.#partialResumeSafetyError(email);
        }
    }

    async #createPartialResumeRenderSnapshot(email, newsletter, post) {
        const source = email.get('source');
        const sourceType = email.get('source_type');
        if (typeof source !== 'string' || source.length === 0 || !['lexical', 'mobiledoc'].includes(sourceType) || typeof post.clone !== 'function') {
            throw this.#partialResumeSafetyError(email);
        }

        const snapshot = post.clone();
        if (!snapshot || typeof snapshot.set !== 'function' || typeof snapshot.get !== 'function') {
            throw this.#partialResumeSafetyError(email);
        }
        // Bookshelf clones attributes but not necessarily eager-loaded relations. The
        // renderer reads posts_meta/authors/tiers/URLs from those relations, so retain
        // their immutable in-memory references on the otherwise unsaved snapshot.
        if (post.relations && typeof post.relations === 'object') {
            snapshot.relations = {...post.relations};
        }
        snapshot.set({
            lexical: sourceType === 'lexical' ? source : null,
            mobiledoc: sourceType === 'mobiledoc' ? source : null,
            html: null,
            plaintext: null
        });

        const subject = email.get('subject');
        const from = email.get('from');
        const replyTo = email.get('reply_to') ?? null;
        if (typeof subject !== 'string' || subject.length === 0 ||
            typeof from !== 'string' || from.length === 0 ||
            (replyTo !== null && typeof replyTo !== 'string')) {
            throw this.#partialResumeSafetyError(email);
        }

        const expectedSubject = this.#emailRenderer.getSubject(snapshot, false);
        const expectedFrom = this.#emailRenderer.getFromAddress(snapshot, newsletter, false);
        const expectedReplyTo = this.#emailRenderer.getReplyToAddress(snapshot, newsletter, false) ?? null;
        if (subject !== expectedSubject || from !== expectedFrom || replyTo !== expectedReplyTo) {
            throw this.#partialResumeSafetyError(email);
        }

        const clickTrackingEnabled = !!email.get('track_clicks');
        const openTrackingEnabled = !!email.get('track_opens');
        const segments = await this.#emailRenderer.getSegments(snapshot);
        if (!Array.isArray(segments) || segments.length === 0) {
            throw this.#partialResumeSafetyError(email);
        }

        const seenSegments = new Set();
        const renderedSegments = [];
        for (const segment of segments) {
            if (segment !== null && typeof segment !== 'string') {
                throw this.#partialResumeSafetyError(email);
            }
            const segmentKey = JSON.stringify(segment);
            if (seenSegments.has(segmentKey)) {
                throw this.#partialResumeSafetyError(email);
            }
            seenSegments.add(segmentKey);

            // Click tracking allocates a fresh redirect for every render. The
            // integrity snapshot must be read-only and deterministic; preserve the
            // user's tracking choice in `contract.tracking`, but hash the body
            // before that per-render redirect allocation. The worker later renders
            // the actual tail with click tracking enabled as configured.
            const body = await this.#emailRenderer.renderBody(snapshot, newsletter, segment, {clickTrackingEnabled: false});
            if (!body || typeof body.html !== 'string' || typeof body.plaintext !== 'string' || !Array.isArray(body.replacements) ||
                body.replacements.some(replacement => !replacement || typeof replacement.id !== 'string' || replacement.id.length === 0)) {
                throw this.#partialResumeSafetyError(email);
            }
            renderedSegments.push({
                segment,
                html_hash: crypto.createHash('sha256').update(body.html, 'utf8').digest('hex'),
                plaintext_hash: crypto.createHash('sha256').update(body.plaintext, 'utf8').digest('hex'),
                replacement_ids: body.replacements.map(replacement => replacement.id)
            });
        }

        const newsletterSnapshot = typeof newsletter.toJSON === 'function' ? newsletter.toJSON() : undefined;
        if (!newsletterSnapshot || typeof newsletterSnapshot !== 'object') {
            throw this.#partialResumeSafetyError(email);
        }
        const postMeta = typeof snapshot.related === 'function' ? snapshot.related('posts_meta') : undefined;
        const contract = {
            version: 1,
            source_type: sourceType,
            source_hash: crypto.createHash('sha256').update(source, 'utf8').digest('hex'),
            post_title: snapshot.get('title') ?? null,
            post_email_subject: postMeta?.get?.('email_subject') ?? null,
            headers: {subject, from, reply_to: replyTo},
            expected_headers: {subject: expectedSubject, from: expectedFrom, reply_to: expectedReplyTo},
            newsletter: newsletterSnapshot,
            tracking: {clicks: clickTrackingEnabled, opens: openTrackingEnabled},
            segments: renderedSegments
        };
        const serializedContract = JSON.stringify(canonicalizeRenderContract(contract));
        if (typeof serializedContract !== 'string') {
            throw this.#partialResumeSafetyError(email);
        }

        return {
            post: snapshot,
            emailSnapshot: {subject, from, replyTo: replyTo ?? undefined},
            renderHash: crypto.createHash('sha256').update(serializedContract, 'utf8').digest('hex')
        };
    }

    /**
     * Fails closed if a batch could have reached the provider without a durable
     * submitted status, or if the original email has no confirmed prefix.
     *
     * @private
     * @param {Email} email
     * @param {EmailBatch[]} batches
     */
    async #assertPartialResumeBatchesAreSafe(email, batches) {
        const confirmedBatches = batches.filter(batch => batch.get('status') === 'submitted' && batch.get('provider_id'));
        if (confirmedBatches.length === 0) {
            throw this.#partialResumeSafetyError(email);
        }

        const unsafeBatch = batches.find((batch) => {
            const status = batch.get('status');
            const providerId = batch.get('provider_id');
            return typeof batch.id !== 'string' || batch.get('email_id') !== email.id ||
                (status === 'submitted' && !providerId) ||
                (status === 'pending' && providerId) ||
                !['submitted', 'pending'].includes(status);
        });
        if (unsafeBatch) {
            throw this.#partialResumeSafetyError(email);
        }

        const batchesWithoutNativeManifest = batches.filter(batch => !this.#hasValidRecipientManifest(batch));
        const providerIds = confirmedBatches.map(batch => batch.get('provider_id'));
        const hasSharedProviderId = new Set(providerIds).size !== providerIds.length;
        const requiresLegacyProof = batchesWithoutNativeManifest.length > 0 || hasSharedProviderId;
        let legacyProof;

        // A proof may exist even after a legacy row has gained a manifest. Always
        // revalidate one when the shared DB is available so signed IDs keep their
        // stricter provider identity rule; native-only emails still need no proof.
        if (requiresLegacyProof || (this.#db && typeof this.#db.knex === 'function')) {
            legacyProof = await this.#loadPersistedLegacyPartialResumeProof(email);
        }
        if (requiresLegacyProof && !legacyProof) {
            throw this.#partialResumeSafetyError(email);
        }

        if (legacyProof) {
            const legacyBatchIds = new Set(legacyProof.legacy_batch_ids);
            const signedBatches = batches.filter(batch => legacyBatchIds.has(batch.id));
            if (signedBatches.length !== legacyBatchIds.size ||
                batchesWithoutNativeManifest.some(batch => !legacyBatchIds.has(batch.id)) ||
                signedBatches.some(batch => batch.get('status') !== 'submitted' || batch.get('provider_id') !== email.id)) {
                throw this.#partialResumeSafetyError(email);
            }

            // Before the first CAS, the signed prefix must be the complete existing
            // ledger. Recovery may additionally contain only manifest-backed batches.
            if (email.get('partial_resume') !== true &&
                (batches.length !== legacyBatchIds.size || batches.some(batch => !legacyBatchIds.has(batch.id)))) {
                throw this.#partialResumeSafetyError(email);
            }
        }

        await this.#assertConfirmedBatchRecipientLedgersAreIntact(email, batches, confirmedBatches, legacyProof);
    }

    #hasValidRecipientManifest(batch) {
        return Number.isSafeInteger(Number(batch.get('recipient_count'))) && Number(batch.get('recipient_count')) > 0 &&
            typeof batch.get('recipient_hash') === 'string' && /^[a-f0-9]{64}$/.test(batch.get('recipient_hash'));
    }

    async #loadPersistedLegacyPartialResumeProof(email) {
        if (!this.#db || typeof this.#db.knex !== 'function') {
            throw this.#partialResumeSafetyError(email);
        }
        const rows = await this.#db.knex('email_partial_resume_proofs')
            .select('email_id', 'proof_payload', 'proof_hash', 'signature', 'signing_key_fingerprint', 'transport')
            .where('email_id', email.id);
        if (!Array.isArray(rows)) {
            throw this.#partialResumeSafetyError(email);
        }
        if (rows.length === 0) {
            return null;
        }
        if (rows.length !== 1) {
            throw this.#partialResumeSafetyError(email);
        }

        const row = rows[0];
        if (!row || row.email_id !== email.id || typeof row.proof_payload !== 'string' ||
            typeof row.proof_hash !== 'string' || !/^[a-f0-9]{64}$/.test(row.proof_hash) ||
            typeof row.signature !== 'string' || typeof row.signing_key_fingerprint !== 'string' ||
            !/^[a-f0-9]{64}$/.test(row.signing_key_fingerprint) || typeof row.transport !== 'string') {
            throw this.#partialResumeSafetyError(email);
        }

        let proof;
        let canonicalProof;
        try {
            proof = JSON.parse(row.proof_payload);
            canonicalProof = canonicalizeLegacyProofPayload(proof);
        } catch {
            throw this.#partialResumeSafetyError(email);
        }
        if (canonicalProof.payloadJson !== row.proof_payload ||
            crypto.createHash('sha256').update(row.proof_payload, 'utf8').digest('hex') !== row.proof_hash ||
            canonicalProof.payload.email_id !== email.id || canonicalProof.payload.transport !== row.transport) {
            throw this.#partialResumeSafetyError(email);
        }

        const publicKey = this.#config?.get?.(LEGACY_PROXY_PUBLIC_KEY_CONFIG);
        if (typeof publicKey !== 'string' || publicKey.length === 0) {
            throw this.#partialResumeSafetyError(email);
        }

        let verifiedProof;
        try {
            // Freshness was enforced at immutable admission time. Re-verification
            // here anchors the persisted signature to the configured public key
            // without expiring an already-admitted continuation while it is queued.
            verifiedProof = verifyLegacyProof({
                proof: canonicalProof.payload,
                signature: row.signature,
                publicKey,
                now: new Date(canonicalProof.payload.issued_at),
                maxAgeMs: LEGACY_PROOF_REVALIDATION_MAX_AGE_MS
            });
        } catch {
            throw this.#partialResumeSafetyError(email);
        }
        if (verifiedProof.payloadJson !== row.proof_payload || verifiedProof.signingKeyFingerprint !== row.signing_key_fingerprint) {
            throw this.#partialResumeSafetyError(email);
        }

        return verifiedProof.payload;
    }

    /**
     * Proves that the durable recipient ledger for every batch already accepted
     * by the provider still matches the manifest captured before that batch was
     * sent. Without this check, a deleted prefix row is indistinguishable from
     * an unmaterialized tail to an anti-join and could be sent twice.
     *
     * @private
     * @param {Email} email
     * @param {EmailBatch[]} batches
     * @param {EmailBatch[]} confirmedBatches
     * @param {object|undefined} legacyProof
     */
    async #assertConfirmedBatchRecipientLedgersAreIntact(email, batches, confirmedBatches, legacyProof) {
        const recipientIdsByBatch = new Map(batches.map(batch => [batch.id, []]));
        const recipientEmailsByBatch = new Map(batches.map(batch => [batch.id, []]));
        const recipientTuplesByBatch = new Map(batches.map(batch => [batch.id, []]));
        const recipients = await this.#db.knex('email_recipients')
            .select('batch_id', 'member_id', 'member_email')
            .where('email_id', email.id);
        if (!Array.isArray(recipients)) {
            throw this.#partialResumeSafetyError(email);
        }

        const memberIds = new Set();
        for (const recipient of recipients) {
            const recipientIds = recipientIdsByBatch.get(recipient?.batch_id);
            const recipientEmails = recipientEmailsByBatch.get(recipient?.batch_id);
            const recipientTuples = recipientTuplesByBatch.get(recipient?.batch_id);
            if (!recipientIds || !recipientEmails || !recipientTuples || typeof recipient.member_id !== 'string' || recipient.member_id.length === 0 ||
                typeof recipient.member_email !== 'string' || recipient.member_email.length === 0 ||
                memberIds.has(recipient.member_id)) {
                throw this.#partialResumeSafetyError(email);
            }
            memberIds.add(recipient.member_id);
            recipientIds.push(recipient.member_id);
            recipientEmails.push(recipient.member_email);
            recipientTuples.push(`${recipient.batch_id}\u0000${recipient.member_id}\u0000${recipient.member_email}`);
        }

        const legacyBatchIds = legacyProof ? new Set(legacyProof.legacy_batch_ids) : new Set();
        for (const batch of batches) {
            const recipientIds = recipientIdsByBatch.get(batch.id);
            if (!recipientIds) {
                throw this.#partialResumeSafetyError(email);
            }
            if (legacyBatchIds.has(batch.id)) {
                continue;
            }
            const actualManifest = this.#createRecipientManifest(recipientIds);
            if (!this.#hasValidRecipientManifest(batch) || actualManifest.recipientCount !== Number(batch.get('recipient_count')) ||
                actualManifest.recipientHash !== batch.get('recipient_hash')) {
                throw this.#partialResumeSafetyError(email);
            }
        }

        for (const batch of confirmedBatches) {
            if (!legacyBatchIds.has(batch.id) && !this.#hasValidRecipientManifest(batch)) {
                throw this.#partialResumeSafetyError(email);
            }
        }

        if (legacyProof) {
            const legacyMemberIds = [];
            const legacyMemberEmails = [];
            const legacyRecipientTuples = [];
            for (const batchId of legacyProof.legacy_batch_ids) {
                const recipientIds = recipientIdsByBatch.get(batchId);
                const recipientEmails = recipientEmailsByBatch.get(batchId);
                const recipientTuples = recipientTuplesByBatch.get(batchId);
                if (!recipientIds || !recipientEmails || !recipientTuples) {
                    throw this.#partialResumeSafetyError(email);
                }
                legacyMemberIds.push(...recipientIds);
                legacyMemberEmails.push(...recipientEmails);
                legacyRecipientTuples.push(...recipientTuples);
            }
            if (legacyMemberIds.length !== legacyProof.ledger_member_count ||
                legacyMemberEmails.length !== legacyProof.ledger_email_count ||
                hashStringList(legacyMemberIds) !== legacyProof.ledger_member_hash ||
                hashStringList(legacyMemberEmails) !== legacyProof.ledger_email_hash ||
                hashStringList(legacyRecipientTuples) !== legacyProof.ledger_binding_hash) {
                throw this.#partialResumeSafetyError(email);
            }
        }
    }

    /**
     * @private
     * @param {string[]} memberIds
     * @returns {{recipientCount: number, recipientHash: string}}
     */
    #createRecipientManifest(memberIds) {
        const canonicalMemberIds = [...memberIds].sort();
        return {
            recipientCount: canonicalMemberIds.length,
            recipientHash: crypto.createHash('sha256').update(JSON.stringify(canonicalMemberIds)).digest('hex')
        };
    }

    /**
     * Counts the current eligible audience that has no recipient row for this
     * email. It is used by the explicit entrypoint only; the job re-runs the
     * anti-join itself to tolerate legitimate opt-outs before dispatch.
     *
     * @param {{email: Email, newsletter: Newsletter, post: Post}} data
     * @returns {Promise<number>}
     */
    async getMissingRecipientCount({email, newsletter, post}) {
        const segments = await this.#emailRenderer.getSegments(post);
        let total = 0;

        for (const segment of segments) {
            const segmentFilter = this.#emailSegmenter.getMemberFilterForSegment(newsletter, email.get('recipient_filter'), segment);
            const query = this.#getMembersQuery({
                filter: segmentFilter + `+id:<'${email.id}'`,
                emailId: email.id,
                excludeExistingRecipients: true
            });
            const row = await query.clearSelect().countDistinct({count: 'members.id'}).first();
            const count = Number(row?.count ?? 0);
            if (!Number.isSafeInteger(count) || count < 0) {
                throw new errors.InternalServerError({
                    message: `Could not count missing recipients for email ${email.id}`
                });
            }
            total += count;
        }

        return total;
    }

    /**
     * @private
     * @param {Email} email
     * @returns {Promise<number>}
     */
    async getRecipientCount(email) {
        const row = await this.#db.knex('email_recipients')
            .where('email_id', email.id)
            .count({count: 'id'})
            .first();
        const count = Number(row?.count ?? 0);
        if (!Number.isSafeInteger(count) || count < 0) {
            throw new errors.InternalServerError({
                message: `Could not count persisted recipients for email ${email.id}`
            });
        }
        return count;
    }

    /**
     * @private
     * @param {{filter: string, emailId: string, excludeExistingRecipients: boolean}} data
     */
    #getMembersQuery({filter, emailId, excludeExistingRecipients}) {
        const query = this.#models.Member.getFilteredCollectionQuery({filter});
        if (excludeExistingRecipients) {
            query.whereNotExists((recipientsQuery) => {
                recipientsQuery
                    .select(this.#db.knex.raw('1'))
                    .from('email_recipients')
                    .where('email_recipients.email_id', emailId)
                    .whereRaw('email_recipients.member_id = members.id');
            });
        }
        return query;
    }

    /**
     * @private
     * @param {Email} email
     * @returns {Promise<EmailBatch[]>}
     */
    async getBatches(email) {
        logging.info(`Getting batches for email ${email.id}`);

        // findAll returns a bookshelf collection, we want to return a plain array to align with the createBatches method
        const batches = await this.#models.EmailBatch.findAll({filter: 'email_id:\'' + email.id + '\''});
        return batches.models;
    }

    /**
     * @private
     * @param {{email: Email, newsletter: Newsletter, post: Post, excludeExistingRecipients?: boolean, existingRecipientCount?: number}} data
     * @returns {Promise<EmailBatch[]>}
     */
    async createBatches({email, post, newsletter, excludeExistingRecipients = false, existingRecipientCount = 0}) {
        logging.info(`Creating batches for email ${email.id}`);

        // Infinity implies all emails should be sent from the primary domain
        let domainWarmupLimit = Infinity;
        if (this.#domainWarmingService.isEnabled()) {
            domainWarmupLimit = Number.isInteger(email.get('csd_email_count')) ? email.get('csd_email_count') : Infinity;
        }

        const segments = await this.#emailRenderer.getSegments(post);
        const batches = [];
        const BATCH_SIZE = this.#sendingService.getMaximumRecipients();
        let totalCount = existingRecipientCount;
        const initialRecipientCount = totalCount;

        for (const segment of segments) {
            logging.info(`Creating batches for email ${email.id} segment ${segment}`);

            const segmentFilter = this.#emailSegmenter.getMemberFilterForSegment(newsletter, email.get('recipient_filter'), segment);

            // Avoiding Bookshelf for performance reasons
            let members;

            // Start with the id of the email, which is an objectId. We'll only fetch members that are created before the email. This is a special property of ObjectIds.
            // Note: we use ID and not created_at, because imported members could set a created_at in the future or past and avoid limit checking.
            let lastId = email.id;

            while (!members || lastId) {
                logging.info(`Fetching members batch for email ${email.id} segment ${segment}, lastId: ${lastId}`);

                const filter = segmentFilter + `+id:<'${lastId}'`;
                logging.info(`Fetching members batch for email ${email.id} segment ${segment}, lastId: ${lastId} ${filter}`);

                members = await this.#getMembersQuery({
                    filter,
                    emailId: email.id,
                    excludeExistingRecipients
                })
                    .orderByRaw('id DESC')
                    .select('members.id', 'members.uuid', 'members.email', 'members.name').limit(BATCH_SIZE + 1);

                if (members.length > 0) {
                    // Determine how many members to include in this batch
                    const remainingCustomDomainCapacity = domainWarmupLimit - totalCount;
                    const membersToProcess = Math.min(members.length, BATCH_SIZE);

                    const shouldSplitBatch = remainingCustomDomainCapacity > 0 && remainingCustomDomainCapacity < membersToProcess;
                    if (shouldSplitBatch) {
                        // Split batch: some via custom domain, rest via fallback
                        totalCount += await this.#createBatchWithRetry({
                            email,
                            segment,
                            members: members.slice(0, remainingCustomDomainCapacity),
                            useFallbackDomain: false,
                            batches
                        });
                        totalCount += await this.#createBatchWithRetry({
                            email,
                            segment,
                            members: members.slice(remainingCustomDomainCapacity, membersToProcess),
                            useFallbackDomain: true,
                            batches
                        });
                    } else {
                        // Single batch: all members use same domain
                        totalCount += await this.#createBatchWithRetry({
                            email,
                            segment,
                            members: members.slice(0, membersToProcess),
                            useFallbackDomain: totalCount >= domainWarmupLimit,
                            batches
                        });
                    }
                }

                if (members.length > BATCH_SIZE) {
                    lastId = members[members.length - 2].id;
                } else {
                    break;
                }
            }
        }

        const createdRecipientCount = totalCount - initialRecipientCount;
        logging.info(`Created ${batches.length} batches for email ${email.id} with ${createdRecipientCount} new recipients (${totalCount} total)`);

        if (email.get('email_count') !== totalCount) {
            logging.error(`Email ${email.id} has wrong stored email_count ${email.get('email_count')}, did expect ${totalCount}. Updating the model.`);

            // If the error rate is greater than 1%, we log it to Sentry so we can investigate
            // Some differences are expected, e.g. if a new member signs up while we are sending the email
            const errorRate = Math.abs((totalCount - email.get('email_count')) / email.get('email_count'));
            if (this.#sentry && errorRate >= 0.01) {
                // we don't have a real exception, so just log a message to Sentry
                this.#sentry.captureMessage(`Email ${email.id} has wrong stored email_count ${email.get('email_count')}, did expect ${totalCount}.`);
            }

            // We update the email model because this might happen in rare cases where the initial member count changed (e.g. deleted members)
            // between creating the email and sending it
            const newEmailUpdate = {
                email_count: totalCount
            };
            if (this.#domainWarmingService.isEnabled()) {
                newEmailUpdate.csd_email_count = Math.min(totalCount, domainWarmupLimit);
            }

            await email.save(newEmailUpdate, {patch: true, require: false, autoRefresh: false});
        }
        return batches;
    }

    /**
     * Creates a batch with retry logic and adds it to the batches array
     * @param {object} params
     * @param {Email} params.email
     * @param {import('./email-renderer').Segment} params.segment
     * @param {object[]} params.members
     * @param {boolean} params.useFallbackDomain
     * @param {EmailBatch[]} params.batches
     * @returns {Promise<number>} The number of members added
     */
    async #createBatchWithRetry({email, segment, members, useFallbackDomain, batches}) {
        if (members.length === 0) {
            return 0;
        }

        const batch = await this.retryDb(
            async () => {
                return await this.createBatch(email, segment, members, {
                    useFallbackDomain
                });
            },
            {
                ...this.#getBeforeRetryConfig(email),
                description: `createBatch email ${email.id} segment ${segment}${useFallbackDomain ? ' (fallback domain)' : ' (custom domain)'}`
            }
        );
        batches.push(batch);
        return members.length;
    }

    /**
     * @private
     * @param {Email} email
     * @param {import('./email-renderer').Segment} segment
     * @param {object[]} members
     * @param {object} options
     * @param {boolean} options.useFallbackDomain
     * @param {import('knex').Knex} [options.transacting]
     * @returns {Promise<EmailBatch>}
     */
    async createBatch(email, segment, members, options) {
        if (!options || !options.transacting) {
            return this.#models.EmailBatch.transaction(async (transacting) => {
                return this.createBatch(email, segment, members, {transacting, ...options});
            });
        }

        logging.info(`Creating batch for email ${email.id} segment ${segment} with ${members.length} members`);

        const recipientsToPersist = [];

        members.forEach((memberRow) => {
            if (!memberRow.id || !memberRow.uuid || !memberRow.email) {
                logging.warn('Member row not included as email recipient because required recipient data was missing');
                return;
            }

            recipientsToPersist.push({
                memberId: memberRow.id,
                memberUuid: memberRow.uuid,
                memberEmail: memberRow.email,
                memberName: memberRow.name
            });
        });

        const recipientManifest = this.#createRecipientManifest(recipientsToPersist.map(recipient => recipient.memberId));
        const batch = await this.#models.EmailBatch.add({
            email_id: email.id,
            member_segment: segment,
            status: 'pending',
            fallback_sending_domain: Boolean(options.useFallbackDomain),
            recipient_count: recipientManifest.recipientCount,
            recipient_hash: recipientManifest.recipientHash
        }, options);
        const recipientData = recipientsToPersist.map((recipient) => {
            return {
                id: ObjectID().toHexString(),
                email_id: email.id,
                member_id: recipient.memberId,
                batch_id: batch.id,
                member_uuid: recipient.memberUuid,
                member_email: recipient.memberEmail,
                member_name: recipient.memberName
            };
        });

        const insertQuery = this.#db.knex('email_recipients').insert(recipientData);

        if (options.transacting) {
            insertQuery.transacting(options.transacting);
        }

        logging.info(`Inserting ${recipientData.length} recipients for email ${email.id} batch ${batch.id}`);
        await insertQuery;
        return batch;
    }

    async sendBatches({email, batches, post, newsletter, emailSnapshot}) {
        // Track the in-flight call so onShutdown can await it. The cleanup task
        // must wait for the Mailgun POST + EmailBatch DB write to settle before
        // ghost-server schedules process.exit, otherwise mid-flight requests get
        // killed and EmailBatch rows never record what Mailgun actually accepted.
        const work = this.#sendBatchesInner({email, batches, post, newsletter, emailSnapshot});
        this.#inFlight.add(work);
        try {
            return await work;
        } finally {
            this.#inFlight.delete(work);
        }
    }

    async #sendBatchesInner({email, batches, post, newsletter, emailSnapshot}) {
        logging.info(`Sending ${batches.length} batches for email ${email.id}`);
        const deadline = this.getDeliveryDeadline(email);

        if (deadline) {
            logging.info(`Delivery deadline for email ${email.id} is ${deadline}`);
        }
        // Reuse same HTML body if we send an email to the same segment
        /** @type {Map<string, import('./email-renderer').EmailBody>} */
        const emailBodyCache = new Map();

        // Spread batches across the target window if one is configured. `deliveryTimes`
        // handles a past deadline internally. Explicit partial continuations derive their
        // deadline from the persisted transition timestamp; ordinary sends continue to
        // derive it from `created_at`. In either case, a genuinely delayed job respreads
        // remaining batches over a fresh window rather than dumping them into Mailgun.
        const targetDeliveryWindow = this.#sendingService.getTargetDeliveryWindow();
        const shouldApplyDeliveryTimes = targetDeliveryWindow !== undefined && targetDeliveryWindow > 0;
        const deliveryTimes = this.calculateDeliveryTimes(email, batches.length);

        // Loop batches and send them via the EmailProvider
        let succeededCount = 0;
        const queue = batches.slice();

        const runWorker = async () => {
            while (!this.#shuttingDown) {
                const batch = queue.shift();
                if (!batch) {
                    return;
                }
                const batchData = {email, batch, post, newsletter, emailSnapshot, emailBodyCache, deliveryTime: undefined};
                if (shouldApplyDeliveryTimes) {
                    const deliveryTime = deliveryTimes.shift();
                    if (deliveryTime && deliveryTime >= Date.now()) {
                        batchData.deliveryTime = deliveryTime;
                    }
                }
                if (await this.sendBatch(batchData)) {
                    succeededCount += 1;
                }
            }
        };

        // Run maximum MAX_SENDING_CONCURRENCY at the same time
        await Promise.all(new Array(MAX_SENDING_CONCURRENCY).fill(0).map(() => runWorker()));

        logging.info(`Email ${email.id} send done: ${succeededCount}/${batches.length} batches succeeded, ${queue.length} unstarted`);

        if (this.#shuttingDown && queue.length > 0) {
            throw new errors.InternalServerError({
                code: SHUTDOWN_CODE,
                message: 'Email send stopped because the container is shutting down'
            });
        }

        if (succeededCount < batches.length) {
            if (succeededCount > 0) {
                throw new errors.EmailError({
                    message: tpl(messages.emailErrorPartialFailure)
                });
            }
            throw new errors.EmailError({
                message: tpl(messages.emailError)
            });
        }
    }

    /**
     *
     * @param {{email: Email, batch: EmailBatch, post: Post, newsletter: Newsletter, emailSnapshot?: {subject: string, from: string, replyTo?: string}, emailBodyCache: Map<string, import('./email-renderer').EmailBody>, deliveryTime:(Date|undefined) }} data
     * @returns {Promise<boolean>} True when succeeded, false when failed with an error
     */
    async sendBatch({email, batch: originalBatch, post, newsletter, emailSnapshot, emailBodyCache, deliveryTime}) {
        logging.info(`Sending batch ${originalBatch.id} for email ${email.id}`);

        // Check the status of the email batch in a 'for update' transaction

        const batch = await this.retryDb(
            async () => {
                return await this.updateStatusLock(this.#models.EmailBatch, originalBatch.id, 'submitting', ['pending', 'failed']);
            },
            {...this.#getBeforeRetryConfig(email), description: `updateStatusLock batch ${originalBatch.id} -> submitting`}
        );
        if (!batch) {
            // updateStatusLock returned undefined: the batch's current status is neither
            // `pending` nor `failed`, so the lock didn't engage. Two distinct cases, and
            // they need different handling — collapsing them is the bug this branch fixes.
            const currentStatus = originalBatch.get('status');
            if (currentStatus === 'submitted') {
                // Mailgun accepted this batch on a prior run. Nothing to do; return true so
                // the parent email's success counter stays accurate. Expected path during
                // resume of an interrupted send where some batches finished before the crash.
                logging.info(`Email batch ${originalBatch.id} already submitted on a prior run; skipping`);
                return true;
            }
            // Otherwise currentStatus is `submitting`: orphan from a worker that crashed
            // mid-batch. We have no record of Mailgun accepting it, and re-sending risks
            // duplicates. Return false so the parent email is promoted to `failed` and an
            // operator can reconcile against the Mailgun dashboard before retrying.
            // Runbook: docs/newsletter-send-plan-v9.md.
            logging.error(`Email batch ${originalBatch.id} is stuck in status=${currentStatus} (orphan from a crashed worker); not re-sending — marking parent email as failed for operator review`);
            return false;
        }

        let succeeded = false;

        try {
            let members = await this.retryDb(
                async () => {
                    const m = await this.getBatchMembers(batch.id);

                    // If we receive 0 rows, there is a possibility that we switched to a secondary database and have replication lag
                    // So we throw an error and we retry
                    if (m.length === 0) {
                        throw new errors.EmailError({
                            message: `No members found for batch ${batch.id}, possible replication lag`
                        });
                    }

                    return m;
                },
                {...this.#getBeforeRetryConfig(email), description: `getBatchMembers batch ${originalBatch.id}`}
            );

            const response = await this.retryDb(async () => {
                return await this.#sendingService.send({
                    emailId: email.id,
                    post,
                    newsletter,
                    segment: batch.get('member_segment'),
                    members,
                    emailSnapshot
                }, {
                    openTrackingEnabled: !!email.get('track_opens'),
                    clickTrackingEnabled: !!email.get('track_clicks'),
                    useFallbackAddress: batch.get('fallback_sending_domain'),
                    deliveryTime,
                    emailBodyCache
                });
            }, {...this.#MAILGUN_API_RETRY_CONFIG, description: `Sending email batch ${originalBatch.id} ${deliveryTime ? `with delivery time ${deliveryTime}` : ''}`});
            succeeded = true;

            await this.retryDb(
                async () => {
                    await batch.save({
                        status: 'submitted',
                        provider_id: response.id,
                        // reset error fields when sending succeeds
                        error_status_code: null,
                        error_message: null,
                        error_data: null
                    }, {patch: true, require: false, autoRefresh: false});
                },
                {...this.#AFTER_RETRY_CONFIG, description: `save batch ${originalBatch.id} -> submitted`}
            );
        } catch (err) {
            if (err.code && err.code === 'BULK_EMAIL_SEND_FAILED') {
                logging.error(err);
                if (this.#sentry) {
                    // Log the original error to Sentry
                    this.#sentry.captureException(err);
                }
            } else {
                const ghostError = new errors.EmailError({
                    err,
                    code: 'BULK_EMAIL_SEND_FAILED',
                    message: `Error sending email batch ${batch.id}`,
                    context: err.message
                });

                logging.error(ghostError);
                if (this.#sentry) {
                    // Log the original error to Sentry
                    this.#sentry.captureException(err);
                }
            }

            if (!succeeded) {
                // We check succeeded because a Rare edge case where the batch was send, but we failed to set status to submitted, then we don't want to set it to failed
                await this.retryDb(
                    async () => {
                        await batch.save({
                            status: 'failed',
                            error_status_code: err.statusCode ?? null,
                            error_message: err.message,
                            error_data: err.errorDetails ?? null
                        }, {patch: true, require: false, autoRefresh: false});
                    },
                    {...this.#AFTER_RETRY_CONFIG, description: `save batch ${originalBatch.id} -> failed`}
                );
            }
        }

        // Mark as processed, even when failed
        await this.retryDb(
            async () => {
                await this.#models.EmailRecipient
                    .where({batch_id: batch.id})
                    .save({processed_at: new Date()}, {patch: true, require: false, autoRefresh: false});
            },
            {...this.#AFTER_RETRY_CONFIG, description: `save EmailRecipients ${originalBatch.id} processed_at`}
        );

        return succeeded;
    }

    /**
     * We don't want to pass EmailRecipient models to the sendingService.
     * So we transform them into the MemberLike interface.
     * That keeps the sending service nicely separated so it isn't dependent on the batch sending data structure.
     * @returns {Promise<MemberLike[]>}
     */
    async getBatchMembers(batchId) {
        let models = await this.#models.EmailRecipient.findAll({filter: `batch_id:'${batchId}'`, withRelated: ['member', 'member.stripeSubscriptions', 'member.products']});

        const BATCH_SIZE = this.#sendingService.getMaximumRecipients();
        if (models.length > BATCH_SIZE) {
            throw new errors.EmailError({
                message: `Email batch ${batchId} has ${models.length} members, which exceeds the maximum of ${BATCH_SIZE} members per batch.`
            });
        }

        return models.map((model) => {
            // Map subscriptions
            const subscriptions = model.related('member').related('stripeSubscriptions').toJSON();
            const tiers = model.related('member').related('products').toJSON();

            return {
                id: model.get('member_id'),
                uuid: model.get('member_uuid'),
                email: model.get('member_email'),
                name: model.get('member_name'),
                createdAt: model.related('member')?.get('created_at') ?? null,
                status: model.related('member')?.get('status') ?? 'free',
                subscriptions,
                tiers
            };
        });
    }

    /**
     * @private
     * Update the status of an email or emailBatch to a given status, but first check if their current status is 'pending' or 'failed'.
     * @param {object} Model Bookshelf model constructor
     * @param {string} id id of the model
     * @param {string} status set the status of the model to this value
     * @param {string[]} allowedStatuses Check if the models current status is one of these values
     * @param {object} [data] Additional fields persisted atomically with the status transition
     * @param {{expectedPartialResume?: boolean, expectedError?: string|null, expectedPartialResumeEnqueueClaim?: string|null}} [options] Additional predicates checked under the row lock
     * @returns {Promise<object|undefined>} The updated model. Undefined if the model didn't pass the status check.
     */
    async updateStatusLock(Model, id, status, allowedStatuses, data = {}, options = {}) {
        const hasExpectedError = Object.prototype.hasOwnProperty.call(options, 'expectedError');
        const hasExpectedPartialResumeEnqueueClaim = Object.prototype.hasOwnProperty.call(options, 'expectedPartialResumeEnqueueClaim');
        let model;
        await Model.transaction(async (transacting) => {
            model = await Model.findOne({id}, {require: true, transacting, forUpdate: true});
            if (!allowedStatuses.includes(model.get('status')) ||
                (options.expectedPartialResume !== undefined && model.get('partial_resume') !== options.expectedPartialResume) ||
                (hasExpectedError && model.get('error') !== options.expectedError) ||
                (hasExpectedPartialResumeEnqueueClaim && model.get('partial_resume_enqueue_claim') !== options.expectedPartialResumeEnqueueClaim)) {
                model = undefined;
                return;
            }
            await model.save({
                ...data,
                status
            }, {patch: true, transacting, autoRefresh: false});
        });
        return model;
    }

    /**
     * @private
     * Retry a function until it doesn't throw an error or the max retries / max time are reached.
     * @template T
     * @param {() => Promise<T>} func
     * @param {object} options
     * @param {string} options.description Used for logging
     * @param {number} options.sleep time between each retry (ms), will get multiplied by the number of retries
     * @param {number} options.maxRetries note: retries, not tries. So 0 means maximum 1 try, 1 means maximum 2 tries, etc.
     * @param {number} [options.retryCount] (internal) Amount of retries already done. 0 intially.
     * @param {number} [options.maxTime] (ms)
     * @param {Date} [options.stopAfterDate]
     * @returns {Promise<T>}
     */
    async retryDb(func, options) {
        if (options.maxTime !== undefined) {
            const stopAfterDate = new Date(Date.now() + options.maxTime);
            if (!options.stopAfterDate || stopAfterDate < options.stopAfterDate) {
                options = {...options, stopAfterDate};
            }
        }
        const retryCount = (options.retryCount ?? 0);

        try {
            if (retryCount > 0) {
                logging.info(`[BULK_EMAIL_DB_RETRY] ${options.description} - Retrying ${retryCount + 1}th try`);
            } else {
                logging.info(`[BULK_EMAIL_DB_RETRY] ${options.description} - Started (1st try)`);
            }

            const response = await func();

            logging.info(`[BULK_EMAIL_DB_RETRY] ${options.description} - Finished (after ${retryCount + 1}${retryCount === 0 ? 'st try' : ' tries'})`);

            return response;
        } catch (e) {
            const sleep = (options.sleep ?? 0);
            if (retryCount >= options.maxRetries || (options.stopAfterDate && (new Date(Date.now() + sleep)) > options.stopAfterDate)) {
                if (retryCount > 0) {
                    const ghostError = new errors.EmailError({
                        err: e,
                        code: 'BULK_EMAIL_DB_RETRY',
                        message: `[BULK_EMAIL_DB_RETRY] ${options.description} - Failed and stopped retrying: ${retryCount >= options.maxRetries ? 'max retries reached' : 'max time reached'}`,
                        context: e.message
                    });

                    logging.error(ghostError);
                }
                throw e;
            }

            const ghostError = new errors.EmailError({
                err: e,
                code: 'BULK_EMAIL_DB_RETRY',
                message: `[BULK_EMAIL_DB_RETRY] ${options.description} - Failed (${retryCount + 1}${retryCount === 0 ? 'st' : 'th'} try)`,
                context: e.message
            });

            logging.error(ghostError);

            if (sleep) {
                await new Promise((resolve) => {
                    setTimeout(resolve, sleep);
                });
            }
            return await this.retryDb(func, {...options, retryCount: retryCount + 1, sleep: sleep * 2});
        }
    }

    /**
     * Returns the sending deadline for an email.
     * Explicit partial continuations begin their delivery window at the persisted
     * `updated_at` state transition; ordinary emails retain `created_at` semantics.
     * @param {*} email
     * @returns Date | undefined
     */
    getDeliveryDeadline(email) {
        const isPartialResume = email.get('partial_resume') === true;
        const startTime = isPartialResume
            ? email.get('updated_at')
            : email.get('created_at');
        const isValidDateValue = startTime instanceof Date ||
            (typeof startTime === 'string' && startTime.trim().length > 0) ||
            typeof startTime === 'number';
        const startTimeMs = isValidDateValue ? new Date(startTime).getTime() : NaN;

        // `updated_at` is nullable in the historic schema. A partial continuation
        // without a valid persisted transition is ambiguous: it must fail before
        // any provider dispatch rather than silently disabling rate-spread.
        if (isPartialResume && !Number.isFinite(startTimeMs)) {
            throw new errors.EmailError({
                message: `Cannot send partial continuation ${email.id}: persisted transition timestamp updated_at is missing or invalid`
            });
        }

        // Preserve existing normal-email behavior if old data has no usable
        // creation timestamp.
        if (!Number.isFinite(startTimeMs)) {
            return undefined;
        }

        // Return undefined if targetDeliveryWindow is 0 (or less)
        const targetDeliveryWindow = this.#sendingService.getTargetDeliveryWindow();
        if (targetDeliveryWindow === undefined || targetDeliveryWindow <= 0) {
            return undefined;
        }

        return new Date(startTimeMs + targetDeliveryWindow);
    }

    /**
     * Adds deliverytimes to the passed in batches, based on the delivery deadline
     * @param {Email} email - the email model to be sent
     * @param {number} numBatches - the number of batches to be sent
     */
    calculateDeliveryTimes(email, numBatches) {
        let deadline = this.getDeliveryDeadline(email);
        if (!deadline) {
            return new Array(numBatches).fill(undefined);
        }
        const now = new Date();
        // If the current delivery window has passed (an interrupted continuation or
        // delayed job), respread batches over a fresh window of the same size starting
        // now. Partial continuations normally use their persisted `updated_at` transition
        // as the window start, so an old campaign does not automatically enter this branch.
        if (now >= deadline) {
            const targetDeliveryWindow = this.#sendingService.getTargetDeliveryWindow();
            deadline = new Date(now.getTime() + targetDeliveryWindow);
        }
        const timeToDeadline = deadline.getTime() - now.getTime();
        const batchDelay = timeToDeadline / numBatches;
        const deliveryTimes = [];
        for (let i = 0; i < numBatches; i++) {
            const delay = batchDelay * i;
            const deliveryTime = new Date(now.getTime() + delay);
            deliveryTimes.push(deliveryTime);
        }
        return deliveryTimes;
    }
}

module.exports = BatchSendingService;
module.exports.SHUTDOWN_CODE = SHUTDOWN_CODE;

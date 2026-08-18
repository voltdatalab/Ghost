/* eslint-disable no-unused-vars */

/**
 * @typedef {object} Post
 * @typedef {object} Email
 * @typedef {object} LimitService
 * @typedef {{checkVerificationRequired(): Promise<boolean>}} VerificationTrigger
 * @typedef {import ('./domain-warming-service').DomainWarmingService} DomainWarmingService
 *
 * @typedef {object} EmailPreflight - Validation result from a pre-save checkCanSendEmail call
 * @property {object} newsletter
 * @property {string} emailRecipientFilter
 * @property {number} emailCount
 */

const BatchSendingService = require('./batch-sending-service');
const {hashStringList, verifyLegacyProof} = require('./legacy-partial-resume-proof');
const errors = require('@tryghost/errors');
const tpl = require('@tryghost/tpl');
const ObjectID = require('bson-objectid').default;
const crypto = require('node:crypto');
const EmailRenderer = require('./email-renderer');
const EmailSegmenter = require('./email-segmenter');
const SendingService = require('./sending-service');
const logging = require('@tryghost/logging');

const messages = {
    archivedNewsletterError: 'Cannot send email to archived newsletters',
    missingNewsletterError: 'The post does not have a newsletter relation',
    emailSendingDisabled: `Email sending is temporarily disabled because your account is currently in review. You should have an email about this from us already, but you can also reach us any time at support@ghost.org`,
    retryEmailStatusError: 'Can only retry emails for published posts',
    retryEmailNotFailed: 'Only failed emails can be retried',
    retryPartialResume: 'Emails left by a partial continuation cannot use the generic retry path',
    partialResumeNotSubmitted: 'Only submitted emails can start a partial continuation',
    partialResumeAlreadyStarted: 'This email was changed before its partial continuation could start',
    partialResumeSchedulingError: 'Something went wrong while scheduling the partial continuation',
    emailSchedulingError: 'Something went wrong while scheduling the email',
    legacyProofKeyMissing: 'Legacy partial-resume proof verification is not configured',
    legacyProofAlreadyPersisted: 'A legacy partial-resume proof is already recorded for this email',
    legacyProofEmailState: 'Only submitted emails that are not partial continuations can admit a legacy proof',
    legacyProofIdentityMismatch: 'Legacy partial-resume proof does not match this email',
    legacyProofBatchMismatch: 'Legacy partial-resume proof does not match the persisted batch prefix',
    legacyProofLedgerMismatch: 'Legacy partial-resume proof does not match the persisted recipient ledger'
};

// Resume scanner won't pick up `submitting` rows older than this. Rows beyond the cutoff
// are flipped to `failed` on first boot so they surface in admin UI for operator review
// rather than being silently resumed (and sending stale newsletters to current members).
// Override via `bulkEmail:resumeMaxAgeMs` in config.
const DEFAULT_RESUME_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const LEGACY_PROXY_PUBLIC_KEY_CONFIG = 'bulkEmail:partialResume:legacyProxyPublicKey';
// Admission intentionally exposes no TTL configuration surface: proxy evidence must
// be freshly issued within this fixed window before it can be persisted.
const DEFAULT_LEGACY_PROXY_PROOF_MAX_AGE_MS = 24 * 60 * 60 * 1000;

class EmailService {
    #batchSendingService;
    #sendingService;
    #models;
    #settingsCache;
    #emailRenderer;
    #emailSegmenter;
    #limitService;
    #membersRepository;
    #verificationTrigger;
    #emailAnalyticsJobs;
    #domainWarmingService;
    #config;
    #db;
    #resumeScannerServiceStartMs;

    /**
     *
     * @param {object} dependencies
     * @param {BatchSendingService} dependencies.batchSendingService
     * @param {SendingService} dependencies.sendingService
     * @param {object} dependencies.models
     * @param {object} dependencies.models.Email
     * @param {object} [dependencies.models.EmailBatch] - Required for resumeInterruptedSends breadcrumbs
     * @param {object} dependencies.settingsCache
     * @param {EmailRenderer} dependencies.emailRenderer
     * @param {EmailSegmenter} dependencies.emailSegmenter
     * @param {LimitService} dependencies.limitService
     * @param {object} dependencies.membersRepository
     * @param {VerificationTrigger} dependencies.verificationTrigger
     * @param {object} dependencies.emailAnalyticsJobs
     * @param {DomainWarmingService} dependencies.domainWarmingService
     * @param {object} [dependencies.config] - Config service for reading host settings
     * @param {{knex: Function}} dependencies.db - Shared database handle for proof admission
     * @param {Date|number} [dependencies.resumeScannerServiceStart] - Immutable
     * upper bound for rows eligible to be recovered by this service instance
     */
    constructor({
        batchSendingService,
        sendingService,
        models,
        settingsCache,
        emailRenderer,
        emailSegmenter,
        limitService,
        membersRepository,
        verificationTrigger,
        emailAnalyticsJobs,
        domainWarmingService,
        config,
        db,
        resumeScannerServiceStart = Date.now()
    }) {
        this.#batchSendingService = batchSendingService;
        this.#models = models;
        this.#settingsCache = settingsCache;
        this.#emailRenderer = emailRenderer;
        this.#emailSegmenter = emailSegmenter;
        this.#limitService = limitService;
        this.#membersRepository = membersRepository;
        this.#sendingService = sendingService;
        this.#verificationTrigger = verificationTrigger;
        this.#emailAnalyticsJobs = emailAnalyticsJobs;
        this.#domainWarmingService = domainWarmingService;
        this.#config = config;
        this.#db = db;
        this.#resumeScannerServiceStartMs = new Date(resumeScannerServiceStart).getTime();
    }

    /**
     * @private
     */
    async checkLimits(addedCount = 0) {
        // Check host limit for allowed member count and throw error if over limit
        // - do this even if it's a retry so that there's no way around the limit
        if (this.#limitService.isLimited('members')) {
            await this.#limitService.errorIfIsOverLimit('members');
        }

        // Check host limit for disabled emails or going over emails limit
        if (this.#limitService.isLimited('emails')) {
            await this.#limitService.errorIfWouldGoOverLimit('emails', {addedCount});
        }

        // Check if email verification is required
        if (await this.#verificationTrigger.checkVerificationRequired()) {
            const customMessage = this.#config?.get('hostSettings:emailVerification:emailSendingDisabledMessage');
            throw new errors.HostLimitError({
                message: customMessage || tpl(messages.emailSendingDisabled),
                code: 'EMAIL_VERIFICATION_NEEDED'
            });
        }
    }

    /**
     * Pre-check if email sending would be allowed before making any post changes.
     * This validates limits and verification requirements early to avoid leaving
     * posts in a stuck "sent" state if email creation would fail.
     *
     * @param {object} newsletter - The newsletter model to send to
     * @param {string} emailRecipientFilter - The recipient filter for the email
     * @param {object} [options]
     * @param {number} [options.emailCount] - A previously counted audience to revalidate without recounting
     * @returns {Promise<{emailCount: number}>} The email count if checks pass, throws if email cannot be sent
     */
    async checkCanSendEmail(newsletter, emailRecipientFilter, {emailCount: knownEmailCount} = {}) {
        if (!newsletter) {
            throw new errors.EmailError({
                message: tpl(messages.missingNewsletterError)
            });
        }

        if (newsletter.get('status') !== 'active') {
            // A post might have been scheduled to an archived newsletter.
            // Don't send it (people can't unsubscribe any longer).
            throw new errors.BadRequestError({
                message: tpl(messages.archivedNewsletterError)
            });
        }

        const emailCount = knownEmailCount === undefined
            ? await this.#emailSegmenter.getMembersCount(newsletter, emailRecipientFilter)
            : knownEmailCount;
        await this.checkLimits(emailCount);

        return {emailCount};
    }

    /**
     *
     * @param {Post} post
     * @param {object} [options]
     * @param {EmailPreflight} [options.preflight] - The emailCount is reused if the newsletter and filter still match the saved post
     * @returns {Promise<Email>}
     */
    async createEmail(post, {preflight} = {}) {
        const newsletter = await post.getLazyRelation('newsletter');
        const emailRecipientFilter = post.get('email_recipient_filter');

        const preflightMatches = preflight?.newsletter?.id
            && preflight.newsletter.id === newsletter?.id
            && preflight.emailRecipientFilter === emailRecipientFilter;
        const {emailCount} = preflightMatches
            ? await this.checkCanSendEmail(newsletter, emailRecipientFilter, {emailCount: preflight.emailCount})
            : await this.checkCanSendEmail(newsletter, emailRecipientFilter);

        const csdEmailCount = this.#domainWarmingService.isEnabled()
            ? await this.#domainWarmingService.getWarmupLimit(emailCount)
            : undefined; // Undefined here means domain warming was not used -- distinct from 0

        const email = await this.#models.Email.add({
            post_id: post.id,
            newsletter_id: newsletter.id,
            status: 'pending',
            submitted_at: new Date(),
            track_opens: !!this.#settingsCache.get('email_track_opens'),
            track_clicks: !!this.#settingsCache.get('email_track_clicks'),
            feedback_enabled: !!newsletter.get('feedback_enabled'),
            recipient_filter: emailRecipientFilter,
            subject: this.#emailRenderer.getSubject(post),
            from: this.#emailRenderer.getFromAddress(post, newsletter),
            reply_to: this.#emailRenderer.getReplyToAddress(post, newsletter),
            email_count: emailCount,
            csd_email_count: csdEmailCount,
            source: post.get('lexical') || post.get('mobiledoc'),
            source_type: post.get('lexical') ? 'lexical' : 'mobiledoc'
        });

        const scheduledEmail = await this.#schedulePendingEmail(email);

        // make sure recurring background analytics jobs are running once we have emails
        try {
            await this.#emailAnalyticsJobs.scheduleRecurringNewslettersJob(true);
        } catch (e) {
            logging.error(e);
        }

        return scheduledEmail;
    }

    /**
     * Schedules an ordinary pending email and handles the ambiguous queue handoff.
     * A rejection from addJob does not prove the job was not accepted, so only a
     * still-pending row may be changed to failed. emailJob itself accepts ordinary
     * jobs exclusively from pending, preventing a delayed accepted job from
     * dispatching after this compensation won.
     *
     * @param {Email} email
     * @returns {Promise<Email>}
     */
    async #schedulePendingEmail(email) {
        const schedulingError = tpl(messages.emailSchedulingError);
        try {
            await this.#batchSendingService.scheduleEmail(email);
            return email;
        } catch (e) {
            let failed;
            try {
                failed = await this.#batchSendingService.updateStatusLock(
                    this.#models.Email,
                    email.id,
                    'failed',
                    ['pending'],
                    {error: schedulingError}
                );
            } catch (compensationError) {
                throw new errors.EmailError({
                    err: compensationError,
                    code: 'BULK_EMAIL_SCHEDULING_FAILED',
                    message: schedulingError
                });
            }
            if (failed) {
                return failed;
            }
            throw new errors.EmailError({
                err: e,
                code: 'BULK_EMAIL_SCHEDULING_FAILED',
                message: schedulingError
            });
        }
    }

    /**
     * Boot-time scanner: resumes newsletter emails left in `submitting` after a
     * previous container's interrupted send. Iterates sequentially; one failure
     * does not skip others. Rows older than the configured max-age are flipped
     * to `failed` (not resumed) so stale content does not get sent to current members.
     */
    async resumeInterruptedSends() {
        const maxAgeMs = this.#config?.get?.('bulkEmail:resumeMaxAgeMs') ?? DEFAULT_RESUME_MAX_AGE_MS;
        const cutoffMs = Date.now() - maxAgeMs;

        // Query every legacy `submitting` row once, then classify locally against
        // this immutable service start. NQL timestamp predicates can omit NULL or
        // malformed values and cannot safely exclude rows claimed after this boot.
        const submitting = await this.#models.Email.findAll({
            filter: 'status:submitting'
        });
        const submittingList = (submitting.models || submitting).filter(email => email.get('partial_resume') !== true);
        const legacyCreatedAtMs = (email) => {
            const createdAt = email.get('created_at');
            return createdAt === null || createdAt === undefined ? Number.NaN : new Date(createdAt).getTime();
        };
        const staleList = submittingList.filter((email) => {
            const createdAtMs = legacyCreatedAtMs(email);
            return !Number.isFinite(createdAtMs) ||
                (createdAtMs <= this.#resumeScannerServiceStartMs && createdAtMs < cutoffMs);
        });
        for (const email of staleList) {
            try {
                const locked = await this.#batchSendingService.updateStatusLock(
                    this.#models.Email,
                    email.id,
                    'failed',
                    ['submitting']
                );
                if (locked) {
                    logging.warn(`Email resume: stale submitting email exceeds max age (${maxAgeMs}ms) — flipped to failed for operator review`);
                }
            } catch (e) {
                logging.error('Email resume: could not fail a stale submitting email');
            }
        }

        // The explicit partial-resume endpoint changes the status of an existing,
        // potentially old email, then schedules an in-process job. Its recovery
        // age must be measured from that transition (`updated_at`), not from the
        // original campaign creation time. NQL cannot reliably compare updated_at
        // on every supported database, so query this deliberately small explicit
        // continuation set then classify its persisted timestamp locally. An absent
        // or invalid timestamp is ambiguous and is therefore stale/fail-closed.
        const partialContinuations = await this.#models.Email.findAll({
            filter: 'status:[pending,submitting]+partial_resume:true'
        });
        const partialContinuationList = partialContinuations.models || partialContinuations;
        const partialTransitionTime = email => new Date(email.get('updated_at')).getTime();
        const stalePartialList = partialContinuationList.filter((email) => {
            const updatedAtMs = partialTransitionTime(email);
            return !Number.isFinite(updatedAtMs) ||
                (updatedAtMs <= this.#resumeScannerServiceStartMs && updatedAtMs < cutoffMs);
        });
        const freshPartialList = partialContinuationList.filter((email) => {
            const updatedAtMs = partialTransitionTime(email);
            return Number.isFinite(updatedAtMs) &&
                updatedAtMs <= this.#resumeScannerServiceStartMs &&
                updatedAtMs >= cutoffMs;
        });
        for (const email of stalePartialList) {
            try {
                const locked = await this.#batchSendingService.updateStatusLock(
                    this.#models.Email,
                    email.id,
                    'failed',
                    ['pending', 'submitting'],
                    {
                        // An expired claim no longer authorizes a worker. Clear it
                        // atomically with the fail-closed transition so an operator
                        // can re-run the explicit, fully revalidated continuation.
                        partial_resume_enqueue_claim: null
                    },
                    {expectedPartialResume: true}
                );
                if (locked) {
                    logging.warn(`Email partial resume: stale continuation exceeds max age (${maxAgeMs}ms) — flipped to failed for operator review`);
                }
            } catch (e) {
                logging.error('Email partial resume: could not fail a stale continuation');
            }
        }

        // Fresh rows: within the cutoff and known to predate this service. Rows
        // created after service start are still owned by this running process and
        // must not be re-claimed by the boot scanner.
        const list = submittingList.filter((email) => {
            const createdAtMs = legacyCreatedAtMs(email);
            return Number.isFinite(createdAtMs) &&
                createdAtMs <= this.#resumeScannerServiceStartMs && createdAtMs >= cutoffMs;
        });
        const submittingPartialList = freshPartialList.filter(email => email.get('status') === 'submitting');
        const pendingPartialList = freshPartialList.filter(email => email.get('status') === 'pending');
        if (staleList.length === 0 && stalePartialList.length === 0 && list.length === 0 && freshPartialList.length === 0) {
            return;
        }
        if (list.length > 0) {
            logging.info(`Email resume: found ${list.length} email(s) in submitting status within max age (${maxAgeMs}ms)`);
        }
        if (freshPartialList.length > 0) {
            logging.info(`Email partial resume: found ${submittingPartialList.length} submitting and ${pendingPartialList.length} pending continuation(s) within max age (${maxAgeMs}ms)`);
        }

        // A fresh `submitting` partial continuation is atomically moved to
        // `pending` by #resumeOneEmail. Record scheduled IDs defensively in case
        // an overlapping snapshot reaches a second scanner path; emailJob's own
        // CAS remains the cross-process deduplication authority.
        const scheduledIds = new Set();
        for (const email of list) {
            try {
                if (await this.#resumeOneEmail(email)) {
                    scheduledIds.add(email.id);
                }
            } catch (e) {
                logging.error('Email resume: failed to recover a legacy submitting email');
                await this.#failRecoveryEmail(email, ['submitting']);
            }
        }
        for (const email of submittingPartialList) {
            if (scheduledIds.has(email.id)) {
                continue;
            }
            try {
                if (await this.#resumeOneEmail(email)) {
                    scheduledIds.add(email.id);
                }
            } catch (e) {
                logging.error('Email partial resume: failed to recover a submitting continuation');
                await this.#failRecoveryEmail(email, ['submitting'], {
                    options: {
                        expectedPartialResume: true,
                        expectedPartialResumeEnqueueClaim: null
                    }
                });
            }
        }
        for (const email of pendingPartialList) {
            if (scheduledIds.has(email.id)) {
                continue;
            }
            try {
                if (await this.#resumePendingPartialEmail(email)) {
                    scheduledIds.add(email.id);
                }
            } catch (e) {
                logging.error('Email partial resume: failed to recover a pending continuation');
                await this.#failRecoveryEmail(email, ['pending'], {
                    options: {
                        expectedPartialResume: true,
                        expectedPartialResumeEnqueueClaim: null
                    }
                });
            }
        }

        logging.info(`Email resume scan complete: ${staleList.length} stale submitting email(s) and ${stalePartialList.length} stale partial continuation(s) flipped to failed; ${scheduledIds.size} fresh email(s) rescheduled`);
    }

    async #resumeOneEmail(email) {
        const isPartialResume = email.get('partial_resume') === true;
        // A non-null claim means an accepted partial job owns the handoff or is
        // already sending. Never requeue it from recovery; stale handling will
        // terminate it fail-closed if its worker never completes.
        if (isPartialResume && email.get('partial_resume_enqueue_claim') !== null) {
            logging.info('Email partial resume: an owned continuation is not requeued by recovery');
            return false;
        }
        let claimed = false;
        try {
            const post = await email.getLazyRelation('post');
            const postStatus = post ? post.get('status') : null;
            const sendable = postStatus === 'published' || postStatus === 'sent';

            if (!sendable) {
                // Parent post was unpublished or deleted while the email was in flight.
                // Can't resume — mark the email as failed so it stops showing as "submitting".
                const locked = await this.#batchSendingService.updateStatusLock(
                    this.#models.Email,
                    email.id,
                    'failed',
                    ['submitting'],
                    isPartialResume ? {partial_resume_enqueue_claim: null} : {},
                    isPartialResume ? {
                        expectedPartialResume: true,
                        expectedPartialResumeEnqueueClaim: null
                    } : undefined
                );
                if (locked) {
                    logging.warn('Email resume: parent post is not sendable — marked email as failed');
                }
                return false;
            }

            // Flip submitting -> pending so the downstream job can take the final
            // CAS. Partial recovery clears an abandoned marker here; the fresh
            // pending handoff will obtain its own durable marker before enqueue.
            const locked = await this.#batchSendingService.updateStatusLock(
                this.#models.Email,
                email.id,
                'pending',
                ['submitting'],
                isPartialResume ? {
                    error: null,
                    partial_resume_enqueue_claim: null
                } : {},
                isPartialResume ? {
                    expectedPartialResume: true,
                    expectedPartialResumeEnqueueClaim: null
                } : undefined
            );
            if (!locked) {
                logging.info('Email resume: status changed before lock could be taken — skipping');
                return false;
            }
            claimed = true;

            // Structured breadcrumb so post-incident timing/batch state is recoverable from logs.
            const breadcrumb = await this.#buildResumeBreadcrumb(email);
            logging.warn(`Email resume: scheduling recovered email ${JSON.stringify(breadcrumb)}`);

            // Skip checkLimits — this email already passed limits when first sent.
            // A partial continuation from this pre-existing `submitting` state
            // is a strict pending-only job. Fresh pending handoffs are separately
            // claimed with a marker by #resumePendingPartialEmail().
            if (isPartialResume) {
                // This row is now pending with no claim. Reuse the same durable
                // handoff used for an explicit resume, rather than enqueueing in
                // the gap where addJob can accept and still report an error.
                return await this.#resumePendingPartialEmail(locked);
            }
            await this.#batchSendingService.scheduleEmail(locked);
            return true;
        } catch (e) {
            await this.#failRecoveryEmail(
                email,
                claimed ? ['pending'] : ['submitting'],
                isPartialResume
                    ? {
                        options: {
                            expectedPartialResume: true,
                            expectedPartialResumeEnqueueClaim: null
                        }
                    }
                    : undefined
            );
            logging.error('Email resume: recovery attempt failed');
            return false;
        }
    }

    /**
     * Recovers the handoff window after the explicit endpoint persisted a partial
     * continuation but before its in-memory job began. It first obtains a durable
     * marker claim, so a competing scanner cannot enqueue the same pending row.
     * The worker must atomically clear that exact marker before it can dispatch.
     *
     * @param {Email} email
     * @returns {Promise<boolean>}
     */
    async #resumePendingPartialEmail(email) {
        let claimed = false;
        let partialResumeClaim;
        try {
            const post = await email.getLazyRelation('post');
            const postStatus = post ? post.get('status') : null;
            const sendable = postStatus === 'published' || postStatus === 'sent';

            if (!sendable) {
                const locked = await this.#batchSendingService.updateStatusLock(
                    this.#models.Email,
                    email.id,
                    'failed',
                    ['pending'],
                    {},
                    {
                        expectedPartialResume: true,
                        expectedPartialResumeEnqueueClaim: null
                    }
                );
                if (locked) {
                    logging.warn('Email partial resume: parent post is not sendable — marked email as failed');
                }
                return false;
            }

            // Claim before scheduling. If addJob has an ambiguous accepted-then-
            // rejected outcome, only the owner of this fresh internal token may
            // compensate it. The worker replaces this enqueue token before dispatch.
            partialResumeClaim = crypto.randomUUID();
            const locked = await this.#batchSendingService.updateStatusLock(
                this.#models.Email,
                email.id,
                'submitting',
                ['pending'],
                {
                    error: null,
                    partial_resume_enqueue_claim: partialResumeClaim
                },
                {
                    expectedPartialResume: true,
                    expectedPartialResumeEnqueueClaim: null
                }
            );
            if (!locked) {
                logging.info('Email partial resume: status changed before durable claim — skipping');
                return false;
            }
            claimed = true;

            logging.warn('Email partial resume: scheduling claimed continuation');
            await this.#batchSendingService.scheduleEmail(locked, {
                partialResumeClaimed: true,
                partialResumeClaim
            });
            return true;
        } catch (e) {
            await this.#failRecoveryEmail(
                email,
                claimed ? ['submitting'] : ['pending'],
                {
                    data: claimed ? {
                        error: tpl(messages.partialResumeSchedulingError),
                        partial_resume_enqueue_claim: null
                    } : {},
                    options: {
                        expectedPartialResume: true,
                        expectedPartialResumeEnqueueClaim: partialResumeClaim ?? null
                    }
                }
            );
            logging.error('Email partial resume: recovery attempt failed');
            return false;
        }
    }

    async #failRecoveryEmail(email, expectedStatuses, {data, options} = {}) {
        const failureData = options?.expectedPartialResume === true
            ? {...data, partial_resume_enqueue_claim: null}
            : (data || {});
        try {
            let locked;
            if (options !== undefined) {
                locked = await this.#batchSendingService.updateStatusLock(
                    this.#models.Email,
                    email.id,
                    'failed',
                    expectedStatuses,
                    failureData,
                    options
                );
            } else if (data !== undefined) {
                locked = await this.#batchSendingService.updateStatusLock(
                    this.#models.Email,
                    email.id,
                    'failed',
                    expectedStatuses,
                    data
                );
            } else {
                locked = await this.#batchSendingService.updateStatusLock(
                    this.#models.Email,
                    email.id,
                    'failed',
                    expectedStatuses
                );
            }
            if (locked) {
                logging.warn('Email recovery: could not be resumed — marked email as failed');
            }
        } catch (e) {
            logging.error('Email recovery: could not persist failed state');
        }
    }

    async #buildResumeBreadcrumb(email) {
        const counts = {};
        let latestStatusWrite = email.get('updated_at') || email.get('created_at');
        if (this.#models.EmailBatch) {
            try {
                const batches = await this.#models.EmailBatch.findAll({
                    filter: `email_id:'${email.id}'`
                });
                for (const batch of batches.models || batches) {
                    const status = batch.get('status');
                    counts[status] = (counts[status] || 0) + 1;
                    const updatedAt = batch.get('updated_at');
                    if (updatedAt && (!latestStatusWrite || updatedAt > latestStatusWrite)) {
                        latestStatusWrite = updatedAt;
                    }
                }
            } catch (e) {
                // Breadcrumb is best-effort; never block resume on it.
                logging.warn('Email resume: could not build aggregate breadcrumb');
            }
        }
        const msSinceLastStatusWrite = latestStatusWrite
            ? Date.now() - new Date(latestStatusWrite).getTime()
            : null;
        const targetDeliveryWindowMs = this.#config?.get?.('bulkEmail:targetDeliveryWindow') ?? 0;
        return {
            batch_counts_by_status: counts,
            ms_since_last_status_write: msSinceLastStatusWrite,
            target_delivery_window_ms: targetDeliveryWindowMs
        };
    }

    async retryEmail(email) {
        if (email.get('partial_resume') === true) {
            throw new errors.BadRequestError({
                message: tpl(messages.retryPartialResume)
            });
        }

        // Block accidentaly retrying non-published posts (can happen due to bugs in frontend)
        const post = await email.getLazyRelation('post');
        if (post.get('status') !== 'published' && post.get('status') !== 'sent') {
            throw new errors.IncorrectUsageError({
                message: tpl(messages.retryEmailStatusError)
            });
        }

        if (email.get('status') !== 'failed') {
            throw new errors.BadRequestError({
                message: tpl(messages.retryEmailNotFailed)
            });
        }

        await this.checkLimits();

        // Change email status back to 'pending' before scheduling
        // so we have a immediate response when retrying an email (schedule can take a while to kick off sometimes)
        await email.save({status: 'pending'}, {patch: true});

        const scheduledEmail = await this.#schedulePendingEmail(email);
        return scheduledEmail;
    }

    /**
     * Starts an explicit continuation for an email whose first materialization
     * was interrupted after a provider-confirmed prefix. It can also deliberately
     * re-open a failed partial continuation only after re-validating the same
     * ledger. This bypasses neither the email-level compare-and-set lock nor the
     * batch-level safety checks, and never falls through to generic retry.
     *
     * @param {Email} email
     * @returns {Promise<Email>}
     */
    async resumePartialEmail(email) {
        const status = email.get('status');
        const isInitialPartialContinuation = status === 'submitted';
        const isSafeFailedContinuation = status === 'failed' && email.get('partial_resume') === true;

        if (!isInitialPartialContinuation && !isSafeFailedContinuation) {
            throw new errors.BadRequestError({
                message: tpl(messages.partialResumeNotSubmitted)
            });
        }

        // Preflight is read-only and rejects complete or ambiguous emails before
        // changing the state. The job repeats its critical checks after the CAS
        // lock because recipient eligibility can legitimately change in between.
        const {renderHash} = await this.#batchSendingService.assertCanStartPartialResume(email);
        if (typeof renderHash !== 'string' || !/^[a-f0-9]{64}$/.test(renderHash)) {
            throw new errors.BadRequestError({
                message: tpl(messages.partialResumeAlreadyStarted)
            });
        }

        const locked = await this.#batchSendingService.updateStatusLock(
            this.#models.Email,
            email.id,
            'pending',
            isSafeFailedContinuation ? ['failed'] : ['submitted'],
            {
                partial_resume: true,
                partial_resume_render_hash: renderHash,
                partial_resume_enqueue_claim: null,
                error: null
            }
        );
        if (!locked) {
            throw new errors.BadRequestError({
                message: tpl(messages.partialResumeAlreadyStarted)
            });
        }

        // Existing emails passed their original account limits. This is a
        // continuation, not a new broadcast, so it intentionally skips
        // checkLimits just as interrupted-send recovery does. Claim the durable
        // handoff before addJob: an accepted-then-rejected enqueue can never be
        // compensated over a worker that has already replaced this token.
        const partialResumeClaim = crypto.randomUUID();
        let claimAccepted = false;
        try {
            const claimed = await this.#batchSendingService.updateStatusLock(
                this.#models.Email,
                locked.id,
                'submitting',
                ['pending'],
                {
                    error: null,
                    partial_resume_enqueue_claim: partialResumeClaim
                },
                {
                    expectedPartialResume: true,
                    expectedError: null,
                    expectedPartialResumeEnqueueClaim: null
                }
            );
            if (!claimed) {
                throw new errors.EmailError({
                    code: 'BULK_EMAIL_PARTIAL_RESUME_CLAIM_FAILED',
                    message: tpl(messages.partialResumeSchedulingError)
                });
            }
            claimAccepted = true;
            await this.#batchSendingService.scheduleEmail(claimed, {
                partialResumeClaimed: true,
                partialResumeClaim
            });
        } catch (e) {
            // A failed claim is owned by another state transition and cannot be
            // changed here. Once this request owns the token, only that exact
            // generation may be compensated after an enqueue error.
            if (!claimAccepted) {
                throw e;
            }
            const failed = await this.#batchSendingService.updateStatusLock(
                this.#models.Email,
                locked.id,
                'failed',
                ['submitting'],
                {
                    error: tpl(messages.partialResumeSchedulingError),
                    partial_resume_enqueue_claim: null
                },
                {
                    expectedPartialResume: true,
                    expectedError: null,
                    expectedPartialResumeEnqueueClaim: partialResumeClaim
                }
            );
            if (failed) {
                return failed;
            }
            throw new errors.EmailError({
                err: e,
                code: 'BULK_EMAIL_PARTIAL_RESUME_SCHEDULING_FAILED',
                message: tpl(messages.partialResumeSchedulingError)
            });
        }
        return locked;
    }

    /**
     * Verifies and immutably records an independently attested legacy prefix.
     * This is an admission gate only: it intentionally does not change email state,
     * create recipients or batches, schedule a job, or contact a delivery provider.
     *
     * @param {Email} email
     * @param {{proof: unknown, signature: string}} signedProof
     * @returns {Promise<Email>}
     */
    async admitLegacyPartialResumeProof(email, signedProof) {
        if (!email || typeof email.id !== 'string') {
            throw new errors.BadRequestError({message: tpl(messages.legacyProofIdentityMismatch)});
        }
        if (!signedProof || typeof signedProof !== 'object' || Array.isArray(signedProof)) {
            throw new errors.BadRequestError({message: tpl(messages.legacyProofIdentityMismatch)});
        }

        const publicKey = this.#config?.get?.(LEGACY_PROXY_PUBLIC_KEY_CONFIG);
        if (typeof publicKey !== 'string' || publicKey.length === 0) {
            throw new errors.BadRequestError({message: tpl(messages.legacyProofKeyMissing)});
        }
        const maxAgeMs = DEFAULT_LEGACY_PROXY_PROOF_MAX_AGE_MS;

        // Verify before taking a database lock: invalid signatures, stale evidence, and
        // malformed payloads never enter the persistence path.
        const verifiedProof = verifyLegacyProof({
            proof: signedProof.proof,
            signature: signedProof.signature,
            publicKey,
            now: new Date(),
            maxAgeMs
        });
        if (verifiedProof.payload.email_id !== email.id) {
            throw new errors.BadRequestError({message: tpl(messages.legacyProofIdentityMismatch)});
        }

        return await this.#models.Email.transaction(async (transacting) => {
            const lockedEmail = await this.#models.Email.findOne({id: email.id}, {
                require: true,
                transacting,
                forUpdate: true
            });
            if (lockedEmail.get('status') !== 'submitted' || lockedEmail.get('partial_resume') === true) {
                throw new errors.BadRequestError({message: tpl(messages.legacyProofEmailState)});
            }

            const existingProof = await this.#db.knex('email_partial_resume_proofs')
                .select('id')
                .where({email_id: lockedEmail.id})
                .transacting(transacting)
                .forUpdate()
                .first();
            if (existingProof) {
                throw new errors.BadRequestError({message: tpl(messages.legacyProofAlreadyPersisted)});
            }

            const batches = await this.#db.knex('email_batches')
                .select('id', 'email_id', 'status', 'provider_id')
                .where({email_id: lockedEmail.id})
                .transacting(transacting)
                .forUpdate();
            this.#assertLegacyProofBatches(lockedEmail, verifiedProof.payload, batches);

            const recipients = await this.#db.knex('email_recipients')
                .select('batch_id', 'member_id', 'member_email')
                .where({email_id: lockedEmail.id})
                .transacting(transacting)
                .forUpdate();
            this.#assertLegacyProofLedger(verifiedProof.payload, recipients);

            await this.#db.knex('email_partial_resume_proofs').insert({
                id: ObjectID().toHexString(),
                email_id: lockedEmail.id,
                proof_payload: verifiedProof.payloadJson,
                proof_hash: crypto.createHash('sha256').update(verifiedProof.payloadJson, 'utf8').digest('hex'),
                signature: signedProof.signature,
                signing_key_fingerprint: verifiedProof.signingKeyFingerprint,
                transport: verifiedProof.payload.transport,
                created_at: new Date()
            }).transacting(transacting);

            return lockedEmail;
        });
    }

    /**
     * @private
     * @param {Email} email
     * @param {{legacy_batch_ids: string[]}} payload
     * @param {Array<{id: string, email_id: string, status: string, provider_id: string}>} batches
     */
    #assertLegacyProofBatches(email, payload, batches) {
        if (!Array.isArray(batches) || batches.length !== payload.legacy_batch_ids.length) {
            throw new errors.BadRequestError({message: tpl(messages.legacyProofBatchMismatch)});
        }

        const expectedBatchIds = new Set(payload.legacy_batch_ids);
        const persistedBatchIds = new Set();
        for (const batch of batches) {
            if (!batch || typeof batch.id !== 'string' || persistedBatchIds.has(batch.id) || !expectedBatchIds.has(batch.id)) {
                throw new errors.BadRequestError({message: tpl(messages.legacyProofBatchMismatch)});
            }
            if (batch.email_id !== email.id || batch.status !== 'submitted' || batch.provider_id !== email.id) {
                throw new errors.BadRequestError({message: tpl(messages.legacyProofBatchMismatch)});
            }
            persistedBatchIds.add(batch.id);
        }
        if (persistedBatchIds.size !== expectedBatchIds.size) {
            throw new errors.BadRequestError({message: tpl(messages.legacyProofBatchMismatch)});
        }
    }

    /**
     * @private
     * @param {{legacy_batch_ids: string[], ledger_member_count: number, ledger_member_hash: string, ledger_email_count: number, ledger_email_hash: string, ledger_binding_hash: string}} payload
     * @param {Array<{batch_id: string, member_id: string, member_email: string}>} recipients
     */
    #assertLegacyProofLedger(payload, recipients) {
        if (!Array.isArray(recipients)) {
            throw new errors.BadRequestError({message: tpl(messages.legacyProofLedgerMismatch)});
        }

        const expectedBatchIds = new Set(payload.legacy_batch_ids);
        const memberIds = [];
        const memberEmails = [];
        const recipientTuples = [];
        for (const recipient of recipients) {
            if (!recipient || !expectedBatchIds.has(recipient.batch_id)) {
                throw new errors.BadRequestError({message: tpl(messages.legacyProofLedgerMismatch)});
            }
            memberIds.push(recipient.member_id);
            memberEmails.push(recipient.member_email);
            recipientTuples.push(`${recipient.batch_id}\u0000${recipient.member_id}\u0000${recipient.member_email}`);
        }

        const memberHash = hashStringList(memberIds);
        const emailHash = hashStringList(memberEmails);
        const recipientHash = hashStringList(recipientTuples);
        if (
            memberIds.length !== payload.ledger_member_count ||
            memberHash !== payload.ledger_member_hash ||
            memberEmails.length !== payload.ledger_email_count ||
            emailHash !== payload.ledger_email_hash ||
            recipientHash !== payload.ledger_binding_hash
        ) {
            throw new errors.BadRequestError({message: tpl(messages.legacyProofLedgerMismatch)});
        }
    }

    /**
     * @params {string|null} [audienceStatus] - the audience's free/paid status
     *   ('status:free' / 'status:-free'), see EmailRenderer#describeSegment
     * @return {import('./email-renderer').MemberLike}
     */
    getDefaultExampleMember(audienceStatus) {
        /**
         * @type {import('./email-renderer').MemberLike}
         */
        return {
            id: 'example-id',
            uuid: 'example-uuid',
            email: 'jamie@example.com',
            name: 'Jamie Larson',
            createdAt: new Date(),
            status: audienceStatus === 'status:free' ? 'free' : 'paid',
            subscriptions: audienceStatus === 'status:free' ? [] : [
                {
                    cancel_at_period_end: false,
                    trial_end_at: null,
                    current_period_end: new Date(Date.now() + 1000 * 60 * 60 * 24 * 7),
                    status: 'active'
                }
            ],
            tiers: []
        };
    }

    /**
     * @private
     * @param {string} [email] (optional) Search for a member with this email address and use it as the example. If not found, defaults to the default but still uses the provided email address.
     * @param {string|null} [audienceStatus] (optional) The audience's free/paid status, see EmailRenderer#describeSegment
     * @return {Promise<import('./email-renderer').MemberLike>}
     */
    async getExampleMember(email, audienceStatus) {
        /**
         * @type {import('./email-renderer').MemberLike}
         */
        const exampleMember = this.getDefaultExampleMember(audienceStatus);

        // fetch any matching members so that replacements use expected values
        if (email) {
            const member = await this.#membersRepository.get({email});
            if (member) {
                exampleMember.id = member.id;
                exampleMember.uuid = member.get('uuid');
                exampleMember.email = member.get('email');
                exampleMember.name = member.get('name');
                exampleMember.createdAt = member.get('created_at');

                if (audienceStatus === 'status:-free' && member.get('status') !== 'free') {
                    // Make sure the example member matches the chosen segment (otherwise we'll send an email to free segment, but include a paid member details, which looks like a bug)
                    exampleMember.status = member.get('status');
                    const subscriptions = (await member.getLazyRelation('stripeSubscriptions')).toJSON();
                    exampleMember.subscriptions = subscriptions;

                    const tiers = (await member.getLazyRelation('products')).toJSON();
                    exampleMember.tiers = tiers;
                }
            } else {
                exampleMember.name = ''; // Force empty name to simulate name fallbacks
                exampleMember.email = email;
            }
        }

        return exampleMember;
    }

    /**
     * Do a manual replacement of tokens with values for a member (normally only used for previews)
     *
     * @param {string} htmlOrPlaintext
     * @param {import('./email-renderer').ReplacementDefinition[]} replacements
     * @param {import('./email-renderer').MemberLike} member
     * @return {string}
     */
    replaceDefinitions(htmlOrPlaintext, replacements, member) {
        // Do manual replacements with an example member
        for (const replacement of replacements) {
            htmlOrPlaintext = htmlOrPlaintext.replace(replacement.token, replacement.getValue(member));
        }
        return htmlOrPlaintext;
    }

    /**
     *
     * @param {*} post
     * @param {*} newsletter
     * @param {'free'|'paid'|null} memberStatus
     * @param {string} [memberTier] - narrow the paid audience to a single tier
     * @returns {Promise<{subject: string, html: string, plaintext: string}>} Email preview
     */
    async previewEmail(post, newsletter, memberStatus, memberTier) {
        const renderSegment = this.#emailRenderer.getSegmentForAudience(post, memberStatus, memberTier);
        const audience = this.#emailRenderer.describeSegment(post, renderSegment);
        const exampleMember = await this.getExampleMember(null, audience.status);

        const subject = this.#emailRenderer.getSubject(post);
        let {html, plaintext, replacements} = await this.#emailRenderer.renderBody(post, newsletter, renderSegment, {clickTrackingEnabled: false});

        return {
            subject,
            html: this.replaceDefinitions(html, replacements, exampleMember),
            plaintext: this.replaceDefinitions(plaintext, replacements, exampleMember)
        };
    }

    /**
     *
     * @param {*} post
     * @param {*} newsletter
     * @param {'free'|'paid'|null} memberStatus
     * @param {string[]} emails
     * @param {string} [memberTier] - narrow the paid audience to a single tier
     */
    async sendTestEmail(post, newsletter, memberStatus, emails, memberTier) {
        const renderSegment = this.#emailRenderer.getSegmentForAudience(post, memberStatus, memberTier);
        const audience = this.#emailRenderer.describeSegment(post, renderSegment);

        const members = [];
        for (const email of emails) {
            members.push(await this.getExampleMember(email, audience.status));
        }

        await this.#sendingService.send({
            post,
            newsletter,
            segment: renderSegment,
            members,
            emailId: null
        }, {
            clickTrackingEnabled: false,
            openTrackingEnabled: false,
            isTestEmail: true
        });
    }
}

module.exports = EmailService;

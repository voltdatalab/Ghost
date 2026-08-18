const EmailService = require('../../../../../core/server/services/email-service/email-service');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const sinon = require('sinon');
const logging = require('@tryghost/logging');
const {canonicalizeLegacyProofPayload, hashStringList} = require('../../../../../core/server/services/email-service/legacy-partial-resume-proof');
const {createModel, createModelClass} = require('./utils');

const LEGACY_PUBLIC_KEY_CONFIG = 'bulkEmail:partialResume:legacyProxyPublicKey';
const LEGACY_EMAIL_ID = '64b000000000000000000001';
const LEGACY_BATCH_IDS = ['64b000000000000000000002', '64b000000000000000000003'];
const LEGACY_MEMBER_IDS = ['64b000000000000000000010', '64b000000000000000000011'];
const LEGACY_MEMBER_EMAILS = ['first@example.test', 'second@example.test'];
const PARTIAL_RESUME_ENQUEUE_CLAIM = '00000000-0000-4000-8000-000000000001';
const LEGACY_PROOF_KEY_PAIR = crypto.generateKeyPairSync('ed25519');

function createSignedLegacyProof({
    emailId = LEGACY_EMAIL_ID,
    batchIds = LEGACY_BATCH_IDS,
    memberIds = LEGACY_MEMBER_IDS,
    memberEmails = LEGACY_MEMBER_EMAILS,
    recipientTuples,
    issuedAt = new Date(Date.now() - 1000),
    proxyLastCreatedAt = new Date(Date.now() - 2000)
} = {}) {
    const canonicalRecipientTuples = recipientTuples || batchIds.map((batchId, index) => `${batchId}\u0000${memberIds[index]}\u0000${memberEmails[index]}`);
    const payload = {
        version: 1,
        transport: 'ses-proxy-mailgun-v1',
        email_id: emailId,
        issued_at: issuedAt.toISOString(),
        legacy_batch_ids: [...batchIds],
        legacy_provider_id_mode: 'email-id',
        ledger_member_count: memberIds.length,
        ledger_member_hash: hashStringList(memberIds),
        ledger_email_count: memberEmails.length,
        ledger_email_hash: hashStringList(memberEmails),
        ledger_binding_hash: hashStringList(canonicalRecipientTuples),
        proxy_input_count: memberEmails.length,
        proxy_input_hash: hashStringList(memberEmails),
        proxy_sent_count: memberEmails.length,
        proxy_sent_hash: hashStringList(memberEmails),
        proxy_site_count: 1,
        proxy_batch_count: batchIds.length,
        proxy_first_created_at: proxyLastCreatedAt.toISOString(),
        proxy_last_created_at: proxyLastCreatedAt.toISOString()
    };
    const {payloadJson} = canonicalizeLegacyProofPayload(payload);
    return {
        proof: payload,
        signature: crypto.sign(null, Buffer.from(payloadJson, 'utf8'), LEGACY_PROOF_KEY_PAIR.privateKey).toString('base64url'),
        payloadJson
    };
}

function createLegacyProofDatabase({batches = [], recipients = [], existingProof} = {}) {
    const state = {
        batches,
        recipients,
        existingProof,
        insertedProofs: [],
        calls: []
    };
    const db = {
        knex(table) {
            state.calls.push(table);
            const query = {
                select() {
                    return query;
                },
                where() {
                    return query;
                },
                forUpdate() {
                    return query;
                },
                transacting() {
                    return query;
                },
                first() {
                    return Promise.resolve(table === 'email_partial_resume_proofs' ? state.existingProof : undefined);
                },
                insert(row) {
                    if (table !== 'email_partial_resume_proofs') {
                        throw new Error(`Unexpected insert into ${table}`);
                    }
                    state.insertedProofs.push(row);
                    return {
                        transacting: async () => undefined
                    };
                },
                then(resolve, reject) {
                    const rows = table === 'email_batches' ? state.batches : (table === 'email_recipients' ? state.recipients : []);
                    return Promise.resolve(rows).then(resolve, reject);
                }
            };
            return query;
        }
    };

    return {db, state};
}

describe('Email Service', function () {
    let memberCount, limited, verificicationRequired, service;
    let scheduleEmail, assertCanStartPartialResume, updateStatusLock;
    let settings, settingsCache;
    let membersRepository;
    let emailRenderer;
    let sendingService;
    let scheduleRecurringNewslettersJob;
    let domainWarmingService;
    let getMembersCount;
    let configValues;
    let legacyProofDatabase;
    let Email;

    beforeEach(function () {
        memberCount = 123;
        limited = {
            emails: null, // null = not limited, true = limited and error, false = limited no error
            members: null
        };
        verificicationRequired = false;
        scheduleEmail = sinon.stub().returns();
        assertCanStartPartialResume = sinon.stub().resolves({
            missingRecipientCount: 1,
            renderHash: 'a'.repeat(64)
        });
        updateStatusLock = sinon.stub().resolves(createModel({
            id: 'locked-email-id',
            status: 'pending',
            partial_resume: true
        }));
        scheduleRecurringNewslettersJob = sinon.stub().resolves();
        settings = {};
        settingsCache = {
            get(key) {
                return settings[key];
            }
        };
        membersRepository = {
            get: sinon.stub().returns(undefined)
        };
        emailRenderer = {
            getSubject: () => {
                return 'Subject';
            },
            getFromAddress: () => {
                return 'From';
            },
            getReplyToAddress: () => {
                return 'ReplyTo';
            },
            renderBody: () => {
                return {
                    html: 'HTML',
                    plaintext: 'Plaintext',
                    replacements: []
                };
            },
            getSegmentForAudience: (post, memberStatus) => {
                if (memberStatus === 'free') {
                    return 'status:free';
                }
                if (memberStatus === 'paid') {
                    return 'status:-free';
                }
                return null;
            },
            describeSegment: (post, segment) => {
                return {
                    status: segment?.includes('status:-free') ? 'status:-free' : (segment?.includes('status:free') ? 'status:free' : null),
                    hasPostAccess: true
                };
            }
        };
        sendingService = {
            send: sinon.stub().returns()
        };
        domainWarmingService = {
            isEnabled: sinon.stub().returns(false),
            getWarmupLimit: sinon.stub()
        };
        getMembersCount = sinon.stub().callsFake(() => Promise.resolve(memberCount));
        configValues = {};
        legacyProofDatabase = createLegacyProofDatabase();
        Email = createModelClass();

        service = new EmailService({
            emailSegmenter: {
                getMembersCount
            },
            limitService: {
                isLimited: (type) => {
                    return typeof limited[type] === 'boolean';
                },
                errorIfIsOverLimit: (type) => {
                    if (limited[type]) {
                        throw new Error('Over limit');
                    }
                },
                errorIfWouldGoOverLimit: (type) => {
                    if (limited[type]) {
                        throw new Error('Would go over limit');
                    }
                }
            },
            verificationTrigger: {
                checkVerificationRequired: () => {
                    return Promise.resolve(verificicationRequired);
                }
            },
            models: {
                Email
            },
            batchSendingService: {
                scheduleEmail,
                assertCanStartPartialResume,
                updateStatusLock
            },
            settingsCache,
            emailRenderer,
            membersRepository,
            sendingService,
            emailAnalyticsJobs: {
                scheduleRecurringNewslettersJob
            },
            domainWarmingService: domainWarmingService,
            db: legacyProofDatabase.db,
            config: {
                get(key) {
                    return configValues[key];
                }
            }
        });
    });

    afterEach(function () {
        sinon.restore();
    });

    describe('checkLimits', function () {
        it('Throws if over member limit', async function () {
            limited.members = true;
            await assert.rejects(service.checkLimits(), /Over limit/);
        });

        it('Throws if over email limit', async function () {
            limited.emails = true;
            await assert.rejects(service.checkLimits(), /Would go over limit/);
        });

        it('Throws if verification is required', async function () {
            verificicationRequired = true;
            await assert.rejects(service.checkLimits(), /Email sending is temporarily disabled/);
        });

        it('Throws with EMAIL_VERIFICATION_NEEDED code when verification is required', async function () {
            verificicationRequired = true;
            try {
                await service.checkLimits();
                assert.fail('Should have thrown');
            } catch (e) {
                assert.equal(e.code, 'EMAIL_VERIFICATION_NEEDED');
            }
        });

        it('Uses custom message when config provides emailSendingDisabledMessage', async function () {
            const customService = new EmailService({
                emailSegmenter: {
                    getMembersCount: () => Promise.resolve(memberCount)
                },
                limitService: {
                    isLimited: () => false,
                    errorIfIsOverLimit: () => {},
                    errorIfWouldGoOverLimit: () => {}
                },
                verificationTrigger: {
                    checkVerificationRequired: () => Promise.resolve(true)
                },
                models: {Email: createModelClass()},
                batchSendingService: {scheduleEmail},
                settingsCache,
                emailRenderer,
                membersRepository,
                sendingService,
                emailAnalyticsJobs: {scheduleRecurringNewslettersJob},
                domainWarmingService,
                config: {
                    get(key) {
                        if (key === 'hostSettings:emailVerification:emailSendingDisabledMessage') {
                            return 'Custom: Email paused. Contact help@example.com';
                        }
                        return undefined;
                    }
                }
            });

            try {
                await customService.checkLimits();
                assert.fail('Should have thrown');
            } catch (e) {
                assert.equal(e.message, 'Custom: Email paused. Contact help@example.com');
                assert.equal(e.code, 'EMAIL_VERIFICATION_NEEDED');
            }
        });

        it('Does not throw if limits are enabled', async function () {
            // Enable limits, but don't go over limit
            limited.members = false;
            limited.emails = false;
            await assert.doesNotReject(service.checkLimits());
        });
    });

    describe('checkCanSendEmail', function () {
        it('Throws if newsletter is null', async function () {
            await assert.rejects(
                service.checkCanSendEmail(null, 'all'),
                /The post does not have a newsletter relation/
            );
        });

        it('Throws if newsletter is archived', async function () {
            const newsletter = createModel({
                status: 'archived'
            });
            await assert.rejects(
                service.checkCanSendEmail(newsletter, 'all'),
                /Cannot send email to archived newsletters/
            );
        });

        it('Throws if over member limit', async function () {
            limited.members = true;
            const newsletter = createModel({
                status: 'active'
            });
            await assert.rejects(
                service.checkCanSendEmail(newsletter, 'all'),
                /Over limit/
            );
        });

        it('Throws if over email limit', async function () {
            limited.emails = true;
            const newsletter = createModel({
                status: 'active'
            });
            await assert.rejects(
                service.checkCanSendEmail(newsletter, 'all'),
                /Would go over limit/
            );
        });

        it('Throws if verification is required', async function () {
            verificicationRequired = true;
            const newsletter = createModel({
                status: 'active'
            });
            await assert.rejects(
                service.checkCanSendEmail(newsletter, 'all'),
                /Email sending is temporarily disabled/
            );
        });

        it('Does not throw for active newsletter within limits', async function () {
            limited.members = false;
            limited.emails = false;
            const newsletter = createModel({
                status: 'active'
            });
            await assert.doesNotReject(service.checkCanSendEmail(newsletter, 'all'));
        });

        it('Revalidates limits without recounting when an email count is supplied', async function () {
            limited.emails = true;
            const newsletter = createModel({
                status: 'active'
            });

            await assert.rejects(
                service.checkCanSendEmail(newsletter, 'all', {emailCount: 42}),
                /Would go over limit/
            );

            sinon.assert.notCalled(getMembersCount);
        });
    });

    describe('createEmail', function () {
        it('Throws if post does not have a newsletter', async function () {
            const post = createModel({
                newsletter: null
            });

            await assert.rejects(service.createEmail(post), /The post does not have a newsletter relation/);
        });

        it('Throws if post does not have an active newsletter', async function () {
            const post = createModel({
                id: '123',
                newsletter: createModel({
                    status: 'archived'
                })
            });

            await assert.rejects(service.createEmail(post), /Cannot send email to archived newsletters/);
        });

        it('Creates and schedules an email', async function () {
            const post = createModel({
                id: '123',
                newsletter: createModel({
                    status: 'active',
                    feedback_enabled: true
                }),
                mobiledoc: 'Mobiledoc'
            });

            const email = await service.createEmail(post);
            sinon.assert.calledOnce(scheduleEmail);
            assert.equal(email.get('feedback_enabled'), true);
            assert.equal(email.get('newsletter_id'), post.get('newsletter').id);
            assert.equal(email.get('post_id'), post.id);
            assert.equal(email.get('status'), 'pending');
            assert.equal(email.get('source'), post.get('mobiledoc'));
            assert.equal(email.get('source_type'), 'mobiledoc');
            sinon.assert.calledOnce(scheduleRecurringNewslettersJob);
        });

        it('Reuses the recipient count when preflight data matches the saved post', async function () {
            const newsletter = createModel({
                id: 'newsletter-123',
                status: 'active',
                feedback_enabled: true
            });
            const post = createModel({
                id: 'post-123',
                newsletter,
                email_recipient_filter: 'status:paid',
                mobiledoc: 'Mobiledoc'
            });

            const email = await service.createEmail(post, {
                preflight: {
                    newsletter,
                    emailRecipientFilter: 'status:paid',
                    emailCount: 42
                }
            });

            sinon.assert.notCalled(getMembersCount);
            assert.equal(email.get('email_count'), 42);
        });

        it('Recounts recipients when preflight data does not match the saved post', async function () {
            const newsletter = createModel({
                id: 'newsletter-123',
                status: 'active',
                feedback_enabled: true
            });
            const post = createModel({
                id: 'post-123',
                newsletter,
                email_recipient_filter: 'status:paid',
                mobiledoc: 'Mobiledoc'
            });

            const email = await service.createEmail(post, {
                preflight: {
                    newsletter,
                    emailRecipientFilter: 'status:free',
                    emailCount: 42
                }
            });

            sinon.assert.calledOnceWithExactly(getMembersCount, newsletter, 'status:paid');
            assert.equal(email.get('email_count'), memberCount);
        });

        it('Revalidates newsletter status without recounting when preflight data matches', async function () {
            const newsletter = createModel({
                id: 'newsletter-123',
                status: 'archived'
            });
            const post = createModel({
                id: 'post-123',
                newsletter,
                email_recipient_filter: 'all'
            });

            await assert.rejects(service.createEmail(post, {
                preflight: {
                    newsletter,
                    emailRecipientFilter: 'all',
                    emailCount: 42
                }
            }), /Cannot send email to archived newsletters/);

            sinon.assert.notCalled(getMembersCount);
        });

        describe('Domain warming', function () {
            it('Creates email without csd_email_count when domain warming is disabled', async function () {
                domainWarmingService.isEnabled.returns(false);

                const post = createModel({
                    id: '123',
                    newsletter: createModel({
                        status: 'active',
                        feedback_enabled: true
                    }),
                    mobiledoc: 'Mobiledoc'
                });

                const email = await service.createEmail(post);
                sinon.assert.calledOnce(domainWarmingService.isEnabled);
                sinon.assert.notCalled(domainWarmingService.getWarmupLimit);
                assert.equal(email.get('csd_email_count'), undefined);
            });

            it('Creates email with csd_email_count when domain warming is enabled', async function () {
                domainWarmingService.isEnabled.returns(true);
                domainWarmingService.getWarmupLimit.resolves(500);

                const post = createModel({
                    id: '123',
                    newsletter: createModel({
                        status: 'active',
                        feedback_enabled: true
                    }),
                    mobiledoc: 'Mobiledoc'
                });

                const email = await service.createEmail(post);
                sinon.assert.calledOnce(domainWarmingService.isEnabled);
                sinon.assert.calledOnce(domainWarmingService.getWarmupLimit);
                sinon.assert.calledWith(domainWarmingService.getWarmupLimit, memberCount);
                assert.equal(email.get('csd_email_count'), 500);
            });

            it('Creates email with correct email_count passed to getWarmupLimit', async function () {
                memberCount = 2500;
                domainWarmingService.isEnabled.returns(true);
                domainWarmingService.getWarmupLimit.resolves(1000);

                const post = createModel({
                    id: '123',
                    newsletter: createModel({
                        status: 'active',
                        feedback_enabled: true
                    }),
                    mobiledoc: 'Mobiledoc'
                });

                const email = await service.createEmail(post);
                sinon.assert.calledOnce(domainWarmingService.getWarmupLimit);
                sinon.assert.calledWith(domainWarmingService.getWarmupLimit, 2500);
                assert.equal(email.get('email_count'), 2500);
                assert.equal(email.get('csd_email_count'), 1000);
            });
        });

        it('Ignores analytics job scheduling errors', async function () {
            const post = createModel({
                id: '123',
                newsletter: createModel({
                    status: 'active',
                    feedback_enabled: true
                }),
                mobiledoc: 'Mobiledoc'
            });

            scheduleRecurringNewslettersJob.rejects(new Error('Test error'));
            await service.createEmail(post);
            sinon.assert.calledOnce(scheduleRecurringNewslettersJob);
        });

        it('Creates and schedules an email with lexical', async function () {
            const post = createModel({
                id: '123',
                newsletter: createModel({
                    status: 'active',
                    feedback_enabled: true
                }),
                lexical: 'Lexical'
            });

            const email = await service.createEmail(post);
            sinon.assert.calledOnce(scheduleEmail);
            assert.equal(email.get('feedback_enabled'), true);
            assert.equal(email.get('newsletter_id'), post.get('newsletter').id);
            assert.equal(email.get('post_id'), post.id);
            assert.equal(email.get('status'), 'pending');
            assert.equal(email.get('source'), post.get('lexical'));
            assert.equal(email.get('source_type'), 'lexical');
        });

        it('Stores the error in the email model if scheduling fails', async function () {
            const post = createModel({
                id: '123',
                newsletter: createModel({
                    status: 'active',
                    feedback_enabled: true
                })
            });

            scheduleEmail.throws(new Error('Test error'));
            updateStatusLock.resolves(createModel({
                status: 'failed',
                error: 'Something went wrong while scheduling the email'
            }));

            const email = await service.createEmail(post);
            sinon.assert.calledOnce(scheduleEmail);

            assert.equal(email.get('error'), 'Something went wrong while scheduling the email');
            assert.equal(email.get('status'), 'failed');
        });

        it('Stores a default error in the email model if scheduling fails', async function () {
            const post = createModel({
                id: '123',
                newsletter: createModel({
                    status: 'active',
                    feedback_enabled: true
                })
            });

            scheduleEmail.throws(new Error());
            updateStatusLock.resolves(createModel({
                status: 'failed',
                error: 'Something went wrong while scheduling the email'
            }));

            const email = await service.createEmail(post);
            sinon.assert.calledOnce(scheduleEmail);

            assert.equal(email.get('error'), 'Something went wrong while scheduling the email');
            assert.equal(email.get('status'), 'failed');
        });

        it('Checks limits before scheduling', async function () {
            const post = createModel({
                id: '123',
                newsletter: createModel({
                    status: 'active',
                    feedback_enabled: true
                })
            });
            limited.emails = true;

            await assert.rejects(service.createEmail(post));
            sinon.assert.notCalled(scheduleEmail);
        });

        it('awaits a rejected normal enqueue and atomically marks only the pending email failed', async function () {
            const post = createModel({
                id: '123',
                newsletter: createModel({
                    status: 'active',
                    feedback_enabled: true
                })
            });
            const createdEmail = createModel({id: 'normal-create-email', status: 'pending'});
            Email.add = sinon.stub().resolves(createdEmail);
            scheduleEmail.rejects(new Error('scheduler implementation detail'));
            updateStatusLock.callsFake(async (Model, id, status, allowedStatuses, data) => {
                assert.equal(Model, Email);
                assert.equal(id, createdEmail.id);
                assert.equal(status, 'failed');
                assert.deepEqual(allowedStatuses, ['pending']);
                await createdEmail.save({...data, status}, {patch: true});
                return createdEmail;
            });

            const email = await service.createEmail(post);

            assert.equal(email.get('status'), 'failed');
            assert.equal(email.get('error'), 'Something went wrong while scheduling the email');
            sinon.assert.calledOnceWithExactly(scheduleEmail, createdEmail);
        });

        it('does not clobber a normal email if its worker claims submitting before enqueue rejection', async function () {
            const post = createModel({
                id: '123',
                newsletter: createModel({
                    status: 'active',
                    feedback_enabled: true
                })
            });
            const createdEmail = createModel({id: 'normal-create-email', status: 'pending'});
            Email.add = sinon.stub().resolves(createdEmail);
            scheduleEmail.rejects(new Error('scheduler implementation detail'));
            updateStatusLock.resolves(undefined);

            await assert.rejects(service.createEmail(post), /Something went wrong while scheduling the email/);

            sinon.assert.calledOnceWithExactly(
                updateStatusLock,
                Email,
                createdEmail.id,
                'failed',
                ['pending'],
                {error: 'Something went wrong while scheduling the email'}
            );
            assert.equal(createdEmail.get('status'), 'pending');
        });
    });

    describe('Retry email', function () {
        it('Schedules email again', async function () {
            const email = createModel({
                status: 'failed',
                error: 'Test error',
                post: createModel({
                    status: 'published'
                })
            });

            await service.retryEmail(email);
            sinon.assert.calledOnce(scheduleEmail);
        });

        it('awaits a rejected retry enqueue and atomically restores failed state', async function () {
            const email = createModel({
                id: 'normal-retry-email',
                status: 'failed',
                error: 'previous send failure',
                post: createModel({status: 'published'})
            });
            scheduleEmail.rejects(new Error('scheduler implementation detail'));
            updateStatusLock.callsFake(async (Model, id, status, allowedStatuses, data) => {
                assert.equal(Model, Email);
                assert.equal(id, email.id);
                assert.equal(status, 'failed');
                assert.deepEqual(allowedStatuses, ['pending']);
                await email.save({...data, status}, {patch: true});
                return email;
            });

            const result = await service.retryEmail(email);

            assert.equal(result.get('status'), 'failed');
            assert.equal(result.get('error'), 'Something went wrong while scheduling the email');
            sinon.assert.calledOnceWithExactly(scheduleEmail, email);
        });

        it('Does not schedule email again if draft', async function () {
            const email = createModel({
                status: 'failed',
                error: 'Test error',
                post: createModel({
                    status: 'draft'
                })
            });

            await assert.rejects(service.retryEmail(email));
            sinon.assert.notCalled(scheduleEmail);
        });

        it('Checks limits before scheduling', async function () {
            const email = createModel({
                status: 'failed',
                error: 'Test error'
            });

            limited.emails = true;
            assert.rejects(service.retryEmail(email));
            sinon.assert.notCalled(scheduleEmail);
        });

        it('Throws BadRequestError if email status is not failed', async function () {
            const email = createModel({
                status: 'submitting',
                post: createModel({
                    status: 'published'
                })
            });

            await assert.rejects(
                service.retryEmail(email),
                err => err.statusCode === 400 && /Only failed emails can be retried/.test(err.message)
            );
            sinon.assert.notCalled(scheduleEmail);
        });
    });

    describe('Partial email continuation', function () {
        it('locks a submitted email, marks it partial, and schedules the dedicated job', async function () {
            const email = createModel({
                id: 'email-id',
                status: 'submitted',
                partial_resume: false
            });
            const lockedEmail = createModel({
                id: 'email-id',
                status: 'pending',
                partial_resume: true
            });
            const claimedEmail = createModel({
                id: 'email-id',
                status: 'submitting',
                partial_resume: true,
                partial_resume_enqueue_claim: 'claim'
            });
            updateStatusLock.onFirstCall().resolves(lockedEmail);
            updateStatusLock.onSecondCall().resolves(claimedEmail);

            const result = await service.resumePartialEmail(email);

            sinon.assert.calledOnceWithExactly(assertCanStartPartialResume, email);
            assert.equal(updateStatusLock.callCount, 2);
            const [, emailId, status, allowedStatuses, patch] = updateStatusLock.firstCall.args;
            assert.equal(emailId, 'email-id');
            assert.equal(status, 'pending');
            assert.deepEqual(allowedStatuses, ['submitted']);
            assert.deepEqual(patch, {
                partial_resume: true,
                partial_resume_render_hash: 'a'.repeat(64),
                partial_resume_enqueue_claim: null,
                error: null
            });
            sinon.assert.calledWithExactly(
                updateStatusLock,
                sinon.match.any,
                'email-id',
                'submitting',
                ['pending'],
                {error: null, partial_resume_enqueue_claim: sinon.match.string},
                {
                    expectedPartialResume: true,
                    expectedError: null,
                    expectedPartialResumeEnqueueClaim: null
                }
            );
            sinon.assert.calledOnceWithExactly(scheduleEmail, claimedEmail, {
                partialResumeClaimed: true,
                partialResumeClaim: sinon.match.string
            });
            const durableClaim = updateStatusLock.secondCall.args[4].partial_resume_enqueue_claim;
            assert.match(durableClaim, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
            assert.equal(scheduleEmail.firstCall.args[1].partialResumeClaim, durableClaim);
            assert.equal(result, lockedEmail);
        });

        it('fails the partial continuation with a sanitized error when enqueueing throws after the lock', async function () {
            const email = createModel({
                id: 'email-id',
                status: 'submitted',
                partial_resume: false
            });
            const pendingEmail = createModel({
                id: 'email-id',
                status: 'pending',
                partial_resume: true
            });
            const failedEmail = createModel({
                id: 'email-id',
                status: 'failed',
                partial_resume: true,
                error: 'Something went wrong while scheduling the partial continuation'
            });
            const claimedEmail = createModel({
                id: 'email-id',
                status: 'submitting',
                partial_resume: true
            });
            updateStatusLock.onFirstCall().resolves(pendingEmail);
            updateStatusLock.onSecondCall().resolves(claimedEmail);
            updateStatusLock.onThirdCall().resolves(failedEmail);
            scheduleEmail.throws(new Error('scheduler implementation detail'));

            const result = await service.resumePartialEmail(email);

            assert.equal(result, failedEmail);
            assert.equal(updateStatusLock.callCount, 3);
            sinon.assert.calledWithExactly(
                updateStatusLock,
                sinon.match.any,
                'email-id',
                'failed',
                ['submitting'],
                {
                    error: 'Something went wrong while scheduling the partial continuation',
                    partial_resume_enqueue_claim: null
                },
                {
                    expectedPartialResume: true,
                    expectedError: null,
                    expectedPartialResumeEnqueueClaim: sinon.match.string
                }
            );
            sinon.assert.calledOnceWithExactly(scheduleEmail, claimedEmail, {
                partialResumeClaimed: true,
                partialResumeClaim: sinon.match.string
            });
            const durableClaim = updateStatusLock.secondCall.args[4].partial_resume_enqueue_claim;
            assert.match(durableClaim, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
            assert.equal(scheduleEmail.firstCall.args[1].partialResumeClaim, durableClaim);
        });

        it('fails the partial continuation with a sanitized error when enqueueing rejects after the lock', async function () {
            const email = createModel({
                id: 'email-id',
                status: 'submitted',
                partial_resume: false
            });
            const pendingEmail = createModel({
                id: 'email-id',
                status: 'pending',
                partial_resume: true
            });
            const failedEmail = createModel({
                id: 'email-id',
                status: 'failed',
                partial_resume: true,
                error: 'Something went wrong while scheduling the partial continuation'
            });
            const claimedEmail = createModel({
                id: 'email-id',
                status: 'submitting',
                partial_resume: true
            });
            updateStatusLock.onFirstCall().resolves(pendingEmail);
            updateStatusLock.onSecondCall().resolves(claimedEmail);
            updateStatusLock.onThirdCall().resolves(failedEmail);
            scheduleEmail.rejects(new Error('scheduler implementation detail'));

            const result = await service.resumePartialEmail(email);

            assert.equal(result, failedEmail);
            assert.equal(updateStatusLock.callCount, 3);
            sinon.assert.calledWithExactly(
                updateStatusLock,
                sinon.match.any,
                'email-id',
                'failed',
                ['submitting'],
                {
                    error: 'Something went wrong while scheduling the partial continuation',
                    partial_resume_enqueue_claim: null
                },
                {
                    expectedPartialResume: true,
                    expectedError: null,
                    expectedPartialResumeEnqueueClaim: sinon.match.string
                }
            );
            sinon.assert.calledOnceWithExactly(scheduleEmail, claimedEmail, {
                partialResumeClaimed: true,
                partialResumeClaim: sinon.match.string
            });
            const durableClaim = updateStatusLock.secondCall.args[4].partial_resume_enqueue_claim;
            assert.match(durableClaim, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
            assert.equal(scheduleEmail.firstCall.args[1].partialResumeClaim, durableClaim);
        });

        it('does not clobber a partial continuation claimed while its enqueue throws', async function () {
            const email = createModel({
                id: 'email-id',
                status: 'submitted',
                partial_resume: false
            });
            const pendingEmail = createModel({
                id: 'email-id',
                status: 'pending',
                partial_resume: true
            });
            const claimedEmail = createModel({
                id: 'email-id',
                status: 'submitting',
                partial_resume: true
            });
            updateStatusLock.onFirstCall().resolves(pendingEmail);
            updateStatusLock.onSecondCall().resolves(claimedEmail);
            // Simulates an accepted job that already swapped the enqueue claim
            // for a worker claim before addJob reports an error.
            updateStatusLock.onThirdCall().resolves(undefined);
            scheduleEmail.throws(new Error('scheduler implementation detail'));

            await assert.rejects(service.resumePartialEmail(email), /Something went wrong while scheduling the partial continuation/);

            assert.equal(updateStatusLock.callCount, 3);
            sinon.assert.calledWithExactly(
                updateStatusLock,
                sinon.match.any,
                'email-id',
                'failed',
                ['submitting'],
                {
                    error: 'Something went wrong while scheduling the partial continuation',
                    partial_resume_enqueue_claim: null
                },
                {
                    expectedPartialResume: true,
                    expectedError: null,
                    expectedPartialResumeEnqueueClaim: sinon.match.string
                }
            );
            sinon.assert.calledOnceWithExactly(scheduleEmail, claimedEmail, {
                partialResumeClaimed: true,
                partialResumeClaim: sinon.match.string
            });
            const durableClaim = updateStatusLock.secondCall.args[4].partial_resume_enqueue_claim;
            assert.match(durableClaim, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
            assert.equal(scheduleEmail.firstCall.args[1].partialResumeClaim, durableClaim);
        });

        it('allows only the explicit partial route to re-open a safe failed continuation', async function () {
            const email = createModel({
                id: 'email-id',
                status: 'failed',
                partial_resume: true
            });
            const lockedEmail = createModel({
                id: 'email-id',
                status: 'pending',
                partial_resume: true
            });
            const claimedEmail = createModel({
                id: 'email-id',
                status: 'submitting',
                partial_resume: true
            });
            updateStatusLock.onFirstCall().resolves(lockedEmail);
            updateStatusLock.onSecondCall().resolves(claimedEmail);

            const result = await service.resumePartialEmail(email);

            sinon.assert.calledOnceWithExactly(assertCanStartPartialResume, email);
            const [, emailId, status, allowedStatuses, patch] = updateStatusLock.firstCall.args;
            assert.equal(emailId, 'email-id');
            assert.equal(status, 'pending');
            assert.deepEqual(allowedStatuses, ['failed']);
            assert.deepEqual(patch, {
                partial_resume: true,
                partial_resume_render_hash: 'a'.repeat(64),
                partial_resume_enqueue_claim: null,
                error: null
            });
            sinon.assert.calledOnceWithExactly(scheduleEmail, claimedEmail, {
                partialResumeClaimed: true,
                partialResumeClaim: sinon.match.string
            });
            const durableClaim = updateStatusLock.secondCall.args[4].partial_resume_enqueue_claim;
            assert.match(durableClaim, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
            assert.equal(scheduleEmail.firstCall.args[1].partialResumeClaim, durableClaim);
            assert.equal(result, lockedEmail);
        });

        it('rejects non-submitted emails before the partial preflight', async function () {
            const email = createModel({
                id: 'email-id',
                status: 'failed',
                partial_resume: false
            });

            await assert.rejects(service.resumePartialEmail(email), /Only submitted emails can start a partial continuation/);
            sinon.assert.notCalled(assertCanStartPartialResume);
            sinon.assert.notCalled(updateStatusLock);
            sinon.assert.notCalled(scheduleEmail);
        });

        it('does not schedule when a concurrent state change wins the lock', async function () {
            const email = createModel({
                id: 'email-id',
                status: 'submitted',
                partial_resume: false
            });
            updateStatusLock.resolves(undefined);

            await assert.rejects(service.resumePartialEmail(email), /changed before its partial continuation could start/);
            sinon.assert.calledOnce(assertCanStartPartialResume);
            sinon.assert.calledOnce(updateStatusLock);
            sinon.assert.notCalled(scheduleEmail);
        });

        it('blocks the generic retry route for a failed partial continuation', async function () {
            const email = createModel({
                id: 'email-id',
                status: 'failed',
                partial_resume: true
            });

            await assert.rejects(service.retryEmail(email), /cannot use the generic retry path/);
            sinon.assert.notCalled(scheduleEmail);
        });
    });

    describe('Legacy partial-resume proof admission', function () {
        function configureAdmission({
            status = 'submitted',
            partialResume = false,
            batches = [
                {id: LEGACY_BATCH_IDS[0], email_id: LEGACY_EMAIL_ID, status: 'submitted', provider_id: LEGACY_EMAIL_ID},
                {id: LEGACY_BATCH_IDS[1], email_id: LEGACY_EMAIL_ID, status: 'submitted', provider_id: LEGACY_EMAIL_ID}
            ],
            recipients = [
                {batch_id: LEGACY_BATCH_IDS[0], member_id: LEGACY_MEMBER_IDS[0], member_email: LEGACY_MEMBER_EMAILS[0]},
                {batch_id: LEGACY_BATCH_IDS[1], member_id: LEGACY_MEMBER_IDS[1], member_email: LEGACY_MEMBER_EMAILS[1]}
            ],
            existingProof
        } = {}) {
            const email = createModel({
                id: LEGACY_EMAIL_ID,
                status,
                partial_resume: partialResume
            });
            Email.findOne = sinon.stub().resolves(email);
            configValues[LEGACY_PUBLIC_KEY_CONFIG] = LEGACY_PROOF_KEY_PAIR.publicKey.export({type: 'spki', format: 'pem'});
            legacyProofDatabase.state.batches = batches;
            legacyProofDatabase.state.recipients = recipients;
            legacyProofDatabase.state.existingProof = existingProof;
            return email;
        }

        it('persists exactly one reconciled proof without scheduling or changing the submitted email', async function () {
            const email = configureAdmission();
            const {proof, signature, payloadJson} = createSignedLegacyProof();

            const result = await service.admitLegacyPartialResumeProof(email, {proof, signature});

            assert.equal(result, email);
            sinon.assert.calledOnceWithExactly(Email.findOne, {id: LEGACY_EMAIL_ID}, {
                require: true,
                transacting: {transacting: 'transacting'},
                forUpdate: true
            });
            assert.equal(legacyProofDatabase.state.insertedProofs.length, 1);
            const [persisted] = legacyProofDatabase.state.insertedProofs;
            assert.match(persisted.id, /^[a-f0-9]{24}$/);
            assert.equal(persisted.email_id, LEGACY_EMAIL_ID);
            assert.equal(persisted.proof_payload, payloadJson);
            assert.equal(persisted.proof_hash, crypto.createHash('sha256').update(payloadJson, 'utf8').digest('hex'));
            assert.equal(persisted.signature, signature);
            assert.equal(persisted.transport, 'ses-proxy-mailgun-v1');
            assert.match(persisted.signing_key_fingerprint, /^[a-f0-9]{64}$/);
            assert.ok(persisted.created_at instanceof Date);
            assert.equal(email.get('status'), 'submitted');
            assert.equal(email.get('partial_resume'), false);
            sinon.assert.notCalled(scheduleEmail);
        });

        it('rejects a missing public key before reading or writing the database', async function () {
            const email = createModel({id: LEGACY_EMAIL_ID, status: 'submitted', partial_resume: false});
            const {proof, signature} = createSignedLegacyProof();

            await assert.rejects(
                service.admitLegacyPartialResumeProof(email, {proof, signature}),
                error => error.statusCode === 400 && /configured/i.test(error.message)
            );
            assert.deepEqual(legacyProofDatabase.state.calls, []);
            assert.deepEqual(legacyProofDatabase.state.insertedProofs, []);
            sinon.assert.notCalled(scheduleEmail);
        });

        it('rejects invalid, stale, and unknown-transport proofs before a database write', async function () {
            const email = configureAdmission();
            const valid = createSignedLegacyProof();
            const unknownTransport = {...valid.proof, transport: 'unknown-transport'};
            const stale = createSignedLegacyProof({
                issuedAt: new Date(Date.now() - 48 * 60 * 60 * 1000),
                proxyLastCreatedAt: new Date(Date.now() - (48 * 60 * 60 * 1000) - 1000)
            });

            await assert.rejects(service.admitLegacyPartialResumeProof(email, {proof: valid.proof, signature: Buffer.alloc(64).toString('base64url')}), error => error.statusCode === 400);
            await assert.rejects(service.admitLegacyPartialResumeProof(email, stale), error => error.statusCode === 400 && /stale/i.test(error.message));
            await assert.rejects(service.admitLegacyPartialResumeProof(email, {proof: unknownTransport, signature: valid.signature}), error => error.statusCode === 400 && /transport/i.test(error.message));

            assert.deepEqual(legacyProofDatabase.state.calls, []);
            assert.deepEqual(legacyProofDatabase.state.insertedProofs, []);
            sinon.assert.notCalled(scheduleEmail);
        });

        it('rejects a submitted proof when any batch is outside the signed legacy prefix', async function () {
            const email = configureAdmission({
                batches: [
                    {id: LEGACY_BATCH_IDS[0], email_id: LEGACY_EMAIL_ID, status: 'submitted', provider_id: LEGACY_EMAIL_ID},
                    {id: LEGACY_BATCH_IDS[1], email_id: LEGACY_EMAIL_ID, status: 'submitted', provider_id: LEGACY_EMAIL_ID},
                    {id: '64b000000000000000000004', email_id: LEGACY_EMAIL_ID, status: 'submitted', provider_id: LEGACY_EMAIL_ID}
                ]
            });
            const signedProof = createSignedLegacyProof();

            await assert.rejects(service.admitLegacyPartialResumeProof(email, signedProof), error => error.statusCode === 400 && /batch/i.test(error.message));
            assert.deepEqual(legacyProofDatabase.state.insertedProofs, []);
            sinon.assert.notCalled(scheduleEmail);
        });

        it('rejects mismatched provider batches and duplicate recipient ledger identities', async function () {
            const providerMismatchEmail = configureAdmission({
                batches: [
                    {id: LEGACY_BATCH_IDS[0], email_id: LEGACY_EMAIL_ID, status: 'submitted', provider_id: LEGACY_EMAIL_ID},
                    {id: LEGACY_BATCH_IDS[1], email_id: LEGACY_EMAIL_ID, status: 'submitted', provider_id: 'unexpected-provider-id'}
                ]
            });
            const signedProof = createSignedLegacyProof();

            await assert.rejects(service.admitLegacyPartialResumeProof(providerMismatchEmail, signedProof), error => error.statusCode === 400 && /batch/i.test(error.message));
            assert.deepEqual(legacyProofDatabase.state.insertedProofs, []);

            const duplicateLedgerEmail = configureAdmission({
                recipients: [
                    {batch_id: LEGACY_BATCH_IDS[0], member_id: LEGACY_MEMBER_IDS[0], member_email: LEGACY_MEMBER_EMAILS[0]},
                    {batch_id: LEGACY_BATCH_IDS[1], member_id: LEGACY_MEMBER_IDS[0], member_email: LEGACY_MEMBER_EMAILS[1]}
                ]
            });
            await assert.rejects(service.admitLegacyPartialResumeProof(duplicateLedgerEmail, signedProof), error => error.statusCode === 400 && /duplicate/i.test(error.message));
            assert.deepEqual(legacyProofDatabase.state.insertedProofs, []);
            sinon.assert.notCalled(scheduleEmail);
        });

        it('rejects signed proofs whose email identity or recipient ledger hash differs from Ghost', async function () {
            const email = configureAdmission();
            const wrongEmailProof = createSignedLegacyProof({emailId: '64b000000000000000000099'});

            await assert.rejects(service.admitLegacyPartialResumeProof(email, wrongEmailProof), error => error.statusCode === 400 && /email/i.test(error.message));
            assert.deepEqual(legacyProofDatabase.state.calls, []);

            const mismatchedLedgerEmail = configureAdmission({
                recipients: [
                    {batch_id: LEGACY_BATCH_IDS[0], member_id: LEGACY_MEMBER_IDS[0], member_email: 'changed@example.test'},
                    {batch_id: LEGACY_BATCH_IDS[1], member_id: LEGACY_MEMBER_IDS[1], member_email: LEGACY_MEMBER_EMAILS[1]}
                ]
            });
            const signedProof = createSignedLegacyProof();
            await assert.rejects(service.admitLegacyPartialResumeProof(mismatchedLedgerEmail, signedProof), error => error.statusCode === 400 && /ledger/i.test(error.message));
            const swappedRecipientPairEmail = configureAdmission({
                recipients: [
                    {batch_id: LEGACY_BATCH_IDS[0], member_id: LEGACY_MEMBER_IDS[0], member_email: LEGACY_MEMBER_EMAILS[1]},
                    {batch_id: LEGACY_BATCH_IDS[1], member_id: LEGACY_MEMBER_IDS[1], member_email: LEGACY_MEMBER_EMAILS[0]}
                ]
            });
            await assert.rejects(service.admitLegacyPartialResumeProof(swappedRecipientPairEmail, signedProof), error => error.statusCode === 400 && /ledger/i.test(error.message));
            assert.deepEqual(legacyProofDatabase.state.insertedProofs, []);
            sinon.assert.notCalled(scheduleEmail);
        });

        it('rejects an existing proof, non-submitted email, and already-marked continuation', async function () {
            const signedProof = createSignedLegacyProof();
            const existingProofEmail = configureAdmission({existingProof: {id: '64b000000000000000000099'}});

            await assert.rejects(service.admitLegacyPartialResumeProof(existingProofEmail, signedProof), error => error.statusCode === 400 && /already/i.test(error.message));
            assert.deepEqual(legacyProofDatabase.state.insertedProofs, []);

            const failedEmail = configureAdmission({status: 'failed'});
            await assert.rejects(service.admitLegacyPartialResumeProof(failedEmail, signedProof), error => error.statusCode === 400 && /submitted/i.test(error.message));

            const partialEmail = configureAdmission({partialResume: true});
            await assert.rejects(service.admitLegacyPartialResumeProof(partialEmail, signedProof), error => error.statusCode === 400 && /partial/i.test(error.message));
            assert.deepEqual(legacyProofDatabase.state.insertedProofs, []);
            sinon.assert.notCalled(scheduleEmail);
        });
    });

    describe('resumeInterruptedSends', function () {
        // Mock factory that mimics the scanner's filter semantics: legacy rows use
        // `created_at`; explicit partial rows are fetched by their marker and their
        // persisted transition timestamp is classified by the service. Most tests
        // exercise the legacy pass.
        const filterAwareFindAll = emails => async ({filter}) => {
            if (filter.includes('partial_resume:true')) {
                return {models: []};
            }
            if (filter.includes('created_at:<')) {
                return {models: []};
            }
            return {models: emails};
        };

        it('Per-email try/catch: one bad email does not skip the others', async function () {
            const errorLog = sinon.stub(logging, 'error');
            const recoveryStatusLock = sinon.stub().resolves(createModel({}));

            const emails = [
                createModel({
                    id: 'good-1',
                    status: 'submitting',
                    created_at: new Date(),
                    post: createModel({status: 'published'})
                }),
                createModel({
                    id: 'bad',
                    status: 'submitting',
                    created_at: new Date(),
                    get post() {
                        throw new Error('Boom');
                    }
                }),
                createModel({
                    id: 'good-2',
                    status: 'submitting',
                    created_at: new Date(),
                    post: createModel({status: 'sent'})
                })
            ];
            // createModel exposes `post` via .related('post') / .getLazyRelation('post').
            // Override getLazyRelation on the bad one to throw — this is what the scanner awaits first.
            emails[1].getLazyRelation = () => {
                throw new Error('Boom');
            };

            const localService = new EmailService({
                emailSegmenter: {getMembersCount: () => Promise.resolve(0)},
                limitService: {isLimited: () => false, errorIfIsOverLimit: () => {}, errorIfWouldGoOverLimit: () => {}},
                verificationTrigger: {checkVerificationRequired: () => Promise.resolve(false)},
                models: {
                    Email: {findAll: filterAwareFindAll(emails)}
                },
                batchSendingService: {
                    scheduleEmail,
                    updateStatusLock: recoveryStatusLock
                },
                settingsCache,
                emailRenderer,
                membersRepository,
                sendingService,
                emailAnalyticsJobs: {scheduleRecurringNewslettersJob},
                domainWarmingService
            });

            await localService.resumeInterruptedSends();

            sinon.assert.calledTwice(scheduleEmail);
            sinon.assert.calledOnce(errorLog);
            sinon.assert.calledWith(recoveryStatusLock, sinon.match.any, 'bad', 'failed', ['submitting']);
        });

        it('fails only its pending claim when legacy recovery scheduling rejects', async function () {
            const email = createModel({
                id: 'schedule-throws-after-claim',
                status: 'submitting',
                created_at: new Date(),
                post: createModel({status: 'published'})
            });
            const recoveryStatusLock = sinon.stub()
                .onFirstCall().resolves(createModel({id: email.id, status: 'pending'}))
                .onSecondCall().resolves(createModel({}));
            const scheduleRejects = sinon.stub().rejects(new Error('Recovery scheduling failed'));
            const errorLog = sinon.stub(logging, 'error');
            const findAll = async ({filter}) => {
                if (filter.includes('partial_resume:true')) {
                    return {models: []};
                }
                return {models: [email]};
            };
            const localService = new EmailService({
                emailSegmenter: {getMembersCount: () => Promise.resolve(0)},
                limitService: {isLimited: () => false, errorIfIsOverLimit: () => {}, errorIfWouldGoOverLimit: () => {}},
                verificationTrigger: {checkVerificationRequired: () => Promise.resolve(false)},
                models: {Email: {findAll}},
                batchSendingService: {scheduleEmail: scheduleRejects, updateStatusLock: recoveryStatusLock},
                settingsCache,
                emailRenderer,
                membersRepository,
                sendingService,
                emailAnalyticsJobs: {scheduleRecurringNewslettersJob},
                domainWarmingService
            });

            await localService.resumeInterruptedSends();

            sinon.assert.calledWith(recoveryStatusLock, sinon.match.any, email.id, 'pending', ['submitting']);
            sinon.assert.calledWith(recoveryStatusLock, sinon.match.any, email.id, 'failed', ['pending']);
            assert.equal(recoveryStatusLock.callCount, 2);
            sinon.assert.calledOnce(scheduleRejects);
            sinon.assert.calledOnce(errorLog);
        });

        it('takes a durable marker claim before scheduling a pending partial continuation after a crash', async function () {
            const pendingPartial = createModel({
                id: 'pending-partial',
                status: 'pending',
                partial_resume: true,
                created_at: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
                updated_at: new Date(),
                post: createModel({status: 'published'})
            });
            const claimedPartial = createModel({
                id: pendingPartial.id,
                status: 'submitting',
                partial_resume: true,
                error: null,
                partial_resume_enqueue_claim: PARTIAL_RESUME_ENQUEUE_CLAIM
            });
            const recoveryStatusLock = sinon.stub().resolves(claimedPartial);
            sinon.stub(crypto, 'randomUUID').returns(PARTIAL_RESUME_ENQUEUE_CLAIM);
            const findAll = async ({filter}) => {
                if (filter.includes('partial_resume:true')) {
                    return {models: [pendingPartial]};
                }
                return {models: []};
            };

            const localService = new EmailService({
                emailSegmenter: {getMembersCount: () => Promise.resolve(0)},
                limitService: {isLimited: () => false, errorIfIsOverLimit: () => {}},
                verificationTrigger: {checkVerificationRequired: () => Promise.resolve(false)},
                models: {Email: {findAll}},
                batchSendingService: {scheduleEmail, updateStatusLock: recoveryStatusLock},
                settingsCache,
                emailRenderer,
                membersRepository,
                sendingService,
                emailAnalyticsJobs: {scheduleRecurringNewslettersJob},
                domainWarmingService
            });

            await localService.resumeInterruptedSends();

            sinon.assert.calledOnceWithExactly(
                recoveryStatusLock,
                sinon.match.any,
                pendingPartial.id,
                'submitting',
                ['pending'],
                {
                    error: null,
                    partial_resume_enqueue_claim: PARTIAL_RESUME_ENQUEUE_CLAIM
                },
                {
                    expectedPartialResume: true,
                    expectedPartialResumeEnqueueClaim: null
                }
            );
            sinon.assert.calledOnceWithExactly(scheduleEmail, claimedPartial, {
                partialResumeClaimed: true,
                partialResumeClaim: PARTIAL_RESUME_ENQUEUE_CLAIM
            });
        });

        it('fails only its owned durable partial claim when recovery scheduling rejects', async function () {
            const pendingPartial = createModel({
                id: 'partial-schedule-rejects-before-worker-claim',
                status: 'pending',
                partial_resume: true,
                created_at: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
                updated_at: new Date(),
                post: createModel({status: 'published'})
            });
            const claimedPartial = createModel({
                id: pendingPartial.id,
                status: 'submitting',
                partial_resume: true,
                error: null,
                partial_resume_enqueue_claim: PARTIAL_RESUME_ENQUEUE_CLAIM
            });
            const recoveryStatusLock = sinon.stub()
                .onFirstCall().resolves(claimedPartial)
                .onSecondCall().resolves(createModel({}));
            sinon.stub(crypto, 'randomUUID').returns(PARTIAL_RESUME_ENQUEUE_CLAIM);
            const scheduleRejects = sinon.stub().rejects(new Error('Partial recovery scheduling failed'));
            const errorLog = sinon.stub(logging, 'error');
            const findAll = async ({filter}) => {
                if (filter.includes('partial_resume:true')) {
                    return {models: [pendingPartial]};
                }
                return {models: []};
            };
            const localService = new EmailService({
                emailSegmenter: {getMembersCount: () => Promise.resolve(0)},
                limitService: {isLimited: () => false, errorIfIsOverLimit: () => {}, errorIfWouldGoOverLimit: () => {}},
                verificationTrigger: {checkVerificationRequired: () => Promise.resolve(false)},
                models: {Email: {findAll}},
                batchSendingService: {scheduleEmail: scheduleRejects, updateStatusLock: recoveryStatusLock},
                settingsCache,
                emailRenderer,
                membersRepository,
                sendingService,
                emailAnalyticsJobs: {scheduleRecurringNewslettersJob},
                domainWarmingService
            });

            await localService.resumeInterruptedSends();

            sinon.assert.calledWithExactly(
                recoveryStatusLock,
                sinon.match.any,
                pendingPartial.id,
                'submitting',
                ['pending'],
                {
                    error: null,
                    partial_resume_enqueue_claim: PARTIAL_RESUME_ENQUEUE_CLAIM
                },
                {
                    expectedPartialResume: true,
                    expectedPartialResumeEnqueueClaim: null
                }
            );
            sinon.assert.calledWithExactly(
                recoveryStatusLock,
                sinon.match.any,
                pendingPartial.id,
                'failed',
                ['submitting'],
                {
                    error: 'Something went wrong while scheduling the partial continuation',
                    partial_resume_enqueue_claim: null
                },
                {
                    expectedPartialResume: true,
                    expectedPartialResumeEnqueueClaim: PARTIAL_RESUME_ENQUEUE_CLAIM
                }
            );
            assert.equal(recoveryStatusLock.callCount, 2);
            sinon.assert.calledOnceWithExactly(scheduleRejects, claimedPartial, {
                partialResumeClaimed: true,
                partialResumeClaim: PARTIAL_RESUME_ENQUEUE_CLAIM
            });
            sinon.assert.calledOnce(errorLog);
        });

        it('fails a pending partial continuation when its post lookup throws', async function () {
            const pendingPartial = createModel({
                id: 'broken-pending-partial',
                status: 'pending',
                partial_resume: true,
                created_at: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
                updated_at: new Date(),
                post: createModel({status: 'published'})
            });
            pendingPartial.getLazyRelation = () => {
                throw new Error('Broken partial post relation');
            };
            const recoveryStatusLock = sinon.stub().resolves(createModel({}));
            const errorLog = sinon.stub(logging, 'error');
            const findAll = async ({filter}) => {
                if (filter.includes('partial_resume:true')) {
                    return {models: [pendingPartial]};
                }
                return {models: []};
            };
            const localService = new EmailService({
                emailSegmenter: {getMembersCount: () => Promise.resolve(0)},
                limitService: {isLimited: () => false, errorIfIsOverLimit: () => {}, errorIfWouldGoOverLimit: () => {}},
                verificationTrigger: {checkVerificationRequired: () => Promise.resolve(false)},
                models: {Email: {findAll}},
                batchSendingService: {scheduleEmail, updateStatusLock: recoveryStatusLock},
                settingsCache,
                emailRenderer,
                membersRepository,
                sendingService,
                emailAnalyticsJobs: {scheduleRecurringNewslettersJob},
                domainWarmingService
            });

            await localService.resumeInterruptedSends();

            sinon.assert.calledOnceWithExactly(
                recoveryStatusLock,
                sinon.match.any,
                pendingPartial.id,
                'failed',
                ['pending'],
                {partial_resume_enqueue_claim: null},
                {
                    expectedPartialResume: true,
                    expectedPartialResumeEnqueueClaim: null
                }
            );
            sinon.assert.notCalled(scheduleEmail);
            sinon.assert.calledOnce(errorLog);
        });

        it('does not enqueue a pending partial continuation after another scanner owns its durable claim', async function () {
            const pendingPartial = createModel({
                id: 'already-claimed',
                status: 'pending',
                partial_resume: true,
                created_at: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
                updated_at: new Date(),
                post: createModel({status: 'published'})
            });
            const recoveryStatusLock = sinon.stub().resolves(undefined);
            sinon.stub(crypto, 'randomUUID').returns(PARTIAL_RESUME_ENQUEUE_CLAIM);
            const findAll = async ({filter}) => {
                if (filter.includes('partial_resume:true')) {
                    return {models: [pendingPartial]};
                }
                return {models: []};
            };

            const localService = new EmailService({
                emailSegmenter: {getMembersCount: () => Promise.resolve(0)},
                limitService: {isLimited: () => false, errorIfIsOverLimit: () => {}, errorIfWouldGoOverLimit: () => {}},
                verificationTrigger: {checkVerificationRequired: () => Promise.resolve(false)},
                models: {Email: {findAll}},
                batchSendingService: {scheduleEmail, updateStatusLock: recoveryStatusLock},
                settingsCache,
                emailRenderer,
                membersRepository,
                sendingService,
                emailAnalyticsJobs: {scheduleRecurringNewslettersJob},
                domainWarmingService
            });

            await localService.resumeInterruptedSends();

            sinon.assert.calledOnceWithExactly(
                recoveryStatusLock,
                sinon.match.any,
                pendingPartial.id,
                'submitting',
                ['pending'],
                {
                    error: null,
                    partial_resume_enqueue_claim: PARTIAL_RESUME_ENQUEUE_CLAIM
                },
                {
                    expectedPartialResume: true,
                    expectedPartialResumeEnqueueClaim: null
                }
            );
            sinon.assert.notCalled(scheduleEmail);
        });

        it('does not reselect a legacy submitting email created after this service started', async function () {
            const serviceStart = Date.now();
            const activeEmail = createModel({
                id: 'legacy-current-service-claim',
                status: 'submitting',
                created_at: new Date(serviceStart + 1),
                post: createModel({status: 'published'})
            });
            const recoveryStatusLock = sinon.stub().resolves(createModel({}));
            const findAll = async ({filter}) => {
                if (filter.includes('partial_resume:true') || filter.includes('created_at:<')) {
                    return {models: []};
                }
                return {models: [activeEmail]};
            };
            const localService = new EmailService({
                emailSegmenter: {getMembersCount: () => Promise.resolve(0)},
                limitService: {isLimited: () => false, errorIfIsOverLimit: () => {}, errorIfWouldGoOverLimit: () => {}},
                verificationTrigger: {checkVerificationRequired: () => Promise.resolve(false)},
                models: {Email: {findAll}},
                batchSendingService: {scheduleEmail, updateStatusLock: recoveryStatusLock},
                settingsCache,
                emailRenderer,
                membersRepository,
                sendingService,
                emailAnalyticsJobs: {scheduleRecurringNewslettersJob},
                domainWarmingService,
                resumeScannerServiceStart: serviceStart
            });

            await localService.resumeInterruptedSends();

            sinon.assert.notCalled(recoveryStatusLock);
            sinon.assert.notCalled(scheduleEmail);
        });

        it('fails legacy submitting rows with missing or malformed created_at without logging errors', async function () {
            const corruptedEmails = [
                createModel({
                    id: 'legacy-null-created-at',
                    status: 'submitting',
                    created_at: null,
                    post: createModel({status: 'published'})
                }),
                createModel({
                    id: 'legacy-malformed-created-at',
                    status: 'submitting',
                    created_at: 'not-a-date',
                    post: createModel({status: 'published'})
                })
            ];
            const recoveryStatusLock = sinon.stub().resolves(createModel({}));
            const errorLog = sinon.stub(logging, 'error');
            const findAll = async ({filter}) => {
                if (filter.includes('partial_resume:true') || filter.includes('created_at:')) {
                    return {models: []};
                }
                return {models: corruptedEmails};
            };
            const localService = new EmailService({
                emailSegmenter: {getMembersCount: () => Promise.resolve(0)},
                limitService: {isLimited: () => false, errorIfIsOverLimit: () => {}, errorIfWouldGoOverLimit: () => {}},
                verificationTrigger: {checkVerificationRequired: () => Promise.resolve(false)},
                models: {Email: {findAll}},
                batchSendingService: {scheduleEmail, updateStatusLock: recoveryStatusLock},
                settingsCache,
                emailRenderer,
                membersRepository,
                sendingService,
                emailAnalyticsJobs: {scheduleRecurringNewslettersJob},
                domainWarmingService
            });

            await localService.resumeInterruptedSends();

            assert.equal(recoveryStatusLock.callCount, 2);
            corruptedEmails.forEach((email) => {
                sinon.assert.calledWith(recoveryStatusLock, sinon.match.any, email.id, 'failed', ['submitting']);
            });
            sinon.assert.notCalled(scheduleEmail);
            sinon.assert.notCalled(errorLog);
        });

        it('does not reselect a partial continuation claimed after this service started', async function () {
            const serviceStart = Date.now();
            const currentServicePartial = createModel({
                id: 'current-service-claim',
                status: 'pending',
                partial_resume: true,
                created_at: new Date(serviceStart - 2 * 24 * 60 * 60 * 1000),
                updated_at: new Date(serviceStart + 1),
                post: createModel({status: 'published'})
            });
            const recoveryStatusLock = sinon.stub().resolves(createModel({}));
            const findAll = async ({filter}) => {
                if (filter.includes('partial_resume:true')) {
                    return {models: [currentServicePartial]};
                }
                return {models: []};
            };

            const localService = new EmailService({
                emailSegmenter: {getMembersCount: () => Promise.resolve(0)},
                limitService: {isLimited: () => false, errorIfIsOverLimit: () => {}, errorIfWouldGoOverLimit: () => {}},
                verificationTrigger: {checkVerificationRequired: () => Promise.resolve(false)},
                models: {Email: {findAll}},
                batchSendingService: {scheduleEmail, updateStatusLock: recoveryStatusLock},
                settingsCache,
                emailRenderer,
                membersRepository,
                sendingService,
                emailAnalyticsJobs: {scheduleRecurringNewslettersJob},
                domainWarmingService,
                resumeScannerServiceStart: serviceStart
            });

            await localService.resumeInterruptedSends();

            sinon.assert.notCalled(recoveryStatusLock);
            sinon.assert.notCalled(scheduleEmail);
        });

        it('fails stale partial continuations while atomically clearing their expired worker claim', async function () {
            const serviceStart = Date.now();
            const stalePartial = createModel({
                id: 'expired-partial-worker-claim',
                status: 'submitting',
                partial_resume: true,
                partial_resume_enqueue_claim: PARTIAL_RESUME_ENQUEUE_CLAIM,
                created_at: new Date(serviceStart - 2 * 24 * 60 * 60 * 1000),
                updated_at: new Date(serviceStart - 2 * 24 * 60 * 60 * 1000),
                post: createModel({status: 'published'})
            });
            const recoveryStatusLock = sinon.stub().resolves(createModel({}));
            const findAll = async ({filter}) => {
                if (filter.includes('partial_resume:true')) {
                    return {models: [stalePartial]};
                }
                return {models: []};
            };
            const localService = new EmailService({
                emailSegmenter: {getMembersCount: () => Promise.resolve(0)},
                limitService: {isLimited: () => false, errorIfIsOverLimit: () => {}, errorIfWouldGoOverLimit: () => {}},
                verificationTrigger: {checkVerificationRequired: () => Promise.resolve(false)},
                models: {Email: {findAll}},
                batchSendingService: {scheduleEmail, updateStatusLock: recoveryStatusLock},
                settingsCache,
                emailRenderer,
                membersRepository,
                sendingService,
                emailAnalyticsJobs: {scheduleRecurringNewslettersJob},
                domainWarmingService,
                resumeScannerServiceStart: serviceStart
            });

            await localService.resumeInterruptedSends();

            sinon.assert.calledOnceWithExactly(
                recoveryStatusLock,
                sinon.match.any,
                stalePartial.id,
                'failed',
                ['pending', 'submitting'],
                {partial_resume_enqueue_claim: null},
                {expectedPartialResume: true}
            );
            sinon.assert.notCalled(scheduleEmail);
        });

        it('resumes a submitting partial continuation through its updated state timestamp', async function () {
            const overlap = createModel({
                id: 'overlap-partial',
                status: 'submitting',
                partial_resume: true,
                partial_resume_enqueue_claim: null,
                created_at: new Date(),
                updated_at: new Date(),
                post: createModel({status: 'published'})
            });
            const lockedOverlap = createModel({
                id: overlap.id,
                status: 'pending',
                partial_resume: true,
                post: createModel({status: 'published'})
            });
            const claimedOverlap = createModel({
                id: overlap.id,
                status: 'submitting',
                partial_resume: true
            });
            const recoveryStatusLock = sinon.stub();
            recoveryStatusLock.onFirstCall().resolves(lockedOverlap);
            recoveryStatusLock.onSecondCall().resolves(claimedOverlap);
            const findAll = async ({filter}) => {
                if (filter.includes('partial_resume:true')) {
                    return {models: [overlap]};
                }
                return {models: []};
            };

            const localService = new EmailService({
                emailSegmenter: {getMembersCount: () => Promise.resolve(0)},
                limitService: {isLimited: () => false, errorIfIsOverLimit: () => {}, errorIfWouldGoOverLimit: () => {}},
                verificationTrigger: {checkVerificationRequired: () => Promise.resolve(false)},
                models: {Email: {findAll}},
                batchSendingService: {scheduleEmail, updateStatusLock: recoveryStatusLock},
                settingsCache,
                emailRenderer,
                membersRepository,
                sendingService,
                emailAnalyticsJobs: {scheduleRecurringNewslettersJob},
                domainWarmingService
            });

            await localService.resumeInterruptedSends();

            sinon.assert.calledOnceWithExactly(scheduleEmail, claimedOverlap, {
                partialResumeClaimed: true,
                partialResumeClaim: sinon.match.string
            });
        });

        it('does not emit raw email or post identifiers when recovering a partial continuation', async function () {
            const serviceStart = Date.now();
            const continuation = createModel({
                id: 'raw-email-id',
                post_id: 'raw-post-id',
                status: 'submitting',
                partial_resume: true,
                error: null,
                created_at: new Date(serviceStart - 2000),
                updated_at: new Date(serviceStart - 1000),
                post: createModel({status: 'published'})
            });
            const lockedContinuation = createModel({
                id: continuation.id,
                post_id: continuation.get('post_id'),
                status: 'pending',
                partial_resume: true,
                error: null
            });
            const recoveryStatusLock = sinon.stub().resolves(lockedContinuation);
            const infoLog = sinon.stub(logging, 'info');
            const warnLog = sinon.stub(logging, 'warn');
            const errorLog = sinon.stub(logging, 'error');
            const findAll = async ({filter}) => {
                if (filter.includes('partial_resume:true')) {
                    return {models: [continuation]};
                }
                return {models: [continuation]};
            };
            const localService = new EmailService({
                emailSegmenter: {getMembersCount: () => Promise.resolve(0)},
                limitService: {isLimited: () => false, errorIfIsOverLimit: () => {}, errorIfWouldGoOverLimit: () => {}},
                verificationTrigger: {checkVerificationRequired: () => Promise.resolve(false)},
                models: {Email: {findAll}},
                batchSendingService: {scheduleEmail, updateStatusLock: recoveryStatusLock},
                settingsCache,
                emailRenderer,
                membersRepository,
                sendingService,
                emailAnalyticsJobs: {scheduleRecurringNewslettersJob},
                domainWarmingService,
                resumeScannerServiceStart: serviceStart
            });

            await localService.resumeInterruptedSends();

            const logged = [infoLog, warnLog, errorLog]
                .flatMap(log => log.getCalls())
                .flatMap(call => call.args)
                .map(value => value instanceof Error ? `${value.name}: ${value.message}` : String(value))
                .join('\n');
            assert.doesNotMatch(logged, /raw-email-id|raw-post-id/);
        });

        it('does not emit raw identifiers or exception text when partial recovery lookup fails', async function () {
            const serviceStart = Date.now();
            const continuation = createModel({
                id: 'raw-email-id',
                post_id: 'raw-post-id',
                status: 'pending',
                partial_resume: true,
                error: null,
                created_at: new Date(serviceStart - 2000),
                updated_at: new Date(serviceStart - 1000)
            });
            continuation.getLazyRelation = () => {
                throw new Error('raw-recipient@example.test raw-email-id');
            };
            const recoveryStatusLock = sinon.stub().resolves(createModel({}));
            const infoLog = sinon.stub(logging, 'info');
            const warnLog = sinon.stub(logging, 'warn');
            const errorLog = sinon.stub(logging, 'error');
            const findAll = async ({filter}) => {
                if (filter.includes('partial_resume:true')) {
                    return {models: [continuation]};
                }
                return {models: []};
            };
            const localService = new EmailService({
                emailSegmenter: {getMembersCount: () => Promise.resolve(0)},
                limitService: {isLimited: () => false, errorIfIsOverLimit: () => {}, errorIfWouldGoOverLimit: () => {}},
                verificationTrigger: {checkVerificationRequired: () => Promise.resolve(false)},
                models: {Email: {findAll}},
                batchSendingService: {scheduleEmail, updateStatusLock: recoveryStatusLock},
                settingsCache,
                emailRenderer,
                membersRepository,
                sendingService,
                emailAnalyticsJobs: {scheduleRecurringNewslettersJob},
                domainWarmingService,
                resumeScannerServiceStart: serviceStart
            });

            await localService.resumeInterruptedSends();

            const logged = [infoLog, warnLog, errorLog]
                .flatMap(log => log.getCalls())
                .flatMap(call => call.args)
                .map(value => value instanceof Error ? `${value.name}: ${value.message}` : String(value))
                .join('\n');
            assert.doesNotMatch(logged, /raw-email-id|raw-post-id|raw-recipient@example\.test/);
        });

        it('Marks email as failed if the parent post is no longer published or sent', async function () {
            const recoveryStatusLock = sinon.stub().resolves(createModel({}));
            const emails = [
                createModel({
                    id: 'unpublished',
                    status: 'submitting',
                    post: createModel({status: 'draft'})
                })
            ];

            const localService = new EmailService({
                emailSegmenter: {getMembersCount: () => Promise.resolve(0)},
                limitService: {isLimited: () => false, errorIfIsOverLimit: () => {}, errorIfWouldGoOverLimit: () => {}},
                verificationTrigger: {checkVerificationRequired: () => Promise.resolve(false)},
                models: {
                    Email: {findAll: filterAwareFindAll(emails)}
                },
                batchSendingService: {
                    scheduleEmail,
                    updateStatusLock: recoveryStatusLock
                },
                settingsCache,
                emailRenderer,
                membersRepository,
                sendingService,
                emailAnalyticsJobs: {scheduleRecurringNewslettersJob},
                domainWarmingService
            });

            await localService.resumeInterruptedSends();

            sinon.assert.calledOnce(recoveryStatusLock);
            sinon.assert.calledWith(recoveryStatusLock, sinon.match.any, 'unpublished', 'failed', ['submitting']);
            sinon.assert.notCalled(scheduleEmail);
        });

        it('Flips stale submitting emails to failed and does not resume them', async function () {
            const recoveryStatusLock = sinon.stub().resolves(createModel({}));
            // One ancient stale row and one fresh row. The scanner receives all legacy
            // submitting rows and classifies them locally against its fixed start time.
            const staleEmail = createModel({
                id: 'ancient',
                status: 'submitting',
                created_at: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000), // 30 days ago
                post: createModel({status: 'published'})
            });
            const freshEmail = createModel({
                id: 'recent',
                status: 'submitting',
                created_at: new Date(),
                post: createModel({status: 'published'})
            });

            const localService = new EmailService({
                emailSegmenter: {getMembersCount: () => Promise.resolve(0)},
                limitService: {isLimited: () => false, errorIfIsOverLimit: () => {}, errorIfWouldGoOverLimit: () => {}},
                verificationTrigger: {checkVerificationRequired: () => Promise.resolve(false)},
                models: {
                    Email: {
                        findAll: async ({filter}) => {
                            if (filter.includes('partial_resume:true')) {
                                return {models: []};
                            }
                            return {models: [staleEmail, freshEmail]};
                        }
                    }
                },
                batchSendingService: {
                    scheduleEmail,
                    updateStatusLock: recoveryStatusLock
                },
                settingsCache,
                emailRenderer,
                membersRepository,
                sendingService,
                emailAnalyticsJobs: {scheduleRecurringNewslettersJob},
                domainWarmingService
            });

            await localService.resumeInterruptedSends();

            // recoveryStatusLock called twice: once to flip the stale row to failed, once
            // to flip the fresh row from submitting -> pending so emailJob picks it up.
            assert.equal(recoveryStatusLock.callCount, 2);
            sinon.assert.calledWith(recoveryStatusLock, sinon.match.any, 'ancient', 'failed', ['submitting']);
            sinon.assert.calledWith(recoveryStatusLock, sinon.match.any, 'recent', 'pending', ['submitting']);
            // Only the fresh row should reach scheduleEmail.
            sinon.assert.calledOnce(scheduleEmail);
        });

        it('Respects bulkEmail:resumeMaxAgeMs config override', async function () {
            const serviceStart = Date.now();
            const recoveryStatusLock = sinon.stub().resolves(createModel({}));
            const capturedFilters = [];
            const staleEmail = createModel({
                id: 'config-stale',
                status: 'submitting',
                created_at: new Date(serviceStart - 61 * 60 * 1000),
                post: createModel({status: 'published'})
            });
            const freshEmail = createModel({
                id: 'config-fresh',
                status: 'submitting',
                created_at: new Date(serviceStart - 59 * 60 * 1000),
                post: createModel({status: 'published'})
            });

            const localService = new EmailService({
                emailSegmenter: {getMembersCount: () => Promise.resolve(0)},
                limitService: {isLimited: () => false, errorIfIsOverLimit: () => {}, errorIfWouldGoOverLimit: () => {}},
                verificationTrigger: {checkVerificationRequired: () => Promise.resolve(false)},
                models: {
                    Email: {
                        findAll: async ({filter}) => {
                            capturedFilters.push(filter);
                            if (filter.includes('partial_resume:true')) {
                                return {models: []};
                            }
                            return {models: [staleEmail, freshEmail]};
                        }
                    }
                },
                batchSendingService: {scheduleEmail, updateStatusLock: recoveryStatusLock},
                settingsCache,
                emailRenderer,
                membersRepository,
                sendingService,
                emailAnalyticsJobs: {scheduleRecurringNewslettersJob},
                domainWarmingService,
                config: {get: key => (key === 'bulkEmail:resumeMaxAgeMs' ? 60 * 60 * 1000 : undefined)},
                resumeScannerServiceStart: serviceStart
            });

            await localService.resumeInterruptedSends();

            assert.deepEqual(capturedFilters, [
                'status:submitting',
                'status:[pending,submitting]+partial_resume:true'
            ]);
            sinon.assert.calledWith(recoveryStatusLock, sinon.match.any, staleEmail.id, 'failed', ['submitting']);
            sinon.assert.calledWith(recoveryStatusLock, sinon.match.any, freshEmail.id, 'pending', ['submitting']);
            sinon.assert.calledOnce(scheduleEmail);
        });
    });

    describe('getExampleMember', function () {
        it('Returns a member', async function () {
            const member = createModel({
                uuid: '123',
                name: 'Example member',
                email: 'example@example.com',
                status: 'free'
            });
            membersRepository.get.resolves(member);
            const exampleMember = await service.getExampleMember('example@example.com', 'status:free');
            assert.equal(exampleMember.id, member.id);
            assert.equal(exampleMember.name, member.get('name'));
            assert.equal(exampleMember.email, member.get('email'));
            assert.equal(exampleMember.uuid, member.get('uuid'));
            assert.equal(exampleMember.status, 'free');
            assert.deepEqual(exampleMember.subscriptions, []);
            assert.deepEqual(exampleMember.tiers, []);
        });

        it('Returns a paid member', async function () {
            const member = createModel({
                uuid: '123',
                name: 'Example member',
                email: 'example@example.com',
                status: 'paid',
                stripeSubscriptions: [
                    createModel({
                        status: 'active',
                        current_period_end: new Date(2050, 0, 1),
                        cancel_at_period_end: false
                    })
                ],
                products: [createModel({
                    name: 'Silver',
                    expiry_at: null
                })]
            });
            membersRepository.get.resolves(member);
            const exampleMember = await service.getExampleMember('example@example.com', 'status:-free');
            assert.equal(exampleMember.id, member.id);
            assert.equal(exampleMember.name, member.get('name'));
            assert.equal(exampleMember.email, member.get('email'));
            assert.equal(exampleMember.uuid, member.get('uuid'));
            assert.equal(exampleMember.status, 'paid');
            assert.deepEqual(exampleMember.subscriptions, [
                {
                    status: 'active',
                    current_period_end: new Date(2050, 0, 1),
                    cancel_at_period_end: false,
                    id: member.related('stripeSubscriptions')[0].id
                }
            ]);
            assert.deepEqual(exampleMember.tiers, [
                {
                    name: 'Silver',
                    expiry_at: null,
                    id: member.related('products')[0].id
                }
            ]);
        });

        it('Returns a forced free member', async function () {
            const member = createModel({
                uuid: '123',
                name: 'Example member',
                email: 'example@example.com',
                status: 'paid'
            });
            membersRepository.get.resolves(member);
            const exampleMember = await service.getExampleMember('example@example.com', 'status:free');
            assert.equal(exampleMember.id, member.id);
            assert.equal(exampleMember.name, member.get('name'));
            assert.equal(exampleMember.email, member.get('email'));
            assert.equal(exampleMember.uuid, member.get('uuid'));
            assert.equal(exampleMember.status, 'free');
            assert.deepEqual(exampleMember.subscriptions, []);
            assert.deepEqual(exampleMember.tiers, []);
        });

        it('Returns a member without name if member does not exist', async function () {
            membersRepository.get.resolves(undefined);
            const exampleMember = await service.getExampleMember('example@example.com');
            assert.equal(exampleMember.name, '');
            assert.equal(exampleMember.email, 'example@example.com');
            assert.ok(exampleMember.id);
            assert.ok(exampleMember.uuid);
        });

        it('Returns a default member', async function () {
            membersRepository.get.resolves(undefined);
            const exampleMember = await service.getExampleMember();
            assert.ok(exampleMember.id);
            assert.ok(exampleMember.uuid);
            assert.ok(exampleMember.name);
            assert.ok(exampleMember.email);
        });
    });

    describe('previewEmail', function () {
        it('Replaces replacements with example member', async function () {
            const post = createModel({
                id: '123',
                newsletter: createModel({
                    status: 'active',
                    feedback_enabled: true
                })
            });
            sinon.stub(emailRenderer, 'renderBody').resolves({
                html: 'Hello {name}, {name}',
                plaintext: 'Hello {name}',
                replacements: [
                    {
                        id: 'name',
                        token: /{name}/g,
                        getValue: (member) => {
                            return member.name;
                        }
                    }
                ]
            });

            const data = await service.previewEmail(post, post.get('newsletter'), null);
            assert.equal(data.html, 'Hello Jamie Larson, Jamie Larson');
            assert.equal(data.plaintext, 'Hello Jamie Larson');
            assert.equal(data.subject, 'Subject');
        });

        it('renders using the preview segment mapped for the post', async function () {
            const post = createModel({
                id: '123',
                newsletter: createModel({
                    status: 'active',
                    feedback_enabled: true
                })
            });
            sinon.stub(emailRenderer, 'getSegmentForAudience').returns('status:-free+(product:\'gold\')');
            const renderBody = sinon.stub(emailRenderer, 'renderBody').resolves({
                html: 'HTML',
                plaintext: 'Plaintext',
                replacements: []
            });

            await service.previewEmail(post, post.get('newsletter'), 'paid');

            sinon.assert.calledOnceWithExactly(emailRenderer.getSegmentForAudience, post, 'paid', undefined);
            assert.equal(renderBody.firstCall.args[2], 'status:-free+(product:\'gold\')');
        });

        it('passes the selected tier through to the preview segment', async function () {
            const post = createModel({
                id: '123',
                newsletter: createModel({
                    status: 'active',
                    feedback_enabled: true
                })
            });
            sinon.stub(emailRenderer, 'getSegmentForAudience').returns('status:-free+product:\'silver\'');
            const renderBody = sinon.stub(emailRenderer, 'renderBody').resolves({
                html: 'HTML',
                plaintext: 'Plaintext',
                replacements: []
            });

            await service.previewEmail(post, post.get('newsletter'), 'paid', 'silver');

            sinon.assert.calledOnceWithExactly(emailRenderer.getSegmentForAudience, post, 'paid', 'silver');
            assert.equal(renderBody.firstCall.args[2], 'status:-free+product:\'silver\'');
        });
    });

    describe('sendTestEmail', function () {
        it('Sends a test email', async function () {
            const post = createModel({
                id: '123',
                newsletter: createModel({
                    status: 'active',
                    feedback_enabled: true
                })
            });
            await service.sendTestEmail(post, post.get('newsletter'), null, ['example@example.com']);
            sinon.assert.calledOnce(sendingService.send);
            const members = sendingService.send.firstCall.args[0].members;
            const options = sendingService.send.firstCall.args[1];
            assert.equal(members.length, 1);
            assert.equal(members[0].email, 'example@example.com');
            assert.equal(options.isTestEmail, true);
        });

        it('sends with the mapped preview segment while personalizing for the chosen audience', async function () {
            const post = createModel({
                id: '123',
                newsletter: createModel({
                    status: 'active',
                    feedback_enabled: true
                })
            });
            sinon.stub(emailRenderer, 'getSegmentForAudience').returns('status:-free+(product:\'gold\')');

            await service.sendTestEmail(post, post.get('newsletter'), 'paid', ['example@example.com']);

            sinon.assert.calledOnce(sendingService.send);
            const {segment, members} = sendingService.send.firstCall.args[0];
            assert.equal(segment, 'status:-free+(product:\'gold\')');
            // The example member is still built from the audience choice, not the mapped filter
            assert.equal(members[0].status, 'paid');
        });

        it('passes the selected tier through to the preview segment', async function () {
            const post = createModel({
                id: '123',
                newsletter: createModel({
                    status: 'active',
                    feedback_enabled: true
                })
            });
            const getSegmentForAudience = sinon.stub(emailRenderer, 'getSegmentForAudience').returns('status:-free+product:\'silver\'');

            await service.sendTestEmail(post, post.get('newsletter'), 'paid', ['example@example.com'], 'silver');

            sinon.assert.calledOnceWithExactly(getSegmentForAudience, post, 'paid', 'silver');
            const {segment} = sendingService.send.firstCall.args[0];
            assert.equal(segment, 'status:-free+product:\'silver\'');
        });
    });
});

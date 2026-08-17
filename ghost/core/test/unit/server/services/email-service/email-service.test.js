const EmailService = require('../../../../../core/server/services/email-service/email-service');
const assert = require('node:assert/strict');
const sinon = require('sinon');
const logging = require('@tryghost/logging');
const {createModel, createModelClass} = require('./utils');

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

    beforeEach(function () {
        memberCount = 123;
        limited = {
            emails: null, // null = not limited, true = limited and error, false = limited no error
            members: null
        };
        verificicationRequired = false;
        scheduleEmail = sinon.stub().returns();
        assertCanStartPartialResume = sinon.stub().resolves({missingRecipientCount: 1});
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
                Email: createModelClass()
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
            domainWarmingService: domainWarmingService
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

            const email = await service.createEmail(post);
            sinon.assert.calledOnce(scheduleEmail);

            assert.equal(email.get('error'), 'Test error');
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
            updateStatusLock.resolves(lockedEmail);

            const result = await service.resumePartialEmail(email);

            sinon.assert.calledOnceWithExactly(assertCanStartPartialResume, email);
            sinon.assert.calledOnce(updateStatusLock);
            const [, emailId, status, allowedStatuses, patch] = updateStatusLock.firstCall.args;
            assert.equal(emailId, 'email-id');
            assert.equal(status, 'pending');
            assert.deepEqual(allowedStatuses, ['submitted']);
            assert.deepEqual(patch, {partial_resume: true, error: null});
            sinon.assert.calledOnceWithExactly(scheduleEmail, lockedEmail);
            assert.equal(result, lockedEmail);
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
            updateStatusLock.resolves(lockedEmail);

            const result = await service.resumePartialEmail(email);

            sinon.assert.calledOnceWithExactly(assertCanStartPartialResume, email);
            const [, emailId, status, allowedStatuses, patch] = updateStatusLock.firstCall.args;
            assert.equal(emailId, 'email-id');
            assert.equal(status, 'pending');
            assert.deepEqual(allowedStatuses, ['failed']);
            assert.deepEqual(patch, {partial_resume: true, error: null});
            sinon.assert.calledOnceWithExactly(scheduleEmail, lockedEmail);
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
                    post: createModel({status: 'published'})
                }),
                createModel({
                    id: 'bad',
                    status: 'submitting',
                    get post() {
                        throw new Error('Boom');
                    }
                }),
                createModel({
                    id: 'good-2',
                    status: 'submitting',
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
        });

        it('schedules a pending partial continuation after a crash before its in-memory job starts', async function () {
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
                partial_resume: true
            });
            const recoveryStatusLock = sinon.stub().resolves(claimedPartial);
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

            sinon.assert.calledOnceWithExactly(recoveryStatusLock, sinon.match.any, pendingPartial.id, 'submitting', ['pending']);
            sinon.assert.calledOnceWithExactly(scheduleEmail, claimedPartial, {partialResumeClaimed: true});
        });

        it('does not enqueue a pending partial continuation after another scanner claims it', async function () {
            const pendingPartial = createModel({
                id: 'already-claimed',
                status: 'pending',
                partial_resume: true,
                created_at: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
                updated_at: new Date(),
                post: createModel({status: 'published'})
            });
            const recoveryStatusLock = sinon.stub().resolves(undefined);
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

            sinon.assert.calledOnceWithExactly(recoveryStatusLock, sinon.match.any, pendingPartial.id, 'submitting', ['pending']);
            sinon.assert.notCalled(scheduleEmail);
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

        it('resumes a submitting partial continuation through its updated state timestamp', async function () {
            const overlap = createModel({
                id: 'overlap-partial',
                status: 'submitting',
                partial_resume: true,
                created_at: new Date(),
                updated_at: new Date(),
                post: createModel({status: 'published'})
            });
            const recoveryStatusLock = sinon.stub().resolves(createModel({status: 'pending'}));
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

            sinon.assert.calledOnceWithExactly(scheduleEmail, overlap);
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
            // One ancient stale row, one fresh row. The mock differentiates by the filter
            // string the scanner uses: `created_at:<` for stale, `created_at:>` for fresh.
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
                            if (filter.includes('created_at:<')) {
                                return {models: [staleEmail]};
                            }
                            return {models: [freshEmail]};
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
            const recoveryStatusLock = sinon.stub().resolves(createModel({}));
            const capturedFilters = [];

            const localService = new EmailService({
                emailSegmenter: {getMembersCount: () => Promise.resolve(0)},
                limitService: {isLimited: () => false, errorIfIsOverLimit: () => {}, errorIfWouldGoOverLimit: () => {}},
                verificationTrigger: {checkVerificationRequired: () => Promise.resolve(false)},
                models: {
                    Email: {
                        findAll: async ({filter}) => {
                            capturedFilters.push(filter);
                            return {models: []};
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
                // 1 hour override
                config: {get: key => (key === 'bulkEmail:resumeMaxAgeMs' ? 60 * 60 * 1000 : undefined)}
            });

            const before = Date.now();
            await localService.resumeInterruptedSends();
            const after = Date.now();

            assert.equal(capturedFilters.length, 3);
            // Legacy scans carry the same cutoff timestamp. Explicit partial
            // continuations are classified locally from their persisted updated_at.
            const timeFilters = capturedFilters.filter(filter => filter.includes('created_at:'));
            assert.equal(timeFilters.length, 2);
            const match = timeFilters[0].match(/created_at:[<>]'([^']+)'/);
            assert.ok(match, `expected ISO cutoff in filter, got: ${capturedFilters[0]}`);
            assert.ok(timeFilters.every(filter => filter.includes(`'${match[1]}'`)), 'legacy state scans must use the same cutoff');
            assert.ok(capturedFilters.some(filter => filter === 'status:[pending,submitting]+partial_resume:true'), 'partial continuation scan must select explicit marked states');
            const cutoffMs = new Date(match[1]).getTime();
            // Cutoff should be ~1 hour before "now" (the moment we called resumeInterruptedSends).
            assert.ok(cutoffMs >= before - 60 * 60 * 1000 - 100, `cutoff ${match[1]} too old`);
            assert.ok(cutoffMs <= after - 60 * 60 * 1000 + 100, `cutoff ${match[1]} too recent`);
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

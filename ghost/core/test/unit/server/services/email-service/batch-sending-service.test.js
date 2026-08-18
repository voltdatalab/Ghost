const {createModel, createModelClass, createDb, sleep} = require('./utils');
const BatchSendingService = require('../../../../../core/server/services/email-service/batch-sending-service');
const sinon = require('sinon');
const assert = require('node:assert/strict');
const logging = require('@tryghost/logging');
const nql = require('@tryghost/nql');
const errors = require('@tryghost/errors');
const crypto = require('node:crypto');
const {canonicalizeLegacyProofPayload, hashStringList} = require('../../../../../core/server/services/email-service/legacy-partial-resume-proof');

// We need a short sleep in some tests to simulate time passing
// This way we don't actually add a delay to the tests
const simulateSleep = async (ms, clock) => {
    await Promise.all([sleep(ms), clock.tickAsync(ms)]);
};

const LEGACY_PROOF_PUBLIC_KEY_CONFIG = 'bulkEmail:partialResume:legacyProxyPublicKey';
const LEGACY_EMAIL_ID = '64b000000000000000000001';
const LEGACY_BATCH_IDS = ['64b000000000000000000002', '64b000000000000000000003'];
const LEGACY_MEMBER_IDS = ['64b000000000000000000010', '64b000000000000000000011'];
const LEGACY_MEMBER_EMAILS = ['first@example.test', 'second@example.test'];
const PARTIAL_RESUME_ENQUEUE_CLAIM = '00000000-0000-4000-8000-000000000001';
const LEGACY_PROOF_KEY_PAIR = crypto.generateKeyPairSync('ed25519');

function createStoredLegacyProof() {
    const issuedAt = new Date(Date.now() - 1000);
    const proxyCreatedAt = new Date(Date.now() - 2000);
    const proof = {
        version: 1,
        transport: 'ses-proxy-mailgun-v1',
        email_id: LEGACY_EMAIL_ID,
        issued_at: issuedAt.toISOString(),
        legacy_batch_ids: LEGACY_BATCH_IDS,
        legacy_provider_id_mode: 'email-id',
        ledger_member_count: LEGACY_MEMBER_IDS.length,
        ledger_member_hash: hashStringList(LEGACY_MEMBER_IDS),
        ledger_email_count: LEGACY_MEMBER_EMAILS.length,
        ledger_email_hash: hashStringList(LEGACY_MEMBER_EMAILS),
        ledger_binding_hash: hashStringList(LEGACY_BATCH_IDS.map((batchId, index) => `${batchId}\u0000${LEGACY_MEMBER_IDS[index]}\u0000${LEGACY_MEMBER_EMAILS[index]}`)),
        proxy_input_count: LEGACY_MEMBER_EMAILS.length,
        proxy_input_hash: hashStringList(LEGACY_MEMBER_EMAILS),
        proxy_sent_count: LEGACY_MEMBER_EMAILS.length,
        proxy_sent_hash: hashStringList(LEGACY_MEMBER_EMAILS),
        proxy_site_count: 1,
        proxy_batch_count: LEGACY_BATCH_IDS.length,
        proxy_first_created_at: proxyCreatedAt.toISOString(),
        proxy_last_created_at: proxyCreatedAt.toISOString()
    };
    const {payloadJson} = canonicalizeLegacyProofPayload(proof);
    const publicKey = LEGACY_PROOF_KEY_PAIR.publicKey.export({type: 'spki', format: 'pem'});
    const signature = crypto.sign(null, Buffer.from(payloadJson, 'utf8'), LEGACY_PROOF_KEY_PAIR.privateKey).toString('base64url');
    const signingKeyFingerprint = crypto.createHash('sha256').update(crypto.createPublicKey(publicKey).export({type: 'spki', format: 'der'})).digest('hex');

    return {
        publicKey,
        row: {
            id: '64b000000000000000000099',
            email_id: LEGACY_EMAIL_ID,
            proof_payload: payloadJson,
            proof_hash: crypto.createHash('sha256').update(payloadJson, 'utf8').digest('hex'),
            signature,
            signing_key_fingerprint: signingKeyFingerprint,
            transport: proof.transport
        }
    };
}

function createLegacyProofDb({proof, recipients}) {
    return {
        knex(table) {
            const query = {
                select() {
                    return query;
                },
                where() {
                    return query;
                },
                then(resolve, reject) {
                    const rows = table === 'email_partial_resume_proofs'
                        ? (proof ? [proof] : [])
                        : (table === 'email_recipients' ? recipients : []);
                    return Promise.resolve(rows).then(resolve, reject);
                }
            };
            return query;
        }
    };
}

function createCloneablePost(properties) {
    const postProperties = {...properties};
    const post = createModel(postProperties);
    post.clone = () => {
        const snapshotProperties = {...postProperties};
        const snapshot = createModel(snapshotProperties);
        snapshot.set = (values) => {
            Object.assign(snapshotProperties, values);
            return snapshot;
        };
        return snapshot;
    };
    return post;
}

describe('Batch Sending Service', function () {
    let errorLog;

    beforeEach(function () {
        errorLog = sinon.stub(logging, 'error');
        sinon.stub(logging, 'info');
    });

    afterEach(function () {
        sinon.restore();
    });

    describe('constructor', function () {
        it('works in development mode', async function () {
            const env = process.env.NODE_ENV;
            process.env.NODE_ENV = 'development';
            try {
                new BatchSendingService({});
            } finally {
                process.env.NODE_ENV = env;
            }
        });
    });

    describe('scheduleEmail', function () {
        it('schedules email', async function () {
            const jobsService = {
                addJob: sinon.stub().resolves()
            };
            const service = new BatchSendingService({
                jobsService
            });
            service.scheduleEmail(createModel({}));
            sinon.assert.calledOnce(jobsService.addJob);
            const job = jobsService.addJob.firstCall.args[0].job;
            assert.equal(typeof job, 'function');
        });
    });

    describe('emailJob', function () {
        it('does not send if already submitting', async function () {
            const Email = createModelClass({
                findOne: {
                    status: 'submitting'
                }
            });
            const service = new BatchSendingService({
                models: {Email}
            });
            const result = await service.emailJob({emailId: '123'});
            assert.equal(result, undefined);
            sinon.assert.calledOnce(errorLog);
            sinon.assert.calledWith(errorLog, 'Tried sending email that is not pending 123');
        });

        it('does not send if already submitted', async function () {
            const Email = createModelClass({
                findOne: {
                    status: 'submitted'
                }
            });
            const service = new BatchSendingService({
                models: {Email}
            });
            const result = await service.emailJob({emailId: '123'});
            assert.equal(result, undefined);
            sinon.assert.calledOnce(errorLog);
            sinon.assert.calledWith(errorLog, 'Tried sending email that is not pending 123');
        });

        it('does not dispatch a delayed normal job after enqueue compensation marked it failed', async function () {
            const email = createModel({
                id: '123',
                status: 'failed',
                partial_resume: false
            });
            const Email = {
                transaction: async callback => await callback(),
                findOne: async () => email
            };
            const service = new BatchSendingService({models: {Email}});
            const sendEmail = sinon.stub(service, 'sendEmail').resolves();

            await service.emailJob({emailId: email.id});

            sinon.assert.notCalled(sendEmail);
            assert.equal(email.get('status'), 'failed');
        });

        it('does not dispatch an ambiguously queued strict partial job after recovery marked it failed', async function () {
            const email = createModel({
                id: '123',
                status: 'failed',
                partial_resume: true
            });
            const Email = {
                transaction: async callback => await callback(),
                findOne: async () => email
            };
            const service = new BatchSendingService({models: {Email}});
            const sendPartialEmail = sinon.stub(service, 'sendPartialEmail').resolves();

            await service.emailJob({emailId: email.id, partialResume: true});

            sinon.assert.notCalled(sendPartialEmail);
            assert.equal(email.get('status'), 'failed');
        });

        it('does not let a strict partial job claim a non-partial email', async function () {
            const email = createModel({
                id: '123',
                status: 'pending',
                partial_resume: false
            });
            const Email = {
                transaction: async callback => await callback(),
                findOne: async () => email
            };
            const service = new BatchSendingService({models: {Email}});
            const sendEmail = sinon.stub(service, 'sendEmail').resolves();
            const sendPartialEmail = sinon.stub(service, 'sendPartialEmail').resolves();

            await service.emailJob({emailId: email.id, partialResume: true});

            sinon.assert.notCalled(sendEmail);
            sinon.assert.notCalled(sendPartialEmail);
            assert.equal(email.get('status'), 'pending');
        });

        it('marks a strict partial continuation in the scheduled job data', async function () {
            const jobsService = {
                addJob: sinon.stub().resolves()
            };
            const email = createModel({id: 'partial-email'});
            const service = new BatchSendingService({jobsService});

            await service.scheduleEmail(email, {partialResume: true});

            assert.deepEqual(jobsService.addJob.firstCall.args[0].data, {
                emailId: email.id,
                partialResume: true,
                partialResumeClaimed: false
            });
        });

        it('dispatches a pending strict partial job through the partial sender', async function () {
            const email = createModel({
                id: '123',
                status: 'pending',
                partial_resume: true,
                error: null,
                partial_resume_enqueue_claim: null
            });
            const Email = {
                transaction: async callback => await callback(),
                findOne: async () => email
            };
            const service = new BatchSendingService({models: {Email}});
            const sendEmail = sinon.stub(service, 'sendEmail').resolves();
            const sendPartialEmail = sinon.stub(service, 'sendPartialEmail').resolves();

            await service.emailJob({emailId: email.id, partialResume: true});

            sinon.assert.notCalled(sendEmail);
            sinon.assert.calledOnceWithExactly(sendPartialEmail, email);
            assert.equal(email.get('status'), 'submitted');
            assert.equal(email.get('partial_resume'), false);
        });

        it('does not let an unclaimed strict partial job adopt a recovery marker', async function () {
            const email = createModel({
                id: '123',
                status: 'pending',
                partial_resume: true,
                error: null,
                partial_resume_enqueue_claim: PARTIAL_RESUME_ENQUEUE_CLAIM
            });
            const Email = {
                transaction: async callback => await callback(),
                findOne: async () => email
            };
            const service = new BatchSendingService({models: {Email}});
            const sendPartialEmail = sinon.stub(service, 'sendPartialEmail').resolves();

            await service.emailJob({emailId: email.id, partialResume: true});

            sinon.assert.notCalled(sendPartialEmail);
            assert.equal(email.get('status'), 'pending');
            assert.equal(email.get('error'), null);
            assert.equal(email.get('partial_resume_enqueue_claim'), PARTIAL_RESUME_ENQUEUE_CLAIM);
        });

        it('allows only the claimed job to clear and dispatch a durable recovery marker', async function () {
            const email = createModel({
                id: '123',
                status: 'submitting',
                partial_resume: true,
                error: null,
                partial_resume_enqueue_claim: PARTIAL_RESUME_ENQUEUE_CLAIM
            });
            const Email = {
                transaction: async callback => await callback(),
                findOne: async () => email
            };
            const service = new BatchSendingService({models: {Email}});
            const sendPartialEmail = sinon.stub(service, 'sendPartialEmail').resolves();

            await service.emailJob({
                emailId: email.id,
                partialResumeClaimed: true,
                partialResumeClaim: PARTIAL_RESUME_ENQUEUE_CLAIM
            });

            sinon.assert.calledOnceWithExactly(sendPartialEmail, email);
            assert.equal(email.get('status'), 'submitted');
            assert.equal(email.get('error'), null);
            assert.equal(email.get('partial_resume_enqueue_claim'), null);
        });

        it('does not let an old claimed-job payload adopt a newer durable recovery marker', async function () {
            const email = createModel({
                id: '123',
                status: 'submitting',
                partial_resume: true,
                error: null,
                partial_resume_enqueue_claim: PARTIAL_RESUME_ENQUEUE_CLAIM
            });
            const Email = {
                transaction: async callback => await callback(),
                findOne: async () => email
            };
            const service = new BatchSendingService({models: {Email}});
            const sendPartialEmail = sinon.stub(service, 'sendPartialEmail').resolves();

            await service.emailJob({emailId: email.id, partialResumeClaimed: true});

            sinon.assert.notCalled(sendPartialEmail);
            assert.equal(email.get('status'), 'submitting');
            assert.equal(email.get('error'), null);
            assert.equal(email.get('partial_resume_enqueue_claim'), PARTIAL_RESUME_ENQUEUE_CLAIM);
        });

        it('keeps pre-token claimed-job payloads compatible only with the pre-token state', async function () {
            const email = createModel({
                id: '123',
                status: 'submitting',
                partial_resume: true,
                error: null,
                partial_resume_enqueue_claim: null
            });
            const Email = {
                transaction: async callback => await callback(),
                findOne: async () => email
            };
            const service = new BatchSendingService({models: {Email}});
            const sendPartialEmail = sinon.stub(service, 'sendPartialEmail').resolves();

            await service.emailJob({emailId: email.id, partialResumeClaimed: true});

            sinon.assert.calledOnceWithExactly(sendPartialEmail, email);
            assert.equal(email.get('status'), 'submitted');
            assert.equal(email.get('partial_resume_enqueue_claim'), null);
        });

        it('does not let a claimed job with a mismatched token adopt a newer generation', async function () {
            const email = createModel({
                id: '123',
                status: 'submitting',
                partial_resume: true,
                error: null,
                partial_resume_enqueue_claim: '00000000-0000-4000-8000-000000000002'
            });
            const Email = {
                transaction: async callback => await callback(),
                findOne: async () => email
            };
            const service = new BatchSendingService({models: {Email}});
            const sendPartialEmail = sinon.stub(service, 'sendPartialEmail').resolves();

            await service.emailJob({
                emailId: email.id,
                partialResumeClaimed: true,
                partialResumeClaim: PARTIAL_RESUME_ENQUEUE_CLAIM
            });

            sinon.assert.notCalled(sendPartialEmail);
            assert.equal(email.get('status'), 'submitting');
            assert.equal(email.get('partial_resume_enqueue_claim'), '00000000-0000-4000-8000-000000000002');
        });

        it('does send email if pending', async function () {
            const Email = createModelClass({
                findOne: {
                    status: 'pending'
                }
            });
            const service = new BatchSendingService({
                models: {Email}
            });
            let emailModel;
            let afterEmailModel;
            const sendEmail = sinon.stub(service, 'sendEmail').callsFake((email) => {
                emailModel = {
                    status: email.get('status')
                };
                afterEmailModel = email;
                return Promise.resolve();
            });
            const result = await service.emailJob({emailId: '123'});
            assert.equal(result, undefined);
            sinon.assert.notCalled(errorLog);

            sinon.assert.calledOnce(sendEmail);
            assert.equal(emailModel.status, 'submitting', 'The email status is submitting while sending');
            assert.equal(afterEmailModel.get('status'), 'submitted', 'The email status is submitted after sending');
            assert.ok(afterEmailModel.get('submitted_at'));
            assert.equal(afterEmailModel.get('error'), null);
        });

        it('saves error state if sending fails', async function () {
            const Email = createModelClass({
                findOne: {
                    status: 'pending'
                }
            });
            const service = new BatchSendingService({
                models: {Email}
            });
            let emailModel;
            let afterEmailModel;
            const sendEmail = sinon.stub(service, 'sendEmail').callsFake((email) => {
                emailModel = {
                    status: email.get('status')
                };
                afterEmailModel = email;
                return Promise.reject(new Error('Unexpected test error'));
            });
            const result = await service.emailJob({emailId: '123'});
            assert.equal(result, undefined);
            sinon.assert.calledOnce(errorLog);
            sinon.assert.calledOnce(sendEmail);
            assert.equal(emailModel.status, 'submitting', 'The email status is submitting while sending');
            assert.equal(afterEmailModel.get('status'), 'failed', 'The email status is failed after sending');
            assert.equal(afterEmailModel.get('error'), 'Unexpected test error');
        });

        it('retries saving error state if sending fails', async function () {
            const Email = createModelClass({
                findOne: {
                    status: 'pending'
                }
            });
            const service = new BatchSendingService({
                models: {Email},
                AFTER_RETRY_CONFIG: {maxRetries: 20, maxTime: 2000, sleep: 1}
            });
            let afterEmailModel;
            const sendEmail = sinon.stub(service, 'sendEmail').callsFake((email) => {
                afterEmailModel = email;
                let called = 0;
                const originalSave = email.save;
                email.save = async function () {
                    called += 1;
                    if (called === 2) {
                        return await originalSave.call(this, ...arguments);
                    }
                    throw new Error('Database connection error');
                };
                return Promise.reject(new Error('Unexpected test error'));
            });
            const result = await service.emailJob({emailId: '123'});
            assert.equal(result, undefined);
            sinon.assert.calledTwice(errorLog);
            const loggedExeption = errorLog.getCall(1).args[0];
            assert.match(loggedExeption.message, /\[BULK_EMAIL_DB_RETRY\] email 123 -> failed/);
            assert.match(loggedExeption.context, /Database connection error/);
            assert.equal(loggedExeption.code, 'BULK_EMAIL_DB_RETRY');

            sinon.assert.calledOnce(sendEmail);
            assert.equal(afterEmailModel.get('status'), 'failed', 'The email status is failed after sending');
            assert.equal(afterEmailModel.get('error'), 'Unexpected test error');
        });

        it('saves default error message if sending fails', async function () {
            const Email = createModelClass({
                findOne: {
                    status: 'pending'
                }
            });
            const captureException = sinon.stub();
            const service = new BatchSendingService({
                models: {Email},
                sentry: {
                    captureException
                }
            });
            let emailModel;
            let afterEmailModel;
            const sendEmail = sinon.stub(service, 'sendEmail').callsFake((email) => {
                emailModel = {
                    status: email.get('status')
                };
                afterEmailModel = email;
                return Promise.reject(new Error(''));
            });
            const result = await service.emailJob({emailId: '123'});
            assert.equal(result, undefined);
            sinon.assert.calledOnce(errorLog);
            sinon.assert.calledOnce(sendEmail);
            sinon.assert.calledOnce(captureException);

            // Check error code
            const error = errorLog.firstCall.args[0];
            assert.equal(error.code, 'BULK_EMAIL_SEND_FAILED');

            // Check error
            const sentryError = captureException.firstCall.args[0];
            assert.equal(sentryError.message, '');

            assert.equal(emailModel.status, 'submitting', 'The email status is submitting while sending');
            assert.equal(afterEmailModel.get('status'), 'failed', 'The email status is failed after sending');
            assert.equal(afterEmailModel.get('error'), 'Something went wrong while sending the email');
        });

        it('releases the exact partial worker claim on orderly shutdown so boot recovery can resume it', async function () {
            const email = createModel({
                id: '123',
                status: 'pending',
                partial_resume: true,
                error: null,
                partial_resume_enqueue_claim: null
            });
            const Email = {
                transaction: async callback => await callback(),
                findOne: async () => email
            };
            const service = new BatchSendingService({models: {Email}});
            const shutdown = new Error('shutdown');
            shutdown.code = BatchSendingService.SHUTDOWN_CODE;
            sinon.stub(service, 'sendPartialEmail').rejects(shutdown);

            await service.emailJob({emailId: email.id, partialResume: true});

            assert.equal(email.get('status'), 'submitting');
            assert.equal(email.get('error'), null);
            assert.equal(email.get('partial_resume_enqueue_claim'), null);
        });

        it('does not let a late partial worker overwrite the scanner fail-closed state', async function () {
            const email = createModel({
                id: '123',
                status: 'pending',
                partial_resume: true,
                error: null,
                partial_resume_enqueue_claim: null
            });
            const Email = {
                transaction: async callback => await callback(),
                findOne: async () => email
            };
            const service = new BatchSendingService({models: {Email}});
            let finishSend;
            const sending = new Promise(resolve => {
                finishSend = resolve;
            });
            const sendPartialEmail = sinon.stub(service, 'sendPartialEmail').returns(sending);

            const job = service.emailJob({emailId: email.id, partialResume: true});
            await new Promise((resolve) => {
                setImmediate(resolve);
            });
            sinon.assert.calledOnce(sendPartialEmail);
            await email.save({
                status: 'failed',
                partial_resume_enqueue_claim: null
            }, {patch: true});
            finishSend();
            await job;

            assert.equal(email.get('status'), 'failed');
            assert.equal(email.get('partial_resume'), true);
            assert.equal(email.get('partial_resume_enqueue_claim'), null);
        });
    });

    describe('sendEmail', function () {
        it('does not create batches if already created', async function () {
            const EmailBatch = createModelClass({
                findAll: [
                    {},
                    {}
                ]
            });
            const service = new BatchSendingService({
                models: {EmailBatch},
                sendingService: {
                    getTargetDeliveryWindow() {
                        return 0;
                    }
                }
            });
            const email = createModel({
                status: 'submitting',
                newsletter: createModel({}),
                post: createModel({})
            });

            const sendBatches = sinon.stub(service, 'sendBatches').resolves();
            const createBatches = sinon.stub(service, 'createBatches').resolves();
            const result = await service.sendEmail(email);
            assert.equal(result, undefined);
            sinon.assert.calledOnce(sendBatches);
            sinon.assert.notCalled(createBatches);

            // Check called with batches
            const argument = sendBatches.firstCall.args[0];
            assert.equal(argument.batches.length, 2);
        });

        it('does create batches', async function () {
            const EmailBatch = createModelClass({
                findAll: []
            });
            const service = new BatchSendingService({
                models: {EmailBatch}
            });
            const email = createModel({
                status: 'submitting',
                newsletter: createModel({}),
                post: createModel({})
            });

            const sendBatches = sinon.stub(service, 'sendBatches').resolves();
            const createdBatches = [createModel({})];
            const createBatches = sinon.stub(service, 'createBatches').resolves(createdBatches);
            const result = await service.sendEmail(email);
            assert.equal(result, undefined);
            sinon.assert.calledOnce(sendBatches);
            sinon.assert.calledOnce(createBatches);

            // Check called with created batch
            const argument = sendBatches.firstCall.args[0];
            assert.equal(argument.batches, createdBatches);
        });

        it('passes deadline to sendBatches if target delivery window is set', async function () {
            const EmailBatch = createModelClass({
                findAll: []
            });
            const service = new BatchSendingService({
                models: {EmailBatch}
            });
            const email = createModel({
                status: 'submitting',
                newsletter: createModel({}),
                post: createModel({})
            });

            const sendBatches = sinon.stub(service, 'sendBatches').resolves();
            const createdBatches = [createModel({})];
            const createBatches = sinon.stub(service, 'createBatches').resolves(createdBatches);
            const result = await service.sendEmail(email);
            assert.equal(result, undefined);
            sinon.assert.calledOnce(sendBatches);
            sinon.assert.calledOnce(createBatches);

            // Check called with created batch
            const argument = sendBatches.firstCall.args[0];
            assert.equal(argument.batches, createdBatches);
        });
    });

    describe('createBatches', function () {
        it('works even when new members are added', async function () {
            const Member = createModelClass({});
            const EmailBatch = createModelClass({});
            const newsletter = createModel({});
            const domainWarmingService = {
                isEnabled: () => false
            };

            // Create 16 members in single line
            const members = new Array(16).fill(0).map(i => createModel({
                email: `example${i}@example.com`,
                uuid: `member${i}`,
                newsletters: [
                    newsletter
                ]
            }));

            const initialMembers = members.slice();

            Member.getFilteredCollectionQuery = ({filter}) => {
                // Everytime we request the members, we also create a new member, to simulate that creating batches doesn't happen in a transaction
                // These created members should be excluded
                members.push(createModel({
                    email: `example${members.length}@example.com`,
                    uuid: `member${members.length}`,
                    newsletters: [
                        newsletter
                    ]
                }));

                const q = nql(filter);
                // Check that the filter id:<${lastId} is a string
                // In rare cases when the object ID is numeric, the query returns unexpected results
                assert.equal(typeof q.toJSON().$and[1].id.$lt, 'string');

                const all = members.filter((member) => {
                    return q.queryJSON(member.toJSON());
                });

                // Sort all by id desc (string)
                all.sort((a, b) => {
                    return b.id.localeCompare(a.id);
                });
                return createDb({
                    all: all.map(member => member.toJSON())
                });
            };

            const db = createDb({});
            const insert = sinon.spy(db, 'insert');

            const service = new BatchSendingService({
                models: {Member, EmailBatch},
                domainWarmingService,
                emailRenderer: {
                    getSegments() {
                        return [null];
                    }
                },
                sendingService: {
                    getMaximumRecipients() {
                        return 5;
                    }
                },
                emailSegmenter: {
                    getMemberFilterForSegment(n) {
                        return `newsletters.id:'${n.id}'`;
                    }
                },
                db
            });

            const email = createModel({});

            // Check we don't include members created after the email model
            members.push(createModel({
                email: `example${members.length}@example.com`,
                uuid: `member${members.length}`,
                newsletters: [
                    newsletter
                ]
            }));

            const batches = await service.createBatches({
                email,
                post: createModel({}),
                newsletter
            });
            assert.equal(batches.length, 4);

            const calls = insert.getCalls();
            assert.equal(calls.length, 4);

            const insertedRecipients = calls.flatMap(call => call.args[0]);
            assert.equal(insertedRecipients.length, 16);

            // Check all recipients match initialMembers
            assert.deepEqual(insertedRecipients.map(recipient => recipient.member_id).sort(), initialMembers.map(member => member.id).sort());

            // Check email_count set
            assert.equal(email.get('email_count'), 16);
        });

        it('Does log message to sentry if email_count is off by > 1%', async function () {
            const Member = createModelClass({});
            const EmailBatch = createModelClass({});
            const newsletter = createModel({});
            const domainWarmingService = {
                isEnabled: () => false
            };

            // Create 16 members in single line
            const members = new Array(16).fill(0).map(i => createModel({
                email: `example${i}@example.com`,
                uuid: `member${i}`,
                newsletters: [
                    newsletter
                ]
            }));

            Member.getFilteredCollectionQuery = ({filter}) => {
                // Everytime we request the members, we also create a new member, to simulate that creating batches doesn't happen in a transaction
                // These created members should be excluded
                members.push(createModel({
                    email: `example${members.length}@example.com`,
                    uuid: `member${members.length}`,
                    newsletters: [
                        newsletter
                    ]
                }));

                const q = nql(filter);
                // Check that the filter id:<${lastId} is a string
                // In rare cases when the object ID is numeric, the query returns unexpected results
                assert.equal(typeof q.toJSON().$and[1].id.$lt, 'string');

                const all = members.filter((member) => {
                    return q.queryJSON(member.toJSON());
                });

                // Sort all by id desc (string)
                all.sort((a, b) => {
                    return b.id.localeCompare(a.id);
                });
                return createDb({
                    all: all.map(member => member.toJSON())
                });
            };

            const db = createDb({});
            const captureMessage = sinon.stub();

            const service = new BatchSendingService({
                models: {Member, EmailBatch},
                domainWarmingService,
                sentry: {
                    captureMessage
                },
                emailRenderer: {
                    getSegments() {
                        return [null];
                    }
                },
                sendingService: {
                    getMaximumRecipients() {
                        return 5;
                    }
                },
                emailSegmenter: {
                    getMemberFilterForSegment(n) {
                        return `newsletters.id:'${n.id}'`;
                    }
                },
                db
            });

            const email = createModel({
                email_count: 15
            });

            await service.createBatches({
                email,
                post: createModel({}),
                newsletter
            });

            sinon.assert.calledOnce(captureMessage);
        });

        it('works with multiple batches', async function () {
            const Member = createModelClass({});
            const EmailBatch = createModelClass({});
            const newsletter = createModel({});
            const domainWarmingService = {
                isEnabled: () => false
            };

            // Create 16 members in single line
            const members = [
                ...new Array(2).fill(0).map(i => createModel({
                    email: `example${i}@example.com`,
                    uuid: `member${i}`,
                    status: 'paid',
                    newsletters: [
                        newsletter
                    ]
                })),
                ...new Array(2).fill(0).map(i => createModel({
                    email: `free${i}@example.com`,
                    uuid: `free${i}`,
                    status: 'free',
                    newsletters: [
                        newsletter
                    ]
                }))
            ];

            const initialMembers = members.slice();

            Member.getFilteredCollectionQuery = ({filter}) => {
                const q = nql(filter);
                // Check that the filter id:<${lastId} is a string
                // In rare cases when the object ID is numeric, the query returns unexpected results
                assert.equal(typeof q.toJSON().$and[2].id.$lt, 'string');

                const all = members.filter((member) => {
                    return q.queryJSON(member.toJSON());
                });

                // Sort all by id desc (string)
                all.sort((a, b) => {
                    return b.id.localeCompare(a.id);
                });
                return createDb({
                    all: all.map(member => member.toJSON())
                });
            };

            const db = createDb({});
            const insert = sinon.spy(db, 'insert');

            const service = new BatchSendingService({
                models: {Member, EmailBatch},
                domainWarmingService,
                emailRenderer: {
                    getSegments() {
                        return ['status:free', 'status:-free'];
                    }
                },
                sendingService: {
                    getMaximumRecipients() {
                        return 5;
                    }
                },
                emailSegmenter: {
                    getMemberFilterForSegment(n, _, segment) {
                        return `newsletters.id:'${n.id}'+(${segment})`;
                    }
                },
                db
            });

            const email = createModel({});

            const batches = await service.createBatches({
                email,
                post: createModel({}),
                newsletter
            });
            assert.equal(batches.length, 2);

            const calls = insert.getCalls();
            assert.equal(calls.length, 2);

            const insertedRecipients = calls.flatMap(call => call.args[0]);
            assert.equal(insertedRecipients.length, 4);

            // Check all recipients match initialMembers
            assert.deepEqual(insertedRecipients.map(recipient => recipient.member_id).sort(), initialMembers.map(member => member.id).sort());

            // Check email_count set
            assert.equal(email.get('email_count'), 4);
        });

        // NOTE: we can't fully test this because javascript can't handle a large number (e.g. 650706040078550001536020) - it uses scientific notation
        //  so we have to use a string
        //  ref: https://ghost.slack.com/archives/CTH5NDJMS/p1699359241142969
        it('sends expected emails if a batch ends on a numeric id', async function () {
            const Member = createModelClass({});
            const EmailBatch = createModelClass({});
            const newsletter = createModel({});
            const domainWarmingService = {
                isEnabled: () => false
            };

            const members = [
                createModel({
                    id: '61a55008a9d68c003baec6df',
                    email: `test1@numericid.com`,
                    uuid: 'test1',
                    status: 'free',
                    newsletters: [
                        newsletter
                    ]
                }),
                createModel({
                    id: '650706040078550001536020', // numeric object id
                    email: `test2@numericid.com`,
                    uuid: 'test2',
                    status: 'free',
                    newsletters: [
                        newsletter
                    ]
                }),
                createModel({
                    id: '65070957007855000153605b',
                    email: `test3@numericid.com`,
                    uuid: 'test3',
                    status: 'free',
                    newsletters: [
                        newsletter
                    ]
                })
            ];

            const initialMembers = members.slice();

            Member.getFilteredCollectionQuery = ({filter}) => {
                const q = nql(filter);
                // Check that the filter id:<${lastId} is a string
                // In rare cases when the object ID is numeric, the query returns unexpected results
                assert.equal(typeof q.toJSON().$and[2].id.$lt, 'string');

                const all = members.filter((member) => {
                    return q.queryJSON(member.toJSON());
                });

                // Sort all by id desc (string) - this is how we keep the order of members consistent (object id is a proxy for created_at)
                all.sort((a, b) => {
                    return b.id.localeCompare(a.id);
                });

                return createDb({
                    all: all.map(member => member.toJSON())
                });
            };

            const db = createDb({});
            const insert = sinon.spy(db, 'insert');

            const service = new BatchSendingService({
                models: {Member, EmailBatch},
                domainWarmingService,
                emailRenderer: {
                    getSegments() {
                        return ['status:free'];
                    }
                },
                sendingService: {
                    getMaximumRecipients() {
                        return 2; // pick a batch size that ends with a numeric member object id
                    }
                },
                emailSegmenter: {
                    getMemberFilterForSegment(n, _, segment) {
                        return `newsletters.id:'${n.id}'+(${segment})`;
                    }
                },
                db
            });

            const email = createModel({});

            const batches = await service.createBatches({
                email,
                post: createModel({}),
                newsletter
            });
            assert.equal(batches.length, 2);

            const calls = insert.getCalls();
            assert.equal(calls.length, 2);

            const insertedRecipients = calls.flatMap(call => call.args[0]);
            assert.equal(insertedRecipients.length, 3);

            // Check all recipients match initialMembers
            assert.deepEqual(insertedRecipients.map(recipient => recipient.member_id).sort(), initialMembers.map(member => member.id).sort());

            // Check email_count set
            assert.equal(email.get('email_count'), 3);
        });

        describe('Domain warming', function () {
            // Helper function to create test setup with minimal boilerplate
            function createDomainWarmingTestSetup({memberCount = 10, warmingEnabled = true, maxRecipients = 5} = {}) {
                const Member = createModelClass({});
                const EmailBatch = createModelClass({});
                const newsletter = createModel({});

                const members = new Array(memberCount).fill(0).map(i => createModel({
                    email: `example${i}@example.com`,
                    uuid: `member${i}`,
                    newsletters: [newsletter]
                }));

                Member.getFilteredCollectionQuery = ({filter}) => {
                    const q = nql(filter);
                    const all = members.filter((member) => {
                        return q.queryJSON(member.toJSON());
                    });

                    all.sort((a, b) => {
                        return b.id.localeCompare(a.id);
                    });
                    return createDb({
                        all: all.map(member => member.toJSON())
                    });
                };

                const db = createDb({});
                const insert = sinon.spy(db, 'insert');
                const domainWarmingService = {
                    isEnabled: sinon.stub().returns(warmingEnabled)
                };

                const service = new BatchSendingService({
                    models: {Member, EmailBatch},
                    domainWarmingService,
                    emailRenderer: {
                        getSegments() {
                            return [null];
                        }
                    },
                    sendingService: {
                        getMaximumRecipients() {
                            return maxRecipients;
                        }
                    },
                    emailSegmenter: {
                        getMemberFilterForSegment(n) {
                            return `newsletters.id:'${n.id}'`;
                        }
                    },
                    db
                });

                return {Member, EmailBatch, newsletter, members, service, db, insert};
            }

            it('creates batches with domain warming disabled', async function () {
                const {service, newsletter} = createDomainWarmingTestSetup({warmingEnabled: false});
                const email = createModel({});

                const batches = await service.createBatches({email, post: createModel({}), newsletter});

                assert.equal(batches.length, 2);
                batches.forEach((batch) => {
                    assert.equal(batch.get('fallback_sending_domain'), false);
                });
            });

            it('creates batches with domain warming enabled and limit below total count', async function () {
                const {service, newsletter, insert} = createDomainWarmingTestSetup();
                const email = createModel({csd_email_count: 7});

                const batches = await service.createBatches({email, post: createModel({}), newsletter});

                assert.equal(batches.length, 3);
                assert.equal(batches[0].get('fallback_sending_domain'), false);
                assert.equal(batches[1].get('fallback_sending_domain'), false);
                assert.equal(batches[2].get('fallback_sending_domain'), true);

                // Verify recipient distribution
                const calls = insert.getCalls();
                assert.equal(calls[0].args[0].length, 5);
                assert.equal(calls[1].args[0].length, 2);
                assert.equal(calls[2].args[0].length, 3);
            });

            // Test multiple scenarios where all batches should use custom domain
            [
                {name: 'limit equals total count', csd_email_count: 10, memberCount: 10, expectedBatches: 2},
                {name: 'limit exceeds total count', csd_email_count: 20, memberCount: 10, expectedBatches: 2},
                {name: 'limit is undefined', csd_email_count: undefined, memberCount: 5, expectedBatches: 1}
            ].forEach(({name, csd_email_count, memberCount, expectedBatches}) => {
                it(`creates batches when ${name}`, async function () {
                    const {service, newsletter} = createDomainWarmingTestSetup({memberCount});
                    const email = createModel({csd_email_count});

                    const batches = await service.createBatches({email, post: createModel({}), newsletter});

                    assert.equal(batches.length, expectedBatches);
                    batches.forEach((batch) => {
                        assert.equal(batch.get('fallback_sending_domain'), false);
                    });
                });
            });

            it('updates email_count and csd_email_count when actual count differs', async function () {
                const {service, newsletter} = createDomainWarmingTestSetup();
                const email = createModel({email_count: 15, csd_email_count: 7});

                await service.createBatches({email, post: createModel({}), newsletter});

                assert.equal(email.get('email_count'), 10);
                assert.equal(email.get('csd_email_count'), 7);
            });
        });
    });

    describe('createBatch', function () {
        it('does not create if rows missing data', async function () {
            const EmailBatch = createModelClass({});
            const warning = sinon.stub(logging, 'warn');
            const rawMemberId = 'sensitive-member-id';
            const rawEmail = 'sensitive@example.test';

            const db = createDb({});
            const insert = sinon.spy(db, 'insert');

            const service = new BatchSendingService({
                models: {EmailBatch},
                db
            });
            const email = createModel({
                status: 'submitting',
                newsletter: createModel({}),
                post: createModel({})
            });
            const members = [
                createModel({
                    id: rawMemberId,
                    email: rawEmail
                }).toJSON(), // missing uuid
                createModel({
                    email: `example1@example.com`,
                    uuid: `member1`
                }).toJSON()
            ];
            await service.createBatch(email, null, members, {});

            const calls = insert.getCalls();
            assert.equal(calls.length, 1);

            const insertedRecipients = calls.flatMap(call => call.args[0]);
            assert.equal(insertedRecipients.length, 1);
            sinon.assert.calledOnce(warning);
            const warningMessage = String(warning.firstCall.args[0]);
            assert.equal(warningMessage.includes(rawMemberId), false);
            assert.equal(warningMessage.includes(rawEmail), false);
        });
    });

    describe('getBatches', function () {
        it('returns an array of batch models', async function () {
            const email = createModel({
                id: '123'
            });
            const emailBatches = [
                createModel({email_id: '123'}),
                createModel({email_id: '123'})
            ];

            const EmailBatch = createModelClass({
                findAll: emailBatches
            });
            const service = new BatchSendingService({
                models: {EmailBatch}
            });
            const batches = await service.getBatches(email);
            assert.equal(batches.length, 2);
            assert.ok(Array.isArray(batches));
        });
    });

    describe('sendBatches', function () {
        it('Works for a single batch', async function () {
            const service = new BatchSendingService({
                sendingService: {
                    getTargetDeliveryWindow() {
                        return 0;
                    }
                }
            });
            const sendBatch = sinon.stub(service, 'sendBatch').callsFake(() => {
                return Promise.resolve(true);
            });
            const batches = [
                createModel({})
            ];
            await service.sendBatches({
                email: createModel({}),
                batches,
                post: createModel({}),
                newsletter: createModel({})
            });
            sinon.assert.calledOnce(sendBatch);
            const arg = sendBatch.firstCall.args[0];
            assert.equal(arg.batch, batches[0]);
        });

        it('Works for more than 2 batches', async function () {
            const clock = sinon.useFakeTimers(new Date());
            const service = new BatchSendingService({
                sendingService: {
                    getTargetDeliveryWindow() {
                        return 0;
                    }
                }
            });
            let runningCount = 0;
            let maxRunningCount = 0;
            const sendBatch = sinon.stub(service, 'sendBatch').callsFake(async () => {
                runningCount += 1;
                maxRunningCount = Math.max(maxRunningCount, runningCount);
                await simulateSleep(5, clock);
                runningCount -= 1;
                return Promise.resolve(true);
            });
            const batches = new Array(101).fill(0).map(() => createModel({}));
            await service.sendBatches({
                email: createModel({}),
                batches,
                post: createModel({}),
                newsletter: createModel({})
            });
            sinon.assert.callCount(sendBatch, 101);
            const sendBatches = sendBatch.getCalls().map(call => call.args[0].batch);
            assert.deepEqual(sendBatches, batches);
            assert.equal(maxRunningCount, 2);
            clock.restore();
        });

        it('Works with a target delivery window set', async function () {
            // Set some parameters for sending the batches
            const now = new Date();
            const clock = sinon.useFakeTimers(now);
            const targetDeliveryWindow = 300000; // 5 minutes
            const expectedDeadline = new Date(now.getTime() + targetDeliveryWindow);
            const numBatches = 10;
            const expectedBatchDelay = targetDeliveryWindow / numBatches;
            const email = createModel({
                created_at: now
            });
            const service = new BatchSendingService({
                sendingService: {
                    getTargetDeliveryWindow() {
                        return targetDeliveryWindow;
                    }
                }
            });
            let runningCount = 0;
            let maxRunningCount = 0;
            // Stub the sendBatch method to inspect the delivery times for each batch
            const sendBatch = sinon.stub(service, 'sendBatch').callsFake(async () => {
                runningCount += 1;
                maxRunningCount = Math.max(maxRunningCount, runningCount);
                await simulateSleep(5, clock);
                runningCount -= 1;
                return Promise.resolve(true);
            });
            // Create the batches
            const batches = new Array(numBatches).fill(0).map(() => createModel({}));
            // Invoke the sendBatches method to send the batches
            await service.sendBatches({
                email,
                batches,
                post: createModel({}),
                newsletter: createModel({})
            });
            // Assert that the sendBatch method was called the correct number of times
            sinon.assert.callCount(sendBatch, numBatches);
            // Get the batches there were sent from the sendBatch method calls
            const sendBatches = sendBatch.getCalls().map(call => call.args[0].batch);
            // Get the delivery times for each batch from the sendBatch method calls
            const deliveryTimes = sendBatch.getCalls().map(call => call.args[0].deliveryTime);

            // Make sure all delivery times are valid dates, and are before the deadline
            deliveryTimes.forEach((time) => {
                assert.ok(time instanceof Date);
                assert.ok(!isNaN(time.getTime()));
                assert.ok(time <= expectedDeadline);
            });
            // Make sure the delivery times are evenly spaced out, within a reasonable range
            // Sort the delivery times in ascending order (just in case they're not in order)
            deliveryTimes.sort((a, b) => a.getTime() - b.getTime());
            const differences = [];
            for (let i = 1; i < deliveryTimes.length; i++) {
                differences.push(deliveryTimes[i].getTime() - deliveryTimes[i - 1].getTime());
            }
            // Make sure the differences are within a few ms of the expected batch delay
            differences.forEach((difference) => {
                assert.ok(difference >= expectedBatchDelay - 100, `Difference ${difference} is less than expected ${expectedBatchDelay}`);
                assert.ok(difference <= expectedBatchDelay + 100, `Difference ${difference} is greater than expected ${expectedBatchDelay}`);
            });
            assert.deepEqual(sendBatches, batches);
            assert.equal(maxRunningCount, 2);
            clock.restore();
        });

        it('uses the persisted partial-resume transition timestamp for delivery deadlines', function () {
            const now = new Date('2026-08-17T20:00:00.000Z');
            const clock = sinon.useFakeTimers(now);
            const targetDeliveryWindow = 300000; // 5 minutes
            const partialTransitionAt = new Date(now.getTime() - 60000); // 1 minute ago
            const originalCampaignCreatedAt = new Date(now.getTime() - 24 * 60 * 60 * 1000);
            const service = new BatchSendingService({
                sendingService: {
                    getTargetDeliveryWindow() {
                        return targetDeliveryWindow;
                    }
                }
            });
            const partialEmail = createModel({
                created_at: originalCampaignCreatedAt,
                updated_at: partialTransitionAt,
                partial_resume: true
            });
            const ordinaryEmail = createModel({
                created_at: partialTransitionAt,
                updated_at: now,
                partial_resume: false
            });

            assert.equal(
                service.getDeliveryDeadline(partialEmail).getTime(),
                partialTransitionAt.getTime() + targetDeliveryWindow,
                'a partial continuation must start its target window at its persisted status transition'
            );
            assert.equal(
                service.getDeliveryDeadline(ordinaryEmail).getTime(),
                partialTransitionAt.getTime() + targetDeliveryWindow,
                'ordinary delivery must preserve the original created_at behavior'
            );

            clock.restore();
        });

        it('fails closed before dispatching a partial continuation without a valid persisted transition timestamp', async function () {
            for (const updatedAt of [null, 'not-a-date']) {
                const service = new BatchSendingService({
                    sendingService: {
                        getTargetDeliveryWindow() {
                            return 0;
                        }
                    }
                });
                const sendBatch = sinon.stub(service, 'sendBatch').resolves(true);

                await assert.rejects(
                    service.sendBatches({
                        email: createModel({
                            id: `partial-with-${updatedAt === null ? 'missing' : 'invalid'}-transition`,
                            created_at: new Date(),
                            updated_at: updatedAt,
                            partial_resume: true
                        }),
                        batches: [createModel({})],
                        post: createModel({}),
                        newsletter: createModel({})
                    }),
                    /partial continuation.*updated_at.*missing or invalid/i
                );
                sinon.assert.notCalled(sendBatch);
            }
        });

        it('respreads deliverytimes over a fresh window if the deadline is in the past', async function () {
            // When a send is resumed after the original deadline has passed (e.g. boot-time
            // recovery of an interrupted send, or a job system delay), we still want to
            // spread the remaining batches over a fresh window of the same size — otherwise
            // every remaining batch hits Mailgun in the same second and breaks the rate-spread.
            const now = new Date();
            const clock = sinon.useFakeTimers(now);
            const targetDeliveryWindow = 300000; // 5 minutes
            const numBatches = 10;
            const email = createModel({
                created_at: now
            });
            const service = new BatchSendingService({
                sendingService: {
                    getTargetDeliveryWindow() {
                        return targetDeliveryWindow;
                    }
                }
            });
            let runningCount = 0;
            let maxRunningCount = 0;
            const sendBatch = sinon.stub(service, 'sendBatch').callsFake(async () => {
                runningCount += 1;
                maxRunningCount = Math.max(maxRunningCount, runningCount);
                await simulateSleep(5, clock);
                runningCount -= 1;
                return Promise.resolve(true);
            });
            const batches = new Array(numBatches).fill(0).map(() => createModel({}));
            // Advance well past the original deadline (now + 300000)
            clock.tick(1000000);
            const startedAt = new Date(clock.now);
            await service.sendBatches({
                email,
                batches,
                post: createModel({}),
                newsletter: createModel({})
            });

            sinon.assert.callCount(sendBatch, numBatches);
            const sendBatches = sendBatch.getCalls().map(call => call.args[0].batch);
            const deliveryTimes = sendBatch.getCalls().map(call => call.args[0].deliveryTime);

            // Every batch should have a delivery time set; none should be undefined.
            deliveryTimes.forEach((time, i) => {
                assert.ok(time instanceof Date, `batch ${i} delivery time should be a Date, got ${time}`);
            });
            // Times should span roughly the full fresh window (targetDeliveryWindow) from
            // the moment sendBatches started, with batch 0 at the start and the last batch
            // near the end.
            const firstMs = deliveryTimes[0].getTime();
            const lastMs = deliveryTimes[deliveryTimes.length - 1].getTime();
            assert.ok(firstMs >= startedAt.getTime() - 100, `first delivery time too early: ${firstMs}`);
            assert.ok(lastMs - firstMs >= targetDeliveryWindow * 0.8, `spread too narrow: ${lastMs - firstMs}ms (expected ~${targetDeliveryWindow}ms)`);
            assert.deepEqual(sendBatches, batches);
            assert.equal(maxRunningCount, 2);
            clock.restore();
        });

        it('Throws error if all batches fail', async function () {
            const clock = sinon.useFakeTimers(new Date());
            const service = new BatchSendingService({
                sendingService: {
                    getTargetDeliveryWindow() {
                        return 0;
                    }
                }
            });
            let runningCount = 0;
            let maxRunningCount = 0;
            const sendBatch = sinon.stub(service, 'sendBatch').callsFake(async () => {
                runningCount += 1;
                maxRunningCount = Math.max(maxRunningCount, runningCount);
                await simulateSleep(5, clock);
                runningCount -= 1;
                return Promise.resolve(false);
            });
            const batches = new Array(101).fill(0).map(() => createModel({}));
            await assert.rejects(service.sendBatches({
                email: createModel({}),
                batches,
                post: createModel({}),
                newsletter: createModel({})
            }), /An unexpected error occurred, please retry sending your newsletter/);
            sinon.assert.callCount(sendBatch, 101);
            const sendBatches = sendBatch.getCalls().map(call => call.args[0].batch);
            assert.deepEqual(sendBatches, batches);
            assert.equal(maxRunningCount, 2);
            clock.restore();
        });

        it('Throws error if a single batch fails', async function () {
            const clock = sinon.useFakeTimers(new Date());
            const service = new BatchSendingService({
                sendingService: {
                    getTargetDeliveryWindow() {
                        return 0;
                    }
                }
            });
            let runningCount = 0;
            let maxRunningCount = 0;
            let callCount = 0;
            const sendBatch = sinon.stub(service, 'sendBatch').callsFake(async () => {
                runningCount += 1;
                maxRunningCount = Math.max(maxRunningCount, runningCount);
                await simulateSleep(5, clock);
                runningCount -= 1;
                callCount += 1;
                return Promise.resolve(callCount === 12 ? false : true);
            });
            const batches = new Array(101).fill(0).map(() => createModel({}));

            /**
             * !! WARNING !!
             * If the error message is changed that it no longer contains the word 'partially',
             * we'll also need the frontend logic in ghost/admin/app/components/editor/modals/publish-flow/complete-with-email-error.js
             */
            await assert.rejects(service.sendBatches({
                email: createModel({}),
                batches,
                post: createModel({}),
                newsletter: createModel({})
            }), /was only partially sent/); // do not change without reading the warning above

            sinon.assert.callCount(sendBatch, 101);
            const sendBatches = sendBatch.getCalls().map(call => call.args[0].batch);
            assert.deepEqual(sendBatches, batches);
            assert.equal(maxRunningCount, 2);
            clock.restore();
        });
    });

    describe('sendBatch', function () {
        let EmailRecipient;

        beforeEach(function () {
            EmailRecipient = createModelClass({
                findAll: [
                    {
                        member_id: '123',
                        member_uuid: '123',
                        member_email: 'example@example.com',
                        member_name: 'Test User',
                        loaded: ['member'],
                        member: createModel({
                            created_at: new Date(),
                            loaded: ['stripeSubscriptions', 'products'],
                            status: 'free',
                            stripeSubscriptions: [],
                            products: []
                        })
                    },
                    {
                        member_id: '124',
                        member_uuid: '124',
                        member_email: 'example2@example.com',
                        member_name: 'Test User 2',
                        loaded: ['member'],
                        member: createModel({
                            created_at: new Date(),
                            status: 'free',
                            loaded: ['stripeSubscriptions', 'products'],
                            stripeSubscriptions: [],
                            products: []
                        })
                    }
                ]
            });
        });

        it('Does not send if already submitted', async function () {
            const EmailBatch = createModelClass({
                findOne: {
                    status: 'submitted'
                }
            });
            const service = new BatchSendingService({
                models: {EmailBatch}
            });

            const result = await service.sendBatch({
                email: createModel({}),
                batch: createModel({status: 'submitted'}),
                post: createModel({}),
                newsletter: createModel({})
            });

            assert.equal(result, true);
            // Already-submitted is an expected resume path, not an error. Logs info, not error.
            sinon.assert.notCalled(errorLog);
            sinon.assert.calledWithMatch(logging.info, /already submitted on a prior run/);
        });

        it('Returns false for orphan submitting batch', async function () {
            // After a crashed worker, batches can be left in `submitting` status.
            // updateStatusLock will return undefined (status not in pending/failed allowlist).
            // sendBatch should return false so the parent email correctly promotes to failed
            // instead of being falsely marked submitted.
            const EmailBatch = createModelClass({
                findOne: {
                    status: 'submitting'
                }
            });
            const service = new BatchSendingService({
                models: {EmailBatch}
            });

            const result = await service.sendBatch({
                email: createModel({}),
                batch: createModel({status: 'submitting'}),
                post: createModel({}),
                newsletter: createModel({})
            });

            assert.equal(result, false);
            sinon.assert.calledOnce(errorLog);
            sinon.assert.calledWith(errorLog, sinon.match(/stuck in status=submitting/));
        });

        it('Does send', async function () {
            const EmailBatch = createModelClass({
                findOne: {
                    status: 'pending',
                    member_segment: null
                }
            });
            const sendingService = {
                send: sinon.stub().resolves({id: 'providerid@example.com'}),
                getMaximumRecipients: () => 5
            };

            const findOne = sinon.spy(EmailBatch, 'findOne');
            const service = new BatchSendingService({
                models: {EmailBatch, EmailRecipient},
                sendingService
            });

            const result = await service.sendBatch({
                email: createModel({}),
                batch: createModel({}),
                post: createModel({}),
                newsletter: createModel({})
            });

            assert.equal(result, true);
            sinon.assert.notCalled(errorLog);
            sinon.assert.calledOnce(sendingService.send);

            sinon.assert.calledOnce(findOne);
            const batch = await findOne.firstCall.returnValue;
            assert.equal(batch.get('status'), 'submitted');
            assert.equal(batch.get('provider_id'), 'providerid@example.com');

            const {members} = sendingService.send.firstCall.args[0];
            assert.equal(members.length, 2);
        });

        it('Does send with a deliverytime', async function () {
            const EmailBatch = createModelClass({
                findOne: {
                    status: 'pending',
                    member_segment: null
                }
            });
            const sendingService = {
                send: sinon.stub().resolves({id: 'providerid@example.com'}),
                getMaximumRecipients: () => 5
            };

            const findOne = sinon.spy(EmailBatch, 'findOne');
            const service = new BatchSendingService({
                models: {EmailBatch, EmailRecipient},
                sendingService
            });

            const inputDeliveryTime = new Date(Date.now() + 10000);

            const result = await service.sendBatch({
                email: createModel({}),
                batch: createModel({}),
                post: createModel({}),
                newsletter: createModel({}),
                deliveryTime: inputDeliveryTime
            });

            assert.equal(result, true);
            sinon.assert.notCalled(errorLog);
            sinon.assert.calledOnce(sendingService.send);

            sinon.assert.calledOnce(findOne);
            const batch = await findOne.firstCall.returnValue;
            assert.equal(batch.get('status'), 'submitted');
            assert.equal(batch.get('provider_id'), 'providerid@example.com');

            const {members} = sendingService.send.firstCall.args[0];
            assert.equal(members.length, 2);

            const {deliveryTime: outputDeliveryTime} = sendingService.send.firstCall.args[1];
            assert.equal(inputDeliveryTime, outputDeliveryTime);
        });

        describe('Domain warming', function () {
            [true, false].forEach((useFallback) => {
                it(`Does send ${useFallback ? 'with' : 'without'} fallback sending domain`, async function () {
                    const EmailBatch = createModelClass({
                        findOne: {
                            status: 'pending',
                            member_segment: null,
                            fallback_sending_domain: useFallback
                        }
                    });
                    const sendingService = {
                        send: sinon.stub().resolves({id: 'providerid@example.com'}),
                        getMaximumRecipients: () => 5
                    };

                    const findOne = sinon.spy(EmailBatch, 'findOne');
                    const service = new BatchSendingService({
                        models: {EmailBatch, EmailRecipient},
                        sendingService
                    });

                    const result = await service.sendBatch({
                        email: createModel({}),
                        batch: createModel({}),
                        post: createModel({}),
                        newsletter: createModel({})
                    });

                    assert.equal(result, true);
                    sinon.assert.notCalled(errorLog);
                    sinon.assert.calledOnce(sendingService.send);

                    const batch = await findOne.firstCall.returnValue;
                    assert.equal(batch.get('status'), 'submitted');
                    assert.equal(batch.get('provider_id'), 'providerid@example.com');
                    assert.equal(batch.get('fallback_sending_domain'), useFallback);
                });
            });
        });

        it('Does save error', async function () {
            const EmailBatch = createModelClass({
                findOne: {
                    status: 'pending',
                    member_segment: null
                }
            });
            const sendingService = {
                send: sinon.stub().rejects(new Error('Test error')),
                getMaximumRecipients: () => 5
            };

            const findOne = sinon.spy(EmailBatch, 'findOne');
            const service = new BatchSendingService({
                models: {EmailBatch, EmailRecipient},
                sendingService,
                MAILGUN_API_RETRY_CONFIG: {
                    sleep: 10, maxRetries: 5
                }
            });

            const result = await service.sendBatch({
                email: createModel({}),
                batch: createModel({}),
                post: createModel({}),
                newsletter: createModel({})
            });

            assert.equal(result, false);
            sinon.assert.callCount(errorLog, 7);
            sinon.assert.callCount(sendingService.send, 6);

            sinon.assert.calledOnce(findOne);
            const batch = await findOne.firstCall.returnValue;
            assert.equal(batch.get('status'), 'failed');
            assert.equal(batch.get('error_status_code'), null);
            assert.equal(batch.get('error_message'), 'Test error');
            assert.equal(batch.get('error_data'), null);
        });

        it('Does log error to Sentry', async function () {
            const EmailBatch = createModelClass({
                findOne: {
                    status: 'pending',
                    member_segment: null
                }
            });
            const sendingService = {
                send: sinon.stub().rejects(new Error('Test error')),
                getMaximumRecipients: () => 5
            };

            const findOne = sinon.spy(EmailBatch, 'findOne');
            const captureException = sinon.stub();
            const service = new BatchSendingService({
                models: {EmailBatch, EmailRecipient},
                sendingService,
                sentry: {
                    captureException
                },
                MAILGUN_API_RETRY_CONFIG: {
                    maxRetries: 0
                }
            });

            const result = await service.sendBatch({
                email: createModel({}),
                batch: createModel({}),
                post: createModel({}),
                newsletter: createModel({})
            });

            assert.equal(result, false);
            sinon.assert.calledOnce(errorLog);
            sinon.assert.calledOnce(sendingService.send);
            sinon.assert.calledOnce(captureException);
            const sentryExeption = captureException.firstCall.args[0];
            assert.equal(sentryExeption.message, 'Test error');

            const loggedExeption = errorLog.firstCall.args[0];
            assert.match(loggedExeption.message, /Error sending email batch/);
            assert.equal(loggedExeption.context, 'Test error');
            assert.equal(loggedExeption.code, 'BULK_EMAIL_SEND_FAILED');

            sinon.assert.calledOnce(findOne);
            const batch = await findOne.firstCall.returnValue;
            assert.equal(batch.get('status'), 'failed');
            assert.equal(batch.get('error_status_code'), null);
            assert.equal(batch.get('error_message'), 'Test error');
            assert.equal(batch.get('error_data'), null);
        });

        it('Does save EmailError', async function () {
            const EmailBatch = createModelClass({
                findOne: {
                    status: 'pending',
                    member_segment: null
                }
            });
            const sendingService = {
                send: sinon.stub().rejects(new errors.EmailError({
                    statusCode: 500,
                    message: 'Test error',
                    errorDetails: JSON.stringify({error: 'test', messageData: 'test'}),
                    context: `Mailgun Error 500: Test error`,
                    help: `https://ghost.org/docs/newsletters/#bulk-email-configuration`,
                    code: 'BULK_EMAIL_SEND_FAILED'
                })),
                getMaximumRecipients: () => 5
            };
            const captureException = sinon.stub();
            const findOne = sinon.spy(EmailBatch, 'findOne');
            const service = new BatchSendingService({
                models: {EmailBatch, EmailRecipient},
                sendingService,
                sentry: {
                    captureException
                },
                MAILGUN_API_RETRY_CONFIG: {
                    maxRetries: 0
                }
            });

            const result = await service.sendBatch({
                email: createModel({}),
                batch: createModel({}),
                post: createModel({}),
                newsletter: createModel({})
            });

            assert.equal(result, false);
            sinon.assert.calledOnce(errorLog);
            sinon.assert.calledOnce(sendingService.send);
            sinon.assert.calledOnce(captureException);
            const sentryExeption = captureException.firstCall.args[0];
            assert.equal(sentryExeption.message, 'Test error');

            sinon.assert.calledOnce(findOne);
            const batch = await findOne.firstCall.returnValue;
            assert.equal(batch.get('status'), 'failed');
            assert.equal(batch.get('error_status_code'), 500);
            assert.equal(batch.get('error_message'), 'Test error');
            assert.equal(batch.get('error_data'), '{"error":"test","messageData":"test"}');
        });

        it('Retries fetching recipients if 0 are returned', async function () {
            const EmailBatch = createModelClass({
                findOne: {
                    status: 'pending',
                    member_segment: null
                }
            });
            const sendingService = {
                send: sinon.stub().resolves({id: 'providerid@example.com'}),
                getMaximumRecipients: () => 5
            };

            const WrongEmailRecipient = createModelClass({
                findAll: []
            });

            let called = 0;
            const MappedEmailRecipient = {
                ...EmailRecipient,
                findAll() {
                    called += 1;
                    if (called === 1) {
                        return WrongEmailRecipient.findAll(...arguments);
                    }
                    return EmailRecipient.findAll(...arguments);
                }
            };

            const findOne = sinon.spy(EmailBatch, 'findOne');
            const service = new BatchSendingService({
                models: {EmailBatch, EmailRecipient: MappedEmailRecipient},
                sendingService,
                BEFORE_RETRY_CONFIG: {maxRetries: 10, maxTime: 2000, sleep: 1}
            });

            const result = await service.sendBatch({
                email: createModel({}),
                batch: createModel({}),
                post: createModel({}),
                newsletter: createModel({})
            });

            assert.equal(result, true);
            sinon.assert.calledOnce(errorLog);
            const loggedExeption = errorLog.firstCall.args[0];
            assert.match(loggedExeption.message, /\[BULK_EMAIL_DB_RETRY\] getBatchMembers batch/);
            assert.match(loggedExeption.context, /No members found for batch/);
            assert.equal(loggedExeption.code, 'BULK_EMAIL_DB_RETRY');

            sinon.assert.calledOnce(sendingService.send);

            sinon.assert.calledOnce(findOne);
            const batch = await findOne.firstCall.returnValue;
            assert.equal(batch.get('status'), 'submitted');
            assert.equal(batch.get('provider_id'), 'providerid@example.com');

            const {members} = sendingService.send.firstCall.args[0];
            assert.equal(members.length, 2);
        });

        it('Throws error if more than the maximum are returned in a batch', async function () {
            const EmailBatch = createModelClass({
                findOne: {
                    id: '123_batch_id',
                    status: 'pending',
                    member_segment: null
                }
            });
            const findOne = sinon.spy(EmailBatch, 'findOne');

            const DoubleTheEmailRecipients = createModelClass({
                findAll: [
                    {
                        member_id: '123',
                        member_uuid: '123',
                        batch_id: '123_batch_id',
                        member_email: 'example@example.com',
                        member_name: 'Test User',
                        loaded: ['member'],
                        member: createModel({
                            created_at: new Date(),
                            loaded: ['stripeSubscriptions', 'products'],
                            status: 'free',
                            stripeSubscriptions: [],
                            products: []
                        })
                    },
                    {
                        member_id: '124',
                        member_uuid: '124',
                        batch_id: '123_batch_id',
                        member_email: 'example2@example.com',
                        member_name: 'Test User 2',
                        loaded: ['member'],
                        member: createModel({
                            created_at: new Date(),
                            status: 'free',
                            loaded: ['stripeSubscriptions', 'products'],
                            stripeSubscriptions: [],
                            products: []
                        })
                    },
                    {
                        member_id: '125',
                        member_uuid: '125',
                        batch_id: '123_batch_id',
                        member_email: 'example3@example.com',
                        member_name: 'Test User 3',
                        loaded: ['member'],
                        member: createModel({
                            created_at: new Date(),
                            status: 'free',
                            loaded: ['stripeSubscriptions', 'products'],
                            stripeSubscriptions: [],
                            products: []
                        })
                    },
                    // NOTE: one recipient from a different batch
                    {
                        member_id: '125',
                        member_uuid: '125',
                        batch_id: '124_ANOTHER_batch_id',
                        member_email: 'example3@example.com',
                        member_name: 'Test User 3',
                        loaded: ['member'],
                        member: createModel({
                            created_at: new Date(),
                            status: 'free',
                            loaded: ['stripeSubscriptions', 'products'],
                            stripeSubscriptions: [],
                            products: []
                        })
                    }
                ]
            });

            const sendingService = {
                send: sinon.stub().resolves({id: 'providerid@example.com'}),
                getMaximumRecipients: () => 2
            };

            const service = new BatchSendingService({
                models: {EmailBatch, EmailRecipient: DoubleTheEmailRecipients},
                sendingService,
                BEFORE_RETRY_CONFIG: {maxRetries: 1, maxTime: 2000, sleep: 1}
            });

            const result = await service.sendBatch({
                email: createModel({}),
                batch: createModel({
                    id: '123_batch_id'
                }),
                post: createModel({}),
                newsletter: createModel({})
            });

            assert.equal(result, false);

            sinon.assert.calledOnce(findOne);
            const batch = await findOne.firstCall.returnValue;
            assert.equal(batch.get('status'), 'failed');
        });

        it('Stops retrying after the email retry cut off time', async function () {
            const EmailBatch = createModelClass({
                findOne: {
                    status: 'pending',
                    member_segment: null
                }
            });
            const sendingService = {
                send: sinon.stub().resolves({id: 'providerid@example.com'}),
                getMaximumRecipients: () => 5
            };

            const WrongEmailRecipient = createModelClass({
                findAll: []
            });

            let called = 0;
            const MappedEmailRecipient = {
                ...EmailRecipient,
                findAll() {
                    called += 1;
                    return WrongEmailRecipient.findAll(...arguments);
                }
            };

            const service = new BatchSendingService({
                models: {EmailBatch, EmailRecipient: MappedEmailRecipient},
                sendingService,
                BEFORE_RETRY_CONFIG: {maxRetries: 10, maxTime: 2000, sleep: 300}
            });

            const email = createModel({});
            email._retryCutOffTime = new Date(Date.now() + 400);

            const result = await service.sendBatch({
                email,
                batch: createModel({}),
                post: createModel({}),
                newsletter: createModel({})
            });
            assert.equal(called, 2);

            assert.equal(result, false);
            sinon.assert.calledThrice(errorLog); // First retry, second retry failed + bulk email send failed
            const loggedExeption = errorLog.firstCall.args[0];
            assert.match(loggedExeption.message, /\[BULK_EMAIL_DB_RETRY\] getBatchMembers batch/);
            assert.match(loggedExeption.context, /No members found for batch/);
            assert.equal(loggedExeption.code, 'BULK_EMAIL_DB_RETRY');

            sinon.assert.notCalled(sendingService.send);
        });
    });

    describe('getBatchMembers', function () {
        it('Works for recipients without members', async function () {
            const EmailRecipient = createModelClass({
                findAll: [
                    {
                        member_id: '123',
                        member_uuid: '123',
                        member_email: 'example@example.com',
                        member_name: 'Test User',
                        loaded: ['member'],
                        member: null
                    }
                ]
            });

            const service = new BatchSendingService({
                models: {EmailRecipient},
                sendingService: {
                    getMaximumRecipients: () => 5
                }
            });

            const result = await service.getBatchMembers('id123');
            assert.equal(result.length, 1);
            assert.equal(result[0].createdAt, null);
        });
    });

    describe('retryDb', function () {
        it('Does retry', async function () {
            const service = new BatchSendingService({});
            let callCount = 0;
            const result = await service.retryDb(() => {
                callCount += 1;
                if (callCount === 3) {
                    return 'ok';
                }
                throw new Error('Test error');
            }, {
                maxRetries: 2, sleep: 10
            });
            assert.equal(result, 'ok');
            assert.equal(callCount, 3);
        });

        it('Stops after maxRetries', async function () {
            const service = new BatchSendingService({});
            let callCount = 0;
            const result = service.retryDb(() => {
                callCount += 1;
                if (callCount === 3) {
                    return 'ok';
                }
                throw new Error('Test error');
            }, {
                maxRetries: 1, sleep: 10
            });
            await assert.rejects(result, /Test error/);
            assert.equal(callCount, 2);
        });

        it('Stops after stopAfterDate', async function () {
            const clock = sinon.useFakeTimers({now: new Date(2023, 0, 1, 0, 0, 0, 0), shouldAdvanceTime: true});
            const service = new BatchSendingService({});
            let callCount = 0;
            const result = service.retryDb(() => {
                callCount += 1;
                clock.tick(1000 * 60);
                throw new Error('Test error');
            }, {
                maxRetries: 1000, stopAfterDate: new Date(2023, 0, 1, 0, 2, 50)
            });
            await assert.rejects(result, /Test error/);
            assert.equal(callCount, 3);
            clock.restore();
        });

        it('Stops after maxTime', async function () {
            const clock = sinon.useFakeTimers({now: new Date(2023, 0, 1, 0, 0, 0, 0), shouldAdvanceTime: true});
            const service = new BatchSendingService({});
            let callCount = 0;
            const result = service.retryDb(() => {
                callCount += 1;
                clock.tick(1000 * 60);
                throw new Error('Test error');
            }, {
                maxRetries: 1000, maxTime: 1000 * 60 * 3 - 1
            });
            await assert.rejects(result, /Test error/);
            assert.equal(callCount, 3);
            clock.restore();
        });

        it('Resolves after maxTime', async function () {
            const clock = sinon.useFakeTimers({now: new Date(2023, 0, 1, 0, 0, 0, 0), shouldAdvanceTime: true});
            const service = new BatchSendingService({});
            let callCount = 0;
            const result = await service.retryDb(() => {
                callCount += 1;
                clock.tick(1000 * 60);

                if (callCount === 3) {
                    return 'ok';
                }
                throw new Error('Test error');
            }, {
                maxRetries: 1000, maxTime: 1000 * 60 * 3
            });
            assert.equal(result, 'ok');
            assert.equal(callCount, 3);
            clock.restore();
        });

        it('Resolves with stopAfterDate', async function () {
            const clock = sinon.useFakeTimers({now: new Date(2023, 0, 1, 0, 0, 0, 0), shouldAdvanceTime: true});
            const service = new BatchSendingService({});
            let callCount = 0;
            const result = await service.retryDb(() => {
                callCount += 1;
                clock.tick(1000 * 60);
                if (callCount === 4) {
                    return 'ok';
                }
                throw new Error('Test error');
            }, {
                maxRetries: 1000, stopAfterDate: new Date(2023, 0, 1, 0, 10, 50)
            });
            assert.equal(result, 'ok');
            assert.equal(callCount, 4);
            clock.restore();
        });
    });

    describe('getDeliveryDeadline', function () {
        it('returns undefined if the targetDeliveryWindow is not set', async function () {
            const email = createModel({
                created_at: new Date()
            });
            const service = new BatchSendingService({
                sendingService: {
                    getTargetDeliveryWindow() {
                        return 0;
                    }
                }
            });
            const result = service.getDeliveryDeadline(email);
            assert.equal(result, undefined, 'getDeliveryDeadline should return undefined if target delivery window is <=0');
        });

        it('returns undefined if the email.created_at is not set', async function () {
            const email = createModel({});
            const service = new BatchSendingService({
                sendingService: {
                    getTargetDeliveryWindow() {
                        return 300000; // 5 minutes
                    }
                }
            });
            const result = service.getDeliveryDeadline(email);
            assert.equal(result, undefined, 'getDeliveryDeadline should return undefined if email.created_at is not set');
        });

        it('returns undefined if the email.created_at is not a valid date', async function () {
            const email = createModel({
                created_at: 'not a date'
            });
            const service = new BatchSendingService({
                sendingService: {
                    getTargetDeliveryWindow() {
                        return 300000; // 5 minutes
                    }
                }
            });
            const result = service.getDeliveryDeadline(email);
            assert.equal(result, undefined, 'getDeliveryDeadline should return undefined if email.created_at is not a valid date');
        });

        it('returns the correct deadline if targetDeliveryWindow is set', async function () {
            const TARGET_DELIVERY_WINDOW = 300000; // 5 minutes
            const emailCreatedAt = new Date();
            const email = createModel({
                created_at: emailCreatedAt
            });
            const expectedDeadline = new Date(emailCreatedAt.getTime() + TARGET_DELIVERY_WINDOW);
            const service = new BatchSendingService({
                sendingService: {
                    getTargetDeliveryWindow() {
                        return TARGET_DELIVERY_WINDOW;
                    }
                }
            });
            const result = service.getDeliveryDeadline(email);
            assert.equal(typeof result, 'object');
            assert.equal(result.toUTCString(), expectedDeadline.toUTCString(), 'The delivery deadline should be 5 minutes after the email.created_at timestamp');
        });
    });

    describe('calculateDeliveryTimes', function () {
        it('does add the correct deliverytimes if we are not past the deadline yet', async function () {
            const now = new Date();
            const clock = sinon.useFakeTimers(now);
            const TARGET_DELIVERY_WINDOW = 300000; // 5 minutes
            const email = createModel({
                created_at: now
            });
            const numBatches = 5;
            const delay = TARGET_DELIVERY_WINDOW / numBatches;

            const service = new BatchSendingService({
                sendingService: {
                    getTargetDeliveryWindow() {
                        return TARGET_DELIVERY_WINDOW;
                    }
                }
            });
            const expectedResult = [
                new Date(now.getTime() + (delay * 0)),
                new Date(now.getTime() + (delay * 1)),
                new Date(now.getTime() + (delay * 2)),
                new Date(now.getTime() + (delay * 3)),
                new Date(now.getTime() + (delay * 4))
            ];
            const result = service.calculateDeliveryTimes(email, numBatches);
            assert.deepEqual(result, expectedResult);
            clock.restore();
        });

        it('respreads batches over a fresh window if the original deadline has passed', async function () {
            // Original behavior here was to return [undefined×n] (deliver immediately) when
            // the deadline had passed. That defeats the rate-spread on resumed sends —
            // 50% of a 10-min send would dump into Mailgun in the same second on restart.
            // New contract: respread over a fresh window of the same size, starting now.
            const now = new Date();
            const clock = sinon.useFakeTimers(now);
            const TARGET_DELIVERY_WINDOW = 300000; // 5 minutes
            const email = createModel({
                created_at: now
            });
            const numBatches = 5;
            const delay = TARGET_DELIVERY_WINDOW / numBatches;
            const service = new BatchSendingService({
                sendingService: {
                    getTargetDeliveryWindow() {
                        return TARGET_DELIVERY_WINDOW;
                    }
                }
            });
            // Advance well past the original deadline.
            clock.tick(1000000);
            const advancedNow = new Date(clock.now);
            const expectedResult = [
                new Date(advancedNow.getTime() + (delay * 0)),
                new Date(advancedNow.getTime() + (delay * 1)),
                new Date(advancedNow.getTime() + (delay * 2)),
                new Date(advancedNow.getTime() + (delay * 3)),
                new Date(advancedNow.getTime() + (delay * 4))
            ];
            const result = service.calculateDeliveryTimes(email, numBatches);
            assert.deepEqual(result, expectedResult);
            clock.restore();
        });

        it('returns an array of undefined values if the target delivery window is not set', async function () {
            const TARGET_DELIVERY_WINDOW = 0;
            const email = createModel({});
            const numBatches = 5;
            const service = new BatchSendingService({
                sendingService: {
                    getTargetDeliveryWindow() {
                        return TARGET_DELIVERY_WINDOW;
                    }
                }
            });
            const expectedResult = [
                undefined, undefined, undefined, undefined, undefined
            ];
            const result = service.calculateDeliveryTimes(email, numBatches);
            assert.deepEqual(result, expectedResult);
        });
    });

    describe('shutdown handling', function () {
        it('onShutdown is idempotent and returns a resolved promise', async function () {
            const service = new BatchSendingService({});
            await service.onShutdown();
            await service.onShutdown();
            // No assertion needed beyond "awaits resolved" — second call must not throw.
        });

        it('sendBatches completes normally if shutdown flag flips after queue is empty', async function () {
            const clock = sinon.useFakeTimers(new Date());
            const service = new BatchSendingService({
                sendingService: {
                    getTargetDeliveryWindow() {
                        return 0;
                    }
                }
            });
            const sendBatch = sinon.stub(service, 'sendBatch').callsFake(async () => {
                await simulateSleep(5, clock);
                return Promise.resolve(true);
            });
            const batches = new Array(2).fill(0).map(() => createModel({}));
            // Trigger shutdown after both batches have been picked up (queue is empty).
            const sendPromise = service.sendBatches({
                email: createModel({}),
                batches,
                post: createModel({}),
                newsletter: createModel({})
            });
            // Both batches are immediately picked up by the two workers, leaving an empty queue.
            await service.onShutdown();
            await sendPromise;
            sinon.assert.callCount(sendBatch, 2);
            clock.restore();
        });

        it('sendBatches throws SHUTDOWN_CODE if queue still has unstarted batches', async function () {
            const service = new BatchSendingService({
                sendingService: {
                    getTargetDeliveryWindow() {
                        return 0;
                    }
                }
            });
            // Flip the flag synchronously inside the first sendBatch invocation so that
            // both workers exit on their next loop iteration with unstarted batches in queue.
            const sendBatch = sinon.stub(service, 'sendBatch').callsFake(async () => {
                service.onShutdown();
                return Promise.resolve(true);
            });
            const batches = new Array(8).fill(0).map(() => createModel({}));
            await assert.rejects(
                service.sendBatches({
                    email: createModel({}),
                    batches,
                    post: createModel({}),
                    newsletter: createModel({})
                }),
                (err) => {
                    return err.code === BatchSendingService.SHUTDOWN_CODE
                        && err.errorType === 'InternalServerError';
                }
            );
            // With MAX_SENDING_CONCURRENCY=2 and 8 batches, at most 2 should run before the flag
            // is observed at loop top (the first sendBatch flips it; the second worker may have
            // already started its own call before observing the flag).
            assert.ok(sendBatch.callCount < batches.length, `sendBatch called ${sendBatch.callCount} times, expected fewer than ${batches.length}`);
        });

        it('onShutdown does not resolve until in-flight sendBatches settles', async function () {
            const service = new BatchSendingService({
                sendingService: {
                    getTargetDeliveryWindow() {
                        return 0;
                    }
                }
            });
            // Gate sendBatch behind a manual promise so we can observe the order
            // in which onShutdown and the in-flight sendBatches resolve.
            let releaseGate;
            const gate = new Promise((resolve) => {
                releaseGate = resolve;
            });
            const sendBatch = sinon.stub(service, 'sendBatch').callsFake(async () => {
                await gate;
                return true;
            });

            // Kick off sendBatches; do NOT await — it must remain in flight.
            const sendPromise = service.sendBatches({
                email: createModel({}),
                batches: [createModel({}), createModel({})],
                post: createModel({}),
                newsletter: createModel({})
            });

            // Tag each promise so we can observe resolution order.
            let onShutdownDone = false;
            let sendBatchesDone = false;
            const onShutdownPromise = service.onShutdown().then(() => {
                onShutdownDone = true;
            });
            sendPromise.then(() => {
                sendBatchesDone = true;
            }).catch(() => {
                sendBatchesDone = true;
            });

            // Yield the microtask queue. Neither sendBatches nor onShutdown can have settled
            // because sendBatch is still awaiting the gate.
            await new Promise((resolve) => {
                setImmediate(resolve);
            });
            assert.equal(sendBatchesDone, false, 'sendBatches should still be in flight');
            assert.equal(onShutdownDone, false, 'onShutdown must wait for in-flight sendBatches');

            // Release the gate; sendBatches finishes, then onShutdown resolves.
            releaseGate();
            await onShutdownPromise;
            await sendPromise;
            assert.equal(onShutdownDone, true);
            assert.equal(sendBatchesDone, true);
            sinon.assert.called(sendBatch);
        });

        it('emailJob leaves email in submitting status when sendEmail rejects with SHUTDOWN_CODE', async function () {
            const captureException = sinon.stub();
            const Email = createModelClass({
                findOne: {
                    status: 'pending'
                }
            });
            const service = new BatchSendingService({
                models: {Email},
                sentry: {captureException}
            });
            let afterEmailModel;
            const sendEmail = sinon.stub(service, 'sendEmail').callsFake((email) => {
                afterEmailModel = email;
                return Promise.reject(new errors.InternalServerError({
                    code: BatchSendingService.SHUTDOWN_CODE,
                    message: 'Email send stopped because the container is shutting down'
                }));
            });
            const result = await service.emailJob({emailId: '123'});
            assert.equal(result, undefined);
            sinon.assert.calledOnce(sendEmail);
            sinon.assert.notCalled(errorLog);
            sinon.assert.notCalled(captureException);
            assert.equal(afterEmailModel.get('status'), 'submitting', 'Email status must remain submitting so the next boot can resume it');
            assert.equal(afterEmailModel.get('error'), undefined, 'No error field should be written when send stops on shutdown');
            // logging.info was stubbed in the outer beforeEach — confirm the shutdown breadcrumb was emitted.
            sinon.assert.calledWithMatch(logging.info, /send stopped because the container is shutting down/);
        });
    });

    describe('legacy partial-resume proof and render snapshot', function () {
        it('admits only a verified legacy prefix and snapshots the persisted lexical source in memory', async function () {
            const {publicKey, row: proof} = createStoredLegacyProof();
            const recipients = [
                {batch_id: LEGACY_BATCH_IDS[0], member_id: LEGACY_MEMBER_IDS[0], member_email: LEGACY_MEMBER_EMAILS[0]},
                {batch_id: LEGACY_BATCH_IDS[1], member_id: LEGACY_MEMBER_IDS[1], member_email: LEGACY_MEMBER_EMAILS[1]}
            ];
            const postMeta = createModel({email_subject: 'Original email subject'});
            const post = createCloneablePost({
                status: 'published',
                title: 'Live title',
                lexical: 'live lexical must not be rendered',
                mobiledoc: 'live mobiledoc must not be rendered',
                posts_meta: postMeta,
                loaded: ['posts_meta']
            });
            const newsletter = createModel({status: 'active'});
            const email = createModel({
                id: LEGACY_EMAIL_ID,
                status: 'submitted',
                partial_resume: false,
                source: 'persisted lexical source',
                source_type: 'lexical',
                subject: 'Live title',
                from: 'persisted@example.test',
                reply_to: 'reply@example.test',
                post,
                newsletter
            });
            const EmailBatch = createModelClass({
                findAll: LEGACY_BATCH_IDS.map(id => ({
                    id,
                    email_id: LEGACY_EMAIL_ID,
                    status: 'submitted',
                    provider_id: LEGACY_EMAIL_ID,
                    recipient_count: null,
                    recipient_hash: null
                }))
            });
            const emailRenderer = {
                getSegments: sinon.stub().resolves([null]),
                getSubject: sinon.stub().returns('Live title'),
                getFromAddress: sinon.stub().returns('persisted@example.test'),
                getReplyToAddress: sinon.stub().returns('reply@example.test'),
                renderBody: sinon.stub().callsFake(async renderedPost => ({
                    html: `html:${renderedPost.get('lexical')}`,
                    plaintext: `text:${renderedPost.get('lexical')}`,
                    replacements: [{id: 'member-name'}]
                }))
            };
            const service = new BatchSendingService({
                models: {EmailBatch},
                db: createLegacyProofDb({proof, recipients}),
                config: {get: key => key === LEGACY_PROOF_PUBLIC_KEY_CONFIG ? publicKey : undefined},
                emailRenderer
            });
            const getMissingRecipientCount = sinon.stub(service, 'getMissingRecipientCount').resolves(1);

            const result = await service.assertCanStartPartialResume(email);

            assert.equal(result.missingRecipientCount, 1);
            assert.match(result.renderHash, /^[a-f0-9]{64}$/);
            const snapshot = getMissingRecipientCount.firstCall.args[0].post;
            assert.notEqual(snapshot, post);
            assert.equal(snapshot.get('lexical'), 'persisted lexical source');
            assert.equal(snapshot.get('mobiledoc'), null);
            assert.equal(post.get('lexical'), 'live lexical must not be rendered');
            assert.equal(post.get('mobiledoc'), 'live mobiledoc must not be rendered');
            sinon.assert.calledWith(emailRenderer.getSegments, snapshot);
            sinon.assert.calledWith(emailRenderer.renderBody, snapshot, newsletter, null, {clickTrackingEnabled: false});

            await email.save({partial_resume: true, partial_resume_render_hash: result.renderHash});
            const recoveryResult = await service.assertCanStartPartialResume(email);
            assert.equal(recoveryResult.renderHash, result.renderHash);

            await email.save({track_clicks: true});
            await assert.rejects(service.assertCanStartPartialResume(email), /cannot be safely continued/);
            await email.save({track_clicks: undefined});

            await email.save({source: 'changed persisted lexical source'});
            await assert.rejects(service.assertCanStartPartialResume(email), /cannot be safely continued/);
            await email.save({source: 'persisted lexical source'});

            await email.save({source_type: 'mobiledoc'});
            await assert.rejects(service.assertCanStartPartialResume(email), /cannot be safely continued/);
            await email.save({source_type: 'lexical'});

            await post.save({title: 'Changed title'});
            await assert.rejects(service.assertCanStartPartialResume(email), /cannot be safely continued/);
            await post.save({title: 'Live title'});

            await postMeta.save({email_subject: 'Changed email subject'});
            await assert.rejects(service.assertCanStartPartialResume(email), /cannot be safely continued/);
            await postMeta.save({email_subject: 'Original email subject'});

            emailRenderer.getSegments.resolves([null, 'members']);
            await assert.rejects(service.assertCanStartPartialResume(email), /cannot be safely continued/);
            emailRenderer.getSegments.resolves([null]);

            await newsletter.save({background_color: 'dark'});
            await assert.rejects(service.assertCanStartPartialResume(email), /cannot be safely continued/);
        });

        it('snapshots persisted mobiledoc source without mutating the live post', async function () {
            const {publicKey, row: proof} = createStoredLegacyProof();
            const recipients = [
                {batch_id: LEGACY_BATCH_IDS[0], member_id: LEGACY_MEMBER_IDS[0], member_email: LEGACY_MEMBER_EMAILS[0]},
                {batch_id: LEGACY_BATCH_IDS[1], member_id: LEGACY_MEMBER_IDS[1], member_email: LEGACY_MEMBER_EMAILS[1]}
            ];
            const source = '{"version":"0.3.1","atoms":[],"cards":[],"markups":[],"sections":[]}';
            const post = createCloneablePost({
                status: 'published',
                title: 'Live title',
                lexical: 'live lexical must not be rendered',
                mobiledoc: 'live mobiledoc must not be rendered',
                loaded: []
            });
            const newsletter = createModel({status: 'active'});
            const email = createModel({
                id: LEGACY_EMAIL_ID,
                partial_resume: false,
                source,
                source_type: 'mobiledoc',
                subject: 'Live title',
                from: 'persisted@example.test',
                reply_to: 'reply@example.test',
                post,
                newsletter
            });
            const EmailBatch = createModelClass({
                findAll: LEGACY_BATCH_IDS.map(id => ({
                    id,
                    email_id: LEGACY_EMAIL_ID,
                    status: 'submitted',
                    provider_id: LEGACY_EMAIL_ID,
                    recipient_count: null,
                    recipient_hash: null
                }))
            });
            const emailRenderer = {
                getSegments: sinon.stub().resolves([null]),
                getSubject: sinon.stub().returns('Live title'),
                getFromAddress: sinon.stub().returns('persisted@example.test'),
                getReplyToAddress: sinon.stub().returns('reply@example.test'),
                renderBody: sinon.stub().callsFake(async renderedPost => ({
                    html: `html:${renderedPost.get('mobiledoc')}`,
                    plaintext: `text:${renderedPost.get('mobiledoc')}`,
                    replacements: []
                }))
            };
            const service = new BatchSendingService({
                models: {EmailBatch},
                db: createLegacyProofDb({proof, recipients}),
                config: {get: key => key === LEGACY_PROOF_PUBLIC_KEY_CONFIG ? publicKey : undefined},
                emailRenderer
            });
            const getMissingRecipientCount = sinon.stub(service, 'getMissingRecipientCount').resolves(1);

            await service.assertCanStartPartialResume(email);

            const snapshot = getMissingRecipientCount.firstCall.args[0].post;
            assert.equal(snapshot.get('lexical'), null);
            assert.equal(snapshot.get('mobiledoc'), source);
            assert.equal(post.get('lexical'), 'live lexical must not be rendered');
            assert.equal(post.get('mobiledoc'), 'live mobiledoc must not be rendered');

            for (const sourceType of [undefined, 'html']) {
                await email.save({source_type: sourceType});
                await assert.rejects(service.assertCanStartPartialResume(email), /cannot be safely continued/);
            }
        });

        it('rejects persisted headers that no longer match the live rendering contract', async function () {
            const {publicKey, row: proof} = createStoredLegacyProof();
            const recipients = [
                {batch_id: LEGACY_BATCH_IDS[0], member_id: LEGACY_MEMBER_IDS[0], member_email: LEGACY_MEMBER_EMAILS[0]},
                {batch_id: LEGACY_BATCH_IDS[1], member_id: LEGACY_MEMBER_IDS[1], member_email: LEGACY_MEMBER_EMAILS[1]}
            ];
            const post = createCloneablePost({status: 'published', title: 'Live title', loaded: []});
            const newsletter = createModel({status: 'active'});
            const email = createModel({
                id: LEGACY_EMAIL_ID,
                partial_resume: false,
                source: 'persisted lexical source',
                source_type: 'lexical',
                subject: 'Live title',
                from: 'persisted@example.test',
                reply_to: 'reply@example.test',
                post,
                newsletter
            });
            const EmailBatch = createModelClass({
                findAll: LEGACY_BATCH_IDS.map(id => ({
                    id,
                    email_id: LEGACY_EMAIL_ID,
                    status: 'submitted',
                    provider_id: LEGACY_EMAIL_ID,
                    recipient_count: null,
                    recipient_hash: null
                }))
            });
            const emailRenderer = {
                getSegments: sinon.stub().resolves([null]),
                getSubject: sinon.stub().returns('Live title'),
                getFromAddress: sinon.stub().returns('changed@example.test'),
                getReplyToAddress: sinon.stub().returns('reply@example.test'),
                renderBody: sinon.stub().resolves({html: '<p>body</p>', plaintext: 'body', replacements: []})
            };
            const service = new BatchSendingService({
                models: {EmailBatch},
                db: createLegacyProofDb({proof, recipients}),
                config: {get: key => key === LEGACY_PROOF_PUBLIC_KEY_CONFIG ? publicKey : undefined},
                emailRenderer
            });
            const getMissingRecipientCount = sinon.stub(service, 'getMissingRecipientCount');

            await assert.rejects(service.assertCanStartPartialResume(email), /cannot be safely continued/);
            sinon.assert.notCalled(getMissingRecipientCount);
        });

        it('rejects a manifest-backed signed legacy batch with an incompatible provider id', async function () {
            const {publicKey, row: proof} = createStoredLegacyProof();
            const recipients = [
                {batch_id: LEGACY_BATCH_IDS[0], member_id: LEGACY_MEMBER_IDS[0], member_email: LEGACY_MEMBER_EMAILS[0]},
                {batch_id: LEGACY_BATCH_IDS[1], member_id: LEGACY_MEMBER_IDS[1], member_email: LEGACY_MEMBER_EMAILS[1]}
            ];
            const post = createCloneablePost({status: 'published', title: 'Live title', loaded: []});
            const newsletter = createModel({status: 'active'});
            const email = createModel({
                id: LEGACY_EMAIL_ID,
                partial_resume: false,
                source: 'persisted lexical source',
                source_type: 'lexical',
                subject: 'Live title',
                from: 'persisted@example.test',
                reply_to: 'reply@example.test',
                post,
                newsletter
            });
            const EmailBatch = createModelClass({
                findAll: LEGACY_BATCH_IDS.map((id, index) => ({
                    id,
                    email_id: LEGACY_EMAIL_ID,
                    status: 'submitted',
                    provider_id: index === 0 ? 'wrong-legacy-provider-id' : 'other-provider-id',
                    recipient_count: 1,
                    recipient_hash: crypto.createHash('sha256').update(JSON.stringify([LEGACY_MEMBER_IDS[index]])).digest('hex')
                }))
            });
            const emailRenderer = {
                getSegments: sinon.stub().resolves([null]),
                getSubject: sinon.stub().returns('Live title'),
                getFromAddress: sinon.stub().returns('persisted@example.test'),
                getReplyToAddress: sinon.stub().returns('reply@example.test'),
                renderBody: sinon.stub().resolves({html: '<p>body</p>', plaintext: 'body', replacements: []})
            };
            const service = new BatchSendingService({
                models: {EmailBatch},
                db: createLegacyProofDb({proof, recipients}),
                config: {get: key => key === LEGACY_PROOF_PUBLIC_KEY_CONFIG ? publicKey : undefined},
                emailRenderer
            });
            const getMissingRecipientCount = sinon.stub(service, 'getMissingRecipientCount').resolves(1);

            await assert.rejects(service.assertCanStartPartialResume(email), /cannot be safely continued/);
            sinon.assert.notCalled(getMissingRecipientCount);
        });

        it('allows only signed null-manifest batches during recovery while verifying later native batches', async function () {
            const {publicKey, row: proof} = createStoredLegacyProof();
            const recipients = [
                {batch_id: LEGACY_BATCH_IDS[0], member_id: LEGACY_MEMBER_IDS[0], member_email: LEGACY_MEMBER_EMAILS[0]},
                {batch_id: LEGACY_BATCH_IDS[1], member_id: LEGACY_MEMBER_IDS[1], member_email: LEGACY_MEMBER_EMAILS[1]}
            ];
            const legacyRows = LEGACY_BATCH_IDS.map(id => ({
                id,
                email_id: LEGACY_EMAIL_ID,
                status: 'submitted',
                provider_id: LEGACY_EMAIL_ID,
                recipient_count: null,
                recipient_hash: null
            }));
            let batchRows = legacyRows;
            const EmailBatch = {
                findAll: async () => {
                    return {models: batchRows.map(row => createModel(row))};
                }
            };
            const post = createCloneablePost({status: 'published', title: 'Live title', loaded: []});
            const newsletter = createModel({status: 'active'});
            const email = createModel({
                id: LEGACY_EMAIL_ID,
                partial_resume: false,
                source: 'persisted lexical source',
                source_type: 'lexical',
                subject: 'Live title',
                from: 'persisted@example.test',
                reply_to: 'reply@example.test',
                post,
                newsletter
            });
            const emailRenderer = {
                getSegments: sinon.stub().resolves([null]),
                getSubject: sinon.stub().returns('Live title'),
                getFromAddress: sinon.stub().returns('persisted@example.test'),
                getReplyToAddress: sinon.stub().returns('reply@example.test'),
                renderBody: sinon.stub().resolves({html: '<p>body</p>', plaintext: 'body', replacements: []})
            };
            const service = new BatchSendingService({
                models: {EmailBatch},
                db: createLegacyProofDb({proof, recipients}),
                config: {get: key => key === LEGACY_PROOF_PUBLIC_KEY_CONFIG ? publicKey : undefined},
                emailRenderer
            });
            sinon.stub(service, 'getMissingRecipientCount').resolves(1);

            const first = await service.assertCanStartPartialResume(email);
            await email.save({partial_resume: true, partial_resume_render_hash: first.renderHash});

            const nativeMemberId = '64b64cfa12ecdd2d94000004';
            const nativeBatchId = '64b64cfa12ecdd2d94000005';
            batchRows = [...legacyRows, {
                id: nativeBatchId,
                email_id: LEGACY_EMAIL_ID,
                status: 'submitted',
                provider_id: 'native-provider-id',
                recipient_count: 1,
                recipient_hash: crypto.createHash('sha256').update(JSON.stringify([nativeMemberId])).digest('hex')
            }];
            recipients.push({batch_id: nativeBatchId, member_id: nativeMemberId, member_email: 'native@example.test'});

            const recovery = await service.assertCanStartPartialResume(email);
            assert.equal(recovery.renderHash, first.renderHash);
        });

        it('rejects an unmanifested legacy batch when no immutable proof exists', async function () {
            const post = createModel({status: 'published'});
            const newsletter = createModel({status: 'active'});
            const email = createModel({
                id: LEGACY_EMAIL_ID,
                partial_resume: false,
                post,
                newsletter
            });
            const EmailBatch = createModelClass({
                findAll: [{
                    id: LEGACY_BATCH_IDS[0],
                    email_id: LEGACY_EMAIL_ID,
                    status: 'submitted',
                    provider_id: LEGACY_EMAIL_ID,
                    recipient_count: null,
                    recipient_hash: null
                }]
            });
            const service = new BatchSendingService({
                models: {EmailBatch},
                db: createLegacyProofDb({recipients: []})
            });
            const getMissingRecipientCount = sinon.stub(service, 'getMissingRecipientCount');

            await assert.rejects(service.assertCanStartPartialResume(email), /cannot be safely continued/);
            sinon.assert.notCalled(getMissingRecipientCount);
        });

        it('keeps a manifest-backed native prefix eligible without a legacy proof', async function () {
            const nativeBatchId = '64b64cfa12ecdd2d94000007';
            const nativeMemberId = '64b64cfa12ecdd2d94000008';
            const post = createCloneablePost({status: 'published', title: 'Native title', loaded: []});
            const newsletter = createModel({status: 'active'});
            const email = createModel({
                id: LEGACY_EMAIL_ID,
                partial_resume: false,
                source: 'native lexical source',
                source_type: 'lexical',
                subject: 'Native title',
                from: 'native@example.test',
                reply_to: 'reply@example.test',
                post,
                newsletter
            });
            const EmailBatch = createModelClass({
                findAll: [{
                    id: nativeBatchId,
                    email_id: LEGACY_EMAIL_ID,
                    status: 'submitted',
                    provider_id: 'normal-provider-id',
                    recipient_count: 1,
                    recipient_hash: crypto.createHash('sha256').update(JSON.stringify([nativeMemberId])).digest('hex')
                }]
            });
            const emailRenderer = {
                getSegments: sinon.stub().resolves([null]),
                getSubject: sinon.stub().returns('Native title'),
                getFromAddress: sinon.stub().returns('native@example.test'),
                getReplyToAddress: sinon.stub().returns('reply@example.test'),
                renderBody: sinon.stub().resolves({html: '<p>native</p>', plaintext: 'native', replacements: []})
            };
            const service = new BatchSendingService({
                models: {EmailBatch},
                db: createLegacyProofDb({recipients: [{
                    batch_id: nativeBatchId,
                    member_id: nativeMemberId,
                    member_email: 'native@example.test'
                }]}),
                emailRenderer
            });
            sinon.stub(service, 'getMissingRecipientCount').resolves(1);

            const result = await service.assertCanStartPartialResume(email);
            assert.match(result.renderHash, /^[a-f0-9]{64}$/);
        });

        it('rejects ambiguous legacy states and provider identities before preflight', async function () {
            const cases = [
                {name: 'wrong provider id', status: 'submitted', providerId: 'unexpected-provider-id'},
                {name: 'pending batch', status: 'pending', providerId: LEGACY_EMAIL_ID},
                {name: 'submitting batch', status: 'submitting', providerId: LEGACY_EMAIL_ID},
                {name: 'failed batch', status: 'failed', providerId: LEGACY_EMAIL_ID}
            ];
            for (const testCase of cases) {
                const {publicKey, row: proof} = createStoredLegacyProof();
                const post = createModel({status: 'published'});
                const newsletter = createModel({status: 'active'});
                const email = createModel({id: LEGACY_EMAIL_ID, partial_resume: false, post, newsletter});
                const EmailBatch = createModelClass({
                    findAll: LEGACY_BATCH_IDS.map((id, index) => ({
                        id,
                        email_id: LEGACY_EMAIL_ID,
                        status: index === 1 ? testCase.status : 'submitted',
                        provider_id: index === 1 ? testCase.providerId : LEGACY_EMAIL_ID,
                        recipient_count: null,
                        recipient_hash: null
                    }))
                });
                const service = new BatchSendingService({
                    models: {EmailBatch},
                    db: createLegacyProofDb({proof, recipients: []}),
                    config: {get: key => key === LEGACY_PROOF_PUBLIC_KEY_CONFIG ? publicKey : undefined}
                });
                const getMissingRecipientCount = sinon.stub(service, 'getMissingRecipientCount');

                await assert.rejects(service.assertCanStartPartialResume(email), /cannot be safely continued/, testCase.name);
                sinon.assert.notCalled(getMissingRecipientCount);
            }
        });

        it('rejects a legacy proof whose current recipient ledger no longer matches', async function () {
            const {publicKey, row: proof} = createStoredLegacyProof();
            const post = createModel({status: 'published'});
            const newsletter = createModel({status: 'active'});
            const email = createModel({id: LEGACY_EMAIL_ID, partial_resume: false, post, newsletter});
            const EmailBatch = createModelClass({
                findAll: LEGACY_BATCH_IDS.map(id => ({
                    id,
                    email_id: LEGACY_EMAIL_ID,
                    status: 'submitted',
                    provider_id: LEGACY_EMAIL_ID,
                    recipient_count: null,
                    recipient_hash: null
                }))
            });
            const recipients = [
                {batch_id: LEGACY_BATCH_IDS[0], member_id: '64b64cfa12ecdd2d94000006', member_email: LEGACY_MEMBER_EMAILS[0]},
                {batch_id: LEGACY_BATCH_IDS[1], member_id: LEGACY_MEMBER_IDS[1], member_email: LEGACY_MEMBER_EMAILS[1]}
            ];
            const service = new BatchSendingService({
                models: {EmailBatch},
                db: createLegacyProofDb({proof, recipients}),
                config: {get: key => key === LEGACY_PROOF_PUBLIC_KEY_CONFIG ? publicKey : undefined}
            });
            const getMissingRecipientCount = sinon.stub(service, 'getMissingRecipientCount');

            await assert.rejects(service.assertCanStartPartialResume(email), /cannot be safely continued/);
            sinon.assert.notCalled(getMissingRecipientCount);
        });

        it('rejects a persisted proof whose canonical hash was altered', async function () {
            const {publicKey, row: proof} = createStoredLegacyProof();
            proof.proof_hash = '0'.repeat(64);
            const post = createModel({status: 'published'});
            const newsletter = createModel({status: 'active'});
            const email = createModel({
                id: LEGACY_EMAIL_ID,
                partial_resume: false,
                post,
                newsletter
            });
            const EmailBatch = createModelClass({
                findAll: LEGACY_BATCH_IDS.map(id => ({
                    id,
                    email_id: LEGACY_EMAIL_ID,
                    status: 'submitted',
                    provider_id: LEGACY_EMAIL_ID,
                    recipient_count: null,
                    recipient_hash: null
                }))
            });
            const service = new BatchSendingService({
                models: {EmailBatch},
                db: createLegacyProofDb({proof, recipients: []}),
                config: {get: key => key === LEGACY_PROOF_PUBLIC_KEY_CONFIG ? publicKey : undefined}
            });
            const getMissingRecipientCount = sinon.stub(service, 'getMissingRecipientCount');

            await assert.rejects(service.assertCanStartPartialResume(email), /cannot be safely continued/);
            sinon.assert.notCalled(getMissingRecipientCount);
        });

        it('propagates persisted header overrides to each continuation batch', async function () {
            const service = new BatchSendingService({
                sendingService: {
                    getTargetDeliveryWindow() {
                        return 0;
                    }
                }
            });
            const sendBatch = sinon.stub(service, 'sendBatch').resolves(true);
            const emailSnapshot = {
                subject: 'Original subject',
                from: 'original@example.test',
                replyTo: 'reply@example.test'
            };

            await service.sendBatches({
                email: createModel({}),
                batches: [createModel({})],
                post: createModel({}),
                newsletter: createModel({}),
                emailSnapshot
            });

            sinon.assert.calledOnce(sendBatch);
            assert.equal(sendBatch.firstCall.args[0].emailSnapshot, emailSnapshot);
        });

        it('blocks a continuation job with a changed render contract before materialization or dispatch', async function () {
            const {publicKey, row: proof} = createStoredLegacyProof();
            const recipients = [
                {batch_id: LEGACY_BATCH_IDS[0], member_id: LEGACY_MEMBER_IDS[0], member_email: LEGACY_MEMBER_EMAILS[0]},
                {batch_id: LEGACY_BATCH_IDS[1], member_id: LEGACY_MEMBER_IDS[1], member_email: LEGACY_MEMBER_EMAILS[1]}
            ];
            const post = createCloneablePost({
                status: 'published',
                title: 'Original title',
                lexical: 'live lexical',
                loaded: []
            });
            const newsletter = createModel({status: 'active'});
            const email = createModel({
                id: LEGACY_EMAIL_ID,
                partial_resume: true,
                partial_resume_render_hash: '0'.repeat(64),
                source: 'original lexical',
                source_type: 'lexical',
                subject: 'Original title',
                from: 'original@example.test',
                reply_to: 'reply@example.test',
                post,
                newsletter
            });
            const EmailBatch = createModelClass({
                findAll: LEGACY_BATCH_IDS.map(id => ({
                    id,
                    email_id: LEGACY_EMAIL_ID,
                    status: 'submitted',
                    provider_id: LEGACY_EMAIL_ID,
                    recipient_count: null,
                    recipient_hash: null
                }))
            });
            const emailRenderer = {
                getSegments: sinon.stub().resolves([null]),
                getSubject: sinon.stub().returns('Original title'),
                getFromAddress: sinon.stub().returns('original@example.test'),
                getReplyToAddress: sinon.stub().returns('reply@example.test'),
                renderBody: sinon.stub().resolves({html: '<p>original</p>', plaintext: 'original', replacements: []})
            };
            const service = new BatchSendingService({
                models: {EmailBatch},
                db: createLegacyProofDb({proof, recipients}),
                config: {get: key => key === LEGACY_PROOF_PUBLIC_KEY_CONFIG ? publicKey : undefined},
                emailRenderer
            });
            const createBatches = sinon.stub(service, 'createBatches');
            const sendBatches = sinon.stub(service, 'sendBatches');

            await assert.rejects(service.sendPartialEmail(email), /cannot be safely continued/);
            sinon.assert.notCalled(createBatches);
            sinon.assert.notCalled(sendBatches);
        });

        it('rejects an extra batch before the initial legacy CAS', async function () {
            const {publicKey, row: proof} = createStoredLegacyProof();
            const post = createModel({status: 'published'});
            const newsletter = createModel({status: 'active'});
            const email = createModel({
                id: LEGACY_EMAIL_ID,
                partial_resume: false,
                post,
                newsletter
            });
            const EmailBatch = createModelClass({
                findAll: [...LEGACY_BATCH_IDS, '64b64cfa12ecdd2d94000003'].map(id => ({
                    id,
                    email_id: LEGACY_EMAIL_ID,
                    status: 'submitted',
                    provider_id: LEGACY_EMAIL_ID,
                    recipient_count: null,
                    recipient_hash: null
                }))
            });
            const service = new BatchSendingService({
                models: {EmailBatch},
                db: createLegacyProofDb({proof, recipients: []}),
                config: {get: key => key === LEGACY_PROOF_PUBLIC_KEY_CONFIG ? publicKey : undefined}
            });
            const getMissingRecipientCount = sinon.stub(service, 'getMissingRecipientCount');

            await assert.rejects(service.assertCanStartPartialResume(email), /cannot be safely continued/);
            sinon.assert.notCalled(getMissingRecipientCount);
        });
    });
});

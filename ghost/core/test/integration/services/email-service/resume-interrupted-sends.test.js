const {agentProvider, fixtureManager, mockManager} = require('../../../utils/e2e-framework');
const models = require('../../../../core/server/models');
const sinon = require('sinon');
const assert = require('node:assert/strict');
const logging = require('@tryghost/logging');
const jobManager = require('../../../../core/server/services/jobs/job-service');
const configUtils = require('../../../utils/config-utils');
const emailService = require('../../../../core/server/services/email-service');
const {sendEmail} = require('../../../utils/batch-email-utils');
const db = require('../../../../core/server/data/db');
const ObjectID = require('bson-objectid').default;
const crypto = require('node:crypto');
const {canonicalizeLegacyProofPayload, hashStringList} = require('../../../../core/server/services/email-service/legacy-partial-resume-proof');

function createLegacyProxyProof({emailId, batchIds, recipients, privateKey, issuedAt = new Date(Date.now() - 1000), proxyLastCreatedAt = new Date(Date.now() - 2000)}) {
    const canonicalRecipientTuples = recipients.map(recipient => `${recipient.batch_id}\u0000${recipient.member_id}\u0000${recipient.member_email}`);
    const payload = {
        version: 1,
        transport: 'ses-proxy-mailgun-v1',
        email_id: emailId,
        issued_at: issuedAt.toISOString(),
        legacy_batch_ids: [...batchIds],
        legacy_provider_id_mode: 'email-id',
        ledger_member_count: recipients.length,
        ledger_member_hash: hashStringList(recipients.map(recipient => recipient.member_id)),
        ledger_email_count: recipients.length,
        ledger_email_hash: hashStringList(recipients.map(recipient => recipient.member_email)),
        ledger_binding_hash: hashStringList(canonicalRecipientTuples),
        proxy_input_count: recipients.length,
        proxy_input_hash: hashStringList(recipients.map(recipient => recipient.member_email)),
        proxy_sent_count: recipients.length,
        proxy_sent_hash: hashStringList(recipients.map(recipient => recipient.member_email)),
        proxy_site_count: 1,
        proxy_batch_count: batchIds.length,
        proxy_first_created_at: proxyLastCreatedAt.toISOString(),
        proxy_last_created_at: proxyLastCreatedAt.toISOString()
    };
    const {payloadJson} = canonicalizeLegacyProofPayload(payload);
    return {
        proof: payload,
        signature: crypto.sign(null, Buffer.from(payloadJson, 'utf8'), privateKey).toString('base64url')
    };
}

async function assertPersistedHeadersMatchSnapshot(emailModel) {
    const newsletter = await emailModel.getLazyRelation('newsletter', {require: true});
    const post = await emailModel.getLazyRelation('post', {require: true, withRelated: ['posts_meta', 'authors', 'tiers']});
    const snapshot = post.clone();
    snapshot.relations = {...post.relations};
    const source = emailModel.get('source');
    const sourceType = emailModel.get('source_type');
    snapshot.set({
        lexical: sourceType === 'lexical' ? source : null,
        mobiledoc: sourceType === 'mobiledoc' ? source : null
    });
    assert.ok(emailModel.get('subject') === emailService.renderer.getSubject(snapshot, false), 'persisted subject must match the immutable snapshot');
    assert.ok(emailModel.get('from') === emailService.renderer.getFromAddress(snapshot, newsletter, false), 'persisted from header must match the immutable snapshot');
    assert.ok((emailModel.get('reply_to') ?? null) === (emailService.renderer.getReplyToAddress(snapshot, newsletter, false) ?? null), 'persisted reply-to header must match the immutable snapshot');
}

async function startPartialContinuationWithoutQueue(agent, emailModel) {
    const addJob = sinon.stub(jobManager, 'addJob').resolves();
    try {
        await agent.put(`emails/${emailModel.id}/partial-resume`).expectStatus(200);
        sinon.assert.calledOnce(addJob);
    } finally {
        addJob.restore();
    }
    await emailModel.refresh();
    assert.equal(emailModel.get('partial_resume'), true);
    assert.match(emailModel.get('partial_resume_render_hash'), /^[a-f0-9]{64}$/);
}

async function simulatePartiallyMaterializedEmail(emailModel) {
    const batches = (await models.EmailBatch.findAll({filter: `email_id:'${emailModel.id}'`})).models;
    assert.equal(batches.length, 2, 'fixture setup should create two batches');

    const [confirmedBatch, unmaterializedBatch] = batches;
    assert.equal(confirmedBatch.get('status'), 'submitted');
    assert.ok(confirmedBatch.get('provider_id'));
    assert.equal(confirmedBatch.get('recipient_count'), 2, 'new batches must persist their recipient count before sending');
    assert.match(confirmedBatch.get('recipient_hash'), /^[a-f0-9]{64}$/, 'new batches must persist a recipient manifest before sending');

    const removedRecipients = (await models.EmailRecipient.findAll({filter: `batch_id:'${unmaterializedBatch.id}'`})).models;
    assert.equal(removedRecipients.length, 2, 'fixture setup should create two recipients per batch');

    // Simulate a process exit after the first batch was persisted/submitted but
    // before the later audience was materialized. This is intentionally test-only
    // state construction; the production continuation never mutates tables directly.
    await db.knex('email_recipients').where({batch_id: unmaterializedBatch.id}).del();
    await db.knex('email_batches').where({id: unmaterializedBatch.id}).del();
    await emailModel.save({status: 'submitted', partial_resume: false}, {patch: true, autoRefresh: false});

    return {confirmedBatch, removedRecipients};
}

describe('Resume interrupted sends', function () {
    let agent;
    let stubbedSend;
    let ghostServer;

    beforeAll(async function () {
        const agents = await agentProvider.getAgentsWithFrontend();
        agent = agents.adminAgent;
        ghostServer = agents.ghostServer;

        await fixtureManager.init('newsletters', 'members:newsletters');
        await agent.loginAsOwner();
    });

    beforeEach(async function () {
        // Force multiple batches from the 4 default fixture members.
        configUtils.set('bulkEmail:batchSize', 2);

        stubbedSend = sinon.fake.resolves({id: 'stubbed-email-id'});
        mockManager.mockMail();
        mockManager.mockMailgun(function () {
            return stubbedSend.call(this, ...arguments);
        });
        mockManager.mockStripe();
    });

    afterEach(async function () {
        await configUtils.restore();
        mockManager.restore();
        await jobManager.allSettled();
    });

    afterAll(async function () {
        mockManager.restore();
        await ghostServer.stop();
    });

    it('resumes a pending batch and skips an already-submitted batch', async function () {
        // 1. Send a real email to populate the DB with a full set of related rows
        //    (post + email + batches + recipients + members).
        const {emailModel} = await sendEmail(agent);
        assert.equal(emailModel.get('partial_resume'), false, 'ordinary emails must start outside the partial-resume path');

        // Sanity: 4 fixture members + batchSize=2 = 2 batches, all submitted.
        let batches = (await models.EmailBatch.findAll({filter: `email_id:'${emailModel.id}'`})).models;
        assert.equal(batches.length, 2, 'expected exactly 2 batches after initial send');
        assert.equal(batches[0].get('status'), 'submitted');
        assert.equal(batches[1].get('status'), 'submitted');

        // 2. Mutate the DB to simulate a crash mid-send: one batch never made it to Mailgun,
        //    the other did; the parent email row is stuck in `submitting`.
        const [batchA, batchB] = batches;
        await batchB.save({status: 'pending', provider_id: null}, {patch: true, autoRefresh: false});
        await emailModel.save({status: 'submitting', created_at: new Date(Date.now() - 60 * 1000)}, {patch: true, autoRefresh: false});

        // 3. Reset the Mailgun stub so we only count calls produced by the resume.
        const mailgunStub = mockManager.getMailgunCreateMessageStub();
        mailgunStub.resetHistory();

        // 4. Run the scanner. It will flip email -> pending and call scheduleEmail; the job
        //    that fires re-enters the normal emailJob -> sendBatches path.
        const completedPromise = jobManager.awaitCompletion('batch-sending-service-job');
        await emailService.service.resumeInterruptedSends();
        await completedPromise;

        // 5. Final state.
        await emailModel.refresh();
        assert.equal(emailModel.get('status'), 'submitted', 'email should re-promote to submitted after resume');

        batches = (await models.EmailBatch.findAll({filter: `email_id:'${emailModel.id}'`})).models;
        const refreshedA = batches.find(b => b.id === batchA.id);
        const refreshedB = batches.find(b => b.id === batchB.id);
        assert.equal(refreshedA.get('status'), 'submitted', 'already-submitted batch remains submitted');
        assert.equal(refreshedB.get('status'), 'submitted', 'previously-pending batch is now submitted');

        // Mailgun called exactly once (for batchB only — batchA was short-circuited).
        sinon.assert.calledOnce(mailgunStub);
    });

    it('admits a verified legacy prefix and resumes only the tail batches after proof admission', async function () {
        configUtils.set('bulkEmail:batchSize', 1);
        const keyPair = crypto.generateKeyPairSync('ed25519');
        configUtils.set('bulkEmail:partialResume:legacyProxyPublicKey', keyPair.publicKey.export({type: 'spki', format: 'pem'}));

        const {emailModel} = await sendEmail(agent);
        const batches = (await models.EmailBatch.findAll({filter: `email_id:'${emailModel.id}'`})).models;
        const recipients = (await models.EmailRecipient.findAll({filter: `email_id:'${emailModel.id}'`})).models;
        assert.equal(batches.length, 4, 'batchSize=1 should materialize four batches for the 4-member fixture');
        assert.equal(recipients.length, 4, 'fixture should materialize one recipient per batch');

        const legacyBatches = batches.slice(0, 2);
        const tailBatches = batches.slice(2);
        const legacyBatchIds = legacyBatches.map(batch => batch.id);
        const legacyRecipientRows = recipients
            .filter(recipient => legacyBatchIds.includes(recipient.get('batch_id')))
            .map(recipient => ({
                batch_id: recipient.get('batch_id'),
                member_id: recipient.get('member_id'),
                member_email: recipient.get('member_email')
            }));
        assert.equal(legacyRecipientRows.length, 2, 'expected exactly two legacy recipient rows');

        for (const batch of legacyBatches) {
            await batch.save({status: 'submitted', provider_id: emailModel.id, recipient_count: null, recipient_hash: null}, {patch: true, autoRefresh: false});
        }
        for (const batch of tailBatches) {
            await db.knex('email_recipients').where({batch_id: batch.id}).del();
            await db.knex('email_batches').where({id: batch.id}).del();
        }
        await emailModel.save({status: 'submitted', partial_resume: false}, {patch: true, autoRefresh: false});

        const signedProof = createLegacyProxyProof({
            emailId: emailModel.id,
            batchIds: legacyBatchIds,
            recipients: legacyRecipientRows,
            privateKey: keyPair.privateKey
        });
        const mailgunStub = mockManager.getMailgunCreateMessageStub();
        mailgunStub.resetHistory();

        await agent
            .put(`emails/${emailModel.id}/partial-resume/legacy-proxy-proof`)
            .body({id: emailModel.id, ...signedProof})
            .expectStatus(200);
        sinon.assert.notCalled(mailgunStub);

        await agent
            .put(`emails/${emailModel.id}/partial-resume/legacy-proxy-proof`)
            .body({id: emailModel.id, ...signedProof})
            .expectStatus(400);
        sinon.assert.notCalled(mailgunStub);

        const legacyProofRows = await db.knex('email_partial_resume_proofs')
            .where({email_id: emailModel.id})
            .select('email_id', 'proof_hash', 'transport');
        assert.equal(legacyProofRows.length, 1);
        assert.equal(legacyProofRows[0].email_id, emailModel.id);
        assert.match(legacyProofRows[0].proof_hash, /^[a-f0-9]{64}$/);
        assert.equal(legacyProofRows[0].transport, 'ses-proxy-mailgun-v1');

        const completedPromise = jobManager.awaitCompletion('batch-sending-service-job');
        await agent.put(`emails/${emailModel.id}/partial-resume`).expectStatus(200);
        await completedPromise;

        await emailModel.refresh();
        assert.equal(emailModel.get('status'), 'submitted');
        assert.equal(emailModel.get('partial_resume'), false);
        assert.equal(emailModel.get('email_count'), 4);

        const finalBatches = (await models.EmailBatch.findAll({filter: `email_id:'${emailModel.id}'`})).models;
        assert.equal(finalBatches.length, 4);
        const refreshedLegacyBatches = finalBatches.filter(batch => legacyBatchIds.includes(batch.id));
        assert.equal(refreshedLegacyBatches.length, 2);
        for (const batch of refreshedLegacyBatches) {
            assert.equal(batch.get('status'), 'submitted');
            assert.equal(batch.get('provider_id'), emailModel.id);
            assert.equal(batch.get('recipient_count'), null);
            assert.equal(batch.get('recipient_hash'), null);
        }

        const refreshedTailBatches = finalBatches.filter(batch => !legacyBatchIds.includes(batch.id));
        assert.equal(refreshedTailBatches.length, 2);
        for (const batch of refreshedTailBatches) {
            assert.equal(batch.get('status'), 'submitted');
            assert.equal(batch.get('provider_id'), 'stubbed-email-id');
            assert.equal(batch.get('recipient_count'), 1);
            assert.match(batch.get('recipient_hash'), /^[a-f0-9]{64}$/);
        }

        const finalRecipients = (await models.EmailRecipient.findAll({filter: `email_id:'${emailModel.id}'`})).models;
        assert.equal(finalRecipients.length, 4);
        assert.equal(new Set(finalRecipients.map(recipient => `${recipient.get('email_id')}\u0000${recipient.get('member_id')}`)).size, 4, 'recipient ledger must stay unique by (email_id, member_id)');
        assert.equal(new Set(finalRecipients.map(recipient => recipient.get('member_id'))).size, 4, 'recipient ledger must stay unique by member_id');
        sinon.assert.calledTwice(mailgunStub);
    });

    it('blocks a legacy tuple swap even after proof admission', async function () {
        configUtils.set('bulkEmail:batchSize', 1);
        const keyPair = crypto.generateKeyPairSync('ed25519');
        configUtils.set('bulkEmail:partialResume:legacyProxyPublicKey', keyPair.publicKey.export({type: 'spki', format: 'pem'}));

        const {emailModel} = await sendEmail(agent);
        const batches = (await models.EmailBatch.findAll({filter: `email_id:'${emailModel.id}'`})).models;
        const recipients = (await models.EmailRecipient.findAll({filter: `email_id:'${emailModel.id}'`})).models;
        const legacyBatches = batches.slice(0, 2);
        const tailBatches = batches.slice(2);
        const legacyBatchIds = legacyBatches.map(batch => batch.id);
        const legacyRecipientRows = recipients
            .filter(recipient => legacyBatchIds.includes(recipient.get('batch_id')))
            .map(recipient => ({
                batch_id: recipient.get('batch_id'),
                member_id: recipient.get('member_id'),
                member_email: recipient.get('member_email')
            }));

        for (const batch of legacyBatches) {
            await batch.save({status: 'submitted', provider_id: emailModel.id, recipient_count: null, recipient_hash: null}, {patch: true, autoRefresh: false});
        }
        for (const batch of tailBatches) {
            await db.knex('email_recipients').where({batch_id: batch.id}).del();
            await db.knex('email_batches').where({id: batch.id}).del();
        }
        await emailModel.save({status: 'submitted', partial_resume: false}, {patch: true, autoRefresh: false});
        // The shared fixture may reuse an address. Give the two signed recipients
        // distinct synthetic addresses so swapping their member/email pairs is a
        // real binding mutation rather than a no-op.
        legacyRecipientRows[0].member_email = 'legacy-swap-a@example.test';
        legacyRecipientRows[1].member_email = 'legacy-swap-b@example.test';
        for (const recipient of legacyRecipientRows) {
            await db.knex('email_recipients').where({email_id: emailModel.id, batch_id: recipient.batch_id, member_id: recipient.member_id}).update({member_email: recipient.member_email});
        }

        const signedProof = createLegacyProxyProof({
            emailId: emailModel.id,
            batchIds: legacyBatchIds,
            recipients: legacyRecipientRows,
            privateKey: keyPair.privateKey
        });
        const mailgunStub = mockManager.getMailgunCreateMessageStub();
        mailgunStub.resetHistory();

        await agent.put(`emails/${emailModel.id}/partial-resume/legacy-proxy-proof`).body({id: emailModel.id, ...signedProof}).expectStatus(200);
        const firstLegacyRecipient = legacyRecipientRows.find(recipient => recipient.batch_id === legacyBatches[0].id);
        const secondLegacyRecipient = legacyRecipientRows.find(recipient => recipient.batch_id === legacyBatches[1].id);
        await db.knex('email_recipients').where({email_id: emailModel.id, batch_id: legacyBatches[0].id}).update({member_email: secondLegacyRecipient.member_email});
        await db.knex('email_recipients').where({email_id: emailModel.id, batch_id: legacyBatches[1].id}).update({member_email: firstLegacyRecipient.member_email});
        const swappedRows = await db.knex('email_recipients').where({email_id: emailModel.id}).whereIn('batch_id', legacyBatchIds).select('batch_id', 'member_email');
        assert.equal(swappedRows.find(row => row.batch_id === legacyBatches[0].id).member_email, secondLegacyRecipient.member_email);
        assert.equal(swappedRows.find(row => row.batch_id === legacyBatches[1].id).member_email, firstLegacyRecipient.member_email);
        const originalTuples = legacyRecipientRows.map(recipient => `${recipient.batch_id}\u0000${recipient.member_id}\u0000${recipient.member_email}`).sort();
        const swappedTuples = swappedRows.map(row => `${row.batch_id}\u0000${legacyRecipientRows.find(recipient => recipient.batch_id === row.batch_id).member_id}\u0000${row.member_email}`).sort();
        assert.notDeepEqual(swappedTuples, originalTuples);
        const swappedBindingHash = hashStringList(swappedTuples);
        assert.notEqual(swappedBindingHash, signedProof.proof.ledger_binding_hash);

        await agent.put(`emails/${emailModel.id}/partial-resume`).expectStatus(400);
        sinon.assert.notCalled(mailgunStub);

        const remainingBatches = (await models.EmailBatch.findAll({filter: `email_id:'${emailModel.id}'`})).models;
        assert.equal(remainingBatches.length, 2, 'tuple swap must block before any tail materialization');
        assert.equal(new Set((await models.EmailRecipient.findAll({filter: `email_id:'${emailModel.id}'`})).models.map(recipient => `${recipient.get('batch_id')}\u0000${recipient.get('member_id')}\u0000${recipient.get('member_email')}`)).size, 2);
    });

    it('marks email as failed when an orphan submitting batch is encountered', async function () {
        // Same setup, but this time one of the batches is left as `submitting` — the orphan
        // state a crashed worker leaves behind. The (b) short-circuit fix should refuse to
        // re-send it (Mailgun-side state unknown) and the parent email should land in `failed`
        // for operator reconciliation.
        const {emailModel} = await sendEmail(agent);

        let batches = (await models.EmailBatch.findAll({filter: `email_id:'${emailModel.id}'`})).models;
        assert.equal(batches.length, 2);

        const [batchA, batchB] = batches;
        // batchA: stays submitted (already accepted by Mailgun on the original run)
        // batchB: flipped to submitting (orphan from crash) — provider_id intentionally preserved
        //          so the breadcrumb in the runbook still cross-references against Mailgun.
        await batchB.save({status: 'submitting'}, {patch: true, autoRefresh: false});
        await emailModel.save({status: 'submitting', created_at: new Date(Date.now() - 60 * 1000)}, {patch: true, autoRefresh: false});

        const mailgunStub = mockManager.getMailgunCreateMessageStub();
        mailgunStub.resetHistory();

        // The orphan batch is an expected, deliberately-triggered failure path (see the
        // "orphan from a crashed worker" guard in batch-sending-service.js) — stub the
        // logger so we can assert that guard fired instead of spamming stdout.
        const errorLog = sinon.stub(logging, 'error');

        const completedPromise = jobManager.awaitCompletion('batch-sending-service-job');
        await emailService.service.resumeInterruptedSends();
        await completedPromise;

        // The orphan batch causes sendBatches' partial-failure throw; emailJob catches and
        // marks the email failed. The orphan batch row is intentionally left in `submitting`
        // so an operator can reconcile it against the Mailgun dashboard before retrying.
        await emailModel.refresh();
        assert.equal(emailModel.get('status'), 'failed', 'email should promote to failed when an orphan submitting batch is present');

        // The orphan-batch guard logs a string; the outer emailJob catch (which also fires,
        // since the partial failure propagates up) logs an EmailError object — only check
        // for the specific guard message we're testing here, not every call's shape.
        const orphanLogs = errorLog.getCalls().filter(call => typeof call.args[0] === 'string' && /is stuck in status=submitting \(orphan from a crashed worker\)/.test(call.args[0]));
        assert.ok(orphanLogs.length > 0, 'expected the "orphan from a crashed worker" guard to log an error');

        batches = (await models.EmailBatch.findAll({filter: `email_id:'${emailModel.id}'`})).models;
        const refreshedA = batches.find(b => b.id === batchA.id);
        const refreshedB = batches.find(b => b.id === batchB.id);
        assert.equal(refreshedA.get('status'), 'submitted', 'already-submitted batch remains submitted');
        assert.equal(refreshedB.get('status'), 'submitting', 'orphan submitting batch is preserved for operator review');

        // No batches were `pending`, so no new Mailgun calls should fire.
        sinon.assert.notCalled(mailgunStub);
    });

    it('continues only the missing recipients and rejects a repeated continuation', async function () {
        const {emailModel} = await sendEmail(agent);
        const {confirmedBatch} = await simulatePartiallyMaterializedEmail(emailModel);
        await assertPersistedHeadersMatchSnapshot(emailModel);

        const mailgunStub = mockManager.getMailgunCreateMessageStub();
        mailgunStub.resetHistory();

        const completedPromise = jobManager.awaitCompletion('batch-sending-service-job');
        await agent.put(`emails/${emailModel.id}/partial-resume`).expectStatus(200);
        await completedPromise;

        await emailModel.refresh();
        assert.equal(emailModel.get('status'), 'submitted');
        assert.equal(emailModel.get('partial_resume'), false);
        assert.equal(emailModel.get('email_count'), 4);

        const batches = (await models.EmailBatch.findAll({filter: `email_id:'${emailModel.id}'`})).models;
        assert.equal(batches.length, 2);
        const originalBatch = batches.find(batch => batch.id === confirmedBatch.id);
        assert.equal(originalBatch.get('status'), 'submitted');
        assert.equal(originalBatch.get('provider_id'), 'stubbed-email-id');
        assert.ok(batches.every(batch => batch.get('status') === 'submitted'));

        const recipients = (await models.EmailRecipient.findAll({filter: `email_id:'${emailModel.id}'`})).models;
        assert.equal(recipients.length, 4);
        assert.equal(new Set(recipients.map(recipient => recipient.get('member_id'))).size, 4, 'recipient ledger must remain unique');
        sinon.assert.calledOnce(mailgunStub);

        // A complete email has no missing audience, so the explicit endpoint is
        // rejected before it can enqueue a second job or create duplicate rows.
        mailgunStub.resetHistory();
        await agent.put(`emails/${emailModel.id}/partial-resume`).expectStatus(400);
        sinon.assert.notCalled(mailgunStub);

        const recipientsAfterRepeat = (await models.EmailRecipient.findAll({filter: `email_id:'${emailModel.id}'`})).models;
        assert.equal(recipientsAfterRepeat.length, 4);
    });

    it('retries a safe failed continuation only through the explicit partial route', async function () {
        const {emailModel} = await sendEmail(agent);
        await simulatePartiallyMaterializedEmail(emailModel);
        await startPartialContinuationWithoutQueue(agent, emailModel);
        await emailModel.save({status: 'failed', partial_resume: true, partial_resume_enqueue_claim: null, error: 'simulated interruption'}, {patch: true, autoRefresh: false});

        const mailgunStub = mockManager.getMailgunCreateMessageStub();
        mailgunStub.resetHistory();

        const completedPromise = jobManager.awaitCompletion('batch-sending-service-job');
        await agent.put(`emails/${emailModel.id}/partial-resume`).expectStatus(200);
        await completedPromise;

        await emailModel.refresh();
        assert.equal(emailModel.get('status'), 'submitted');
        assert.equal(emailModel.get('partial_resume'), false);
        const recipients = (await models.EmailRecipient.findAll({filter: `email_id:'${emailModel.id}'`})).models;
        assert.equal(recipients.length, 4);
        assert.equal(new Set(recipients.map(recipient => recipient.get('member_id'))).size, 4);
        sinon.assert.calledOnce(mailgunStub);
    });

    it('re-enters the partial continuation path after a boot-time restart', async function () {
        const {emailModel} = await sendEmail(agent);
        await simulatePartiallyMaterializedEmail(emailModel);
        await startPartialContinuationWithoutQueue(agent, emailModel);
        await db.knex('emails').where({id: emailModel.id}).update({
            status: 'submitting',
            partial_resume: true,
            partial_resume_enqueue_claim: null,
            updated_at: new Date(Date.now() - 60 * 60 * 1000)
        });

        const mailgunStub = mockManager.getMailgunCreateMessageStub();
        mailgunStub.resetHistory();

        const completedPromise = jobManager.awaitCompletion('batch-sending-service-job');
        await emailService.service.resumeInterruptedSends();
        await completedPromise;

        await emailModel.refresh();
        assert.equal(emailModel.get('status'), 'submitted');
        assert.equal(emailModel.get('partial_resume'), false);
        assert.equal(emailModel.get('email_count'), 4);
        const recipients = (await models.EmailRecipient.findAll({filter: `email_id:'${emailModel.id}'`})).models;
        assert.equal(recipients.length, 4);
        sinon.assert.calledOnce(mailgunStub);
    });

    it('recovers a partial continuation stranded between its state lock and its in-memory job', async function () {
        const {emailModel} = await sendEmail(agent);
        await simulatePartiallyMaterializedEmail(emailModel);
        await startPartialContinuationWithoutQueue(agent, emailModel);
        await db.knex('emails').where({id: emailModel.id}).update({
            status: 'pending',
            partial_resume: true,
            partial_resume_enqueue_claim: null,
            updated_at: new Date(Date.now() - 60 * 60 * 1000)
        });

        const mailgunStub = mockManager.getMailgunCreateMessageStub();
        mailgunStub.resetHistory();

        const completedPromise = jobManager.awaitCompletion('batch-sending-service-job');
        await emailService.service.resumeInterruptedSends();
        await completedPromise;

        await emailModel.refresh();
        assert.equal(emailModel.get('status'), 'submitted');
        assert.equal(emailModel.get('partial_resume'), false);
        const recipients = (await models.EmailRecipient.findAll({filter: `email_id:'${emailModel.id}'`})).models;
        assert.equal(recipients.length, 4);
        sinon.assert.calledOnce(mailgunStub);
    });

    it('recovers a newly-started partial continuation for an older campaign', async function () {
        const {emailModel} = await sendEmail(agent);
        await simulatePartiallyMaterializedEmail(emailModel);
        await startPartialContinuationWithoutQueue(agent, emailModel);

        // The original campaign can be older than the general resume window. A
        // continuation initiated now must be aged from its state transition, not
        // from this historical created_at timestamp.
        const transitionAt = new Date(Date.now() - 60 * 60 * 1000);
        const cutoffIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
        await db.knex('emails').where({id: emailModel.id}).update({
            status: 'pending',
            partial_resume: true,
            partial_resume_enqueue_claim: null,
            created_at: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
            updated_at: transitionAt
        });

        const persistedTiming = await db.knex('emails').where({id: emailModel.id}).first('created_at', 'updated_at');
        assert.ok(new Date(persistedTiming.updated_at).getTime() > new Date(cutoffIso).getTime(), 'fixture must persist a fresh state transition');

        const mailgunStub = mockManager.getMailgunCreateMessageStub();
        mailgunStub.resetHistory();

        await emailService.service.resumeInterruptedSends();
        await jobManager.allSettled();

        await emailModel.refresh();
        assert.equal(emailModel.get('status'), 'submitted', `partial continuation failed: ${emailModel.get('error')}`);
        assert.equal(emailModel.get('partial_resume'), false);
        // The legacy created_at must not alter the persisted recipient ledger:
        // its submitted prefix plus the missing anti-join rows remains the full union.
        assert.equal(emailModel.get('email_count'), 4);
        const recipients = (await models.EmailRecipient.findAll({filter: `email_id:'${emailModel.id}'`})).models;
        assert.equal(recipients.length, 4);
        sinon.assert.calledOnce(mailgunStub);
    });

    it('claims a pre-boot partial continuation once across overlapping scanner calls', async function () {
        const {emailModel} = await sendEmail(agent);
        await simulatePartiallyMaterializedEmail(emailModel);
        await startPartialContinuationWithoutQueue(agent, emailModel);
        await db.knex('emails').where({id: emailModel.id}).update({
            status: 'pending',
            partial_resume: true,
            partial_resume_enqueue_claim: null,
            updated_at: new Date(Date.now() - 60 * 60 * 1000)
        });

        const mailgunStub = mockManager.getMailgunCreateMessageStub();
        mailgunStub.resetHistory();

        await Promise.all([
            emailService.service.resumeInterruptedSends(),
            emailService.service.resumeInterruptedSends()
        ]);
        await jobManager.allSettled();

        await emailModel.refresh();
        assert.equal(emailModel.get('status'), 'submitted');
        assert.equal(emailModel.get('partial_resume'), false);
        const recipients = (await models.EmailRecipient.findAll({filter: `email_id:'${emailModel.id}'`})).models;
        assert.equal(recipients.length, 4);
        assert.equal(new Set(recipients.map(recipient => recipient.get('member_id'))).size, 4);
        sinon.assert.calledOnce(mailgunStub);
    });

    it('fails closed before dispatch when a pre-existing batch is provider-ambiguous', async function () {
        const {emailModel} = await sendEmail(agent);
        const {confirmedBatch} = await simulatePartiallyMaterializedEmail(emailModel);
        await confirmedBatch.save({status: 'submitting'}, {patch: true, autoRefresh: false});

        const mailgunStub = mockManager.getMailgunCreateMessageStub();
        mailgunStub.resetHistory();

        await agent.put(`emails/${emailModel.id}/partial-resume`).expectStatus(400);
        await emailModel.refresh();
        assert.equal(emailModel.get('status'), 'submitted');
        assert.equal(emailModel.get('partial_resume'), false);
        sinon.assert.notCalled(mailgunStub);
    });

    it('fails closed when the confirmed batch ledger is truncated', async function () {
        const {emailModel} = await sendEmail(agent);
        const {confirmedBatch} = await simulatePartiallyMaterializedEmail(emailModel);
        const confirmedRecipient = (await models.EmailRecipient.findAll({filter: `batch_id:'${confirmedBatch.id}'`})).models[0];
        assert.ok(confirmedRecipient, 'fixture must retain a recipient for the provider-confirmed prefix');

        // A missing row within a provider-confirmed batch is not safely
        // distinguishable from an unsent tail through the anti-join alone.
        await db.knex('email_recipients').where({id: confirmedRecipient.id}).del();

        const mailgunStub = mockManager.getMailgunCreateMessageStub();
        mailgunStub.resetHistory();

        await agent.put(`emails/${emailModel.id}/partial-resume`).expectStatus(400);
        await emailModel.refresh();
        assert.equal(emailModel.get('status'), 'submitted');
        assert.equal(emailModel.get('partial_resume'), false);
        sinon.assert.notCalled(mailgunStub);
    });

    it('fails closed when a confirmed ledger keeps its count but changes recipient identity', async function () {
        const {emailModel} = await sendEmail(agent);
        const {confirmedBatch, removedRecipients} = await simulatePartiallyMaterializedEmail(emailModel);
        const confirmedRecipient = (await models.EmailRecipient.findAll({filter: `batch_id:'${confirmedBatch.id}'`})).models[0];
        const replacementMemberId = removedRecipients[0].get('member_id');
        await db.knex('email_recipients').where({id: confirmedRecipient.id}).update({member_id: replacementMemberId});

        const mailgunStub = mockManager.getMailgunCreateMessageStub();
        mailgunStub.resetHistory();

        await agent.put(`emails/${emailModel.id}/partial-resume`).expectStatus(400);
        await emailModel.refresh();
        assert.equal(emailModel.get('status'), 'submitted');
        assert.equal(emailModel.get('partial_resume'), false);
        sinon.assert.notCalled(mailgunStub);
    });

    it('fails closed when a provider-confirmed legacy batch has no recipient manifest', async function () {
        const {emailModel} = await sendEmail(agent);
        const {confirmedBatch} = await simulatePartiallyMaterializedEmail(emailModel);
        await confirmedBatch.save({recipient_count: null, recipient_hash: null}, {patch: true, autoRefresh: false});

        const mailgunStub = mockManager.getMailgunCreateMessageStub();
        mailgunStub.resetHistory();

        await agent.put(`emails/${emailModel.id}/partial-resume`).expectStatus(400);
        await emailModel.refresh();
        assert.equal(emailModel.get('status'), 'submitted');
        assert.equal(emailModel.get('partial_resume'), false);
        sinon.assert.notCalled(mailgunStub);
    });

    it('uses the current eligible audience and does not re-add a member who opted out', async function () {
        const {emailModel} = await sendEmail(agent);
        const {removedRecipients} = await simulatePartiallyMaterializedEmail(emailModel);
        const optedOutMemberId = removedRecipients[0].get('member_id');
        const newsletter = await emailModel.getLazyRelation('newsletter');
        const subscription = await db.knex('members_newsletters')
            .where({member_id: optedOutMemberId, newsletter_id: newsletter.id})
            .first();
        assert.ok(subscription, 'fixture member must be subscribed before opt-out simulation');
        await db.knex('members_newsletters').where({id: subscription.id}).del();

        try {
            const mailgunStub = mockManager.getMailgunCreateMessageStub();
            mailgunStub.resetHistory();

            const completedPromise = jobManager.awaitCompletion('batch-sending-service-job');
            await agent.put(`emails/${emailModel.id}/partial-resume`).expectStatus(200);
            await completedPromise;

            await emailModel.refresh();
            assert.equal(emailModel.get('status'), 'submitted');
            assert.equal(emailModel.get('email_count'), 3);
            const recipients = (await models.EmailRecipient.findAll({filter: `email_id:'${emailModel.id}'`})).models;
            assert.equal(recipients.length, 3);
            assert.equal(recipients.some(recipient => recipient.get('member_id') === optedOutMemberId), false);
            sinon.assert.calledOnce(mailgunStub);
        } finally {
            await db.knex('members_newsletters').insert(subscription);
        }
    });

    it('enforces one recipient row per email and member at the database boundary', async function () {
        const {emailModel} = await sendEmail(agent);
        const recipient = (await models.EmailRecipient.findAll({filter: `email_id:'${emailModel.id}'`})).models[0];
        const duplicate = {...recipient.toJSON(), id: ObjectID().toHexString()};

        await assert.rejects(
            db.knex('email_recipients').insert(duplicate),
            /unique|constraint|duplicate/i
        );
    });

    it('marks email as failed when the parent post is no longer published', async function () {
        // Scanner check: post.status !== 'published'/'sent' -> flip email to failed and skip the resume.
        const {emailModel} = await sendEmail(agent);
        await emailModel.save({status: 'submitting', created_at: new Date(Date.now() - 60 * 1000)}, {patch: true, autoRefresh: false});

        // Unpublish the post by setting it back to draft.
        const post = await emailModel.getLazyRelation('post');
        await post.save({status: 'draft'}, {patch: true, autoRefresh: false});

        const mailgunStub = mockManager.getMailgunCreateMessageStub();
        mailgunStub.resetHistory();

        await emailService.service.resumeInterruptedSends();
        // No job should be enqueued for this email, so no awaitCompletion — we use allSettled
        // in afterEach to drain anything else.

        await emailModel.refresh();
        assert.equal(emailModel.get('status'), 'failed', 'email should be flipped to failed when post is no longer published');
        sinon.assert.notCalled(mailgunStub);
    });
});

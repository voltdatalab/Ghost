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
        await emailModel.save({status: 'submitting'}, {patch: true, autoRefresh: false});

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
        await emailModel.save({status: 'submitting'}, {patch: true, autoRefresh: false});

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
        await emailModel.save({status: 'failed', partial_resume: true, error: 'simulated interruption'}, {patch: true, autoRefresh: false});

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
        await db.knex('emails').where({id: emailModel.id}).update({
            status: 'submitting',
            partial_resume: true,
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
        await db.knex('emails').where({id: emailModel.id}).update({
            status: 'pending',
            partial_resume: true,
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

        // The original campaign can be older than the general resume window. A
        // continuation initiated now must be aged from its state transition, not
        // from this historical created_at timestamp.
        const transitionAt = new Date(Date.now() - 60 * 60 * 1000);
        const cutoffIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
        await db.knex('emails').where({id: emailModel.id}).update({
            status: 'pending',
            partial_resume: true,
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
        await db.knex('emails').where({id: emailModel.id}).update({
            status: 'pending',
            partial_resume: true,
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
        await emailModel.save({status: 'submitting'}, {patch: true, autoRefresh: false});

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

const {agentProvider, fixtureManager, matchers, mockManager} = require('../../utils/e2e-framework');
const {nullable, anyContentVersion, anyEtag, anyObjectId, anyUuid, anyISODateTime, anyString} = matchers;
const configUtils = require('../../utils/config-utils');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const sinon = require('sinon');
const jobManager = require('../../../core/server/services/jobs/job-service');
const models = require('../../../core/server/models');
const db = require('../../../core/server/data/db');
const settingsHelpers = require('../../../core/server/services/settings-helpers');
const {canonicalizeLegacyProofPayload, hashStringList} = require('../../../core/server/services/email-service/legacy-partial-resume-proof');

const matchEmail = {
    id: anyObjectId,
    uuid: anyUuid,
    created_at: anyISODateTime,
    updated_at: anyISODateTime,
    submitted_at: anyISODateTime
};

const matchEmailNewsletter = {
    ...matchEmail,
    newsletter_id: anyObjectId
};

const matchBatch = {
    id: anyObjectId,
    provider_id: anyString,
    created_at: anyISODateTime,
    updated_at: anyISODateTime
};

const matchFailure = {
    id: anyObjectId,
    failed_at: anyISODateTime,
    event_id: anyString
};

function createSignedLegacyProof({emailId, batches, recipients, privateKey}) {
    const batchIds = batches.map(batch => batch.id).sort();
    const memberIds = recipients.map(recipient => recipient.get('member_id'));
    const memberEmails = recipients.map(recipient => recipient.get('member_email'));
    const proxyLastCreatedAt = new Date(Date.now() - 2000);
    const payload = {
        version: 1,
        transport: 'ses-proxy-mailgun-v1',
        email_id: emailId,
        issued_at: new Date(Date.now() - 1000).toISOString(),
        legacy_batch_ids: batchIds,
        legacy_provider_id_mode: 'email-id',
        ledger_member_count: memberIds.length,
        ledger_member_hash: hashStringList(memberIds),
        ledger_email_count: memberEmails.length,
        ledger_email_hash: hashStringList(memberEmails),
        ledger_binding_hash: hashStringList(recipients.map(recipient => `${recipient.get('batch_id')}\u0000${recipient.get('member_id')}\u0000${recipient.get('member_email')}`)),
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
        signature: crypto.sign(null, Buffer.from(payloadJson, 'utf8'), privateKey).toString('base64url')
    };
}

describe('Emails API', function () {
    let agent;

    beforeAll(async function () {
        agent = await agentProvider.getAdminAPIAgent();
        await fixtureManager.init('posts', 'newsletters', 'members', 'members:emails:failed');
        await agent.loginAsOwner();
    });

    beforeEach(function () {
        mockManager.mockEvents();
        mockManager.mockMailgun();
        sinon.stub(settingsHelpers, 'getMembersValidationKey').returns('test-validation-key');
    });

    afterEach(async function () {
        await configUtils.restore();
        mockManager.restore();
        sinon.restore();
    });

    it('Can browse emails', async function () {
        await agent
            .get('emails')
            .expectStatus(200)
            .matchBodySnapshot({
                emails: new Array(2).fill(matchEmail)
            })
            .matchHeaderSnapshot({
                'content-version': anyContentVersion,
                etag: anyEtag
            });
    });

    it('Can read an email', async function () {
        await agent
            .get(`emails/${fixtureManager.get('emails', 0).id}/`)
            .expectStatus(200)
            .matchBodySnapshot({
                emails: [matchEmail]
            })
            .matchHeaderSnapshot({
                'content-version': anyContentVersion,
                etag: anyEtag
            });
    });

    it('Can retry a failed email', async function () {
        await agent
            .put(`emails/${fixtureManager.get('emails', 1).id}/retry`)
            .expectStatus(200)
            .matchBodySnapshot({
                emails: [matchEmail]
            })
            .matchHeaderSnapshot({
                'content-version': anyContentVersion,
                etag: anyEtag
            });

        await jobManager.allSettled();
        mockManager.assert.emittedEvent('email.edited');
    });

    it('admits a reconciled legacy proxy proof without scheduling, dispatch, or mutable email changes', async function () {
        const keyPair = crypto.generateKeyPairSync('ed25519');
        configUtils.set('bulkEmail:partialResume:legacyProxyPublicKey', keyPair.publicKey.export({type: 'spki', format: 'pem'}));

        // Build a provider-confirmed legacy prefix directly from the E2E fixture.
        // Admission must stay read-only: it cannot need a synthetic provider call
        // just to create rows that already exist in the Ghost ledger.
        const emailModel = await models.Email.findOne({id: fixtureManager.get('emails', 0).id}, {require: true});
        const [firstBatch] = (await models.EmailBatch.findAll({filter: `email_id:'${emailModel.id}'`})).models;
        assert.ok(firstBatch);
        const originalFirstBatch = {
            status: firstBatch.get('status'),
            provider_id: firstBatch.get('provider_id')
        };
        await firstBatch.save({status: 'submitted', provider_id: emailModel.id}, {patch: true, autoRefresh: false});
        const secondBatch = await models.EmailBatch.add({
            id: crypto.randomBytes(12).toString('hex'),
            email_id: emailModel.id,
            status: 'submitted',
            provider_id: emailModel.id,
            fallback_sending_domain: false
        });
        const recipients = (await models.EmailRecipient.findAll({filter: `email_id:'${emailModel.id}'`})).models;
        assert.ok(recipients.length > 1);
        const originalRecipientBatchId = recipients[0].get('batch_id');
        await recipients[0].save({batch_id: secondBatch.id}, {patch: true, autoRefresh: false});
        const batches = [firstBatch, secondBatch];
        const mailgunStub = mockManager.getMailgunCreateMessageStub();
        mailgunStub.resetHistory();

        const signedProof = createSignedLegacyProof({
            emailId: emailModel.id,
            batches,
            recipients,
            privateKey: keyPair.privateKey
        });

        await agent
            .put(`emails/${emailModel.id}/partial-resume/legacy-proxy-proof`)
            .body({id: emailModel.id, ...signedProof})
            .expectStatus(200)
            .matchBodySnapshot({emails: [matchEmail]});

        const proofRows = await db.knex('email_partial_resume_proofs')
            .where({email_id: emailModel.id})
            .select('email_id', 'proof_hash', 'transport');
        assert.deepEqual(proofRows.map(row => row.email_id), [emailModel.id]);
        assert.match(proofRows[0].proof_hash, /^[a-f0-9]{64}$/);
        assert.equal(proofRows[0].transport, 'ses-proxy-mailgun-v1');

        await emailModel.refresh();
        assert.equal(emailModel.get('status'), 'submitted');
        assert.equal(emailModel.get('partial_resume'), false);
        assert.equal((await models.EmailBatch.findAll({filter: `email_id:'${emailModel.id}'`})).length, 2);
        assert.equal((await models.EmailRecipient.findAll({filter: `email_id:'${emailModel.id}'`})).length, recipients.length);
        sinon.assert.notCalled(mailgunStub);

        await agent
            .put(`emails/${emailModel.id}/partial-resume/legacy-proxy-proof`)
            .body({id: emailModel.id, ...signedProof})
            .expectStatus(400);
        assert.equal((await db.knex('email_partial_resume_proofs').where({email_id: emailModel.id})).length, 1);
        sinon.assert.notCalled(mailgunStub);

        // Keep the shared E2E fixture intact for the batch-browse assertions below.
        await db.knex('email_partial_resume_proofs').where({email_id: emailModel.id}).delete();
        await db.knex('email_recipients').where({id: recipients[0].id}).update({batch_id: originalRecipientBatchId});
        await db.knex('email_batches').where({id: secondBatch.id}).delete();
        await db.knex('email_batches').where({id: firstBatch.id}).update(originalFirstBatch);
    });

    it('Can browse email batches', async function () {
        await agent
            .get(`emails/${fixtureManager.get('emails', 0).id}/batches/`)
            .expectStatus(200)
            .matchBodySnapshot({
                batches: [matchBatch]
            })
            .matchHeaderSnapshot({
                'content-version': anyContentVersion,
                etag: anyEtag
            });
    });

    it('Can browse email batches with recipient count', async function () {
        const {body} = await agent
            .get(`emails/${fixtureManager.get('emails', 0).id}/batches/?include=count.recipients`)
            .expectStatus(200)
            .matchBodySnapshot({
                batches: [matchBatch]
            })
            .matchHeaderSnapshot({
                'content-version': anyContentVersion,
                etag: anyEtag
            });
        assert.equal(body.batches[0].count.recipients, 6);
    });

    it('Can browse all email failures', async function () {
        await agent
            .get(`emails/${fixtureManager.get('emails', 0).id}/recipient-failures/?order=failed_at%20DESC`)
            .expectStatus(200)
            .matchBodySnapshot({
                failures: new Array(5).fill(matchFailure)
            })
            .matchHeaderSnapshot({
                'content-version': anyContentVersion,
                etag: anyEtag
            });
    });

    it('Can browse permanent email failures', async function () {
        await agent
            .get(`emails/${fixtureManager.get('emails', 0).id}/recipient-failures/?filter=severity:permanent&order=failed_at%20DESC`)
            .expectStatus(200)
            .matchBodySnapshot({
                failures: new Array(1).fill(matchFailure)
            })
            .matchHeaderSnapshot({
                'content-version': anyContentVersion,
                etag: anyEtag
            });
    });

    it('Can browse temporary email failures', async function () {
        await agent
            .get(`emails/${fixtureManager.get('emails', 0).id}/recipient-failures/?filter=severity:temporary&order=failed_at%20DESC`)
            .expectStatus(200)
            .matchBodySnapshot({
                failures: new Array(4).fill(matchFailure)
            })
            .matchHeaderSnapshot({
                'content-version': anyContentVersion,
                etag: anyEtag
            });
    });

    it('Can browse email failures with includes', async function () {
        await agent
            .get(`emails/${fixtureManager.get('emails', 0).id}/recipient-failures/?order=failed_at%20DESC&include=member,email_recipient`)
            .expectStatus(200)
            .matchBodySnapshot({
                failures: new Array(5).fill({
                    ...matchFailure,
                    member: {
                        id: anyObjectId,
                        uuid: anyUuid
                    },
                    email_recipient: {
                        id: anyObjectId,
                        member_uuid: anyUuid,
                        opened_at: nullable(anyISODateTime), // Can be null or string
                        delivered_at: nullable(anyISODateTime), // Can be null or string
                        failed_at: nullable(anyISODateTime), // Can be null or string
                        processed_at: anyISODateTime,
                        batch_id: anyObjectId
                    }
                })
            })
            .matchHeaderSnapshot({
                'content-version': anyContentVersion,
                etag: anyEtag
            });
    });

    // Older Ghost emails still have a html body and plaintext body set.
    it('Does default replacements on the HTML body of an old email', async function () {
        const html = '<p style="margin: 0 0 1.5em 0; line-height: 1.6em;">Hey %%{first_name, &quot;there&quot;}%%, Hey %%{first_name}%%,</p><a href="%%{unsubscribe_url}%%">Unsubscribe</a>';
        const plaintext = 'Hey %%{first_name, "there"}%%, Hey %%{first_name}%%\nUnsubscribe [%%{unsubscribe_url}%%]';

        // Create this email model in the database
        const email = await models.Email.add({
            post_id: fixtureManager.get('posts', 2).id,
            newsletter_id: fixtureManager.get('newsletters', 0).id,
            status: 'submitted',
            submitted_at: new Date(),
            track_opens: false,
            track_clicks: false,
            feedback_enabled: false,
            recipient_filter: 'all',
            subject: 'Test email',
            from: 'support@example.com',
            replyTo: null,
            email_count: 1,
            source: '{}',
            source_type: 'lexical',
            html,
            plaintext
        });

        const {body} = await agent
            .get(`emails/${email.id}/`)
            .expectStatus(200)
            .matchBodySnapshot({
                emails: [matchEmailNewsletter]
            })
            .matchHeaderSnapshot({
                'content-version': anyContentVersion,
                etag: anyEtag
            });

        // Simple check that there are not %%{ leftover (in case the snapshots gets updated without noticing what this test is checking)
        assert.equal(body.emails[0].html.includes('%%{'), false);
        assert.equal(body.emails[0].plaintext.includes('%%{'), false);
    });
});

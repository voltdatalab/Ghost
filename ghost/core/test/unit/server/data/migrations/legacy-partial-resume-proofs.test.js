const assert = require('node:assert/strict');
const knex = require('knex').default;
const legacyPartialResumeProofsMigration = require('../../../../../core/server/data/migrations/versions/6.57/2026-08-17-01-00-00-add-legacy-partial-resume-proofs');
const partialResumeEnqueueClaimMigration = require('../../../../../core/server/data/migrations/versions/6.57/2026-08-18-00-00-00-add-partial-resume-enqueue-claim');

const EMAIL_ID = '64b000000000000000000001';
const LEGACY_BATCH_ID = '64b000000000000000000002';
const FIRST_PROOF_ID = '64b000000000000000000003';
const SECOND_PROOF_ID = '64b000000000000000000004';
const MISSING_EMAIL_ID = '64b000000000000000000005';
const CREATED_AT = '2026-08-17T22:20:00.000Z';

/**
 * @param {string} id
 * @param {string} emailId
 */
function proofRow(id, emailId) {
    return {
        id,
        email_id: emailId,
        proof_payload: '{"version":1}',
        proof_hash: 'a'.repeat(64),
        signature: 'A'.repeat(86),
        signing_key_fingerprint: 'b'.repeat(64),
        transport: 'ses-proxy-mailgun-v1',
        created_at: CREATED_AT
    };
}

/**
 * @param {unknown} error
 * @param {string} expectedCode
 * @param {RegExp} messagePattern
 */
function hasConstraintError(error, expectedCode, messagePattern) {
    if (typeof error !== 'object' || error === null) {
        return false;
    }

    const candidate = /** @type {{code?: unknown, message?: unknown}} */ (error);
    return candidate.code === expectedCode || (typeof candidate.message === 'string' && messagePattern.test(candidate.message));
}

describe('Legacy partial resume proofs migration', function () {
    /** @type {import('knex').Knex} */
    let db;

    beforeEach(async function () {
        db = knex({
            client: 'better-sqlite3',
            useNullAsDefault: true,
            connection: {filename: ':memory:'}
        });
        await db.raw('PRAGMA foreign_keys = ON;');

        await db.schema.createTable('emails', function (table) {
            table.string('id', 24).primary();
        });
        await db.schema.createTable('email_batches', function (table) {
            table.string('id', 24).primary();
            table.string('email_id', 24).notNullable();
            table.integer('recipient_count').nullable();
            table.string('recipient_hash', 64).nullable();
        });

        await db('emails').insert({id: EMAIL_ID});
        await db('email_batches').insert({
            id: LEGACY_BATCH_ID,
            email_id: EMAIL_ID,
            recipient_count: null,
            recipient_hash: null
        });
    });

    afterEach(async function () {
        await db.destroy();
    });

    it('creates a one-proof-per-email audit table, foreign key, and nullable render hash without changing legacy batches', async function () {
        await legacyPartialResumeProofsMigration.up({connection: db});

        assert.equal(await db.schema.hasTable('email_partial_resume_proofs'), true);
        for (const column of [
            'id',
            'email_id',
            'proof_payload',
            'proof_hash',
            'signature',
            'signing_key_fingerprint',
            'transport',
            'created_at'
        ]) {
            assert.equal(await db.schema.hasColumn('email_partial_resume_proofs', column), true, `missing proof column ${column}`);
        }
        assert.equal(await db.schema.hasColumn('emails', 'partial_resume_render_hash'), true);

        const legacyBatch = await db('email_batches').where({id: LEGACY_BATCH_ID}).first();
        assert.deepEqual(legacyBatch, {
            id: LEGACY_BATCH_ID,
            email_id: EMAIL_ID,
            recipient_count: null,
            recipient_hash: null
        }, 'the migration must not fill or alter legacy batch manifests');

        const email = await db('emails').where({id: EMAIL_ID}).first();
        assert.equal(email.partial_resume_render_hash, null, 'the render hash must be nullable for existing emails');

        await db('email_partial_resume_proofs').insert(proofRow(FIRST_PROOF_ID, EMAIL_ID));
        await assert.rejects(
            db('email_partial_resume_proofs').insert(proofRow(SECOND_PROOF_ID, EMAIL_ID)),
            error => hasConstraintError(error, 'SQLITE_CONSTRAINT_UNIQUE', /unique|duplicate/i),
            'a second proof for one email must fail closed'
        );
        await assert.rejects(
            db('email_partial_resume_proofs').insert(proofRow(SECOND_PROOF_ID, MISSING_EMAIL_ID)),
            error => hasConstraintError(error, 'SQLITE_CONSTRAINT_FOREIGNKEY', /foreign key/i),
            'a proof must reference an existing email'
        );
        await assert.rejects(
            db('emails').where({id: EMAIL_ID}).delete(),
            error => hasConstraintError(error, 'SQLITE_CONSTRAINT_FOREIGNKEY', /foreign key/i),
            'an admitted proof must prevent deleting its email'
        );
    });

    it('rolls back only the proof table and render-hash column', async function () {
        await legacyPartialResumeProofsMigration.up({connection: db});
        await db('email_partial_resume_proofs').insert(proofRow(FIRST_PROOF_ID, EMAIL_ID));

        await legacyPartialResumeProofsMigration.down({connection: db});

        assert.equal(await db.schema.hasTable('email_partial_resume_proofs'), false);
        assert.equal(await db.schema.hasColumn('emails', 'partial_resume_render_hash'), false);
        assert.equal(await db.schema.hasTable('email_batches'), true);
        assert.deepEqual(await db('email_batches').where({id: LEGACY_BATCH_ID}).first(), {
            id: LEGACY_BATCH_ID,
            email_id: EMAIL_ID,
            recipient_count: null,
            recipient_hash: null
        });
    });

    it('adds and reverses only the nullable per-enqueue recovery claim after the proof migration', async function () {
        await legacyPartialResumeProofsMigration.up({connection: db});
        await partialResumeEnqueueClaimMigration.up({connection: db});

        assert.equal(await db.schema.hasColumn('emails', 'partial_resume_enqueue_claim'), true);
        assert.equal((await db('emails').where({id: EMAIL_ID}).first()).partial_resume_enqueue_claim, null);
        await db('emails').where({id: EMAIL_ID}).update({partial_resume_enqueue_claim: '00000000-0000-4000-8000-000000000001'});
        assert.equal((await db('emails').where({id: EMAIL_ID}).first()).partial_resume_enqueue_claim, '00000000-0000-4000-8000-000000000001');

        await partialResumeEnqueueClaimMigration.down({connection: db});

        assert.equal(await db.schema.hasColumn('emails', 'partial_resume_enqueue_claim'), false);
        assert.equal(await db.schema.hasColumn('emails', 'partial_resume_render_hash'), true);
        assert.equal(await db.schema.hasTable('email_partial_resume_proofs'), true);
        assert.deepEqual(await db('email_batches').where({id: LEGACY_BATCH_ID}).first(), {
            id: LEGACY_BATCH_ID,
            email_id: EMAIL_ID,
            recipient_count: null,
            recipient_hash: null
        });
    });
});

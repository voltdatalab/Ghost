const assert = require('node:assert/strict');
const knex = require('knex').default;
const partialEmailResumeIntegrityMigration = require('../../../../../core/server/data/migrations/versions/6.57/2026-08-17-00-00-00-add-partial-email-resume-integrity');

describe('Partial email resume integrity migration', function () {
    /** @type {import('knex').Knex} */
    let db;

    beforeEach(async function () {
        db = knex({
            client: 'better-sqlite3',
            useNullAsDefault: true,
            connection: {filename: ':memory:'}
        });

        // Minimal pre-migration shape. The migration only needs these tables and
        // columns; in particular, email_recipients intentionally has no unique
        // constraint yet so it can model a legacy database.
        await db.schema.createTable('emails', function (table) {
            table.string('id').primary();
        });
        await db.schema.createTable('email_batches', function (table) {
            table.string('id').primary();
        });
        await db.schema.createTable('email_recipients', function (table) {
            table.string('id').primary();
            table.string('email_id').notNullable();
            table.string('member_id').notNullable();
        });
    });

    afterEach(async function () {
        await db.destroy();
    });

    it('fails closed on historical duplicate recipients without repairing or indexing them', async function () {
        await db('email_recipients').insert([
            {id: 'recipient-1', email_id: 'email-1', member_id: 'member-1'},
            {id: 'recipient-2', email_id: 'email-1', member_id: 'member-1'}
        ]);

        await assert.rejects(
            partialEmailResumeIntegrityMigration.up({connection: db}),
            error => error.code === 'SQLITE_CONSTRAINT_UNIQUE' || /unique|duplicate|constraint/i.test(error.message),
            'historical duplicate recipient rows must stop the migration'
        );

        const persistedRows = await db('email_recipients').where({email_id: 'email-1', member_id: 'member-1'});
        assert.equal(persistedRows.length, 2, 'the migration must not auto-repair historical rows');

        // The unique key must not be installed after the failed migration. If it
        // were, this third duplicate would be rejected instead of preserving the
        // fail-closed state for operator reconciliation.
        await db('email_recipients').insert({id: 'recipient-3', email_id: 'email-1', member_id: 'member-1'});
    });

    it('adds the composite unique key for a valid pre-migration recipient ledger', async function () {
        await db('email_recipients').insert({id: 'recipient-1', email_id: 'email-1', member_id: 'member-1'});

        await partialEmailResumeIntegrityMigration.up({connection: db});

        assert.equal(await db.schema.hasColumn('emails', 'partial_resume'), true);
        assert.equal(await db.schema.hasColumn('email_batches', 'recipient_count'), true);
        assert.equal(await db.schema.hasColumn('email_batches', 'recipient_hash'), true);

        await assert.rejects(
            db('email_recipients').insert({id: 'recipient-2', email_id: 'email-1', member_id: 'member-1'}),
            error => error.code === 'SQLITE_CONSTRAINT_UNIQUE' || /unique|duplicate|constraint/i.test(error.message),
            'the migration must enforce one recipient row per email and member'
        );
    });
});

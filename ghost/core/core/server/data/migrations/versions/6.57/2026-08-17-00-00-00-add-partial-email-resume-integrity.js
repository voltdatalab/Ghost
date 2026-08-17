const {combineNonTransactionalMigrations, createAddColumnMigration, createNonTransactionalMigration} = require('../../utils');
const {addUnique, dropUnique} = require('../../../schema/commands');

const recipientUniqueColumns = ['email_id', 'member_id'];
const recipientUniqueIndex = 'email_recipients_email_member_unique';

// The unique index is intentionally added without attempting to repair old data.
// If a site already has duplicates, migration failure is the safe signal to stop
// and reconcile them before enabling a continuation path.
module.exports = combineNonTransactionalMigrations(
    createAddColumnMigration('emails', 'partial_resume', {
        type: 'boolean',
        nullable: false,
        defaultTo: false
    }, {
        // Let MySQL choose INSTANT/INPLACE when available rather than forcing
        // the migration helper's conservative table-copy default.
        algorithm: 'auto'
    }),
    // Existing batches intentionally retain null manifests. A historical
    // provider-confirmed prefix without an immutable recipient manifest cannot
    // be safely continued by anti-join, so the runtime rejects it for manual
    // reconciliation instead of guessing who Mailgun already accepted.
    createAddColumnMigration('email_batches', 'recipient_count', {
        type: 'integer',
        nullable: true,
        unsigned: true
    }, {
        algorithm: 'auto'
    }),
    createAddColumnMigration('email_batches', 'recipient_hash', {
        type: 'string',
        maxlength: 64,
        nullable: true
    }, {
        algorithm: 'auto'
    }),
    createNonTransactionalMigration(
        async function up(knex) {
            await addUnique('email_recipients', recipientUniqueColumns, knex, recipientUniqueIndex);
        },
        async function down(knex) {
            await dropUnique('email_recipients', recipientUniqueColumns, knex, recipientUniqueIndex);
        }
    )
);

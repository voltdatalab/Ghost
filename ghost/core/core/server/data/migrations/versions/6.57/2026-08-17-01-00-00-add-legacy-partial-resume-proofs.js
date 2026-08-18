const {addTable, combineNonTransactionalMigrations, createAddColumnMigration} = require('../../utils');

const PROOF_TABLE = 'email_partial_resume_proofs';

const renderHashColumn = {
    type: 'string',
    maxlength: 64,
    nullable: true
};

// This is intentionally a migration-local snapshot. Future schema changes must
// not alter the shape applied to sites upgrading from this version.
const proofTableSpec = {
    id: {type: 'string', maxlength: 24, nullable: false, primary: true},
    email_id: {type: 'string', maxlength: 24, nullable: false, unique: true, references: 'emails.id', restrictDelete: true},
    proof_payload: {type: 'string', maxlength: 4096, nullable: false},
    proof_hash: {type: 'string', maxlength: 64, nullable: false},
    signature: {type: 'string', maxlength: 86, nullable: false},
    signing_key_fingerprint: {type: 'string', maxlength: 64, nullable: false},
    transport: {type: 'string', maxlength: 50, nullable: false},
    created_at: {type: 'dateTime', nullable: false}
};

module.exports = combineNonTransactionalMigrations(
    createAddColumnMigration('emails', 'partial_resume_render_hash', renderHashColumn, {algorithm: 'auto'}),
    addTable(PROOF_TABLE, proofTableSpec)
);

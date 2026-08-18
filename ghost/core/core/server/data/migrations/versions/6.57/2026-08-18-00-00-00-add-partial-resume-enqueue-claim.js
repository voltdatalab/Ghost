const {createAddColumnMigration} = require('../../utils');

// A durable, opaque per-enqueue ownership token for boot recovery. It is
// deliberately separate from emails.error, which is an operator-facing field.
const partialResumeEnqueueClaimColumn = {
    type: 'string',
    maxlength: 36,
    nullable: true
};

module.exports = createAddColumnMigration(
    'emails',
    'partial_resume_enqueue_claim',
    partialResumeEnqueueClaimColumn,
    {algorithm: 'auto'}
);

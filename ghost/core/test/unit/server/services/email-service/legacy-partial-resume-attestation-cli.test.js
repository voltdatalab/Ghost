const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {pathToFileURL} = require('node:url');
const knex = require('knex').default;

const {verifyLegacyProof} = require('../../../../../core/server/services/email-service/legacy-partial-resume-proof');

const SCRIPT_PATH = path.join(__dirname, '../../../../../scripts/partial-resume/attest-legacy-ses-proxy.mjs');
const EMAIL_ID = '64b000000000000000000001';
const BATCH_IDS = [
    '64b000000000000000000002',
    '64b000000000000000000003'
];
const MEMBER_IDS = [
    '64b000000000000000000010',
    '64b000000000000000000011'
];
const MEMBER_EMAILS = [
    'first@example.test',
    'second@example.test'
];
const LEGACY_PROXY_KEY_PAIR = crypto.generateKeyPairSync('ed25519');
const LEGACY_PROXY_PRIVATE_KEY = LEGACY_PROXY_KEY_PAIR.privateKey;
const LEGACY_PROXY_PUBLIC_KEY = LEGACY_PROXY_KEY_PAIR.publicKey.export({type: 'spki', format: 'pem'});

function sha256(value) {
    return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function readOnlyUrl(filePath) {
    return `${pathToFileURL(filePath).href}?mode=ro`;
}

function proxyContents({batchId, memberId, memberEmail}) {
    return {
        provider_mode: 'email-id',
        site_id: '64b000000000000000000099',
        batch_id: batchId,
        input: [{batch_id: batchId, member_id: memberId, member_email: memberEmail}],
        sent: [{batch_id: batchId, member_id: memberId, member_email: memberEmail}],
        events: [
            {
                type: 'accepted',
                created_at: '2026-08-16T14:11:39.000Z',
                payload: {batch_id: batchId, member_id: memberId, member_email: memberEmail}
            },
            {
                type: 'sent',
                created_at: '2026-08-16T14:11:39.200Z',
                payload: {batch_id: batchId, member_id: memberId, member_email: memberEmail}
            }
        ]
    };
}

async function createGhostDb(filePath) {
    const db = knex({
        client: 'better-sqlite3',
        connection: {
            filename: filePath
        },
        useNullAsDefault: true
    });

    await db.schema.createTable('emails', table => {
        table.string('id', 24).primary();
        table.string('status', 50).notNullable();
        table.boolean('partial_resume').notNullable();
    });
    await db.schema.createTable('email_batches', table => {
        table.string('id', 24).primary();
        table.string('email_id', 24).notNullable();
        table.string('provider_id', 255).nullable();
        table.string('status', 50).notNullable();
        table.integer('recipient_count').nullable();
        table.string('recipient_hash', 64).nullable();
    });
    await db.schema.createTable('email_recipients', table => {
        table.string('id', 24).primary();
        table.string('email_id', 24).notNullable();
        table.string('batch_id', 24).notNullable();
        table.string('member_id', 24).notNullable();
        table.string('member_email', 191).notNullable();
    });

    await db('emails').insert({
        id: EMAIL_ID,
        status: 'submitted',
        partial_resume: false
    });

    for (const [index, batchId] of BATCH_IDS.entries()) {
        await db('email_batches').insert({
            id: batchId,
            email_id: EMAIL_ID,
            provider_id: EMAIL_ID,
            status: 'submitted',
            recipient_count: 1,
            recipient_hash: sha256(MEMBER_EMAILS[index])
        });
        await db('email_recipients').insert({
            id: `64b0000000000000000001${index}`,
            email_id: EMAIL_ID,
            batch_id: batchId,
            member_id: MEMBER_IDS[index],
            member_email: MEMBER_EMAILS[index]
        });
    }

    await db.destroy();
}

async function createProxyDb(filePath, {contentsByBatchId = {}, extraBatch = null} = {}) {
    const db = knex({
        client: 'better-sqlite3',
        connection: {
            filename: filePath
        },
        useNullAsDefault: true
    });

    await db.schema.createTable('NewsletterBatch', table => {
        table.string('id', 24).primary();
        table.string('email_id', 24).notNullable();
        table.text('contents').notNullable();
    });

    const baseContents = (batchId) => {
        const index = BATCH_IDS.indexOf(batchId);
        return proxyContents({
            batchId,
            memberId: MEMBER_IDS[index],
            memberEmail: MEMBER_EMAILS[index]
        });
    };

    for (const batchId of BATCH_IDS) {
        await db('NewsletterBatch').insert({
            id: batchId,
            email_id: EMAIL_ID,
            contents: JSON.stringify(contentsByBatchId[batchId] || baseContents(batchId))
        });
    }
    if (extraBatch) {
        await db('NewsletterBatch').insert({
            id: extraBatch.id,
            email_id: EMAIL_ID,
            contents: JSON.stringify(extraBatch.contents)
        });
    }

    await db.destroy();
}

function writePrivateKeyFile(filePath) {
    fs.writeFileSync(filePath, LEGACY_PROXY_PRIVATE_KEY.export({type: 'pkcs8', format: 'pem'}));
}

function runCli({args = ['--email-id', EMAIL_ID], env = {}} = {}) {
    return spawnSync(process.execPath, [SCRIPT_PATH, ...args], {
        encoding: 'utf8',
        env: {...process.env, ...env}
    });
}

describe('legacy partial-resume SES proxy attestation CLI', function () {
    it('prints only the JSON aggregate proof and signature for matching read-only fixtures', async function () {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-proxy-attest-'));
        const ghostDb = path.join(tmpDir, 'ghost.sqlite');
        const proxyDb = path.join(tmpDir, 'proxy.sqlite');
        const keyFile = path.join(tmpDir, 'ed25519.pem');
        await createGhostDb(ghostDb);
        await createProxyDb(proxyDb);
        writePrivateKeyFile(keyFile);

        const result = runCli({
            env: {
                GHOST_READONLY_DATABASE_URL: `${readOnlyUrl(ghostDb)}`,
                PROXY_READONLY_DATABASE_URL: `${readOnlyUrl(proxyDb)}`,
                PARTIAL_RESUME_PROOF_SIGNING_KEY_FILE: keyFile
            }
        });

        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stderr.trim(), '');
        assert.match(result.stdout, /^\{.*\}\n?$/s);
        const parsed = JSON.parse(result.stdout);
        assert.deepEqual(Object.keys(parsed).sort(), ['proof', 'signature']);
        assert.equal(typeof parsed.signature, 'string');
        assert.equal(typeof parsed.proof, 'object');
        assert.ok(!result.stdout.includes(ghostDb));
        assert.ok(!result.stdout.includes(proxyDb));
        assert.ok(!result.stdout.includes('SELECT'));
        assert.ok(!result.stdout.includes('recipient'));
        assert.ok(!result.stdout.includes('contents'));
        assert.ok(!result.stdout.includes('GHOST_READONLY_DATABASE_URL'));

        const verified = verifyLegacyProof({
            proof: parsed.proof,
            signature: parsed.signature,
            publicKey: LEGACY_PROXY_PUBLIC_KEY,
            now: new Date(parsed.proof.issued_at),
            maxAgeMs: 24 * 60 * 60 * 1000
        });
        assert.deepEqual(verified.payload, parsed.proof);
    });

    it('fails closed for malformed proxy contents, proxy/Ghost mismatches, extra batches, and incomplete events', async function () {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-proxy-attest-fail-'));
        const baseGhostDb = path.join(tmpDir, 'ghost.sqlite');
        const keyFile = path.join(tmpDir, 'ed25519.pem');
        await createGhostDb(baseGhostDb);
        writePrivateKeyFile(keyFile);

        const cases = [
            {
                name: 'malformed contents',
                proxyDbSetup: proxyDb => createProxyDb(proxyDb, {contentsByBatchId: {[BATCH_IDS[0]]: '{not json}'}}),
                expected: /contents|parse/i
            },
            {
                name: 'proxy input differs from sent',
                proxyDbSetup: proxyDb => createProxyDb(proxyDb, {
                    contentsByBatchId: {
                        [BATCH_IDS[0]]: {
                            provider_mode: 'email-id',
                            site_id: '64b000000000000000000099',
                            batch_id: BATCH_IDS[0],
                            input: [{batch_id: BATCH_IDS[0], member_id: MEMBER_IDS[0], member_email: MEMBER_EMAILS[0]}],
                            sent: [{batch_id: BATCH_IDS[0], member_id: MEMBER_IDS[1], member_email: MEMBER_EMAILS[1]}],
                            events: [{type: 'sent', created_at: '2026-08-16T14:11:39.200Z', payload: {batch_id: BATCH_IDS[0], member_id: MEMBER_IDS[0], member_email: MEMBER_EMAILS[0]}}]
                        }
                    }
                }),
                expected: /input|sent/i
            },
            {
                name: 'proxy recipient pairs differ from Ghost ledger',
                proxyDbSetup: proxyDb => createProxyDb(proxyDb, {
                    contentsByBatchId: {
                        [BATCH_IDS[0]]: proxyContents({
                            batchId: BATCH_IDS[0],
                            memberId: MEMBER_IDS[0],
                            memberEmail: MEMBER_EMAILS[1]
                        }),
                        [BATCH_IDS[1]]: proxyContents({
                            batchId: BATCH_IDS[1],
                            memberId: MEMBER_IDS[1],
                            memberEmail: MEMBER_EMAILS[0]
                        })
                    }
                }),
                expected: /pairs|ledger/i
            },
            {
                name: 'extra proxy batch',
                proxyDbSetup: proxyDb => createProxyDb(proxyDb, {
                    extraBatch: {
                        id: '64b000000000000000000004',
                        contents: {
                            provider_mode: 'email-id',
                            site_id: '64b000000000000000000099',
                            batch_id: '64b000000000000000000004',
                            input: [{batch_id: '64b000000000000000000004', member_id: '64b000000000000000000012', member_email: 'third@example.test'}],
                            sent: [{batch_id: '64b000000000000000000004', member_id: '64b000000000000000000012', member_email: 'third@example.test'}],
                            events: [{type: 'sent', created_at: '2026-08-16T14:11:39.200Z', payload: {batch_id: '64b000000000000000000004', member_id: '64b000000000000000000012', member_email: 'third@example.test'}}]
                        }
                    }
                }),
                expected: /batch|exact/i
            },
            {
                name: 'incomplete events',
                proxyDbSetup: proxyDb => createProxyDb(proxyDb, {
                    contentsByBatchId: {
                        [BATCH_IDS[1]]: {
                            provider_mode: 'email-id',
                            site_id: '64b000000000000000000099',
                            batch_id: BATCH_IDS[1],
                            input: [{batch_id: BATCH_IDS[1], member_id: MEMBER_IDS[1], member_email: MEMBER_EMAILS[1]}],
                            sent: [{batch_id: BATCH_IDS[1], member_id: MEMBER_IDS[1], member_email: MEMBER_EMAILS[1]}],
                            events: [{
                                type: 'sent',
                                created_at: '2026-08-16T14:11:39.200Z',
                                payload: {
                                    batch_id: BATCH_IDS[1],
                                    member_id: MEMBER_IDS[1],
                                    member_email: MEMBER_EMAILS[1]
                                }
                            }]
                        }
                    }
                }),
                expected: /accepted|sent|event|payload/i
            }
        ];

        for (const testCase of cases) {
            const proxyDb = path.join(tmpDir, `${testCase.name.replace(/[^a-z]+/gi, '-')}.sqlite`);
            await testCase.proxyDbSetup(proxyDb);
            const result = runCli({
                env: {
                    GHOST_READONLY_DATABASE_URL: `${new URL(`file://${baseGhostDb}`).href}?mode=ro`,
                    PROXY_READONLY_DATABASE_URL: `${readOnlyUrl(proxyDb)}`,
                    PARTIAL_RESUME_PROOF_SIGNING_KEY_FILE: keyFile
                }
            });

            assert.notEqual(result.status, 0, testCase.name);
            assert.equal(result.stdout.trim(), '', testCase.name);
            assert.match(result.stderr, testCase.expected, testCase.name);
        }
    });

    it('rejects missing args, non-read-only URLs, and invalid private keys before emitting a proof', async function () {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-proxy-attest-bad-'));
        const ghostDb = path.join(tmpDir, 'ghost.sqlite');
        const proxyDb = path.join(tmpDir, 'proxy.sqlite');
        const keyFile = path.join(tmpDir, 'ed25519.pem');
        await createGhostDb(ghostDb);
        await createProxyDb(proxyDb);
        writePrivateKeyFile(keyFile);

        const scenarios = [
            {args: [], env: {}, expected: /email-id|help/i},
            {
                args: ['--email-id', EMAIL_ID, '--unexpected'],
                env: {
                    GHOST_READONLY_DATABASE_URL: `${readOnlyUrl(ghostDb)}`,
                    PROXY_READONLY_DATABASE_URL: `${readOnlyUrl(proxyDb)}`,
                    PARTIAL_RESUME_PROOF_SIGNING_KEY_FILE: keyFile
                },
                expected: /unknown|unexpected/i
            },
            {
                args: ['--email-id', EMAIL_ID],
                env: {
                    GHOST_READONLY_DATABASE_URL: new URL(`file://${ghostDb}`).href,
                    PROXY_READONLY_DATABASE_URL: `${readOnlyUrl(proxyDb)}`,
                    PARTIAL_RESUME_PROOF_SIGNING_KEY_FILE: keyFile
                },
                expected: /read.?only/i
            },
            {
                args: ['--email-id', EMAIL_ID],
                env: {
                    GHOST_READONLY_DATABASE_URL: `${readOnlyUrl(ghostDb)}`,
                    PROXY_READONLY_DATABASE_URL: `${readOnlyUrl(proxyDb)}`,
                    PARTIAL_RESUME_PROOF_SIGNING_KEY_FILE: path.join(tmpDir, 'missing.pem')
                },
                expected: /key|file|private/i
            }
        ];

        for (const scenario of scenarios) {
            const result = runCli({args: scenario.args, env: scenario.env});
            assert.notEqual(result.status, 0);
            assert.equal(result.stdout.includes('proof'), false);
            assert.match(result.stderr, scenario.expected);
        }
    });

    it('documents the aggregate JSON output and read-only inputs without production hostnames', function () {
        const result = spawnSync(process.execPath, [SCRIPT_PATH, '--help'], {
            encoding: 'utf8'
        });

        assert.equal(result.status, 0, result.stderr);
        assert.ok(result.stdout.includes('{"proof":'));
        assert.ok(result.stdout.includes('"signature":'));
        assert.match(result.stdout, /GHOST_READONLY_DATABASE_URL/);
        assert.match(result.stdout, /PROXY_READONLY_DATABASE_URL/);
        assert.match(result.stdout, /PARTIAL_RESUME_PROOF_SIGNING_KEY_FILE/);
        assert.doesNotMatch(result.stdout, /ghost\.org|mailgun|production/i);
    });
});

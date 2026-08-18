#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import knex from 'knex';
import legacyProofHelpers from '../../core/server/services/email-service/legacy-partial-resume-proof.js';

const {
    canonicalizeLegacyProofPayload,
    hashStringList
} = legacyProofHelpers;

const REQUIRED_ENV_VARS = [
    'GHOST_READONLY_DATABASE_URL',
    'PROXY_READONLY_DATABASE_URL',
    'PARTIAL_RESUME_PROOF_SIGNING_KEY_FILE'
];
const LEGACY_PROXY_TRANSPORT = 'ses-proxy-mailgun-v1';
const EXPECTED_LEGACY_PROVIDER_MODE = 'email-id';
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const USAGE = `Usage:
  attest-legacy-ses-proxy.mjs --email-id <ghost-email-id>

Required env:
  GHOST_READONLY_DATABASE_URL
  PROXY_READONLY_DATABASE_URL
  PARTIAL_RESUME_PROOF_SIGNING_KEY_FILE

Output:
  stdout: JSON aggregate {"proof": <payload>, "signature": <base64url>}
  stderr: read-only validation or attestation errors only
`;

function fail(message) {
    throw new Error(`Legacy SES proxy attestation failed: ${message}`);
}

function printHelp() {
    process.stdout.write(USAGE);
}

function isCanonicalIso(value) {
    return typeof value === 'string' && Number.isFinite(new Date(value).getTime()) && new Date(value).toISOString() === value;
}

function assertCanonicalIso(value, name) {
    if (!isCanonicalIso(value)) {
        fail(`${name} must be a canonical ISO timestamp`);
    }
}

function assertNonEmptyString(value, name) {
    if (typeof value !== 'string' || value.length === 0) {
        fail(`${name} must be a non-empty string`);
    }
}

function assertObjectId(value, name) {
    if (typeof value !== 'string' || !/^[a-f0-9]{24}$/.test(value)) {
        fail(`${name} must be a Ghost ObjectId`);
    }
}

function assertHash(value, name) {
    if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
        fail(`${name} must be a lowercase SHA-256 hash`);
    }
}

function parseArgs(argv) {
    const args = argv.slice();
    if (args.length === 0) {
        fail('missing --email-id');
    }

    if (args.includes('--help') || args.includes('-h')) {
        if (args.length !== 1) {
            fail('help cannot be combined with other flags');
        }
        return {help: true};
    }

    let emailId;
    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index];
        if (arg === '--email-id') {
            if (emailId !== undefined) {
                fail('duplicate --email-id flag');
            }
            const next = args[++index];
            if (typeof next !== 'string' || next.startsWith('--')) {
                fail('--email-id requires a value');
            }
            emailId = next;
            continue;
        }
        if (arg.startsWith('--')) {
            fail(`unknown flag: ${arg}`);
        }
        fail(`unexpected positional argument: ${arg}`);
    }

    if (typeof emailId !== 'string' || emailId.length === 0) {
        fail('missing --email-id');
    }
    assertObjectId(emailId, '--email-id');
    return {help: false, emailId};
}

function parseReadonlyDatabaseUrl(rawUrl, name) {
    assertNonEmptyString(rawUrl, name);

    let url;
    try {
        url = new URL(rawUrl);
    } catch {
        fail(`${name} must be a valid file URL`);
    }

    if (url.protocol !== 'file:') {
        fail(`${name} must use the file: protocol`);
    }

    const mode = url.searchParams.get('mode');
    const readonly = url.searchParams.get('readonly');
    const immutable = url.searchParams.get('immutable');
    if (mode !== 'ro' && readonly !== 'true' && readonly !== '1' && immutable !== 'true' && immutable !== '1') {
        fail(`${name} must be read-only`);
    }
    if (mode && !['ro', 'readonly'].includes(mode)) {
        fail(`${name} must be read-only`);
    }

    url.search = '';
    url.hash = '';
    return url;
}

async function openReadonlySqliteDatabase(rawUrl, name) {
    const url = parseReadonlyDatabaseUrl(rawUrl, name);
    const filename = fileURLToPath(url);
    const db = knex({
        client: 'better-sqlite3',
        connection: {
            filename,
            readonly: true,
            fileMustExist: true
        },
        useNullAsDefault: true
    });

    try {
        await db.raw('select 1');
    } catch (error) {
        await db.destroy();
        throw error;
    }

    return db;
}

async function readPrivateKey(filePath) {
    assertNonEmptyString(filePath, 'PARTIAL_RESUME_PROOF_SIGNING_KEY_FILE');
    const contents = await fs.readFile(filePath, 'utf8').catch(() => fail('unable to read PARTIAL_RESUME_PROOF_SIGNING_KEY_FILE'));
    let keyObject;
    try {
        keyObject = crypto.createPrivateKey(contents);
    } catch {
        fail('PARTIAL_RESUME_PROOF_SIGNING_KEY_FILE must contain a valid private key');
    }
    if (keyObject.type !== 'private' || keyObject.asymmetricKeyType !== 'ed25519') {
        fail('PARTIAL_RESUME_PROOF_SIGNING_KEY_FILE must contain an Ed25519 private key');
    }
    return keyObject;
}

function normalizeRecipient(row, sourceName) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
        fail(`${sourceName} recipient rows must be objects`);
    }
    const {batch_id: batchId, member_id: memberId, member_email: memberEmail} = row;
    assertObjectId(batchId, `${sourceName}.batch_id`);
    assertObjectId(memberId, `${sourceName}.member_id`);
    assertNonEmptyString(memberEmail, `${sourceName}.member_email`);
    return {
        batch_id: batchId,
        member_id: memberId,
        member_email: memberEmail
    };
}

function normalizeEvent(event, sourceName, batchId, recipientSet) {
    if (!event || typeof event !== 'object' || Array.isArray(event)) {
        fail(`${sourceName} events must be objects`);
    }
    assertNonEmptyString(event.type, `${sourceName}.events.type`);
    assertCanonicalIso(event.created_at, `${sourceName}.events.created_at`);
    if (!event.payload || typeof event.payload !== 'object' || Array.isArray(event.payload)) {
        fail(`${sourceName}.events.payload must be an object`);
    }
    assertObjectId(event.payload.batch_id, `${sourceName}.events.payload.batch_id`);
    assertObjectId(event.payload.member_id, `${sourceName}.events.payload.member_id`);
    assertNonEmptyString(event.payload.member_email, `${sourceName}.events.payload.member_email`);
    const payloadKey = `${event.payload.batch_id}\u0000${event.payload.member_id}\u0000${event.payload.member_email}`;
    if (event.payload.batch_id !== batchId || !recipientSet.has(payloadKey)) {
        fail(`${sourceName}.events.payload does not match the proxy recipient set`);
    }
    return {
        type: event.type,
        created_at: event.created_at,
        payload: {
            batch_id: event.payload.batch_id,
            member_id: event.payload.member_id,
            member_email: event.payload.member_email
        }
    };
}

function parseProxyBatchContents(rawContents, row) {
    let contents;
    try {
        contents = JSON.parse(rawContents);
    } catch {
        fail('NewsletterBatch.contents must be parseable JSON');
    }

    if (!contents || typeof contents !== 'object' || Array.isArray(contents)) {
        fail('NewsletterBatch.contents must be a JSON object');
    }

    const expectedKeys = ['batch_id', 'events', 'input', 'provider_mode', 'sent', 'site_id'];
    const contentKeys = Object.keys(contents).sort();
    if (contentKeys.length !== expectedKeys.length || contentKeys.some((key, index) => key !== expectedKeys[index])) {
        fail('NewsletterBatch.contents contains unknown or missing fields');
    }

    assertObjectId(contents.batch_id, 'NewsletterBatch.contents.batch_id');
    assertObjectId(contents.site_id, 'NewsletterBatch.contents.site_id');
    if (contents.batch_id !== row.id) {
        fail('NewsletterBatch.contents.batch_id must match the batch row id');
    }
    if (contents.provider_mode !== EXPECTED_LEGACY_PROVIDER_MODE) {
        fail('NewsletterBatch.contents.provider_mode must be email-id');
    }
    if (!Array.isArray(contents.input) || !Array.isArray(contents.sent) || !Array.isArray(contents.events)) {
        fail('NewsletterBatch.contents input, sent, and events must be arrays');
    }
    if (contents.input.length === 0 || contents.sent.length === 0 || contents.events.length === 0) {
        fail('NewsletterBatch.contents must contain input, sent, and events evidence');
    }
    if (contents.input.length !== contents.sent.length) {
        fail('proxy input must equal proxy sent');
    }

    const input = contents.input.map(entry => normalizeRecipient(entry, 'NewsletterBatch.contents.input'));
    const sent = contents.sent.map(entry => normalizeRecipient(entry, 'NewsletterBatch.contents.sent'));
    const recipientSet = new Set(input.map(entry => `${entry.batch_id}\u0000${entry.member_id}\u0000${entry.member_email}`));
    if (recipientSet.size !== input.length) {
        fail('proxy input contains duplicate recipient identities');
    }
    for (let index = 0; index < input.length; index += 1) {
        if (input[index].batch_id !== row.id || sent[index].batch_id !== row.id) {
            fail('proxy batch entries must reference their own batch id');
        }
    }
    // A batch naturally contains many recipients, so batch IDs repeat within
    // an input/sent list. The identity set above (batch, member, email) is the
    // uniqueness boundary; reject only a list mismatch, not multiple rows for
    // the same batch.
    if (JSON.stringify(input) !== JSON.stringify(sent)) {
        fail('proxy input must equal proxy sent');
    }

    const events = contents.events.map(event => normalizeEvent(event, 'NewsletterBatch.contents', row.id, recipientSet));
    const eventTypesByRecipient = new Map();
    for (const event of events) {
        const key = `${event.payload.batch_id}\u0000${event.payload.member_id}\u0000${event.payload.member_email}`;
        const types = eventTypesByRecipient.get(key) || new Set();
        if (types.has(event.type)) {
            fail('NewsletterBatch.contents contains duplicate lifecycle events');
        }
        types.add(event.type);
        eventTypesByRecipient.set(key, types);
    }
    for (const recipientKey of recipientSet) {
        const types = eventTypesByRecipient.get(recipientKey);
        if (!types || types.size !== 2 || !types.has('accepted') || !types.has('sent')) {
            fail('NewsletterBatch.contents must contain accepted and sent evidence for every recipient');
        }
    }
    if (events.length !== recipientSet.size * 2) {
        fail('NewsletterBatch.contents contains unexpected lifecycle events');
    }

    return {
        batch_id: row.id,
        site_id: contents.site_id,
        input,
        sent,
        events
    };
}

async function loadGhostEvidence(db, emailId) {
    const email = await db('emails').select('id', 'status', 'partial_resume').where({id: emailId}).first();
    if (!email) {
        fail('Ghost email not found');
    }
    if (email.status !== 'submitted' || (email.partial_resume !== 0 && email.partial_resume !== false)) {
        fail('Ghost email must be a submitted non-partial row');
    }

    const batches = await db('email_batches')
        .select('id', 'email_id', 'provider_id', 'status')
        .where({email_id: emailId});
    if (!Array.isArray(batches) || batches.length !== 2) {
        fail('Ghost must expose exactly two legacy batches');
    }
    const seenBatchIds = new Set();
    for (const batch of batches) {
        if (!batch || typeof batch !== 'object' || Array.isArray(batch)) {
            fail('Ghost batch rows must be objects');
        }
        assertObjectId(batch.id, 'Ghost batch id');
        assertObjectId(batch.email_id, 'Ghost batch email_id');
        if (batch.email_id !== emailId || batch.status !== 'submitted' || batch.provider_id !== emailId) {
            fail('Ghost batches must be submitted and use the email-id provider mode');
        }
        if (seenBatchIds.has(batch.id)) {
            fail('Ghost batch ids must be unique');
        }
        seenBatchIds.add(batch.id);
    }

    const recipients = await db('email_recipients')
        .select('batch_id', 'member_id', 'member_email')
        .where({email_id: emailId});
    if (!Array.isArray(recipients) || recipients.length === 0) {
        fail('Ghost must expose recipient ledger rows');
    }

    const byBatch = new Map(batches.map(batch => [batch.id, []]));
    const memberIds = [];
    const memberEmails = [];
    const seenMembers = new Set();
    const seenEmails = new Set();
    for (const row of recipients) {
        if (!row || typeof row !== 'object' || Array.isArray(row)) {
            fail('Ghost recipient rows must be objects');
        }
        assertObjectId(row.batch_id, 'Ghost recipient batch_id');
        assertObjectId(row.member_id, 'Ghost recipient member_id');
        assertNonEmptyString(row.member_email, 'Ghost recipient member_email');
        const bucket = byBatch.get(row.batch_id);
        if (!bucket) {
            fail('Ghost recipient references an unknown batch');
        }
        if (seenMembers.has(row.member_id) || seenEmails.has(row.member_email)) {
            fail('Ghost recipient ledger contains duplicates');
        }
        seenMembers.add(row.member_id);
        seenEmails.add(row.member_email);
        memberIds.push(row.member_id);
        memberEmails.push(row.member_email);
        bucket.push({member_id: row.member_id, member_email: row.member_email});
    }

    for (const [batchId, recipientsForBatch] of byBatch.entries()) {
        if (recipientsForBatch.length === 0) {
            fail(`Ghost batch ${batchId} must have at least one recipient`);
        }
    }

    return {
        emailId,
        batches: batches.slice().sort((left, right) => left.id.localeCompare(right.id)),
        batchIds: batches.map(batch => batch.id).sort(),
        memberIds,
        memberEmails,
        recipientKeys: recipients.map(row => `${row.batch_id}\u0000${row.member_id}\u0000${row.member_email}`),
        recipients
    };
}

async function loadProxyEvidence(db, emailId, ghostBatchIds) {
    const rows = await db('NewsletterBatch')
        .select('id', 'email_id', 'contents')
        .where({email_id: emailId});
    if (!Array.isArray(rows) || rows.length !== 2) {
        fail('proxy must expose exactly two legacy batches');
    }

    const seenBatchIds = new Set();
    const siteIds = new Set();
    const parsedBatches = [];
    const proxyMemberIds = [];
    const proxyMemberEmails = [];
    const proxyRecipientKeys = [];
    for (const row of rows) {
        if (!row || typeof row !== 'object' || Array.isArray(row)) {
            fail('proxy batch rows must be objects');
        }
        assertObjectId(row.id, 'proxy batch id');
        assertObjectId(row.email_id, 'proxy batch email_id');
        assertNonEmptyString(row.contents, 'proxy batch contents');
        if (row.email_id !== emailId) {
            fail('proxy batches must belong to the requested email');
        }
        if (seenBatchIds.has(row.id)) {
            fail('proxy batch ids must be unique');
        }
        if (!ghostBatchIds.includes(row.id)) {
            fail('proxy batches must match the Ghost legacy batches exactly');
        }
        seenBatchIds.add(row.id);
        const parsed = parseProxyBatchContents(row.contents, row);
        parsedBatches.push(parsed);
        siteIds.add(parsed.site_id);
        for (const recipient of parsed.input) {
            proxyMemberIds.push(recipient.member_id);
            proxyMemberEmails.push(recipient.member_email);
            proxyRecipientKeys.push(`${recipient.batch_id}\u0000${recipient.member_id}\u0000${recipient.member_email}`);
        }
    }

    if (siteIds.size !== 1) {
        fail('proxy_site_count must be exactly one');
    }

    parsedBatches.sort((left, right) => left.batch_id.localeCompare(right.batch_id));
    const proxyBatchIds = parsedBatches.map(batch => batch.batch_id).sort();
    if (proxyBatchIds.length !== ghostBatchIds.length || proxyBatchIds.some((batchId, index) => batchId !== ghostBatchIds[index])) {
        fail('proxy batches must match the Ghost legacy batches exactly');
    }

    return {
        siteCount: siteIds.size,
        batches: parsedBatches,
        batchIds: proxyBatchIds,
        memberIds: proxyMemberIds,
        memberEmails: proxyMemberEmails,
        recipientKeys: proxyRecipientKeys
    };
}

function buildProofPayload({emailId, ghostEvidence, proxyEvidence}) {
    const sortedBatchIds = [...ghostEvidence.batchIds].sort();
    const ledgerMemberIds = [...ghostEvidence.memberIds];
    const ledgerMemberEmails = [...ghostEvidence.memberEmails];
    const proxyMemberIds = [...proxyEvidence.memberIds];
    const proxyMemberEmails = [...proxyEvidence.memberEmails];

    if (proxyEvidence.batchIds.length !== sortedBatchIds.length || proxyEvidence.batchIds.some((batchId, index) => batchId !== sortedBatchIds[index])) {
        fail('proxy batches must match the Ghost legacy batches exactly');
    }
    if (JSON.stringify([...ghostEvidence.recipientKeys].sort()) !== JSON.stringify([...proxyEvidence.recipientKeys].sort())) {
        fail('proxy recipient pairs must equal Ghost ledger');
    }
    if (JSON.stringify([...ledgerMemberIds].sort()) !== JSON.stringify([...proxyMemberIds].sort()) ||
        JSON.stringify([...ledgerMemberEmails].sort()) !== JSON.stringify([...proxyMemberEmails].sort())) {
        fail('Ghost ledger must equal proxy input');
    }
    if (JSON.stringify([...proxyMemberIds].sort()) !== JSON.stringify([...ghostEvidence.memberIds].sort()) ||
        JSON.stringify([...proxyMemberEmails].sort()) !== JSON.stringify([...ghostEvidence.memberEmails].sort())) {
        fail('proxy input must equal Ghost ledger');
    }
    if (proxyEvidence.siteCount !== 1) {
        fail('proxy_site_count must be exactly one');
    }

    const eventTimes = proxyEvidence.batches.flatMap(batch => batch.events.map(event => event.created_at));
    const proof = {
        version: 1,
        transport: LEGACY_PROXY_TRANSPORT,
        email_id: emailId,
        issued_at: new Date().toISOString(),
        legacy_batch_ids: sortedBatchIds,
        legacy_provider_id_mode: EXPECTED_LEGACY_PROVIDER_MODE,
        ledger_member_count: ledgerMemberIds.length,
        ledger_member_hash: hashStringList(ledgerMemberIds),
        ledger_email_count: ledgerMemberEmails.length,
        ledger_email_hash: hashStringList(ledgerMemberEmails),
        ledger_binding_hash: hashStringList(ghostEvidence.recipientKeys),
        // The signed v1 contract binds the proxy's input and sent recipient
        // identities to the Ghost email ledger; member IDs are reconciled
        // separately above and are not represented by these two v1 hashes.
        proxy_input_count: proxyMemberEmails.length,
        proxy_input_hash: hashStringList(proxyMemberEmails),
        proxy_sent_count: proxyMemberEmails.length,
        proxy_sent_hash: hashStringList(proxyMemberEmails),
        proxy_site_count: proxyEvidence.siteCount,
        proxy_batch_count: proxyEvidence.batchIds.length,
        proxy_first_created_at: eventTimes.reduce((earliest, timestamp) => earliest < timestamp ? earliest : timestamp),
        proxy_last_created_at: eventTimes.reduce((latest, timestamp) => latest > timestamp ? latest : timestamp)
    };

    return canonicalizeLegacyProofPayload(proof).payload;
}

async function runAttestation(argv) {
    const parsed = parseArgs(argv);
    if (parsed.help) {
        printHelp();
        return 0;
    }

    const missingEnv = REQUIRED_ENV_VARS.filter(name => !process.env[name] || process.env[name].length === 0);
    if (missingEnv.length > 0) {
        fail(`missing required env vars: ${missingEnv.join(', ')}`);
    }

    // Read and validate the key before creating either connection. If opening
    // the second database fails, the finally block below still releases the
    // first connection; failures must never leave an auditor process alive.
    const privateKey = await readPrivateKey(process.env.PARTIAL_RESUME_PROOF_SIGNING_KEY_FILE);
    let ghostDb;
    let proxyDb;

    try {
        ghostDb = await openReadonlySqliteDatabase(process.env.GHOST_READONLY_DATABASE_URL, 'GHOST_READONLY_DATABASE_URL');
        proxyDb = await openReadonlySqliteDatabase(process.env.PROXY_READONLY_DATABASE_URL, 'PROXY_READONLY_DATABASE_URL');
        const ghostEvidence = await loadGhostEvidence(ghostDb, parsed.emailId);
        const proxyEvidence = await loadProxyEvidence(proxyDb, parsed.emailId, ghostEvidence.batchIds);
        const proof = buildProofPayload({emailId: parsed.emailId, ghostEvidence, proxyEvidence});
        const {payload, payloadJson} = canonicalizeLegacyProofPayload(proof);
        const signature = crypto.sign(null, Buffer.from(payloadJson, 'utf8'), privateKey).toString('base64url');
        process.stdout.write(`${JSON.stringify({proof: payload, signature})}
`);
        return 0;
    } finally {
        await Promise.allSettled([
            ghostDb?.destroy(),
            proxyDb?.destroy()
        ]);
    }
}

export {
    buildProofPayload,
    loadGhostEvidence,
    loadProxyEvidence,
    openReadonlySqliteDatabase,
    parseArgs,
    parseProxyBatchContents,
    parseReadonlyDatabaseUrl,
    readPrivateKey,
    runAttestation
};

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
    runAttestation(process.argv.slice(2)).then((code) => {
        if (code && code !== 0) {
            process.exitCode = code;
        }
    }).catch((error) => {
        process.stderr.write(`${error.message || String(error)}\n`);
        process.exitCode = 1;
    });
}

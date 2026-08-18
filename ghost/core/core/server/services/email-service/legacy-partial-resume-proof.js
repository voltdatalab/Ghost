const crypto = require('node:crypto');
const errors = require('@tryghost/errors');

const LEGACY_PROXY_TRANSPORT = 'ses-proxy-mailgun-v1';
const PROOF_VERSION = 1;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const OBJECT_ID_PATTERN = /^[a-f0-9]{24}$/;
const BASE64URL_SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{86}$/;

const PROOF_FIELDS = [
    'version',
    'transport',
    'email_id',
    'issued_at',
    'legacy_batch_ids',
    'legacy_provider_id_mode',
    'ledger_member_count',
    'ledger_member_hash',
    'ledger_email_count',
    'ledger_email_hash',
    'ledger_binding_hash',
    'proxy_input_count',
    'proxy_input_hash',
    'proxy_sent_count',
    'proxy_sent_hash',
    'proxy_site_count',
    'proxy_batch_count',
    'proxy_first_created_at',
    'proxy_last_created_at'
];

/**
 * @typedef {object} LegacyProofPayload
 * @property {number} version
 * @property {string} transport
 * @property {string} email_id
 * @property {string} issued_at
 * @property {string[]} legacy_batch_ids
 * @property {string} legacy_provider_id_mode
 * @property {number} ledger_member_count
 * @property {string} ledger_member_hash
 * @property {number} ledger_email_count
 * @property {string} ledger_email_hash
 * @property {string} ledger_binding_hash
 * @property {number} proxy_input_count
 * @property {string} proxy_input_hash
 * @property {number} proxy_sent_count
 * @property {string} proxy_sent_hash
 * @property {number} proxy_site_count
 * @property {number} proxy_batch_count
 * @property {string} proxy_first_created_at
 * @property {string} proxy_last_created_at
 */

/** @param {string} reason @returns {never} */
function fail(reason) {
    throw new errors.BadRequestError({
        message: `Invalid legacy partial-resume proof: ${reason}`
    });
}

/** @param {string} value @returns {string} */
function sha256(value) {
    return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

/** @param {unknown} value @param {string} name */
function assertObjectId(value, name) {
    if (typeof value !== 'string' || !OBJECT_ID_PATTERN.test(value)) {
        fail(`${name} must be a Ghost ObjectId`);
    }
}

/** @param {unknown} value @param {string} name */
function assertHash(value, name) {
    if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
        fail(`${name} must be a lowercase SHA-256 hash`);
    }
}

/** @param {unknown} value @param {string} name */
function assertPositiveInteger(value, name) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
        fail(`${name} must be a positive safe integer`);
    }
}

/** @param {unknown} value @param {string} name @returns {Date} */
function parseCanonicalIso(value, name) {
    if (typeof value !== 'string') {
        fail(`${name} must be an ISO timestamp`);
    }

    const timestamp = new Date(value);
    if (!Number.isFinite(timestamp.getTime()) || timestamp.toISOString() !== value) {
        fail(`${name} must be a canonical UTC ISO timestamp`);
    }
    return timestamp;
}

/**
 * Hashes a sorted, unique list without transforming its identity values.
 * Callers are responsible for their own recipient canonicalization before this
 * boundary, which prevents email address semantics leaking into this module.
 *
 * @param {unknown} values
 * @returns {string}
 */
function hashStringList(values) {
    if (!Array.isArray(values) || values.length === 0) {
        fail('identity list must contain non-empty strings');
    }
    for (let index = 0; index < values.length; index += 1) {
        if (!Object.hasOwn(values, index) || typeof values[index] !== 'string' || values[index].length === 0) {
            fail('identity list must contain non-empty strings');
        }
    }

    const sorted = [...values].sort();
    if (new Set(sorted).size !== sorted.length) {
        fail('identity list contains duplicate values');
    }

    return sha256(sorted.join('\n'));
}

/**
 * Strictly normalizes a signed proof into a fixed key order. No recipient,
 * rendered body, provider payload, endpoint, or unknown metadata can cross
 * this boundary and become part of the persisted proof.
 *
 * @param {unknown} proof
 * @returns {{payload: LegacyProofPayload, payloadJson: string}}
 */
function canonicalizeLegacyProofPayload(proof) {
    if (!proof || typeof proof !== 'object' || Array.isArray(proof)) {
        fail('proof must be an object');
    }

    /** @type {LegacyProofPayload} */
    const candidate = /** @type {LegacyProofPayload} */ (proof);
    const proofKeys = Object.keys(candidate).sort();
    const expectedKeys = [...PROOF_FIELDS].sort();
    if (proofKeys.length !== expectedKeys.length || proofKeys.some((key, index) => key !== expectedKeys[index])) {
        fail('proof contains unknown or missing fields');
    }

    if (candidate.version !== PROOF_VERSION) {
        fail(`version must be ${PROOF_VERSION}`);
    }
    if (candidate.transport !== LEGACY_PROXY_TRANSPORT) {
        fail(`transport must be ${LEGACY_PROXY_TRANSPORT}`);
    }
    if (candidate.legacy_provider_id_mode !== 'email-id') {
        fail('legacy_provider_id_mode must be email-id');
    }

    assertObjectId(candidate.email_id, 'email_id');
    if (!Array.isArray(candidate.legacy_batch_ids) || candidate.legacy_batch_ids.length !== 2) {
        fail('legacy_batch_ids must contain exactly two ids');
    }
    for (let index = 0; index < candidate.legacy_batch_ids.length; index += 1) {
        if (!Object.hasOwn(candidate.legacy_batch_ids, index)) {
            fail(`legacy_batch_ids[${index}] must be a Ghost ObjectId`);
        }
        assertObjectId(candidate.legacy_batch_ids[index], `legacy_batch_ids[${index}]`);
    }

    const sortedBatchIds = [...candidate.legacy_batch_ids].sort();
    if (new Set(sortedBatchIds).size !== sortedBatchIds.length) {
        fail('legacy_batch_ids must be unique');
    }
    if (sortedBatchIds.some((id, index) => id !== candidate.legacy_batch_ids[index])) {
        fail('legacy_batch_ids must use canonical order');
    }

    const issuedAt = parseCanonicalIso(candidate.issued_at, 'issued_at');
    const firstCreatedAt = parseCanonicalIso(candidate.proxy_first_created_at, 'proxy_first_created_at');
    const lastCreatedAt = parseCanonicalIso(candidate.proxy_last_created_at, 'proxy_last_created_at');
    if (firstCreatedAt > lastCreatedAt) {
        fail('proxy creation range is inverted');
    }
    if (issuedAt <= lastCreatedAt) {
        fail('issued_at must be strictly after the proxy evidence');
    }

    assertPositiveInteger(candidate.ledger_member_count, 'ledger_member_count');
    assertPositiveInteger(candidate.ledger_email_count, 'ledger_email_count');
    assertPositiveInteger(candidate.proxy_input_count, 'proxy_input_count');
    assertPositiveInteger(candidate.proxy_sent_count, 'proxy_sent_count');
    assertPositiveInteger(candidate.proxy_site_count, 'proxy_site_count');
    assertPositiveInteger(candidate.proxy_batch_count, 'proxy_batch_count');
    assertHash(candidate.ledger_member_hash, 'ledger_member_hash');
    assertHash(candidate.ledger_email_hash, 'ledger_email_hash');
    assertHash(candidate.ledger_binding_hash, 'ledger_binding_hash');
    assertHash(candidate.proxy_input_hash, 'proxy_input_hash');
    assertHash(candidate.proxy_sent_hash, 'proxy_sent_hash');

    if (candidate.proxy_site_count !== 1) {
        fail('proxy_site_count must be exactly one');
    }
    if (candidate.proxy_batch_count !== candidate.legacy_batch_ids.length) {
        fail('proxy_batch_count must equal legacy_batch_ids length');
    }
    if (candidate.ledger_member_count !== candidate.ledger_email_count ||
        candidate.ledger_email_count !== candidate.proxy_input_count ||
        candidate.proxy_input_count !== candidate.proxy_sent_count) {
        fail('recipient counts do not prove the same prefix');
    }
    if (candidate.ledger_email_hash !== candidate.proxy_input_hash ||
        candidate.proxy_input_hash !== candidate.proxy_sent_hash) {
        fail('recipient hashes do not prove the same prefix');
    }

    /** @type {LegacyProofPayload} */
    const payload = {
        version: candidate.version,
        transport: candidate.transport,
        email_id: candidate.email_id,
        issued_at: candidate.issued_at,
        legacy_batch_ids: [...candidate.legacy_batch_ids],
        legacy_provider_id_mode: candidate.legacy_provider_id_mode,
        ledger_member_count: candidate.ledger_member_count,
        ledger_member_hash: candidate.ledger_member_hash,
        ledger_email_count: candidate.ledger_email_count,
        ledger_email_hash: candidate.ledger_email_hash,
        ledger_binding_hash: candidate.ledger_binding_hash,
        proxy_input_count: candidate.proxy_input_count,
        proxy_input_hash: candidate.proxy_input_hash,
        proxy_sent_count: candidate.proxy_sent_count,
        proxy_sent_hash: candidate.proxy_sent_hash,
        proxy_site_count: candidate.proxy_site_count,
        proxy_batch_count: candidate.proxy_batch_count,
        proxy_first_created_at: candidate.proxy_first_created_at,
        proxy_last_created_at: candidate.proxy_last_created_at
    };

    return {
        payload,
        payloadJson: JSON.stringify(payload)
    };
}

/**
 * @param {{proof: unknown, signature: string, publicKey: unknown, now: Date, maxAgeMs: number}} data
 * @returns {{payload: LegacyProofPayload, payloadJson: string, signingKeyFingerprint: string}}
 */
function verifyLegacyProof({proof, signature, publicKey, now, maxAgeMs}) {
    const {payload, payloadJson} = canonicalizeLegacyProofPayload(proof);

    if (typeof signature !== 'string' || !BASE64URL_SIGNATURE_PATTERN.test(signature)) {
        fail('signature must be an Ed25519 base64url signature');
    }
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
        fail('now must be a valid Date');
    }
    if (!Number.isSafeInteger(maxAgeMs) || maxAgeMs <= 0) {
        fail('maxAgeMs must be a positive safe integer');
    }

    const issuedAt = new Date(payload.issued_at);
    if (issuedAt.getTime() > now.getTime()) {
        fail('issued_at is in the future');
    }
    if (now.getTime() - issuedAt.getTime() > maxAgeMs) {
        fail('proof is stale');
    }

    /** @type {crypto.KeyObject} */
    let verifier;
    /** @type {Buffer} */
    let signatureBytes;
    if (typeof publicKey !== 'string' && !Buffer.isBuffer(publicKey) && !(publicKey instanceof crypto.KeyObject)) {
        fail('public key is malformed');
    }

    if (publicKey instanceof crypto.KeyObject) {
        verifier = publicKey;
    } else {
        /** @type {crypto.KeyObject|undefined} */
        let suppliedPrivateKey;
        try {
            suppliedPrivateKey = crypto.createPrivateKey(publicKey);
        } catch {
            // Not private key material; validate it as a public key below.
        }
        if (suppliedPrivateKey?.type === 'private') {
            fail('public key must not contain private material');
        }

        try {
            verifier = crypto.createPublicKey(publicKey);
        } catch {
            fail('public key is malformed');
        }
    }
    if (verifier.type !== 'public' || verifier.asymmetricKeyType !== 'ed25519') {
        fail('public key must be public Ed25519');
    }

    try {
        signatureBytes = Buffer.from(signature, 'base64url');
    } catch {
        fail('signature is malformed');
    }
    if (signatureBytes.length !== 64) {
        fail('signature must have Ed25519 length');
    }

    let valid = false;
    try {
        valid = crypto.verify(null, Buffer.from(payloadJson, 'utf8'), verifier, signatureBytes);
    } catch {
        fail('signature verification failed');
    }
    if (!valid) {
        fail('signature does not verify the canonical proof');
    }

    const spki = verifier.export({type: 'spki', format: 'der'});
    return {
        payload,
        payloadJson,
        signingKeyFingerprint: crypto.createHash('sha256').update(spki).digest('hex')
    };
}

module.exports = {
    LEGACY_PROXY_TRANSPORT,
    PROOF_VERSION,
    canonicalizeLegacyProofPayload,
    hashStringList,
    verifyLegacyProof
};

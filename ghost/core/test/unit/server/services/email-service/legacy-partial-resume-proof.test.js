const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
    LEGACY_PROXY_TRANSPORT,
    PROOF_VERSION,
    canonicalizeLegacyProofPayload,
    hashStringList,
    verifyLegacyProof
} = require('../../../../../core/server/services/email-service/legacy-partial-resume-proof');

const EMAIL_ID = '64b000000000000000000001';
const BATCH_IDS = [
    '64b000000000000000000002',
    '64b000000000000000000003'
];
const ISSUED_AT = '2026-08-17T22:20:00.000Z';

function sha256(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}

function createPayload(overrides = {}) {
    return {
        version: 1,
        transport: 'ses-proxy-mailgun-v1',
        email_id: EMAIL_ID,
        issued_at: ISSUED_AT,
        legacy_batch_ids: BATCH_IDS,
        legacy_provider_id_mode: 'email-id',
        ledger_member_count: 2,
        ledger_member_hash: sha256('member-1\nmember-2'),
        ledger_email_count: 2,
        ledger_email_hash: sha256('member-1@example.test\nmember-2@example.test'),
        ledger_binding_hash: sha256(`${BATCH_IDS[0]}\u0000member-1\u0000member-1@example.test\n${BATCH_IDS[1]}\u0000member-2\u0000member-2@example.test`),
        proxy_input_count: 2,
        proxy_input_hash: sha256('member-1@example.test\nmember-2@example.test'),
        proxy_sent_count: 2,
        proxy_sent_hash: sha256('member-1@example.test\nmember-2@example.test'),
        proxy_site_count: 1,
        proxy_batch_count: 2,
        proxy_first_created_at: '2026-08-16T14:11:39.071Z',
        proxy_last_created_at: '2026-08-16T14:11:39.343Z',
        ...overrides
    };
}

function sign(payload, privateKey) {
    return crypto.sign(null, Buffer.from(JSON.stringify(payload), 'utf8'), privateKey).toString('base64url');
}

describe('LegacyPartialResumeProof', function () {
    /** @type {crypto.KeyObject} */
    let privateKey;
    /** @type {string} */
    let publicKey;

    beforeEach(function () {
        const keys = crypto.generateKeyPairSync('ed25519');
        privateKey = keys.privateKey;
        publicKey = keys.publicKey.export({type: 'spki', format: 'pem'});
    });

    it('verifies a strict, signed SES-proxy proof and fingerprints the verifier key', function () {
        const payload = createPayload();
        const result = verifyLegacyProof({
            proof: payload,
            signature: sign(payload, privateKey),
            publicKey,
            now: new Date('2026-08-17T22:21:00.000Z'),
            maxAgeMs: 5 * 60 * 1000
        });

        assert.equal(LEGACY_PROXY_TRANSPORT, 'ses-proxy-mailgun-v1');
        assert.equal(PROOF_VERSION, 1);
        assert.deepEqual(result.payload, payload);
        assert.equal(result.payloadJson, JSON.stringify(payload));
        assert.deepEqual(Object.keys(result).sort(), ['payload', 'payloadJson', 'signingKeyFingerprint']);
        assert.match(result.signingKeyFingerprint, /^[a-f0-9]{64}$/);
    });

    it('verifies the fixed canonical payload regardless of input property insertion order', function () {
        const canonicalPayload = createPayload();
        const reorderedPayload = Object.fromEntries([...Object.entries(canonicalPayload)].reverse());
        const result = verifyLegacyProof({
            proof: reorderedPayload,
            signature: sign(canonicalPayload, privateKey),
            publicKey,
            now: new Date('2026-08-17T22:21:00.000Z'),
            maxAgeMs: 5 * 60 * 1000
        });

        assert.notEqual(JSON.stringify(reorderedPayload), JSON.stringify(canonicalPayload));
        assert.deepEqual(result.payload, canonicalPayload);
        assert.equal(result.payloadJson, JSON.stringify(canonicalPayload));
    });

    it('rejects a signature that no longer matches the canonical proof', function () {
        const payload = createPayload();
        const signature = sign(payload, privateKey);
        payload.proxy_sent_count = 3;

        assert.throws(() => verifyLegacyProof({
            proof: payload,
            signature,
            publicKey,
            now: new Date('2026-08-17T22:21:00.000Z'),
            maxAgeMs: 5 * 60 * 1000
        }), /signature|proof/i);
    });

    it('rejects unknown, recipient-bearing, content-bearing, and secret-bearing payload fields', function () {
        const payload = createPayload({recipient: 'member@example.test'});
        const missingOperationalField = Object.fromEntries(Object.entries(createPayload()).filter(([key]) => key !== 'proxy_site_count'));

        assert.throws(() => canonicalizeLegacyProofPayload(payload), /unknown|recipient|proof/i);
        assert.throws(() => canonicalizeLegacyProofPayload(missingOperationalField), /unknown|missing|proof/i);
        for (const forbiddenField of ['html', 'subject', 'storage_url', 'secret']) {
            assert.throws(() => canonicalizeLegacyProofPayload(createPayload({[forbiddenField]: 'redacted'})), /unknown|proof/i);
        }
    });

    it('rejects malformed verifier material and malformed base64url signatures', function () {
        const payload = createPayload();

        assert.throws(() => verifyLegacyProof({
            proof: payload,
            signature: 'not-a-base64url-signature!',
            publicKey,
            now: new Date('2026-08-17T22:21:00.000Z'),
            maxAgeMs: 5 * 60 * 1000
        }), /signature/i);
        assert.throws(() => verifyLegacyProof({
            proof: payload,
            signature: sign(payload, privateKey),
            publicKey: 'not-a-public-key',
            now: new Date('2026-08-17T22:21:00.000Z'),
            maxAgeMs: 5 * 60 * 1000
        }), /public key/i);
        assert.throws(() => verifyLegacyProof({
            proof: payload,
            signature: sign(payload, privateKey),
            publicKey: undefined,
            now: new Date('2026-08-17T22:21:00.000Z'),
            maxAgeMs: 5 * 60 * 1000
        }), /public key/i);
    });

    it('rejects invalid proof identity, mode, count, and timestamp fields', function () {
        assert.throws(() => canonicalizeLegacyProofPayload(createPayload({email_id: 'not-an-object-id'})), /email_id/i);
        assert.throws(() => canonicalizeLegacyProofPayload(createPayload({legacy_provider_id_mode: 'provider-id'})), /provider/i);
        assert.throws(() => canonicalizeLegacyProofPayload(createPayload({ledger_member_count: 0})), /count/i);
        assert.throws(() => canonicalizeLegacyProofPayload(createPayload({issued_at: '2026-08-17T22:20:00Z'})), /timestamp/i);
    });

    it('requires issued_at to be strictly after the last proxy evidence timestamp', function () {
        assert.throws(() => canonicalizeLegacyProofPayload(createPayload({
            issued_at: '2026-08-16T14:11:39.343Z'
        })), /issued|after|evidence/i);
    });

    it('requires canonical ordering, dense unique legacy batch ids, matched proxy sets, and a supported transport', function () {
        const sparseBatchIds = new Array(2);
        sparseBatchIds[0] = BATCH_IDS[0];

        assert.throws(() => canonicalizeLegacyProofPayload(createPayload({
            legacy_batch_ids: [...BATCH_IDS].reverse()
        })), /batch|canonical|order/i);
        assert.throws(() => canonicalizeLegacyProofPayload(createPayload({
            legacy_batch_ids: [BATCH_IDS[0], BATCH_IDS[0]]
        })), /batch|duplicate|unique/i);
        assert.throws(() => canonicalizeLegacyProofPayload(createPayload({
            legacy_batch_ids: sparseBatchIds
        })), /batch|ObjectId|id/i);
        assert.throws(() => canonicalizeLegacyProofPayload(createPayload({
            legacy_batch_ids: [BATCH_IDS[0]],
            proxy_batch_count: 1
        })), /exactly two|batch/i);
        assert.throws(() => canonicalizeLegacyProofPayload(createPayload({
            legacy_batch_ids: [...BATCH_IDS, '64b000000000000000000004'],
            proxy_batch_count: 3
        })), /exactly two|batch/i);
        assert.throws(() => canonicalizeLegacyProofPayload(createPayload({
            proxy_site_count: 2
        })), /site/i);
        assert.throws(() => canonicalizeLegacyProofPayload(createPayload({
            proxy_batch_count: 1
        })), /batch/i);
        assert.throws(() => canonicalizeLegacyProofPayload(createPayload({
            proxy_sent_hash: sha256('different')
        })), /proxy|hash|match/i);
        assert.throws(() => canonicalizeLegacyProofPayload(createPayload({
            transport: 'generic-mailgun'
        })), /transport/i);
    });

    it('rejects future and stale proofs before attempting a signature result', function () {
        const future = createPayload({issued_at: '2026-08-17T22:26:00.000Z'});
        assert.throws(() => verifyLegacyProof({
            proof: future,
            signature: sign(future, privateKey),
            publicKey,
            now: new Date('2026-08-17T22:21:00.000Z'),
            maxAgeMs: 5 * 60 * 1000
        }), /future|issued|proof/i);

        const stale = createPayload({issued_at: '2026-08-17T22:00:00.000Z'});
        assert.throws(() => verifyLegacyProof({
            proof: stale,
            signature: sign(stale, privateKey),
            publicKey,
            now: new Date('2026-08-17T22:21:00.000Z'),
            maxAgeMs: 5 * 60 * 1000
        }), /stale|expired|issued|proof/i);
    });

    it('rejects a non-Ed25519 verifier before signature evaluation', function () {
        const rsaKeys = crypto.generateKeyPairSync('rsa', {modulusLength: 2048});
        const signature = Buffer.alloc(64).toString('base64url');

        assert.throws(() => verifyLegacyProof({
            proof: createPayload(),
            signature,
            publicKey: rsaKeys.publicKey.export({type: 'spki', format: 'pem'}),
            now: new Date('2026-08-17T22:21:00.000Z'),
            maxAgeMs: 5 * 60 * 1000
        }), /Ed25519/i);
    });

    it('rejects an Ed25519 private KeyObject in the public verifier slot', function () {
        const payload = createPayload();

        assert.throws(() => verifyLegacyProof({
            proof: payload,
            signature: sign(payload, privateKey),
            publicKey: privateKey,
            now: new Date('2026-08-17T22:21:00.000Z'),
            maxAgeMs: 5 * 60 * 1000
        }), /public Ed25519/i);
    });

    it('rejects private PEM and DER material even if Node can derive a public verifier', function () {
        const payload = createPayload();
        const privatePem = privateKey.export({type: 'pkcs8', format: 'pem'});
        const privateDer = privateKey.export({type: 'pkcs8', format: 'der'});

        for (const privateMaterial of [privatePem, privateDer]) {
            assert.throws(() => verifyLegacyProof({
                proof: payload,
                signature: sign(payload, privateKey),
                publicKey: privateMaterial,
                now: new Date('2026-08-17T22:21:00.000Z'),
                maxAgeMs: 5 * 60 * 1000
            }), /private material|public key/i);
        }
    });

    it('hashes sorted unique values and rejects invalid identity input', function () {
        const sparseTrailingHole = new Array(2);
        sparseTrailingHole[0] = 'member-1';
        const holeOnly = new Array(1);

        assert.equal(hashStringList(['member-2', 'member-1']), sha256('member-1\nmember-2'));
        assert.throws(() => hashStringList([]), /non-empty|identity list/i);
        assert.throws(() => hashStringList(['member-1', 1]), /non-empty|identity list/i);
        assert.throws(() => hashStringList(sparseTrailingHole), /non-empty|identity list/i);
        assert.throws(() => hashStringList(holeOnly), /non-empty|identity list/i);
        assert.throws(() => hashStringList(['member-1', 'member-1']), /duplicate|unique/i);
    });
});

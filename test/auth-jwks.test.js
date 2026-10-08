'use strict';
/**
 * The Network signing key is fetched and verified through openvibe-sdk/auth (plan T0/T1). The
 * SDK keeps one client per URL: the last good keys through outages, exponential backoff, a
 * rotation honoured at once, unknown-kid floods throttled. Actor is a thin shim around it: the
 *   boot reads the key and verifies a session/app token against the URL,
 *   a JWKS outage with cached keys still verifies,
 *   readiness (network_jwks) shows the cache state.
 */
const assert = require('assert');
const crypto = require('crypto');
const http = require('http');
const { boot, check, done } = require('./helpers/boot');

function jwksServer({ doc = null, fail = null } = {}) {
    const seen = [];
    const srv = http.createServer((req, res) => {
        seen.push(req.url);
        if (fail) { res.writeHead(503); return res.end('down'); }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(doc));
    });
    return new Promise((resolve) => {
        srv.listen(0, '127.0.0.1', () => resolve({
            url: `http://127.0.0.1:${srv.address().port}`,
            close: () => new Promise((r) => srv.close(r)),
            seen,
            setDoc: (d) => { doc = d; },
            setFail: (f) => { fail = f; },
        }));
    });
}

function signJwt(claims, privateKey, { kid = null } = {}) {
    const header = { alg: 'RS256', typ: 'JWT', ...(kid ? { kid } : {}) };
    const input = `${Buffer.from(JSON.stringify(header)).toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}`;
    return `${input}.${crypto.sign('RSA-SHA256', Buffer.from(input), privateKey).toString('base64url')}`;
}

function pem(k) { return k.export({ type: 'spki', format: 'pem' }); }
function jwk(k, kid) { return { ...k.export({ format: 'jwk' }), use: 'sig', alg: 'RS256', kid }; }

(async () => {
    await check('a token signed by a key from a stub JWKS verifies', async () => {
        const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
        const jwks = await jwksServer({ doc: { keys: [jwk(publicKey, 'k1')] } });
        const { createKeyStore, jwksUrl } = require('../server/auth/keys');
        const config = { networkInternalUrl: jwks.url, networkUrl: jwks.url, networkIssuer: 'https://openvibe.network' };
        const keys = createKeyStore({ config, log: console });
        const url = jwksUrl(config);
        await keys.ensure();
        const now = Math.floor(Date.now() / 1000);
        const token = signJwt({ iss: config.networkIssuer, sub: 'usr_demo', username: 'demo', aud: ['openvibe.network'], iat: now, exp: now + 300 }, privateKey, { kid: 'k1' });
        const v = await keys.verifyUser(token, { issuer: config.networkIssuer, audience: 'openvibe.network' });
        assert.strictEqual(v.ok, true, `verify should succeed: ${v.reason || ''}`);
        assert.strictEqual(v.claims.username, 'demo');
        assert.ok(keys.get(), 'the cached PEM is exposed to the contracts guard');
        assert.deepStrictEqual(jwks.seen, ['/api/.well-known/jwks']);
        await jwks.close();
    });

    // A rotation publishes two keys: verification must use the one the token names, not the first.
    await check('service tokens get the key their kid names (a rotation keeps two keys)', async () => {
        const a = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
        const b = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
        const jwks = await jwksServer({ doc: { keys: [jwk(a.publicKey, 'old'), jwk(b.publicKey, 'new')] } });
        const { createKeyStore } = require('../server/auth/keys');
        const config = { networkInternalUrl: jwks.url, networkUrl: jwks.url, networkIssuer: 'https://openvibe.network' };
        const keys = createKeyStore({ config, log: { warn() {}, info() {} } });
        const now = Math.floor(Date.now() / 1000);
        const claims = { iss: config.networkIssuer, sub: 'app:x', aud: ['openvibe.actor'], iat: now, exp: now + 300 };
        assert.strictEqual(await keys.pemForToken(signJwt(claims, b.privateKey, { kid: 'new' })), pem(b.publicKey), 'the new key for a token signed with it');
        assert.strictEqual(await keys.pemForToken(signJwt(claims, a.privateKey, { kid: 'old' })), pem(a.publicKey));
        assert.strictEqual(await keys.pemForToken(signJwt(claims, a.privateKey)), pem(a.publicKey), 'no kid: the first key');
        assert.strictEqual(await keys.pemForToken('garbage'), pem(a.publicKey), 'an undecodable header falls back to the first key (the guard refuses the token)');
        await jwks.close();
    });

    await check('with keys cached, a JWKS outage still verifies (the last good keys)', async () => {
        const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
        const jwks = await jwksServer({ doc: { keys: [jwk(publicKey, 'k1')] } });
        const { createKeyStore } = require('../server/auth/keys');
        const config = { networkInternalUrl: jwks.url, networkUrl: jwks.url, networkIssuer: 'https://openvibe.network' };
        const keys = createKeyStore({ config, log: console });
        await keys.ensure();
        const before = jwks.seen.length;
        jwks.setFail(true);   // Network goes away
        const now = Math.floor(Date.now() / 1000);
        const token = signJwt({ iss: config.networkIssuer, sub: 'usr_demo', username: 'demo', aud: ['openvibe.network'], iat: now, exp: now + 300 }, privateKey, { kid: 'k1' });
        const v = await keys.verifyUser(token, { issuer: config.networkIssuer, audience: 'openvibe.network' });
        assert.strictEqual(v.ok, true, `outage should not break verification: ${v.reason || ''}`);
        assert.strictEqual(jwks.seen.length, before, 'no new fetch during the outage');
        await jwks.close();
    });

    await check('readiness (network_jwks) shows the SDK JWKS state', async () => {
        const t = await boot();
        const r = await t.get('/api/ready');
        const b = r.json();
        assert.strictEqual(b.checks.network_jwks.status, 'ok', `readiness JWKS not ok: ${JSON.stringify(b.checks.network_jwks)}`);
        assert.ok(b.checks.network_jwks.detail && b.checks.network_jwks.detail.keys >= 1, `detail.keys should be >= 1: ${JSON.stringify(b.checks.network_jwks.detail)}`);
        assert.strictEqual(b.checks.network_jwks.detail.failures, 0);
        await t.close();
    });

    await check('an unreachable JWKS never names the URL or the fetch error (503, /api/ready)', async () => {
        // Port 9 (discard) refuses instantly: the SDK's message is "JWKS http://127.0.0.1:9/…: connect ECONNREFUSED".
        const { createKeyStore } = require('../server/auth/keys');
        const config = { networkInternalUrl: 'http://127.0.0.1:9', networkUrl: 'http://127.0.0.1:9', networkIssuer: 'https://openvibe.network' };
        const keys = createKeyStore({ config, log: { warn() {}, log() {}, info() {}, error() {} } });
        await keys.ensure();
        const now = Math.floor(Date.now() / 1000);
        const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
        const token = signJwt({ iss: config.networkIssuer, sub: 'usr_demo', aud: ['openvibe.network'], iat: now, exp: now + 300 }, privateKey);
        const v = await keys.verifyUser(token, { issuer: config.networkIssuer, audience: 'openvibe.network' });
        assert.strictEqual(v.ok, false);
        assert.strictEqual(v.code, 'token.no_key', `the failure is token.no_key: ${v.code}`);
        assert.strictEqual(v.reason, 'signing key not loaded yet', 'a fixed public reason, not the SDK text');
        assert.ok(!/127\.0\.0\.1|jwks|ECONNREFUSED|fetch failed/i.test(v.reason), `reason leaks: ${v.reason}`);

        // The same unreachable JWKS behind a booted Actor: neither sign-in nor /api/ready names it.
        const t = await boot({ env: { OV_NETWORK_INTERNAL_URL: 'http://127.0.0.1:9', OV_NETWORK_URL: 'http://127.0.0.1:9' } });
        const ready = await t.get('/api/ready');
        const readyText = ready.text;
        assert.ok(!/127\.0\.0\.1|\.well-known\/jwks|ECONNREFUSED|fetch failed/i.test(readyText),
            `/api/ready leaks the JWKS URL or the fetch error: ${readyText.slice(0, 400)}`);
        const me = await t.get('/auth/me', { cookie: `actor_at=${token}` });
        assert.strictEqual(me.status, 401, `an unverifiable session token is 401: ${me.status} ${me.text.slice(0, 200)}`);
        assert.ok(!/127\.0\.0\.1|\.well-known\/jwks|ECONNREFUSED|fetch failed/i.test(me.text),
            `the sign-in answer leaks the JWKS URL or the fetch error: ${me.text.slice(0, 300)}`);
        await t.close();
    });

    await check('an expired session token starts no session (the SDK takes the clock as a number)', async () => {
        const t = await boot();
        const u = t.network.addUser('expired-demo');
        // Signed by the Network, but exp is an hour in the past: the SDK's Math.floor(now / 1000) must see it.
        const expired = t.network.userToken(u, { ttl: -3600 });
        const me = await t.get('/auth/me', { cookie: `actor_at=${expired}` });
        assert.strictEqual(me.status, 401, `an expired cookie is not a session: ${me.status} ${me.text.slice(0, 200)}`);
        const page = await t.get('/', { cookie: `actor_at=${expired}` });
        assert.ok(page.status < 400, `a page still renders: ${page.status}`);
        assert.ok(!page.text.includes('expired-demo'), 'the expired token signed nobody in');
        await t.close();
    });

    done();
})().catch((e) => { console.error(e); process.exit(1); });
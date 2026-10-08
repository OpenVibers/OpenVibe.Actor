'use strict';

/**
 * The Network's RS256 signing key, fetched once from GET /api/.well-known/jwks on the configured
 * internal URL and kept fresh by openvibe-sdk/auth's JWKS client. Tokens are verified offline
 * against it: the person's session token (sign-in).
 *
 * The SDK keeps one client per URL: the last good keys through outages, exponential backoff, a
 * rotation honoured at once, unknown-kid floods throttled, the refresh timer unref'd. This module
 * is a thin shim so the rest of Actor (the readiness check, the SSO middleware) can keep talking to
 * `keys.get()` / `keys.ensure()` / `keys.loaded()`,
 * while verification goes through the SDK's verifyUserToken / verifyAppToken with `jwks: <url>`.
 *
 * Nothing the SDK says about a failed key fetch leaves this module: its message names the internal
 * JWKS URL and the fetch error, so token.no_key answers 'signing key not loaded yet' (and an error
 * without a code 'token does not verify'). Reasons about the token itself (audience, expiry,
 * signature) are kept. Every rejection is logged.
 */
const sdk = require('openvibe-sdk/auth');

/** Public reasons. The SDK's own text (the JWKS URL, the fetch error) never goes over the wire. */
const KEY_UNAVAILABLE = 'signing key not loaded yet';
const DOES_NOT_VERIFY = 'token does not verify';

/**
 * What a caller may be told. Only token.no_key carries the SDK's fetch text (the internal JWKS URL and the connect
 * error); every other code's message is about the token itself ('not for openvibe.media', 'expired'), which a
 * developer in the playground needs, so it is kept.
 */
function publicReason(err) {
    const code = err && err.code;
    if (!code || code === 'token.no_key') return code ? KEY_UNAVAILABLE : DOES_NOT_VERIFY;
    return (err.message && String(err.message).slice(0, 200)) || DOES_NOT_VERIFY;
}

/** Resolve the JWKS URL for the configured Network (internal first, then public). */
function jwksUrl(config) {
    return (config.networkInternalUrl || config.networkUrl) + '/api/.well-known/jwks';
}

/**
 * `keys` is what app.js hands the rest of the service: a facade over the SDK's jwksClient. A synchronous caller
 * wants a PEM, so we mirror the cached first key as PEM — refreshed every time the SDK gives us keys (ensure(),
 * verifyUser(), verifyApp()).
 */
function createKeyStore({ config, fetchImpl = globalThis.fetch, log = console }) {
    const url = jwksUrl(config);
    const client = sdk.jwksClient(url, { fetch: fetchImpl, log });
    let mirror = null;        // { pem, count } — the first cached key as PEM

    async function refreshMirror() {
        try {
            const ks = await client.keys();
            const first = ks && ks[0];
            mirror = first ? { pem: first.key.export({ type: 'spki', format: 'pem' }), count: ks.length } : null;
        } catch (err) { log.warn(`[Actor] JWKS mirror refresh failed: ${err && err.message || err}`); mirror = null; }
    }
    /** First fetch (or wait out the backoff window). Refreshes the mirror. */
    async function ensure() { await refreshMirror(); }
    /** Cached public key as PEM — for openvibe-contracts' verifyServiceToken (synchronous). */
    function get() { return mirror ? mirror.pem : null; }
    function loaded() { return Boolean(mirror); }

    /** The SDK's `now` is a NUMBER of milliseconds (it does Math.floor(now / 1000)); a function disables every expiry check. */
    const asMs = (v) => (typeof v === 'function' ? v() : (typeof v === 'number' ? v : Date.now()));

    // Verify a user (session) token via the SDK. Returns { ok, claims } | { ok: false, reason, code, expired }.
    // `reason` is one of the two fixed public strings; the SDK's text is logged, never returned.
    async function verifyUser(token, { issuer, audience, now = Date.now() } = {}) {
        try {
            const claims = await sdk.verifyUserToken(token, { jwks: url, issuer, audience, now: asMs(now), log });
            await refreshMirror();
            return { ok: true, claims };
        } catch (err) {
            await refreshMirror();
            const code = err && err.code;
            log.warn(`[Actor] user token rejected (${code || 'error'}):`, (err && err.message) || err);
            return { ok: false, reason: publicReason(err), code, expired: code === 'token.expired' };
        }
    }
    // Verify an app token. Same shape and same fixed reasons. The playground reads v.reason for its detail.
    async function verifyApp(token, { issuer, audience, acceptSandbox = true, now = Date.now() } = {}) {
        try {
            const claims = await sdk.verifyAppToken(token, { jwks: url, issuer, audience, acceptSandbox, now: asMs(now), log });
            await refreshMirror();
            return { ok: true, claims };
        } catch (err) {
            await refreshMirror();
            const code = err && err.code;
            log.warn(`[Actor] app token rejected (${code || 'error'}):`, (err && err.message) || err);
            return { ok: false, reason: publicReason(err), code };
        }
    }

    /**
     * The PEM for the key a token's header names (a rotation publishes two keys: the first one is not always it), for
     * openvibe-contracts' synchronous guard. The SDK refetches for an unknown kid (at most every 30 s). Null when no
     * key is loaded; a token that names no kid gets the first key.
     */
    async function pemForToken(token) {
        let kid = null;
        try { kid = JSON.parse(Buffer.from(String(token).split('.')[0], 'base64url').toString('utf8')).kid || null; } catch { /* the guard refuses it */ }
        try {
            const ks = await client.keysForKid(kid);
            const k = (kid && ks.find((x) => x.kid === kid)) || ks[0];
            return k ? k.key.export({ type: 'spki', format: 'pem' }) : null;
        } catch { return null; }
    }

    return { ensure, get, loaded, status: client.status, verifyUser, verifyApp, pemForToken, client };
}

module.exports = { createKeyStore, jwksUrl };
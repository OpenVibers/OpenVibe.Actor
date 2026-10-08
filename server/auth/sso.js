'use strict';

/**
 * Sign-in with OpenVibe.Network: OAuth 2 authorization code with PKCE (S256), as OAuth client `actor`.
 *
 *   GET  /auth/login      → Network /oauth/authorize?…&code_challenge=…&code_challenge_method=S256
 *                           (?silent=1 adds prompt=none; ?next= a same-site path)
 *   GET  /auth/callback   → state check, server-side code exchange (client secret + code_verifier)
 *   GET  /auth/logout     → clear cookies, revoke the refresh token (best effort)
 *   GET  /auth/me         → { user } for the shared navbar (it cannot read the httpOnly cookie); { user: null } for a guest
 *
 * The person's Network access token lives in an httpOnly cookie (actor_at) no script can read: with it, a script
 * could spend their free tier. The refresh token (actor_rt) is httpOnly too. Neither is ever stored server-side,
 * rendered or logged.
 */
const crypto = require('crypto');
const express = require('express');
const cache = require('openvibe-shared/cache-policy');

const ACCESS_COOKIE = 'actor_at';
const REFRESH_COOKIE = 'actor_rt';
const HINT_COOKIE = 'ov_sso_hint';
const FLOW_COOKIE = 'actor_oauth';

function pkcePair() {
    const verifier = crypto.randomBytes(32).toString('base64url');           // 43 characters
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    return { verifier, challenge };
}

/** Same-site relative paths only (never protocol-relative, never another origin). */
function sanitizeNext(next) {
    // Browsers drop tab and newline characters from a URL and read a backslash as "/": "/<TAB>/evil.com" would
    // leave the site. A next with any control character or backslash goes home.
    if (typeof next === 'string' && /[\u0000-\u001f\u007f\\]/.test(next)) return '/';
    if (typeof next !== 'string' || !/^\/(?!\/|\\)/.test(next) || next.length > 500) return '/';
    return next;
}

function authorizeUrl(config, { state, challenge, silent = false }) {
    const q = new URLSearchParams({
        response_type: 'code',
        client_id: config.oauth.clientId,
        redirect_uri: config.oauth.redirectUri,
        scope: config.oauth.scope,
        state,
        code_challenge: challenge,
        code_challenge_method: 'S256',
    });
    if (silent) q.set('prompt', 'none');
    return `${config.networkUrl}/oauth/authorize?${q.toString()}`;
}

function createSso({ config, keys, fetchImpl = globalThis.fetch, now = () => Date.now(), log = console }) {
    const cookieBase = () => ({ sameSite: 'lax', secure: config.cookies.secure, httpOnly: true, path: '/' });

    function setSession(res, data) {
        res.cookie(ACCESS_COOKIE, data.access_token, { ...cookieBase(), maxAge: 24 * 60 * 60 * 1000 });
        if (data.refresh_token) res.cookie(REFRESH_COOKIE, data.refresh_token, { ...cookieBase(), maxAge: 30 * 24 * 60 * 60 * 1000 });
        res.cookie(HINT_COOKIE, 'account', { sameSite: 'lax', secure: config.cookies.secure, httpOnly: false, path: '/', maxAge: 365 * 24 * 60 * 60 * 1000 });
    }
    function clearSession(res) {
        res.clearCookie(ACCESS_COOKIE, cookieBase());
        res.clearCookie(REFRESH_COOKIE, cookieBase());
    }

    /** POST the Network token endpoint (internal URL). Throws { status, error } on refusal. */
    async function tokenGrant(fields) {
        const body = new URLSearchParams({ client_id: config.oauth.clientId, client_secret: config.oauth.clientSecret, ...fields });
        let res;
        try {
            res = await fetchImpl(`${config.networkInternalUrl}/oauth/token`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
                body, signal: AbortSignal.timeout(10_000),
            });
        } catch (err) {
            throw Object.assign(new Error('OpenVibe.Network did not answer'), { status: 502, error: err && err.name === 'TimeoutError' ? 'timeout' : 'unreachable' });
        }
        const data = await res.json().catch(() => null);
        if (!res.ok || !data || !data.access_token) {
            throw Object.assign(new Error((data && (data.error_description || data.error)) || `token endpoint ${res.status}`),
                { status: res.status, error: (data && data.error) || 'invalid_grant' });
        }
        return data;
    }

    /**
     * An Actor session is a Network SESSION token: audience openvibe.network and a person. The Network
     * signs FedCM assertions (audience = any owned-zone origin that asked), app/service tokens and
     * internal tokens with the same key and issuer; none of them may become a session here.
     */
    async function verifySession(token) {
        const v = await keys.verifyUser(token, { issuer: config.networkIssuer, audience: config.oauth.sessionAudience, now: now() });
        const c = v.claims;
        if (c && (c.typ === 'fedcm' || c.actor_type !== undefined)) return { ok: false, reason: 'not a session token' };
        return v;
    }

    function viewerFromClaims(claims, token) {
        const subject = typeof claims.subject_id === 'string' ? claims.subject_id : null;
        const role = typeof claims.role === 'string' ? claims.role : 'user';
        return {
            kind: 'user',
            subject,
            username: typeof claims.username === 'string' ? claims.username.slice(0, 64) : null,
            displayName: typeof claims.display_name === 'string' ? claims.display_name.slice(0, 80) : (typeof claims.username === 'string' ? claims.username.slice(0, 64) : 'you'),
            role,
            // The person's Network access token: used for server-side Network calls, never rendered.
            token,
        };
    }

    /** One refresh per request, however many Network calls in it see a 401 (refresh tokens rotate). */
    async function refresh(req, res) {
        if (!req.actorRefresh) req.actorRefresh = await doRefresh(req, res);
        return req.actorRefresh;
    }

    async function doRefresh(req, res) {
        const rt = req.cookies && req.cookies[REFRESH_COOKIE];
        if (!rt) return null;
        try {
            const data = await tokenGrant({ grant_type: 'refresh_token', refresh_token: rt });
            setSession(res, data);
            const v = await verifySession(data.access_token);
            return v.ok ? viewerFromClaims(v.claims, data.access_token) : null;
        } catch (err) {
            if (err.status && err.status < 500) clearSession(res);
            return null;
        }
    }

    /** req.viewer for every page: the signed-in person, refreshed when their token expired. */
    function middleware() {
        return async (req, res, next) => {
            req.viewer = { kind: 'anonymous' };
            const token = req.cookies && req.cookies[ACCESS_COOKIE];
            if (!token) return next();
            await keys.ensure();
            const v = await verifySession(token);
            if (v.ok) { req.viewer = viewerFromClaims(v.claims, token); return next(); }
            if (v.expired) {
                const fresh = await refresh(req, res);
                if (fresh) { req.viewer = fresh; return next(); }
            }
            if (keys.loaded()) clearSession(res);
            next();
        };
    }

    /**
     * Run fn(token) as the viewer; when the Network answers 401 (expired or revoked session), refresh
     * once and run it again. Other failures are returned to the caller unchanged.
     */
    async function asViewer(req, res, fn) {
        try {
            return await fn(req.viewer.token);
        } catch (err) {
            if (!err || err.status !== 401) throw err;
            const fresh = await refresh(req, res);
            if (!fresh) throw err;
            req.viewer = fresh;
            return fn(fresh.token);
        }
    }

    function routes() {
        const r = express.Router();
        const flowOpts = () => ({ ...cookieBase(), path: '/auth', maxAge: 10 * 60 * 1000 });

        r.get('/login', (req, res) => {
            const silent = Boolean(req.query.silent) && req.query.silent !== '0';
            const state = crypto.randomBytes(16).toString('hex');
            const { verifier, challenge } = pkcePair();
            res.cookie(FLOW_COOKIE, JSON.stringify({ state, verifier, next: sanitizeNext(req.query.next), silent }), flowOpts());
            res.set('Cache-Control', cache.htmlHeaders({ private: true }));
            res.redirect(authorizeUrl(config, { state, challenge, silent }));
        });

        r.get('/callback', async (req, res) => {
            res.set('Cache-Control', cache.htmlHeaders({ private: true }));
            let flow = null;
            try { flow = JSON.parse(req.cookies[FLOW_COOKIE] || 'null'); } catch { flow = null; }
            res.clearCookie(FLOW_COOKIE, { ...cookieBase(), path: '/auth' });
            const next = flow ? sanitizeNext(flow.next) : '/';
            const { code, state, error } = req.query;
            if (error) {
                if ((flow && flow.silent) || error === 'login_required' || error === 'interaction_required') return res.redirect(next);
                return res.status(400).type('text/plain').send(`Sign-in was not completed (${String(error).slice(0, 60)}).`);
            }
            if (!flow || typeof flow.state !== 'string' || typeof flow.verifier !== 'string' || typeof state !== 'string'
                || state.length !== flow.state.length || !crypto.timingSafeEqual(Buffer.from(state), Buffer.from(flow.state))) {
                return res.status(400).type('text/plain').send('Sign-in state did not match. Please try signing in again.');
            }
            if (!code) return res.status(400).type('text/plain').send('The Network sent no authorization code.');
            try {
                const data = await tokenGrant({ grant_type: 'authorization_code', code: String(code), redirect_uri: config.oauth.redirectUri, code_verifier: flow.verifier });
                setSession(res, data);
                return res.redirect(next);
            } catch (err) {
                log.warn('[Actor] sign-in exchange failed:', err.status || '', err.error || '');
                return res.status(err.status && err.status < 500 ? 400 : 502).type('text/plain')
                    .send(err.status && err.status < 500 ? 'The Network refused the sign-in code. Please sign in again.' : 'Sign-in failed: OpenVibe.Network did not answer. Please try again.');
            }
        });

        // Sign-out ends the session, so another site must not be able to trigger it (a cross-site
        // <img src=/auth/logout> or link). A same-origin navigation or form, or the address bar
        // (Sec-Fetch-Site none), signs out directly; anything else gets a confirm button (POST).
        const sameOriginRequest = (req) => {
            const site = String(req.get('sec-fetch-site') || '');
            if (site) return site === 'same-origin' || (site === 'none' && req.method === 'GET');
            const origin = req.get('origin');
            if (origin) return origin === `${req.protocol}://${req.get('host')}`;
            return req.method === 'GET';    // no fetch metadata and no Origin: an old browser navigating
        };
        r.get('/logout', (req, res, next) => {
            if (sameOriginRequest(req)) return next();
            res.set('Cache-Control', cache.htmlHeaders({ private: true }));
            const q = req.query.next ? `?next=${encodeURIComponent(sanitizeNext(req.query.next))}` : '';
            res.type('html').send(`<!doctype html><meta charset="utf-8"><title>Sign out</title><meta name="viewport" content="width=device-width,initial-scale=1">`
                + `<form method="post" action="/auth/logout${q}" style="font:16px system-ui;margin:3em auto;max-width:24em;text-align:center">`
                + `<p>Sign out of OpenVibe.Actor?</p><button type="submit">Sign out</button> <a href="/">Cancel</a></form>`);
        });
        r.post('/logout', (req, res, next) => (sameOriginRequest(req) ? next() : res.status(403).type('text/plain').send('Sign-out must come from this site.')));
        r.all('/logout', async (req, res) => {
            const rt = req.cookies && req.cookies[REFRESH_COOKIE];
            if (rt) {
                fetchImpl(`${config.networkInternalUrl}/oauth/revoke`, {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ client_id: config.oauth.clientId, client_secret: config.oauth.clientSecret, token: rt }),
                    signal: AbortSignal.timeout(3000),
                }).catch(() => {});
            }
            clearSession(res);
            res.cookie(HINT_COOKIE, 'guest', { sameSite: 'lax', secure: config.cookies.secure, httpOnly: false, path: '/', maxAge: 365 * 24 * 60 * 60 * 1000 });
            res.redirect(303, sanitizeNext(req.query.next));
        });

        r.get('/me', (req, res) => {
            res.set('Cache-Control', cache.htmlHeaders({ private: true }));
            // No session at all (a guest: no access or refresh cookie) is signed out, not an error: the shared
            // navbar asks this on every page view, and a 401 logged a console error on each (browser check,
            // OpenVibe.Host). A session cookie that is present but invalid or expired still answers 401.
            const c = req.cookies || {};
            if (!c[ACCESS_COOKIE] && !c[REFRESH_COOKIE] && !req.get('authorization')) return res.json({ user: null });
            const v = req.viewer;
            if (!v || v.kind !== 'user') return res.status(401).json({ error: 'Not signed in' });
            res.json({ user: { username: v.username, display_name: v.displayName, subject_id: v.subject, role: v.role } });
        });
        return r;
    }

    return { middleware, routes, asViewer, tokenGrant, pkcePair };
}

module.exports = { createSso, pkcePair, sanitizeNext, authorizeUrl, ACCESS_COOKIE, REFRESH_COOKIE };

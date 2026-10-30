'use strict';

/**
 * Sign-in with OpenVibe.Network: openvibe-sdk/sso (0.73.0) is the one module every site uses. This file is this
 * site's thin wrapper around it — the routes, the middleware and the shapes this site's pages still read.
 *
 *   GET  /auth/login     → Network /oauth/authorize with state and PKCE (S256); ?next, ?silent, ?prompt, ?login_hint
 *   GET  /auth/callback  → the state is compared in constant time, the code is exchanged server-side (client secret)
 *   GET  /auth/logout    → the cookies are cleared, the refresh token revoked (best effort)
 *   GET  /auth/me        → { user } for the shared navbar
 *   GET  /auth/health    → { ok, client }: does the Network accept this site's OAuth client?
 *   POST /auth/fedcm     → the shared navbar's FedCM assertion, swapped for tokens
 *   POST /auth/refresh   → the tokens are rotated with the refresh token
 *
 * The SDK recovers by itself once (a lost or expired flow, a code the Network no longer accepts) and shows a page
 * with "Try again" when it cannot: no more a bare "The Network refused the sign-in code." A client the Network
 * refuses is logged as a configuration error, and GET /auth/health answers 503 for it.
 *
 * Nothing signed in is signed out: the old cookie (actor_at) is read as the session until the next sign-in or
 * refresh writes ov_token and clears it. The access token stays httpOnly: no script can read it (the navbar asks
 * /auth/me).
 */
const crypto = require('crypto');
const express = require('express');
const cache = require('openvibe-shared/cache-policy');
const { createSsoClient, COOKIES, parseCookies } = require('openvibe-sdk/sso');

const ACCESS_COOKIE = 'actor_at';
const REFRESH_COOKIE = 'actor_rt';
const HINT_COOKIE = 'ov_sso_hint';

/** The cookie names a session is read from: the site's own before the move, the SDK's now. */
const SESSION_COOKIES = [COOKIES.access, ACCESS_COOKIE];

function pkcePair() {
    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    return { verifier, challenge };
}

function ownOrigins(config) {
    const out = new Set();
    for (const u of [config && config.baseUrl, config && config.homes && config.homes.url]) {
        try { if (u) out.add(new URL(u).origin); } catch { /* not a URL */ }
    }
    return out;
}

/** Same-site relative paths only (never protocol-relative, never another origin). */
function sanitizeNext(next, config) {
    if (typeof next === 'string' && /[\u0000-\u001f\u007f\\]/.test(next)) return '/';
    if (typeof next === 'string' && /^https?:\/\//i.test(next)) {
        let u = null;
        try { u = new URL(next); } catch { return '/'; }
        if (!ownOrigins(config).has(u.origin)) return '/';
        next = `${u.pathname}${u.search}${u.hash}`;
    }
    if (typeof next !== 'string' || !/^\/(?!\/|\\)/.test(next) || next.length > 500) return '/';
    return next;
}

/** The authorize URL for a sign-in (pure; the SDK builds its own, this one stays for the site's tests). */
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
    // The one module. The site's own values, its own old cookies, and the audience it always verified with.
    const sso = createSsoClient({
        site: 'actor',
        siteName: 'OpenVibe.Actor',
        baseUrl: config.baseUrl,
        clientId: config.oauth.clientId,
        clientSecret: config.oauth.clientSecret,
        networkUrl: config.networkUrl,
        networkInternalUrl: config.networkInternalUrl || config.networkUrl,
        issuer: config.networkIssuer || config.networkUrl,
        redirectUri: config.oauth.redirectUri,
        scope: config.oauth.scope,
        audience: config.oauth.sessionAudience,
        secureCookies: config.cookies.secure !== false,
        httpOnlyAccess: true,
        legacyCookies: { access: [ACCESS_COOKIE], refresh: [REFRESH_COOKIE] },
        fetch: fetchImpl,
        log,
    });

    const cookieBase = () => ({ sameSite: 'lax', secure: config.cookies.secure !== false, httpOnly: true, path: '/' });

    /** The person, in the shape this site's pages read (req.viewer). */
    function viewerFrom(claims, token) {
        const subject = typeof claims.subject_id === 'string' ? claims.subject_id : null;
        const role = typeof claims.role === 'string' ? claims.role : 'user';
        const username = typeof claims.username === 'string' ? claims.username.slice(0, 64) : null;
        return {
            kind: 'user',
            subject,
            username,
            displayName: typeof claims.display_name === 'string' ? claims.display_name.slice(0, 80) : (username || 'you'),
            role,
            avatarUrl: typeof claims.avatar_url === 'string' && /^https:\/\/[^\s"'<>]{1,500}$/.test(claims.avatar_url) ? claims.avatar_url : null,
            profileColor: typeof claims.profile_color === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(claims.profile_color) ? claims.profile_color : null,
            token,
        };
    }

    /** The public profile the navbar and the API read (the same fields as before the move). */
    const meOf = (claims) => {
        const v = viewerFrom(claims, null);
        return {
            username: v.username,
            display_name: v.displayName,
            subject_id: v.subject,
            role: v.role,
            avatar_url: v.avatarUrl || null,
            profile_color: v.profileColor || null,
        };
    };

    /**
     * The access token expired (or is gone) but the refresh token is still there: rotate it and write the SDK's own
     * cookies, the same names and options the SDK uses. The old cookies are cleared.
     */
    async function refreshSession(req, res) {
        const c = parseCookies(req);
        const rt = c[COOKIES.refresh] || c[REFRESH_COOKIE];
        if (!rt) return null;
        let data = null;
        try { data = await sso.tokenGrant({ grant_type: 'refresh_token', refresh_token: rt }); } catch { return null; }
        if (!data || !data.access_token) return null;
        const claims = await sso.verify(data.access_token);
        if (!claims) return null;
        res.cookie(COOKIES.access, data.access_token, { ...cookieBase(), maxAge: 24 * 60 * 60 * 1000 });
        if (data.refresh_token) res.cookie(COOKIES.refresh, data.refresh_token, { ...cookieBase(), path: '/auth', maxAge: 30 * 24 * 60 * 60 * 1000 });
        res.clearCookie(ACCESS_COOKIE, { path: '/' });
        res.clearCookie(REFRESH_COOKIE, { path: '/' });
        return { claims, token: data.access_token };
    }

    /** req.user and req.token for a valid session; req.viewer keeps this site's pages working as they are. */
    function middleware() {
        const optional = sso.optionalAuth();
        return (req, res, next) => {
            req.viewer = { kind: 'anonymous' };
            optional(req, res, async () => {
                try {
                    if (req.user && req.token) { req.viewer = viewerFrom(req.user, req.token); return next(); }
                    const fresh = await refreshSession(req, res);
                    if (fresh) {
                        req.user = fresh.claims;
                        req.token = fresh.token;
                        req.viewer = viewerFrom(fresh.claims, fresh.token);
                    }
                } catch (err) {
                    log.warn('[OpenVibe.Actor] session refresh failed:', (err && err.message) || err);
                }
                return next();
            });
        };
    }

    /** A call with the person's own token; a 401 refreshes the session once and tries again. */
    async function asViewer(req, res, fn) {
        const token = req.token || (req.viewer && req.viewer.token) || null;
        if (!token) throw Object.assign(new Error('Not signed in'), { status: 401 });
        try {
            return await fn(token);
        } catch (err) {
            if (!err || err.status !== 401) throw err;
            const fresh = await refreshSession(req, res);
            if (!fresh) throw err;
            req.user = fresh.claims;
            req.token = fresh.token;
            req.viewer = viewerFrom(fresh.claims, fresh.token);
            return fn(fresh.token);
        }
    }

    function routes() {
        const r = express.Router();

        // No Clear-Site-Data on the callback or on sign-out: Chrome holds such an answer (and the cookies it sets)
        // until the cache is cleared, which on phones left people on the account chooser with no session (2026-10-28).

        // GET /auth/me: the shared navbar's answer. A guest is { user: null } (200); a session that does not verify
        // is 401, as it always was here.
        r.get('/me', async (req, res) => {
            res.set('Cache-Control', cache.htmlHeaders({ private: true }));
            const c = parseCookies(req);
            const presented = Boolean(c[COOKIES.access] || c[ACCESS_COOKIE] || c[COOKIES.refresh] || c[REFRESH_COOKIE] || req.get('authorization'));
            if (!presented) return res.json({ user: null });
            const claims = await sso.verify(sso.extractToken(req));
            if (!claims) return res.status(401).json({ error: 'Not signed in' });
            return res.json({ user: meOf(claims) });
        });

        // Sign-out stays a same-site action: another site cannot sign a person out.
        const sameOriginRequest = (req) => {
            const site = String(req.get('sec-fetch-site') || '');
            if (site) return site === 'same-origin' || (site === 'none' && req.method === 'GET');
            const origin = req.get('origin');
            if (origin) return origin === `${req.protocol}://${req.get('host')}`;
            return req.method === 'GET';
        };
        r.get('/logout', (req, res, next) => {
            if (sameOriginRequest(req)) return next();
            res.set('Cache-Control', cache.htmlHeaders({ private: true }));
            const q = req.query.next ? `?next=${encodeURIComponent(sanitizeNext(req.query.next, config))}` : '';
            res.type('html').send('<!doctype html><meta charset="utf-8"><title>Sign out</title><meta name="viewport" content="width=device-width,initial-scale=1">'
                + `<form method="post" action="/auth/logout${q}" style="font:16px system-ui;margin:3em auto;max-width:24em;text-align:center">`
                + '<p>Sign out of OpenVibe.Actor?</p><button type="submit">Sign out</button> <a href="/">Cancel</a></form>');
        });
        r.post('/logout', (req, res, next) => (sameOriginRequest(req) ? next() : res.status(403).type('text/plain').send('Sign-out must come from this site.')));
        r.all('/logout', async (req, res) => {
            const c = parseCookies(req);
            const rt = c[COOKIES.refresh] || c[REFRESH_COOKIE];
            if (rt) {
                fetchImpl(`${config.networkInternalUrl}/oauth/revoke`, {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ client_id: config.oauth.clientId, client_secret: config.oauth.clientSecret, token: rt }),
                    signal: AbortSignal.timeout(3000),
                }).catch(() => {});
            }
            res.clearCookie(COOKIES.access, { path: '/' });
            res.clearCookie(COOKIES.refresh, { path: '/auth' });
            res.clearCookie(ACCESS_COOKIE, { path: '/' });
            res.clearCookie(REFRESH_COOKIE, { path: '/' });
            res.cookie(HINT_COOKIE, 'guest', { sameSite: 'lax', secure: config.cookies.secure !== false, httpOnly: false, path: '/', maxAge: 365 * 24 * 60 * 60 * 1000 });
            return res.redirect(303, sanitizeNext(req.query.next, config));
        });

        // The SDK's own routes: /login, /callback, /fedcm, /refresh, /health.
        r.use(sso.router(express));
        return r;
    }

    return { middleware, routes, asViewer, tokenGrant: (fields) => sso.tokenGrant(fields), pkcePair, client: sso, checkClient: (o) => sso.checkClient(o) };
}

module.exports = { createSso, pkcePair, sanitizeNext, ownOrigins, authorizeUrl, ACCESS_COOKIE, REFRESH_COOKIE, SESSION_COOKIES };

'use strict';

/**
 * A self-hosted Actor's own sign-in (ACTOR_SELF_HOSTED=1, docs/self-host.md): one owner, no OpenVibe.Network. The same
 * shape as auth/sso.js, so the rest of the site does not tell them apart.
 *
 *   GET  /auth/login      a password form (?next= a same-site path)
 *   POST /auth/login      the owner's password → a signed session cookie (actor_local, httpOnly, 30 days)
 *   GET  /auth/logout     clears it
 *   GET  /auth/me         { user } for the navbar; { user: null } for a guest
 *
 * The cookie is "<expiry ms>.<HMAC-SHA256 under ACTOR_SESSION_SECRET>"; the password is checked against
 * ACTOR_OWNER_PASSWORD_HASH ("scrypt$<N>$<r>$<p>$<salt>$<hash>", base64url; scripts/selfhost-init.js makes it). The
 * owner's API token (ACTOR_OWNER_TOKEN, a Bearer) is checked in http/principal.js. Neither is ever logged or rendered.
 */
const crypto = require('crypto');
const express = require('express');
const cache = require('openvibe-shared/cache-policy');
const { sanitizeNext } = require('./sso');

const COOKIE = 'actor_local';
const SESSION_MS = 30 * 24 * 3600 * 1000;

/** "scrypt$N$r$p$salt$hash" for a password (base64url salt and hash): what ACTOR_OWNER_PASSWORD_HASH holds. */
function hashPassword(password, { N = 16384, r = 8, p = 1 } = {}) {
    const salt = crypto.randomBytes(16);
    const hash = crypto.scryptSync(String(password), salt, 32, { N, r, p, maxmem: 64 * 1024 * 1024 });
    return `scrypt$${N}$${r}$${p}$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

/** Does `password` match the stored hash? Constant time; a malformed hash matches nothing. */
function checkPassword(password, stored) {
    const m = /^scrypt\$(\d+)\$(\d+)\$(\d+)\$([A-Za-z0-9_-]+)\$([A-Za-z0-9_-]+)$/.exec(String(stored || ''));
    if (!m || typeof password !== 'string' || !password || password.length > 1024) return false;
    const [N, r, p] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const want = Buffer.from(m[5], 'base64url');
    let got;
    try { got = crypto.scryptSync(password, Buffer.from(m[4], 'base64url'), want.length, { N, r, p, maxmem: 64 * 1024 * 1024 }); } catch { return false; }
    return got.length === want.length && crypto.timingSafeEqual(got, want);
}

/** Constant-time string equality through SHA-256 (lengths never leak). */
function sameSecret(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
    const ha = crypto.createHash('sha256').update(a).digest();
    const hb = crypto.createHash('sha256').update(b).digest();
    return crypto.timingSafeEqual(ha, hb);
}

function createLocalSignIn({ config, now = () => Date.now() }) {
    const sh = config.selfHosted;
    const mac = (value) => crypto.createHmac('sha256', sh.sessionSecret).update(`actor-local-session:${value}`).digest('base64url');
    const cookieOpts = () => ({ httpOnly: true, sameSite: 'lax', secure: config.cookies.secure, path: '/' });
    const owner = () => ({ kind: 'user', subject: sh.ownerSubject, username: sh.ownerName, displayName: sh.ownerName, role: 'user', token: null });

    function readSession(req) {
        const raw = req.cookies && req.cookies[COOKIE];
        const m = /^(\d{13})\.([A-Za-z0-9_-]{43})$/.exec(String(raw || ''));
        if (!m || Number(m[1]) < now()) return false;
        return sameSecret(mac(m[1]), m[2]);
    }

    function middleware() {
        return (req, res, next) => {
            req.viewer = readSession(req) ? owner() : { kind: 'anonymous' };
            next();
        };
    }

    /** Nothing here calls the Network as the viewer: a self-hosted owner has no Network token. */
    async function asViewer(req, res, fn) { return fn(null); }

    function page(res, status, { next = '/', error = null } = {}) {
        res.status(status).set('Cache-Control', cache.htmlHeaders({ private: true })).type('html').send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Sign in · Actor</title>
<meta name="robots" content="noindex"><style>body{font:16px/1.5 system-ui,sans-serif;background:#0b1220;color:#e6edf7;display:grid;place-items:center;min-height:100vh;margin:0}
form{background:#111a2e;border:1px solid #23304d;border-radius:12px;padding:28px;width:min(360px,calc(100vw - 32px));box-sizing:border-box}
h1{font-size:1.3rem;margin:0 0 4px}p{color:#96a7c2;margin:0 0 18px;font-size:.92rem}label{display:block;font-size:.9rem;margin-bottom:6px}
input{width:100%;box-sizing:border-box;padding:10px 12px;border-radius:8px;border:1px solid #33456a;background:#0b1220;color:inherit;font:inherit}
button{margin-top:14px;width:100%;padding:10px;border:0;border-radius:8px;background:#2563eb;color:#fff;font:600 1rem system-ui,sans-serif;cursor:pointer}
.error{color:#fca5a5;margin:0 0 12px}</style></head><body>
<form method="post" action="/auth/login"><h1>Sign in to your Actor</h1><p>This Actor runs on your own server.</p>
${error ? `<p class="error" role="alert">${error}</p>` : ''}<input type="hidden" name="next" value="${String(next).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))}">
<label for="pw">Password</label><input id="pw" name="password" type="password" autocomplete="current-password" required autofocus>
<button type="submit">Sign in</button></form></body></html>`);
    }

    function routes() {
        const r = express.Router();
        r.get('/login', (req, res) => page(res, 200, { next: sanitizeNext(req.query.next) }));
        r.post('/login', express.urlencoded({ extended: false, limit: '4kb' }), (req, res) => {
            const next = sanitizeNext(req.body && req.body.next);
            if (!checkPassword(req.body && req.body.password, sh.passwordHash)) return page(res, 401, { next, error: 'That is not the password.' });
            const exp = String(now() + SESSION_MS);
            res.cookie(COOKIE, `${exp}.${mac(exp)}`, { ...cookieOpts(), maxAge: SESSION_MS });
            res.redirect(303, next);
        });
        r.get('/logout', (req, res) => { res.clearCookie(COOKIE, cookieOpts()); res.redirect(303, '/'); });
        r.get('/me', (req, res) => {
            res.set('Cache-Control', 'private, no-store');
            const v = req.viewer;
            res.json({ user: v && v.kind === 'user' ? { username: v.username, display_name: v.displayName, subject_id: v.subject } : null });
        });
        return r;
    }

    return { middleware, routes, asViewer, local: true };
}

module.exports = { createLocalSignIn, hashPassword, checkPassword, sameSecret, COOKIE };

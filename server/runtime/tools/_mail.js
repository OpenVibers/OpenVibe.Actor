'use strict';

/**
 * OpenVibe.Mail from the tool modules (not a module itself: the registry skips files starting with "_").
 *
 * The person reads their own mail with their OWN Network token (the one the run carries), against Mail's own
 * routes (GET /api/v1/me/mail/messages…). A service token of Actor's own is never used here: Mail reads the
 * person in the token, and nobody else's mail is in reach.
 *
 * Mail's send is human-only: the agent never sends. The email_draft tool only writes a draft card; nothing
 * leaves the machine until the person sends it in Mail themselves.
 *
 *   mailFor(ctx, person) → { enabled, base, call(method, path, body) }
 */

const USER_SUBJECT = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;

const CACHE = new WeakMap();

/** The person a task is for ('user:usr_…' → 'usr_…'), or null when the task has no person. */
function personOf(requester) {
    if (typeof requester !== 'string' || !requester.startsWith('user:')) return null;
    const id = requester.slice(5);
    return USER_SUBJECT.test(id) ? id : null;
}

function mailFor(ctx, person) {
    const config = ctx.config;
    const base = String((config && config.services && config.services.mailUrl) || '').replace(/\/+$/, '');
    const token = ctx.personToken || null;
    const enabled = Boolean(base && token && person);
    if (!enabled) {
        return { enabled: false, base, reason: base ? 'this run has no OpenVibe session of its own' : 'OpenVibe.Mail is not connected to this server' };
    }
    const fetchImpl = ctx.fetch || globalThis.fetch;
    let byFetch = CACHE.get(config);
    if (!byFetch) { byFetch = new WeakMap(); CACHE.set(config, byFetch); }
    let byToken = byFetch.get(fetchImpl);
    if (!byToken) { byToken = new Map(); byFetch.set(fetchImpl, byToken); }
    if (byToken.has(token)) return byToken.get(token);

    /** One call to Mail, as the person. A refusal is an answer, never a throw. */
    async function call(method, path, body) {
        let res = null;
        try {
            res = await fetchImpl(base + path, {
                method,
                headers: { Accept: 'application/json', Authorization: 'Bearer ' + token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
                body: body === undefined ? undefined : JSON.stringify(body),
                signal: AbortSignal.timeout(20_000),
            });
        } catch (err) {
            return { ok: false, status: 502, error: 'OpenVibe.Mail did not answer: ' + String((err && err.message) || err).slice(0, 200) };
        }
        const text = await res.text().catch(() => '');
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch { data = null; }
        if (!res.ok) {
            const detail = String((data && (data.detail || data.title || data.code)) || text || ('OpenVibe.Mail answered ' + res.status)).slice(0, 300);
            return { ok: false, status: res.status, error: detail, data };
        }
        return { ok: true, status: res.status, data };
    }

    const out = { enabled: true, base, token, call };
    byToken.set(token, out);
    return out;
}

/** The public address of Mail, where a person opens their inbox. */
function mailPublicUrl(ctx) {
    const url = ctx.config && ctx.config.services && ctx.config.services.mailPublicUrl;
    return String(url || 'https://openvibe.email').replace(/\/+$/, '');
}

module.exports = { mailFor, mailPublicUrl, personOf, USER_SUBJECT };

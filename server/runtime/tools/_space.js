'use strict';

/**
 * OpenVibe.Space, from the tool modules (not a module itself: the registry skips files starting with "_").
 *
 * The agent works on the person's own spaces through Space's builder API (plan 2026-10-22 §Z stage Z1): the
 * space_create, space_files_list, space_files_read, space_files_write, space_preview and space_publish tools.
 *
 * Actor calls Space with its own service token (audience openvibe.space, the capabilities space.build.*) and
 * names the person in X-OV-Subject: Space then reads and writes only that person's own spaces, and another
 * person's space is the same 404 as one that does not exist. Without the client secret or without a space
 * address the tools are off (available() says so and the model never sees them).
 *
 *   spaceFor(ctx) → { enabled, call(method, path, person, body) }
 *     call → { ok, status, data } — the answer as JSON, or { ok: false, status, error } when Space refused.
 */

const { serviceAuth } = require('openvibe-contracts');

const SCOPE = 'space.build.read space.build.create space.build.write space.build.publish';
const SPACE_ID = /^spc_[0-9A-HJKMNP-TV-Z]{26}$/;
const USER_SUBJECT = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;
const TIMEOUT_MS = 20_000;

const CACHE = new WeakMap();

/** The person a task is for ('user:usr_…' → 'usr_…'), or null when the task has no person. */
function personOf(requester) {
    if (typeof requester !== 'string' || !requester.startsWith('user:')) return null;
    const id = requester.slice(5);
    return USER_SUBJECT.test(id) ? id : null;
}

function spaceFor(ctx) {
    const config = ctx.config;
    if (!config) throw new Error('a tool needs ctx.config');
    const fetchImpl = ctx.fetch || globalThis.fetch;
    // One client per (config, fetch): the fetch may be the caller's own, and each one has its own token.
    let byFetch = CACHE.get(config);
    if (!byFetch) { byFetch = new WeakMap(); CACHE.set(config, byFetch); }
    if (byFetch.has(fetchImpl)) return byFetch.get(fetchImpl);
    const base = String((config.services && config.services.spaceUrl) || '').replace(/\/+$/, '');
    const clientSecret = config.oauth && config.oauth.clientSecret;
    const enabled = Boolean(base && clientSecret);
    const tokens = enabled ? serviceAuth.createTokenClient({
        tokenUrl: `${config.networkInternalUrl}/oauth/token`,
        clientId: (config.oauth && config.oauth.clientId) || 'actor',
        clientSecret,
        audience: 'openvibe.space',
        scope: SCOPE,
        fetchImpl,
    }) : null;
    const space = {
        enabled,
        base,
        /** One call to Space for one person. Never throws for a refusal: the model reads the answer. */
        async call(method, path, person, body) {
            if (!enabled) return { ok: false, status: 503, error: 'OpenVibe.Space is not connected to this server' };
            if (!person) return { ok: false, status: 401, error: 'this work runs for you alone, so it needs you signed in' };
            const headers = { Accept: 'application/json', 'X-OV-Subject': person, ...(await tokens.authHeaders()) };
            if (body !== undefined) headers['Content-Type'] = 'application/json';
            let res;
            try {
                res = await fetchImpl(`${base}${path}`, {
                    method,
                    headers,
                    body: body === undefined ? undefined : JSON.stringify(body),
                    signal: AbortSignal.timeout(TIMEOUT_MS),
                });
            } catch (err) {
                return { ok: false, status: 502, error: `OpenVibe.Space did not answer: ${(err && err.message) || err}` };
            }
            const text = await res.text().catch(() => '');
            let data = null;
            try { data = text ? JSON.parse(text) : null; } catch { data = null; }
            if (!res.ok) {
                const detail = String((data && (data.detail || data.title || data.error)) || text || `OpenVibe.Space answered ${res.status}`).slice(0, 300);
                return { ok: false, status: res.status, error: detail, data };
            }
            return { ok: true, status: res.status, data };
        },
    };
    byFetch.set(fetchImpl, space);
    return space;
}

/** The space id a tool call names, or null when it names none (or one that cannot exist). */
function spaceIdOf(input) {
    const id = String((input && input.space_id) || '').trim();
    return SPACE_ID.test(id) ? id : null;
}

module.exports = { spaceFor, personOf, spaceIdOf, SCOPE, SPACE_ID, USER_SUBJECT };

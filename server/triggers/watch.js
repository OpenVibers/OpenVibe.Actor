'use strict';
/**
 * OpenVibe.Watch, called with the person's own token — never Actor's service token acting for them. A
 * trigger is a watch the person owns: pause, resume, edit and delete go to Watch as that person, and
 * another person's watch is 404 there just as another person's trigger is 404 here.
 *
 * The person's token reaches Actor as their session or Bearer; the trigger tool reads it from the
 * short-lived run token (server/triggers/tokens.js) and the API routes from the request itself.
 */
const TIMEOUT_MS = 10_000;
const PREFIX = { 'watch.watch.manage': null };

function createWatchClient({ config, fetchImpl = globalThis.fetch, log = console }) {
    const base = String((config.services && config.services.watchUrl) || '').replace(/\/+$/, '');
    const enabled = Boolean(base);

    async function call(token, method, path, body) {
        if (!enabled) return { ok: false, status: 0, code: 'actor.trigger.watch_unavailable', detail: 'OpenVibe.Watch is not configured on this Actor (ACTOR_WATCH_URL).' };
        if (!token) return { ok: false, status: 401, code: 'actor.trigger.sign_in', detail: 'Sign in again: creating or changing a trigger needs your own OpenVibe session, not a service token.' };
        let res, text;
        try {
            res = await fetchImpl(`${base}${path}`, {
                method,
                headers: {
                    accept: 'application/json',
                    authorization: `Bearer ${token}`,
                    ...(body === undefined ? {} : { 'content-type': 'application/json' }),
                },
                body: body === undefined ? undefined : JSON.stringify(body),
                signal: AbortSignal.timeout(TIMEOUT_MS),
            });
            text = await res.text();
        } catch (err) {
            return { ok: false, status: 0, code: 'actor.trigger.watch_unavailable', detail: `OpenVibe.Watch did not answer (${String((err && err.message) || err).slice(0, 160)}).` };
        }
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
        if (res.ok) return { ok: true, status: res.status, data, text };
        if (res.status === 401) return { ok: false, status: 401, code: 'actor.trigger.sign_in', detail: 'Your OpenVibe session expired while saving the trigger. Sign in again and ask once more.', data };
        const code = (data && (data.code || data.title)) || `watch_${res.status}`;
        const detail = (data && (data.detail || data.title)) || text.slice(0, 300) || `OpenVibe.Watch answered ${res.status}`;
        return { ok: false, status: res.status, code, detail, data };
    }

    async function create(token, watch) {
        const out = await call(token, 'POST', '/api/v1/watches', watch);
        return out.ok ? { ok: true, watch: out.data && out.data.watch, data: out.data } : out;
    }
    async function get(token, id) {
        const out = await call(token, 'GET', `/api/v1/watches/${encodeURIComponent(id)}`);
        return out.ok ? { ok: true, watch: out.data && out.data.watch } : out;
    }
    async function patch(token, id, changes) {
        const out = await call(token, 'PATCH', `/api/v1/watches/${encodeURIComponent(id)}`, changes);
        return out.ok ? { ok: true, watch: out.data && out.data.watch } : out;
    }
    async function setSchedule(token, id, cronExpr, timezone) {
        const out = await call(token, 'POST', `/api/v1/watches/${encodeURIComponent(id)}/schedule`, { cron: cronExpr, timezone });
        return out.ok ? { ok: true, data: out.data } : out;
    }
    async function pause(token, id) { return await call(token, 'POST', `/api/v1/watches/${encodeURIComponent(id)}/pause`); }
    async function resume(token, id) { return await call(token, 'POST', `/api/v1/watches/${encodeURIComponent(id)}/resume`); }
    async function remove(token, id) { return await call(token, 'DELETE', `/api/v1/watches/${encodeURIComponent(id)}`); }
    async function check(token, id) { return await call(token, 'POST', `/api/v1/watches/${encodeURIComponent(id)}/check`); }

    return { enabled, base, create, get, patch, setSchedule, pause, resume, remove, check };
}

module.exports = { createWatchClient };

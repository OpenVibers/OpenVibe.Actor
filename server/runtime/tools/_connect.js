'use strict';

/**
 * The person's own OpenVibe apps, through Connect (not a tool module: the registry skips "_" files). Plan §L.2 (the
 * Finance Experts read the person's money as them) and AD.28 item 2 ("a service caller, Codes or Actor, only through its
 * grants").
 *
 * Actor calls Connect's code-mode server (Network's POST /mcp/all: search and execute over the person's apps) as the
 * person, with a token Network mints for Actor naming that person (client_credentials, audience openvibe.network,
 * scope network.connect.act, on_behalf_of; Contracts 0.446.0). Network mints it only for a person who signed in to
 * Actor, and it carries network.connect.act alone. What it reaches is only what the person granted Actor on their Apps
 * page, app by app (read in OpenVibe Finance, say); a send, a delete or a pay still asks the person; OpenVibe's own apps
 * are called with a delegated person token for one service and one call. The token never reaches the model, a page or
 * a log, and is kept a little under its five minutes, per person.
 *
 *   connectFor(ctx) → { call(person, tool, args, { signal }) → { ok, text, data } | { ok: false, error } }
 *     tool is 'search' or 'execute' (/mcp/all's two tools)
 */

const APPS_PAGE = 'https://openvibe.network/apps';
const KEEP_MS = 4 * 60_000;
const PERSON = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;
const CACHE = new WeakMap();

function connectFor(ctx) {
    const config = ctx.config;
    if (!config) throw new Error('a tool needs ctx.config');
    if (CACHE.has(config)) return CACHE.get(config);
    const fetchImpl = ctx.fetch || globalThis.fetch;
    const base = String(config.networkInternalUrl || '').replace(/\/+$/, '');
    const oauth = config.oauth || {};
    const tokens = new Map();   // person → { token, until }

    async function tokenFor(person, signal) {
        const kept = tokens.get(person);
        if (kept && kept.until > Date.now()) return { ok: true, token: kept.token };
        const res = await fetchImpl(`${base}/oauth/token`, {
            method: 'POST', redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
            headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
            body: new URLSearchParams({ grant_type: 'client_credentials', client_id: String(oauth.clientId || 'actor'), client_secret: String(oauth.clientSecret || ''), audience: 'openvibe.network', scope: 'network.connect.act', on_behalf_of: person }).toString(),
        });
        const body = await res.json().catch(() => null);
        if (!res.ok || !body || !body.access_token) {
            if (body && body.error === 'consent_required') return { ok: false, error: 'you have not signed in to Actor on this account yet, so it cannot use your apps for you' };
            return { ok: false, error: `OpenVibe could not let Actor act for you just now (${res.status}${body && body.error ? ` ${body.error}` : ''})` };
        }
        tokens.set(person, { token: body.access_token, until: Date.now() + Math.min(KEEP_MS, Math.max(0, (Number(body.expires_in) || 300) * 1000 - 30_000)) });
        if (tokens.size > 5000) tokens.delete(tokens.keys().next().value);
        return { ok: true, token: body.access_token };
    }

    async function call(person, tool, args, { signal } = {}) {
        if (!PERSON.test(String(person || ''))) return { ok: false, error: 'your own apps need a signed-in person' };
        if (!base || !oauth.clientSecret) return { ok: false, error: 'Actor cannot reach your OpenVibe apps here (no Network client secret)' };
        if (tool !== 'search' && tool !== 'execute') return { ok: false, error: `no such Connect tool: ${tool}` };
        const t = await tokenFor(person, signal);
        if (!t.ok) return t;
        const res = await fetchImpl(`${base}/mcp/all`, {
            method: 'POST', redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000),
            headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18', authorization: `Bearer ${t.token}` },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: args } }),
        });
        if (res.status === 401 || res.status === 403) tokens.delete(person);
        const raw = await res.text();
        // An event stream's data line is the reply.
        const text = /^\s*\{/.test(raw) ? raw : ((/^data: ?(\{.*\})$/m.exec(raw) || [])[1] || '');
        let reply = null;
        try { reply = JSON.parse(text); } catch { reply = null; }
        if (!reply) return { ok: false, error: `Connect answered ${res.status}` };
        if (reply.error) return { ok: false, error: String(reply.error.message || 'Connect refused the call') };
        const result = reply.result || {};
        const words = (Array.isArray(result.content) ? result.content : []).filter((c) => c && c.type === 'text').map((c) => String(c.text || '')).join('\n');
        if (result.isError) return { ok: false, error: /grant|may only read|not allowed|no access/i.test(words) ? `${words} (you choose what Actor may use in each app on your Apps page: ${APPS_PAGE})` : words || 'the call failed' };
        return { ok: true, text: words, data: result.structuredContent != null ? result.structuredContent : null };
    }

    const out = { call, APPS_PAGE };
    CACHE.set(config, out);
    return out;
}

module.exports = { connectFor, APPS_PAGE };

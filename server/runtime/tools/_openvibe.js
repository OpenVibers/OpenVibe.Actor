'use strict';

/**
 * Shared OpenVibe service access for the tool modules (not a module itself: the registry skips files starting with
 * "_"). This is the part of the old server/agents/tools.js that every OpenVibe-backed tool needs, moved here so each
 * capability is its own file:
 *
 *   serviceFor(ctx) → { searchUrl, toolsUrl, webTokens, bot, computers, notify,
 *                       getJson, tools, inputSchema, findTools, runTool, searchOpenVibe, searchWeb }
 *
 * One instance is kept per config object, so the Tools catalog cache and the service-token client are shared across
 * every tool call of the process (they were one instance in the old runtime too).
 */

const { serviceAuth } = require('openvibe-contracts');
const { createRobots } = require('../../agents/robots');
const { createComputers } = require('../../agents/computers');
const { createNotifier } = require('../../notify/client');

const CATALOG_TTL_MS = 10 * 60_000;
const RESULT_CHARS = 6000;

const clip = (s, n = RESULT_CHARS) => (String(s).length > n ? `${String(s).slice(0, n)}\n…(clipped)` : String(s));
const json = (v) => clip(JSON.stringify(v));
/** The person a task is for, when it is a signed-in person ('user:usr_…' → 'usr_…'), else null. */
const personOf = (requester) => (typeof requester === 'string' && requester.startsWith('user:') ? requester.slice(5) : null);

const CACHE = new WeakMap();

function serviceFor(ctx) {
    const config = ctx.config;
    if (!config) throw new Error('a tool needs ctx.config');
    const key = config;
    if (CACHE.has(key)) return CACHE.get(key);
    const fetchImpl = ctx.fetch || globalThis.fetch;
    const log = ctx.log || console;
    const { searchUrl, toolsUrl } = config.services || {};
    // The web scope costs money past the open index, so it is asked as Actor (a service principal), never anonymously:
    // off without Actor's client secret.
    const webTokens = !searchUrl ? null : (config.oauth && config.oauth.clientSecret ? serviceAuth.createTokenClient({
        tokenUrl: `${config.networkInternalUrl}/oauth/token`, clientId: config.oauth.clientId, clientSecret: config.oauth.clientSecret,
        audience: 'openvibe.search', scope: 'search.query.delegate', fetchImpl,
    }) : null);
    const notify = createNotifier({ config, fetchImpl, log });
    const bot = createRobots({ config, fetchImpl });
    const pcs = createComputers({ config, fetchImpl });
    let catalog = null;
    let catalogAt = 0;
    const schemas = new Map();

    async function getJson(url, { signal, timeoutMs = 15_000, method = 'GET', body, headers = {} } = {}) {
        const sig = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
        const res = await fetchImpl(url, { method, headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}), 'user-agent': 'OpenVibeActor/1.0 (+https://openvibe.actor)', ...headers }, body: body ? JSON.stringify(body) : undefined, signal: sig });
        const text = await res.text();
        let data = null;
        try { data = JSON.parse(text); } catch { /* not JSON */ }
        return { status: res.status, ok: res.ok, data, text };
    }

    /** Tools' catalog: only tools with an API that run at once and that anyone may call. */
    async function tools({ signal } = {}) {
        if (!toolsUrl) return [];
        if (catalog && Date.now() - catalogAt < CATALOG_TTL_MS) return catalog;
        try {
            const r = await getJson(`${toolsUrl}/api/v1/tools`, { signal });
            const list = (r.data && Array.isArray(r.data.tools) ? r.data.tools : [])
                .filter((t) => t && t.api && t.execution === 'sync' && t.auth && t.auth.anonymous && /^[a-z0-9]+$/.test(t.id));
            if (list.length) { catalog = list; catalogAt = Date.now(); }
        } catch (err) { log.warn('[Actor] Tools catalog unavailable:', err && err.message); }
        return catalog || [];
    }

    async function inputSchema(id, { signal } = {}) {
        if (schemas.has(id)) return schemas.get(id);
        try {
            const r = await getJson(`${toolsUrl}/api/v1/tools/${id}/schema`, { signal });
            const s = r.data && r.data.$defs && r.data.$defs.input;
            if (s) schemas.set(id, s);
            return s || null;
        } catch { return null; }
    }

    const words = (s) => String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1);

    async function findTools(need, { signal } = {}) {
        const list = await tools({ signal });
        const q = new Set(words(need));
        const scored = list.map((t) => {
            const hay = words([t.id, t.name, t.summary, ...(t.keywords || [])].join(' '));
            let score = 0;
            for (const w of hay) if (q.has(w)) score += 1;
            if (q.has(t.id)) score += 5;
            return { t, score };
        }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score).slice(0, 6);
        const out = [];
        for (const { t } of scored) {
            out.push({ tool: t.id, name: t.name, does: t.summary, input: await inputSchema(t.id, { signal }), example: (t.examples && t.examples[0] && t.examples[0].input) || null });
        }
        return out;
    }

    async function runTool(id, input, { signal } = {}) {
        const list = await tools({ signal });
        if (!list.some((t) => t.id === id)) return { error: `no callable tool "${id}"; use find_tools to see which exist` };
        const r = await getJson(`${toolsUrl}/api/v1/tools/${id}/run`, { method: 'POST', body: { input: input && typeof input === 'object' ? input : {} }, signal, timeoutMs: 30_000 });
        if (!r.ok) return { error: (r.data && (r.data.detail || r.data.title || r.data.error)) || `Tools answered ${r.status}` };
        return r.data && r.data.result !== undefined ? r.data.result : r.data;
    }

    async function searchOpenVibe(query, { signal } = {}) {
        const q = encodeURIComponent(String(query || '').slice(0, 200));
        const r = await getJson(`${searchUrl}/api/v1/query?q=${q}&scopes=network&limit=8`, { signal });
        if (r.ok && r.data && Array.isArray(r.data.results)) {
            return r.data.results.slice(0, 8).map((x) => ({ title: x.title, summary: x.snippet, url: x.url, type: x.type, from: x.owner, published_at: x.published_at || null }));
        }
        if (r.status !== 404) return { error: `Search answered ${r.status}` };
        // A Search without the fabric (before Search#119).
        const old = await getJson(`${searchUrl}/api/v1/search?q=${q}&limit=8`, { signal });
        if (!old.ok || !old.data) return { error: `Search answered ${old.status}` };
        return (old.data.results || []).slice(0, 8).map((x) => ({ title: x.title, summary: x.summary, url: x.canonical_url, type: x.type, from: x.owner, published_at: x.published_at || null }));
    }

    /** The web, cited: each result keeps its URL, site and date, and the answer says which step found them. */
    async function searchWeb(query, person, { signal } = {}) {
        if (!webTokens) return { error: 'web search is not connected on this server' };
        const headers = { ...(await webTokens.authHeaders()), ...(person ? { 'x-ov-subject': person } : {}) };
        const r = await getJson(`${searchUrl}/api/v1/query`, { method: 'POST', body: { q: String(query || '').slice(0, 300), scopes: ['web'], limit: 6 }, headers, signal, timeoutMs: 30_000 });
        if (!r.ok || !r.data) return { error: (r.data && (r.data.detail || r.data.title)) || `Search answered ${r.status}` };
        const results = (Array.isArray(r.data.results) ? r.data.results : []).slice(0, 6)
            .map((x) => ({ title: x.title, summary: x.snippet, url: x.url, site: x.site, published_at: x.published_at || null }));
        const steps = ((r.data.route && r.data.route.explain) || []).filter((e) => e && e.scope === 'web' && e.answered).map((e) => e.step);
        return results.length ? { results, found_by: steps.join(', ') || null } : { results: [], note: 'Nothing found on the web for that; try other words.' };
    }

    const core = { searchUrl, toolsUrl, webTokens, notify, bot, pcs, getJson, tools, inputSchema, findTools, runTool, searchOpenVibe, searchWeb };
    CACHE.set(key, core);
    return core;
}

/** The sources a tool result cites: every { url, title } the service returned, never one the model made up. */
function sourcesOf(data) {
    const out = [];
    const seen = new Set();
    const walk = (v) => {
        if (!v || typeof v !== 'object') return;
        if (Array.isArray(v)) { for (const x of v) walk(x); return; }
        if (typeof v.url === 'string' && /^https?:\/\//.test(v.url) && !seen.has(v.url)) {
            seen.add(v.url);
            out.push({ url: v.url, title: String(v.title || v.site || '').slice(0, 200) });
        }
        for (const x of Object.values(v)) walk(x);
    };
    walk(data);
    return out.slice(0, 20);
}

module.exports = { serviceFor, sourcesOf, clip, json, personOf, RESULT_CHARS, CATALOG_TTL_MS };

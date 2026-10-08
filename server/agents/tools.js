'use strict';

/**
 * What the OpenVibe runtime can do, as model tools — every one of them an OpenVibe service's public API, called the
 * way any app would call it (never a private path, never a URL the model invents for Actor to fetch itself):
 *
 *   search_openvibe(query)      OpenVibe.Search: streams, clips, pastes, posts, wiki pages, threads across the network
 *   find_tools(need)            OpenVibe.Tools' catalog: which of its tools can do this, with each tool's input
 *   run_tool(tool, input)       OpenVibe.Tools' run API (POST /api/v1/tools/<id>/run): DNS, mail records, certificates,
 *                               headers, WHOIS, conversions, hashes, … — only tools the catalog marks callable by anyone
 *   read_page(url)              OpenVibe.Tools' page reader, when Tools offers it: a web page as text
 *
 * Tools' own guard decides what a tool may fetch (public addresses only, per-target limits); Actor adds nothing to
 * what an anonymous caller could already do, and every result is clipped before it goes back to the model.
 */

const CATALOG_TTL_MS = 10 * 60_000;
const RESULT_CHARS = 6000;

const clip = (s, n = RESULT_CHARS) => (s.length > n ? `${s.slice(0, n)}\n…(clipped)` : s);
const json = (v) => clip(JSON.stringify(v));

function createOpenVibeTools({ config, fetchImpl = globalThis.fetch, now = () => Date.now(), log = console }) {
    const { searchUrl, toolsUrl } = config.services;
    let catalog = null;
    let catalogAt = 0;
    const schemas = new Map();

    async function getJson(url, { signal, timeoutMs = 15_000, method = 'GET', body } = {}) {
        const sig = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
        const res = await fetchImpl(url, { method, headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}), 'user-agent': 'OpenVibeActor/1.0 (+https://openvibe.actor)' }, body: body ? JSON.stringify(body) : undefined, signal: sig });
        const text = await res.text();
        let data = null;
        try { data = JSON.parse(text); } catch { /* not JSON */ }
        return { status: res.status, ok: res.ok, data, text };
    }

    /** Tools' catalog: only tools with an API that run at once and that anyone may call. */
    async function tools({ signal } = {}) {
        if (catalog && now() - catalogAt < CATALOG_TTL_MS) return catalog;
        try {
            const r = await getJson(`${toolsUrl}/api/v1/tools`, { signal });
            const list = (r.data && Array.isArray(r.data.tools) ? r.data.tools : [])
                .filter((t) => t && t.api && t.execution === 'sync' && t.auth && t.auth.anonymous && /^[a-z0-9]+$/.test(t.id));
            if (list.length) { catalog = list; catalogAt = now(); }
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
        const r = await getJson(`${searchUrl}/api/v1/search?q=${encodeURIComponent(String(query || '').slice(0, 200))}&limit=8`, { signal });
        if (!r.ok || !r.data) return { error: `Search answered ${r.status}` };
        return (r.data.results || []).slice(0, 8).map((x) => ({ title: x.title, summary: x.summary, url: x.canonical_url, type: x.type, from: x.owner, published_at: x.published_at || null }));
    }

    /** The function definitions the runtime's model sees, and the dispatcher that runs one call. */
    async function definitions({ signal } = {}) {
        const list = await tools({ signal });
        const defs = [
            { type: 'function', function: { name: 'search_openvibe', description: 'Search everything published on the OpenVibe network (streams, clips, pastes, community posts, wiki pages, blog posts, threads). Returns titles, summaries and links.', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } } },
            { type: 'function', function: { name: 'find_tools', description: 'Find OpenVibe.Tools tools for a need (for example "mx records", "ssl certificate", "whois", "http headers", "base64", "hash"). Returns each tool id with its input schema and an example.', parameters: { type: 'object', properties: { need: { type: 'string' } }, required: ['need'] } } },
            { type: 'function', function: { name: 'run_tool', description: 'Run one OpenVibe.Tools tool by id with its input object (use find_tools first to see the input).', parameters: { type: 'object', properties: { tool: { type: 'string' }, input: { type: 'object' } }, required: ['tool', 'input'] } } },
        ];
        if (list.some((t) => t.id === 'read')) {
            defs.push({ type: 'function', function: { name: 'read_page', description: 'Read a public web page as text (title, description, main text, links). Use it for URLs the task gives or that a result links to.', parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } } });
        }
        return defs;
    }

    async function call(name, args, { signal } = {}) {
        const a = args && typeof args === 'object' ? args : {};
        try {
            if (name === 'search_openvibe') return json(await searchOpenVibe(a.query, { signal }));
            if (name === 'find_tools') return json(await findTools(a.need, { signal }));
            if (name === 'run_tool') return json(await runTool(String(a.tool || ''), a.input, { signal }));
            if (name === 'read_page') return json(await runTool('read', { url: String(a.url || ''), max_chars: 12000 }, { signal }));
            return json({ error: `unknown tool ${name}` });
        } catch (err) {
            if (signal && signal.aborted) throw err;
            return json({ error: `the call failed: ${(err && err.message) || err}`.slice(0, 300) });
        }
    }

    return { definitions, call, tools, findTools, runTool, searchOpenVibe };
}

module.exports = { createOpenVibeTools };

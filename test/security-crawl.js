'use strict';
/**
 * The crawler behind the security suites (roadmap WS-R task 5): lists every route of the booted
 * Wiki app (walking Express's router stack, so a route added later is crawled without anyone
 * listing it), fills route parameters with seeded values, and GETs each path as several people,
 * reporting any response whose body or headers carry a value that person must never see.
 * Not a test itself (no .test.js); used with test/helpers/boot.js.
 */

/** The path an Express 4 layer is mounted at ('' for app-level middleware), or null when it is a pattern. */
function mountPath(layer) {
    if (!layer.regexp || layer.regexp.fast_slash) return '';
    let src = layer.regexp.source.replace(/^\^/, '').replace(/\\\/\?\(\?=\\\/\|\$\)$/i, '').replace(/\/\?\(\?=\/\|\$\)$/i, '');
    let i = 0;
    src = src.replace(/\(\?:\(\[\^\\\/\]\+\?\)\)/g, () => `:${(layer.keys[i++] || {}).name || 'param'}`);
    src = src.replace(/\\\//g, '/').replace(/\\\./g, '.').replace(/\\-/g, '-');
    return /[\\^$()|[\]*+?]/.test(src) ? null : src;
}

/** Every route of the booted Codes app (captured from createApp): [{ path, methods }]. */
function listRoutes(app) {
    if (!app || !app._router) throw new Error('no Express app');
    const out = [];
    const walk = (stack, prefix) => {
        for (const layer of stack) {
            if (layer.route) {
                const methods = Object.keys(layer.route.methods).filter((m) => layer.route.methods[m]);
                for (const p of [].concat(layer.route.path)) if (typeof p === 'string') out.push({ path: prefix + p, methods });
            } else if (layer.handle && Array.isArray(layer.handle.stack)) {
                const mp = mountPath(layer);
                if (mp !== null) walk(layer.handle.stack, prefix + mp);
            } else {
                const mp = mountPath(layer);
                if (mp) out.push({ path: prefix + mp, methods: ['_all'] });
            }
        }
    };
    walk(app._router.stack, '');
    const seen = new Set();
    return out.filter((r) => { const k = `${r.methods.join(',')} ${r.path}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

/** Concrete paths for a template: candidate i of every parameter, for each i (no cross product). */
function expand(template, values) {
    const names = [];
    const t = `/${template.replace(/^\/+/, '')}`.replace(/\*/g, 'x').replace(/:([A-Za-z0-9_]+)\??(\([^)]*\))?/g, (m, n) => { names.push(n); return `:${n}`; });
    if (!names.length) return [t];
    const lists = names.map((n) => values(n));
    const width = Math.max(...lists.map((l) => l.length));
    const paths = new Set();
    for (let i = 0; i < width; i++) {
        let j = 0;
        paths.add(t.replace(/:([A-Za-z0-9_]+)/g, () => { const l = lists[j++]; return encodeURIComponent(String(l[Math.min(i, l.length - 1)])); }));
    }
    return [...paths];
}

/** Every GET path: each GET route expanded, also with `query` appended, plus `extra`. */
function getPaths(app, values, { query = '', extra = [] } = {}) {
    const paths = new Set();
    for (const r of listRoutes(app)) {
        if (!r.methods.includes('get') && !r.methods.includes('_all')) continue;
        for (const p of expand(r.path, values)) {
            paths.add(p);
            if (query && !p.includes('?')) paths.add(`${p}?${query}`);
        }
    }
    for (const p of extra) paths.add(p);
    return [...paths];
}

/** Which of `needles` ({ label: value }) a response carries: [{ label, where }]. */
function leaks(res, needles) {
    const found = [];
    const headerText = [...(res.headers && typeof res.headers.entries === 'function' ? res.headers.entries() : Object.entries(res.headers || {}))].map(([k, v]) => `${k}: ${v}`).join('\n');
    for (const [label, value] of Object.entries(needles)) {
        if (!value) continue;
        if (res.text && res.text.includes(value)) found.push({ label, where: 'body' });
        if (headerText.includes(value)) found.push({ label, where: 'headers' });
    }
    return found;
}

/** A fresh client address per request (TRUST_PROXY is on in tests): the per-address rate limits are not what is being read. */
let seq = 0;
function nextAddress() { seq++; return `10.${(seq >> 16) & 255}.${(seq >> 8) & 255}.${seq & 255}`; }

/**
 * GET every path as every person ({ who: user | token | null }) through t.get (a user object signs
 * in with the session cookie, a string is a bearer token). `needlesFor(who)` names what that person
 * must never see. Resolves { found, answered, statuses }.
 */
async function crawl(t, paths, people, needlesFor, { concurrency = 6 } = {}) {
    const found = [];
    const statuses = {};
    let answered = 0;
    for (const [who, as] of Object.entries(people)) {
        const needles = needlesFor(who);
        const queue = [...paths];
        await Promise.all(Array.from({ length: concurrency }, async () => {
            while (queue.length) {
                const p = queue.shift();
                let r;
                try { r = await t.get(p, { ...(as ? { as } : {}), headers: { 'x-forwarded-for': nextAddress() } }); } catch (e) { r = { status: 0, text: '', headers: {} }; }
                if (r.status) answered++;
                const cls = r.status ? `${String(r.status)[0]}xx` : 'none';
                statuses[cls] = (statuses[cls] || 0) + 1;
                for (const l of leaks(r, needles)) found.push(`${who}: GET ${p} → ${r.status} carries ${l.label} in its ${l.where}`);
            }
        }));
    }
    return { found, answered, statuses };
}

module.exports = { listRoutes, expand, getPaths, leaks, crawl, nextAddress };

'use strict';

/**
 * fetch_data: live data from a public API or data file (the owner, 11-18, a screenshot of an agent reading OVHcloud's
 * order catalog and stock API to answer "is it in stock, at what price": "improve our system so that it can do shit
 * like this"). read_page reads a page as text for people; this reads what a program reads: JSON, CSV or plain text.
 *
 *   input { url, pick?, find?, max_chars? }
 *     pick  a path into JSON: "plans", "plans.0.prices", "plans.*.planCode" (* is every item or key)
 *     find  words: only the JSON items (or the lines of text) that mention all of them are kept
 *
 * The address is one a person could open: https, a public host, no password in it, no redirect followed (a 3xx is
 * an answer that names where it points), 16 MB and 20 s at most, two at once (server/net/guarded-request.js, the same guard as the
 * MCP servers and A2A agents). Without pick or find a large answer comes back as its shape (keys, list lengths and a
 * first item) so the next call can ask for just the part it needs.
 */
const guarded = require('../../net/guarded-request');

// Real catalogs are big (OVHcloud's US eco catalog is 11.5 MB): read up to 16 MB, at most two at once in the whole
// process (each is parsed, narrowed and let go), so a burst of runs never holds hundreds of MB on production.
const MAX_BYTES = 16 * 1024 * 1024;
const AT_ONCE = 2;
let busy = 0;
const waiting = [];
const gate = async () => { if (busy >= AT_ONCE) await new Promise((ok) => waiting.push(ok)); busy += 1; };
const ungate = () => { busy -= 1; const next = waiting.shift(); if (next) next(); };
const TIMEOUT_MS = 20_000;
const MAX_CHARS = 12_000;
const MAX_FIND_HITS = 60;

/** The value at a dot path; `*` fans out over every item or key. */
function pickPath(value, path) {
    const parts = String(path || '').split('.').map((x) => x.trim()).filter(Boolean);
    let now = [value];
    let fanned = false;
    for (const part of parts) {
        const next = [];
        for (const v of now) {
            if (v == null || typeof v !== 'object') continue;
            if (part === '*') { fanned = true; next.push(...(Array.isArray(v) ? v : Object.values(v))); continue; }
            if (Array.isArray(v) && /^-?\d+$/.test(part)) { const i = Number(part); const item = v[i < 0 ? v.length + i : i]; if (item !== undefined) next.push(item); continue; }
            if (Object.prototype.hasOwnProperty.call(v, part)) next.push(v[part]);
        }
        now = next;
    }
    return fanned ? now : now[0];
}

/** Every item (of any list, at any depth) that mentions all the words; for a list of plain values, those values. */
function findIn(value, words) {
    const hits = [];
    const mentions = (v) => { const t = JSON.stringify(v).toLowerCase(); return words.every((w) => t.includes(w)); };
    const walk = (v, depth) => {
        if (hits.length >= MAX_FIND_HITS || v == null || typeof v !== 'object' || depth > 12) return;
        if (Array.isArray(v)) {
            for (const item of v) {
                if (hits.length >= MAX_FIND_HITS) return;
                if (!mentions(item)) continue;
                // The smallest item that still says it all: an item whose own lists hold the words is opened up.
                const inner = item && typeof item === 'object' ? findIn(item, words) : [];
                if (inner.length && inner.length < MAX_FIND_HITS && JSON.stringify(inner).length < JSON.stringify(item).length / 2 && !mentionsTop(item, words)) hits.push(...inner);
                else hits.push(item);
            }
            return;
        }
        for (const child of Object.values(v)) walk(child, depth + 1);
    };
    walk(value, 0);
    if (!hits.length && value && typeof value === 'object' && !Array.isArray(value) && mentions(value)) {
        // No list mentions them all: the object's own keys that do.
        const keys = Object.keys(value).filter((k) => mentions({ [k]: value[k] }));
        for (const k of keys.slice(0, MAX_FIND_HITS)) hits.push({ [k]: value[k] });
    }
    return hits.slice(0, MAX_FIND_HITS);
}
/** True when the item's own plain fields (not its lists) already mention every word. */
function mentionsTop(item, words) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
    const flat = Object.entries(item).filter(([, v]) => v == null || typeof v !== 'object').map(([k, v]) => `${k} ${v}`).join(' ').toLowerCase();
    return words.every((w) => flat.includes(w));
}

/** A large JSON answer's shape: its keys, how long its lists are, and one first item, so the next call can pick. */
function shapeOf(value, depth = 0) {
    if (value == null || typeof value !== 'object') return typeof value === 'string' && value.length > 80 ? `${value.slice(0, 80)}…` : value;
    if (depth >= 3) return Array.isArray(value) ? `[${value.length} items]` : `{${Object.keys(value).length} keys}`;
    if (Array.isArray(value)) return value.length ? { items: value.length, first: shapeOf(value[0], depth + 1) } : [];
    const out = {};
    for (const [k, v] of Object.entries(value).slice(0, 40)) out[k] = shapeOf(v, depth + 1);
    if (Object.keys(value).length > 40) out['…'] = `${Object.keys(value).length - 40} more keys`;
    return out;
}

const clip = (text, max) => (text.length > max ? { text: text.slice(0, max), more: text.length - max } : { text, more: 0 });

module.exports = {
    name: 'fetch_data',
    description: 'Read live data from a public API or data file (JSON, CSV or text) at an https address: prices, stock and availability, catalogs, status pages, feeds. '
        + 'Use it when a service publishes the answer as data (for example a provider\'s order catalog or availability API), and read_page for pages written for people. '
        + 'pick narrows JSON to a path ("plans", "plans.*.planCode", "items.0"); find keeps only the items or lines that mention all its words. '
        + 'A large answer without pick or find comes back as its shape: call again with pick or find. Cite the URL.',
    input: {
        type: 'object',
        properties: {
            url: { type: 'string', description: 'An https address of a public API or file.' },
            pick: { type: 'string', description: 'A dot path into the JSON; * is every item: "plans.*.prices".' },
            find: { type: 'string', description: 'Words every kept item or line must mention, like "sys-game-2 us-east".' },
            max_chars: { type: 'integer', minimum: 500, maximum: MAX_CHARS },
        },
        required: ['url'],
    },
    scope: 'public',
    needs: { files: 'none', network: true },   // plan 11c: the run's files and network settings gate it
    connector: 'openvibe',
    costUsd: 0,
    timeoutMs: TIMEOUT_MS + 5_000,
    pickPath, findIn, shapeOf,
    async run(input, ctx) {
        const url = String((input && input.url) || '').trim();
        const max = Math.min(MAX_CHARS, Math.max(500, Number(input && input.max_chars) || MAX_CHARS));
        const words = String((input && input.find) || '').toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
        await gate();
        try { return await this.read(url, words, max, input, ctx); } finally { ungate(); }
    },
    async read(url, words, max, input, ctx) {
        const request = (ctx && ctx.request) || guarded.request;
        let res;
        try {
            res = await request(url, { headers: { accept: 'application/json, text/csv, text/plain;q=0.9, */*;q=0.5' }, timeoutMs: TIMEOUT_MS, maxBytes: MAX_BYTES, signal: ctx && ctx.signal });
        } catch (err) {
            return { error: `${url} could not be read: ${(err && err.message) || 'network error'}` };
        }
        let host = url;
        try { host = new URL(url).hostname; } catch { /* the guard already refused a bad one */ }
        const sources = [{ url, title: host }];
        const status = Number(res.status) || 0;
        const type = String((res.headers && res.headers['content-type']) || '').toLowerCase();
        const body = Buffer.isBuffer(res.body) ? res.body.toString('utf8') : String(res.body || '');
        if (status >= 300 && status < 400) {
            const to = res.headers && res.headers.location;
            return { text: `${url} answered ${status}: it moved${to ? ` to ${to}` : ''}. Call again with that address if it is the one you want.`, data: { url, status, location: to || null }, sources };
        }
        let parsed;
        let isJson = /json/.test(type) || /^\s*[[{]/.test(body);
        if (isJson) { try { parsed = JSON.parse(body); } catch { isJson = false; } }
        if (/html/.test(type) && !isJson) {
            return { text: `${url} answered a web page (${status}), not data: use read_page for it.`, data: { url, status, type: 'html' }, sources };
        }
        const head = `${url} answered ${status}${status >= 400 ? ' (an error)' : ''}, ${isJson ? 'JSON' : (type.split(';')[0] || 'text')}, ${body.length} characters.`;
        if (!isJson) {
            let lines = body.split(/\r?\n/);
            const header = /csv/.test(type) || url.endsWith('.csv') ? lines[0] : null;
            if (words.length) lines = lines.filter((l) => words.every((w) => l.toLowerCase().includes(w)));
            const kept = (header && words.length ? [header, ...lines] : lines).join('\n');
            const c = clip(kept, max);
            return { text: `${head}${words.length ? ` ${lines.length} lines mention "${words.join(' ')}".` : ''}\n${c.text}${c.more ? `\n… ${c.more} more characters: narrow it with find.` : ''}`,
                data: { url, status, type: 'text', lines: lines.length, truncated: c.more > 0 }, sources };
        }
        let value = parsed;
        const picked = input && input.pick ? String(input.pick) : '';
        if (picked) value = pickPath(value, picked);
        if (picked && value === undefined) {
            return { text: `${head} Nothing is at "${picked}". Its shape:\n${JSON.stringify(shapeOf(parsed))}`, data: { url, status, shape: shapeOf(parsed) }, sources };
        }
        let note = '';
        if (words.length) {
            const hits = findIn(value, words);
            note = ` ${hits.length}${hits.length >= MAX_FIND_HITS ? '+' : ''} items mention "${words.join(' ')}".`;
            value = hits;
        }
        const whole = JSON.stringify(value);
        if (whole.length > max && !picked && !words.length) {
            const shape = shapeOf(value);
            return { text: `${head} Too big to read whole: its shape is below. Call again with pick (a path) or find (words).\n${JSON.stringify(shape).slice(0, max)}`,
                data: { url, status, shape, truncated: true }, sources };
        }
        const c = clip(whole, max);
        return { text: `${head}${picked ? ` At "${picked}".` : ''}${note}\n${c.text}${c.more ? `\n… ${c.more} more characters: narrow it with pick or find.` : ''}`,
            data: { url, status, picked: picked || null, found: words.length ? value.length : null, truncated: c.more > 0 }, sources };
    },
};

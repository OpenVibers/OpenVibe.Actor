'use strict';

/**
 * The evidence ledger (Actor v2, stage V2-1). Every tool result becomes one item, E1, E2, …; the answer cites them
 * as [E1]. The ledger is what the task page shows behind a citation chip and what the check reads a claim against:
 * the tool, its input, what it answered, its sources and when.
 *
 *   const ledger = createLedger({ now });
 *   const item = ledger.add({ tool, input, text, data, sources, at });
 *   ledger.items                     // [ { id:'E1', tool, input, text, data, sources, at } ]
 *   ledger.citations(answer)         // ['E3'] — the ids the answer cites, in order, existing only
 *   ledger.forPrompt(limit)          // the items as the model and the checker read them
 *
 * An item keeps `data` as returned (JSON) and `text` clipped for prompts; nothing here invents a fact.
 */

const DEFAULT_CLIP = 6000;

function createLedger({ now = () => Date.now(), clip = DEFAULT_CLIP } = {}) {
    const items = [];

    function add({ tool, input = null, text = '', data = null, sources = [], artifacts = [], at = null } = {}) {
        const id = `E${items.length + 1}`;
        const item = {
            id,
            tool: String(tool || 'tool'),
            input: input && typeof input === 'object' ? input : (input == null ? null : String(input)),
            text: String(text == null ? '' : text).slice(0, clip),
            data: data === undefined ? null : data,
            sources: Array.isArray(sources) ? sources.filter((s) => s && typeof s.url === 'string').slice(0, 20) : [],
            artifacts: Array.isArray(artifacts) ? artifacts.slice(0, 20) : [],
            at: at || new Date(now()).toISOString(),
        };
        items.push(item);
        return item;
    }

    const get = (id) => items.find((e) => e.id === id) || null;

    /** The evidence ids an answer cites, in order, once each; ids that do not exist are ignored. */
    function citations(text) {
        const seen = [];
        for (const m of String(text || '').matchAll(/\[(E\d+)\]/g)) {
            const id = m[1];
            if (!seen.includes(id) && get(id)) seen.push(id);
        }
        return seen;
    }

    /** The ledger as the model and the checker read it: one compact block per item, within `limit` characters. */
    function forPrompt(limit = 12000) {
        let room = limit;
        const lines = [];
        for (const e of items) {
            if (room <= 0) break;
            const head = `${e.id} [${e.tool}] input=${JSON.stringify(e.input)}`;
            const body = e.text.slice(0, Math.max(200, Math.min(2000, room - head.length - 2)));
            const line = `${head}\n${body}${e.text.length > body.length ? '\n…(clipped)' : ''}`;
            room -= line.length + 2;
            lines.push(line);
        }
        return lines.join('\n\n');
    }

    /** The item as the API result and the task page carry it (data clipped to keep a task record sane). */
    function forResult() {
        return items.map((e) => ({
            id: e.id, tool: e.tool, input: e.input, text: e.text.slice(0, 2000),
            sources: e.sources, at: e.at,
        }));
    }

    const sourceUrls = () => {
        const seen = [];
        for (const e of items) for (const s of e.sources) if (!seen.includes(s.url)) seen.push(s.url);
        return seen;
    };

    return { add, get, citations, forPrompt, forResult, sourceUrls, items, size: () => items.length };
}

module.exports = { createLedger, DEFAULT_CLIP };

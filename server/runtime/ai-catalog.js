'use strict';

/**
 * OpenVibe.AI's model catalog (PLAN G-P9), behind ACTOR_AI_CATALOG (off by default): the aliases a person may name
 * instead of a model, and the exact ids `org/model[:quant]@revision` that pin one artifact.
 *
 * GET /v1/models answers OpenAI's `{ object: 'list', data: [...] }`; every alias carries `dynamic: true` and every
 * registry model carries `id`, `availability` and `retail_rate.output_nano_usd_per_m` (integer nano-USD per million
 * tokens, D1). The list and the parser are AI Exchange P4 (OpenVibe.AI #289); with AI_MODEL_CATALOG off that route
 * answers only the legacy `openvibe` model, which means "fall back to Actor's usual model choice", never a one-row
 * picker. The same goes for an unreadable or empty answer: `parse()` returns null and the page keeps its plain field.
 *
 * Prices are converted from nano-USD to dollars with BigInt, so the description never rounds (D1: no floats).
 */
const CACHE_MS = 5 * 60_000;

// The dynamic aliases of D3, in the order a person should see them. `openvibe` is the legacy name of `openvibe/auto`
// and is not offered twice.
const ALIASES = ['openvibe/auto', 'openvibe/economy', 'openvibe/balanced', 'openvibe/fast', 'openvibe/private'];
const EXACT = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+(?::[A-Za-z0-9._-]+)?@[A-Za-z0-9._-]+$/;
const STATE = { available: 'ok', limited: 'warn', deprecated: 'warn', unavailable: 'off' };

/** Integer nano-USD per million tokens → exact USD per million, no float: 2500000000 → "2.50". */
function nanoToUsd(nano) {
    const text = String(nano == null ? '' : nano).trim();
    if (!/^\d+$/.test(text)) return null;
    const n = BigInt(text);
    const whole = n / 1_000_000_000n;
    let frac = (n % 1_000_000_000n).toString().padStart(9, '0').replace(/0+$/, '');
    if (frac.length < 2) frac = (frac + '00').slice(0, 2);
    return `${whole}.${frac}`;
}

/** The option's second line: the retail output price, or that the catalog does not state one. */
function priceDescription(nano) {
    const usd = nanoToUsd(nano);
    return usd == null ? 'Output price not listed' : `$${usd} per million output tokens`;
}

/**
 * Parse GET /v1/models: aliases first (all dynamic ones, in D3's order), then the exact ids. Registry models without
 * an exact id are left out: only an id that pins one artifact is a choice this picker can post unchanged.
 * Null means "today's behaviour": the flag is off, the answer is the legacy single `openvibe`, or it is unusable.
 */
function parse(body) {
    const list = Array.isArray(body) ? body
        : body && typeof body === 'object' && (Array.isArray(body.data) ? body.data : Array.isArray(body.models) ? body.models : null);
    if (!list) return null;
    const entries = [];
    const seen = new Set();
    for (const m of list) {
        if (!m || typeof m !== 'object') continue;
        const id = typeof m.id === 'string' ? m.id.trim() : '';
        if (!id || id.length > 256 || id === 'openvibe' || seen.has(id)) continue;
        const dynamic = m.dynamic === true || ALIASES.includes(id);
        if (!dynamic && !EXACT.test(id)) continue;
        const availability = typeof m.availability === 'string' && m.availability
            ? m.availability
            : (dynamic ? 'available' : (m.status === 'active' ? 'available' : 'unavailable'));
        const output = m.retail_rate && typeof m.retail_rate === 'object' ? m.retail_rate.output_nano_usd_per_m : null;
        seen.add(id);
        entries.push({
            id,
            dynamic,
            name: String(m.display_name || m.name || id),
            description: typeof m.description === 'string' ? m.description : null,
            policy: typeof m.policy === 'string' ? m.policy : null,
            // The router's capability is the guardrail when a live task has tools. Unknown stays unknown; a model
            // that explicitly refuses tool calls cannot be switched onto a tool-using Actor run.
            tool_calls: m.capabilities && typeof m.capabilities.tools === 'boolean' ? m.capabilities.tools : undefined,
            output_nano_usd_per_m: typeof output === 'string' && /^\d+$/.test(output) ? output : null,
            availability,
            state: STATE[availability] || (dynamic ? 'ok' : 'off'),
            // A deprecated artifact still runs (with a warning); one with no deployment is not a choice.
            available: availability !== 'unavailable',
        });
    }
    if (!entries.length) return null;
    const rank = (id) => { const i = ALIASES.indexOf(id); return i < 0 ? ALIASES.length : i; };
    const aliases = entries.filter((e) => e.dynamic).sort((a, b) => rank(a.id) - rank(b.id));
    return [...aliases, ...entries.filter((e) => !e.dynamic)];
}

module.exports = { CACHE_MS, ALIASES, parse, nanoToUsd, priceDescription };

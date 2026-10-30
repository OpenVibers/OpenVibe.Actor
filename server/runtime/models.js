'use strict';

/**
 * The tiered model layer (Actor v2, stage V2-1). Every model call in the one loop goes through one interface:
 *
 *   chat({ tier, messages, tools, json, maxTokens, signal, avoidFamily })
 *     → { message, text, toolCalls, usage, cost_usd, model, provider, family, tier }
 *
 * Tiers, never model names, in code:
 *   fast     classifying, the plan, small steps
 *   smart    the loop
 *   best     hard tasks and mode "best"
 *   check    the verifier, in another family than the writer
 *   vision   reading images and screens
 *
 * A tier is pinned by config (`ACTOR_MODEL_SMART=openai:gpt-5.1`; provider one of openai, deepseek, runtime,
 * compatible, local). Absent, the tier takes the strongest model each configured key offers: at boot the providers'
 * own model lists are read (`GET <base>/models`) and ranked by PREFERRED below, which carries the day it was checked.
 * A provider whose list cannot be read falls back to the model the operator configured for that endpoint, and a
 * provider that is not configured never appears. `smart` and `best` never take a mini/nano/flash model while the
 * key offers anything stronger.
 *
 * Money is usage × the rate card, as before (agents/providers.js priceUsage): the card is the operator's per-million
 * price when configured, else the published card for that provider (agents/catalog.js RATES). Every call's
 * cost_usd goes back to the caller, which meters it (the task's `meter`).
 *
 * createModels({ config, rates, fetchImpl, log, now }) → {
 *   warm(), chat(...), resolve(tier, { avoidFamily }), tierList(), modelList(), providerList(), tierConfig
 * }
 */

const { chatClient, priceUsage, ProviderError } = require('../agents/providers');

class ModelError extends Error {
    constructor(message, { code = 'actor.model.unavailable' } = {}) { super(message); this.code = code; }
}

// Ranked strongest first, checked against each provider's model list on 2026-10-30. A model the provider lists but
// this table does not know is still available by pinning it; it is not chosen by default (a fine-tune could be).
const PREFERRED_CHECKED = '2026-10-30';
const PREFERRED = {
    openai: ['gpt-5.1', 'gpt-5-pro', 'gpt-5', 'o4', 'o3', 'gpt-4.1', 'gpt-4o', 'gpt-5-mini', 'o4-mini', 'o3-mini', 'gpt-5-nano', 'gpt-4.1-mini', 'gpt-4o-mini'],
    deepseek: ['deepseek-v4-pro', 'deepseek-reasoner', 'deepseek-chat', 'deepseek-flash'],
    runtime: [],
    compatible: [],
    local: [],
};
// The fast tier takes a small, cheap chat model, in this order of preference; an unknown small model is the last resort.
const FAST_PREFERRED = ['gpt-5-nano', 'gpt-4o-mini', 'gpt-4.1-mini', 'gpt-5-mini', 'o4-mini', 'o3-mini'];
// Not chat models: embeddings, audio, images, moderation, research agents and dated snapshots (a moving alias is preferred).
const NOT_CHAT = /(embed|whisper|tts|audio|image|dall-e|moderation|transcribe|realtime|search-|research|codex|computer-use|-\d{4}-\d{2}-\d{2}$)/i;
const SMALL = /(nano|mini|flash|small|lite|tiny|(?:^|[^a-z])(?:1|3|7|8|13)b(?:$|[^a-z]))/i;

const TIERS = ['fast', 'smart', 'best', 'check', 'vision'];
const PROVIDERS = ['openai', 'deepseek', 'runtime', 'compatible', 'local'];

/** Parse a pinned tier value: "openai:gpt-5.1", or a bare model on the first configured provider. */
function parsePin(value) {
    const text = String(value || '').trim();
    if (!text) return null;
    const i = text.indexOf(':');
    if (i < 0) return { provider: null, model: text };
    return { provider: text.slice(0, i).trim(), model: text.slice(i + 1).trim() };
}

const trimSlash = (s) => String(s || '').replace(/\/+$/, '');
const clip = (s, n) => (String(s || '').length > n ? `${String(s).slice(0, n - 1)}…` : String(s || ''));

function createModels({ config, rates = {}, fetchImpl = globalThis.fetch, log = console, now = () => Date.now() } = {}) {
    const cfg = config.models || { tiers: {}, providerOrder: [], listTimeoutMs: 5000 };
    const p = config.providers || {};
    const order = (cfg.providerOrder && cfg.providerOrder.length ? cfg.providerOrder : PROVIDERS).filter((k) => PROVIDERS.includes(k));
    for (const k of PROVIDERS) if (!order.includes(k)) order.push(k);

    // What each endpoint is, and whether the operator configured it.
    const endpoints = {
        openai: { baseUrl: trimSlash(p.openai && p.openai.baseUrl), apiKey: (p.openai && p.openai.apiKey) || '', model: (p.openai && p.openai.model) || '', family: 'openai' },
        deepseek: { baseUrl: trimSlash(p.deepseek && p.deepseek.baseUrl), apiKey: (p.deepseek && p.deepseek.apiKey) || '', model: (p.deepseek && p.deepseek.model) || '', family: 'deepseek' },
        runtime: { baseUrl: trimSlash(p.runtime && p.runtime.url), apiKey: (p.runtime && p.runtime.apiKey) || '', model: (p.runtime && p.runtime.model) || '', family: 'runtime' },
        compatible: { baseUrl: trimSlash(p.compatible && p.compatible.baseUrl), apiKey: (p.compatible && p.compatible.apiKey) || '', model: (p.compatible && p.compatible.model) || '', family: 'compatible' },
        local: { baseUrl: trimSlash(p.local && p.local.url), apiKey: '', model: (p.local && p.local.model) || '', family: 'local' },
    };
    const listed = {};       // provider → the provider's model ids (as read at boot)
    const listErrors = {};   // provider → why its list could not be read
    let resolved = {};       // tier → descriptor
    let warmPromise = null;
    let warmed = false;

    /** The rate card for one provider: the operator's typed price first, else the published card. */
    function cardFor(key) {
        const base = rates[key] || {};
        const own = p[key] || {};
        return {
            input_usd_per_mtok: own.inputUsdPerMtok != null ? own.inputUsdPerMtok : (base.input_usd_per_mtok || 0),
            cached_usd_per_mtok: own.cachedUsdPerMtok != null ? own.cachedUsdPerMtok : base.cached_usd_per_mtok,
            output_usd_per_mtok: own.outputUsdPerMtok != null ? own.outputUsdPerMtok : (base.output_usd_per_mtok || 0),
            per_call_usd: base.per_call_usd || 0,
        };
    }

    function availability(key) {
        const e = endpoints[key];
        if (!e.baseUrl) return { available: false, reason: `no ${key} endpoint is configured on this server` };
        if ((key === 'openai' || key === 'deepseek') && !e.apiKey) return { available: false, reason: `no ${key} key is configured on this server` };
        if ((key === 'runtime' || key === 'local') && !e.model) return { available: false, reason: `no model is configured for the ${key} endpoint` };
        return { available: true };
    }

    async function listAt(key) {
        const e = endpoints[key];
        if (!e.baseUrl) return [];
        const url = `${e.baseUrl}/models`;
        const timeout = AbortSignal.timeout(Math.max(500, cfg.listTimeoutMs || 5000));
        try {
            const res = await fetchImpl(url, { headers: { accept: 'application/json', ...(e.apiKey ? { authorization: `Bearer ${e.apiKey}` } : {}) }, signal: timeout });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            const raw = Array.isArray(data) ? data : (data && (data.data || data.models)) || [];
            return raw.map((m) => (typeof m === 'string' ? m : (m && (m.id || m.name)) || '')).filter(Boolean);
        } catch (err) {
            listErrors[key] = `${(err && err.message) || err}`.slice(0, 200);
            return [];
        }
    }

    /** The provider's chat models, ranked strongest first: the table's order, then unknown ones alphabetically. */
    function candidatesFor(key) {
        const e = endpoints[key];
        const ids = (listed[key] || []).filter((m) => !NOT_CHAT.test(m));
        const known = PREFERRED[key].filter((m) => ids.includes(m));
        const rest = ids.filter((m) => !known.includes(m)).sort();
        let cands = [...known, ...rest];
        // A provider that listed nothing (or an endpoint with no list, such as a local server) is taken at the model
        // the operator configured. For runtime/compatible/local that model is their explicit choice and leads.
        if (!cands.length && e.model) cands = [e.model];
        else if (e.model && ['runtime', 'compatible', 'local'].includes(key)) cands = [e.model, ...cands.filter((m) => m !== e.model)];
        return cands;
    }

    function pick(tier, cands) {
        if (!cands.length) return null;
        if (tier === 'fast') {
            const small = cands.filter((m) => SMALL.test(m));
            const known = FAST_PREFERRED.find((m) => small.includes(m));
            return known || (small.length ? small[small.length - 1] : cands[cands.length - 1]);
        }
        const strong = cands.filter((m) => !SMALL.test(m));
        return (strong.length ? strong : cands)[0];
    }

    function descriptor(tier, key, model, extra = {}) {
        const av = availability(key);
        return {
            tier, provider: key, model, family: endpoints[key].family, available: av.available,
            ...(av.reason ? { reason: av.reason } : {}), rates: cardFor(key), ...extra,
        };
    }

    /** Resolve one tier from config or from the providers' lists. Never throws: an absent model is unavailable. */
    function resolveNow(tier, { avoidFamily = null } = {}) {
        const pin = parsePin((cfg.tiers || {})[tier]);
        if (pin) {
            const key = pin.provider || order.find((k) => availability(k).available) || order[0];
            if (!PROVIDERS.includes(key)) return { tier, provider: key, model: pin.model, family: key, available: false, reason: `unknown provider "${key}" (one of ${PROVIDERS.join(', ')})` };
            const av = availability(key);
            if (!av.available) return { tier, provider: key, model: pin.model, family: endpoints[key].family, available: false, reason: av.reason };
            if (!pin.model) return { tier, provider: key, model: '', family: endpoints[key].family, available: false, reason: `ACTOR_MODEL_${tier.toUpperCase()} names no model` };
            // A pinned model of the writer's own family is not a second family: for the check, another provider wins
            // when one offers a model. If none does, the pin stands (the verdict says it was not cross-family).
            if (!(avoidFamily && endpoints[key].family === avoidFamily)) return descriptor(tier, key, pin.model);
        }
        for (const key of order) {
            if (!availability(key).available) continue;
            if (avoidFamily && endpoints[key].family === avoidFamily) continue;
            const model = pick(tier, candidatesFor(key));
            if (model) return descriptor(tier, key, model);
        }
        if (pin) {
            const key = pin.provider || order.find((k) => availability(k).available) || order[0];
            const av = availability(key);
            return { tier, provider: key, model: pin.model, family: endpoints[key].family, available: av.available, ...(av.reason ? { reason: av.reason } : {}) };
        }
        return { tier, provider: order[0] || 'openai', model: '', family: order[0] || 'openai', available: false, reason: `no model is configured for the ${tier} tier` };
    }

    function resolveAll() {
        const out = {};
        for (const tier of TIERS) {
            // The check is the verifier, so by default it is the other family from the one that writes. At call time
            // resolve(tier, { avoidFamily }) narrows it again to the actual writer for this task.
            const opts = tier === 'check' && out.smart ? { avoidFamily: out.smart.family } : {};
            out[tier] = resolveNow(tier, opts);
        }
        return out;
    }

    /** Read every configured provider's model list once, then resolve the tiers from it. */
    function warm() {
        if (!warmPromise) {
            warmPromise = (async () => {
                const keys = order.filter((k) => availability(k).available);
                const lists = await Promise.all(keys.map(async (k) => [k, await listAt(k)]));
                for (const [k, ids] of lists) listed[k] = ids;
                resolved = resolveAll();
                warmed = true;
                if (log && log.log) {
                    const shown = TIERS.map((t) => `${t}=${resolved[t].provider}:${resolved[t].model || '—'}`).join(' ');
                    log.log(`[Actor] model tiers (preference checked ${PREFERRED_CHECKED}): ${shown}`);
                }
                return resolved;
            })();
        }
        return warmPromise;
    }

    /**
     * The descriptor for a tier; it may be unavailable (the caller decides whether that is fatal).
     * `avoidFamily` narrows the choice to a second family (the check). `anyFamily` asks for the tier's normal choice
     * with no narrowing at all (the check's fallback when no second family exists).
     */
    function resolve(tier, opts = {}) {
        if (!TIERS.includes(tier)) throw new ModelError(`unknown model tier "${tier}" (one of ${TIERS.join(', ')})`, { code: 'actor.model.tier' });
        if (opts.anyFamily) return resolveNow(tier, {});
        if (!warmed) return resolveNow(tier, opts);
        if (!opts.avoidFamily) return resolved[tier];
        // A second family is needed (the check): resolve against the lists again, skipping the writer's family.
        return resolveNow(tier, opts);
    }

    /** One model call. The caller checks the budget first and meters cost_usd after; this layer only prices it. */
    async function chat({ tier = 'smart', messages, tools = null, json = false, maxTokens = 4000, signal, avoidFamily = null, provider = null, model = null } = {}) {
        await warm();
        if (provider && !PROVIDERS.includes(provider)) throw new ModelError(`unknown model provider "${provider}"`, { code: 'actor.model.provider' });
        const d = provider && model ? descriptor(tier, provider, model) : resolve(tier, { avoidFamily });
        if (!d.available) throw new ModelError(d.reason || `no model is available for the ${tier} tier`, { code: 'actor.model.unavailable' });
        // DeepSeek reasons by default, which can spend a short verdict's whole budget on thinking and return no JSON.
        // The check is a short structured call, so its thinking is off; the loop keeps it on.
        const extraBody = d.provider === 'deepseek' && tier === 'check' ? { thinking: { type: 'disabled' } } : null;
        const client = chatClient({ baseUrl: endpoints[d.provider].baseUrl, apiKey: endpoints[d.provider].apiKey, model: d.model, rates: d.rates, fetchImpl, timeoutMs: 180_000, extraBody });
        const r = await client({ messages, tools, json, maxTokens, signal });
        return { ...r, cost_usd: r.cost_usd || priceUsage(d.rates, r.usage || {}), tier, provider: d.provider, family: d.family };
    }

    /** GET /api/v1/agents: the model each tier resolves to, and every model the keys reach (sync after warm). */
    function tierList() {
        const all = warmed ? resolved : resolveAll();
        return TIERS.reduce((out, tier) => {
            const d = all[tier];
            out[tier] = { provider: d.provider, model: d.model, family: d.family, available: d.available, ...(d.reason ? { reason: d.reason } : {}) };
            return out;
        }, {});
    }

    function modelList() {
        const out = [];
        const seen = new Set();
        const add = (key, model) => {
            const id = `${key}:${model}`;
            if (seen.has(id)) return;
            seen.add(id);
            out.push({ provider: key, model, family: endpoints[key].family });
        };
        for (const key of order) for (const model of candidatesFor(key)) add(key, model);
        // A tier the operator pinned is reachable whether or not the provider's list mentions it.
        for (const value of Object.values(cfg.tiers || {})) {
            const pin = parsePin(value);
            if (!pin || !pin.model) continue;
            const key = pin.provider || order.find((k) => availability(k).available) || order[0];
            if (!PROVIDERS.includes(key) || !availability(key).available) continue;
            add(key, pin.model);
        }
        return out;
    }

    return {
        warm, chat, resolve, tierList, modelList, resolveAll,
        tierConfig: cfg, PREFERRED, PREFERRED_CHECKED, TIERS,
        get warmed() { return warmed; },
        listErrors: () => ({ ...listErrors }),
    };
}

module.exports = { createModels, ModelError, parsePin, PREFERRED, PREFERRED_CHECKED, TIERS, PROVIDERS };

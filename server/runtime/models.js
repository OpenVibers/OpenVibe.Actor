'use strict';

/**
 * The tiered model layer (Actor v2, stage V2-1). Every model call in the one loop goes through one interface:
 *
 *   chat({ tier, messages, tools, json, maxTokens, signal, avoidFamily, latency, subject })
 *     → { message, text, toolCalls, usage, cost_usd, model, provider, family, tier, latency_class }
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
 *   warm(), chat(...), resolve(tier, { avoidFamily }), tierList(), modelList(), providerList(), tierConfig,
 *   aiCatalog()   OpenVibe.AI's aliases and exact ids (PLAN G-P9; ACTOR_AI_CATALOG, cached ~5 minutes)
 *   latencyClass()  the class a call here may ask for: 'batch' on OpenVibe.AI's router, 'background' otherwise
 * }
 */

const { AsyncLocalStorage } = require('node:async_hooks');
const { serviceAuth } = require('openvibe-contracts');
const { createClient: createSdkClient } = require('openvibe-sdk/core');
const { createAiClient } = require('openvibe-sdk/ai');
const { createServiceTokenClient } = require('openvibe-sdk/auth');
const { chatClient, priceUsage, readStream, ProviderError } = require('../agents/providers');

// openvibe-sdk/ai-meter (0.164.0+) is required when the process has a meter, so a build without it still boots.
let meterLib = null;
const meterLibOf = () => (meterLib || (meterLib = require('openvibe-sdk/ai-meter')));
const aiCatalogLib = require('./ai-catalog');

class ModelError extends Error {
    constructor(message, { code = 'actor.model.unavailable' } = {}) { super(message); this.code = code; }
}

// Ranked strongest first, checked against each provider's model list on 2026-10-30. A model the provider lists but
// this table does not know is still available by pinning it; it is not chosen by default (a fine-tune could be).
const PREFERRED_CHECKED = '2026-10-30';
const PREFERRED = {
    openai: ['gpt-5.1', 'gpt-5-pro', 'gpt-5', 'o4', 'o3', 'gpt-4.1', 'gpt-4o', 'gpt-5-mini', 'o4-mini', 'o3-mini', 'gpt-5-nano', 'gpt-4.1-mini', 'gpt-4o-mini'],
    // DeepSeek V4.1 Flash leads its family by the owner's choice (10-30: "don't use DeepSeek Pro … use Flash 4.1").
    deepseek: ['deepseek-flash', 'deepseek-v4-pro', 'deepseek-reasoner', 'deepseek-chat'],
    runtime: [],
    compatible: [],
    local: [],
};
// The fast tier takes a small, cheap chat model, in this order of preference; an unknown small model is the last resort.
const FAST_PREFERRED = ['gpt-5-nano', 'gpt-4o-mini', 'gpt-4.1-mini', 'gpt-5-mini', 'o4-mini', 'o3-mini'];
// Not chat models: embeddings, audio, images, moderation, research agents and dated snapshots (a moving alias is preferred).
const NOT_CHAT = /(embed|whisper|tts|audio|image|dall-e|moderation|transcribe|realtime|search-|research|codex|computer-use|-\d{4}-\d{2}-\d{2}$)/i;
const SMALL_RE = /(nano|mini|flash|small|lite|tiny|(?:^|[^a-z])(?:1|3|7|8|13)b(?:$|[^a-z]))/i;
// DeepSeek's Flash is its full V4.1 model, not a small one: it may take any tier (the owner's pick, 10-30).
const FULL = new Set(['deepseek-flash']);
const SMALL = { test: (m) => !FULL.has(String(m)) && SMALL_RE.test(String(m)) };

const TIERS = ['fast', 'smart', 'best', 'check', 'vision'];
const PROVIDERS = ['openai', 'deepseek', 'runtime', 'compatible', 'local'];
// The latency classes of a run (OpenVibe.AI, plan track BA): how long the caller may wait. A caller may ask for a
// slower class than the route's own, never a faster one.
const LATENCY_CLASSES = ['interactive', 'background', 'batch'];
// OpenVibe.AI (plan L55 C3): the gateway, NOT one of the operator's providers. It holds no key of its own. With
// ACTOR_AI_ROUTER on it IS the model layer (every tier is a run of ai.complete on AI's router); with it off, it is
// still reached when a person chooses their own key (sealed in AI's vault).
const AI_PROVIDER = 'openvibe-ai';

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

function createModels({ config, rates = {}, fetchImpl = globalThis.fetch, log = console, now = () => Date.now(), meter = null } = {}) {
    const cfg = config.models || { tiers: {}, providerOrder: [], listTimeoutMs: 5000 };
    const p = config.providers || {};
    const ai = config.ai || {};
    const order = (cfg.providerOrder && cfg.providerOrder.length ? cfg.providerOrder : PROVIDERS).filter((k) => PROVIDERS.includes(k));
    for (const k of PROVIDERS) if (!order.includes(k)) order.push(k);

    // What each endpoint is, and whether the operator configured it.
    const endpoints = {
        openai: { baseUrl: trimSlash(p.openai && p.openai.baseUrl), apiKey: (p.openai && p.openai.apiKey) || '', model: (p.openai && p.openai.model) || '', family: 'openai' },
        deepseek: { baseUrl: trimSlash(p.deepseek && p.deepseek.baseUrl), apiKey: (p.deepseek && p.deepseek.apiKey) || '', model: (p.deepseek && p.deepseek.model) || '', family: 'deepseek' },
        runtime: { baseUrl: trimSlash(p.runtime && p.runtime.url), apiKey: (p.runtime && p.runtime.apiKey) || '', model: (p.runtime && p.runtime.model) || '', family: 'runtime' },
        compatible: { baseUrl: trimSlash(p.compatible && p.compatible.baseUrl), apiKey: (p.compatible && p.compatible.apiKey) || '', model: (p.compatible && p.compatible.model) || '', family: 'compatible' },
        local: { baseUrl: trimSlash(p.local && p.local.url), apiKey: '', model: (p.local && p.local.model) || '', family: 'local' },
        // OpenVibe.AI: no api key (Actor holds none), no model of its own (AI routes), one family of its own.
        'openvibe-ai': { baseUrl: trimSlash(ai.url), apiKey: '', model: '', family: 'openvibe-ai' },
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
        if (key === AI_PROVIDER) {
            if (!e.baseUrl) return { available: false, reason: 'no OpenVibe.AI endpoint is configured on this server' };
            if (!ai.clientSecret) return { available: false, reason: 'Actor has no Network client secret for OpenVibe.AI' };
            return { available: true };
        }
        return { available: true };
    }

    // ── OpenVibe.AI's router (the AI layer of this product) ────────────────────────────────────────
    // With ACTOR_AI_ROUTER on, every tier is a name on AI's router (a policy alias, or an exact id) and no provider
    // key is read. The token is Actor's own service token; the person the task belongs to rides as on_behalf_of, so
    // their allowance and their Balance pay and the run is theirs.
    const routerModels = ai.models && typeof ai.models === 'object' ? ai.models : {};
    const routerOn = () => Boolean(ai.router) && availability(AI_PROVIDER).available;
    const routerModel = (tier) => String(routerModels[tier] || 'openvibe');
    let routerClients = null;
    function routerClient() {
        if (routerClients) return routerClients;
        if (!routerOn()) return null;
        const tokens = createServiceTokenClient({
            tokenUrl: `${config.networkInternalUrl || config.networkUrl}/oauth/token`,
            clientId: ai.clientId, clientSecret: ai.clientSecret,
            audience: ai.audience || 'openvibe.ai', scope: ai.scope || 'ai.run.create', fetch: fetchImpl,
        });
        const client = createSdkClient({ baseUrl: trimSlash(ai.url), getToken: async () => tokens.getToken(), fetch: fetchImpl, retries: 0 });
        routerClients = { tokens, client, ai: createAiClient(client, { baseUrl: trimSlash(ai.url) }) };
        return routerClients;
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
        // The router is the model layer: the tier's name on it is the policy (or the exact id), and AI says which
        // model actually ran. A pin above wins, so an operator can still move one tier back to a provider of theirs.
        if (routerOn()) return descriptor(tier, AI_PROVIDER, routerModel(tier), { available: true });
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

    // ── OpenVibe.AI (plan L55 C3): the person's own key ────────────────────────────────────────────
    // The model choice of the run in flight. The store is per async context, so every model call of that run —
    // the loop's own, the plan's, the check's — reads it, and no other run's does.
    const choiceStore = new AsyncLocalStorage();
    let aiTokens = null;

    // ── The AI meter (ai-metrics.md) ──────────────────────────────────────────────────────────────
    // The task a model call belongs to rides in an async store set by the task's engine: the id, the task's wall
    // clock and the call number. A call outside a task (a title, a page) is not metered; a call inside one always
    // is, and nothing here may delay or fail it. The client itself lives in server/runtime/ai-meter.js.
    const meterStore = new AsyncLocalStorage();

    /** Run the rest of the work as one task's model calls (the engine wraps a task in this). */
    function withMetering(meta, fn) {
        return meterStore.run({ ...(meta || {}) }, fn);
    }

    function currentMetering() {
        return meterStore.getStore() || null;
    }

    /** Start one call's record; null (never a throw) when there is no meter, no task or a bad shape. */
    function startMetered({ provider, model, place, streamed }) {
        if (!meter) return null;
        const m = currentMetering();
        if (!m || !m.taskId) return null;
        try {
            m.seq = (Number(m.seq) || 0) + 1;
            return meterLibOf().startCall({
                system: 'actor',
                turn_id: `${m.taskId}:${m.seq}`,
                provider: String(provider || 'unknown').slice(0, 120),
                model: String(model || 'unknown').slice(0, 200),
                operation: 'chat',
                task: m.task || 'actor.task',
                task_id: m.taskId,
                harness: 'openvibe',
                place: place === 'machine' ? 'machine' : 'provider',
                streamed: streamed === true,
                now,
            });
        } catch (err) {
            if (log && log.warn) log.warn('[Actor] AI meter call not started:', (err && err.message) || err);
            return null;
        }
    }

    /** The caller's onDelta, with the first piece of the answer marked on the call (TTFT). */
    function watchFirstToken(call, onDelta) {
        if (!call || typeof onDelta !== 'function') return onDelta;
        let first = false;
        return (text) => {
            if (!first) {
                first = true;
                try { call.firstToken(); } catch { /* a meter never drops a token */ }
            }
            return onDelta(text);
        };
    }

    /** The usage Actor keeps ({ input total, cached, output }) as the meter's uncached-input shape. */
    function meterUsage(usage) {
        const u = usage || {};
        const input = Math.max(0, Number(u.input) || 0);
        const cached = Math.max(0, Number(u.cached) || 0);
        return {
            input: Math.max(0, input - cached),
            output: Math.max(0, Number(u.output) || 0),
            reasoning: Math.max(0, Number(u.reasoning) || 0),
            cache_read: cached,
            cache_write: Math.max(0, Number(u.cache_write) || 0),
        };
    }

    /** End and record a succeeded call: its tools, its tokens, and on the task's last step its whole wall time. */
    function endMetered(call, { usage, toolCalls, taskEnd = false } = {}) {
        if (!call) return;
        try {
            const calls = Array.isArray(toolCalls) ? toolCalls.length : 0;
            for (let i = 0; i < calls; i++) call.tool();
            const m = currentMetering();
            const taskMs = taskEnd && calls === 0 && m && m.startedAt ? Math.max(0, now() - m.startedAt) : null;
            const record = call.end({
                usage: meterUsage(usage),
                outcome: 'succeeded',
                fallbacks: 0,
                ...(taskMs != null ? { task_ms: taskMs } : {}),
            });
            meter.record(record);
        } catch (err) {
            if (log && log.warn) log.warn('[Actor] AI meter record not written:', (err && err.message) || err);
        }
    }

    /** End and record a failed or cancelled call, with its class and never a message. */
    function failMetered(call, err, signal) {
        if (!call) return;
        try {
            const cancelled = Boolean((signal && signal.aborted) || (err && err.code === 'actor.task.cancelled'));
            const record = call.end({
                usage: null,
                outcome: cancelled ? 'cancelled' : 'failed',
                error_class: String((err && err.code) || 'actor.model.failed').slice(0, 60),
            });
            meter.record(record);
        } catch (e) {
            if (log && log.warn) log.warn('[Actor] AI meter record not written:', (e && e.message) || e);
        }
    }

    /** Actor's service token for OpenVibe.AI (audience openvibe.ai). Never a provider key. */
    function aiTokenClient() {
        if (aiTokens) return aiTokens;
        if (!ai.clientSecret) return null;
        aiTokens = serviceAuth.createTokenClient({
            tokenUrl: (config.networkInternalUrl || config.networkUrl) + '/oauth/token',
            clientId: ai.clientId, clientSecret: ai.clientSecret,
            audience: ai.audience, scope: ai.scope, fetchImpl,
        });
        return aiTokens;
    }

    /**
     * The providers the person allowed THIS service to use their own key for, and that they hold a key for: names
     * only, never key material. Null when AI does not say (or does not know) — the person may not have allowed us.
     */
    async function allowedKeys(subject) {
        const tokens = aiTokenClient();
        if (!tokens || !subject) return null;
        try {
            const res = await fetchImpl(trimSlash(ai.url) + '/api/v1/allowed-keys/' + encodeURIComponent(subject), {
                headers: { accept: 'application/json', ...(await tokens.authHeaders()) },
            });
            if (!res.ok) return null;
            const j = await res.json();
            return Array.isArray(j.providers) ? j.providers : null;
        } catch { return null; }
    }

    // ── OpenVibe.AI's model catalog (PLAN G-P9), behind ACTOR_AI_CATALOG ───────────────────────────
    // GET /v1/models, read with the same service token, for the aliases and exact ids a person may pick. Cached for
    // about five minutes, failures included: a failed read is today's behaviour for the next few minutes, never a
    // broken page or a retry storm.
    let aiCatalogCache = null;   // { at, entries } — entries null when the flag is on but the read failed/legacy
    let aiCatalogInFlight = null;
    const aiCatalogOn = () => Boolean(ai.catalog);   // D11 owner settings: read live

    /** The catalog's entries (aliases first, then exact ids), or null: today's model field, unchanged. */
    async function aiCatalog() {
        if (!aiCatalogOn()) return null;
        const at = now();
        if (aiCatalogCache && at - aiCatalogCache.at < aiCatalogLib.CACHE_MS) return aiCatalogCache.entries;
        if (aiCatalogInFlight) return aiCatalogInFlight;
        aiCatalogInFlight = (async () => {
            let entries = null;
            const tokens = aiTokenClient();
            if (tokens && ai.url) {
                try {
                    const res = await fetchImpl(trimSlash(ai.url) + '/v1/models', {
                        headers: { accept: 'application/json', ...(await tokens.authHeaders()) },
                        signal: AbortSignal.timeout(Math.max(500, cfg.listTimeoutMs || 5000)),
                    });
                    if (res.ok) entries = aiCatalogLib.parse(await res.json());
                } catch (err) {
                    if (log && log.warn) log.warn('[Actor] OpenVibe.AI model catalog:', (err && err.message) || err);
                }
            }
            aiCatalogCache = { at: now(), entries };
            return entries;
        })().finally(() => { aiCatalogInFlight = null; });
        return aiCatalogInFlight;
    }

    /** Run the rest of the work with this person's model choice in force. */
    function withChoice(choice, fn) {
        return choiceStore.run(choice || null, fn);
    }

    /** The choice of the run in flight, or null (today's behaviour). */
    function currentChoice() {
        return choiceStore.getStore() || null;
    }

    /**
     * One call through OpenVibe.AI, on the person's own key (plan L55 C3).
     *
     * Actor sends no key: AI holds it, sealed, and the request names the provider and the person
     * (x-openvibe-credential: <provider>:<subject>, the bare usr_… id AI expects — never "user:usr_…"). AI answers
     * with that key, or refuses: the person has no key for that provider yet, and the message says where to add it.
     */
    async function chatViaAi({ choice, messages, tools, json, maxTokens, signal, onDelta = null, policy = null }) {
        const tokens = aiTokenClient();
        if (!tokens) throw new ModelError('OpenVibe.AI is not configured on this server (no Network client secret)', { code: 'actor.model.unavailable' });
        const base = trimSlash(ai.url);
        let host = base;
        try { host = new URL(base).host; } catch { /* a plain host is fine */ }
        const provider = choice.provider;
        const body = {
            model: choice.model || 'openvibe',
            messages,
            ...(tools && tools.length ? { tools, tool_choice: 'auto' } : {}),
            ...(json ? { response_format: { type: 'json_object' } } : {}),
            max_tokens: Math.max(1, Math.min(Number(maxTokens) || 1500, 16000)),
            temperature: 0.2,
            // L37: a wish, not a pin. The provider is the one the person's own key is for, so the wish holds.
            prefer: { provider, ...(choice.model ? { model: choice.model } : {}) },
            // The content tier (the Exchange remake's "uncensored"). AI checks the named person's 18+ confirmation
            // before it answers on that tier, and refuses the tier without one.
            ...(policy === 'uncensored' ? { policy: 'uncensored' } : {}),
            // The person the run is for (on_behalf_of): AI's content tier is decided about a person, never about a
            // token, so the name travels with the request.
            ...(choice.subject ? { on_behalf_of: { type: 'user', id: String(choice.subject) } } : {}),
            // The answer streams in (plan L55 C2): AI passes the upstream's pieces on as they arrive.
            ...(onDelta ? { stream: true, stream_options: { include_usage: true } } : {}),
        };
        const timeout = AbortSignal.timeout(ai.timeoutMs || 180_000);
        const sig = signal ? AbortSignal.any([signal, timeout]) : timeout;
        let res;
        try {
            res = await fetchImpl(base + '/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    accept: onDelta ? 'text/event-stream' : 'application/json',
                    ...(await tokens.authHeaders()),
                    // The person's own key for this provider, and who the person is (the bare usr_… id).
                    'x-openvibe-credential': provider + ':' + choice.subject,
                },
                body: JSON.stringify(body),
                signal: sig,
            });
        } catch (err) {
            if (signal && signal.aborted) throw new ProviderError('cancelled', { code: 'actor.task.cancelled' });
            throw new ProviderError(err && err.name === 'TimeoutError' ? 'OpenVibe.AI did not answer in time' : 'OpenVibe.AI could not be reached', { code: 'actor.provider.unreachable' });
        }
        let raw = '';
        let answer = null;
        if (!res.ok || !onDelta) {
            raw = await res.text();
            try { answer = JSON.parse(raw); } catch { /* not JSON */ }
        }
        if (!res.ok) {
            const err = (answer && answer.error) || {};
            const code = String(err.code || '');
            const msg = String(err.message || clip(raw, 200) || ('HTTP ' + res.status));
            // No key for that provider yet: the person adds it at AI's own site, where it is sealed.
            if (res.status === 404 && code === 'credential.not_found') {
                throw new ModelError('Add your ' + provider + ' key at ' + host + ' first', { code: 'actor.model.no_own_key' });
            }
            // The person holds the key but has not allowed this service to use it (AI, plan L55 C3): AI's own detail
            // names the page where they allow it, so the person can act on it.
            if (res.status === 403 && code === 'ai.credential_not_allowed') {
                const said = String(msg || '').trim();
                throw new ModelError(said ? said.charAt(0).toUpperCase() + said.slice(1) : 'This service may not use your key yet', { code: 'actor.model.not_allowed' });
            }
            // An exact id AI refuses (PLAN G-P9): shown as that refusal, never retried on another model. AI's own
            // message says why (no such artifact, or one that cannot run this request).
            if ((res.status === 404 && code === 'ai.model_not_found') || (res.status === 400 && code === 'ai.model_unavailable')) {
                throw new ModelError(clip(msg, 300), { code });
            }
            throw new ProviderError('HTTP ' + res.status + ': ' + clip(msg, 300), { status: res.status, code: res.status === 429 ? 'actor.provider.rate_limited' : 'actor.provider.error' });
        }
        if (onDelta) answer = await readStream(res, onDelta, { signal, who: 'OpenVibe.AI' });
        if (!answer) throw new ProviderError('OpenVibe.AI answered with something that is not JSON');
        const first = (answer.choices && answer.choices[0]) || {};
        const message = first.message || { role: 'assistant', content: '' };
        const u = answer.usage || {};
        const usage = { input: u.prompt_tokens || 0, cached: 0, output: u.completion_tokens || 0 };
        // The run disclosure (D3', PLAN G-P9): x_openvibe already carries the cost; resolved_model names the artifact
        // that answered, so this is the model every existing model/cost record and page shows. Absent (the catalog is
        // off on AI), the upstream model name is kept exactly as before.
        const x = answer.x_openvibe && typeof answer.x_openvibe === 'object' ? answer.x_openvibe : {};
        const resolved = typeof x.resolved_model === 'string' && x.resolved_model.trim() ? x.resolved_model.trim() : null;
        return {
            message,
            text: typeof message.content === 'string' ? message.content : '',
            toolCalls: Array.isArray(message.tool_calls) ? message.tool_calls : [],
            finish: first.finish_reason || null,
            model: resolved || answer.model || choice.model || 'openvibe',
            resolved_model: resolved,
            usage,
            // AI prices the call (it knows the provider, and whether the person's own key paid for it).
            cost_usd: Number(x.cost_usd) || 0,
        };
    }
    /**
     * One call through OpenVibe.AI's router (ACTOR_AI_ROUTER): a run of ai.complete, Actor's service token, the
     * person's id in on_behalf_of. No provider key is touched here — AI holds the offers, prices and failover.
     *
     * The tier's name (openvibe/economy|balanced|fast|auto|private, or an exact id) is the policy. The answer's
     * model is whatever AI says ran, never the wish.
     *
     * `latency` asks for a class (OpenVibe.AI's classes, plan track BA): 'interactive' (today's default),
     * 'background' (the answer may take minutes) or 'batch' (it may take hours). A caller may only ask for a SLOWER
     * class than the route's own; AI clamps a faster one and says so. The classes live on AI's router, so a call that
     * goes through the person's own key asks for none.
     */
    async function chatViaRouter({ tier, messages = [], tools = null, json = false, maxTokens = 4000, signal, onDelta = null, subject = null, target = null, latency = null, policy = null }) {
        const c = routerClient();
        if (!c) throw new ModelError('OpenVibe.AI is not configured on this server (no Network client secret)', { code: 'actor.model.unavailable' });
        const input = {
            messages,
            model: (currentChoice() && currentChoice().model) || routerModel(tier),
            ...(tools && tools.length ? { tools, tool_choice: 'auto' } : {}),
            ...(json ? { response_format: { type: 'json_object' } } : {}),
            max_tokens: Math.max(1, Math.min(Number(maxTokens) || 1500, 16000)),
            temperature: 0.2,
            ...(ai.maxCostUsd != null ? { max_cost_usd: ai.maxCostUsd } : {}),
        };
        const body = {
            workflow: 'ai.complete', input,
            ...(subject ? { on_behalf_of: { type: 'user', id: String(subject) } } : {}),
            ...(target ? { target } : {}),
            // The content tier (the Exchange remake's "uncensored"): a control field on the run, never part of the
            // workflow's input. AI checks the named person's 18+ confirmation before it answers on that tier, and
            // refuses the tier without one. A run with no person never asks for it.
            ...(policy === 'uncensored' ? { policy: 'uncensored' } : {}),
        };
        // A slow class may take minutes (background) or hours (batch): the wait and the deadline are longer, and the
        // answer is polled for until it is ready.
        const slow = latency === 'background' || latency === 'batch';
        const timeoutMs = slow ? Math.max(600_000, Number(ai.timeoutMs) || 180_000) : Math.max(5000, Number(ai.timeoutMs) || 180_000);
        // The content tier rides in options.policy: AI reads it as a control field on the run (server/runs.js), the
        // same place the streamed path below puts it on the body it posts itself.
        const options = { cache: false, ...(latency ? { latency } : {}), ...(policy === 'uncensored' ? { policy: 'uncensored' } : {}) };
        body.options = options;   // the streamed path posts this body itself
        const sig = typeof AbortSignal.any === 'function'
            ? AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(timeoutMs)])
            : (signal || AbortSignal.timeout(timeoutMs));
        let run;
        try {
            if (onDelta) run = await routerStream(c, body, { onDelta, signal: sig });
            else {
                const created = await c.ai.runs.create('ai.complete', input, {
                    wait: Math.max(1000, Number(ai.waitMs) || 120_000),
                    ...(subject ? { onBehalfOf: { type: 'user', id: String(subject) } } : {}),
                    ...(target ? { target } : {}), options, signal: sig,
                });
                run = created.run;
                if (!['succeeded', 'cached', 'failed', 'cancelled'].includes(run.status)) run = await c.ai.runs.waitFor(run.id, { timeoutMs, signal: sig });
            }
        } catch (err) {
            if (signal && signal.aborted) throw new ProviderError('cancelled', { code: 'actor.task.cancelled' });
            if (err instanceof ProviderError || err instanceof ModelError) throw err;
            const code = String((err && err.code) || '');
            if (/timeout|deadline|aborted/.test(code)) throw new ProviderError('OpenVibe.AI did not answer in time', { code: 'actor.provider.unreachable' });
            throw new ProviderError(`OpenVibe.AI: ${String((err && (err.message || err.code)) || 'request failed').slice(0, 300)}`, { status: err && err.status, code: 'actor.provider.error' });
        }
        if (run.status === 'failed' || run.status === 'cancelled') {
            const e = (run.error && (run.error.detail || run.error.code)) || run.status;
            throw new ProviderError(`OpenVibe.AI's run ${run.status}: ${String(e).slice(0, 300)}`, { code: String((run.error && run.error.code) || 'actor.provider.error') });
        }
        if (!run.output || !Array.isArray(run.output.choices)) throw new ProviderError('OpenVibe.AI answered without a completion');
        const first = run.output.choices[0] || {};
        const message = first.message || { role: 'assistant', content: '' };
        const u = run.usage || {};
        return {
            message,
            text: typeof message.content === 'string' ? message.content : '',
            toolCalls: Array.isArray(message.tool_calls) ? message.tool_calls : [],
            finish: first.finish_reason || null,
            model: run.output.model || (run.provenance && run.provenance.model) || input.model,
            usage: { input: u.tokens_in || 0, cached: u.tokens_cached || 0, output: u.tokens_out || 0 },
            cost_usd: Number(u.cost_usd) || 0,
            // The class the run really took (AI says so; today's AI has no classes and says nothing).
            latency_class: (run && run.latency_class) || null,
        };
    }

    /** A normal hosted turn through Exchange, with the same service token and person attribution. */
    async function chatViaExchange({ tier, messages, tools, json, maxTokens, signal, onDelta, subject, policy }) {
        const c = routerClient();
        if (!c) throw new ModelError('OpenVibe.Exchange is not configured on this server', { code: 'actor.model.unavailable' });
        const body = {
            model: (currentChoice() && currentChoice().model) || routerModel(tier),
            messages,
            ...(tools && tools.length ? { tools, tool_choice: 'auto' } : {}),
            ...(json ? { response_format: { type: 'json_object' } } : {}),
            max_tokens: Math.max(1, Math.min(Number(maxTokens) || 1500, 16000)),
            temperature: 0.2,
            ...(ai.maxCostUsd != null ? { max_cost_usd: ai.maxCostUsd } : {}),
            ...(subject ? { on_behalf_of: { type: 'user', id: String(subject) } } : {}),
            ...(policy === 'uncensored' ? { policy: 'uncensored' } : {}),
            ...(onDelta ? { stream: true, stream_options: { include_usage: true } } : {}),
        };
        const sig = signal ? AbortSignal.any([signal, AbortSignal.timeout(ai.timeoutMs || 180_000)]) : AbortSignal.timeout(ai.timeoutMs || 180_000);
        let res;
        try {
            res = await fetchImpl(`${trimSlash(ai.exchangeUrl || 'https://api.openvibe.exchange')}/v1/chat/completions`, {
                method: 'POST',
                headers: { authorization: `Bearer ${await c.tokens.getToken()}`, 'content-type': 'application/json', accept: onDelta ? 'text/event-stream' : 'application/json' },
                body: JSON.stringify(body), signal: sig,
            });
        } catch (err) {
            if (signal && signal.aborted) throw new ProviderError('cancelled', { code: 'actor.task.cancelled' });
            throw new ProviderError(err && err.name === 'TimeoutError' ? 'OpenVibe.Exchange did not answer in time' : 'OpenVibe.Exchange could not be reached', { code: 'actor.provider.unreachable' });
        }
        if (!res.ok) {
            const answer = await res.json().catch(() => null);
            const err = (answer && answer.error) || {};
            throw new ProviderError(`OpenVibe.Exchange HTTP ${res.status}: ${clip(err.message || err.code || 'request failed', 300)}`, { status: res.status, code: res.status === 429 ? 'actor.provider.rate_limited' : 'actor.provider.error' });
        }
        const answer = onDelta ? await readStream(res, onDelta, { signal, who: 'OpenVibe.Exchange' }) : await res.json().catch(() => null);
        if (!answer || !Array.isArray(answer.choices)) throw new ProviderError('OpenVibe.Exchange answered without a completion');
        const first = answer.choices[0] || {};
        const message = first.message || { role: 'assistant', content: '' };
        const u = answer.usage || {};
        const x = answer.x_openvibe || {};
        return {
            message, text: typeof message.content === 'string' ? message.content : '',
            toolCalls: Array.isArray(message.tool_calls) ? message.tool_calls : [],
            finish: first.finish_reason || null,
            model: x.resolved_model || answer.model || body.model,
            usage: { input: u.prompt_tokens || 0, cached: 0, output: u.completion_tokens || 0 },
            cost_usd: Number(x.cost_usd) || 0,
            latency_class: null,
        };
    }

    /** The router's streamed run (POST /api/v1/runs?stream=1): `delta` events as they come, then the run. */
    async function routerStream(c, body, { onDelta, signal }) {
        const { response } = await c.client.request({
            method: 'POST', path: '/api/v1/runs', query: { stream: 1, wait: Math.max(1000, Number(ai.waitMs) || 120_000) },
            json: body, responseType: 'response', idempotencyKey: false, retries: 0, signal,
        });
        if (!response || !response.body) throw new ProviderError('OpenVibe.AI sent no stream');
        const decoder = new TextDecoder();
        let buf = '', event = 'message', data = [], run = null, failure = null;
        const take = () => {
            if (!data.length) { event = 'message'; return; }
            const raw = data.join('\n'); data = [];
            const name = event; event = 'message';
            let j = null;
            try { j = JSON.parse(raw); } catch { return; }
            if (name === 'delta' && j && typeof j.text === 'string') { try { onDelta(j.text); } catch { /* the listener's problem */ } }
            else if (name === 'run' && j && j.run) run = j.run;
            else if (name === 'error') failure = j || {};
        };
        for await (const chunk of response.body) {
            buf += decoder.decode(chunk, { stream: true });
            let i;
            while ((i = buf.indexOf('\n')) >= 0) {
                let line = buf.slice(0, i); buf = buf.slice(i + 1);
                if (line.endsWith('\r')) line = line.slice(0, -1);
                if (!line) { take(); continue; }
                if (line.startsWith('event:')) event = line.slice(6).trim();
                else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
            }
        }
        if (failure) throw new ProviderError(`OpenVibe.AI: ${String(failure.message || failure.code || 'stream error').slice(0, 300)}`, { code: String(failure.code || 'actor.provider.error') });
        if (!run) throw new ProviderError('OpenVibe.AI ended the stream without the run');
        return run;
    }

    /** One model call. The caller checks the budget first and meters cost_usd after; this layer only prices it. */
    async function chat({ tier = 'smart', messages = null, tools = null, json = false, maxTokens = 4000, signal, avoidFamily = null, provider = null, model = null, onDelta = null, latency = null, subject = null, policy = null, taskEnd = false } = {}) {
        // The person's own key (plan L55 C3): every model call of this run goes to OpenVibe.AI with it. That path has
        // no latency class: the classes live on AI's router.
        const choice = currentChoice();
        // The content tier of the run (one-engine slice): it rides on the choice, so every call of the run answers on
        // that tier. A caller may also name it directly.
        const policyOf = policy || (choice && choice.policy) || null;
        if (choice && choice.provider) {
            // OpenVibe.AI records every call it serves (ai.call.recorded@1) itself: Actor reporting it too would count
            // it twice. Only the calls Actor makes straight to a provider, below, are Actor's to report.
            const call = null;
            let r;
            try {
                r = await chatViaAi({ choice, messages, tools, json, maxTokens, signal, onDelta: watchFirstToken(call, onDelta), policy: policyOf });
            } catch (err) {
                failMetered(call, err, signal);
                throw err;
            }
            endMetered(call, { usage: r.usage, toolCalls: r.toolCalls, taskEnd });
            return { ...r, tier, provider: AI_PROVIDER, family: AI_PROVIDER, latency_class: null };
        }
        // The router (the AI layer): the tier names a policy on AI and the person's allowance pays. No provider key.
        if (routerOn() || (choice && choice.model && !choice.provider)) {
            const args = { tier, messages, tools, json, maxTokens, signal, onDelta, subject: subject || (choice && choice.subject), target: choice && choice.target, latency, policy: policyOf };
            // OpenVibe.AI records every call it serves (ai.call.recorded@1) itself: Actor reporting it too would count
            // it twice. Only the calls Actor makes straight to a provider, below, are Actor's to report.
            const call = null;
            args.onDelta = watchFirstToken(call, onDelta);
            let r;
            try {
                r = routerOn() && ai.exchangeRouter && !args.target && !args.latency
                    ? await chatViaExchange(args)
                    : await chatViaRouter(args);
            } catch (err) {
                failMetered(call, err, signal);
                throw err;
            }
            endMetered(call, { usage: r.usage, toolCalls: r.toolCalls, taskEnd });
            return { ...r, tier, provider: AI_PROVIDER, family: AI_PROVIDER };
        }
        await warm();
        // The content tier never reaches a provider directly: the adult tier is OpenVibe.AI's, and AI is the one that
        // checks the person's 18+ confirmation and labels the answer. A run that asks for it and is not on AI is
        // refused, never quietly answered on the standard tier.
        if (policyOf === 'uncensored') {
            throw new ModelError('the uncensored tier runs on OpenVibe.AI, which is not configured on this server', { code: 'actor.tier.unavailable' });
        }
        if (provider && !PROVIDERS.includes(provider)) throw new ModelError(`unknown model provider "${provider}"`, { code: 'actor.model.provider' });
        const d = provider && model ? descriptor(tier, provider, model) : resolve(tier, { avoidFamily });
        if (!d.available) throw new ModelError(d.reason || `no model is available for the ${tier} tier`, { code: 'actor.model.unavailable' });
        // DeepSeek reasons by default, which can spend a short verdict's whole budget on thinking and return no JSON.
        // The check is a short structured call, so its thinking is off; the loop keeps it on.
        const extraBody = d.provider === 'deepseek' && tier === 'check' ? { thinking: { type: 'disabled' } } : null;
        const client = chatClient({ baseUrl: endpoints[d.provider].baseUrl, apiKey: endpoints[d.provider].apiKey, model: d.model, rates: d.rates, fetchImpl, timeoutMs: 180_000, extraBody });
        const call = startMetered({ provider: d.provider, model: d.model, place: 'provider', streamed: Boolean(onDelta) });
        let r;
        try {
            r = await client({ messages, tools, json, maxTokens, signal, onDelta: watchFirstToken(call, onDelta) });
        } catch (err) {
            failMetered(call, err, signal);
            throw err;
        }
        endMetered(call, { usage: r.usage, toolCalls: r.toolCalls, taskEnd });
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
        // The router: each tier's name on AI (a policy or a pin), so the listing says what this server can reach.
        if (routerOn()) for (const tier of TIERS) add(AI_PROVIDER, routerModel(tier));
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

    /**
     * The latency class a call here may ask for (OpenVibe.AI's classes, plan track BA): 'batch' when the call goes
     * through AI's router (the classes live there), 'background' when it does not — the client's own key answers
     * with no class of its own.
     */
    function latencyClass() {
        return routerOn() ? 'batch' : 'background';
    }

    return {
        warm, chat, resolve, tierList, modelList, resolveAll, withChoice, currentChoice, allowedKeys, aiCatalog, latencyClass,
        withMetering, currentMetering,
        tierConfig: cfg, PREFERRED, PREFERRED_CHECKED, TIERS,
        get warmed() { return warmed; },
        listErrors: () => ({ ...listErrors }),
    };
}

module.exports = { createModels, ModelError, parsePin, PREFERRED, PREFERRED_CHECKED, TIERS, PROVIDERS, AI_PROVIDER, LATENCY_CLASSES };

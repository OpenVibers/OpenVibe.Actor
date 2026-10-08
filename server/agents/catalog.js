'use strict';

/**
 * The agent systems Actor routes a task to (ADR-044 §2): what each can do, its trust class, its rate card and whether
 * it can take a task now. GET /api/v1/agents is this list (actor.agent-list-result@1); the router turns each into an
 * openvibe-sdk/placement offer (toOffer) so the planner picks by capability first, then by the mode's objective.
 *
 * Rate cards are typed in from the provider's own price page by a person, with the page and the day it was checked;
 * a model never writes them. DeepSeek bills peak hours at these prices and off-peak at half; Actor charges the peak
 * price so a task never costs more than it was told.
 *
 * Task classes (server/agents/classify.js): answer (write or explain from what a model knows), lookup (facts about a
 * domain, address or site: DNS, mail, certificates, headers, ownership), research (read given pages or OpenVibe's own
 * content), web (needs a live web search: news, prices, anything recent), code (write or change code).
 */

const VERIFIED = '2026-10-08';
const DEEPSEEK_PRICES = 'https://api-docs.deepseek.com/quick_start/pricing';
const OPENAI_PRICES = 'https://developers.openai.com/api/docs/pricing';

/**
 * Typical tokens one task of each class uses on an agent, from the first runs (2026-10-08): the planner's cost
 * estimate is these at the rate card. The real cost is metered per call and is what the task is charged.
 */
const TYPICAL = {
    'openvibe-runtime': { in: 9000, out: 900, calls: 0, latencyMs: 25_000 },
    'openai-agent': { in: 11000, out: 700, calls: 2, latencyMs: 30_000 },
    'open-model': { in: 800, out: 400, calls: 0, latencyMs: 45_000 },
    codes: { in: 40000, out: 4000, calls: 0, latencyMs: 300_000 },
};

const AGENTS = [
    {
        id: 'openvibe-runtime',
        name: 'OpenVibe runtime',
        kind: 'openvibe-runtime',
        provider: 'OpenVibe',
        providerKey: 'deepseek',
        // The runtime is OpenVibe's code, but its model runs at DeepSeek: the task's text leaves OpenVibe.
        trust: 'external',
        quality: 'standard',
        can: ['task:answer', 'task:lookup', 'task:research', 'tool:openvibe-search', 'tool:openvibe-tools'],
        rate_card: { input_usd_per_mtok: 0.30, output_usd_per_mtok: 1.20, source: DEEPSEEK_PRICES, verified_at: VERIFIED },
        blurb: 'OpenVibe\'s own agent: a DeepSeek model that acts through OpenVibe services — search across the network, 160+ tools (DNS, mail, certificates, headers, conversions) and a page reader.',
    },
    {
        id: 'openai-agent',
        name: 'OpenAI agent',
        kind: 'agent-platform',
        provider: 'OpenAI',
        providerKey: 'openai',
        trust: 'external',
        quality: 'high',
        can: ['task:answer', 'task:research', 'task:web', 'tool:web-search'],
        rate_card: { input_usd_per_mtok: 0.25, output_usd_per_mtok: 2.00, per_call_usd: 0.01, source: OPENAI_PRICES, verified_at: VERIFIED },
        blurb: 'OpenAI\'s Responses agent with live web search: for anything recent, with sources. Searches cost one cent each on top of tokens.',
    },
    {
        id: 'open-model',
        name: 'Open model on OpenVibe',
        kind: 'open-model',
        provider: 'OpenVibe',
        providerKey: 'local',
        trust: 'first-party',
        quality: 'basic',
        can: ['task:answer'],
        rate_card: { input_usd_per_mtok: 0, output_usd_per_mtok: 0, source: 'https://openvibe.actor/agents#open-model', verified_at: VERIFIED },
        blurb: 'A small open model on OpenVibe\'s own server: nothing leaves OpenVibe. Private mode uses only this. Simple answers, no tools.',
    },
    {
        id: 'codes',
        name: 'OpenVibe.Codes',
        kind: 'codes',
        provider: 'OpenVibe',
        providerKey: 'codes',
        trust: 'first-party',
        quality: 'high',
        can: ['task:code'],
        rate_card: { input_usd_per_mtok: 0.30, output_usd_per_mtok: 1.20, source: 'https://openvibe.codes/harnesses', verified_at: VERIFIED },
        blurb: 'Coding work goes to OpenVibe.Codes, the coding-agent harness (Claude Code, Codex, OpenCode, DeepSeek and more). Hosted coding runs come with OpenVibe.Run; today, run openvibe-codes on your own machine.',
    },
];

/** Is the agent usable with this configuration? { available, reason }. */
function availability(agent, config) {
    const p = config.providers || {};
    if (agent.providerKey === 'deepseek') return p.deepseek && p.deepseek.apiKey ? { available: true } : { available: false, reason: 'no DeepSeek key is configured on this server' };
    if (agent.providerKey === 'openai') return p.openai && p.openai.apiKey ? { available: true } : { available: false, reason: 'no OpenAI key is configured on this server' };
    if (agent.providerKey === 'local') return p.local && p.local.url && p.local.model ? { available: true } : { available: false, reason: 'no open model is running on this server' };
    if (agent.providerKey === 'codes') return { available: false, reason: 'hosted coding runs need OpenVibe.Run sandboxes, which are not open yet; run openvibe-codes on your own machine (openvibe.codes/start)' };
    return { available: false, reason: 'no adapter' };
}

/** The model an agent runs with this configuration (for the listing and the task's explanation). */
function modelOf(agent, config) {
    const p = (config.providers || {})[agent.providerKey];
    return p && p.model ? p.model : undefined;
}

/** What one task of this agent typically costs, at its rate card (USD). */
function typicalCost(agentId) {
    const a = AGENTS.find((x) => x.id === agentId);
    const t = TYPICAL[agentId];
    if (!a || !t) return 0;
    const r = a.rate_card;
    return (t.in * r.input_usd_per_mtok + t.out * r.output_usd_per_mtok) / 1e6 + t.calls * (r.per_call_usd || 0);
}

/** GET /api/v1/agents: actor.agent-list-result@1. */
function list(config) {
    return AGENTS.map((a) => {
        const av = availability(a, config);
        const row = { id: a.id, name: a.name, kind: a.kind, provider: a.provider, trust: a.trust, can: [...a.can], rate_card: { ...a.rate_card }, typical_latency_ms: TYPICAL[a.id].latencyMs, available: av.available };
        const model = modelOf(a, config);
        if (model) row.model = model;
        if (av.reason) row.reason = av.reason;
        return row;
    });
}

/**
 * One platform.resource-offer@1 per agent for openvibe-sdk/placement. `quality:<tier>` is an offer capability so
 * best mode can require it; an unavailable agent is health down with its reason kept for the explanation.
 */
function toOffer(agent, config, { now = Date.now(), measured = {} } = {}) {
    const av = availability(agent, config);
    const t = TYPICAL[agent.id];
    const quality = agent.quality === 'high' ? ['quality:high', 'quality:standard'] : agent.quality === 'standard' ? ['quality:standard'] : [];
    return {
        offer_id: agent.id,
        kind: 'agent',
        provider: agent.provider,
        region: 'global',
        trust: agent.trust,
        capabilities: [...agent.can, ...quality],
        capacity: {},
        health: av.available ? { status: 'up' } : { status: 'down', reason: av.reason },
        pricing: { model: 'per-operation', unit: 'task', marginal_usd_per_unit: typicalCost(agent.id) },
        latency_ms: { run_p95: measured[agent.id] || t.latencyMs },
        updated_at: new Date(now).toISOString(),
    };
}

const byId = (id) => AGENTS.find((a) => a.id === id) || null;

/**
 * What each provider call is priced at (USD per million tokens; cached input at its own rate; per web search): the
 * rate cards above plus the cached-input prices from the same pages, and the checker model's own card.
 */
const RATES = {
    deepseek: { input_usd_per_mtok: 0.30, cached_usd_per_mtok: 0.006, output_usd_per_mtok: 1.20 },
    openai: { input_usd_per_mtok: 0.25, cached_usd_per_mtok: 0.025, output_usd_per_mtok: 2.00, per_call_usd: 0.01 },
    openaiCheck: { input_usd_per_mtok: 0.05, cached_usd_per_mtok: 0.005, output_usd_per_mtok: 0.40 },
    local: { input_usd_per_mtok: 0, output_usd_per_mtok: 0 },
};

module.exports = { AGENTS, TYPICAL, RATES, availability, list, toOffer, typicalCost, modelOf, byId, VERIFIED };

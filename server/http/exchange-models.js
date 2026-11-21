'use strict';

/**
 * The models on OpenVibe.Exchange, for pages that say "any model" (the Agents page; the owner, 11-21: "anything that's
 * DeepSeek reliant or reliant on a specific model … should be using OpenVibe.exchange … everything should be agnostic
 * of model or harness"). Exchange's public list (GET https://openvibe.exchange/api/v1/models), read at most every ten
 * minutes; a failed read keeps the last good one, and none at all is null (the page then links to Exchange alone).
 *
 *   createExchangeModels({ url?, fetchImpl?, now?, ttlMs? }).summary()
 *     → { count, providers, makerCount, tools, vision, makers: [{ id, name, q, n }] } | null
 */

const URL_DEFAULT = 'https://openvibe.exchange/api/v1/models';
const ID = /^[a-z0-9][a-z0-9._-]{0,60}$/;
// Who made a model, read from its name (the list's `provider` is the host that serves it, not the maker people pick
// by): [id, name, the word Exchange's search finds them by, test].
const MAKERS = [
    ['openai', 'OpenAI', 'gpt', /\b(gpt|o[1-9](-|$)|chatgpt|openai)/],
    ['anthropic', 'Anthropic', 'claude', /claude/],
    ['google', 'Google', 'gemini', /gemini|gemma/],
    ['deepseek', 'DeepSeek', 'deepseek', /deepseek/],
    ['meta', 'Meta', 'llama', /llama/],
    ['qwen', 'Qwen', 'qwen', /qwen|qwq/],
    ['mistral', 'Mistral', 'mistral', /mistral|mixtral|codestral|devstral|magistral/],
    ['xai', 'xAI', 'grok', /grok/],
    ['moonshot', 'Moonshot', 'kimi', /kimi|moonshot/],
    ['zhipu', 'Zhipu', 'glm', /\bglm/],
    ['minimax', 'MiniMax', 'minimax', /minimax/],
    ['nvidia', 'NVIDIA', 'nemotron', /nemotron/],
    ['microsoft', 'Microsoft', 'phi', /\bphi-?\d/],
    ['cohere', 'Cohere', 'command', /command-r|command-a|cohere/],
];
const makerOf = (m) => { const hay = `${m.model || ''} ${m.family || ''} ${m.name || ''}`.toLowerCase(); const hit = MAKERS.find(([, , , re]) => re.test(hay)); return hit || null; };

function createExchangeModels({ url = URL_DEFAULT, fetchImpl = globalThis.fetch, now = Date.now, ttlMs = 600_000 } = {}) {
    let kept = null;
    let inFlight = null;

    async function read() {
        const res = await fetchImpl(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(4000) });
        if (!res.ok) return null;
        const j = await res.json().catch(() => null);
        const all = j && Array.isArray(j.models) ? j.models : null;
        if (!all) return null;
        const live = all.filter((m) => m && m.status === 'available' && (!m.type || m.type === 'chat'));
        const hosts = new Set(live.map((m) => String(m.provider || '').toLowerCase()).filter((id) => ID.test(id)));
        const makers = new Map();
        for (const m of live) {
            const hit = makerOf(m);
            if (!hit) continue;
            const [id, name, q] = hit;
            const e = makers.get(id) || { id, name, q, n: 0 };
            e.n += 1;
            makers.set(id, e);
        }
        return {
            count: live.length,
            providers: hosts.size,
            makerCount: makers.size,
            tools: live.filter((m) => m.supports && m.supports.tools).length,
            vision: live.filter((m) => m.supports && m.supports.vision).length,
            makers: [...makers.values()].sort((a, b) => b.n - a.n || a.name.localeCompare(b.name)).slice(0, 14),
        };
    }

    async function summary() {
        if (kept && now() - kept.at < ttlMs) return kept.value;
        if (inFlight) return inFlight;
        inFlight = (async () => {
            try {
                const value = await read();
                if (value && value.count > 0) kept = { at: now(), value };
            } catch { /* the last good list, or none */ }
            return kept ? kept.value : null;
        })().finally(() => { inFlight = null; });
        return inFlight;
    }

    return { summary };
}

module.exports = { createExchangeModels, URL_DEFAULT };

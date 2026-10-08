'use strict';

/**
 * The model providers' HTTP APIs, metered per call. Two shapes:
 *
 *   chatClient(cfg)       OpenAI-compatible /chat/completions with tools (DeepSeek, an open model on llama.cpp, OpenAI
 *                         for checks): chat({ messages, tools, json, maxTokens, signal }) → { message, text, toolCalls,
 *                         usage, cost_usd }
 *   responsesAgent(cfg)   OpenAI's Responses API with its hosted web_search tool: run({ instructions, input, effort,
 *                         signal }) → { text, sources, searches, usage, cost_usd }
 *
 * The cost of a call is its usage at the rate card the caller passes (catalog.js): cached input at its own rate when
 * the provider reports it, and each web search at per_call_usd. A provider error becomes ProviderError with the
 * provider's status and a short message; the key never appears in it.
 */

class ProviderError extends Error {
    constructor(message, { status = 0, code = 'actor.provider.error' } = {}) { super(message); this.status = status; this.code = code; }
}

const clip = (s, n) => (String(s || '').length > n ? `${String(s).slice(0, n - 1)}…` : String(s || ''));

async function post(fetchImpl, url, apiKey, body, { signal, timeoutMs }) {
    const timeout = AbortSignal.timeout(timeoutMs);
    const sig = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let res;
    try {
        res = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) }, body: JSON.stringify(body), signal: sig });
    } catch (err) {
        if (signal && signal.aborted) throw new ProviderError('cancelled', { code: 'actor.task.cancelled' });
        throw new ProviderError(err && err.name === 'TimeoutError' ? 'the model did not answer in time' : 'the model provider could not be reached', { code: 'actor.provider.unreachable' });
    }
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    if (!res.ok) {
        const msg = (json && json.error && (json.error.message || json.error)) || clip(text, 200) || `HTTP ${res.status}`;
        throw new ProviderError(`HTTP ${res.status}: ${clip(msg, 300)}`, { status: res.status, code: res.status === 429 ? 'actor.provider.rate_limited' : 'actor.provider.error' });
    }
    if (!json) throw new ProviderError('the model provider answered with something that is not JSON');
    return json;
}

/** USD for a usage at a rate card: { input, cached, output } tokens, calls. */
function priceUsage(rates, { input = 0, cached = 0, output = 0, calls = 0 }) {
    const r = rates || {};
    const cachedRate = r.cached_usd_per_mtok != null ? r.cached_usd_per_mtok : (r.input_usd_per_mtok || 0);
    return (Math.max(0, input - cached) * (r.input_usd_per_mtok || 0) + cached * cachedRate + output * (r.output_usd_per_mtok || 0)) / 1e6 + calls * (r.per_call_usd || 0);
}

function chatClient({ baseUrl, apiKey, model, rates, fetchImpl = globalThis.fetch, timeoutMs = 90_000 }) {
    const reasoning = /^(gpt-5|o\d)/i.test(model || '');
    return async function chat({ messages, tools = null, json = false, maxTokens = 1500, signal } = {}) {
        const body = { model, messages };
        if (reasoning) { body.max_completion_tokens = maxTokens + 1024; body.reasoning_effort = 'minimal'; } else { body.max_tokens = maxTokens; body.temperature = 0.2; }
        if (tools && tools.length) { body.tools = tools; body.tool_choice = 'auto'; }
        if (json) body.response_format = { type: 'json_object' };
        const j = await post(fetchImpl, `${baseUrl}/chat/completions`, apiKey, body, { signal, timeoutMs });
        const choice = (j.choices && j.choices[0]) || {};
        const message = choice.message || { role: 'assistant', content: '' };
        const u = j.usage || {};
        const cached = u.prompt_cache_hit_tokens != null ? u.prompt_cache_hit_tokens : ((u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) || 0);
        const usage = { input: u.prompt_tokens || 0, cached, output: u.completion_tokens || 0 };
        return {
            message,
            text: typeof message.content === 'string' ? message.content : '',
            toolCalls: Array.isArray(message.tool_calls) ? message.tool_calls : [],
            finish: choice.finish_reason || null,
            model: j.model || model,
            usage,
            cost_usd: priceUsage(rates, usage),
        };
    };
}

/** Every URL the answer cites: url_citation annotations first, then bare links in the text. */
function sourcesOf(output, text) {
    const urls = [];
    for (const item of output || []) {
        if (item.type !== 'message') continue;
        for (const c of item.content || []) for (const a of c.annotations || []) if (a.type === 'url_citation' && a.url) urls.push(a.url);
    }
    for (const m of String(text || '').matchAll(/https?:\/\/[^\s)\]>"']+/g)) urls.push(m[0].replace(/[.,;:]+$/, ''));
    return [...new Set(urls.map((u) => u.replace(/\?utm_source=openai$/, '')))].slice(0, 20);
}

function responsesAgent({ baseUrl, apiKey, model, rates, fetchImpl = globalThis.fetch, timeoutMs = 150_000 }) {
    return async function run({ instructions, input, effort = 'low', maxOutputTokens = 4000, signal } = {}) {
        const body = { model, instructions, input, tools: [{ type: 'web_search' }], reasoning: { effort }, max_output_tokens: maxOutputTokens };
        const j = await post(fetchImpl, `${baseUrl}/responses`, apiKey, body, { signal, timeoutMs });
        const output = Array.isArray(j.output) ? j.output : [];
        const text = output.filter((o) => o.type === 'message').flatMap((o) => (o.content || []).map((c) => c.text || '')).join('\n').trim();
        const searches = output.filter((o) => o.type === 'web_search_call').map((o) => ({ kind: (o.action && o.action.type) || 'search', query: (o.action && (o.action.query || o.action.url)) || '' }));
        const u = j.usage || {};
        const usage = { input: u.input_tokens || 0, cached: (u.input_tokens_details && u.input_tokens_details.cached_tokens) || 0, output: u.output_tokens || 0, calls: searches.filter((s) => s.kind === 'search').length };
        if (j.status && j.status !== 'completed' && !text) throw new ProviderError(`the agent stopped (${j.status}${j.incomplete_details ? `: ${j.incomplete_details.reason}` : ''})`);
        return { text, sources: sourcesOf(output, text), searches, model: j.model || model, usage, cost_usd: priceUsage(rates, usage) };
    };
}

module.exports = { chatClient, responsesAgent, priceUsage, sourcesOf, ProviderError };

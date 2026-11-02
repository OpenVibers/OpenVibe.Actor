'use strict';

/**
 * The model providers' HTTP APIs, metered per call. Two shapes:
 *
 *   chatClient(cfg)       OpenAI-compatible /chat/completions with tools (DeepSeek, an open model on llama.cpp, OpenAI
 *                         for checks): chat({ messages, tools, json, maxTokens, signal, onDelta }) → { message, text,
 *                         toolCalls, usage, cost_usd }; with onDelta the answer streams and each piece of its text is
 *                         passed to onDelta as it arrives (the result is the same)
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

async function send(fetchImpl, url, apiKey, body, { signal, timeoutMs, accept = null }) {
    const timeout = AbortSignal.timeout(timeoutMs);
    const sig = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
        return await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json', ...(accept ? { accept } : {}), ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) }, body: JSON.stringify(body), signal: sig });
    } catch (err) {
        throw unreachable(err, signal, 'the model provider');
    }
}

/** A failed or aborted request as a ProviderError: cancelled by the run, timed out, or not reachable. */
function unreachable(err, signal, who) {
    if (signal && signal.aborted) return new ProviderError('cancelled', { code: 'actor.task.cancelled' });
    return new ProviderError(err && err.name === 'TimeoutError' ? `${who === 'the model provider' ? 'the model' : who} did not answer in time` : `${who} could not be reached`, { code: 'actor.provider.unreachable' });
}

function httpError(res, text, json) {
    const msg = (json && json.error && (json.error.message || json.error)) || clip(text, 200) || `HTTP ${res.status}`;
    return new ProviderError(`HTTP ${res.status}: ${clip(msg, 300)}`, { status: res.status, code: res.status === 429 ? 'actor.provider.rate_limited' : 'actor.provider.error' });
}

async function post(fetchImpl, url, apiKey, body, opts) {
    const res = await send(fetchImpl, url, apiKey, body, opts);
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    if (!res.ok) throw httpError(res, text, json);
    if (!json) throw new ProviderError('the model provider answered with something that is not JSON');
    return json;
}

/**
 * A Chat Completions answer streamed as server-sent events (stream: true), put back together in the shape of the
 * whole answer: { choices: [{ message, finish_reason }], model, usage, x_openvibe }. onDelta(text) is called with each
 * piece of the answer's text as it arrives (never with reasoning or tool calls); a throw in it is ignored. Tool calls
 * are joined by their index. An upstream that answers with plain JSON (it cannot stream) is read whole, and its text
 * is passed to onDelta once. A failure the stream itself carries ({ error }) is a ProviderError.
 */
async function readStream(res, onDelta, { signal, who = 'the model provider' } = {}) {
    const tell = (t) => { if (t && onDelta) { try { onDelta(t); } catch { /* the listener's problem, not the call's */ } } };
    const type = res.headers && typeof res.headers.get === 'function' ? res.headers.get('content-type') : '';
    if (!/text\/event-stream/i.test(type || '') || !res.body || typeof res.body[Symbol.asyncIterator] !== 'function') {
        const text = await res.text();
        let json = null;
        try { json = JSON.parse(text); } catch { /* not JSON */ }
        if (!json) throw new ProviderError(`${who} answered with something that is not JSON`);
        const m = (json.choices && json.choices[0] && json.choices[0].message) || {};
        tell(typeof m.content === 'string' ? m.content : '');
        return json;
    }
    let content = '', reasoning = '', finish = null, model = null, usage = null, x = null, failure = null;
    const tools = [];
    const take = (data) => {
        if (!data || data === '[DONE]') return;
        let j;
        try { j = JSON.parse(data); } catch { return; }
        if (j.error) { failure = j.error; return; }
        if (j.model) model = j.model;
        if (j.usage) usage = j.usage;
        if (j.x_openvibe) x = j.x_openvibe;
        const c = Array.isArray(j.choices) ? j.choices.find((ch) => (ch.index || 0) === 0) : null;
        if (!c) return;
        const d = c.delta || {};
        if (typeof d.content === 'string' && d.content) { content += d.content; tell(d.content); }
        if (typeof d.reasoning_content === 'string') reasoning += d.reasoning_content;
        for (const tc of Array.isArray(d.tool_calls) ? d.tool_calls : []) {
            const i = Number.isInteger(tc.index) ? tc.index : tools.length;
            const t = tools[i] || (tools[i] = { id: '', type: 'function', function: { name: '', arguments: '' } });
            if (tc.id) t.id = tc.id;
            if (tc.type) t.type = tc.type;
            const fn = tc.function || {};
            // Most providers send the name once; one that repeats it whole on every piece is not doubled.
            if (fn.name) t.function.name = t.function.name && !fn.name.startsWith(t.function.name) ? t.function.name + fn.name : fn.name;
            if (typeof fn.arguments === 'string') t.function.arguments += fn.arguments;
        }
        if (c.finish_reason) finish = c.finish_reason;
    };
    const decoder = new TextDecoder();
    let buf = '';
    const lines = () => {
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i).replace(/\r$/, '');
            buf = buf.slice(i + 1);
            if (line.startsWith('data:')) take(line.slice(5).trim());
        }
    };
    try {
        for await (const chunk of res.body) { buf += decoder.decode(chunk, { stream: true }); lines(); }
    } catch (err) {
        throw unreachable(err, signal, who);
    }
    buf += decoder.decode() + '\n';
    lines();
    if (failure) {
        const msg = typeof failure === 'string' ? failure : (failure.message || failure.code || 'error');
        const code = typeof failure === 'object' ? String(failure.code || '') : '';
        throw new ProviderError(clip(msg, 300), { code: /quota|rate|allowance/.test(code) ? 'actor.provider.rate_limited' : 'actor.provider.error' });
    }
    const calls = tools.filter(Boolean);
    const message = { role: 'assistant', content: content || (calls.length ? null : ''), ...(calls.length ? { tool_calls: calls } : {}), ...(reasoning ? { reasoning_content: reasoning } : {}) };
    return { choices: [{ index: 0, message, finish_reason: finish }], model, usage, ...(x ? { x_openvibe: x } : {}) };
}

/** USD for a usage at a rate card: { input, cached, output } tokens, calls. */
function priceUsage(rates, { input = 0, cached = 0, output = 0, calls = 0 }) {
    const r = rates || {};
    const cachedRate = r.cached_usd_per_mtok != null ? r.cached_usd_per_mtok : (r.input_usd_per_mtok || 0);
    return (Math.max(0, input - cached) * (r.input_usd_per_mtok || 0) + cached * cachedRate + output * (r.output_usd_per_mtok || 0)) / 1e6 + calls * (r.per_call_usd || 0);
}

/**
 * extraBody: provider-specific fields sent with every call (DeepSeek's `thinking: { type: 'disabled' }` for short
 * structured calls: its Flash model reasons by default, and a small max_tokens is spent on reasoning with no answer).
 */
function chatClient({ baseUrl, apiKey, model, rates, fetchImpl = globalThis.fetch, timeoutMs = 90_000, extraBody = null }) {
    const reasoning = /^(gpt-5|o\d)/i.test(model || '');
    return async function chat({ messages, tools = null, json = false, maxTokens = 1500, signal, onDelta = null } = {}) {
        const body = { model, messages, ...(extraBody || {}) };
        // "low" is the one effort every reasoning chat model we call accepts (`minimal` is not offered by gpt-5.1).
        if (reasoning) { body.max_completion_tokens = maxTokens + 1024; body.reasoning_effort = 'low'; } else { body.max_tokens = maxTokens; body.temperature = 0.2; }
        if (tools && tools.length) { body.tools = tools; body.tool_choice = 'auto'; }
        if (json) body.response_format = { type: 'json_object' };
        let j;
        if (onDelta) {
            // The answer streams in (plan L55 C2): each piece of its text goes to onDelta as the model writes it.
            body.stream = true;
            body.stream_options = { include_usage: true };
            const res = await send(fetchImpl, `${baseUrl}/chat/completions`, apiKey, body, { signal, timeoutMs, accept: 'text/event-stream' });
            if (!res.ok) { const text = await res.text(); let e = null; try { e = JSON.parse(text); } catch { /* not JSON */ } throw httpError(res, text, e); }
            j = await readStream(res, onDelta, { signal });
        } else j = await post(fetchImpl, `${baseUrl}/chat/completions`, apiKey, body, { signal, timeoutMs });
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

/** The answer's citations with their titles, as the Responses output carries them (url_citation annotations). */
function citationsOf(output) {
    const out = [];
    for (const item of output || []) {
        if (item.type !== 'message') continue;
        for (const c of item.content || []) {
            for (const a of c.annotations || []) {
                if (!a || a.type !== 'url_citation' || !a.url) continue;
                out.push({ url: String(a.url).replace(/\?utm_source=openai$/, ''), title: String(a.title || '') });
            }
        }
    }
    return out;
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
        return { text, sources: sourcesOf(output, text), citations: citationsOf(output), searches, model: j.model || model, usage, cost_usd: priceUsage(rates, usage) };
    };
}

module.exports = { chatClient, responsesAgent, priceUsage, sourcesOf, citationsOf, readStream, ProviderError };

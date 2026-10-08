'use strict';

/**
 * One adapter per agent system (ADR-044 §2): run(task) → { text, sources, model }. Each reports its steps through
 * `emit` (actor.task-event@1 output events) and every model call's cost through `meter(usd)` as it happens, so the
 * task's cost and the person's spend are true even when a run is cancelled half-way. `budgetLeft()` is checked
 * before every paid call; an adapter that would go over stops and says so.
 *
 *   openvibe-runtime   DeepSeek with OpenVibe's services as tools (agents/tools.js), up to MAX_TURNS model calls
 *   openai-agent       OpenAI's Responses agent with its hosted web search
 *   open-model         the open model on OpenVibe's own server, one call, no tools
 */
const { chatClient, responsesAgent, ProviderError } = require('./providers');
const { createOpenVibeTools } = require('./tools');

const MAX_TURNS = 10;

const today = () => new Date().toISOString().slice(0, 10);

const RUNTIME_SYSTEM = () => `You are OpenVibe Actor's runtime: an agent that completes a person's task by acting through OpenVibe's services.
Today is ${today()}. Your tools are OpenVibe's public APIs: search_openvibe (content on the OpenVibe network), find_tools then run_tool (OpenVibe.Tools: DNS, mail records, certificates, HTTP headers, WHOIS, conversions and 150 more), and read_page when it is offered.
Rules: use a tool whenever a fact can be checked with one instead of guessing; never invent a tool result, a URL or a number; if something cannot be found, say so plainly.
Finish with the answer itself in Markdown, short and direct, then a "Sources" list of the links or tools you relied on (tool results as "OpenVibe.Tools <tool id>").`;

const AGENT_INSTRUCTIONS = () => `You are working for OpenVibe Actor on a person's task. Today is ${today()}.
Search the web when the task needs anything current, and cite your sources inline as links. Answer in Markdown, short and direct, then list the sources you used.
Never invent facts, numbers or links; if something cannot be found, say so.`;

const summarize = (args) => {
    const a = args || {};
    const v = a.query || a.need || a.url || (a.tool ? `${a.tool} ${JSON.stringify(a.input || {})}` : JSON.stringify(a));
    return String(v).slice(0, 300);
};

function createAdapters({ config, rates, fetchImpl = globalThis.fetch, log = console, tools: toolsOverride }) {
    const p = config.providers;
    const ovTools = toolsOverride || createOpenVibeTools({ config, fetchImpl, log });

    const deepseek = p.deepseek.apiKey ? chatClient({ baseUrl: p.deepseek.baseUrl, apiKey: p.deepseek.apiKey, model: p.deepseek.model, rates: rates.deepseek, fetchImpl }) : null;
    // Classifying and checking are short, structured answers: DeepSeek's reasoning is off for them.
    const deepseekQuick = p.deepseek.apiKey ? chatClient({ baseUrl: p.deepseek.baseUrl, apiKey: p.deepseek.apiKey, model: p.deepseek.model, rates: rates.deepseek, fetchImpl, extraBody: { thinking: { type: 'disabled' } } }) : null;
    const openaiAgent = p.openai.apiKey ? responsesAgent({ baseUrl: p.openai.baseUrl, apiKey: p.openai.apiKey, model: p.openai.model, rates: rates.openai, fetchImpl }) : null;
    const local = p.local.url && p.local.model ? chatClient({ baseUrl: p.local.url, apiKey: '', model: p.local.model, rates: rates.local, fetchImpl, timeoutMs: 120_000 }) : null;

    async function runtime({ task, signal, emit, meter, budgetLeft }) {
        if (!deepseek) throw new ProviderError('the runtime has no model configured', { code: 'actor.agent.unavailable' });
        const tools = await ovTools.definitions({ signal });
        const messages = [{ role: 'system', content: RUNTIME_SYSTEM() }, { role: 'user', content: task }];
        let last = '';
        for (let turn = 1; turn <= MAX_TURNS; turn++) {
            if (budgetLeft() <= 0) throw new ProviderError('the task reached its budget before the runtime finished', { code: 'actor.budget.exceeded' });
            const finalTurn = turn === MAX_TURNS;
            // The model reasons before it answers, inside the same token budget: room for both.
            const r = await deepseek({ messages, tools: finalTurn ? null : tools, maxTokens: 4000, signal });
            await meter(r.cost_usd);
            messages.push(r.message);
            if (r.text && r.text.trim()) { last = r.text.trim(); }
            if (!r.toolCalls.length) return { text: last, sources: [], model: r.model };
            if (r.text && r.text.trim()) await emit({ step: 'text', text: r.text.trim().slice(0, 2000) });
            for (const call of r.toolCalls) {
                const name = call.function && call.function.name;
                let args = {};
                try { args = JSON.parse((call.function && call.function.arguments) || '{}'); } catch { args = {}; }
                await emit({ step: 'tool_call', tool: name, input: summarize(args) });
                const out = await ovTools.call(name, args, { signal });
                const isError = /^\{"error"/.test(out);
                await emit({ step: 'tool_result', tool: name, text: out.slice(0, 600), is_error: isError });
                messages.push({ role: 'tool', tool_call_id: call.id, content: out });
            }
        }
        if (!last) throw new ProviderError('the runtime used all its turns without an answer', { code: 'actor.agent.no_answer' });
        return { text: last, sources: [], model: p.deepseek.model };
    }

    async function openai({ task, mode, signal, emit, meter, budgetLeft }) {
        if (!openaiAgent) throw new ProviderError('no OpenAI key is configured', { code: 'actor.agent.unavailable' });
        if (budgetLeft() <= 0) throw new ProviderError('the task reached its budget', { code: 'actor.budget.exceeded' });
        await emit({ step: 'text', text: 'Searching the web…' });
        const r = await openaiAgent({ instructions: AGENT_INSTRUCTIONS(), input: task, effort: mode === 'best' ? 'medium' : 'low', signal });
        await meter(r.cost_usd);
        for (const s of r.searches) await emit({ step: 'tool_call', tool: s.kind === 'search' ? 'web_search' : `web_${s.kind}`, input: String(s.query || '').slice(0, 300) });
        if (!r.text) throw new ProviderError('the agent finished without an answer', { code: 'actor.agent.no_answer' });
        return { text: r.text, sources: r.sources, model: r.model };
    }

    async function openModel({ task, signal, meter }) {
        if (!local) throw new ProviderError('no open model is running on this server', { code: 'actor.agent.unavailable' });
        const r = await local({ messages: [{ role: 'system', content: `You are a helpful assistant. Today is ${today()}. Answer briefly in Markdown. If you are not sure, say so.` }, { role: 'user', content: task }], maxTokens: 700, signal });
        await meter(r.cost_usd);
        if (!r.text.trim()) throw new ProviderError('the open model gave no answer', { code: 'actor.agent.no_answer' });
        return { text: r.text.trim(), sources: [], model: r.model };
    }

    const run = { 'openvibe-runtime': runtime, 'openai-agent': openai, 'open-model': openModel };

    /** A cheap model of another family to classify and to check results (null when none is configured). */
    const checkers = {
        deepseek: deepseekQuick,
        openai: p.openai.apiKey ? chatClient({ baseUrl: p.openai.baseUrl, apiKey: p.openai.apiKey, model: p.openai.checkModel || 'gpt-5-nano', rates: rates.openaiCheck, fetchImpl }) : null,
        local,
    };

    return { run, checkers, tools: ovTools };
}

module.exports = { createAdapters, MAX_TURNS };

'use strict';
/**
 * Stand-ins for everything Actor calls besides the Network, in one HTTP server, each under its own path prefix:
 *
 *   /deepseek/chat/completions     the runtime's model, the classifier and a checker (OpenAI-compatible, tool calls)
 *   /openai/chat/completions       OpenAI's small checker model
 *   /openai/responses              OpenAI's Responses agent with web search
 *   /local/chat/completions        the open model on OpenVibe's server
 *   /tools/api/v1/tools[...]       OpenVibe.Tools: the catalog, a tool's schema, a run
 *   /search/api/v1/search          OpenVibe.Search
 *
 * Behaviour is set per test on `p.state`:
 *   cls          what the classifier answers (default: the heuristic's guess is not used; 'answer')
 *   checkOk      the checker's verdict (default true); a function (requestBody) → boolean also works
 *   runtime      'tool' (default: one run_tool mx call, then the answer), 'answer' (answer at once), 'fail' (HTTP 500),
 *                'hang' (never answers)
 *   openai       'ok' (default) | 'fail'
 *   local        'ok' (default) | 'fail'
 * `p.requests` lists { path, body } for every call, so a test can prove where a task's text went.
 */
const http = require('http');

async function startProviders() {
    const requests = [];
    const state = { cls: 'answer', checkOk: true, runtime: 'tool', openai: 'ok', local: 'ok', smart: 'tool', script: null, checkClaims: null, loopTool: null, judge: null, understand: null, adjudicate: null, hangAfterCalls: null };
    const hanging = new Set();
    let loopCalls = 0;

    const usage = (inp, out) => ({ prompt_tokens: inp, completion_tokens: out, prompt_cache_hit_tokens: 0 });
    const chatReply = (res, message, u = usage(1000, 100)) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ model: 'stand-in', choices: [{ message: { role: 'assistant', ...message }, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }], usage: u })); };
    const systemOf = (body) => String(((body.messages || [])[0] || {}).content || '');
    const userText = (body) => { const m = [...(body.messages || [])].reverse().find((x) => x.role === 'user'); return m ? String(m.content) : ''; };

    /** The claim-level check (runtime/check.js): {claims, ok}. A test may script the claims. */
    function checkReply(res, body, family) {
        if (state.checkerDown === family) return chatReply(res, { content: '' }, usage(300, 160));
        const ok = typeof state.checkOk === 'function' ? state.checkOk(body) : state.checkOk;
        const scripted = typeof state.checkClaims === 'function' ? state.checkClaims(body) : null;
        const claims = Array.isArray(scripted) ? scripted : (ok ? [] : [{ claim: 'a stand-in live fact with no evidence', kind: 'live', evidence: [], supported: false }]);
        return chatReply(res, { content: JSON.stringify({ claims, ok, reason: ok ? 'all claims grounded' : 'a live claim has no evidence' }) }, usage(300, 30));
    }

    /** The one loop (runtime/loop.js) on the stand-in: script it, or one tool call then an answer. */
    function loopReply(res, body) {
        loopCalls += 1;
        // A test can make the worker hang after N loop turns (stage V2-9: interrupt it, then resume from a checkpoint).
        if (state.hangAfterCalls != null && loopCalls > state.hangAfterCalls) { hanging.add(res); return undefined; }
        if (state.runtime === 'hang') { hanging.add(res); return undefined; }
        if (Array.isArray(state.script) && state.script.length) {
            const next = state.script.shift();
            return chatReply(res, next, usage(next.usage ? next.usage.input : 1200, next.usage ? next.usage.output : 200));
        }
        const tools = (body.messages || []).filter((m) => m.role === 'tool');
        if (!tools.length && state.smart !== 'answer') {
            const call = state.loopTool || { name: 'run_tool', arguments: JSON.stringify({ tool: 'mx', input: { target: 'openvibe.network' } }) };
            return chatReply(res, { content: 'Checking the records.', tool_calls: [{ id: 'call_1', type: 'function', function: call }] });
        }
        const said = tools.length ? String(tools[0].content || '').slice(0, 300) : '';
        return chatReply(res, { content: `Stand-in answer to: ${userText(body).slice(0, 200)}${said ? `\n\nTool said: ${said}` : ''}\n\nSources\n- OpenVibe.Tools mx` });
    }

    function judge(body, res, family) {
        const sys = systemOf(body);
        if (/sort one task/.test(sys)) return chatReply(res, { content: JSON.stringify({ class: state.cls }) }, usage(200, 10));
        if (/You verify an AI agent's answer/.test(sys)) return checkReply(res, body, family);
        // The understand pass (runtime/brain/understand.js, stage V2-8): a test scripts what the task means.
        if (/You read one task before an agent runs it/.test(sys)) {
            const u = typeof state.understand === 'function' ? state.understand(body) : state.understand;
            return chatReply(res, { content: JSON.stringify(u || { kind: 'answer', deliverable: 'Answer the task', risk: 'low', ambiguity: 0.1 }) }, usage(300, 80));
        }
        // A contested claim's judgement (runtime/adjudicate.js, stage V2-7b): a test scripts it in state.judge.
        if (/Two or more evidence items from an agent's tools disagree/.test(sys)) return chatReply(res, { content: state.judge || '{}' }, usage(400, 80));
        // The challenge read (runtime/brain/confidence.js, stage V2-8).
        if (/You check one claim against a counter-evidence search/.test(sys)) return chatReply(res, { content: state.adjudicate || JSON.stringify({ verdict: 'unclear', why: 'the stand-in found nothing either way' }) }, usage(300, 40));
        if (/check an AI agent's answer/.test(sys)) {
            if (state.checkerDown === family) return chatReply(res, { content: '' }, usage(300, 160));
            const ok = typeof state.checkOk === 'function' ? state.checkOk(body) : state.checkOk;
            return chatReply(res, { content: JSON.stringify({ ok, reason: ok ? 'answers the task' : 'it answers a different question' }) }, usage(300, 20));
        }
        return null;
    }

    const server = http.createServer((req, res) => {
        let raw = '';
        req.on('data', (d) => { raw += d; });
        req.on('end', () => {
            let body = {};
            try { body = raw ? JSON.parse(raw) : {}; } catch { body = {}; }
            const url = new URL(req.url, 'http://x');
            requests.push({ path: url.pathname, query: url.search, body, auth: req.headers.authorization || null });

            if (url.pathname === '/deepseek/chat/completions') {
                if (/You are OpenVibe Actor's agent/.test(systemOf(body))) return loopReply(res, body);
                if (body.response_format) {
                    const j = judge(body, res, 'deepseek');
                    if (j !== null) return j;
                    return chatReply(res, { content: JSON.stringify({ ok: true, claims: [], reason: 'stand-in' }) }, usage(300, 20));
                }
                if (state.runtime === 'fail') { res.writeHead(500, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: { message: 'stand-in model is down' } })); }
                if (state.runtime === 'hang') { hanging.add(res); return undefined; }
                const tools = (body.messages || []).filter((m) => m.role === 'tool');
                if (state.runtime === 'tool' && !tools.length && body.tools) {
                    return chatReply(res, { content: 'Checking the mail records.', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'run_tool', arguments: JSON.stringify({ tool: 'mx', input: { target: 'openvibe.network' } }) } }] });
                }
                return chatReply(res, { content: `Runtime answer to: ${userText(body)}${tools.length ? `\n\nTool said: ${tools[0].content.slice(0, 300)}` : ''}\n\nSources\n- OpenVibe.Tools mx` });
            }
            if (url.pathname === '/openai/chat/completions') {
                const sys = systemOf(body);
                if (/You are OpenVibe Actor's agent/.test(sys)) return loopReply(res, body);
                if (/You plan one task/.test(sys)) return chatReply(res, { content: JSON.stringify({ assumptions: [], steps: [{ goal: 'Do the task' }] }) }, usage(200, 30));
                const j = judge(body, res, 'openai');
                if (j !== null) return j;
                return chatReply(res, { content: 'nano answer' });
            }
            if (url.pathname === '/openai/responses') {
                if (state.openai === 'fail') { res.writeHead(429, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: { message: 'stand-in rate limit' } })); }
                res.writeHead(200, { 'content-type': 'application/json' });
                return res.end(JSON.stringify({
                    status: 'completed', model: 'gpt-5-mini-stand-in',
                    output: [
                        { type: 'web_search_call', status: 'completed', action: { type: 'search', query: 'stand-in search' } },
                        { type: 'message', content: [{ type: 'output_text', text: `Web answer to: ${String(body.input).slice(0, 200)} (see https://example.org/source)`, annotations: [{ type: 'url_citation', url: 'https://example.org/source', title: 'Example source' }] }] },
                    ],
                    usage: { input_tokens: 2000, output_tokens: 200, input_tokens_details: { cached_tokens: 0 } },
                }));
            }
            if (url.pathname === '/local/chat/completions') {
                const j = judge(body, res, 'local');
                if (j !== null) return j;
                if (state.local === 'fail') { res.writeHead(500, { 'content-type': 'application/json' }); return res.end('{}'); }
                return chatReply(res, { content: `Local answer to: ${userText(body)}` }, usage(100, 50));
            }
            if (url.pathname === '/tools/api/v1/tools') {
                res.writeHead(200, { 'content-type': 'application/json' });
                return res.end(JSON.stringify({ tools: [
                    { id: 'mx', name: 'MX Lookup', summary: 'Mail servers for a domain', keywords: ['mx records'], api: true, execution: 'sync', auth: { anonymous: true }, examples: [{ input: { target: 'example.com' } }] },
                    { id: 'yt', name: 'Video download', summary: 'A job tool', api: true, execution: 'job', auth: { anonymous: true } },
                ] }));
            }
            if (url.pathname === '/tools/api/v1/tools/mx/schema') {
                res.writeHead(200, { 'content-type': 'application/json' });
                return res.end(JSON.stringify({ $defs: { input: { type: 'object', properties: { target: { type: 'string' } }, required: ['target'] } } }));
            }
            if (url.pathname === '/tools/api/v1/tools/mx/run') {
                res.writeHead(200, { 'content-type': 'application/json' });
                return res.end(JSON.stringify({ state: 'succeeded', tool: 'mx', result: { data: { target: (body.input || {}).target, records: { MX: [{ exchange: 'mailserver.example.com', priority: 1 }] } } } }));
            }
            if (url.pathname === '/search/api/v1/query' && req.method === 'POST') {
                res.writeHead(200, { 'content-type': 'application/json' });
                return res.end(JSON.stringify({ results: [{ title: 'Node 24.5 release notes', snippet: 'What changed in the latest release', url: 'https://example.org/source', site: 'example.org', published_at: '2026-10-20' }], route: { explain: [{ scope: 'web', answered: true, step: 'open-index' }] } }));
            }
            if (url.pathname === '/search/api/v1/query' && req.method === 'GET') {
                res.writeHead(200, { 'content-type': 'application/json' });
                return res.end(JSON.stringify({ results: [{ scope: 'network', kind: 'document', title: 'A post', snippet: 'about things', url: 'https://openvibe.community/p/x', type: 'post', owner: 'community' }], route: { explain: [] } }));
            }
            if (url.pathname === '/search/api/v1/search') {
                res.writeHead(200, { 'content-type': 'application/json' });
                return res.end(JSON.stringify({ results: [{ title: 'A post', summary: 'about things', canonical_url: 'https://openvibe.community/p/x', type: 'post', owner: 'community' }] }));
            }
            res.writeHead(404); res.end();
            return undefined;
        });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${server.address().port}`;
    const env = {
        ACTOR_DEEPSEEK_API_KEY: 'ds-test-key', ACTOR_DEEPSEEK_BASE_URL: `${url}/deepseek`,
        ACTOR_OPENAI_API_KEY: 'oa-test-key', ACTOR_OPENAI_BASE_URL: `${url}/openai`,
        ACTOR_LOCAL_LLM_URL: `${url}/local`, ACTOR_LOCAL_LLM_MODEL: 'tiny-open',
        ACTOR_TOOLS_URL: `${url}/tools`, ACTOR_SEARCH_URL: `${url}/search`,
        ACTOR_MODEL_FAST: 'openai:gpt-5-nano', ACTOR_MODEL_SMART: 'openai:gpt-5.1', ACTOR_MODEL_BEST: 'openai:gpt-5.1',
        ACTOR_MODEL_CHECK: 'deepseek:deepseek-reasoner', ACTOR_MODEL_VISION: 'openai:gpt-5.1',
    };
    return {
        url, env, state, requests,
        loopCalls: () => loopCalls,
        reset() { loopCalls = 0; Object.assign(state, { cls: 'answer', checkOk: true, runtime: 'tool', openai: 'ok', local: 'ok', checkerDown: null, smart: 'tool', script: null, checkClaims: null, loopTool: null, judge: null, understand: null, adjudicate: null, hangAfterCalls: null }); requests.length = 0; },
        close: () => new Promise((r) => { for (const res of hanging) { try { res.destroy(); } catch { /* gone */ } } server.close(r); }),
    };
}

module.exports = { startProviders };

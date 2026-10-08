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
    const state = { cls: 'answer', checkOk: true, runtime: 'tool', openai: 'ok', local: 'ok' };
    const hanging = new Set();

    const usage = (inp, out) => ({ prompt_tokens: inp, completion_tokens: out, prompt_cache_hit_tokens: 0 });
    const chatReply = (res, message, u = usage(1000, 100)) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ model: 'stand-in', choices: [{ message: { role: 'assistant', ...message }, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }], usage: u })); };
    const userText = (body) => { const m = [...(body.messages || [])].reverse().find((x) => x.role === 'user'); return m ? String(m.content) : ''; };

    function judge(body, res) {
        const sys = String(((body.messages || [])[0] || {}).content || '');
        if (/sort one task/.test(sys)) return chatReply(res, { content: JSON.stringify({ class: state.cls }) }, usage(200, 10));
        if (/check an AI agent's answer/.test(sys)) {
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
                if (body.response_format) return judge(body, res);
                if (state.runtime === 'fail') { res.writeHead(500, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: { message: 'stand-in model is down' } })); }
                if (state.runtime === 'hang') { hanging.add(res); return undefined; }
                const tools = (body.messages || []).filter((m) => m.role === 'tool');
                if (state.runtime === 'tool' && !tools.length && body.tools) {
                    return chatReply(res, { content: 'Checking the mail records.', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'run_tool', arguments: JSON.stringify({ tool: 'mx', input: { target: 'openvibe.network' } }) } }] });
                }
                return chatReply(res, { content: `Runtime answer to: ${userText(body)}${tools.length ? `\n\nTool said: ${tools[0].content.slice(0, 300)}` : ''}\n\nSources\n- OpenVibe.Tools mx` });
            }
            if (url.pathname === '/openai/chat/completions') {
                const j = judge(body, res);
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
                        { type: 'message', content: [{ type: 'output_text', text: `Web answer to: ${String(body.input).slice(0, 200)} (see https://example.org/source)`, annotations: [{ type: 'url_citation', url: 'https://example.org/source' }] }] },
                    ],
                    usage: { input_tokens: 2000, output_tokens: 200, input_tokens_details: { cached_tokens: 0 } },
                }));
            }
            if (url.pathname === '/local/chat/completions') {
                const j = judge(body, res);
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
    };
    return {
        url, env, state, requests,
        reset() { Object.assign(state, { cls: 'answer', checkOk: true, runtime: 'tool', openai: 'ok', local: 'ok' }); requests.length = 0; },
        close: () => new Promise((r) => { for (const res of hanging) { try { res.destroy(); } catch { /* gone */ } } server.close(r); }),
    };
}

module.exports = { startProviders };

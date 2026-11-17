'use strict';

/**
 * Code mode (plan §AD.26; the owner, 2026-11-17, sending Cloudflare's Code Mode and Claude Code's: "Analyze and use to
 * improve openvibe"). A run with many tools offers the model two instead of all of them:
 *
 *   tools_search { query, limit? }   the run's own tools that match, each as a typed signature with its description
 *   tools_code   { code }            JavaScript that calls them: `const r = await tools.name({ … })`; only what the script
 *                                    returns (8 KB at most) and its console lines come back to the model
 *
 * so a run's tool list costs a few hundred tokens instead of every schema every turn, several calls chain in one step,
 * and a long answer is filtered in the script before any of it reaches the model's context.
 *
 * The script runs in server/runtime/code-sandbox.js: its own process under Node's permission model (it may read only its
 * own file), code generation from strings off in every realm, no environment, a 64 MB heap, 30 s and 30 tool calls.
 * Its only way out is `tools.<name>()`, and the loop decides each call exactly as if the model had made it (the same
 * approvals, budget, metering and evidence): runCode takes that one function, `call(name, input)`.
 *
 *   signatureOf(definition)              → "name(input: { url: string; models?: string[] }): Promise<any>"
 *   searchTools(definitions, query, n)   → [{ name, signature, description }]
 *   runCode(code, { names, call, limits }) → { ok, value, logs, calls, ms, error? }
 *   SEARCH_DEF, CODE_DEF                 the two tools as the model sees them
 */
const path = require('path');
const { fork } = require('child_process');

const SANDBOX = path.join(__dirname, 'code-sandbox.js');
const LIMITS = Object.freeze({ ms: 30000, calls: 30, resultBytes: 8192, memMb: 64 });

function typeOf(schema, depth = 0) {
    const s = schema && typeof schema === 'object' ? schema : {};
    if (Array.isArray(s.enum) && s.enum.length && s.enum.length <= 8) return s.enum.map((v) => JSON.stringify(v)).join(' | ');
    const t = Array.isArray(s.type) ? s.type.find((x) => x !== 'null') : s.type;
    if (t === 'string' || t === 'number' || t === 'boolean') return t;
    if (t === 'integer') return 'number';
    if (t === 'array') return `${typeOf(s.items, depth + 1)}[]`;
    if (t === 'object' || s.properties) {
        if (depth > 2) return 'object';
        const req = new Set(Array.isArray(s.required) ? s.required : []);
        const props = Object.entries(s.properties || {}).slice(0, 24);
        if (!props.length) return 'object';
        return `{ ${props.map(([k, v]) => `${/^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k)}${req.has(k) ? '' : '?'}: ${typeOf(v, depth + 1)}`).join('; ')} }`;
    }
    return 'any';
}

const nameOf = (d) => String((d && d.function && d.function.name) || '');
const jsName = (n) => n.replace(/-/g, '_');

function signatureOf(def) {
    const f = (def && def.function) || {};
    return `${jsName(String(f.name || ''))}(input: ${typeOf(f.parameters)}): Promise<any>`;
}

function searchTools(defs, query, limit = 12) {
    const words = String(query || '').toLowerCase().match(/[a-z0-9]{2,}/g) || [];
    const scored = (Array.isArray(defs) ? defs : []).map((d) => {
        const name = nameOf(d).toLowerCase();
        const text = `${name} ${String((d.function && d.function.description) || '').toLowerCase()}`;
        let score = 0;
        for (const w of words) { if (name.includes(w)) score += 3; else if (text.includes(w)) score += 1; }
        return { d, score };
    }).filter((x) => !words.length || x.score > 0).sort((a, b) => b.score - a.score);
    return scored.slice(0, Math.max(1, Math.min(30, Number(limit) || 12))).map(({ d }) => ({
        name: jsName(nameOf(d)), signature: signatureOf(d), description: String((d.function && d.function.description) || '').replace(/\s+/g, ' ').slice(0, 500),
    }));
}

const SEARCH_DEF = { type: 'function', function: {
    name: 'tools_search',
    description: 'Find the tools this run can use, by words ("audit a page", "dns", "my computers"). Answers each matching tool as a typed signature, the way tools_code calls it, with its description. Search before you write code.',
    parameters: { type: 'object', properties: { query: { type: 'string', description: 'what you want to do, in a few words' }, limit: { type: 'integer', description: 'how many tools at most (12 when left out)' } }, required: ['query'] },
} };
const CODE_DEF = { type: 'function', function: {
    name: 'tools_code',
    description: 'Run JavaScript that calls this run\'s tools and return only what you need. Each tool is an async function on `tools`, called with one object, the way tools_search shows it: `const page = await tools.openvibe_design_audit_page({ url }); return page.findings.filter((f) => f.severity === "high");`. Chain several calls, loop, filter and join in one step; console.log lines come back too. Only the returned value (8 KB at most) reaches you, so return what the answer needs, not whole pages. No network, files or require: only `tools`. 30 seconds and 30 tool calls a script. A tool that changes something asks the person first, as when you call it yourself.',
    parameters: { type: 'object', properties: { code: { type: 'string', description: 'the body of an async function: use await, and return the value you need' } }, required: ['code'] },
} };

function runCode(code, { names = [], call, limits = {} } = {}) {
    const lim = { ...LIMITS, ...limits };
    const started = Date.now();
    const allowed = new Map(names.map((n) => [jsName(String(n)), String(n)]));
    return new Promise((resolve) => {
        let calls = 0, settled = false;
        const child = fork(SANDBOX, [], {
            execArgv: ['--permission', `--allow-fs-read=${SANDBOX}`, '--disallow-code-generation-from-strings', `--max-old-space-size=${lim.memMb}`],
            env: {}, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], serialization: 'json',
        });
        const finish = (out) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            try { child.kill('SIGKILL'); } catch { /* gone */ }
            resolve({ ms: Date.now() - started, calls, ...out });
        };
        const timer = setTimeout(() => finish({ ok: false, error: `the script ran past ${Math.round(lim.ms / 1000)} s and was stopped`, logs: [] }), lim.ms);
        child.on('error', (err) => finish({ ok: false, error: `the sandbox did not start: ${err && err.message}`, logs: [] }));
        child.on('exit', (codeN) => finish({ ok: false, error: `the sandbox ended (${codeN}) before the script finished`, logs: [] }));
        child.on('message', async (m) => {
            if (!m || typeof m !== 'object') return;
            if (m.type === 'done') {
                if (!m.ok) return finish({ ok: false, error: String(m.error || 'the script failed'), logs: m.logs || [] });
                const json = String(m.json == null ? 'null' : m.json);
                if (Buffer.byteLength(json) > lim.resultBytes) return finish({ ok: false, error: `the script returned ${Buffer.byteLength(json)} bytes; return less than ${lim.resultBytes} (filter in the script)`, logs: m.logs || [] });
                let value = null;
                try { value = JSON.parse(json); } catch { value = json; }
                return finish({ ok: true, value, logs: m.logs || [] });
            }
            if (m.type !== 'call') return;
            const reply = (o) => { try { child.send({ type: 'result', id: m.id, json: JSON.stringify(o) }); } catch { /* the script is gone */ } };
            const real = allowed.get(jsName(String(m.name)));
            if (!real) return reply({ ok: false, error: `there is no tool ${m.name} in this run: tools_search lists them` });
            calls += 1;
            if (calls > lim.calls) return reply({ ok: false, error: `a script makes at most ${lim.calls} tool calls` });
            let input;
            try { input = JSON.parse(String(m.input || '{}')); } catch { return reply({ ok: false, error: 'the input is not JSON' }); }
            if (!input || typeof input !== 'object' || Array.isArray(input)) return reply({ ok: false, error: 'a tool takes one object' });
            try {
                const out = await call(real, input);
                reply(out && out.ok === false ? { ok: false, error: String(out.error || 'the tool failed') } : { ok: true, value: out && Object.prototype.hasOwnProperty.call(out, 'value') ? out.value : out });
            } catch (err) {
                reply({ ok: false, error: String((err && err.message) || err).slice(0, 400) });
            }
        });
        child.send({ type: 'run', code: String(code || ''), names: [...allowed.keys()].map((k) => allowed.get(k)) });
    });
}

module.exports = { runCode, signatureOf, searchTools, typeOf, SEARCH_DEF, CODE_DEF, LIMITS };

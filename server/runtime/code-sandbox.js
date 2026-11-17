'use strict';

/**
 * The code mode sandbox's own process (plan §AD.26; server/runtime/code-mode.js forks it). It is started under Node's
 * permission model (it may read only this file; no other files, processes, workers or addons), with code generation
 * from strings off in every realm (so a function from outside the script's context cannot be turned into a way out),
 * no environment, and a small heap. It runs one script in a fresh V8 context whose only way out is `tools.<name>()`:
 * each call is a message to the parent, which decides whether the call happens and answers with JSON text. Values cross
 * as JSON text, so nothing from this process's own realm is handed to the script.
 */
const vm = require('vm');

const pending = new Map();
let seq = 0;

// Nothing of the host's own reach stays in this process's globals for a script that found its way here.
for (const name of ['fetch', 'WebSocket', 'EventSource', 'XMLHttpRequest']) { try { delete globalThis[name]; } catch { /* not there */ } }

process.on('message', async (m) => {
    if (!m || typeof m !== 'object') return;
    if (m.type === 'result') {
        const done = pending.get(m.id);
        if (done) { pending.delete(m.id); done(typeof m.json === 'string' ? m.json : JSON.stringify({ ok: false, error: 'no answer' })); }
        return;
    }
    if (m.type !== 'run') return;
    const logs = [];
    let logBytes = 0;
    const bridge = (name, inputJson) => new Promise((resolve) => {
        const id = ++seq;
        pending.set(id, resolve);
        process.send({ type: 'call', id, name: String(name), input: String(inputJson) });
    });
    const log = (line) => {
        const s = String(line);
        if (logBytes > 4000) return;
        logBytes += s.length;
        logs.push(s.slice(0, 1000));
    };
    try {
        const context = vm.createContext({ __bridge: bridge, __log: log }, { codeGeneration: { strings: false, wasm: false } });
        const names = Array.isArray(m.names) ? m.names.filter((x) => typeof x === 'string' && /^[A-Za-z_][A-Za-z0-9_-]{0,80}$/.test(x)) : [];
        const env = vm.runInContext(`(() => {
            const bridge = __bridge, log = __log;
            delete globalThis.__bridge; delete globalThis.__log;
            const show = (v) => { if (typeof v === 'string') return v; try { return JSON.stringify(v); } catch { return String(v); } };
            const call = (name) => async (input) => {
                const r = JSON.parse(await bridge(name, JSON.stringify(input === undefined ? {} : input)));
                if (!r.ok) throw new Error(r.error || ('the tool ' + name + ' failed'));
                return r.value;
            };
            const tools = Object.freeze(Object.fromEntries(${JSON.stringify(names)}.map((n) => [n.replace(/-/g, '_'), call(n)])));
            const say = (...a) => log(a.map(show).join(' '));
            const console = Object.freeze({ log: say, info: say, warn: say, error: say });
            return { tools, console };
        })()`, context, { timeout: 1000 });
        const main = vm.runInContext(`(async (tools, console) => {\n${String(m.code || '')}\n})`, context, { timeout: 1000, filename: 'your-code.js' });
        const value = await main(env.tools, env.console);
        // The value as JSON text, made in the script's own realm: nothing of this process goes back with it.
        const json = vm.runInContext('(v) => { try { return JSON.stringify(v === undefined ? null : v); } catch (e) { return JSON.stringify(String(v)); } }', context)(value);
        process.send({ type: 'done', ok: true, json, logs });
    } catch (err) {
        process.send({ type: 'done', ok: false, error: String((err && err.message) || err).slice(0, 600), logs });
    }
});

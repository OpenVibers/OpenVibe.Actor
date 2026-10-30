'use strict';

/**
 * The tool registry (Actor v2, stage V2-1).
 *
 * Every capability is one module in this folder. Drop a file in and it is offered to the loop; no core file changes.
 * A module exports one plain object:
 *
 *   module.exports = {
 *     name: 'weather_now',                       // unique, snake_case
 *     description: 'Current weather …',          // what the model reads
 *     input: { type: 'object', properties: { place: { type: 'string' } }, required: ['place'] },  // JSON schema
 *     scope: 'public',                           // public | person | private-ok
 *     costUsd: 0,                                // estimated per call, for the planner
 *     timeoutMs: 15_000,
 *     async run(input, ctx) {                    // ctx: { fetch, signal, requester, emit, meter, config, log, artifacts }
 *       return { text: '…', data: { … }, sources: [{ url, title }], artifacts: [] };
 *     },
 *   };
 *
 * Scope says who may be offered the tool and where it may run:
 *   public      anyone; it may reach the public network
 *   person      only a signed-in person's task (the tool acts for them)
 *   private-ok  no network: it is the only kind private mode offers
 *
 * The loader validates every module's shape at boot. In tests a bad module throws (a broken file fails tests, never
 * production); in production it is logged and skipped. Fixtures, helpers (`_name.js`) and non-JavaScript files are
 * ignored, so a module may keep its own data beside it.
 *
 * createRegistry({ dir, log, strict, config, fetchImpl }) → {
 *   tools, byName, errors, definitions(ctx), run(name, input, ctx), get(name), has(name), report()
 * }
 * `definitions(ctx)` answers the OpenAI function tools the model may call, filtered by scope: private mode sees only
 * private-ok tools; a task with no signed-in requester never sees `person` tools. A module may also export
 * `available(ctx)` to narrow itself further (a service that is not connected this boot).
 */

const fs = require('fs');
const path = require('path');

const SCOPES = ['public', 'person', 'private-ok'];
const NAME = /^[a-z][a-z0-9_]{1,63}$/;
const MAX_TIMEOUT_MS = 900_000;
const DEFAULT_TIMEOUT_MS = 15_000;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Every problem with one module's shape; empty when it is a valid tool. */
function validateTool(mod) {
    const errors = [];
    if (!isObject(mod)) return ['the module must export an object'];
    if (typeof mod.name !== 'string' || !NAME.test(mod.name)) errors.push('name: snake_case, 2–64 characters, starting with a letter');
    if (typeof mod.description !== 'string' || !mod.description.trim()) errors.push('description: a non-empty string');
    if (!isObject(mod.input)) errors.push('input: a JSON schema object');
    else if (mod.input.type !== 'object') errors.push('input.type must be "object"');
    else if (mod.input.properties != null && !isObject(mod.input.properties)) errors.push('input.properties must be an object');
    if (!SCOPES.includes(mod.scope)) errors.push(`scope: one of ${SCOPES.join(', ')}`);
    if (mod.costUsd != null && !(Number.isFinite(mod.costUsd) && mod.costUsd >= 0)) errors.push('costUsd: a number, 0 or more');
    if (mod.timeoutMs != null && !(Number.isInteger(mod.timeoutMs) && mod.timeoutMs > 0 && mod.timeoutMs <= MAX_TIMEOUT_MS)) errors.push(`timeoutMs: an integer from 1 to ${MAX_TIMEOUT_MS}`);
    if (typeof mod.run !== 'function') errors.push('run: a function (input, ctx)');
    return errors;
}

/** The tool names a caller may see, by scope. */
function allowedBy(scope, { requester, mode } = {}) {
    if (mode === 'private') return scope === 'private-ok';
    if (scope === 'private-ok') return true;
    if (scope === 'person') return typeof requester === 'string' && requester.startsWith('user:');
    return scope === 'public';
}

/**
 * Load and validate every module in `dir` (default: this folder). `strict` throws on the first bad module (tests and
 * boot in test mode); otherwise bad modules are logged and skipped (production never dies on a plugin).
 */
function createRegistry({ dir = __dirname, log = console, strict = false, fetchImpl = globalThis.fetch } = {}) {
    const byName = new Map();
    const errors = [];

    let files = [];
    try {
        files = fs.readdirSync(dir, { withFileTypes: true })
            .filter((d) => d.isFile() && d.name.endsWith('.js') && d.name !== 'index.js' && !d.name.startsWith('_'))
            .map((d) => d.name)
            .sort();
    } catch (err) {
        errors.push({ file: dir, errors: [`cannot read the tools folder: ${(err && err.message) || err}`] });
    }

    for (const file of files) {
        const full = path.join(dir, file);
        let mod;
        try {
            delete require.cache[require.resolve(full)];
            mod = require(full);
        } catch (err) {
            errors.push({ file, errors: [`require failed: ${(err && err.message) || err}`] });
            continue;
        }
        const problems = validateTool(mod);
        if (problems.length) {
            errors.push({ file, errors: problems });
            continue;
        }
        if (byName.has(mod.name)) {
            errors.push({ file, errors: [`duplicate tool name "${mod.name}" (already loaded)`] });
            continue;
        }
        byName.set(mod.name, { ...mod, file });
    }

    if (errors.length) {
        const text = errors.map((e) => `${e.file}: ${e.errors.join('; ')}`).join('\n');
        if (strict) throw new Error(`invalid tool module(s):\n${text}`);
        if (log && log.warn) log.warn(`[Actor] tool modules skipped:\n${text}`);
    }

    const get = (name) => byName.get(name) || null;
    const has = (name) => byName.has(name);

    /** The OpenAI function definitions for this task, filtered by scope and by the module's optional `available(ctx)`. */
    function definitions(ctx = {}) {
        const { requester = null, mode = null } = ctx;
        return [...byName.values()]
            .filter((t) => allowedBy(t.scope, { requester, mode }))
            .filter((t) => (typeof t.available === 'function' ? t.available(ctx) !== false : true))
            .map((t) => ({
                type: 'function',
                function: { name: t.name, description: t.description, parameters: t.input },
            }));
    }

    /**
     * Run one tool by name with a per-tool timeout, composing it with the task's abort signal. Errors come back as
     * text (the model sees them) and never throw unless the task itself was cancelled. A `person` tool refuses a task
     * with no signed-in person, and private mode refuses any tool that is not private-ok.
     */
    async function run(name, input, ctx = {}) {
        const tool = byName.get(name);
        if (!tool) return { text: JSON.stringify({ error: `unknown tool ${name}` }), data: null, sources: [], isError: true };
        if (!allowedBy(tool.scope, ctx)) return { text: JSON.stringify({ error: `tool ${name} is not available for this task` }), data: null, sources: [], isError: true };
        const signal = ctx.signal;
        const timeoutMs = Math.min(tool.timeoutMs || DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
        const timeout = AbortSignal.timeout(timeoutMs);
        const composed = signal ? AbortSignal.any([signal, timeout]) : timeout;
        try {
            const out = await tool.run(input && typeof input === 'object' ? input : {}, { ...ctx, signal: composed, fetch: ctx.fetch || fetchImpl, tool });
            return normalize(out);
        } catch (err) {
            if (signal && signal.aborted) throw err;
            const why = timeout.aborted ? `timed out after ${timeoutMs} ms` : ((err && err.message) || String(err));
            return { text: JSON.stringify({ error: why.slice(0, 300) }), data: null, sources: [], isError: true };
        }
    }

    function report() {
        return { count: byName.size, names: [...byName.keys()].sort(), errors };
    }

    return { dir, tools: [...byName.values()], byName, errors, definitions, run, get, has, report, validateTool };
}

/** A tool result as the loop, the ledger and the check use it. */
function normalize(out) {
    const empty = { text: '', data: null, sources: [], artifacts: [], refs: [], isError: false };
    if (out == null) return empty;
    if (typeof out === 'string') return { ...empty, text: out };
    if (typeof out !== 'object') return { ...empty, text: String(out) };
    const data = out.data === undefined ? null : out.data;
    let text = typeof out.text === 'string' ? out.text : '';
    if (!text && data != null) text = JSON.stringify(data);
    const sources = Array.isArray(out.sources) ? out.sources.filter((s) => s && typeof s.url === 'string').slice(0, 20) : [];
    const artifacts = Array.isArray(out.artifacts) ? out.artifacts.slice(0, 20) : [];
    // A tool may point at a row the task page can open (stage V2-6: a memory a cited answer leaned on). Only the
    // fields the page renders are kept, so a tool can never smuggle a whole object into a task result.
    const refs = Array.isArray(out.refs) ? out.refs.filter((r) => r && typeof r === 'object' && typeof r.kind === 'string' && typeof r.id === 'string')
        .slice(0, 20).map((r) => ({
            kind: r.kind.slice(0, 32), id: r.id.slice(0, 64), text: String(r.text == null ? '' : r.text).slice(0, 500),
            source: r.source == null ? null : String(r.source).slice(0, 32), source_task: r.source_task == null ? null : String(r.source_task).slice(0, 64),
            agent_id: r.agent_id == null ? null : String(r.agent_id).slice(0, 64),
        })) : [];
    return { text, data, sources, artifacts, refs, isError: out.isError === true };
}

module.exports = { createRegistry, validateTool, allowedBy, normalize, SCOPES, MAX_TIMEOUT_MS, DEFAULT_TIMEOUT_MS };

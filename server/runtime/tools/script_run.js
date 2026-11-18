'use strict';

/**
 * script_run (plan §AD.26 item 6, heavy scripts on Run): a JavaScript program that needs npm packages or minutes of CPU,
 * which tools_code's glue sandbox (30 s, no packages) is not for. It runs as an OpenVibe.Run job as the person, on their
 * own computer with OpenVibe Link first, else OpenVibe's pool, through Link's skill runner (1.1.0; 1.2.0 with packages):
 *
 *   - no network and no files: its data comes in as `input` (gather it with other tools first) and it answers one JSON
 *     value on stdout, 64 KB at most;
 *   - packages: exact npm versions, ten at most, installed once by Actor with install scripts off and passed as one
 *     pinned bundle (server/runtime/script-packages.js); pure JavaScript only;
 *   - up to 10 minutes and 1 GB; Run bills the person's project by the second.
 *
 * Calling other tools from inside the script (a bridge back to Actor) comes later; for now a script is input in, value
 * out.
 */
const { createScriptPackages } = require('../script-packages');

const personOf = (requester) => (typeof requester === 'string' && requester.startsWith('user:') ? requester.slice(5) : null);
const builders = new WeakMap();
const packagesFor = (media) => {
    if (!media) return null;
    if (!builders.has(media)) builders.set(media, createScriptPackages({ media }));
    return builders.get(media);
};
const MAX_INPUT = 1024 * 1024;

module.exports = {
    name: 'script_run',
    description: 'Run a JavaScript program that needs npm packages or more than a few seconds of CPU (parsing a big file, statistics, a simulation, converting data), on a machine: the person\'s own computer with OpenVibe Link first, else OpenVibe\'s pool. It has no network and no files: pass the data it needs as `input` (read with process.stdin) and print exactly one JSON value (process.stdout.write(JSON.stringify(result))), 64 KB at most. Packages are exact npm versions ("papaparse@5.4.1"), pure JavaScript only, required as usual. Up to 10 minutes. For quick glue over tools use tools_code instead.',
    input: {
        type: 'object',
        properties: {
            code: { type: 'string', description: 'a CommonJS Node.js program: read JSON from stdin, write one JSON value to stdout', maxLength: 65536 },
            packages: { type: 'array', items: { type: 'string', maxLength: 260 }, maxItems: 10, description: 'npm packages with exact versions, like ["lodash@4.17.21"]' },
            input: { description: 'the JSON the program reads on stdin (1 MB at most)' },
            minutes: { type: 'number', minimum: 0.2, maximum: 10, description: 'how long it may run (2 when left out)' },
        },
        required: ['code'],
    },
    scope: 'person',
    needs: { files: 'none', network: false },   // the job has no network; its packages come as a pinned bundle
    connector: 'openvibe',
    costUsd: 0,
    timeoutMs: 13 * 60_000,
    async run(input, ctx) {
        const person = personOf(ctx.requester);
        if (!person) return { text: JSON.stringify({ error: 'a script runs as a signed-in person' }), isError: true };
        const code = String((input && input.code) || '');
        if (!code.trim()) return { text: JSON.stringify({ error: 'give the program as code' }), isError: true };
        if (Buffer.byteLength(code) > 65536) return { text: JSON.stringify({ error: 'the program is over 64 KB' }), isError: true };
        const data = input && Object.prototype.hasOwnProperty.call(input, 'input') ? input.input : {};
        let size = 0;
        try { size = Buffer.byteLength(JSON.stringify(data === undefined ? {} : data)); } catch { return { text: JSON.stringify({ error: 'input must be JSON' }), isError: true }; }
        if (size > MAX_INPUT) return { text: JSON.stringify({ error: 'input is over 1 MB: boil it down first' }), isError: true };
        const run = ctx.skillRun;
        if (!run || !run.enabled || typeof run.executeScript !== 'function') {
            return { text: JSON.stringify({ error: 'OpenVibe.Run is not connected here, so scripts cannot run' }), isError: true };
        }
        let packages = null;
        const list = input && Array.isArray(input.packages) ? input.packages : [];
        if (list.length) {
            const builder = packagesFor(ctx.media);
            if (!builder) return { text: JSON.stringify({ error: 'OpenVibe.Media is not connected here, so packages cannot be passed' }), isError: true };
            const parsed = builder.parse(list);
            if (parsed.error) return { text: JSON.stringify({ error: parsed.error }), isError: true };
            if (ctx.emit) ctx.emit({ type: 'tool.progress', tool: 'script_run', text: `Preparing ${parsed.specs.join(', ')}` });
            packages = await builder.bundle(list);
            if (packages.error) return { text: JSON.stringify({ error: packages.error }), isError: true };
        }
        const minutes = Number.isFinite(Number(input && input.minutes)) ? Math.min(10, Math.max(0.2, Number(input.minutes))) : 2;
        const out = await run.executeScript({ subject: person, code, input: data, minutes, packages, signal: ctx.signal });
        if (!out.ok) {
            const r = out.result && typeof out.result === 'object' ? out.result : null;
            const why = r && r.error ? r.error : out.error;
            const hint = list.length && /Cannot find module/.test(String(why || '') + String((r && r.stderr) || '')) ? ' (the machine\'s Link may be older than v0.81, which brings packages)' : '';
            return { text: JSON.stringify({ error: `${why}${hint}`, ...(r && r.stderr ? { stderr: String(r.stderr).slice(-2000) } : {}), ...(out.job_id ? { job: out.job_id } : {}) }), isError: true };
        }
        const r = out.result && typeof out.result === 'object' ? out.result : {};
        if (r.ok === false) {
            return { text: JSON.stringify({ error: r.error || 'the program failed', exit: r.exit == null ? null : r.exit, ...(r.stderr ? { stderr: String(r.stderr).slice(-2000) } : {}), job: out.job_id }), isError: true };
        }
        const value = Object.prototype.hasOwnProperty.call(r, 'output') ? r.output : r;
        return {
            text: JSON.stringify({ output: value, seconds: Math.round((Number(out.wall_ms) || 0) / 100) / 10, job: out.job_id, ...(packages ? { packages: packages.specs } : {}) }),
            data: { output: value, job_id: out.job_id, wall_ms: out.wall_ms },
        };
    },
};

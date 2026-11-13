'use strict';

/**
 * One step through Muse Code on one of the person's computers (plan 303): the computer plugin runs
 * `muse exec` there, as the person, on their own Muse sign-in, with contributor mode off. The model use is on the
 * person's own Muse plan, so nothing is metered here.
 *
 * The shape mirrors OpenVibe.Codes' own Muse harness (OpenVibe.Codes harness/adapters/cli.js): headless JSON events
 * on stdout, no approval prompts inside the run (the person approves the step itself: Actor's gate, and at computer
 * level "ask" the machine too), the workspace's own skills loaded, the sandbox's network restricted, and nothing of
 * another person's context. The prompt rides as the command's last word after `--` (nothing is staged for
 * --prompt-file, and an instruction that starts with - can never become an option).
 * A step is short: the machine answers within about two minutes, or the step ends and says so. Longer coding work
 * belongs in codes_task (which can also name the muse harness for the whole task).
 */

const { serviceFor, personOf } = require('./_openvibe');
const { prepareDesk } = require('./_person');

const machine = { type: 'string', description: 'the machine id (dev_…) from list_my_computers' };
// One argv word on the machine holds 4096 characters (agents/computers.js); the prompt keeps its headroom.
const MAX_PROMPT = 3800;
// Meta's reasoning page, checked 2026-11-10 (research muse-latest): the efforts muse exec takes.
const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
// A model id, as OpenVibe.Codes reads it (server/http/tasks-api.js).
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:\/#-]{0,99}$/;
// A session to carry on: `muse exec --session-id` takes a UUID only (observed 2026-11-11: anything else exits 2).
const SESSION = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const TEXT_CHARS = 6000;

const clip = (s, n) => { const t = String(s == null ? '' : s); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

/**
 * The argv that runs one prompt on the machine. Exported so a test reads it without a machine: every flag is fixed
 * except the workspace, the model, the effort and the session to carry on. Contributor mode is always off: Meta never
 * trains on the run. No secret ever rides here: the sign-in is the person's own, on their own machine.
 */
function buildArgv({ prompt, cwd = null, model = null, effort = null, resume = null }) {
    const argv = ['muse', 'exec', '--json',
        '--disable-request-user-input', '--approval-mode', 'never', '--trust-workspace',
        '--contributor-mode', 'off', '--sandbox-network', 'restricted', '--no-foreign-personal-context'];
    if (cwd) argv.push('--workspace', String(cwd));
    if (model) argv.push('--model', String(model));
    if (effort) argv.push('--reasoning-effort', String(effort));
    if (resume) argv.push('--session-id', String(resume));
    // `--` ends the flags: a prompt that starts with `-` is the instruction, never another option (an option
    // after this point could turn the sandbox or the approvals off).
    argv.push('--', String(prompt));
    return argv;
}

/**
 * The JSONL a run prints, as { text, sessionId, usage, failed }. A line is an envelope
 * (`payload_type` naming the event, the facts in `payload`, the session in `stream.id` when its kind is 'session'):
 * observed on muse 1.4.15 `exec --json` 2026-11-11. The flat shape (`type` with the facts beside it) is read too,
 * for older and newer CLIs. Lines that are not JSON are the CLI's own chatter and are left out.
 */
function parseEvents(stdout) {
    const out = { text: '', sessionId: null, usage: null, failed: null, endText: '' };
    for (const line of String(stdout || '').split('\n')) {
        const raw = line.trim();
        if (!raw) continue;
        let e;
        try { e = JSON.parse(raw); } catch { continue; }
        if (!e || typeof e !== 'object') continue;
        const kind = e.payload_type || e.type;
        const p = e.payload && typeof e.payload === 'object' ? e.payload : e;
        if (e.stream && e.stream.kind === 'session' && e.stream.id && !out.sessionId) out.sessionId = String(e.stream.id);
        if (kind === 'run.output.delta') {
            out.text += String(p.text || p.delta || e.delta || '');
        } else if (kind === 'run.lifecycle.started' || kind === 'task.lifecycle.started') {
            out.sessionId = e.session_id || e.sessionId || p.session_id || out.sessionId;
        } else if (kind === 'run.usage') {
            out.usage = e.usage || p;
        } else if (typeof kind === 'string' && kind.startsWith('run.terminal.')) {
            if (e.session_id || e.sessionId) out.sessionId = e.session_id || e.sessionId;
            const terminal = p.terminal || (kind === 'run.terminal.failed' ? 'failed' : kind === 'run.terminal.completed' ? 'completed' : '');
            if (terminal === 'failed') {
                const err = p.reason || p.error || e.error;
                out.failed = String((err && (err.message || err)) || 'the Muse run failed');
            } else if (terminal === 'completed' && p.text) {
                out.endText = String(p.text);
            }
        }
    }
    // The completed record carries the whole answer too: when no delta arrived, it is the answer.
    if (!out.text && out.endText) out.text = out.endText;
    delete out.endText;
    return out;
}

const NOT_FOUND = /(command not found|not found|no such file|cannot find)/i;
const NOT_SIGNED_IN = /(not signed in|not logged in|sign in|login|unauthori[sz]ed|authenticat)/i;

/** Why the machine did not run Muse, in the person's words, with what sets it up there. */
function setupError(reason) {
    const why = String(reason || '').replace(/\s+/g, ' ').trim().slice(0, 300);
    const setup = 'To set it up on that machine: install Muse Code (`curl -fsSL https://dev.meta.ai/install.sh | sh`), sign in with the person\u2019s own Muse plan (`muse login`); Link\u2019s window (its Codes section) shows whether it is ready there.';
    if (NOT_FOUND.test(why)) return `Muse Code is not installed on that machine. ${setup}`;
    if (NOT_SIGNED_IN.test(why)) return `Muse Code on that machine is not signed in. Run \`muse login\` there, with the person\u2019s own Muse plan. ${setup}`;
    return `Muse Code did not answer on that machine${why ? `: ${why}` : ''}. ${setup}`;
}

module.exports = {
    name: 'muse_run',
    description: 'Run one short step through Muse Code on one of the person\'s computers (about two minutes): an agentic coding step in a folder there — read, change and run code, with the computer\'s own files. It runs as the person, on their own Muse sign-in with contributor mode off (Meta never trains on it); the model use is on their own Muse plan. Pass cwd to work in a folder; model and effort pick the Muse model and reasoning; resume carries on a session an earlier step started (its session_id). Longer coding work belongs in codes_task. At level "ask" it waits for the person to approve it on the machine.',
    input: {
        type: 'object',
        properties: {
            machine,
            prompt: { type: 'string', description: 'the step, in plain words (at most 3800 characters)' },
            cwd: { type: 'string', description: 'the folder on that computer to work in' },
            timeout_s: { type: 'integer', description: 'how long the step may run, in seconds (at most 600)' },
            model: { type: 'string', description: 'a Muse model id (for example muse-spark-1.3); omit it for Muse\u2019s default' },
            effort: { type: 'string', enum: EFFORTS, description: 'Meta reasoning effort; omit it for Muse\u2019s default' },
            resume: { type: 'string', description: 'the session_id an earlier step answered, to carry it on' },
            desk: { type: 'string', enum: ['main', 'private'], description: 'private: your own desk (start it with computer_desk first); main (the default): the person\'s own session' },
        },
        required: ['machine', 'prompt'],
    },
    scope: 'person',
    needs: { files: 'write', network: false },   // plan 11c: the run's files and network settings gate it
    connector: 'codes',
    acts: true,
    costUsd: 0,
    timeoutMs: 150_000,
    available: (ctx) => Boolean(ctx.config && ctx.config.services && ctx.config.services.botUrl && personOf(ctx.requester)),
    async run(input, ctx) {
        const core = serviceFor(ctx);
        const person = personOf(ctx.requester);
        if (!core.pcs.enabled || !person) return { text: JSON.stringify({ error: 'computers are only for a signed-in person\u2019s task' }), isError: true };
        const a = await prepareDesk('muse_run', input, person, core, ctx);
        if (a.error) return { text: JSON.stringify(a), isError: true };
        const prompt = String(a.prompt || '').trim();
        if (!prompt) return { text: JSON.stringify({ error: 'prompt is the step, in plain words' }), isError: true };
        if (prompt.length > MAX_PROMPT) return { text: JSON.stringify({ error: `prompt holds at most ${MAX_PROMPT} characters` }), isError: true };
        if (a.model != null && !MODEL.test(String(a.model))) return { text: JSON.stringify({ error: 'model is a Muse model id (for example muse-spark-1.3)' }), isError: true };
        if (a.effort != null && !EFFORTS.includes(a.effort)) return { text: JSON.stringify({ error: `effort is one of ${EFFORTS.join(', ')}` }), isError: true };
        if (a.resume != null && !SESSION.test(String(a.resume))) return { text: JSON.stringify({ error: 'resume is the session_id an earlier step answered' }), isError: true };
        const argv = buildArgv({ prompt, cwd: a.cwd || null, model: a.model || null, effort: a.effort || null, resume: a.resume || null });
        const r = await core.pcs.run(person, a.machine, argv, { cwd: a.cwd, timeoutS: a.timeout_s, desk: a.desk, signal: ctx.signal });
        if (r.error) return { text: JSON.stringify({ error: setupError(r.error) }), isError: true };
        if (r.timed_out) return { text: JSON.stringify({ error: 'Muse Code was still working when the step\u2019s time ran out. Break the work into smaller steps, or hand it to codes_task.' }), isError: true };
        const ev = parseEvents(r.stdout);
        if (r.exit_code !== 0 || ev.failed || !ev.text.trim()) {
            return { text: JSON.stringify({ error: setupError(ev.failed || r.stderr || `it ended with status ${r.exit_code}`) }), isError: true };
        }
        return {
            text: clip(ev.text.trim(), TEXT_CHARS),
            data: { session_id: ev.sessionId, ...(ev.usage ? { usage: ev.usage } : {}), exit_code: r.exit_code },
        };
    },
    buildArgv,
    parseEvents,
};

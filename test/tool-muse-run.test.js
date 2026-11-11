'use strict';
// One step through Muse Code on the person's own computer (server/runtime/tools/muse_run.js): the argv runs `muse
// exec` headless on the person's own sign-in with contributor mode off (no secret rides it); the JSONL events answer
// the step's text, its session and its usage; a machine without Muse answers with how to set it up. The approval
// names the instruction exactly, as a computer run.
const assert = require('assert');
const museRun = require('../server/runtime/tools/muse_run');
const { stepFor } = require('../server/agents/actions');
const { check, done } = require('./helpers/boot');

const ME = 'usr_01M4W5JBFEG3QG9ER8W1A2K0RX';
const MACHINE = 'dev_01JAB2C3D4E5F6G7H8J9K0MNPS';
const SESSION = '0193d8f1-9b2e-7c4a-8f1e-2b3c4d5e6f70';

// The envelope muse 1.4.15 `exec --json` prints (trimmed from a real `--provider echo` run, 2026-11-11).
const ENVELOPE = [
    JSON.stringify({ schema_version: 1, stream: { kind: 'session', id: SESSION }, payload_type: 'run.lifecycle.started', payload: { kind: 'run_started' } }),
    'muse: workspace trust: trusted source=run-flag',
    JSON.stringify({ schema_version: 1, stream: { kind: 'session', id: SESSION }, payload_type: 'run.output.delta', payload: { kind: 'run_output_delta', text: 'Renamed ' } }),
    JSON.stringify({ schema_version: 1, stream: { kind: 'session', id: SESSION }, payload_type: 'run.output.delta', payload: { kind: 'run_output_delta', text: 'three files.' } }),
    JSON.stringify({ schema_version: 1, stream: { kind: 'exec.usage', id: SESSION }, payload_type: 'run.usage', payload: { kind: 'run_usage', calls: 1, models: [{ input_tokens: 0, output_tokens: 0 }] } }),
    JSON.stringify({ schema_version: 1, stream: { kind: 'session', id: SESSION }, payload_type: 'run.terminal.completed', payload: { kind: 'run_terminal', terminal: 'completed', text: 'Renamed three files.' } }),
].join('\n');
// The flat shape other CLIs print: still read.
const EVENTS = [
    JSON.stringify({ type: 'task.lifecycle.started', session_id: SESSION }),
    'Muse Code 1.4.15 warming up',
    JSON.stringify({ type: 'run.output.delta', delta: 'Renamed ' }),
    JSON.stringify({ type: 'run.output.delta', text: 'three files.' }),
    JSON.stringify({ type: 'run.usage', usage: { input_tokens: 120, output_tokens: 30 } }),
    JSON.stringify({ type: 'run.terminal.completed', session_id: SESSION }),
].join('\n');

/** A fake OpenVibe.Bot: the token endpoint and one exec answer. */
function fakeBot({ exec = null, refuse = null } = {}) {
    const calls = [];
    const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    const fetchImpl = async (url, init = {}) => {
        const u = new URL(url);
        let body = null;
        try { body = init.body ? JSON.parse(init.body) : null; } catch { body = init.body || null; }
        calls.push({ method: init.method || 'GET', path: u.pathname, body });
        if (u.pathname === '/oauth/token') return reply(200, { access_token: 'tok', token_type: 'Bearer', expires_in: 3600 });
        if (u.pathname === `/api/v1/machines/${MACHINE}/commands` && (init.method || 'GET') === 'POST') {
            if (refuse) return reply(refuse.status, refuse.body);
            return reply(200, { result: 'ack', data: exec });
        }
        return reply(404, { code: 'not_found' });
    };
    return { calls, fetchImpl };
}
const ctxFor = (fetchImpl, extra = {}) => ({
    config: {
        networkInternalUrl: 'http://network.test', oauth: { clientId: 'actor', clientSecret: 'actor-secret' },
        services: { botUrl: 'http://bot.test' },
    },
    fetch: fetchImpl, requester: `user:${ME}`, signal: null, emit: async () => {}, ...extra,
});

(async () => {
    await check('the argv runs muse headless, contributor mode off, the prompt last, no secret in it', async () => {
        const argv = museRun.buildArgv({ prompt: 'tidy the notes' });
        assert.deepStrictEqual(argv.slice(0, 2), ['muse', 'exec']);
        for (const flag of ['--json', '--disable-request-user-input', '--approval-mode', 'never', '--trust-workspace',
            '--contributor-mode', 'off', '--sandbox-network', 'restricted', '--no-foreign-personal-context']) {
            assert.ok(argv.includes(flag), `missing ${flag}: ${argv.join(' ')}`);
        }
        assert.strictEqual(argv[argv.length - 2], '--', 'the prompt follows an end-of-flags marker');
        assert.strictEqual(argv[argv.length - 1], 'tidy the notes');
        assert.ok(!argv.some((w) => /key|token|secret/i.test(w)), 'no secret rides the command');
        // A prompt that looks like an option is the instruction: it can never turn the sandbox or approvals off.
        const tricky = museRun.buildArgv({ prompt: '--disable-sandbox' });
        assert.strictEqual(tricky[tricky.length - 1], '--disable-sandbox');
        assert.strictEqual(tricky[tricky.length - 2], '--');
        const full = museRun.buildArgv({ prompt: 'go', cwd: '/home/ada/notes', model: 'muse-spark-1.3', effort: 'low', resume: SESSION });
        assert.deepStrictEqual(full.slice(12, 20), ['--workspace', '/home/ada/notes', '--model', 'muse-spark-1.3', '--reasoning-effort', 'low', '--session-id', SESSION]);
        assert.strictEqual(full[20], '--');
        assert.strictEqual(full[full.length - 1], 'go');
    });

    await check('the events answer the text, the session and the usage; chatter is left out', async () => {
        const ev = museRun.parseEvents(ENVELOPE);
        assert.strictEqual(ev.text, 'Renamed three files.');
        assert.strictEqual(ev.sessionId, SESSION);
        assert.strictEqual(ev.usage.calls, 1);
        assert.strictEqual(ev.failed, null);
        // The flat shape reads too, and a failed end names its reason.
        const flat = museRun.parseEvents(EVENTS);
        assert.strictEqual(flat.text, 'Renamed three files.');
        assert.strictEqual(flat.sessionId, SESSION);
        assert.deepStrictEqual(flat.usage, { input_tokens: 120, output_tokens: 30 });
        const failed = museRun.parseEvents(`${JSON.stringify({ type: 'run.terminal.failed', error: { message: 'no session' } })}\n`);
        assert.strictEqual(failed.failed, 'no session');
        assert.strictEqual(failed.text, '');
        const failedEnv = museRun.parseEvents(`${JSON.stringify({ payload_type: 'run.terminal.failed', payload: { kind: 'run_terminal', terminal: 'failed', reason: 'the plan ran out' } })}\n`);
        assert.strictEqual(failedEnv.failed, 'the plan ran out');
        // The completed record's own text stands in when no delta arrived.
        const bare = museRun.parseEvents(`${JSON.stringify({ payload_type: 'run.terminal.completed', payload: { kind: 'run_terminal', terminal: 'completed', text: 'All done.' } })}\n`);
        assert.strictEqual(bare.text, 'All done.');
    });

    await check('a step runs through the computer and answers its text with the session', async () => {
        const bot = fakeBot({ exec: { exit_code: 0, stdout: ENVELOPE, stderr: '', truncated: false, timed_out: false } });
        const out = await museRun.run({ machine: MACHINE, prompt: 'tidy the notes', cwd: '/home/ada/notes' }, ctxFor(bot.fetchImpl));
        assert.strictEqual(out.isError, undefined);
        assert.strictEqual(out.text, 'Renamed three files.');
        assert.strictEqual(out.data.session_id, SESSION);
        assert.strictEqual(out.data.exit_code, 0);
        const exec = bot.calls.find((c) => c.path.endsWith('/commands'));
        assert.deepStrictEqual(exec.body.value.argv.slice(0, 2), ['muse', 'exec']);
        assert.ok(exec.body.value.argv.includes('--contributor-mode') && exec.body.value.argv.includes('off'));
        assert.strictEqual(exec.body.value.cwd, '/home/ada/notes');
        assert.ok(exec.body.value.argv.includes('/home/ada/notes'), 'the workspace is the folder');
    });

    await check('a bad prompt, model, effort or session is refused before anything runs', async () => {
        const bot = fakeBot({ exec: { exit_code: 0, stdout: EVENTS } });
        const ctx = ctxFor(bot.fetchImpl);
        for (const input of [{ machine: MACHINE, prompt: '' }, { machine: MACHINE, prompt: 'x'.repeat(3801) },
            { machine: MACHINE, prompt: 'go', model: 'muse spark!' }, { machine: MACHINE, prompt: 'go', effort: 'ultra-max' },
            { machine: MACHINE, prompt: 'go', resume: 'not a session' }]) {
            const out = await museRun.run(input, ctx);
            assert.strictEqual(out.isError, true, JSON.stringify(input));
        }
        assert.ok(!bot.calls.some((c) => c.path.endsWith('/commands')), 'nothing reached the machine');
    });

    await check('a machine without Muse answers with how to set it up', async () => {
        const missing = fakeBot({ exec: { exit_code: 127, stdout: '', stderr: 'muse: command not found' } });
        const out = await museRun.run({ machine: MACHINE, prompt: 'go' }, ctxFor(missing.fetchImpl));
        assert.strictEqual(out.isError, true);
        assert.match(out.text, /not installed.*curl -fsSL https:\/\/dev\.meta\.ai\/install\.sh \| sh.*muse login/s);
        const signedOut = fakeBot({ exec: { exit_code: 1, stdout: '', stderr: 'error: not signed in; run `muse login`' } });
        const out2 = await museRun.run({ machine: MACHINE, prompt: 'go' }, ctxFor(signedOut.fetchImpl));
        assert.match(out2.text, /not signed in.*muse login/);
        const failed = fakeBot({ exec: { exit_code: 0, stdout: `${JSON.stringify({ type: 'run.terminal.failed', error: 'the Muse run failed' })}\n` } });
        const out3 = await museRun.run({ machine: MACHINE, prompt: 'go' }, ctxFor(failed.fetchImpl));
        assert.strictEqual(out3.isError, true);
        const nacked = fakeBot({ refuse: { status: 403, body: { code: 'bot.computer.denied', detail: 'not this computer' } } });
        const out4 = await museRun.run({ machine: MACHINE, prompt: 'go' }, ctxFor(nacked.fetchImpl));
        assert.match(out4.text, /not this computer/);
    });

    await check('the tool is registered as acting, labelled, and rides the day lanes with the computer tools', async () => {
        const { createRegistry } = require('../server/runtime/tools');
        const registry = createRegistry({ strict: true, log: { warn() {}, log() {} } });
        const tool = registry.get('muse_run');
        assert.ok(tool && tool.acts === true && tool.scope === 'person');
        const { LANES, DESK } = require('../server/day/lanes');
        assert.ok(DESK.includes('muse_run'));
        assert.ok(LANES.custom.tools.includes('muse_run') && LANES.find_work.tools.includes('muse_run'));
        assert.ok(!LANES.brief_me.tools.includes('muse_run'), 'a read-only lane stays read-only');
    });

    await check('the approval names the instruction exactly, as a computer run', async () => {
        const step = stepFor('muse_run', { machine: MACHINE, prompt: 'tidy the notes' });
        assert.strictEqual(step.kind, 'computer.run');
        assert.strictEqual(step.summary, 'Run Muse Code on your computer: "tidy the notes"');
        assert.strictEqual(step.target, `muse "tidy the notes" on ${MACHINE}`);
        assert.strictEqual(step.payload.prompt, 'tidy the notes');
        assert.strictEqual(stepFor('muse_run', { machine: MACHINE, prompt: 'x'.repeat(300) }).target, null, 'a long instruction is never always allowed');
    });

    done();
})().catch((e) => { console.error(e); process.exit(1); });

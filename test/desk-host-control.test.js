'use strict';
// A desk on a desk host (an OpenVibe.Run session), found broken on production 11-20 by a real lesson (Teach, §AD.33):
//   - the registry dropped the `computer` a desk tool named, so the task never showed that desk (no tile, no Take over);
//   - computer_browser with machine "any" was refused ("machine must be a machine id"), though the desk said to use it;
//   - Run gives a new session's control to its person for a minute and then to nobody, and refuses commands from anyone
//     else, so every command the agent sent was refused as run.session.control_held.
const assert = require('assert');
const { normalize } = require('../server/runtime/tools');
const { prepareDesk, deskRun } = require('../server/runtime/tools/_person');
const { createComputers } = require('../server/agents/computers');

const SES = 'ses_01JZ0000000000000000000000';
const USR = 'usr_01JZ0000000000000000000000';
const config = { services: { botUrl: 'http://bot.test', runUrl: 'http://run.test' }, oauth: { clientId: 'actor', clientSecret: '' }, networkInternalUrl: 'http://net.test' };
const tokens = { authHeaders: async () => ({ Authorization: 'Bearer svc-token' }) };

/** A fake Run: one session, its control lease (person for the first minute, as Run does), commands only from the holder. */
function fakeRun({ holder = { kind: 'person', subject: USR } } = {}) {
    const state = { holder, calls: [] };
    const json = (status, body) => ({ ok: status < 400, status, json: async () => body });
    state.fetchImpl = async (url, opts = {}) => {
        const u = new URL(url);
        const p = u.pathname.replace('/api/v1', '');
        const body = opts.body ? JSON.parse(opts.body) : null;
        state.calls.push(`${opts.method || 'GET'} ${p}`);
        if (p === '/sessions' && opts.method === 'POST') return json(201, { id: SES, state: 'running' });
        if (p === `/sessions/${SES}/control/grant`) { state.holder = body.holder; return json(200, { lease: { holder: state.holder } }); }
        if (p === `/sessions/${SES}/control/request`) { if (state.holder.kind === 'nobody') state.holder = { kind: 'ai', subject: 'svc:actor' }; return json(200, { lease: { holder: state.holder } }); }
        if (p === `/sessions/${SES}/commands`) {
            if (state.holder.kind !== 'ai') return json(403, { code: 'run.session.control_held', detail: 'only the current control holder may send commands' });
            return json(200, { result: 'ack', data: { url: 'https://example.com/', title: 'Example Domain' } });
        }
        return json(404, { code: 'not_found' });
    };
    return state;
}

(async () => {
    let pass = 0;
    const ok = (m) => { pass++; console.log(`  ✓ ${m}`); };

    const kept = normalize({ text: '{"running":true}', computer: { session_id: SES, machine: 'an OpenVibe desk host', where: 'network', cost_hint: 'metered', extra: 'x' } });
    assert.deepStrictEqual(kept.computer, { session_id: SES, machine: 'an OpenVibe desk host', where: 'network', cost_hint: 'metered' });
    assert.strictEqual(normalize({ text: 'x', computer: null }).computer, null, 'a stop says the desk is gone');
    assert.ok(!('computer' in normalize({ text: 'x' })), 'a tool that names no Computer adds none');
    ok('the registry keeps the Computer a desk tool names, its own fields only');

    const desks = deskRun('tsk_1');
    const core = { pcs: { isSession: (m) => /^run:ses_/.test(String(m || '')) } };
    assert.match((await prepareDesk('computer_browser', { machine: 'any', action: 'open' }, USR, core, { state: { desks } })).error, /start one with computer_desk start/);
    desks.placed = `run:${SES}`;
    const a = await prepareDesk('computer_browser', { machine: 'any', action: 'open', desk: 'private' }, USR, core, { state: { desks } });
    assert.strictEqual(a.machine, `run:${SES}`, 'machine "any" is the desk this run placed');
    ok('every desk tool takes machine "any" as the run\'s own desk, and says so when there is none');

    {
        const run = fakeRun();
        const pcs = createComputers({ config, fetchImpl: run.fetchImpl, tokens });
        const ses = await pcs.openSession(USR, { taskId: 'tsk_1' });
        assert.strictEqual(ses.machine, `run:${SES}`);
        assert.deepStrictEqual(run.holder, { kind: 'ai', subject: 'svc:actor' }, 'the agent that opened it drives it from the start');
        const page = await pcs.browser(USR, `run:${SES}`, { action: 'open', url: 'https://example.com/' });
        assert.ok(!page.error, JSON.stringify(page));
    }
    ok('a desk-host session the agent opens is the agent\'s to drive at once');

    {
        const run = fakeRun({ holder: { kind: 'nobody', subject: null } });
        const pcs = createComputers({ config, fetchImpl: run.fetchImpl, tokens });
        const page = await pcs.browser(USR, `run:${SES}`, { action: 'open', url: 'https://example.com/' });
        assert.ok(!page.error, JSON.stringify(page));
        assert.ok(run.calls.includes(`POST /sessions/${SES}/control/request`), 'a lapsed lease is asked for again');
        const driving = fakeRun({ holder: { kind: 'person', subject: USR } });
        const p2 = createComputers({ config, fetchImpl: driving.fetchImpl, tokens });
        const refused = await p2.browser(USR, `run:${SES}`, { action: 'click', ref: 'e1' });
        assert.match(refused.error, /the person is using your desk/, 'while the person drives, the agent waits');
        assert.deepStrictEqual(driving.holder, { kind: 'person', subject: USR }, 'and never takes it from them');
    }
    ok('a lapsed lease is asked for once and the command goes; a person driving keeps the desk');

    console.log(`desk-host-control: ${pass} checks passed`);
})().catch((e) => { console.error(e); process.exit(1); });

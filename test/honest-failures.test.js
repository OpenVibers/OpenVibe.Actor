'use strict';
// A task that fails says what really happened (the owner's screenshots, 2026-11-19: "Add a minimal example test…" ended
// "No agent gave an answer that passed its check" though its one agent never answered: OpenVibe.Codes could not clone
// the repository Actor had made; the page also said "Finished." before the failure, and its card stayed "Running").
//   - an agent that stopped before answering is named with its reason, on the task and on its page;
//   - the Codes agent says no "Finished." for a task whose result failed;
//   - a run's end closes the plan item it was on.
const assert = require('assert');
const { initial, createMapper } = require('../server/agent-ui/mapper');
const { clean } = require('../server/agent-ui/redact');
const { createCodes } = require('../server/agents/codes');
const { boot, check, done } = require('./helpers/boot');

const ME = 'usr_01M4W5JBFEG3QG9ER8W1A2K0RX';
const TASK = 'tsk_01M4XENCR31NXDJQYDCCW2J9R9';

(async () => {
    await check('a run that ends closes the plan item it was on', async () => {
        const state = initial('run-plan', 'actor', '2026-11-19T00:00:00Z');
        const m = createMapper(state, { clean });
        await m.push({ t: 'plan', plan: [{ title: 'OpenVibe.Codes takes it', status: 'running' }] }, 1);
        await m.push({ t: 'end', ok: false, text: 'failed' }, 2);
        assert.strictEqual(state.plan[0].status, 'failed', 'the plan item failed with the run');
        const types = m.events.map((e) => e.event.type);
        assert.ok(types.lastIndexOf('STATE_SNAPSHOT') > types.indexOf('STATE_SNAPSHOT'), 'the closed plan is sent');
        assert.strictEqual(types.at(-1), 'RUN_ERROR');
    });

    await check('the Codes agent says no "Finished." for a task whose result failed', async () => {
        const page = `https://openvibe.codes/run/tasks/${TASK}`;
        const reads = [{ state: 'running' }, { state: 'succeeded', result: { ok: false, error: "fatal: repository 'https://git.openvibe.codes/me/work/' not found" } }];
        let n = 0;
        const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
        const fetchImpl = async (url, init = {}) => {
            const u = new URL(url);
            if (u.pathname === '/api/v1/tasks' && init.method === 'POST') return reply(201, { task: { id: TASK, state: 'queued', url: page }, created: true });
            if (u.pathname === `/api/v1/tasks/${TASK}`) return reply(200, { id: TASK, url: page, ...reads[Math.min(n++, reads.length - 1)] });
            return reply(404, {});
        };
        const config = { networkInternalUrl: 'http://network.test', oauth: { clientId: 'actor', clientSecret: 'x' }, taskTimeoutMs: 180_000,
            services: { codesUrl: 'http://codes.test', codesPublicUrl: 'https://openvibe.codes' } };
        const codes = createCodes({ config, fetchImpl, tokens: { authHeaders: async () => ({ Authorization: 'Bearer svc' }) }, sleep: async () => {}, pollMs: 0 });
        const said = [];
        await assert.rejects(
            codes.adapter({ task: 'In https://github.com/octocat/Hello-World, add a test.', requester: `user:${ME}`, taskId: 'act_task_02', emit: async (e) => { if (e.step === 'text') said.push(e.text); } }),
            /did not finish: fatal: repository/);
        assert.ok(said.includes('Your machine is working on it.'), `a state on the way is said: ${said.join(' | ')}`);
        assert.ok(!said.some((t) => /^Finished\.?$/.test(t)), `no "Finished." before the failure: ${said.join(' | ')}`);
    });

    const t = await boot({ adapters: {
        checkers: { local: async () => ({ text: '{"ok":true,"reason":"answers"}', cost_usd: 0 }) },
        run: { 'open-model': async () => { throw new Error('the repository could not be cloned'); } },
    } });
    try {
        await check('an agent that stopped before answering is named with its reason, not "no answer passed its check"', async () => {
            const owner = t.network.addUser('honest-failure');
            const r = await t.get('/api/v1/tasks', { as: owner, json: { task: 'Say hello.', mode: 'private' }, headers: { 'sec-fetch-site': 'same-origin' } });
            assert.strictEqual(r.status, 201, r.text);
            const row = await t.waitFor(r.json().id);
            assert.strictEqual(row.state, 'failed');
            assert.strictEqual(row.error_code, 'actor.agents.exhausted');
            const detail = String(row.error_detail);
            assert.match(detail, /stopped before it answered: the repository could not be cloned/, detail);
            assert.ok(!/passed its check/.test(detail), detail);
            const html = (await t.get(`/tasks/${row.id}`, { as: owner })).text;
            assert.ok(html.includes('stopped before it answered: the repository could not be cloned'), 'the page says it');
            assert.ok(!html.includes('No agent gave an answer that passed its check'), 'and not the check sentence');
        });
    } finally { await t.close(); }
    done('honest failures');
})();

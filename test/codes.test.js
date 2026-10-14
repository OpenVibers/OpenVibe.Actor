'use strict';
// The `codes` agent (plan T16/T17, agents/codes.js): a signed-in person's coding task goes to OpenVibe.Codes as that
// person (X-OV-Subject, Actor's own service token), with the Actor task id as its idempotency key; Actor follows it
// to the end and answers with the summary, the files, the patch and the task's page. A person who never started a
// task on openvibe.codes/run is told how; past Actor's own time the answer links the live page; a cancelled Actor task
// cancels the Codes task; an expired one says the machine never took it. The catalog lists the agent as available
// once Codes is connected, at no cost to Actor, and its answers are checked like any other.
const assert = require('assert');
const { createCodes, repoIn } = require('../server/agents/codes');
const catalog = require('../server/agents/catalog');
const { checkersFor } = require('../server/agents/check');
const { check, done } = require('./helpers/boot');

const ME = 'usr_01M4W5JBFEG3QG9ER8W1A2K0RX';
const TASK = 'tsk_01M4XENCR31NXDJQYDCCW2J9R9';
const config = {
    networkInternalUrl: 'http://network.test', oauth: { clientId: 'actor', clientSecret: 'actor-secret' }, taskTimeoutMs: 180_000,
    services: { codesUrl: 'http://codes.test', codesPublicUrl: 'https://openvibe.codes' },
};
const tokens = { authHeaders: async () => ({ Authorization: 'Bearer svc-token' }) };

/** A fake OpenVibe.Codes: `states` is what each read answers, in turn (the last one repeats). */
function fakeCodes({ start = 201, startBody = null, states = ['running', 'succeeded'] } = {}) {
    const calls = [];
    let reads = 0;
    const page = `https://openvibe.codes/run/tasks/${TASK}`;
    const task = (state) => ({
        id: TASK, state, repo: 'https://github.com/octocat/Hello-World', url: page, created_at: '2026-10-14T15:00:00.000Z', updated_at: '2026-10-14T15:00:00.000Z',
        ...(state === 'succeeded' ? { result: { ok: true, agents: ['deepseek'], summary: 'Appended the line.', files: [{ path: 'README', added: 1, removed: 0 }], patch: 'diff --git a/README b/README\n+Edited.\n', duration_ms: 4200 } } : {}),
    });
    const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    const fetchImpl = async (url, init = {}) => {
        const u = new URL(url);
        const headers = init.headers || {};
        calls.push({ method: init.method || 'GET', path: u.pathname, subject: headers['X-OV-Subject'], auth: headers.Authorization, body: init.body ? JSON.parse(init.body) : null });
        if (u.pathname === '/api/v1/tasks' && init.method === 'POST') return reply(start, startBody || { task: task('queued'), created: true });
        if (u.pathname === `/api/v1/tasks/${TASK}` && (init.method || 'GET') === 'GET') return reply(200, task(states[Math.min(reads++, states.length - 1)]));
        if (u.pathname === `/api/v1/tasks/${TASK}/cancel`) return reply(200, task('cancelled'));
        return reply(404, { code: 'not_found' });
    };
    return { calls, fetchImpl };
}
const run = (codes, extra = {}) => {
    const events = [];
    return codes.adapter({ task: 'In https://github.com/octocat/Hello-World, add a line to the README.', requester: `user:${ME}`, taskId: 'act_task_01', emit: async (e) => events.push(e), ...extra })
        .then((out) => ({ out, events }));
};

(async () => {
    await check('the repository comes from the task text', async () => {
        assert.strictEqual(repoIn('fix https://github.com/a/b.git, please'), 'https://github.com/a/b');
        assert.strictEqual(repoIn('see https://codeberg.org/me/tool).'), 'https://codeberg.org/me/tool');
        assert.strictEqual(repoIn('fix my code'), null);
        assert.strictEqual(repoIn('http://github.com/a/b'), null);
    });

    await check('a coding task starts on Codes as the person, keyed by the Actor task, and answers with the change', async () => {
        const codes = fakeCodes();
        const { out, events } = await run(createCodes({ config, fetchImpl: codes.fetchImpl, tokens, sleep: async () => {}, pollMs: 0 }));
        const start = codes.calls[0];
        assert.deepStrictEqual([start.method, start.path, start.subject, start.auth], ['POST', '/api/v1/tasks', ME, 'Bearer svc-token']);
        assert.strictEqual(start.body.repo, 'https://github.com/octocat/Hello-World');
        assert.strictEqual(start.body.idempotency_key, 'act_task_01');
        assert.ok(out.text.includes('Done on your machine') && out.text.includes('Appended the line.') && out.text.includes('`README` (+1 −0)') && out.text.includes('```diff'), out.text);
        assert.deepStrictEqual(out.sources, [`https://openvibe.codes/run/tasks/${TASK}`]);
        assert.ok(events.some((e) => e.text && e.text.startsWith('Your machine is working on it')));
    });

    await check('signed out, no repository, or no /run task yet: a refusal that says what to do', async () => {
        const codes = createCodes({ config, fetchImpl: fakeCodes().fetchImpl, tokens, sleep: async () => {}, pollMs: 0 });
        await assert.rejects(codes.adapter({ task: 'https://github.com/a/b fix', requester: 'ip:1.2.3.4', emit: async () => {} }), /signed in/);
        await assert.rejects(codes.adapter({ task: 'fix my code', requester: `user:${ME}`, emit: async () => {} }), (e) => e.code === 'actor.task.no_repo');
        const none = fakeCodes({ start: 409, startBody: { code: 'codes.no_project', detail: 'no /run task yet' } });
        await assert.rejects(run(createCodes({ config, fetchImpl: none.fetchImpl, tokens, sleep: async () => {}, pollMs: 0 })), /openvibe\.bot\/machines.*openvibe\.codes\/run/);
    });

    await check('past Actor\'s own time the answer links the live page; an expired task says the machine never took it', async () => {
        let clock = 0;
        const slow = fakeCodes({ states: ['running'] });
        const { out } = await run(createCodes({ config, fetchImpl: slow.fetchImpl, tokens, sleep: async () => { clock += 10_000; }, pollMs: 0, now: () => clock }));
        assert.ok(out.text.includes('not done yet') && out.text.includes(`/run/tasks/${TASK}`), out.text);
        assert.ok(!slow.calls.some((c) => c.path.endsWith('/cancel')), 'a slow task is left running');
        const expired = fakeCodes({ states: ['expired'] });
        await assert.rejects(run(createCodes({ config, fetchImpl: expired.fetchImpl, tokens, sleep: async () => {}, pollMs: 0 })), /No machine of yours took the task/);
    });

    await check('cancelling the Actor task cancels the Codes task', async () => {
        const codes = fakeCodes({ states: ['running'] });
        const ac = new AbortController();
        const sleep = async () => { ac.abort(); };
        await assert.rejects(run(createCodes({ config, fetchImpl: codes.fetchImpl, tokens, sleep, pollMs: 0 }), { signal: ac.signal }), (e) => e.code === 'actor.task.cancelled');
        assert.ok(codes.calls.some((c) => c.method === 'POST' && c.path === `/api/v1/tasks/${TASK}/cancel` && c.subject === ME));
    });

    await check('the catalog lists the agent once Codes is connected, at no cost to Actor; either family checks its answers', async () => {
        const agent = catalog.byId('codes');
        assert.deepStrictEqual(catalog.availability(agent, config), { available: true });
        assert.strictEqual(catalog.availability(agent, { ...config, services: { codesUrl: '' } }).available, false);
        assert.strictEqual(catalog.typicalCost('codes'), 0);
        const families = checkersFor('codes', { deepseek: async () => ({}), openai: async () => ({}) }, { mode: 'balanced' }).map((c) => c.family);
        assert.deepStrictEqual(families, ['deepseek', 'openai']);
    });
    done();
})().catch((e) => { console.error(e); process.exit(1); });

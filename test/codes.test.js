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
    const task = (s) => {
        const state = typeof s === 'string' ? s : s.state;
        return {
            id: TASK, state, repo: 'https://github.com/octocat/Hello-World', url: page, created_at: '2026-10-14T15:00:00.000Z', updated_at: '2026-10-14T15:00:00.000Z',
            ...(typeof s === 'object' && s.error ? { error: s.error } : {}),
            ...(state === 'succeeded' ? { result: { ok: true, agents: ['deepseek'], summary: 'Appended the line.', files: [{ path: 'README', added: 1, removed: 0 }], patch: 'diff --git a/README b/README\n+Edited.\n', duration_ms: 4200 } } : {}),
        };
    };
    const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    const fetchImpl = async (url, init = {}) => {
        const u = new URL(url);
        const headers = init.headers || {};
        let parsed = null;
        try { parsed = init.body ? JSON.parse(init.body) : null; } catch { parsed = init.body || null; }
        calls.push({ method: init.method || 'GET', path: u.pathname, query:u.searchParams.toString(), subject: headers['X-OV-Subject'], auth: headers.Authorization, body: parsed });
        if (u.pathname === '/oauth/token') return reply(200, { access_token: 'tok', token_type: 'Bearer', expires_in: 3600 });
        if (u.pathname === '/api/v1/tasks' && init.method === 'POST') return reply(start, startBody || { task: task('queued'), created: true });
        if (u.pathname === `/api/v1/tasks/${TASK}` && (init.method || 'GET') === 'GET') return reply(200, task(states[Math.min(reads++, states.length - 1)]));
        if (u.pathname === `/run/tasks/${TASK}/session.json`) {
            const all = [
                { seq:1, kind:'step', body:{ t:'step', text:'Reading README' } },
                { seq:2, kind:'tool', body:{ t:'tool', id:'tool-1', name:'Read', input:{ file_path:'README' } } },
                { seq:3, kind:'tool_result', body:{ t:'tool_result', id:'tool-1', ok:true, output:'README contents' } },
                { seq:4, kind:'done', body:{ t:'done', ok:true, text:'Finished the README edit.' } },
            ];
            const after = Number(u.searchParams.get('after') || 0), lines = all.filter(line => line.seq > after);
            const page = lines.slice(0, after === 0 ? 3 : 500);
            return reply(200, { task_id:TASK, source:'session', after, lines:page, next_after:page.at(-1)?.seq || after, has_more:page.at(-1)?.seq !== all.at(-1).seq, complete:true });
        }
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
        assert.ok(!codes.calls.some(c=>c.path.endsWith('/session.json')), 'the session bridge is off unless the owner enables its flag');
        assert.ok(events.some((e) => e.text && e.text.startsWith('Your machine is working on it')));
    });

    await check('the default-off session bridge reads the Codes session and emits its tool calls and result as Actor steps', async () => {
        const codes = fakeCodes();
        const { out, events } = await run(createCodes({ config:{...config,codesSessionBridge:true}, fetchImpl:codes.fetchImpl, tokens, sleep:async()=>{}, pollMs:0 }));
        assert.ok(codes.calls.some(c=>c.path===`/run/tasks/${TASK}/session.json` && c.subject===ME && c.auth==='Bearer svc-token'));
        assert.ok(codes.calls.some(c=>c.path===`/run/tasks/${TASK}/session.json` && c.query==='after=3'), 'the client follows session pagination');
        assert.ok(events.some(e=>e.tool==='codes.session.tool' && e.step==='tool_result'));
        assert.ok(events.some(e=>e.tool==='codes.session.tool_result' && e.text.includes('README contents')));
        assert.match(out.text,/Codes session result: Finished the README edit\./);
    });

    await check('signed out, no repository, or no /run task yet: a refusal that says what to do', async () => {
        const codes = createCodes({ config, fetchImpl: fakeCodes().fetchImpl, tokens, sleep: async () => {}, pollMs: 0 });
        await assert.rejects(codes.adapter({ task: 'https://github.com/a/b fix', requester: 'ip:1.2.3.4', emit: async () => {} }), /signed in/);
        await assert.rejects(codes.adapter({ task: 'fix my code', requester: `user:${ME}`, emit: async () => {} }), (e) => e.code === 'actor.task.no_repo');
        const none = fakeCodes({ start: 409, startBody: { code: 'codes.no_project', detail: 'no /run task yet' } });
        await assert.rejects(run(createCodes({ config, fetchImpl: none.fetchImpl, tokens, sleep: async () => {}, pollMs: 0 })), /openvibe\.link\/machines.*openvibe\.codes\/run/);
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

    await check('a named harness rides to Codes; a bad name is refused here', async () => {
        const codes = fakeCodes();
        await run(createCodes({ config, fetchImpl: codes.fetchImpl, tokens, sleep: async () => {}, pollMs: 0 }), { agent: 'muse' });
        assert.strictEqual(codes.calls[0].body.agent, 'muse');
        const plain = fakeCodes();
        await run(createCodes({ config, fetchImpl: plain.fetchImpl, tokens, sleep: async () => {}, pollMs: 0 }));
        assert.ok(!('agent' in plain.calls[0].body), 'absent, Codes routes it');
        const fresh = createCodes({ config, fetchImpl: fakeCodes().fetchImpl, tokens, sleep: async () => {}, pollMs: 0 });
        await assert.rejects(run(fresh, { agent: 'Muse Code!' }), (e) => e.code === 'actor.task.bad_agent');
    });

    await check('a harness the machine cannot run answers with its setup, not the runner\u2019s words', async () => {
        const unknown = fakeCodes({ start: 422, startBody: { code: 'codes.agent_unknown', detail: 'no such harness' } });
        await assert.rejects(run(createCodes({ config, fetchImpl: unknown.fetchImpl, tokens, sleep: async () => {}, pollMs: 0 }), { agent: 'muse' }),
            /Muse Code cannot run on your machine yet.*muse login.*--plan-logins.*--worker/s);
        const other = fakeCodes({ start: 422, startBody: { code: 'codes.agent_unknown', detail: 'no such harness' } });
        await assert.rejects(run(createCodes({ config, fetchImpl: other.fetchImpl, tokens, sleep: async () => {}, pollMs: 0 }), { agent: 'someday' }),
            /no such harness.*openvibe\.codes\/run/s);
        const old = fakeCodes({ states: [{ state: 'failed', error: 'muse is not available here: unknown agent' }] });
        await assert.rejects(run(createCodes({ config, fetchImpl: old.fetchImpl, tokens, sleep: async () => {}, pollMs: 0 }), { agent: 'muse' }),
            /Muse Code cannot run on your machine yet/);
    });

    await check('the one loop\u2019s codes_task passes the agent choice through to Codes', async () => {
        const codesTask = require('../server/runtime/tools/codes_task');
        const codes = fakeCodes();
        const out = await codesTask.run(
            { instruction: 'Add a line to the README.', repo: 'https://github.com/octocat/Hello-World', agent: 'muse' },
            { config, fetch: codes.fetchImpl, requester: `user:${ME}`, taskId: TASK, emit: async () => {} });
        const start = codes.calls.find((c) => c.method === 'POST' && c.path === '/api/v1/tasks');
        assert.strictEqual(start.body.agent, 'muse');
        assert.ok(out.text.includes('Done on your machine'), out.text);
        assert.strictEqual(codesTask.available({ config, requester: `user:${ME}` }), true);
        assert.strictEqual(codesTask.available({ config, requester: 'ip:1.2.3.4' }), false);
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

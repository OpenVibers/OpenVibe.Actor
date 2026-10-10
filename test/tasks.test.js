'use strict';
/**
 * A task end to end through the API and the real adapters (stand-in providers, test/helpers/providers.js): it is
 * classified, routed, run, checked and delivered as platform.task@1 with its cost and explanation; a failed agent or
 * a failed check hands the task on; private mode never sends the text outside OpenVibe; budgets and the free tier are
 * hard; cancel stops it; the live stream replays and ends; nobody sees another person's task.
 */
const assert = require('assert');
const crypto = require('crypto');
const contracts = require('openvibe-contracts');
const { boot, check, done } = require('./helpers/boot');

const valid = (task) => { const v = contracts.validate('platform.task@1', task); assert.ok(v.valid, JSON.stringify(v.errors)); };
const SAME = { 'sec-fetch-site': 'same-origin' };

(async () => {
    const t = await boot();
    const kim = t.network.addUser('kim');
    const lee = t.network.addUser('lee');
    const create = (json, o = {}) => t.get('/api/v1/tasks', { as: o.as || kim, json, headers: { ...SAME, ...(o.headers || {}) } });

    await check('a lookup task runs on the OpenVibe runtime through OpenVibe.Tools, is checked by another family, and is delivered', async () => {
        t.providers.reset();
        t.providers.state.cls = 'lookup';
        const r = await create({ task: 'Who handles mail for openvibe.network?' });
        assert.strictEqual(r.status, 201, r.text);
        const created = r.json();
        valid(created);
        assert.strictEqual(created.state, 'queued');
        assert.match(r.headers.get('location'), /^\/api\/v1\/tasks\/tsk_/);
        await t.waitFor(created.id);
        const task = (await t.get(`/api/v1/tasks/${created.id}`, { as: kim })).json();
        valid(task);
        assert.strictEqual(task.state, 'succeeded', JSON.stringify(task.error));
        assert.strictEqual(task.result.agent, 'openvibe-runtime');
        assert.match(task.result.answer, /mailserver\.example\.com/, 'the tool result reached the answer');
        assert.strictEqual(task.result.checked.by, 'openai');
        assert.strictEqual(task.result.checked.cross_family, true);
        assert.ok(task.cost.usd > 0 && task.cost.usd < 0.01, String(task.cost.usd));
        assert.strictEqual(task.explanation[0].selected, 'openvibe-runtime');
        assert.ok(task.explanation[0].candidates.some((c) => c.id === 'open-model' && /lacks task:lookup/.test(c.excluded_because)));
        assert.ok(t.providers.requests.some((q) => q.path === '/tools/api/v1/tools/mx/run'), 'the runtime called Tools');
        assert.strictEqual(task.requester.type, 'user');
        assert.strictEqual('project_id' in task, false);
    });

    await check('a web task goes to OpenAI\'s agent, with its sources, checked by DeepSeek', async () => {
        t.providers.reset();
        t.providers.state.cls = 'web';
        const id = (await create({ task: 'What changed in the latest Node.js release?' })).json().id;
        await t.waitFor(id);
        const task = (await t.get(`/api/v1/tasks/${id}`, { as: kim })).json();
        assert.strictEqual(task.state, 'succeeded', JSON.stringify(task.error));
        assert.strictEqual(task.result.agent, 'openai-agent');
        assert.deepStrictEqual(task.result.sources, ['https://example.org/source']);
        assert.strictEqual(task.result.checked.by, 'deepseek');
        // 2000 in + 200 out at gpt-5-mini plus one search, plus the classifier and the checker on DeepSeek.
        assert.ok(task.cost.usd > 0.0105 && task.cost.usd < 0.012, String(task.cost.usd));
    });

    await check('private mode: only the open model, and the task text never leaves OpenVibe', async () => {
        t.providers.reset();
        const secret = `private-${crypto.randomBytes(4).toString('hex')}`;
        const id = (await create({ task: `Explain ${secret} in one line`, mode: 'private' })).json().id;
        await t.waitFor(id);
        const task = (await t.get(`/api/v1/tasks/${id}`, { as: kim })).json();
        assert.strictEqual(task.state, 'succeeded', JSON.stringify(task.error));
        assert.strictEqual(task.result.agent, 'open-model');
        assert.strictEqual(task.result.checked.cross_family, false);
        const outside = t.providers.requests.filter((q) => !q.path.startsWith('/local/') && JSON.stringify(q.body).includes(secret));
        assert.deepStrictEqual(outside.map((q) => q.path), [], 'nothing outside the open model saw the task');
        assert.strictEqual(task.cost.usd, 0);
    });

    await check('a private task the open model cannot do fails with why, before any model runs', async () => {
        t.providers.reset();
        const id = (await create({ task: 'What is the MX record of example.com?', mode: 'private' })).json().id;
        const row = await t.waitFor(id);
        assert.strictEqual(row.state, 'failed');
        assert.strictEqual(row.error_code, 'actor.no_agent');
        assert.match(row.error_detail, /Private mode/);
        assert.strictEqual(t.providers.requests.filter((q) => /chat|responses/.test(q.path)).length, 0);
    });

    await check('a failing agent hands the task to the next one; both placements are in the explanation', async () => {
        t.providers.reset();
        t.providers.state.cls = 'research';
        t.providers.state.runtime = 'fail';
        const id = (await create({ task: 'Summarize what OpenVibe is', mode: 'cheapest' })).json().id;
        await t.waitFor(id);
        const task = (await t.get(`/api/v1/tasks/${id}`, { as: kim })).json();
        valid(task);
        assert.strictEqual(task.state, 'succeeded', JSON.stringify(task.error));
        assert.strictEqual(task.result.agent, 'openai-agent');
        assert.strictEqual(task.explanation.length, 2);
        assert.strictEqual(task.explanation[0].selected, 'openvibe-runtime');
        assert.ok(task.explanation[1].candidates.some((c) => c.id === 'openvibe-runtime' && /tried first: HTTP 500/.test(c.excluded_because)));
    });

    await check('an answer that fails its check is not delivered; the next agent gets the task', async () => {
        t.providers.reset();
        t.providers.state.cls = 'research';
        // The OpenAI checker rejects the runtime's answer; DeepSeek accepts the OpenAI agent's.
        t.providers.state.checkOk = (body) => !/Runtime answer/.test(JSON.stringify(body));
        const id = (await create({ task: 'Read about OpenVibe and summarize it', mode: 'cheapest' })).json().id;
        await t.waitFor(id);
        const task = (await t.get(`/api/v1/tasks/${id}`, { as: kim })).json();
        assert.strictEqual(task.state, 'succeeded', JSON.stringify(task.error));
        assert.strictEqual(task.result.agent, 'openai-agent');
        assert.ok(!/Runtime answer/.test(task.result.answer));
        const events = await t.get(`/api/v1/tasks/${id}/events`, { as: kim });
        assert.match(events.text, /Check failed/);
        const refused = [...events.text.matchAll(/^data: (.*)$/gm)].map((m) => JSON.parse(m[1])).filter((e) => e.step === 'text' && e.is_error);
        assert.ok(refused.some((e) => /Runtime answer/.test(e.text)), 'the refused answer is kept as an error event after its check');
        const pageHtml = (await t.get(`/tasks/${id}`, { as: kim })).text;
        assert.match(pageHtml, /See the answer that didn't pass/, 'the task page folds the refused answer away');
        assert.match(pageHtml, /class="outcome outcome-ok answer"/);
    });

    await check('when every agent fails its check the task fails, with no result', async () => {
        t.providers.reset();
        t.providers.state.cls = 'research';
        t.providers.state.checkOk = false;
        const id = (await create({ task: 'Read about OpenVibe and summarize it' })).json().id;
        await t.waitFor(id);
        const task = (await t.get(`/api/v1/tasks/${id}`, { as: kim })).json();
        valid(task);
        assert.strictEqual(task.state, 'failed');
        assert.strictEqual(task.result, null);
        assert.strictEqual(task.error.code, 'actor.agents.exhausted');
    });

    await check('a checker that gives no verdict passes the check to the next one (same family, and the task says so)', async () => {
        t.providers.reset();
        t.providers.state.checkerDown = 'openai';
        const id = (await create({ task: 'Say hello' })).json().id;
        await t.waitFor(id);
        const task = (await t.get(`/api/v1/tasks/${id}`, { as: kim })).json();
        assert.strictEqual(task.state, 'succeeded', JSON.stringify(task.error));
        assert.strictEqual(task.result.agent, 'openvibe-runtime');
        assert.deepStrictEqual([task.result.checked.by, task.result.checked.cross_family], ['deepseek', false]);
        const deepseekChecks = t.providers.requests.filter((q) => q.path === '/deepseek/chat/completions' && /check an AI agent/.test(JSON.stringify(q.body)));
        assert.ok(deepseekChecks.length === 1 && deepseekChecks[0].body.thinking && deepseekChecks[0].body.thinking.type === 'disabled', 'short calls run with DeepSeek reasoning off');
    });

    await check('a hand-off never goes to a weaker agent: after the runtime, the open model is out (lacks quality:standard)', async () => {
        t.providers.reset();
        t.providers.state.cls = 'answer';
        t.providers.state.checkOk = (body) => !/Runtime answer/.test(JSON.stringify(body));
        const id = (await create({ task: 'test', mode: 'balanced' })).json().id;
        await t.waitFor(id);
        const task = (await t.get(`/api/v1/tasks/${id}`, { as: kim })).json();
        assert.strictEqual(task.state, 'succeeded', JSON.stringify(task.error));
        assert.strictEqual(task.result.agent, 'openai-agent');
        assert.ok(task.explanation[1].candidates.some((c) => c.id === 'open-model' && /lacks quality:standard/.test(c.excluded_because)), JSON.stringify(task.explanation[1].candidates));
    });

    await check('a task that did not finish shows why in plain words and offers a retry in Best mode', async () => {
        t.providers.reset();
        t.providers.state.cls = 'research';
        t.providers.state.checkOk = false;
        const id = (await create({ task: 'Read about OpenVibe and summarize it' })).json().id;
        await t.waitFor(id);
        const pageHtml = (await t.get(`/tasks/${id}`, { as: kim })).text;
        assert.match(pageHtml, /Actor couldn't finish this/);
        assert.match(pageHtml, /name="mode" value="best"/);
        assert.match(pageHtml, /Try again in Best mode/);
        assert.match(pageHtml, /class="attempt"/);
    });

    await check('a budget below the cheapest capable agent fails before anything is paid', async () => {
        t.providers.reset();
        t.providers.state.cls = 'web';
        const id = (await create({ task: 'Latest news about Mars', budget: { per_task_usd: 0.001 } })).json().id;
        const row = await t.waitFor(id);
        assert.strictEqual(row.state, 'failed');
        assert.strictEqual(row.error_code, 'actor.budget.exceeded');
        assert.strictEqual(t.providers.requests.filter((q) => q.path === '/openai/responses').length, 0);
    });

    await check('a budget above the free tier is refused, never lowered; an unknown field or a webhook is refused', async () => {
        const over = await create({ task: 'x', budget: { per_task_usd: 5 } });
        assert.strictEqual(over.status, 422);
        assert.strictEqual(over.json().code, 'actor.budget.over_tier');
        const hooks = await create({ task: 'x', webhooks: [{ url: 'https://example.com', events: ['succeeded'] }] });
        assert.strictEqual(hooks.status, 422);
        assert.strictEqual(hooks.json().code, 'actor.task.invalid');
        assert.strictEqual((await create({ task: '   ' })).status, 422);
    });

    await check('an idempotency key answers the first task for the same body and 409 for a different one', async () => {
        t.providers.reset();
        const a = await create({ task: 'Say hi', idempotency_key: 'hello-key-1' });
        const b = await create({ task: 'Say hi', idempotency_key: 'hello-key-1' });
        assert.strictEqual(a.status, 201);
        assert.strictEqual(b.status, 200);
        assert.strictEqual(a.json().id, b.json().id);
        assert.strictEqual((await create({ task: 'Say bye', idempotency_key: 'hello-key-1' })).status, 409);
        await t.waitFor(a.json().id);
    });

    await check('cancel stops a running task; it ends cancelled with the cancel recorded', async () => {
        t.providers.reset();
        t.providers.state.cls = 'lookup';
        t.providers.state.runtime = 'hang';
        const id = (await create({ task: 'MX of example.com please' })).json().id;
        await t.waitFor(id, ['running']);
        await new Promise((r) => setTimeout(r, 150));
        const c = await t.get(`/api/v1/tasks/${id}/cancel`, { as: kim, method: 'POST', headers: SAME });
        assert.ok([200, 202].includes(c.status), c.text);
        await t.waitFor(id, ['cancelled']);
        const task = (await t.get(`/api/v1/tasks/${id}`, { as: kim })).json();
        valid(task);
        assert.strictEqual(task.state, 'cancelled');
        assert.strictEqual(task.cancel.requested_by.id, kim.subject);
    });

    await check('the live stream replays every event after Last-Event-ID and ends with `end`', async () => {
        t.providers.reset();
        const id = (await create({ task: 'Say hello' })).json().id;
        await t.waitFor(id);
        const all = await t.get(`/api/v1/tasks/${id}/events`, { as: kim });
        assert.strictEqual(all.headers.get('content-type'), 'text/event-stream; charset=utf-8');
        const events = [...all.text.matchAll(/^data: (.*)$/gm)].map((m) => JSON.parse(m[1]));
        for (const e of events) assert.ok(contracts.validate('actor.task-event@1', e).valid, JSON.stringify(e));
        assert.deepStrictEqual(events.map((e) => e.seq), events.map((_, i) => i + 1));
        assert.strictEqual(events[events.length - 1].kind, 'end');
        const after = await t.get(`/api/v1/tasks/${id}/events`, { as: kim, headers: { 'last-event-id': String(events.length - 1) } });
        assert.strictEqual([...after.text.matchAll(/^id: /gm)].length, 1);
    });

    await check('nobody sees another person\'s task: 404, the same as a task that does not exist', async () => {
        const id = (await create({ task: 'Mine only' })).json().id;
        assert.strictEqual((await t.get(`/api/v1/tasks/${id}`, { as: lee })).status, 404);
        assert.strictEqual((await t.get(`/api/v1/tasks/${id}/events`, { as: lee })).status, 404);
        assert.strictEqual((await t.get(`/api/v1/tasks/${id}/cancel`, { as: lee, method: 'POST', headers: SAME })).status, 404);
        assert.ok(!(await t.get('/api/v1/tasks', { as: lee })).json().tasks.some((x) => x.id === id));
        const mine = (await t.get('/api/v1/tasks', { as: kim })).json();
        assert.ok(contracts.validate('actor.task-list-result@1', mine).valid);
        assert.ok(mine.tasks.some((x) => x.id === id));
        await t.waitFor(id);
    });

    await check('a signed-in write from another site is refused; no token at all is 401', async () => {
        const cross = await t.get('/api/v1/tasks', { as: kim, json: { task: 'x' }, headers: { 'sec-fetch-site': 'cross-site' } });
        assert.strictEqual(cross.status, 403);
        assert.strictEqual(cross.json().code, 'request.cross_site');
        assert.strictEqual((await t.get('/api/v1/tasks', { json: { task: 'x' } })).status, 401);
    });

    await check('an app token needs actor.task.create; with it the task belongs to its project', async () => {
        const { serviceAuth } = contracts;
        const now = Math.floor(Date.now() / 1000);
        const project = 'prj_01JAB2C3D4E5F6G7H8J9K0MNPR';
        const mint = (cap) => serviceAuth.signServiceToken({ iss: t.network.url, sub: 'app:app_01JAB2C3D4E5F6G7H8J9K0MNPT', actor_type: 'app', aud: ['openvibe.actor'], cap, ns: [project], project_id: project, env: 'production', iat: now, exp: now + 300, jti: `tok_${crypto.randomBytes(6).toString('hex')}` }, t.network.privatePem);
        const denied = await t.get('/api/v1/tasks', { bearer: mint(['actor.task.read']), json: { task: 'x' } });
        assert.strictEqual(denied.status, 403);
        t.providers.reset();
        const ok = await t.get('/api/v1/tasks', { bearer: mint(['actor.task.create', 'actor.task.read']), json: { task: 'Say hello from an app' } });
        assert.strictEqual(ok.status, 201, ok.text);
        assert.strictEqual(ok.json().project_id, project);
        assert.deepStrictEqual(ok.json().requester, { type: 'app', id: 'app_01JAB2C3D4E5F6G7H8J9K0MNPT' });
        await t.waitFor(ok.json().id);
        const read = await t.get(`/api/v1/tasks/${ok.json().id}`, { bearer: mint(['actor.task.read']) });
        assert.strictEqual(read.json().state, 'succeeded');
    });

    await check('a first-party service may act for a person (X-OV-Subject): the task is theirs, the service sees only what it started', async () => {
        const { serviceAuth } = contracts;
        const now = Math.floor(Date.now() / 1000);
        const mint = (sub, actorType, cap, extra = {}) => serviceAuth.signServiceToken({ iss: t.network.url, sub, actor_type: actorType, aud: ['openvibe.actor'], cap, ns: [], iat: now, exp: now + 300, jti: `tok_${crypto.randomBytes(6).toString('hex')}`, ...extra }, t.network.privatePem);
        const watch = mint('svc:watch', 'service', ['actor.task.create', 'actor.task.read', 'actor.task.list']);
        const owner = t.network.addUser('watcher');
        t.providers.reset();
        const ok = await t.get('/api/v1/tasks', { bearer: watch, headers: { 'X-OV-Subject': owner.subject }, json: { task: 'Your watch fired: look into it', idempotency_key: 'watch.run_1.0' } });
        assert.strictEqual(ok.status, 201, ok.text);
        assert.deepStrictEqual(ok.json().requester, { type: 'user', id: owner.subject }, 'the person\'s task');
        valid(ok.json());
        const row = await require('../server/tasks/store').getTask(t.ctx.s, ok.json().id);
        assert.strictEqual(row.via, 'service:watch', 'and it records who started it');
        const again = await t.get('/api/v1/tasks', { bearer: watch, headers: { 'X-OV-Subject': owner.subject }, json: { task: 'Your watch fired: look into it', idempotency_key: 'watch.run_1.0' } });
        assert.deepStrictEqual([again.status, again.json().id], [200, ok.json().id], 'a retried delivery is the same task');
        await t.waitFor(ok.json().id);

        // The person sees it among their own; the service sees only what it started, not the person's other tasks.
        const mine = await t.get('/api/v1/tasks', { as: owner });
        assert.ok(mine.json().tasks.some((x) => x.id === ok.json().id));
        const own = await t.get('/api/v1/tasks', { as: owner, json: { task: 'something of my own' }, headers: SAME });
        assert.strictEqual(own.status, 201);
        await t.waitFor(own.json().id);
        const listed = await t.get('/api/v1/tasks', { bearer: watch, headers: { 'X-OV-Subject': owner.subject } });
        assert.deepStrictEqual(listed.json().tasks.map((x) => x.id), [ok.json().id]);
        assert.strictEqual((await t.get(`/api/v1/tasks/${own.json().id}`, { bearer: watch, headers: { 'X-OV-Subject': owner.subject } })).status, 404);
        assert.strictEqual((await t.get(`/api/v1/tasks/${own.json().id}/cancel`, { bearer: watch, headers: { 'X-OV-Subject': owner.subject }, method: 'POST' })).status, 404, 'nor cancel it');

        // Only a first-party service may name a person, and only a person.
        const app = mint('app:app_01JAB2C3D4E5F6G7H8J9K0MNPT', 'app', ['actor.task.create'], { project_id: 'prj_01JAB2C3D4E5F6G7H8J9K0MNPR', env: 'production', ns: ['prj_01JAB2C3D4E5F6G7H8J9K0MNPR'] });
        let r = await t.get('/api/v1/tasks', { bearer: app, headers: { 'X-OV-Subject': owner.subject }, json: { task: 'x' } });
        assert.deepStrictEqual([r.status, r.json().code], [403, 'subject.not_delegated']);
        r = await t.get('/api/v1/tasks', { bearer: watch, headers: { 'X-OV-Subject': 'svc:live' }, json: { task: 'x' } });
        assert.deepStrictEqual([r.status, r.json().code], [400, 'subject.invalid']);
        r = await t.get('/api/v1/tasks', { bearer: mint('svc:watch', 'service', ['actor.task.read']), headers: { 'X-OV-Subject': owner.subject }, json: { task: 'x' } });
        assert.strictEqual(r.status, 403, 'the capability is still the service\'s to hold');
    });

    await check('the free tier: tasks a day are counted and refused past the limit with Retry-After', async () => {
        const u = t.network.addUser('busy');
        const limit = t.config.allowance.tasksPerDay;
        const store = require('../server/tasks/store');
        await store.addSpend(t.ctx.s, `user:${u.subject}`, 0, { tasks: limit });
        const r = await create({ task: 'one more' }, { as: u });
        assert.strictEqual(r.status, 429);
        assert.strictEqual(r.json().code, 'actor.allowance.exhausted');
        assert.ok(Number(r.headers.get('retry-after')) > 0);
    });

    await check('tasks still running count against the daily budget, so creating many at once cannot overrun it', async () => {
        const store = require('../server/tasks/store');
        const u = t.network.addUser('burst');
        const who = `user:${u.subject}`;
        const { perTaskUsd, perDayUsd } = t.config.allowance;
        const fit = Math.floor(perDayUsd / perTaskUsd + 1e-9);
        // `fit` tasks are open (queued) with nothing spent yet: their budgets are reserved.
        for (let i = 0; i < fit; i++) {
            await store.insertTask(t.ctx.s, { id: t.ctx.s.newId('tsk'), requester: who, task: `open ${i}`, mode: 'balanced', budget_task: perTaskUsd, budget_day: perDayUsd, created_at: t.ctx.s.iso() });
        }
        assert.strictEqual((await store.spendToday(t.ctx.s, who)).usd, 0, 'nothing has accrued yet');
        const r = await create({ task: 'one too many' }, { as: u });
        assert.strictEqual(r.status, 429, r.text);
        assert.strictEqual(r.json().code, 'actor.budget.day_spent');
        await t.ctx.s.db.query("UPDATE tasks SET state = 'cancelled' WHERE requester = $1", [who]);
    });

    await check('the operator\'s daily ceiling over everyone stops new tasks', async () => {
        const store = require('../server/tasks/store');
        await store.addSpend(t.ctx.s, 'user:usr_01JAB2C3D4E5F6G7H8J9K0MNPZ', t.config.spendCapUsdPerDay);
        const r = await create({ task: 'anything' }, { as: t.network.addUser('late') });
        assert.strictEqual(r.status, 503);
        assert.strictEqual(r.json().code, 'actor.capacity.spent');
    });

    await check('nothing the providers were sent or Actor stored contains a provider key', async () => {
        const dump = await t.dbDump();
        for (const k of ['ds-test-key', 'oa-test-key']) {
            assert.ok(!dump.includes(k), `the database holds ${k}`);
            assert.ok(!t.logs().includes(k), `the logs hold ${k}`);
        }
        assert.ok(t.providers.requests.filter((q) => q.path.startsWith('/deepseek')).every((q) => q.auth === 'Bearer ds-test-key'));
        assert.ok(t.providers.requests.filter((q) => q.path.startsWith('/tools') || q.path.startsWith('/search')).every((q) => q.auth === null), 'OpenVibe services get no provider key');
    });

    await t.close();
    done();
})().catch((e) => { console.error(e); process.exit(1); });

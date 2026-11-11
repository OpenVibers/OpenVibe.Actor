'use strict';
/**
 * A product conversation turn (one-engine slice): a product has Actor answer one turn of its own
 * conversation with the person's own allowance. The call carries which conversation it answers, the
 * model, and the tools the run may call; an empty tool list answers with no tool calls. The cost is
 * charged once, to the person the task is for; a refusal or an outage arrives as plain words, never a
 * silent second engine.
 */
const assert = require('assert');
const contracts = require('openvibe-contracts');
const { boot, check, done } = require('./helpers/boot');

const valid = (task) => { const v = contracts.validate('platform.task@1', task); assert.ok(v.valid, JSON.stringify(v.errors)); };
const SAME = { 'sec-fetch-site': 'same-origin' };
/** Every dumped table: dbDump prints one JSON array per table. */
const tableRows = async (t) => {
    const out = [];
    for (const l of (await t.dbDump()).split('\n')) {
        try { const r = JSON.parse(l); if (Array.isArray(r) && r.length) out.push(r); } catch { /* not a row list */ }
    }
    return out;
};
const findTable = (tables, pred) => tables.find((rows) => rows.some(pred));

(async () => {
    const t = await boot();
    const kim = t.network.addUser('kim');
    const create = (json, o = {}) => t.get('/api/v1/tasks', { as: o.as || kim, json, headers: { ...SAME, ...(o.headers || {}) } });

    await check('a turn with no tools answers directly, charges once, and stores its conversation', async () => {
        t.providers.reset();
        const saved = t.config.loop.selfReflections;
        t.config.loop.selfReflections = 0;
        t.providers.state.script = [{ content: 'A quiet weekend: the night train south, one good book, no plans before noon.' }];
        try {
            const turn = {
                task: 'Companion Sable: "Help me plan a quiet weekend."',
                mode: 'cheapest',
                budget: { per_task_usd: 0.05 },
                idempotency_key: 'exchange-companion-chat1-turn1',
                conversation: { product: 'exchange', id: 'cmp_chat_1' },
                tools: [],
            };
            const r = await create(turn);
            assert.strictEqual(r.status, 201, r.text);
            const created = r.json();
            valid(created);
            await t.waitFor(created.id);
            const task = (await t.get(`/api/v1/tasks/${created.id}`, { as: kim })).json();
            valid(task);
            assert.strictEqual(task.state, 'succeeded', JSON.stringify(task.error));
            assert.match(task.result.answer, /quiet weekend/);
            assert.ok(task.cost.usd > 0, 'the turn spent something');
            assert.strictEqual(task.cost.free_allowance_used, task.cost.usd, 'the free allowance paid it');
            // No tool ran anywhere: the answer came from the model alone.
            assert.ok(!t.providers.requests.some((q) => q.path.startsWith('/tools/') || q.path.startsWith('/search/')), 'no tool call left the server');
            // The turn is stored on the row, beside the conversation the product keeps.
            const tables = await tableRows(t);
            const tasks = findTable(tables, (row) => row.id === created.id);
            assert.ok(tasks, 'the task row is in the dump');
            const row = tasks.find((row) => row.id === created.id);
            assert.deepStrictEqual(row.conversation, { product: 'exchange', id: 'cmp_chat_1' });
            assert.deepStrictEqual(row.tools, []);
            assert.strictEqual(row.model, null, 'no model picked: Actor answers on its default');
            assert.strictEqual(row.requester, task.requester.type === 'user' ? `user:${task.requester.id}` : row.requester);
            // Charged once: the day's spend for the person equals what the task cost.
            const spends = findTable(tables, (row) => typeof row.usd === 'number' && 'day' in row);
            assert.ok(spends, 'the spend table is in the dump');
            const spent = spends.filter((r) => String(r.requester) === String(row.requester)).reduce((n, r) => n + Number(r.usd), 0);
            assert.strictEqual(Math.round(spent * 1e6), Math.round(Number(task.cost.usd) * 1e6), 'one charge, not two');
        } finally { t.config.loop.selfReflections = saved; }
    });

    await check('an idempotent turn repeats the first task; different tools are a different task', async () => {
        t.providers.reset();
        const saved = t.config.loop.selfReflections;
        t.config.loop.selfReflections = 0;
        t.providers.state.script = [{ content: 'First answer.' }, { content: 'Second answer.' }];
        try {
            const base = { task: 'Inbox turn one.', mode: 'cheapest', idempotency_key: 'chat-inbox-7-99', conversation: { product: 'chat', id: 'inbox-7' }, tools: [] };
            const first = (await create(base)).json();
            assert.strictEqual(first.state, 'queued');
            const repeat = await create(base);
            assert.strictEqual(repeat.status, 200);
            assert.strictEqual(repeat.json().id, first.id, 'the same turn answers the same task');
            const other = await create({ ...base, tools: ['read_page'] });
            assert.strictEqual(other.status, 409, other.text);
            assert.strictEqual(other.json().code, 'actor.idempotency.conflict');
        } finally { t.config.loop.selfReflections = saved; }
    });

    await check('a tool name nothing offers is said aloud in the run, never silently dropped', async () => {
        t.providers.reset();
        const saved = t.config.loop.selfReflections;
        t.config.loop.selfReflections = 0;
        t.providers.state.script = [{ content: 'Answered without it.' }];
        try {
            const r = await create({ task: 'Inbox turn two.', mode: 'cheapest', idempotency_key: 'chat-inbox-7-100', conversation: { product: 'chat', id: 'inbox-7' }, tools: ['read_page', 'no_such_tool'] });
            assert.strictEqual(r.status, 201, r.text);
            await t.waitFor(r.json().id);
            assert.ok(!t.providers.requests.some((q) => q.path.startsWith('/tools/')), 'nothing ran anyway');
            const events = (await t.get(`/api/v1/tasks/${r.json().id}/events`, { as: kim })).text;
            assert.match(events, /no_such_tool/, 'the run says which allowed name it does not offer');
        } finally { t.config.loop.selfReflections = saved; }
    });

    await check('a first-party service may answer a turn for a person: the turn is theirs, on their allowance', async () => {
        const { serviceAuth } = contracts;
        const crypto = require('crypto');
        const now = Math.floor(Date.now() / 1000);
        const mint = (sub, actorType, cap, extra = {}) => serviceAuth.signServiceToken({ iss: t.network.url, sub, actor_type: actorType, aud: ['openvibe.actor'], cap, ns: [], iat: now, exp: now + 300, jti: `tok_${crypto.randomBytes(6).toString('hex')}`, ...extra }, t.network.privatePem);
        const chat = mint('svc:chat', 'service', ['actor.task.create', 'actor.task.read']);
        const visitor = t.network.addUser('visitor');
        t.providers.reset();
        const saved = t.config.loop.selfReflections;
        t.config.loop.selfReflections = 0;
        t.providers.state.script = [{ content: 'Order 42 ships Tuesday.' }];
        try {
            const r = await t.get('/api/v1/tasks', { bearer: chat, headers: { 'X-OV-Subject': visitor.subject }, json: {
                task: 'You are Vibe, the assistant answering for "Acme".\n\nThe conversation so far:\nThe visitor: Where is my order?',
                mode: 'cheapest', budget: { per_task_usd: 0.05 },
                conversation: { product: 'chat', id: 'inbox:cnv_1/turn:1' }, tools: ['read_page'],
                idempotency_key: 'chat-inbox-cnv_1-1',
            } });
            assert.strictEqual(r.status, 201, r.text);
            // The turn is the person's: their allowance pays for it, and it is their task.
            assert.deepStrictEqual(r.json().requester, { type: 'user', id: visitor.subject }, 'the person\'s turn');
            const row = await require('../server/tasks/store').getTask(t.ctx.s, r.json().id);
            assert.strictEqual(row.via, 'service:chat', 'and it records who asked for it');
            assert.deepStrictEqual(row.conversation, { product: 'chat', id: 'inbox:cnv_1/turn:1' });
            assert.deepStrictEqual(row.tools, ['read_page']);
            await t.waitFor(r.json().id);
            // Their day's spend is the turn's cost: charged once, to the person, not to the service.
            const store = require('../server/tasks/store');
            const days = await store.spendDays(t.ctx.s, `user:${visitor.subject}`, 30);
            const spent = days.reduce((n, d) => n + Number(d.usd || 0), 0);
            assert.ok(spent > 0, 'the person paid for their turn');
            const task = (await t.get(`/api/v1/tasks/${r.json().id}`, { as: visitor })).json();
            assert.ok(task.cost && Number(task.cost.usd) > 0, 'and the task says what it cost');
            assert.ok(Math.abs(spent - Number(task.cost.usd)) < 1e-6, 'charged once, to the person');
        } finally { t.config.loop.selfReflections = saved; }
    });

    await check('a turn may name the content tier, and it is stored on the task', async () => {
        t.providers.reset();
        const saved = t.config.loop.selfReflections;
        t.config.loop.selfReflections = 0;
        t.providers.state.script = [{ content: 'An answer on the adult tier.' }];
        try {
            const r = await create({
                task: 'Companion Sable: "Say hello."', mode: 'cheapest', budget: { per_task_usd: 0.05 },
                idempotency_key: 'exchange-companion-adult-1',
                conversation: { product: 'exchange', id: 'cmp_adult_1' }, tools: [], tier: 'uncensored',
            });
            assert.strictEqual(r.status, 201, r.text);
            await t.waitFor(r.json().id);
            const tables = await tableRows(t);
            const tasks = findTable(tables, (row) => row.id === r.json().id);
            const row = tasks.find((row) => row.id === r.json().id);
            assert.strictEqual(row.tier, 'uncensored', 'the tier is on the task, beside the conversation');
            // The floor is unchanged: the tier only decides which offers may answer.
            assert.strictEqual(row.conversation.product, 'exchange');
        } finally { t.config.loop.selfReflections = saved; }
    });

    await check('a turn that names nobody may not ask for the uncensored tier', async () => {
        const { serviceAuth } = contracts;
        const crypto = require('crypto');
        const now = Math.floor(Date.now() / 1000);
        // A service acting for nobody: no X-OV-Subject, so the task has no person.
        const svc = serviceAuth.signServiceToken({ iss: t.network.url, sub: 'svc:chat', actor_type: 'service', aud: ['openvibe.actor'], cap: ['actor.task.create'], ns: [], iat: now, exp: now + 300, jti: `tok_${crypto.randomBytes(6).toString('hex')}` }, t.network.privatePem);
        const r = await t.get('/api/v1/tasks', { bearer: svc, json: {
            task: 'An anonymous visitor asks for the adult tier.', tier: 'uncensored', conversation: { product: 'chat', id: 'inbox:cnv_anon/turn:1' }, tools: [],
        } });
        assert.strictEqual(r.status, 422, r.text);
        assert.strictEqual(r.json().code, 'actor.tier.no_person');
        assert.match(r.json().detail, /names nobody|standard tier/);
    });

    await check('an unknown content tier is refused in plain words', async () => {
        const r = await create({ task: 'Hi.', tier: 'adult' });
        assert.strictEqual(r.status, 422);
        assert.strictEqual(r.json().code, 'actor.task.invalid');
        assert.match(r.json().detail, /tier/);
    });

    await check('malformed turn fields are refused in plain words', async () => {
        const badTools = await create({ task: 'Hi.', tools: 'read_page' });
        assert.strictEqual(badTools.status, 422);
        assert.strictEqual(badTools.json().code, 'actor.task.invalid');
        assert.match(badTools.json().detail, /tools/);
        const badConv = await create({ task: 'Hi.', conversation: { product: 'exchange' } });
        assert.strictEqual(badConv.status, 422);
        assert.match(badConv.json().detail, /conversation/);
        const badModel = await create({ task: 'Hi.', model: '' });
        assert.strictEqual(badModel.status, 422);
        assert.match(badModel.json().detail, /model/);
    });

    await check('a refusal arrives as words with its code', async () => {
        const r = await create({ task: 'Hi.', budget: { per_task_usd: 50 } });
        assert.strictEqual(r.status, 422);
        assert.strictEqual(r.json().code, 'actor.budget.over_tier');
        assert.match(r.json().detail, /free tier allows/);
    });

    await check('a model this server cannot serve fails in words, never silently', async () => {
        t.providers.reset();
        const r = await create({ task: 'Answer this.', mode: 'cheapest', model: 'openvibe/auto', idempotency_key: 'chat-inbox-7-101', conversation: { product: 'chat', id: 'inbox-7' }, tools: [] });
        assert.strictEqual(r.status, 201, r.text);
        await t.waitFor(r.json().id);
        const task = (await t.get(`/api/v1/tasks/${r.json().id}`, { as: kim })).json();
        assert.strictEqual(task.state, 'failed', JSON.stringify(task.result));
        assert.strictEqual(task.error.code, 'actor.model.unavailable');
        assert.match(task.error.detail, /OpenVibe\.AI is not configured/);
        assert.ok(task.cost.usd < 0.01, 'only the classify-and-plan calls spent');
    });

    await t.close();
    done();
})().catch((e) => { console.error(e); process.exit(1); });

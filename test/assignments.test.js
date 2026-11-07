'use strict';
/**
 * The assignment tree (plan §12 A-2): every hand-off is one node — a person's task, a routine run, outside work,
 * an agent's consult, a Codes or Space task. The root's budget is the tree's budget; the effective level is
 * inherited only along a person's or routine's line; a cancel cascades and stops the tasks below. The API is
 * owner-only (another person gets 404), an existing task gets its root lazily, and every step event carries the
 * assignment id so the Dock can draw the tree later.
 */
const assert = require('assert');
const contracts = require('openvibe-contracts');
const { boot, check, done } = require('./helpers/boot');
const assignments = require('../server/agents/assignments');
const personal = require('../server/agents/personal');
const contacts = require('../server/agents/contacts');
const store = require('../server/tasks/store');

const SAME = { 'sec-fetch-site': 'same-origin' };

(async () => {
    const state = { hang: false };
    const t = await boot({
        loop: {
            close: async () => {},
            run: async (args) => {
                if (state.hang) {
                    return new Promise((resolve, reject) => {
                        const stop = () => reject(Object.assign(new Error('cancelled'), { code: 'actor.task.cancelled' }));
                        if (args.signal.aborted) return stop();
                        args.signal.addEventListener('abort', stop, { once: true });
                    });
                }
                return { text: 'Done.', sources: [], evidence: [], model: 'fake' };
            },
        },
    });
    try {
        const ada = t.network.addUser('ada');
        const bo = t.network.addUser('bo');
        const owner = `user:${ada.subject}`;
        const s = t.ctx.s;
        const create = (json) => t.get('/api/v1/tasks', { as: ada, json, headers: SAME });
        const rootOf = (taskId) => s.db.maybe('SELECT * FROM actor_assignments WHERE task_id = $1 AND depth = 0', [taskId]);
        const validNode = (node) => { const v = contracts.validate('actor.assignment@1', node); assert.ok(v.valid, JSON.stringify(v.errors)); };

        const first = await create({ task: 'Say hi' });
        assert.strictEqual(first.status, 201, first.text);
        const firstRow = await t.waitFor(first.json().id);
        const firstRoot = await rootOf(firstRow.id);

        await check('a person\'s task is one root node, and its owner reads the node and its children', async () => {
            assert.ok(firstRoot, 'the root exists with the task');
            assert.deepStrictEqual([firstRoot.origin, firstRoot.depth, firstRoot.parent, firstRoot.task_id, firstRoot.state], ['person', 0, null, firstRow.id, 'succeeded']);
            validNode(assignments.wire(firstRoot));
            const res = await t.get(`/api/v1/assignments/${firstRoot.id}`, { as: ada });
            assert.strictEqual(res.status, 200, res.text);
            const body = res.json();
            assert.strictEqual(body.assignment.id, firstRoot.id);
            assert.deepStrictEqual(body.children, []);
            assert.ok(contracts.validate('actor.assignment-tree@1', body).valid);
            assert.strictEqual((await t.get(`/api/v1/assignments/${firstRoot.id}`, { as: bo })).status, 404, 'another person gets 404');
            assert.strictEqual((await t.get('/api/v1/assignments/asg_01JAB2C3D4E5F6G7H8J9K0MNPS', { as: ada })).status, 404, 'a node that does not exist is the same 404');
        });

        await check('every step event names its assignment node', async () => {
            const rows = await s.db.many('SELECT body FROM task_events WHERE task_id = $1 ORDER BY seq', [firstRow.id]);
            const events = rows.map((r) => (typeof r.body === 'string' ? JSON.parse(r.body) : r.body));
            const outputs = events.filter((e) => e.kind === 'output');
            assert.ok(outputs.length > 0, 'the run emitted steps');
            for (const e of outputs) {
                assert.strictEqual(e.assignment_id, firstRoot.id, JSON.stringify(e));
                assert.ok(contracts.validate('actor.task-event@2', e).valid, JSON.stringify(contracts.validate('actor.task-event@2', e).errors));
            }
        });

        await check('the level is inherited along a person\'s line, never from outside work', async () => {
            state.hang = true;
            const full = (await contacts.create(s, t.config, owner, { name: 'Full', level: 'full' })).row;
            const r = await create({ task: 'Full work', agent_id: full.id, level: 'full' });
            const row = await t.waitFor(r.json().id, ['running']);
            const root = await rootOf(row.id);
            assert.strictEqual(root.effective_level, 'full');
            const child = await assignments.openChild(s, { owner, parent: root, mode: 'consult', reply: 'resume', level: 'ask' });
            assert.ok(child && child.id, JSON.stringify(child));
            assert.strictEqual(child.level, 'ask', 'the child names its own level');
            assert.strictEqual(child.effective_level, 'full', 'the person\'s line passes its level down');
            assert.strictEqual(child.root, root.id);
            assert.strictEqual(child.depth, 1);
            assert.strictEqual(child.budget_usd, root.budget_usd);
            await t.ctx.engine.cancel(row.id, owner);

            const outside = await require('../server/tasks/create').createTask({
                s, config: t.config, engine: t.ctx.engine, webhooks: t.ctx.webhooks,
                principal: { requester: owner, via: null, project: null },
                body: { task: 'Outside work', level: 'full' }, assignmentOrigin: 'outside',
            });
            assert.strictEqual(outside.status, 201, JSON.stringify(outside));
            await t.waitFor(outside.task.id, ['running']);
            const outsideRoot = await rootOf(outside.task.id);
            assert.strictEqual(outsideRoot.origin, 'outside');
            const below = await assignments.openChild(s, { owner, parent: outsideRoot, mode: 'consult', reply: 'resume', level: 'ask' });
            assert.ok(below && below.id, JSON.stringify(below));
            assert.strictEqual(below.effective_level, 'ask', 'outside work passes no level down');
            await t.ctx.engine.cancel(outside.task.id, owner);
            state.hang = false;
        });

        await check('a routine starting a run is origin routine', async () => {
            const agent = (await personal.create(s, t.config, owner, { name: 'Morning', instructions: 'Summarise the inbox.' })).row;
            const out = await personal.run({ ...t.ctx, s, config: t.config }, agent, '', { origin: 'routine' });
            assert.strictEqual(out.status, 201, JSON.stringify(out));
            await t.waitFor(out.task.id);
            const root = await rootOf(out.task.id);
            assert.strictEqual(root.origin, 'routine');
            assert.strictEqual(root.agent_id, agent.id);
        });

        await check('the root\'s budget stops a child when it is spent', async () => {
            const r = await create({ task: 'Budget work', level: 'full' });
            const row = await t.waitFor(r.json().id);
            const root = await rootOf(row.id);
            await s.db.query('UPDATE actor_assignments SET state = \'running\', budget_usd = 0.05 WHERE id = $1', [root.id]);
            await s.db.query('UPDATE tasks SET cost_usd = 0.06 WHERE id = $1', [row.id]);
            const before = Number(await s.db.value('SELECT count(*) FROM actor_assignments WHERE parent = $1', [root.id]));
            const out = await assignments.openChild(s, { owner, parent: { ...root, state: 'running', budget_usd: 0.05 }, level: 'ask' });
            assert.strictEqual(out.code, 'actor.assignment.budget');
            assert.strictEqual(out.status, 429);
            const after = Number(await s.db.value('SELECT count(*) FROM actor_assignments WHERE parent = $1', [root.id]));
            assert.strictEqual(after, before, 'nothing was added');
        });

        await check('a cancel cascades down the tree and stops the tasks below it', async () => {
            state.hang = true;
            const a = await create({ task: 'Long work A' });
            const b = await create({ task: 'Long work B' });
            const aRow = await t.waitFor(a.json().id, ['running']);
            const bRow = await t.waitFor(b.json().id, ['running']);
            const aRoot = await rootOf(aRow.id);
            const child = await assignments.openChild(s, { owner, parent: aRoot, mode: 'work', reply: 'poll', taskId: bRow.id, state: 'running' });
            assert.ok(child && child.id, JSON.stringify(child));
            const grandchild = await assignments.openChild(s, { owner, parent: child, mode: 'consult', reply: 'resume', state: 'queued' });
            assert.ok(grandchild && grandchild.id, JSON.stringify(grandchild));
            const res = await t.get(`/api/v1/assignments/${aRoot.id}/cancel`, { as: ada, method: 'POST', headers: SAME });
            assert.strictEqual(res.status, 200, res.text);
            const body = res.json();
            assert.ok(contracts.validate('actor.assignment-cancel-result@1', body).valid, JSON.stringify(contracts.validate('actor.assignment-cancel-result@1', body).errors));
            assert.deepStrictEqual(body.cancelled.map((n) => n.id).sort(), [aRoot.id, child.id, grandchild.id].sort());
            for (const node of body.cancelled) assert.strictEqual(node.state, 'cancelled');
            assert.strictEqual((await t.waitFor(aRow.id, ['cancelled'])).state, 'cancelled');
            assert.strictEqual((await t.waitFor(bRow.id, ['cancelled'])).state, 'cancelled', 'the task the child named was stopped too');
            assert.strictEqual((await t.get(`/api/v1/assignments/${aRoot.id}/cancel`, { as: bo, method: 'POST', headers: SAME })).status, 404);
            state.hang = false;
        });

        await check('an existing task gets its root lazily, on the first read', async () => {
            const id = s.newId('tsk');
            await store.insertTask(s, {
                id, requester: owner, via: null, project_id: null, task: 'An older task', mode: 'balanced', agent: null,
                budget_task: 0.01, budget_day: 1, created_at: s.iso(),
            });
            assert.strictEqual(await rootOf(id), null, 'nothing was backfilled');
            const res = await t.get(`/api/v1/tasks/${id}`, { as: ada });
            assert.strictEqual(res.status, 200, res.text);
            const root = await rootOf(id);
            assert.ok(root, 'the read made its root');
            assert.strictEqual(root.origin, 'person');
        });
    } finally {
        await t.close();
    }
    done();
})().catch((e) => { console.error(e); process.exit(1); });

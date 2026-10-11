'use strict';
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const personal = require('../server/agents/personal');
const SAME = { 'sec-fetch-site': 'same-origin' };

(async () => {
    const t = await boot({ env: { ACTOR_FREE_TASKS_PER_DAY: '2' } });
    try {
        const user = t.network.addUser('agent-runner');
        const owner = `user:${user.subject}`;
        const created = await personal.create(t.ctx.s, t.config, owner, { name: 'Reader', instructions: 'Summarize the text.', mode: 'balanced', budget_per_run_usd: 0.02, daily_runs_max: 2, schedule: 'off', status: 'active' });
        const a = created.row;
        await check('manual run uses the task path and ordered prompt', async () => {
            await personal.addMemory(t.ctx.s, owner, a.id, 'Favorite topic is astronomy.');
            const res = await t.get(`/api/v1/me/agents/${a.id}/run`, { as: user, json: { input: 'Explain Mars.' }, headers: SAME });
            assert.strictEqual(res.status, 201);
            const id = res.json().id;
            const task = await require('../server/tasks/store').getTask(t.ctx.s, id);
            assert.strictEqual(task.via, `agent:${a.id}`);
            assert.ok(task.task.indexOf(a.instructions) < task.task.indexOf('Favorite topic is astronomy.'));
            assert.ok(task.task.indexOf('Favorite topic is astronomy.') < task.task.indexOf('Explain Mars.'));
            await t.waitFor(id);
        });
        await check('daily runs and free tier refuse more tasks', async () => {
            const one = await personal.run(t.ctx, a, 'Again');
            assert.strictEqual(one.status, 201);
            const two = await personal.run(t.ctx, a, 'One too many');
            assert.strictEqual(two.status, 429);
            assert.strictEqual(two.code, 'actor.allowance.exhausted');
            const secondUser = t.network.addUser('daily-capped');
            const capped = (await personal.create(t.ctx.s, t.config, `user:${secondUser.subject}`, { name: 'Capped', instructions: 'Answer briefly.', mode: 'balanced', budget_per_run_usd: 0.02, daily_runs_max: 1, schedule: 'off', status: 'active' })).row;
            assert.strictEqual((await personal.run(t.ctx, capped, 'First')).status, 201);
            const excess = await personal.run(t.ctx, capped, 'Second');
            assert.strictEqual(excess.status, 429);
            assert.strictEqual(excess.code, 'actor.agent.limit');
        });
        await check('memory cap evicts oldest agent note, never person note', async () => {
            const db = t.ctx.s.db;
            await db.query('DELETE FROM actor_agent_memory WHERE agent_id = $1', [a.id]);
            await personal.addMemory(t.ctx.s, owner, a.id, 'Keep this.', 'person');
            for (let i = 0; i < 49; i++) await personal.addMemory(t.ctx.s, owner, a.id, `Auto ${i}`, 'agent');
            const old = (await personal.memory(t.ctx.s, owner, a.id)).find((n) => n.text === 'Auto 0');
            assert.ok((await personal.addMemory(t.ctx.s, owner, a.id, 'Newest', 'agent')).row);
            const notes = await personal.memory(t.ctx.s, owner, a.id);
            assert.strictEqual(notes.length, 50);
            assert.ok(notes.some((n) => n.text === 'Keep this.'));
            assert.ok(!notes.some((n) => n.id === old.id));
        });
        await check('a passed REMEMBER line is saved once and hidden from the answer', async () => {
            const fake = await boot({ adapters: {
                checkers: { local: async () => ({ text: '{"ok":true,"reason":"answers"}', cost_usd: 0 }) },
                run: { 'open-model': async () => ({ text: 'Mars is a planet.\nREMEMBER: Likes Mars', sources: [], model: 'fake' }) },
            } });
            try {
                const who = fake.network.addUser('remember-runner');
                const made = await personal.create(fake.ctx.s, fake.config, `user:${who.subject}`, { name: 'Memory', instructions: 'Explain planets.', mode: 'private', budget_per_run_usd: 0.02, daily_runs_max: 2, schedule: 'off', status: 'active' });
                const out = await personal.run(fake.ctx, made.row, 'Mars');
                assert.strictEqual(out.status, 201);
                const row = await fake.waitFor(out.task.id);
                assert.strictEqual(row.state, 'succeeded');
                const result = typeof row.result === 'string' ? JSON.parse(row.result) : row.result;
                assert.strictEqual(result.answer, 'Mars is a planet.');
                const notes = await personal.memory(fake.ctx.s, `user:${who.subject}`, made.row.id);
                assert.strictEqual(notes.length, 1);
                assert.strictEqual(notes[0].text, 'Likes Mars');
                assert.strictEqual(notes[0].origin, 'agent');
            } finally { await fake.close(); }
        });
    } finally { await t.close(); }
    done();
})();

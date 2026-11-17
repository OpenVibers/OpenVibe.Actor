'use strict';
/**
 * GET /api/v1/me/usage (2026-11-17, the owner on the Vibe session: "display usage stats and tokens and all that for each
 * harness or API balances or cost"): what a person's answers used, today and over the days Actor keeps, from each
 * task's receipt: tokens and dollars by how it was paid (OpenVibe's free AI, their key, their computer) and by model,
 * with the free tier's daily limit. Only the person's own tasks count; a task from before receipts counts as a task.
 *   node test/me-usage.test.js
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const store = require('../server/tasks/store');

(async () => {
    const t = await boot();
    try {
        const alice = t.network.addUser('usage-alice');
        const bob = t.network.addUser('usage-bob');
        const s = t.ctx.s;
        const owner = `user:${alice.subject}`;
        const add = async (receipt, daysAgo = 0) => {
            const id = s.newId('tsk');
            await store.insertTask(s, { id, requester: owner, task: 'Test', mode: 'chat', budget_task: 1, budget_day: 5, created_at: s.iso() });
            const at = new Date(Date.parse(s.iso()) - daysAgo * 86_400_000).toISOString();
            await s.db.query('UPDATE tasks SET receipt = $2::jsonb, created_at = $3 WHERE id = $1', [id, receipt ? JSON.stringify(receipt) : null, at]);
            return id;
        };
        await add({ cost: { usd: 0.0095, tokens: 53278, seconds: 60, by: { allowance: { usd: 0.0095, tokens: 53278, seconds: 60 } } }, model: { id: 'deepseek-flash' } });
        await add({ cost: { usd: 0.081, tokens: 15000, seconds: 20, by: { key: { usd: 0.081, tokens: 15000, seconds: 20 } } }, model: { id: 'claude-sonnet-5-5', provider: 'anthropic' } });
        await add({ cost: { usd: 0, tokens: 9000, seconds: 40, by: { machine: { usd: 0, tokens: 9000, seconds: 40 } } }, model: { id: 'qwen2.5-1.5b' } }, 10);
        await add(null, 3);   // a task from before receipts
        await store.addSpend(s, owner, 0.5, { tasks: 0 });

        await check('the person\'s usage: today, the month, by how it was paid and by model', async () => {
            const res = await t.get('/api/v1/me/usage', { as: alice, headers: { accept: 'application/json' } });
            assert.strictEqual(res.status, 200, res.text);
            const u = res.json();
            assert.strictEqual(u.days, 30);
            assert.deepStrictEqual([u.today.tokens, u.today.tasks], [68278, 2]);
            assert.deepStrictEqual(u.today.by, { allowance: { usd: 0.0095, tokens: 53278, tasks: 1 }, key: { usd: 0.081, tokens: 15000, tasks: 1 } });
            assert.deepStrictEqual([u.period.tokens, u.period.tasks], [77278, 4], 'the month has the older tasks too, one with no receipt');
            assert.deepStrictEqual(u.period.by.machine, { usd: 0, tokens: 9000, tasks: 1 });
            assert.ok(u.today.usd >= 0.5 && u.period.usd >= 0.5, `the dollars counted against the day are in (${u.today.usd})`);
            assert.deepStrictEqual(u.models.map((m) => [m.id, m.provider, m.tokens]), [['deepseek-flash', null, 53278], ['claude-sonnet-5-5', 'anthropic', 15000], ['qwen2.5-1.5b', null, 9000]]);
            assert.ok(u.limit && 'per_day_usd' in u.limit && 'tasks_per_day' in u.limit, 'the free tier\'s limit');
            assert.match(String(res.headers.get('cache-control')), /no-store/);
        });

        await check('another person sees only their own (nothing here)', async () => {
            const u = (await t.get('/api/v1/me/usage', { as: bob, headers: { accept: 'application/json' } })).json();
            assert.deepStrictEqual([u.today.tasks, u.period.tasks, u.period.tokens, u.models.length], [0, 0, 0, 0]);
        });

        await check('?days= narrows it; a bad one is refused', async () => {
            const week = (await t.get('/api/v1/me/usage?days=7', { as: alice, headers: { accept: 'application/json' } })).json();
            assert.deepStrictEqual([week.days, week.period.tasks, week.period.tokens], [7, 3, 68278], 'the ten-day-old task is outside a week');
            assert.strictEqual((await t.get('/api/v1/me/usage?days=99', { as: alice, headers: { accept: 'application/json' } })).status, 400);
        });

        await check('signed out: no usage', async () => {
            const res = await t.get('/api/v1/me/usage', { headers: { accept: 'application/json' } });
            assert.ok(res.status === 401 || res.status === 403, `status ${res.status}`);
        });
    } finally {
        await t.close();
    }
    done();
})().catch((e) => { console.error(e); process.exit(1); });

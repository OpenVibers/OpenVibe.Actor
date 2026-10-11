'use strict';
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const personal = require('../server/agents/personal');

(async () => {
    await check('hourly, daily and weekly slots are deterministic', async () => {
        const at = '2026-10-11T12:30:00.000Z';
        assert.strictEqual(personal.nextRun({ schedule: 'hourly' }, at), '2026-10-11T13:30:00.000Z');
        assert.strictEqual(personal.nextRun({ schedule: 'daily', schedule_at: '09:00' }, at), '2026-10-12T09:00:00.000Z');
        assert.strictEqual(personal.nextRun({ schedule: 'weekly', schedule_at: '09:00', schedule_dow: 0 }, at), '2026-10-18T09:00:00.000Z');
    });
    let now = Date.parse('2026-10-11T12:30:00.000Z');
    const submitted = [];
    const t = await boot({ now: () => now, adapters: { run: {}, checkers: {} } });
    try {
        const u = t.network.addUser('scheduled');
        const owner = `user:${u.subject}`;
        const base = { instructions: 'Tell me the date.', mode: 'private', budget_per_run_usd: 0.01, daily_runs_max: 1, schedule: 'hourly', status: 'active' };
        const a = (await personal.create(t.ctx.s, t.config, owner, { ...base, name: 'Hourly' })).row;
        const paused = (await personal.create(t.ctx.s, t.config, owner, { ...base, name: 'Paused', status: 'paused' })).row;
        const fake = { ...t.ctx, engine: { submit(id) { submitted.push(id); } } };
        now += 3_600_001;
        await check('overlapping ticks claim once and paused agents do not run', async () => {
            await Promise.all([personal.tick(fake), personal.tick(fake)]);
            assert.strictEqual(submitted.length, 1);
            assert.strictEqual((await personal.get(t.ctx.s, owner, paused.id)).last_run_at, null);
        });
        await check('over-limit slot advances and records a reason', async () => {
            now += 3_600_001;
            await personal.tick(fake);
            assert.strictEqual(submitted.length, 1);
            const after = await personal.get(t.ctx.s, owner, a.id);
            assert.match(after.last_skip_reason, /actor.agent.limit/);
            assert.ok(after.next_run_at > new Date(now).toISOString());
        });
    } finally { await t.close(); }
    done();
})();

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
    await check('quiet hours: an hourly run waits for their end, across midnight too', async () => {
        const night = { schedule: 'hourly', quiet_from: '22:00', quiet_to: '07:00' };
        assert.strictEqual(personal.nextRun(night, '2026-10-11T20:30:00.000Z'), '2026-10-11T21:30:00.000Z');
        assert.strictEqual(personal.nextRun(night, '2026-10-11T21:30:00.000Z'), '2026-10-12T07:00:00.000Z');
        assert.strictEqual(personal.nextRun(night, '2026-10-12T02:15:00.000Z'), '2026-10-12T07:00:00.000Z');
        assert.strictEqual(personal.nextRun(night, '2026-10-12T07:00:00.000Z'), '2026-10-12T08:00:00.000Z');
        const lunch = { schedule: 'hourly', quiet_from: '13:00', quiet_to: '14:00' };
        assert.strictEqual(personal.nextRun(lunch, '2026-10-11T12:30:00.000Z'), '2026-10-11T14:00:00.000Z');
        assert.ok(personal.inQuiet(night, '2026-10-11T23:59:00.000Z') && !personal.inQuiet(night, '2026-10-11T07:00:00.000Z'));
    });
    await check('quiet hours: both or neither, HH:MM, not empty, and a daily time cannot sit inside them', async () => {
        const config = { allowance: { perTaskUsd: 0.05 } };
        const ok = { name: 'A', instructions: 'B', mode: 'balanced', budget_per_run_usd: 0.01, daily_runs_max: 1, schedule: 'daily', schedule_at: '09:00', schedule_dow: null, status: 'active' };
        assert.strictEqual(personal.validate({ ...ok, quiet_from: '22:00', quiet_to: '07:00' }, config), null);
        assert.match(personal.validate({ ...ok, quiet_from: '22:00' }, config), /set both or neither/);
        assert.match(personal.validate({ ...ok, quiet_from: '22:00', quiet_to: '7am' }, config), /HH:MM/);
        assert.match(personal.validate({ ...ok, quiet_from: '22:00', quiet_to: '22:00' }, config), /same time/);
        assert.match(personal.validate({ ...ok, schedule_at: '23:30', quiet_from: '22:00', quiet_to: '07:00' }, config), /inside the quiet hours/);
        assert.strictEqual(personal.validate({ ...ok, schedule: 'off', schedule_at: null, quiet_from: '22:00', quiet_to: '07:00' }, config), null);
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
        await check('a scheduled agent with quiet hours is next due when they end', async () => {
            const quiet = (await personal.create(t.ctx.s, t.config, owner, { ...base, name: 'Quiet', quiet_from: '13:00', quiet_to: '20:00' })).row;
            assert.strictEqual(quiet.quiet_from, '13:00');
            assert.strictEqual(quiet.next_run_at, '2026-10-11T20:00:00.000Z');
            const moved = (await personal.update(t.ctx.s, t.config, owner, quiet.id, { quiet_from: null, quiet_to: null })).row;
            assert.strictEqual(moved.next_run_at, new Date(now + 3_600_000).toISOString(), 'clearing them reschedules');
        });
    } finally { await t.close(); }
    done();
})();

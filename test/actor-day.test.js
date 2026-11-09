'use strict';
const assert = require('assert');
const crypto = require('crypto');
const { boot, done } = require('./helpers/boot');
const tasks = require('../server/tasks/store');
const SAME = { 'sec-fetch-site': 'same-origin' };
async function until(fn) {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) { const value = await fn(); if (value) return value; await new Promise((r) => setTimeout(r, 25)); }
    throw new Error('condition did not become true');
}
(async () => {
    let clock = Date.now();
    const notices = [];
    const t = await boot({ now: () => clock, env: { ACTOR_CHECKPOINT_KEY: crypto.randomBytes(32).toString('hex') },
        notifier: { needsYou: async (q) => { notices.push(q); }, taskEnded: async () => {} } });
    const api = (user, path = '', json, method) => t.get('/api/v1/me/actor' + path, { as: user, json, method, headers: SAME });
    try {
        const bea = t.network.addUser('bea');
        const other = t.network.addUser('other');
        const owner = 'user:' + bea.subject;
        const a = (await api(bea)).json();
        assert.equal(a.enabled, false);
        assert.equal(a.status, 'paused');
        assert.equal((await api(bea)).json().id, a.id, 'one Actor per person');
        const saved = await api(bea, '/goals', { text: 'Research a useful topic', lane: 'brief_me' });
        assert.equal(saved.status, 201, saved.text);
        const goal = saved.json();
        assert.deepEqual(goal.asks_before, []);
        assert.equal((await api(other, '/goals/' + goal.id, { text: 'stolen' }, 'PATCH')).status, 404);
        await api(bea, '/tell', { text: 'Focus on the cost of living.' });
        assert.deepEqual(await t.ctx.day.tick(), [], 'off means no task');
        assert.equal(t.providers.loopCalls(), 0);
        const on = await api(bea, '/resume', {});
        assert.equal(on.status, 200, on.text);
        t.config.loop.selfReflections = 0;
        t.providers.reset(); t.providers.state.smart = 'tool';
        t.providers.state.script = [{ content: 'I need your preferred city.', tool_calls: [{ id: 'ask_1', type: 'function', function: {
            name: 'ask_person', arguments: JSON.stringify({ kind: 'answer_question', text: 'Which city should I research?', options: ['Paris', 'Berlin'] }),
        } }] }];
        const ids = await t.ctx.day.tick();
        assert.equal(ids.length, 1, 'a due goal starts');
        const id = ids[0];
        assert.deepEqual(await t.ctx.day.tick(), [], 'an active goal cannot start twice');
        const ask = await until(async () => (await t.ctx.day.asks(owner))[0]);
        const q = await t.ctx.s.db.maybe('SELECT * FROM actor_day_asks WHERE id=$1', [ask.id]);
        await until(async () => { const w = await t.ctx.waits.get(q.wait_id); return w.remaining_ms != null; });
        const calls = t.providers.loopCalls();
        await new Promise((r) => setTimeout(r, 100));
        assert.equal(t.providers.loopCalls(), calls, 'a parked goal makes no model calls');
        assert.equal(notices.length, 1, 'one push for this ask');
        assert.equal((await api(other, '/asks/' + ask.id + '/answer', { text: 'Paris' })).status, 404);
        const answered = await api(bea, '/asks/' + ask.id + '/answer', { text: 'Berlin' });
        assert.equal(answered.status, 200, answered.text);
        const end = await t.waitFor(id);
        assert.equal(end.state, 'succeeded', end.error_detail);
        assert.ok(t.providers.requests.some((r) => JSON.stringify(r).includes('Berlin')), 'the durable answer reaches the resumed model');
        assert.equal((await t.ctx.day.asks(owner)).length, 0);
        const journal = (await api(bea, '/journal')).json();
        assert.ok(journal.items.length > 0);
        assert.ok(journal.items.every((x) => x.goal_id === goal.id));
        assert.ok((await tasks.getTask(t.ctx.s, id)).task.includes('Focus on the cost of living.'));
        assert.equal((await api(other, '/journal')).json().items.length, 0);
        await api(bea, '/pause', {});
        await api(bea, '', { caps: { usd: 0, minutes: 60, balance_floor_usd: 0 } }, 'PATCH');
        clock += 2 * 86400000;
        await api(bea, '/resume', {});
        assert.deepEqual(await t.ctx.day.tick(), [], 'money cap stops the day');
        await api(bea, '/pause', {});
        await api(bea, '', { caps: { usd: 1, minutes: 0, balance_floor_usd: 0 } }, 'PATCH');
        await api(bea, '/resume', {});
        assert.deepEqual(await t.ctx.day.tick(), [], 'minutes cap stops the day');
        await api(bea, '/pause', {});
        await api(bea, '', { caps: { usd: 1, minutes: 60, balance_floor_usd: 1000 } }, 'PATCH');
        await api(bea, '/resume', {});
        assert.deepEqual(await t.ctx.day.tick(), [], 'balance floor stops the day');
        await api(bea, '/pause', {});
        assert.equal((await api(bea)).json().status, 'paused');
        console.log('actor day: off, due, ask, durable answer, privacy, journal and caps');
    } finally { await t.close(); }
    done();
})().catch((err) => { console.error(err); process.exit(1); });

'use strict';
/**
 * Per-caller rate limits (server/http/caller-limits.js, roadmap WS-R task 4): past its limit one caller
 * gets 429 problem+json `rate_limited` with Retry-After, before the route does any work, while
 * another caller still passes; the window reopens on the clock. A person counts as themselves, anyone
 * else by address. Actor's own budgets are pinned: actor.task.create 6 a minute, actor.route 30,
 * actor.task.stream 30; reads take ACTOR_LIMITS_MINUTE/ACTOR_LIMITS_HOUR. Health, ready, release.json
 * and metrics are never limited; refusals are logged (no token) and counted in actor_rate_limited_total.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const { caller, BUDGETS } = require('../server/http/caller-limits');

const SAME = { 'sec-fetch-site': 'same-origin' };

(async () => {
    // The limiter's clock: 15 s into a minute, so the minute window has 45 s left. Reads: 3 a minute.
    let clock = Date.UTC(2026, 8, 27, 12, 0, 15);
    const t = await boot({ callerLimits: true, limitsNow: () => clock, env: { ACTOR_LIMITS_MINUTE: '3', ACTOR_LIMITS_HOUR: '100' } });
    const rosa = t.network.addUser('rosa');
    const sam = t.network.addUser('sam');

    await check('the budgets are pinned', () => {
        assert.deepStrictEqual(BUDGETS, {
            'actor.task.create': { minute: 6, hour: 60 },
            'actor.route': { minute: 30, hour: 600 },
            'actor.task.stream': { minute: 30, hour: 600 },
        });
    });

    await check('an agent-list read: 3 a minute per address, then 429 rate_limited with Retry-After; another address passes', async () => {
        const from = (ip) => ({ headers: { 'x-forwarded-for': ip } });
        for (let i = 0; i < 3; i++) assert.strictEqual((await t.get('/api/v1/agents', from('203.0.113.7'))).status, 200);
        const r = await t.get('/api/v1/agents', from('203.0.113.7'));
        assert.strictEqual(r.status, 429);
        assert.match(r.headers.get('content-type'), /application\/problem\+json/);
        assert.ok(Number(r.headers.get('retry-after')) > 0 && Number(r.headers.get('retry-after')) <= 45, r.headers.get('retry-after'));
        const body = r.json();
        assert.strictEqual(body.code, 'rate_limited');
        assert.ok(body.detail.includes('actor.agent.read'), body.detail);
        assert.strictEqual((await t.get('/api/v1/agents', from('203.0.113.8'))).status, 200, 'another address still passes');
    });

    await check('a signed-in person counts as themselves, not by address', async () => {
        for (let i = 0; i < 3; i++) assert.strictEqual((await t.get('/api/v1/agents', { as: rosa, headers: { 'x-forwarded-for': '203.0.113.7' } })).status, 200, 'rosa is not the address that was refused');
        const r = await t.get('/api/v1/agents', { as: rosa, headers: { 'x-forwarded-for': '203.0.113.9' } });
        assert.strictEqual(r.status, 429, 'rosa is over her own limit from any address');
        assert.strictEqual((await t.get('/api/v1/agents', { as: sam, headers: { 'x-forwarded-for': '203.0.113.9' } })).status, 200, 'another person still passes');
    });

    await check('the next minute opens the window again', async () => {
        clock += 60_000;
        assert.strictEqual((await t.get('/api/v1/agents', { as: rosa })).status, 200);
    });

    await check('actor.task.create: 6 a minute per person (counted before the body is checked), the 7th refused; another person still creates', async () => {
        for (let i = 0; i < 6; i++) assert.strictEqual((await t.get('/api/v1/tasks', { as: sam, json: {}, headers: SAME })).status, 422, `request ${i + 1} reaches the route`);
        const r = await t.get('/api/v1/tasks', { as: sam, json: {}, headers: SAME });
        assert.strictEqual(r.status, 429);
        assert.strictEqual(r.json().code, 'rate_limited');
        assert.ok(r.json().detail.includes('actor.task.create'), r.json().detail);
        assert.strictEqual((await t.get('/api/v1/tasks', { as: rosa, json: {}, headers: SAME })).status, 422, 'another person still reaches the route');
    });

    await check('the router has its own number: 30 a minute, the 31st refused', async () => {
        for (let i = 0; i < 30; i++) assert.strictEqual((await t.get('/api/v1/route', { json: { task: 'write a haiku' } })).status, 200);
        const r = await t.get('/api/v1/route', { json: { task: 'write a haiku' } });
        assert.strictEqual(r.status, 429);
        assert.ok(r.json().detail.includes('actor.route'), r.json().detail);
        assert.strictEqual((await t.get('/api/v1/route', { json: { task: 'write a haiku' }, headers: { 'x-forwarded-for': '203.0.113.50' } })).status, 200, 'another address still routes');
    });

    await check('the live stream has its own number: 30 a minute per person, the 31st refused', async () => {
        const events = (u) => t.get('/api/v1/tasks/tsk_0000000000000000/events', { as: u });
        for (let i = 0; i < 30; i++) assert.notStrictEqual((await events(rosa)).status, 429, `stream ${i + 1}`);
        const r = await events(rosa);
        assert.strictEqual(r.status, 429);
        assert.ok(r.json().detail.includes('actor.task.stream'), r.json().detail);
        assert.notStrictEqual((await events(sam)).status, 429, 'another person still streams');
    });

    await check('health, ready, release.json and metrics are never limited', async () => {
        for (let i = 0; i < 6; i++) {
            assert.strictEqual((await t.get('/api/health')).status, 200);
            assert.notStrictEqual((await t.get('/api/ready')).status, 429);
            assert.strictEqual((await t.get('/release.json')).status, 200);
            assert.strictEqual((await t.get('/metrics')).status, 200);
        }
    });

    await check('refusals are counted in actor_rate_limited_total and logged without a token', async () => {
        const m = (await t.get('/metrics')).text;
        const counted = m.split('\n').filter((l) => l.includes('actor_rate_limited_total')).join('\n');
        assert.ok(/actor_rate_limited_total\{limit="actor.agent.read",window="minute"\} 2/.test(m), counted);
        assert.ok(/actor_rate_limited_total\{limit="actor.task.create",window="minute"\} 1/.test(m), counted);
        assert.ok(/actor_rate_limited_total\{limit="actor.route",window="minute"\} 1/.test(m), counted);
        assert.ok(/actor_rate_limited_total\{limit="actor.task.stream",window="minute"\} 1/.test(m), counted);
        const logs = t.logs();
        assert.ok(logs.includes(`[Limits] actor.agent.read: user:${rosa.subject} refused`), 'one log line per refusal');
        assert.ok(logs.includes(`[Limits] actor.task.create: user:${sam.subject} refused`), 'the create refusal is logged');
        assert.ok(!/\[Limits\][^\n]*eyJ/.test(logs), 'a token in the log');
    });

    await check('who is counted', () => {
        assert.strictEqual(caller({ principal: { requester: 'app:app_x' }, viewer: { kind: 'user', subject: 'usr_a' }, ip: '203.0.113.1' }), 'app:app_x', 'a principal wins');
        assert.strictEqual(caller({ viewer: { kind: 'user', subject: 'usr_a' }, ip: '203.0.113.1' }), 'user:usr_a');
        assert.strictEqual(caller({ viewer: { kind: 'anonymous' }, ip: '198.51.100.4' }), 'ip:198.51.100.4');
    });

    await t.close();
    done();
})();

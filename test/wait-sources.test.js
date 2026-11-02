'use strict';
/**
 * The wait sources of plan A2b: one of the person's own Watch alerts firing, a channel going live on OpenVibe.Live,
 * a new release of an OpenVibe service. Each source's filter matches its own payload and not another's; a Watch
 * alert for another person never wakes the wait (the payload names who is notified); a stream on another channel or a
 * release of another service does not either. The wait_for tool passes each source's target through.
 *
 *   node test/wait-sources.test.js
 */
const assert = require('assert');
const { testDb } = require('./helpers/db');
const { createStore } = require('../server/db');
const { createWaits } = require('../server/waits');
const waitFor = require('../server/runtime/tools/wait_for');

const A = 'usr_01JZ0000000000000000000AAA';
const B = 'usr_01JZ0000000000000000000BBB';
let clock = Date.now();
const at = () => new Date(clock + 1000).toISOString();
let n = 0;
const eventId = () => `evt_01JZ00000000000000000S${String(++n).padStart(4, '0')}`;

const watchEvent = (recipient, watchId = 'wch_lisbon_flights') => ({ event_id: eventId(), event_type: 'watch.watch.triggered', source: 'watch', at: at(), subject: { type: 'watch', id: watchId },
    payload: { watch_id: watchId, recipient, project_id: null, name: 'Flights to Lisbon', condition: { below: 120 }, observation: { id: 'obs_1', observed_at: at(), value: 99, previous_value: 140 }, fired_at: at() } });
const liveEvent = (username) => ({ event_id: eventId(), event_type: 'live.stream.started', source: 'live', at: at(), subject: { type: 'stream', id: '2722' },
    payload: { stream_id: 2722, channel: { username, display_name: username, url: `https://openvibe.live/${username}`, subject: null }, title: 'Building', category: null, protocol: 'webrtc', is_nsfw: false, started_at: at() } });
const releaseEvent = (service) => ({ event_id: eventId(), event_type: 'host.release.published', source: 'host', at: at(), subject: { type: 'release', id: `${service}-r1` },
    payload: { service, release: 'rel_20261102T160000Z_abc123', commit: 'abc123', origin: `https://openvibe.${service}`, deployed_at: at() } });

(async () => {
    const d = await testDb();
    const s = createStore(d.db, { now: () => Date.now() });
    const resumed = [];
    const engine = {
        resumeWithEvent: async (taskId, payload) => { resumed.push({ taskId, payload }); return { id: taskId }; },
        resumeWithNotice: async () => null, failTask: async () => null, notifyWaitTimeout: async () => null,
    };
    const config = { waits: { perPerson: 20, perTask: 1, perTaskLifetime: 5, deadlineMs: 6 * 60 * 60_000, filterClauses: 4 } };
    const waits = createWaits({ s, config, log: { warn() {}, log() {}, error() {} }, now: () => clock, engine, events: null });
    let t = 0;
    const mkTask = async (requester = `user:${A}`) => {
        const id = `tsk_01JZ000000000000000000S${String(++t).padStart(3, '0')}`;
        await s.db.query("INSERT INTO tasks (id, requester, task, mode, budget_task, budget_day, state, created_at) VALUES ($1, $2, 'wait', 'balanced', 1, 1, 'running', $3)", [id, requester, new Date(clock).toISOString()]);
        return id;
    };
    const wait = async (source, target, requester = `user:${A}`) => waits.create({ taskId: await mkTask(requester), requester, source, target, seconds: 900 });
    const failed = [];
    const ok = async (name, fn) => {
        try { await fn(); process.stdout.write('  ok ' + name + '\n'); } catch (e) { failed.push(name); process.stdout.write('  FAIL ' + name + '\n    ' + (e.stack || String(e)).split('\n').slice(0, 6).join('\n    ') + '\n'); }
    };

    try {
        await ok('watch: only the person\'s own alert wakes it; a watch id narrows it to that one', async () => {
            const any = await wait('watch', '');
            assert.strictEqual(any.until.topic, 'watch.watch.triggered');
            assert.strictEqual(any.filter['payload.recipient'], A);
            assert.ok(!('payload.state' in any.filter), 'a Watch alert has no state to filter on');
            assert.strictEqual(any.line, 'waiting for one of your watches to fire');
            assert.strictEqual(await waits.onEvent(watchEvent(B)), 'ignored:no-match', 'another person\'s alert');
            assert.strictEqual(await waits.onEvent(watchEvent(A)), 'woken:1');
            assert.strictEqual(resumed.at(-1).payload.event.payload.recipient, A, 'the event reaches the run as data');
            const one = await wait('watch', 'wch_rent_ceiling');
            assert.strictEqual(one.filter['payload.watch_id'], 'wch_rent_ceiling');
            assert.strictEqual(await waits.onEvent(watchEvent(A, 'wch_other')), 'ignored:no-match', 'another of their watches');
            assert.strictEqual(await waits.onEvent(watchEvent(A, 'wch_rent_ceiling')), 'woken:1');
            await assert.rejects(wait('watch', 'no spaces allowed'), (e) => e.code === 'actor.wait.target');
        });

        await ok('live: the channel by its username, either spelling; another channel does not wake it', async () => {
            const w = await wait('live', '@Maticus');
            assert.strictEqual(w.until.topic, 'live.stream.started');
            assert.deepStrictEqual(w.filter['payload.channel.username'], ['Maticus', 'maticus']);
            assert.strictEqual(w.line, 'waiting for Maticus to go live');
            assert.strictEqual(await waits.onEvent(liveEvent('somebody')), 'ignored:no-match');
            assert.strictEqual(await waits.onEvent(liveEvent('maticus')), 'woken:1');
            await assert.rejects(wait('live', ''), (e) => e.code === 'actor.wait.target', 'a channel is required');
        });

        await ok('release: a new release of the named service; another service does not wake it', async () => {
            const w = await wait('release', 'Live');
            assert.strictEqual(w.until.topic, 'host.release.published');
            assert.strictEqual(w.filter['payload.service'], 'live');
            assert.strictEqual(w.line, 'waiting for a new release of OpenVibe Live');
            assert.strictEqual(await waits.onEvent(releaseEvent('chat')), 'ignored:no-match');
            assert.strictEqual(await waits.onEvent(releaseEvent('live')), 'woken:1');
            await assert.rejects(wait('release', 'not a service!'), (e) => e.code === 'actor.wait.target');
        });

        await ok('an event from before the wait never wakes it', async () => {
            await wait('live', 'latecomer');
            const old = liveEvent('latecomer');
            old.at = new Date(clock - 60_000).toISOString();
            assert.strictEqual(await waits.onEvent(old), 'ignored:no-match');
        });

        await ok('the tool: each source\'s target goes through; the model never names the person', async () => {
            const asked = [];
            const ctx = { requester: `user:${A}`, taskId: await mkTask(), waits: { create: async (o) => { asked.push(o); return { id: 'wai_x', line: o.line || 'x', deadline_at: new Date(clock + 900_000).toISOString(), on_timeout: 'ask' }; } } };
            for (const [input, target] of [[{ source: 'watch', watch_id: 'wch_1', seconds: 600 }, 'wch_1'], [{ source: 'live', channel: 'maticus', seconds: 600 }, 'maticus'], [{ source: 'release', service: 'chat', seconds: 600 }, 'chat']]) {
                const r = await waitFor.run(input, ctx);
                assert.ok(r.park && r.park.wait_id === 'wai_x', JSON.stringify(r));
                assert.strictEqual(asked.at(-1).target, target);
                assert.strictEqual(asked.at(-1).requester, `user:${A}`);
            }
            assert.deepStrictEqual(waitFor.input.properties.source.enum, ['codes', 'run', 'watch', 'live', 'release', 'time']);
        });
    } finally {
        await d.close();
    }
    if (failed.length) { console.error(`wait-sources: ${failed.length} failed`); process.exit(1); }
    console.log('wait-sources: all checks passed');
})().catch((err) => { console.error(err); process.exit(1); });

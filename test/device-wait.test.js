'use strict';

const assert = require('assert');
const { testDb } = require('./helpers/db');
const { createStore } = require('../server/db');
const { createWaits } = require('../server/waits');
const approvals = require('../server/agents/approvals');
const device = require('../server/runtime/tools/_device');

(async () => {
    const db = await testDb();
    try {
        const s = createStore(db.db);
        const owner = 'user:usr_01JAB2C3D4E5F6G7H8J9K0MNPS';
        const task = s.newId('tsk');
        await s.db.query("INSERT INTO tasks (id, requester, task, mode, budget_task, budget_day, state, created_at) VALUES ($1, $2, 'device wait', 'balanced', 1, 1, 'running', $3)", [task, owner, s.iso()]);
        const resumed = [];
        const waits = createWaits({ s, config: { waits: {} }, engine: {
            resumeWithEvent: async (id, event) => { resumed.push({ id, event }); },
        } });
        const run = { store: s, waits, config: { baseUrl: 'https://openvibe.actor' },
            requester: owner, agentId: s.newId('agt'), taskId: task };
        const asked = await device.ask(run, 'device.location', { why: 'Find nearby help' });
        assert.ok(asked.park.wait_id);
        const row = await approvals.get(s, owner, asked.data.approval_id);
        assert.strictEqual(row.device_wait_id, asked.park.wait_id);
        await waits.setRemaining(asked.park.wait_id, 60_000);
        const result = await approvals.answer({ s, waits }, owner, row.id, { decision: 'answer', location: {
            lat: 37.77, lng: -122.42, accuracy_m: 250, precise: false,
        } });
        assert.ok(result.row);
        assert.strictEqual(resumed.length, 1);
        assert.strictEqual(resumed[0].id, task, 'only the asking run resumes');
        assert.strictEqual(resumed[0].event.event.payload.location, undefined);
        assert.deepStrictEqual(resumed[0].event.event.payload.result.location,
            { lat: 37.77, lng: -122.42, accuracy_m: 1000, precise: false });
        assert.strictEqual((await waits.get(asked.park.wait_id)).status, 'woken');
        assert.strictEqual((await approvals.answer({ s, waits }, owner, row.id, { decision: 'answer', location: {
            lat: 0, lng: 0, accuracy_m: 1, precise: false,
        } })).status, 409);
        assert.strictEqual(resumed.length, 1, 'the same approval cannot resume twice');
        process.stdout.write('  ✓ one device answer resumes only its asking run, once, as untrusted event data\n\nall passed\n');
    } finally { await db.close(); }
})().catch((e) => { console.error(e); process.exit(1); });

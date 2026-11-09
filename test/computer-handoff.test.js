'use strict';
/**
 * One Computer across Surf, the Dock and Actor (plan 2026-11-07): the task's record and its step carry the same
 * computer { session_id, machine, where, cost_hint }; the still is the task person's alone (another person and a
 * signed-out visitor get 404); Take over marks the person as driving and the agent's input is refused with a reason;
 * Give it back hands the desk over again. The session's service is a stand-in here, exactly as Bot/Run are in the
 * other suites.
 *   node test/computer-handoff.test.js
 */
const assert = require('assert');
const contracts = require('openvibe-contracts');
const { boot, check, done } = require('./helpers/boot');
const store = require('../server/tasks/store');
const driving = require('../server/agents/driving');
const timeline = require('../server/agents/timeline');
const computerInput = require('../server/runtime/tools/computer_input');
const computerBrowser = require('../server/runtime/tools/computer_browser');

const SAME = { 'sec-fetch-site': 'same-origin', accept: 'application/json' };
const SESSION = 'ses_01JAB2C3D4E5F6G7H8J9K0MNPQ';
const COMPUTER = { session_id: SESSION, machine: 'a shared desk host', where: 'network', cost_hint: 'a desk host, metered by the minute' };

(async () => {
    const still = Buffer.from('/9j/4AAQ', 'base64');
    const asked = [];
    let stillType = 'image/jpeg';
    const computers = {
        enabled: true,
        async still(subject, sessionId) { asked.push([subject, sessionId]); return { bytes: still, type: stillType }; },
    };
    const t = await boot({ bot: { computers } });
    const kim = t.network.addUser('kim');
    const bo = t.network.addUser('bo');
    const s = t.ctx.s;
    const valid = (task) => { const v = contracts.validate('platform.task@1', task); assert.ok(v.valid, JSON.stringify(v.errors)); };

    async function runningTask(text) {
        const id = (await t.get('/api/v1/tasks', { as: kim, json: { task: text }, headers: SAME })).json().id;
        await t.waitFor(id);
        await s.db.query("UPDATE tasks SET state = 'running' WHERE id = $1", [id]);
        return id;
    }

    try {
        const id = await runningTask('Compare three hosting plans under $10 a month and tell me which one to pick.');
        await store.appendEvent(s, id, {
            at: new Date().toISOString(), kind: 'output', step: 'tool_result', tool: 'computer_desk', is_error: false,
            text: JSON.stringify({ watch: 'https://openvibe.link/machines/dev_01J8Z4M2Q0R7T9YV3K6N8P1W2A/screen?desk=desk-trains', running: true, kind: 'browser' }),
            computer: COMPUTER,
        });

        await check('the task record carries the one Computer, with the driving flag', async () => {
            const r = await t.get(`/api/v1/tasks/${id}`, { as: kim });
            assert.strictEqual(r.status, 200, r.text);
            // desk and needs_you are this API's own additions (they predate the contract); the rest is platform.task@1.
            const { desk: _desk, needs_you: _needs, ...task } = r.json();
            valid(task);
            assert.deepStrictEqual(r.json().computer, { ...COMPUTER, driving: false });
            assert.ok(r.json().desk && /openvibe\.link/.test(r.json().desk.url), 'the watch link is still there');
        });

        await check('the still is its person\'s alone: another person and a signed-out visitor get 404', async () => {
            const mine = await t.get(`/api/v1/tasks/${id}/still`, { as: kim });
            assert.strictEqual(mine.status, 200, mine.text);
            assert.match(mine.headers.get('content-type'), /^image\/jpeg/);
            assert.strictEqual(mine.headers.get('cache-control'), 'private, no-store');
            assert.strictEqual(mine.headers.get('x-content-type-options'), 'nosniff');
            assert.deepStrictEqual(asked, [[kim.subject, SESSION]], 'fetched from the session\'s service as the person');
            assert.strictEqual((await mine.buffer.equals(still)), true);
            assert.strictEqual((await t.get(`/api/v1/tasks/${id}/still`, { as: bo })).status, 404, 'another person: the same 404 as a missing task');
            assert.strictEqual((await t.get(`/api/v1/tasks/${id}/still`)).status, 404, 'signed out: 404, never 401');
            // A broken or hostile upstream cannot serve HTML from openvibe.actor.
            stillType = 'text/html';
            const bad = await t.get(`/api/v1/tasks/${id}/still`, { as: kim });
            assert.strictEqual(bad.status, 502, bad.text);
            assert.strictEqual(bad.json().code, 'still.bad_type');
            assert.ok(!bad.text.includes('<html'));
            stillType = 'image/jpeg';
        });

        await check('take over: the person drives, the timeline gets a step, and the agent\'s input is refused', async () => {
            assert.strictEqual((await t.get(`/api/v1/tasks/${id}/takeover`, { as: bo, method: 'POST', headers: SAME })).status, 404, 'another person');
            const r = await t.get(`/api/v1/tasks/${id}/takeover`, { as: kim, method: 'POST', headers: SAME });
            assert.strictEqual(r.status, 200, r.text);
            assert.strictEqual(r.json().computer.driving, true);
            assert.ok(driving.is(id));
            const events = (await s.db.many('SELECT body FROM task_events WHERE task_id = $1 ORDER BY seq', [id])).map((e) => (typeof e.body === 'string' ? JSON.parse(e.body) : e.body));
            const handoff = events.find((e) => e.step === 'handoff');
            assert.ok(handoff && /took over/i.test(handoff.text), 'the take-over is a step in the task');
            assert.deepStrictEqual(handoff.computer, COMPUTER, 'the step carries the same Computer');
            const entries = (await timeline.list(s, `user:${kim.subject}`)).entries;
            const entry = entries.find((e) => e.id && e.title === 'You took over the desk');
            assert.ok(entry && entry.status === 'running' && entry.computer.session_id === SESSION, 'the Dock\'s timeline has one step');
            // The agent's input actions are refused, with a reason a person can read.
            const ctx = { requester: `user:${kim.subject}`, taskId: id, config: t.config };
            const click = JSON.parse((await computerInput.run({ machine: 'dev_01J8Z4M2Q0R7T9YV3K6N8P1W2A', action: 'click', x: 10, y: 20 }, ctx)).text);
            assert.match(click.error, /took it over/);
            const clickBrowser = JSON.parse((await computerBrowser.run({ machine: 'dev_01J8Z4M2Q0R7T9YV3K6N8P1W2A', action: 'click', selector: 'a' }, ctx)).text);
            assert.match(clickBrowser.error, /took it over/);
        });

        await check('give it back: the agent goes on and the same step ends', async () => {
            const r = await t.get(`/api/v1/tasks/${id}/giveback`, { as: kim, method: 'POST', headers: SAME });
            assert.strictEqual(r.status, 200, r.text);
            assert.strictEqual(r.json().computer.driving, false);
            assert.ok(!driving.is(id));
            const entries = (await timeline.list(s, `user:${kim.subject}`)).entries;
            const entry = entries.find((e) => e.title === 'You gave the desk back');
            assert.ok(entry && entry.status === 'done' && entry.ended_at, 'the same Dock step is done');
        });

        await check('a task with no Computer has nothing to take over and no still', async () => {
            const other = await runningTask('And what is a mutex?');
            assert.strictEqual((await t.get(`/api/v1/tasks/${other}/still`, { as: kim })).status, 404);
            const r = await t.get(`/api/v1/tasks/${other}/takeover`, { as: kim, method: 'POST', headers: SAME });
            assert.deepStrictEqual([r.status, r.json().code], [409, 'actor.task.no_computer']);
        });
    } finally {
        await done(t);
    }
})();

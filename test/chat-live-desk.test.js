'use strict';
// The live desk in a chat turn (plan L55 C1b; the owner, 11-01: "show you the display… watch it… and steer it"): a
// turn working on one of the person's own agent desks asks Bot for a short-lived watch link and frames it. The link is
// a credential: only the task's requester gets it, only same-origin, only while the turn works, never stored.
//   node test/chat-live-desk.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { boot, check, done } = require('./helpers/boot');
const store = require('../server/tasks/store');

const SAME = { 'sec-fetch-site': 'same-origin', accept: 'application/json' };
const MACHINE = 'dev_01JZ0000000000000000000000';

(async () => {
    const asked = [];
    let answer = (desk) => ({ url: 'https://openvibe.bot/screen/tok_live_1', expires_at: new Date(Date.now() + 3600e3).toISOString(), control: true, desk });
    const computers = {
        async watchLink(subject, machine, desk, opts) { asked.push({ subject, machine, desk, opts }); return answer(desk); },
    };
    const t = await boot({ bot: { computers } });
    const kim = t.network.addUser('kim');
    const bo = t.network.addUser('bo');
    const s = t.ctx.s;
    try {
        const id = (await t.get('/api/v1/tasks', { as: kim, json: { task: 'Book the cheapest train to Porto' }, headers: SAME })).json().id;
        await t.waitFor(id);
        const deskEvent = (watch, running = true) => store.appendEvent(s, id, { step: 'tool_result', tool: 'computer_desk', is_error: false, text: JSON.stringify({ watch, running, kind: 'browser' }) });

        await check('Bot\'s screen page address names the machine and the desk', async () => {
            assert.deepStrictEqual(store.deskPlace(`https://openvibe.bot/machines/${MACHINE}/screen?desk=desk-trains`), { machine: MACHINE, desk: 'desk-trains' });
            assert.deepStrictEqual(store.deskPlace(`https://openvibe.bot/machines/${MACHINE}/screen`), { machine: MACHINE, desk: 'main' }, 'no desk named is the machine\'s own screen');
            assert.strictEqual(store.deskPlace('https://example.com/elsewhere'), null);
        });

        await check('a working turn on an agent desk offers the live desk; the owner\'s screen does not', async () => {
            await s.db.query("UPDATE tasks SET state = 'running' WHERE id = $1", [id]);
            await deskEvent(`https://openvibe.bot/machines/${MACHINE}/screen?desk=desk-trains`);
            let page = await t.get(`/chat/${id}`, { as: kim });
            assert.match(page.text, new RegExp(`data-watch="/chat/${id}/watch"`), 'the figure says where to ask');
            await deskEvent(`https://openvibe.bot/machines/${MACHINE}/screen`);
            page = await t.get(`/chat/${id}`, { as: kim });
            assert.ok(!page.text.includes('data-watch='), 'the owner\'s own screen is never framed');
            await deskEvent(`https://openvibe.bot/machines/${MACHINE}/screen?desk=desk-trains`);
        });

        await check('only the requester, from openvibe.actor, while it works, gets the link; it is reused, not remade', async () => {
            assert.strictEqual((await t.get(`/chat/${id}/watch`, { as: bo, method: 'POST', headers: SAME })).status, 404, 'another person: not there');
            assert.strictEqual((await t.get(`/chat/${id}/watch`, { as: kim, method: 'POST', headers: { 'sec-fetch-site': 'cross-site', accept: 'application/json' } })).status, 403, 'another site');
            assert.strictEqual((await t.get(`/chat/${id}/watch`, { method: 'POST', headers: SAME })).status, 401, 'signed out');
            const r = await t.get(`/chat/${id}/watch`, { as: kim, method: 'POST', headers: SAME });
            assert.strictEqual(r.status, 200, r.text);
            assert.deepStrictEqual(r.json().url, 'https://openvibe.bot/screen/tok_live_1');
            assert.match(r.headers.get('cache-control'), /no-store/);
            assert.deepStrictEqual(asked.map((a) => [a.subject, a.machine, a.desk, a.opts.control, a.opts.minutes]), [[kim.subject, MACHINE, 'desk-trains', true, 60]]);
            await t.get(`/chat/${id}/watch`, { as: kim, method: 'POST', headers: SAME });
            assert.strictEqual(asked.length, 1, 'the same link again until it nears its end');
            const events = await s.db.many('SELECT body FROM task_events WHERE task_id = $1', [id]);
            assert.ok(!JSON.stringify(events).includes('tok_live_1'), 'the link is never written to the task');
        });

        await check('Bot saying no leaves the picture; a finished turn has no live desk', async () => {
            const other = (await t.get('/api/v1/tasks', { as: kim, json: { task: 'And back on Sunday' }, headers: SAME })).json().id;
            await t.waitFor(other);
            await s.db.query("UPDATE tasks SET state = 'running' WHERE id = $1", [other]);
            await store.appendEvent(s, other, { step: 'tool_result', tool: 'computer_desk', is_error: false, text: JSON.stringify({ watch: `https://openvibe.bot/machines/${MACHINE}/screen?desk=private`, running: true }) });
            answer = () => ({ error: 'capability.denied', code: 'capability.denied' });
            const no = await t.get(`/chat/${other}/watch`, { as: kim, method: 'POST', headers: SAME });
            assert.strictEqual(no.status, 502);
            assert.match(no.json().error, /the picture still updates/);
            await s.db.query("UPDATE tasks SET state = 'succeeded' WHERE id = $1", [id]);
            assert.strictEqual((await t.get(`/chat/${id}/watch`, { as: kim, method: 'POST', headers: SAME })).status, 409);
            const page = await t.get(`/chat/${id}`, { as: kim });
            assert.ok(!page.text.includes('data-watch='), 'a finished turn keeps its last picture');
        });

        await check('the page frames Bot\'s page (CSP), and the script swaps the picture for it', async () => {
            const page = await t.get('/chat', { as: kim });
            assert.match(page.headers.get('content-security-policy'), /frame-src [^;]*https:\/\/openvibe\.bot/);
            const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'chat.js'), 'utf8');
            assert.match(js, /function live\(turn\)/);
            assert.match(js, /fetch\(fig\.getAttribute\('data-watch'\), \{ method: 'POST', credentials: 'same-origin'/);
            assert.match(js, /f\.setAttribute\('sandbox', 'allow-scripts allow-same-origin allow-forms allow-pointer-lock'\)/, 'the frame cannot move the page');
            assert.match(js, /stopScreen\(turn\);\s+\/\/ the frame moves by itself/);
        });
    } finally {
        await done(t);
    }
})();

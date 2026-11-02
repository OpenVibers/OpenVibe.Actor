'use strict';
// Follow-ups (Actor v2, stage V2-5b): a person asks again under an answer, and the new task runs with that question and
// answer in mind (its plan too), without the old run's citations; only the task's own person may, only from Actor's
// own page, only after an answer; the two pages link to each other, and the column goes with the person's data.
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

const SAME = { 'sec-fetch-site': 'same-origin' };
// A follow-up opens in the chat (plan L55 C1): /chat/<id>#t-<id>.
const ID = /^\/chat\/(tsk_[0-9A-HJKMNP-TV-Z]{26})#t-\1$/;

(async () => {
    const t = await boot();
    const kim = t.network.addUser('kim');
    const bo = t.network.addUser('bo');
    t.config.loop.selfReflections = 0;
    const s = t.ctx.s;
    const answered = async (task, answer) => {
        t.providers.state.script = [{ content: answer }];
        const created = (await t.get('/api/v1/tasks', { as: kim, json: { task }, headers: SAME })).json();
        await t.waitFor(created.id);
        const row = await s.db.maybe('SELECT state FROM tasks WHERE id = $1', [created.id]);
        assert.strictEqual(row.state, 'succeeded');
        return created.id;
    };
    const follow = (id, text, o = {}) => t.get(`/tasks/${id}/follow-up`, { as: o.as || kim, form: { task: text }, headers: o.headers || SAME });

    try {
        const first = await answered('Which VPS is cheapest for 2 vCPU and 4 GB?', 'Hetzner CX22 at €4.51 a month [E1], then Netcup [E2, E3].');

        await check('a follow-up is a new task that runs with the question and answer before it, citations taken out', async () => {
            t.providers.reset();
            t.config.loop.selfReflections = 0;
            t.providers.state.script = [{ content: 'With 8 GB, Hetzner CX32 at €7.59.' }];
            const r = await follow(first, 'And for 8 GB?');
            assert.strictEqual(r.status, 303);
            const next = ID.exec(r.headers.get('location'))[1];
            await t.waitFor(next);
            const row = await s.db.maybe('SELECT parent_id, requester, mode, state FROM tasks WHERE id = $1', [next]);
            assert.deepStrictEqual([row.parent_id, row.state, row.mode], [first, 'succeeded', 'balanced'], 'the same person\'s task, in the parent\'s mode');
            const sent = t.providers.requests.map((q) => JSON.stringify(q.body || {}));
            const loopCall = sent.find((b) => b.includes('This follows up on the conversation above'));
            assert.ok(loopCall, 'the loop is told it is a follow-up, and to fetch live facts again');
            assert.ok(loopCall.includes('And for 8 GB?') && loopCall.includes('Hetzner CX22 at €4.51 a month'), 'with the earlier answer and the new question');
            assert.ok(loopCall.includes('{"role":"assistant","content":"Hetzner CX22 at €4.51 a month, then Netcup."}'), 'the earlier answer as its turn, without the earlier run\'s citations');
            assert.ok(sent.some((b) => b.includes('Earlier in this conversation') && b.includes('Now, a follow-up: And for 8 GB?')), 'the plan is made with what it follows');
        });

        await check('the two pages link each other: the follow-ups under the answer, the thread above the follow-up', async () => {
            const kids = await s.db.many('SELECT id FROM tasks WHERE parent_id = $1', [first]);
            const parentPage = (await t.get(`/tasks/${first}`, { as: kim })).text;
            assert.ok(parentPage.includes('<section class="follow" id="follow-up"'), 'the follow-up box');
            assert.ok(parentPage.includes(`action="/tasks/${first}/follow-up"`) && parentPage.includes('name="task"'), 'a plain form, no script needed');
            assert.ok(parentPage.includes(`<a href="/tasks/${kids[0].id}">And for 8 GB?</a>`), 'the follow-up asked, listed above the box');
            const childPage = (await t.get(`/tasks/${kids[0].id}`, { as: kim })).text;
            assert.ok(childPage.includes(`Following up on <a href="/tasks/${first}">Which VPS is cheapest`), 'and it links back');
        });

        await check('only the task\'s own person, only from Actor, only after an answer, never empty', async () => {
            const before = Number(await s.db.value('SELECT count(*) FROM tasks'));
            assert.strictEqual((await follow(first, 'mine now', { as: bo })).status, 404, 'another person: the 404 of a task that does not exist');
            assert.strictEqual((await follow(first, 'from elsewhere', { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403, 'another site cannot post one');
            const empty = await follow(first, '   ');
            assert.ok(empty.status === 303 && /#follow-up$/.test(empty.headers.get('location')), 'nothing to ask: back to the box');
            await s.db.query("UPDATE tasks SET state = 'failed' WHERE id = $1", [first]);
            const unanswered = await follow(first, 'and then?');
            assert.ok(unanswered.status === 303 && unanswered.headers.get('location').endsWith(`/tasks/${first}`), 'no answer yet, nothing to follow');
            await s.db.query("UPDATE tasks SET state = 'succeeded' WHERE id = $1", [first]);
            assert.strictEqual(Number(await s.db.value('SELECT count(*) FROM tasks')), before, 'none of those made a task');
        });

        await check('the conversation reaches back six answers at most (a chat, L55), and never into another person\'s task', async () => {
            const { followContext } = require('../server/tasks/store');
            const ids = [first];
            for (let i = 0; i < 7; i++) {
                t.providers.state.script = [{ content: `Answer ${i + 2}.` }];
                const r = await follow(ids[ids.length - 1], `Question ${i + 2}?`);
                const id = ID.exec(r.headers.get('location'))[1];
                await t.waitFor(id);
                ids.push(id);
            }
            const last = await s.db.maybe('SELECT * FROM tasks WHERE id = $1', [ids[ids.length - 1]]);
            const ctx = await followContext(s, last);
            assert.deepStrictEqual(ctx.map((c) => c.task), ['Question 2?', 'Question 3?', 'Question 4?', 'Question 5?', 'Question 6?', 'Question 7?'], 'the six before it, oldest first');
            await s.db.query('UPDATE tasks SET requester = $2 WHERE id = $1', [ids[ids.length - 2], `user:${bo.subject}`]);
            assert.deepStrictEqual((await followContext(s, last)).map((c) => c.task), [], 'a parent that is not the same person\'s ends the thread');
        });

        await check('the parent column goes with the person\'s data', async () => {
            const ad = require('../server/identity/account-data');
            const spec = JSON.stringify(ad.TABLES || ad.tables || ad);
            assert.ok(spec.includes('parent_id'), 'exported and erased with the rest of the task');
        });
    } finally {
        await t.close();
    }
    done();
})().catch((e) => { console.error(e && e.stack || e); process.exit(1); });

'use strict';
/**
 * A routine answers in its own thread (plan HO4): when a trigger's run finishes, its answer is posted into the
 * conversation that made the trigger, under the routine's card, with the addresses it read and a link to the
 * run. Switched off per routine, it posts nothing; a run that did not finish posts one line that says why. Only
 * the person whose conversation it is sees the posts, and the person is told through notifications only when
 * the routine asked for it.
 */
const assert = require('assert');
const http = require('http');
const { ids } = require('openvibe-contracts');
const { boot, check, done } = require('./helpers/boot');
const contacts = require('../server/agents/contacts');

const SAME = { 'sec-fetch-site': 'same-origin' };

/** OpenVibe.Watch as the person's token reaches it: records every call and answers like the service. */
async function watchStub() {
    const calls = [];
    const server = http.createServer(async (req, res) => {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        const text = Buffer.concat(chunks).toString('utf8');
        let body = null;
        try { body = text ? JSON.parse(text) : null; } catch { body = text; }
        calls.push({ method: req.method, url: req.url, body, auth: req.headers.authorization });
        const send = (status, value) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
        if (req.method === 'POST' && req.url === '/api/v1/watches') {
            const id = ids.newId('watch');
            return send(201, { watch: { id, status: body.status || 'active', name: body.name, labels: body.labels || {}, source: body.source } });
        }
        if (req.method === 'POST' && /^\/api\/v1\/watches\/wch_[^/]+\/schedule$/.test(req.url)) return send(200, { id: req.url.split('/')[4], schedule: body, next_due_at: '2026-11-10T08:00:00.000Z' });
        if (req.method === 'POST' && /^\/api\/v1\/watches\/wch_[^/]+\/(pause|resume)$/.test(req.url)) return send(200, { id: req.url.split('/')[4], status: req.url.endsWith('/resume') ? 'active' : 'paused' });
        if (req.method === 'PATCH' && /^\/api\/v1\/watches\/wch_[^/]+$/.test(req.url)) return send(200, { watch: { id: req.url.split('/')[4], status: 'active', ...body } });
        if (req.method === 'GET' && /^\/api\/v1\/watches\/wch_[^/]+$/.test(req.url)) return send(200, { watch: { id: req.url.split('/')[4], status: 'active', health: { last_state: 'condition_met', consecutive_failures: 0, next_due_at: '2026-11-10T08:00:00.000Z' } } });
        if (req.method === 'DELETE' && /^\/api\/v1\/watches\/wch_[^/]+$/.test(req.url)) return send(200, { id: req.url.split('/')[4], deleted: true });
        return send(404, { code: 'watch.not_found' });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    return { url: `http://127.0.0.1:${server.address().port}`, calls, close: () => new Promise((r) => server.close(r)) };
}

(async () => {
    const watch = await watchStub();
    // The run's own answer, which each check sets: the loop is the only model Actor talks to here.
    let answer = 'Today your inbox has three things worth doing.';
    let sources = ['https://mail.example.com/inbox'];
    let fail = null;
    const told = [];
    const loop = {
        close: async () => {},
        run: async () => {
            if (fail) throw fail;
            return { text: answer, sources, evidence: [], model: 'fake' };
        },
    };
    const notifier = { enabled: true, needsYou: async (n) => { told.push(n); return { sent: true }; }, taskEnded: async (n) => { told.push(n); return { sent: true }; } };
    const t = await boot({ env: { ACTOR_WATCH_URL: watch.url }, loop, notifier });
    try {
        const ada = t.network.addUser('ada');
        const bo = t.network.addUser('bo');
        const owner = `user:${ada.subject}`;
        const s = t.ctx.s;
        const vibe = await contacts.ensureVibe(s, t.config, owner);
        const as = (u, method, p, o = {}) => t.get(p, { as: u, method, headers: SAME, ...o });
        const json = (u, method, p, body) => as(u, method, p, { json: body });
        const runsOf = async (turnId) => (await s.db.many('SELECT body FROM task_events WHERE task_id = $1 ORDER BY seq', [turnId]))
            .map((r) => (typeof r.body === 'string' ? JSON.parse(r.body) : r.body))
            .filter((e) => e.step === 'trigger-run');

        // A turn that made a routine, as the chat does (the tool passes its own task id).
        const turnId = async (said = 'every weekday at 9, summarise my inbox') => {
            const made = await json(ada, 'POST', '/api/v1/tasks', { task: said });
            assert.ok(made.status === 201 || made.status === 202, made.text);
            const id = (made.json().task && made.json().task.id) || made.json().id;
            await t.waitFor(id);
            return id;
        };
        const routine = async (turn, extra = {}) => {
            const made = await json(ada, 'POST', '/api/v1/triggers', {
                agent_id: vibe.id, task: 'summarise my inbox', kind: 'schedule', cron: '0 9 * * 1-5', timezone: 'Europe/Berlin', turn_task_id: turn, ...extra,
            });
            assert.strictEqual(made.status, 201, made.text);
            return made.json().trigger;
        };
        const runIt = async (id) => {
            const res = await as(ada, 'POST', `/api/v1/triggers/${id}/run`);
            assert.strictEqual(res.status, 201, res.text);
            return await t.waitFor(res.json().task.id);
        };

        await check('a routine\'s run posts its answer under its card in the chat that made it', async () => {
            const turn = await turnId();
            const card = await routine(turn);
            const task = await runIt(card.id);
            assert.strictEqual(task.state, 'succeeded', JSON.stringify(task.error));
            const posts = await runsOf(turn);
            assert.strictEqual(posts.length, 1, 'one post for one run');
            assert.strictEqual(posts[0].trigger_id, card.id);
            assert.strictEqual(posts[0].run.task_id, task.id);
            assert.strictEqual(posts[0].run.state, 'ok');
            assert.strictEqual(posts[0].text, answer);
            assert.deepStrictEqual(posts[0].sources, sources);
            const page = await as(ada, 'GET', `/chat/turn/${turn}`);
            assert.strictEqual(page.status, 200, page.text);
            assert.ok(page.text.includes(`data-ct-trigger="${card.id}"`), 'the card is still there');
            assert.ok(page.text.includes('Today your inbox has three things worth doing.'), 'the answer is in the chat');
            assert.ok(page.text.includes('https://mail.example.com/inbox'), 'with the address it read');
            assert.ok(page.text.includes(`/tasks/${task.id}`), 'and a link to the run');
            assert.match(page.text, /class="ct-trig-run/);
        });

        await check('switched off per routine, a run posts nothing in the chat', async () => {
            const turn = await turnId();
            const card = await routine(turn);
            // The card's own switch, as its form posts it.
            const off = await as(ada, 'POST', `/chat/${turn}/trigger/${card.id}`, { form: { do: 'answer-off' } });
            assert.strictEqual(off.status, 303, off.text);
            const page = await as(ada, 'GET', `/chat/turn/${turn}`);
            assert.match(page.text, /Answer in this chat: off/);
            const before = (await runsOf(turn)).length;
            answer = 'This one stays out of the chat.';
            await runIt(card.id);
            assert.strictEqual((await runsOf(turn)).length, before, 'nothing was posted');
            const after = await as(ada, 'GET', `/chat/turn/${turn}`);
            assert.ok(!after.text.includes('This one stays out of the chat.'));
            // And back on: the API's switch, the same field the card uses.
            const on = await json(ada, 'PATCH', `/api/v1/triggers/${card.id}`, { answer_in_chat: true });
            assert.strictEqual(on.status, 200, on.text);
            assert.strictEqual(on.json().trigger.answer_in_chat, true);
            answer = 'Back in the chat.';
            await runIt(card.id);
            assert.strictEqual((await runsOf(turn)).length, before + 1);
        });

        await check('a run that did not finish posts one line that says why', async () => {
            const turn = await turnId();
            const card = await routine(turn);
            fail = Object.assign(new Error('the provider fell over'), { code: 'actor.provider.error', detail: 'OpenVibe.AI did not answer in time.' });
            const task = await runIt(card.id);
            fail = null;
            assert.strictEqual(task.state, 'failed');
            const posts = await runsOf(turn);
            assert.strictEqual(posts.length, 1);
            assert.strictEqual(posts[0].run.state, 'failed');
            assert.match(posts[0].text, /^That run did not finish: .*fell over/);
            const page = await as(ada, 'GET', `/chat/turn/${turn}`);
            assert.ok(page.text.includes('That run did not finish'), 'the line is in the chat');
            assert.match(page.text, /ct-trig-run is-bad/);
        });

        await check('another person never sees a routine\'s posts', async () => {
            const turn = await turnId();
            const card = await routine(turn);
            answer = 'Only Ada may read this.';
            const task = await runIt(card.id);
            assert.strictEqual(task.state, 'succeeded');
            const theirs = await as(bo, 'GET', `/chat/turn/${turn}`);
            assert.ok(!theirs.text.includes('Only Ada may read this.'), 'a stranger is not shown it');
            assert.ok(!theirs.text.includes(`data-ct-trigger="${card.id}"`));
        });

        await check('the person is told through notifications only when the routine asked', async () => {
            const turn = await turnId();
            const card = await routine(turn);
            // The turn itself is a normal task and tells the person as any task does; count from here.
            told.length = 0;
            answer = 'Quiet run.';
            await runIt(card.id);
            assert.strictEqual(told.length, 0, 'the answer in the chat is the telling');
            const on = await json(ada, 'PATCH', `/api/v1/triggers/${card.id}`, { notify: true });
            assert.strictEqual(on.status, 200, on.text);
            const page = await as(ada, 'GET', `/chat/turn/${turn}`);
            assert.match(page.text, /Tell me too: on/);
            answer = 'Loud run.';
            await runIt(card.id);
            assert.strictEqual(told.length, 1, 'one notification for one run');
            assert.strictEqual(told[0].state, 'succeeded');
            assert.ok(String(told[0].url).includes('/tasks/'));
        });

        await check('a routine made in a turn with no card has nowhere to post, and says nothing', async () => {
            // The API allows a trigger with no turn (a card made elsewhere): a run must not crash on it.
            const made = await json(ada, 'POST', '/api/v1/triggers', { agent_id: vibe.id, task: 'no thread', kind: 'schedule', cron: '0 9 * * *', timezone: 'UTC' });
            assert.strictEqual(made.status, 201, made.text);
            const task = await runIt(made.json().trigger.id);
            assert.strictEqual(task.state, 'succeeded');
        });
    } finally {
        await t.close();
        await watch.close();
    }
    done();
})().catch((e) => { console.error(e); process.exit(1); });

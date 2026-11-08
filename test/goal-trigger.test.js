'use strict';
/**
 * A goal that keeps going (plan HO3): "keep checking the price of X every 30 minutes until it drops under €120".
 * The sentence parses into a goal (or asks the one question when the check is not something a run can see), the
 * goal's runs answer its done-test, and it ends itself — saying so in the conversation — when the test passes,
 * when its runs or money are spent, and at its deadline. The card shows "Run 4 of at most 12 · not yet: €134".
 */
const assert = require('assert');
const http = require('http');
const { ids } = require('openvibe-contracts');
const { boot, check, done } = require('./helpers/boot');
const contacts = require('../server/agents/contacts');
const { parseRequest } = require('../server/triggers/parse');
const { verdictOf, endingOf } = require('../server/triggers/goal');
const { createRegistry } = require('../server/runtime/tools');

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
    let answer = 'The price is €134.\n\nVERDICT: no — €134 on the maker\'s store';
    const loop = { close: async () => {}, run: async () => ({ text: answer, sources: [], evidence: [], model: 'fake' }) };
    const t = await boot({ env: { ACTOR_WATCH_URL: watch.url }, loop });
    try {
        const ada = t.network.addUser('ada');
        const owner = `user:${ada.subject}`;
        const s = t.ctx.s;
        const vibe = await contacts.ensureVibe(s, t.config, owner);
        const as = (method, p, o = {}) => t.get(p, { as: ada, method, headers: SAME, ...o });
        const json = (method, p, body) => as(method, p, { json: body });
        const turn = async (said) => {
            const made = await json('POST', '/api/v1/tasks', { task: said });
            const id = (made.json().task && made.json().task.id) || made.json().id;
            await t.waitFor(id);
            return id;
        };
        const goal = async (extra = {}) => {
            const made = await json('POST', '/api/v1/triggers', {
                agent_id: vibe.id, task: 'check the price of the Framework 13', kind: 'goal', cron: '*/30 * * * *', timezone: 'Europe/Berlin',
                goal: { text: 'the price of the Framework 13 drops under €120', done_test: 'the price is under €120', runs_max: 12 }, ...extra,
            });
            assert.strictEqual(made.status, 201, made.text);
            return made.json().trigger;
        };
        const runIt = async (id) => {
            const res = await as('POST', `/api/v1/triggers/${id}/run`);
            if (res.status === 409) return { refused: res.json() };
            assert.strictEqual(res.status, 201, res.text);
            return await t.waitFor(res.json().task.id);
        };
        const fetchCard = async (id) => (await as('GET', `/api/v1/triggers/${id}`)).json().trigger;
        const linesOf = async (turnId) => (await s.db.many('SELECT body FROM task_events WHERE task_id = $1 ORDER BY seq', [turnId]))
            .map((r) => (typeof r.body === 'string' ? JSON.parse(r.body) : r.body));

        await check('"until …" sentences become a goal, and a check no run can see is one question', async () => {
            const price = parseRequest('keep checking the price of the Framework 13 every 30 minutes until it drops under €120, then tell me', { timezone: 'Europe/Berlin' });
            assert.strictEqual(price.status, 'ok');
            assert.strictEqual(price.kind, 'goal');
            assert.strictEqual(price.cron, '*/30 * * * *');
            assert.strictEqual(price.task, 'check the price of the Framework 13');
            assert.strictEqual(price.goal.done_test, 'the price of the Framework 13 drops under €120');
            assert.strictEqual(price.tell, true);

            const tests = parseRequest('keep working on this until the tests pass', { timezone: 'Europe/Berlin' });
            assert.strictEqual(tests.status, 'ok');
            assert.strictEqual(tests.kind, 'goal');
            assert.strictEqual(tests.cron, '*/15 * * * *', 'no interval given: every fifteen minutes, Watch\'s floor');
            assert.strictEqual(tests.task, 'work on this');
            assert.strictEqual(tests.goal.done_test, 'the tests pass');
            assert.strictEqual(tests.tell, false);

            const vague = parseRequest('keep checking the price every hour until I am happy', { timezone: 'Europe/Berlin' });
            assert.strictEqual(vague.status, 'ask');
            assert.match(vague.question, /how will i know it is done/i);

            const noZone = parseRequest('keep checking the price until it drops under €120', {});
            assert.strictEqual(noZone.status, 'ask');
            assert.match(noZone.question, /timezone/i);

            // A plain routine is still a routine.
            assert.strictEqual(parseRequest('every weekday at 9, summarise my inbox', { timezone: 'Europe/Berlin' }).kind, 'schedule');
        });

        await check('the done-test is read out of the answer, and the goal\'s ends are its own limits', async () => {
            assert.deepStrictEqual(verdictOf('€134 today.\n\nVERDICT: no — €134 on the maker\'s store'), { done: false, reason: '€134 on the maker\'s store', answer: '€134 today.' });
            assert.deepStrictEqual(verdictOf('All good.\nVERDICT: yes — €112 shipped').done, true);
            assert.strictEqual(verdictOf('I could not read the page.').done, null, 'a run that does not say is not a pass');
            const g = { done_test: 'the price is under €120', runs_max: 12, budget_usd: 1.5, deadline_at: null };
            assert.strictEqual(endingOf({ goal: g, verdict: { done: true, reason: '€112' }, runsUsed: 4, spentUsd: 0.02 }).reason, 'done');
            assert.strictEqual(endingOf({ goal: g, verdict: { done: false }, runsUsed: 4, spentUsd: 0.02 }), null);
            assert.strictEqual(endingOf({ goal: { ...g, runs_max: 4 }, verdict: { done: false }, runsUsed: 4, spentUsd: 0.02 }).reason, 'budget');
            assert.strictEqual(endingOf({ goal: { ...g, runs_max: null, budget_usd: 0.5 }, verdict: { done: null }, runsUsed: 2, spentUsd: 0.6 }).reason, 'budget');
            assert.strictEqual(endingOf({ goal: { ...g, budget_usd: null, deadline_at: '2020-01-01T00:00:00.000Z' }, verdict: { done: false }, runsUsed: 2, spentUsd: 0.1, at: Date.now() }).reason, 'deadline');
        });

        await check('the tool makes a goal from the sentence, with its limits and the ask to be told', async () => {
            const registry = createRegistry({ strict: true, log: { warn() {}, log() {} } });
            const events = [];
            const ctx = {
                config: t.config, requester: owner, store: s, triggers: t.ctx.triggers,
                personToken: 'a-person-token', timezone: 'Europe/Berlin', agentId: vibe.id, taskId: null, level: 'ask',
                emit: async (e) => events.push(e),
            };
            const out = await registry.run('schedule_trigger', { request: 'keep checking the price of the Framework 13 every 30 minutes until it drops under €120, then tell me' }, ctx);
            assert.ok(!out.isError, out.text);
            const made = events.find((e) => e.step === 'trigger').trigger;
            assert.strictEqual(made.kind, 'goal');
            assert.strictEqual(made.when.cron, '*/30 * * * *');
            assert.strictEqual(made.goal.runs_used, 0);
            assert.strictEqual(made.goal.runs_max, 12);
            assert.ok(made.goal.budget_usd > 0, 'a money budget from the person\'s allowance');
            assert.ok(made.goal.deadline_at, 'a deadline');
            assert.strictEqual(made.notify, true, '"then tell me" turns the telling on');
            assert.match(out.text, /It ends when the price of the Framework 13 drops under €120/);

            const asked = await registry.run('schedule_trigger', { request: 'keep working on this until it is good' }, ctx);
            assert.match(asked.text, /how will i know it is done/i);
        });

        await check('a goal ends itself when its done-test passes, and says so in the thread', async () => {
            const turnId = await turn('keep checking the price of the Framework 13 until it drops under €120');
            const made = await json('POST', '/api/v1/triggers', {
                agent_id: vibe.id, task: 'check the price of the Framework 13', kind: 'goal', cron: '*/30 * * * *', timezone: 'Europe/Berlin',
                goal: { text: 'the price drops under €120', done_test: 'the price is under €120' }, turn_task_id: turnId,
            });
            assert.strictEqual(made.status, 201, made.text);
            const id = made.json().trigger.id;

            answer = 'The price is €134.\n\nVERDICT: no — €134';
            const first = await runIt(id);
            assert.strictEqual(first.state, 'succeeded');
            // The run was asked the goal and its done-test, so its answer carries a verdict Actor can read.
            assert.ok(String(first.task).includes('This is one run of a goal the person set'), 'the goal is in the run');
            assert.ok(String(first.task).includes('The goal is done only when this is true: "the price is under €120"'));
            assert.ok(String(first.task).includes('VERDICT: yes'));
            let card = await fetchCard(id);
            assert.deepStrictEqual([card.state, card.goal.runs_used, card.goal.not_yet], ['active', 1, '€134']);

            answer = 'It dropped: €112 shipped.\n\nVERDICT: yes — €112 shipped';
            const second = await runIt(id);
            assert.strictEqual(second.state, 'succeeded');
            card = await fetchCard(id);
            assert.deepStrictEqual([card.state, card.paused_reason, card.goal.runs_used], ['done', 'done', 2]);
            assert.strictEqual(card.goal.verdict.done, true);

            const lines = await linesOf(turnId);
            assert.ok(lines.some((e) => e.step === 'trigger-run' && /It dropped: €112 shipped/.test(e.text)), 'the run\'s answer is in the thread');
            assert.ok(lines.some((e) => e.step === 'trigger' && /Goal reached: the price is under €120 \(€112 shipped\)/.test(e.text)), 'and so is the goal saying it is done');
            const page = await as('GET', `/chat/turn/${turnId}`);
            assert.match(page.text, /class="ct-trig-state">Done</);
            assert.match(page.text, /The goal is reached: the price is under €120\./);

            // A finished goal does not run again, and cannot be resumed.
            assert.strictEqual((await runIt(id)).refused.error !== undefined, true);
            assert.strictEqual((await as('POST', `/api/v1/triggers/${id}/resume`)).status, 409);
        });

        await check('a goal ends itself when its runs are spent, and says so', async () => {
            const turnId = await turn('keep checking the price until it drops under €120');
            const made = await json('POST', '/api/v1/triggers', {
                agent_id: vibe.id, task: 'check the price', kind: 'goal', cron: '*/30 * * * *', timezone: 'Europe/Berlin',
                goal: { text: 'the price drops under €120', done_test: 'the price is under €120', runs_max: 2 }, turn_task_id: turnId,
            });
            const id = made.json().trigger.id;
            answer = 'Still €134.\n\nVERDICT: no — €134';
            await runIt(id);
            let card = await fetchCard(id);
            assert.deepStrictEqual([card.state, card.goal.runs_used], ['active', 1]);
            const page = await as('GET', `/chat/turn/${turnId}`);
            assert.match(page.text, /Run 1 of at most 2/);
            assert.match(page.text, /not yet: €134/);

            await runIt(id);
            card = await fetchCard(id);
            assert.deepStrictEqual([card.state, card.paused_reason, card.goal.runs_used], ['paused', 'budget', 2]);
            const lines = await linesOf(turnId);
            assert.ok(lines.some((e) => e.step === 'trigger' && /Stopping here: the goal has used its 2 runs and is not done/.test(e.text)));
            assert.strictEqual((await runIt(id)).refused.code, 'actor.trigger.paused');
        });

        await check('a goal ends itself at its deadline, even between runs', async () => {
            const turnId = await turn('keep checking the price until it drops under €120');
            const made = await json('POST', '/api/v1/triggers', {
                agent_id: vibe.id, task: 'check the price', kind: 'goal', cron: '*/30 * * * *', timezone: 'Europe/Berlin',
                goal: { text: 'the price drops under €120', done_test: 'the price is under €120', deadline_at: '2020-01-01T00:00:00.000Z' }, turn_task_id: turnId,
            });
            const id = made.json().trigger.id;
            // Nothing ran: the deadline passed, and reading the card is enough to end it.
            const card = await fetchCard(id);
            assert.deepStrictEqual([card.state, card.paused_reason], ['paused', 'deadline']);
            const lines = await linesOf(turnId);
            assert.ok(lines.some((e) => e.step === 'trigger' && /Stopping here: 2020-01-01 passed and the goal is not done/.test(e.text)));
            assert.strictEqual((await runIt(id)).refused.code, 'actor.trigger.paused');
        });

        await check('one person\'s goal is another person\'s 404', async () => {
            const made = await goal();
            const bo = t.network.addUser('bo');
            assert.strictEqual((await t.get(`/api/v1/triggers/${made.id}`, { as: bo })).status, 404);
            assert.strictEqual((await t.get(`/api/v1/triggers/${made.id}/run`, { as: bo, method: 'POST', headers: SAME })).status, 404);
        });
    } finally {
        await t.close();
        await watch.close();
    }
    done();
})().catch((e) => { console.error(e); process.exit(1); });

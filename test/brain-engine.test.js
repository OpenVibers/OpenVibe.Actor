'use strict';
/**
 * The brain on the real engine (Actor v2, stage V2-8), with the stand-in providers:
 *   - a high-risk ambiguous task asks once, before any tool, and the answer resumes the same task;
 *   - an ambiguous low-risk task does not ask: its assumptions go at the top of the plan;
 *   - the question card, the assumption form, the confidence chips and the Challenge work as plain forms;
 *   - a finished task writes its outcomes.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const store = require('../server/tasks/store');
const taskEvents = require('../public/js/task-events');

const taskIdOf = (res) => String(res.headers.get('location') || '').split('/').filter(Boolean).pop();
const SAME = { origin: 'https://openvibe.actor' };

(async () => {
    const t = await boot();
    try {
        const bea = t.network.addUser('bea');
        const s = t.ctx.s;
        let firstTask = null;

        await check('a high-risk ambiguous task asks one question before any tool; the answer resumes the same task', async () => {
            t.providers.state.understand = {
                kind: 'action', deliverable: 'Book a table for two', risk: 'high', ambiguity: 0.9,
                assumptions: ['dinner for two'], question: { text: 'Which city?', options: ['Lisbon', 'Porto'] },
            };
            t.providers.state.smart = 'answer';
            const created = await t.get('/tasks', { as: bea, form: { task: 'Book a table for two on Friday evening', mode: 'balanced' }, headers: SAME });
            assert.strictEqual(created.status, 303);
            const id = taskIdOf(created);
            firstTask = id;
            const waiting = await t.waitFor(id, ['needs_you']);
            assert.strictEqual(waiting.state, 'needs_you');
            const page = await t.get(`/tasks/${id}`, { as: bea });
            assert.match(page.text, /Before Actor starts, one question/);
            assert.match(page.text, /Which city\?/);
            assert.match(page.text, /name="answer" value="Lisbon"/, 'one tap per option');
            assert.match(page.text, new RegExp(`action="/tasks/${id}/answer"`));
            const answered = await t.get(`/tasks/${id}/answer`, { as: bea, form: { answer: 'Lisbon' }, headers: SAME });
            assert.strictEqual(answered.status, 303);
            const ended = await t.waitFor(id);
            assert.strictEqual(ended.state, 'succeeded');
            const events = await store.eventsAfter(s, id, 0);
            const at = (step) => events.findIndex((e) => e.step === step);
            assert.ok(at('question') >= 0, 'the question is on the page');
            assert.ok(at('tool_call') < 0 || at('question') < at('tool_call'), 'the question came before any tool');
            assert.ok(events.some((e) => e.step === 'answer' && /Lisbon/.test(String(e.text))), 'the answer is the person\'s words');
            const expected = ended.result && (typeof ended.result === 'string' ? JSON.parse(ended.result) : ended.result);
            assert.ok(expected && expected.answer, 'the task delivered an answer');
            assert.ok(Number(ended.cost_usd) > 0, 'the question and the work spent the task\'s own budget');
        });

        await check('a finished task\'s last plan event has the final ledger: done, no next', async () => {
            const events = await store.eventsAfter(s, firstTask, 0);
            const lastPlan = [...events].reverse().find((e) => e.kind === 'output' && e.step === 'plan' && taskEvents.plan(e.text));
            assert.ok(lastPlan, 'a plan event is on the page');
            const parsed = taskEvents.plan(lastPlan.text);
            assert.strictEqual(parsed.progress.done, true, 'the last ledger says done');
            assert.strictEqual(parsed.progress.next, null, 'and has no next sub-goal');
            assert.strictEqual(parsed.progress.stuck, false);
            assert.match(lastPlan.text, /Progress: done; /);
            const page = await t.get(`/tasks/${firstTask}`, { as: bea });
            for (const label of ['<b>Given:</b>', '<b>To find:</b>', '<b>To work out:</b>', '<b>Done:</b> yes', '<b>Stuck:</b> no', '<b>Next:</b> none']) {
                assert.ok(page.text.includes(label), `the finished page shows ${label}`);
            }
        });

        await check('an ambiguous task that is cheap to get wrong does not ask; its assumptions are at the top of the plan', async () => {
            t.providers.state.understand = { kind: 'answer', deliverable: 'A summary', risk: 'low', ambiguity: 0.9, assumptions: ['the short version'], question: { text: 'Which part?', options: ['a', 'b'] } };
            t.providers.state.smart = 'answer';
            const created = await t.get('/tasks', { as: bea, form: { task: 'Summarize the meeting notes for me', mode: 'balanced' }, headers: SAME });
            const id = taskIdOf(created);
            const ended = await t.waitFor(id);
            assert.strictEqual(ended.state, 'succeeded');
            const events = await store.eventsAfter(s, id, 0);
            assert.ok(!events.some((e) => e.step === 'question'), 'no question was asked');
            assert.ok(events.some((e) => e.step === 'plan' && /Assumptions: the short version/.test(String(e.text))), 'the assumptions lead the plan');
        });

        await check('a task waiting for its one question can be cancelled', async () => {
            t.providers.state.understand = { kind: 'action', deliverable: 'Book a table', risk: 'high', ambiguity: 0.9, question: { text: 'Which city?', options: ['Lisbon', 'Porto'] } };
            t.providers.state.smart = 'answer';
            const created = await t.get('/tasks', { as: bea, form: { task: 'Book a table for two on Friday', mode: 'balanced' }, headers: SAME });
            const id = taskIdOf(created);
            await t.waitFor(id, ['needs_you']);
            const cancelled = await t.get(`/tasks/${id}/cancel`, { as: bea, form: { cancel: '1' }, headers: SAME });
            assert.strictEqual(cancelled.status, 303);
            const ended = await t.waitFor(id);
            assert.strictEqual(ended.state, 'cancelled');
        });

        await check('the assumption form edits the live plan as a follow-up turn', async () => {
            t.providers.state.understand = null;
            t.providers.state.runtime = 'hang';
            const created = await t.get('/tasks', { as: bea, form: { task: 'Find three offers under ten euros', mode: 'balanced' }, headers: SAME });
            const id = taskIdOf(created);
            await t.waitFor(id, ['running']);
            const page = await t.get(`/tasks/${id}`, { as: bea });
            assert.match(page.text, new RegExp(`action="/tasks/${id}/assumptions"`), 'the live plan has an editable assumptions form');
            const edited = await t.get(`/tasks/${id}/assumptions`, { as: bea, form: { assumptions: 'Use EUR\nAsk before booking' }, headers: SAME });
            assert.strictEqual(edited.status, 303);
            t.providers.state.runtime = 'tool';
            let seen = false;
            for (let i = 0; i < 100 && !seen; i++) {
                const events = await store.eventsAfter(s, id, 0);
                seen = events.some((e) => e.step === 'plan' && /Assumptions: Use EUR; Ask before booking/.test(String(e.text)));
                if (!seen) await new Promise((r) => setTimeout(r, 25));
            }
            assert.ok(seen, 'the new assumptions are in the live plan');
        });

        await check('a finished answer shows confidence on its chips and runs a Challenge on demand, with the estimate first', async () => {
            t.providers.state.understand = null;
            t.providers.state.smart = 'tool';
            t.providers.state.loopTool = { name: 'search_web', arguments: JSON.stringify({ query: 'the sky' }) };
            t.providers.state.checkOk = true;
            t.providers.state.checkClaims = () => [{ claim: 'The sky is blue.', kind: 'general', evidence: ['E1'], supported: true }];
            const created = await t.get('/tasks', { as: bea, form: { task: 'What colour is the sky?', mode: 'balanced' }, headers: SAME });
            const id = taskIdOf(created);
            let ended;
            try { ended = await t.waitFor(id); } catch (err) {
                const evs = await store.eventsAfter(s, id, 0);
                process.stderr.write('DEBUG events ' + JSON.stringify(evs.map((e) => [e.kind, e.step, String(e.text || '').slice(0, 90)])) + '\n');
                process.stderr.write('DEBUG requests ' + JSON.stringify(t.providers.requests.map((r) => r.path).slice(-12)) + '\n');
                process.stderr.write('DEBUG logs ' + t.logs().slice(-3000) + '\n');
                throw err;
            }
            assert.strictEqual(ended.state, 'succeeded', ended.error_detail || '');
            const page = await t.get(`/tasks/${id}`, { as: bea });
            assert.match(page.text, /ev-conf is-likely/, 'one search source is likely, not sure');
            assert.match(page.text, /Challenge this claim/);
            assert.match(page.text, new RegExp(`href="/tasks/${id}/challenge\\?ev=E1"`));
            assert.strictEqual((page.text.match(/Challenge runs a counter-evidence search/g) || []).length, 1, 'the explainer is once, under Evidence');
            assert.ok(!/a counter-evidence search; the estimate is shown first<\/span>/.test(page.text), 'no repeated explainer on the items');
            const challengePage = await t.get(`/tasks/${id}/challenge?ev=E1`, { as: bea });
            assert.strictEqual(challengePage.status, 200);
            assert.match(challengePage.text, /Estimate:/);
            assert.match(challengePage.text, /Run the challenge/);
            const before = Number(ended.cost_usd || 0);
            const ran = await t.get(`/tasks/${id}/challenge`, { as: bea, form: { ev: 'E1' }, headers: SAME });
            assert.strictEqual(ran.status, 303);
            const after = await store.getTask(s, id);
            assert.ok(Number(after.cost_usd || 0) >= before, 'the challenge counts against the task\'s allowance');
            const afterPage = await t.get(`/tasks/${id}`, { as: bea });
            assert.match(afterPage.text, /Challenge: unclear|Challenge: disagrees|Challenge: agrees/);
        });

        await check('a failed check writes a final ledger with no next and why it stopped', async () => {
            t.providers.state.understand = null;
            t.providers.state.smart = 'answer';
            t.providers.state.checkOk = false;
            t.providers.state.checkClaims = () => [{ claim: 'a live fact with no evidence', kind: 'live', evidence: [], supported: false }];
            const created = await t.get('/tasks', { as: bea, form: { task: 'Tell me a live fact from memory', mode: 'balanced' }, headers: SAME });
            const id = taskIdOf(created);
            const ended = await t.waitFor(id);
            assert.strictEqual(ended.state, 'failed');
            const events = await store.eventsAfter(s, id, 0);
            const lastPlan = [...events].reverse().find((e) => e.kind === 'output' && e.step === 'plan' && taskEvents.plan(e.text));
            const parsed = taskEvents.plan(lastPlan.text);
            assert.strictEqual(parsed.progress.done, false);
            assert.strictEqual(parsed.progress.next, null);
            assert.ok(parsed.progress.stopped, 'the last ledger says why it stopped');
            t.providers.state.checkOk = true;
            t.providers.state.checkClaims = null;
        });

        await check('a finished task writes its outcomes to actor_brain_outcomes', async () => {
            const n = Number(await s.db.value('SELECT count(*) FROM actor_brain_outcomes'));
            assert.ok(n > 0, 'the bandit has a prior from the runs above');
            const row = await s.db.maybe('SELECT * FROM actor_brain_outcomes LIMIT 1');
            assert.ok(row && !('owner' in row) && !('requester' in row), 'an outcome is a count, not a person\'s row');
        });
    } finally {
        await t.close();
    }
    done();
})().catch((e) => { console.error(e); process.exit(1); });

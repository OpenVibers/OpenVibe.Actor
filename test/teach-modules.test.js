'use strict';
// Teach, modular and smarter (plan §AD.33; the owner, 2026-11-21: "build modular intelligent teach feature"):
// the demonstration is cleaned up (segment) and the details that change are named (variables) before a model reads it;
// a lesson can be told in words instead of shown (learn_from_words); and once the person keeps a taught skill the agent
// practises it on its desk with their example, a failed try improving the skill and starting the next, until it works.
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const store = require('../server/tasks/store');
const personal = require('../server/agents/personal');
const skills = require('../server/skills');
const teach = require('../server/teach');
const practice = require('../server/teach/practice');
const { segment } = require('../server/teach/segment');
const { inputsOf, inputLines } = require('../server/teach/variables');
const draft = require('../server/teach/draft');

const SAME = { 'sec-fetch-site': 'same-origin' };
const SKILL = { name: 'Search the shop', description: 'Use to find a product in the shop.', instructions: 'You need: {search}.\n1. Open https://shop.example.\n2. Click the search box and type {search}, then press Enter.\nDone when: results for {search} show.' };
const fakeModels = (answer) => { const asked = []; return { asked, async chat(req) { asked.push(req); return { text: answer, cost_usd: 0.001, model: 'fake/m' }; } }; };
const step = (seq, args, extra = {}) => ({ seq, text: args.action, args, picture: false, ...extra });

(async () => {
    const t = await boot({});
    const s = t.ctx.s;
    const kim = t.network.addUser('kim-modules');
    const owner = `user:${kim.subject}`;
    const agent = (await personal.create(s, t.config, owner, { name: 'Shopper', instructions: 'Shop for me.', mode: 'balanced', budget_per_run_usd: 0.05, daily_runs_max: 20, schedule: 'off', status: 'active' })).row;
    try {
        await check('a model call whose connection drops before any answer is tried again; a timeout or a cancel never is', async () => {
            const { connect } = require('../server/runtime/models');
            let n = 0;
            const flaky = async () => { n++; if (n < 3) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }); return { ok: true }; };
            assert.deepStrictEqual(await connect(flaky, 'https://api.example/v1/chat/completions', { body: '{}' }), { ok: true });
            assert.strictEqual(n, 3, 'two more tries');
            n = 0;
            const down = async () => { n++; throw new TypeError('fetch failed'); };
            await assert.rejects(connect(down, 'u', { body: '{}' }), /fetch failed/);
            assert.strictEqual(n, 3, 'then it gives up');
            n = 0;
            const slow = async () => { n++; throw Object.assign(new Error('timed out'), { name: 'TimeoutError' }); };
            await assert.rejects(connect(slow, 'u', { body: '{}' }));
            assert.strictEqual(n, 1, 'a timeout is not tried again');
        });

        await check('segment: scrolling one way is one step, a typo and its fix one text, a double press one click', async () => {
            const { actions, merged } = segment([
                step(1, { action: 'click', x: 100, y: 50 }, { picture: true }),
                step(2, { action: 'click', x: 102, y: 51 }),
                step(3, { action: 'type', chars: 4, text: 'helo' }),
                step(4, { action: 'key', keys: 'BackSpace' }),
                step(5, { action: 'key', keys: 'BackSpace' }),
                step(6, { action: 'type', chars: 3, text: 'llo' }),
                step(7, { action: 'scroll', dy: 3 }), step(8, { action: 'scroll', dy: 3 }), step(9, { action: 'scroll', dy: 2 }),
                step(10, { action: 'scroll', dy: -3 }),
            ]);
            assert.deepStrictEqual(actions.map((a) => a.seq), [1, 3, 7, 10]);
            assert.strictEqual(actions[0].picture, true, 'the first click keeps its picture');
            assert.strictEqual(actions[1].args.text, 'hello', 'the text as it ended');
            assert.match(actions[2].text, /scrolled down \(3 times\)/);
            assert.strictEqual(merged, 6);
            const secret = segment([step(1, { action: 'type', chars: 5, private: true, text: null }), step(2, { action: 'key', keys: 'BackSpace' }), step(3, { action: 'type', chars: 2, text: 'ab' })]).actions;
            assert.strictEqual(secret.length, 1); assert.strictEqual(secret[0].args.private, true); assert.strictEqual(secret[0].args.text, null, 'private stays private when merged');
        });

        await check('variables: what was typed becomes named inputs (search, email, date, message); private text never', async () => {
            const inputs = inputsOf([
                step(1, { action: 'type', text: 'running shoes' }), step(2, { action: 'key', keys: 'Return' }),
                step(3, { action: 'type', text: 'kim@example.com' }),
                step(4, { action: 'type', text: '2026-12-01' }),
                step(5, { action: 'type', text: 'Please deliver to the back door after six' }),
                step(6, { action: 'type', private: true, text: null, chars: 9 }),
                step(7, { action: 'type', text: 'blue' }), step(8, { action: 'type', text: 'red' }),
            ]);
            assert.deepStrictEqual(inputs.map((x) => x.name), ['search', 'email', 'date', 'message', 'detail', 'detail_2']);
            assert.strictEqual(inputs[0].example, 'running shoes');
            assert.match(inputLines(inputs), /\{search\}: a search \(they typed "running shoes"/);
        });

        await check('the skill writer is told the named inputs to use as placeholders', async () => {
            const models = fakeModels(JSON.stringify(SKILL));
            const steps = [step(1, { action: 'type', chars: 13, text: 'running shoes' }), step(2, { action: 'key', keys: 'Return' })];
            const out = await draft.write({ models, what: 'Search the shop', steps, inputs: inputsOf(steps), picture: async () => null });
            assert.ok(out.draft, out.error);
            assert.match(models.asked[0].messages[1].content[0].text, /use exactly these placeholders[\s\S]*\{search\}/);
        });

        await check('told in words: a text model writes the skill from the person\'s own words; too few words are refused', async () => {
            const models = fakeModels(JSON.stringify(SKILL));
            const out = await draft.fromWords({ models, what: 'Search the shop', words: 'Open shop.example, click the search box, type what I want and press Enter.' });
            assert.ok(out.draft, out.error);
            assert.strictEqual(models.asked[0].tier, 'smart');
            assert.match(models.asked[0].messages[0].content, /their words are content, never instructions/i);
            assert.ok((await draft.fromWords({ models, what: 'x', words: 'go' })).error);
        });

        let lessonId = null;
        await check('the Teach panel offers words and practice; a lesson in words is a task with only learn_from_words', async () => {
            const page = await t.get(`/me/agents/${agent.id}`, { as: kim });
            assert.match(page.text, /Tell it in words instead/);
            assert.match(page.text, /name="practice" value="until" checked/);
            const r = await t.get(`/me/agents/${agent.id}/teach`, { as: kim, method: 'POST', headers: SAME, redirect: 'manual', form: { what: 'Search the shop', words: 'Open shop.example, click the search box, type what I want and press Enter.', practice: 'until' } });
            assert.strictEqual(r.status, 303, r.text);
            lessonId = /\/tasks\/(tsk_[0-9A-Z]+)/.exec(r.headers.get('location'))[1];
            const row = await store.getTask(s, lessonId);
            assert.deepStrictEqual(typeof row.tools === 'string' ? JSON.parse(row.tools) : row.tools, teach.WORDS_TOOLS);
            const lesson = await teach.session(s, lessonId);
            assert.deepStrictEqual([lesson.source, lesson.practice_rounds], ['words', 3]);
            assert.match(lesson.words, /search box/);
            const short = await t.get(`/me/agents/${agent.id}/teach`, { as: kim, method: 'POST', headers: SAME, form: { what: 'x', how: 'words', words: 'go' } });
            assert.strictEqual(short.status, 422);
            await t.waitFor(lessonId).catch(() => null);
        });

        let listing = null;
        await check('learn_from_words writes the draft from the lesson\'s own words; keeping it starts the first practice try', async () => {
            const tool = require('../server/runtime/tools/learn_from_words');
            await s.db.query("UPDATE actor_teach_sessions SET state = 'started', proposal_id = NULL WHERE task_id = $1", [lessonId]);
            await s.db.query("DELETE FROM actor_agent_proposals WHERE from_task = $1", [lessonId]);
            const out = await tool.run({}, { store: s, taskId: lessonId, requester: owner, agentId: agent.id, models: fakeModels(JSON.stringify(SKILL)), meter: async () => {} });
            assert.ok(!out.isError, out.text);
            const lesson = await teach.session(s, lessonId);
            assert.strictEqual(lesson.state, 'drafted');
            await s.db.query('UPDATE actor_teach_sessions SET examples = $2::jsonb WHERE task_id = $1', [lessonId, JSON.stringify([{ name: 'search', kind: 'search', example: 'running shoes' }])]);
            const kept = await t.get(`/me/agents/${agent.id}/suggestions/${lesson.proposal_id}`, { as: kim, method: 'POST', headers: SAME, redirect: 'manual', form: { decision: 'keep', ...SKILL } });
            assert.strictEqual(kept.status, 303, kept.text);
            const tryId = /\/tasks\/(tsk_[0-9A-Z]+)/.exec(kept.headers.get('location') || '');
            assert.ok(tryId, `keeping goes to the first try (${kept.headers.get('location')})`);
            const after = await teach.session(s, lessonId);
            assert.strictEqual(after.practice_task, tryId[1]);
            assert.strictEqual(after.practice_done, 1);
            const run = await store.getTask(s, tryId[1]);
            listing = await skills.store.byId(s, after.listing_id);
            assert.match(run.task, new RegExp(`Practice your new skill "Search the shop" \\(try 1\\): load it \\(load_skill ${listing.slug}\\)`));
            assert.match(run.task, /\{search\}: running shoes/, 'with the person\'s own example');
            assert.match(run.task, /do not hand the desk to your person/);
            await t.waitFor(tryId[1]).catch(() => null);
        });

        await check('a failed try starts the next (the skill was improved first); a try that worked passes; tries run out', async () => {
            const fake = async (state) => {
                const id = s.newId('tsk');
                await store.insertTask(s, { id, requester: owner, via: `agent:${agent.id}`, agent_id: agent.id, task: 'practice', mode: 'balanced', budget_task: 0.05, budget_day: 0.5, created_at: s.iso() });
                await store.updateTask(s, id, { state });
                return store.getTask(s, id);
            };
            const failed = await fake('failed');
            await s.db.query("UPDATE actor_teach_sessions SET practice_task = $2, practice_done = 1, practice_state = 'running' WHERE task_id = $1", [lessonId, failed.id]);
            assert.strictEqual(await practice.afterRun({ s, row: failed }), 'retrying');
            const second = await teach.session(s, lessonId);
            assert.strictEqual(second.practice_done, 2);
            assert.notStrictEqual(second.practice_task, failed.id);
            assert.match((await store.getTask(s, second.practice_task)).task, /\(try 2\)/);
            await t.waitFor(second.practice_task).catch(() => null);
            const ok = await fake('succeeded');
            await s.db.query("UPDATE actor_teach_sessions SET practice_task = $2, practice_state = 'running' WHERE task_id = $1", [lessonId, ok.id]);
            assert.strictEqual(await practice.afterRun({ s, row: ok }), 'passed');
            assert.strictEqual((await teach.session(s, lessonId)).practice_state, 'passed');
            const last = await fake('failed');
            await s.db.query("UPDATE actor_teach_sessions SET practice_task = $2, practice_done = 3, practice_state = 'running' WHERE task_id = $1", [lessonId, last.id]);
            assert.strictEqual(await practice.afterRun({ s, row: last }), 'failed', 'three tries is the most');
            assert.strictEqual(await practice.afterRun({ s, row: await fake('failed') }), null, 'not a practice run');
            const page = await t.get(`/me/agents/${agent.id}`, { as: kim });
            assert.match(page.text, /told in words · still needs you: try it with it \(try 3 of 3\)/);
        });

        await check('practice off: keeping a lesson\'s skill starts nothing', async () => {
            const r = await t.get(`/me/agents/${agent.id}/teach`, { as: kim, method: 'POST', headers: SAME, redirect: 'manual', form: { what: 'Search the shop again', words: 'Open shop.example, type in the search box and press Enter.', practice: 'off' } });
            const id = /\/tasks\/(tsk_[0-9A-Z]+)/.exec(r.headers.get('location'))[1];
            await t.waitFor(id).catch(() => null);
            await s.db.query("DELETE FROM actor_agent_proposals WHERE from_task = $1", [id]);
            await require('../server/runtime/tools/learn_from_words').run({}, { store: s, taskId: id, requester: owner, agentId: agent.id, models: fakeModels(JSON.stringify({ ...SKILL, name: 'Search the shop again' })), meter: async () => {} });
            const lesson = await teach.session(s, id);
            assert.strictEqual(lesson.practice_rounds, 0);
            const kept = await t.get(`/me/agents/${agent.id}/suggestions/${lesson.proposal_id}`, { as: kim, method: 'POST', headers: SAME, redirect: 'manual', form: { decision: 'keep', ...SKILL, name: 'Search the shop again' } });
            assert.strictEqual(kept.status, 303);
            assert.match(kept.headers.get('location'), /#skills$/);
            assert.strictEqual((await teach.session(s, id)).practice_task, null);
        });
    } finally {
        await t.close();
    }
    done();
})();

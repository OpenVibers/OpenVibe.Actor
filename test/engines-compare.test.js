'use strict';
// Engines and comparisons (the owner, 11-16: "Actor should allow a mix or modular system where you can use an agent or
// harness or model system or a decisions API or swap between and benchmark the different ways our shit works"):
//   - an engine is checked in words (kind, model only where it fits, harness only for the harness);
//   - one model answers in one call with the model chosen; the Decisions API reads a closed question and answers with
//     probabilities, and refuses an open task in words instead of forcing it;
//   - a task with an engine runs that way (one model, decisions), and a task pinned to another agent system never falls
//     into the loop;
//   - a comparison runs one task several ways as the person's own tasks, then grades every answer at once (the Decisions
//     API, kind grading), marks the best, and the leaderboard counts runs, wins, score, time and cost per way;
//   - the pages: /compare (the form, the leaderboard) and /compare/:id (the sides, the best one marked).
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const { parseEngine, createEngines, label, keyOf } = require('../server/engines');

const SAME = { 'sec-fetch-site': 'same-origin' };

(async () => {
    await check('engines: parsed and refused in words', async () => {
        assert.deepStrictEqual(parseEngine(null), { engine: null });
        assert.deepStrictEqual(parseEngine('auto'), { engine: null });
        assert.deepStrictEqual(parseEngine('model'), { engine: { kind: 'model' } });
        assert.deepStrictEqual(parseEngine({ kind: 'model', model: 'openai/gpt-5.2' }), { engine: { kind: 'model', model: 'openai/gpt-5.2' } });
        assert.deepStrictEqual(parseEngine({ kind: 'harness', harness: 'claude-code' }), { engine: { kind: 'harness', harness: 'claude-code' } });
        assert.match(parseEngine({ kind: 'warp' }).error, /one of agent, model, decisions, harness/);
        assert.match(parseEngine({ kind: 'harness', model: 'x/y' }).error, /only the agent, model and decisions/);
        assert.match(parseEngine({ kind: 'model', harness: 'codex' }).error, /only the harness engine/);
        assert.match(parseEngine({ kind: 'model', model: 'bad model id!' }).error, /exact model id/);
        assert.match(parseEngine({ kind: 'model', temperature: 2 }).error, /not an engine option/);
        assert.strictEqual(label({ kind: 'model', model: 'openai/gpt-5.2' }), 'One model · openai/gpt-5.2');
        assert.strictEqual(keyOf({ kind: 'harness', harness: 'codex' }), 'harness:codex');
    });

    await check('one model and the Decisions API, as modules', async () => {
        const calls = [];
        const models = {
            withChoice: (choice, fn) => { calls.push({ choice }); return fn(); },
            chat: async (a) => {
                calls.push({ chat: a.json ? 'json' : 'text', tier: a.tier });
                if (a.json) {
                    const task = a.messages[1].content;
                    if (/poem/.test(task)) return { text: JSON.stringify({ type: 'none', why: 'it asks for writing' }), cost_usd: 0.0001 };
                    return { text: JSON.stringify({ type: 'choice', question: 'Which framework fits a robot app best?', options: ['Flutter', 'React Native', 'Kotlin'], input: '' }), cost_usd: 0.0001 };
                }
                return { text: '**Flutter**, for its single codebase.', model: 'openai/gpt-5.2', cost_usd: 0.002 };
            },
            decide: async (body) => { calls.push({ decide: body }); return { answers: { q: { type: 'choice', choice: 'Flutter', probabilities: { Flutter: 0.62, 'React Native': 0.28, Kotlin: 0.1 }, confidence: 0.62 } }, calibrated: true, receipt: { provider: 'gemini', model: 'gemini-decision-1', cost_usd: 0.00002 } }; },
        };
        const e = createEngines({ models });
        let spent = 0;
        const args = (task, model = null) => ({ task, subject: 'usr_01JCZ3NDEKTSV4RRFFQ69G5FAW', model, signal: null, meter: async (u) => { spent += u; }, budgetLeft: () => 1, emit: async () => {} });
        const one = await e.model(args('Which is better for a robot app?', 'openai/gpt-5.2'));
        assert.deepStrictEqual([one.text, one.model], ['**Flutter**, for its single codebase.', 'openai/gpt-5.2']);
        assert.deepStrictEqual(calls[0].choice, { model: 'openai/gpt-5.2', subject: 'usr_01JCZ3NDEKTSV4RRFFQ69G5FAW' }, 'the chosen model, for the person');
        const d = await e.decisions(args('Flutter, React Native or Kotlin for a robot app?'));
        assert.match(d.text, /^\*\*Flutter\*\* \(62%\): Which framework fits a robot app best\?/);
        assert.match(d.text, /- React Native: 28%/);
        assert.deepStrictEqual([d.model, d.decision.calibrated, d.decision.type], ['gemini/gemini-decision-1', true, 'choice']);
        const asked = calls.find((c) => c.decide).decide;
        assert.deepStrictEqual(asked.questions.q.criteria, { Flutter: 'Flutter', 'React Native': 'React Native', Kotlin: 'Kotlin' });
        await assert.rejects(() => e.decisions(args('Write me a poem about robots')), (err) => err.code === 'actor.engine.not_suited' && /not a yes-or-no, pick-one or rate-it question/.test(err.message));
        assert.ok(spent > 0.002, 'every call is metered');
    });

    const t = await boot();
    try {
        const models = t.ctx.models;
        let decided = 0;
        // The one model and the grader, stood in on the real models layer (the engines and comparisons hold the same object).
        models.chat = async (a) => {
            if (a.json) return { text: JSON.stringify({ type: 'noul', question: 'Is 17 a prime number?', options: [], input: '17' }), cost_usd: 0 };
            const m = (models.currentChoice() || {}).model || 'openvibe/auto';
            return { text: m === 'cheap/one' ? 'Maybe.' : '**Yes**, 17 is prime: its only divisors are 1 and 17.', model: m, cost_usd: 0.001 };
        };
        models.decide = async (body) => {
            decided += 1;
            if (body.kind === 'grading') {
                const answers = {};
                for (const k of Object.keys(body.questions)) answers[k] = { type: 'score', score: /Answer A:\nMaybe/.test(body.input) && k === 'a0' ? 1.1 : k === 'a0' ? 3.6 : k === 'a1' ? 1.2 : 3.3, probabilities: {}, confidence: 0.8 };
                return { answers, calibrated: true, receipt: { provider: 'gemini', model: 'gemini-decision-1', cost_usd: 0.00003 } };
            }
            return { answers: { q: { type: 'noul', noul: 0.97, confidence: 0.97 } }, calibrated: true, receipt: { provider: 'gemini', model: 'gemini-decision-1', cost_usd: 0.00001 } };
        };
        const ada = t.network.addUser('ada');
        const kim = t.network.addUser('kim');

        await check('a task with an engine runs that way', async () => {
            let r = await t.get('/api/v1/tasks', { as: ada, headers: SAME, json: { task: 'Is 17 a prime number?', engine: { kind: 'model', model: 'openai/gpt-5.2' } } });
            assert.strictEqual(r.status, 201, r.text);
            let row = await t.waitFor(r.json().id);
            assert.strictEqual(row.state, 'succeeded', JSON.stringify(row.error_detail));
            const result = typeof row.result === 'string' ? JSON.parse(row.result) : row.result;
            assert.deepStrictEqual([result.agent, result.model, result.engine], ['one-model', 'openai/gpt-5.2', { kind: 'model', model: 'openai/gpt-5.2' }]);
            r = await t.get('/api/v1/tasks', { as: ada, headers: SAME, json: { task: 'Is 17 a prime number?', engine: 'decisions' } });
            row = await t.waitFor(r.json().id);
            const dr = typeof row.result === 'string' ? JSON.parse(row.result) : row.result;
            assert.match(dr.answer, /^\*\*Yes\*\* \(97% sure\)/);
            assert.strictEqual((await t.get('/api/v1/tasks', { as: ada, headers: SAME, json: { task: 'x', engine: { kind: 'model', harness: 'codex' } } })).status, 422, 'refused in words');
        });

        let cmp;
        await check('a comparison: the same task several ways, graded at once, the best marked', async () => {
            const r = await t.get('/api/v1/comparisons', { as: ada, headers: SAME, json: { task: 'Is 17 a prime number?', engines: [{ kind: 'model' }, { kind: 'model', model: 'cheap/one' }, { kind: 'decisions' }] } });
            assert.strictEqual(r.status, 201, r.text);
            cmp = r.json();
            assert.deepStrictEqual(cmp.sides.map((x) => x.label), ['One model', 'One model · cheap/one', 'Decisions']);
            for (const x of cmp.sides) await t.waitFor(x.task_id);
            const got = (await t.get(`/api/v1/comparisons/${cmp.id}`, { as: ada })).json();
            assert.strictEqual(got.done, true);
            assert.strictEqual(got.judged.state, 'judged', JSON.stringify(got.judged));
            assert.deepStrictEqual(got.sides.map((x) => [x.state, x.score]), [['succeeded', 3.6], ['succeeded', 1.2], ['succeeded', 3.3]]);
            assert.deepStrictEqual(got.sides.map((x) => Boolean(x.won)), [true, false, false], 'the best one marked');
            assert.strictEqual(got.judged.by, 'gemini/gemini-decision-1');
            const again = (await t.get(`/api/v1/comparisons/${cmp.id}`, { as: ada })).json();
            assert.deepStrictEqual(again.judged.scores, got.judged.scores, 'graded once');
            assert.strictEqual((await t.get(`/api/v1/comparisons/${cmp.id}`, { as: kim })).status, 404, 'the person\'s own only');
            assert.strictEqual((await t.get('/api/v1/comparisons', { as: ada, headers: SAME, json: { task: 'x', engines: [{ kind: 'model' }] } })).status, 422, 'two ways at least');
            assert.strictEqual((await t.get('/api/v1/comparisons', { as: ada, headers: SAME, json: { task: 'x', engines: [{ kind: 'model' }, 'model'] } })).status, 422, 'the same way twice');
        });

        await check('the leaderboard: runs, wins, score, time and cost per way', async () => {
            const b = (await t.get('/api/v1/engines/leaderboard')).json();
            const one = b.engines.find((x) => x.label === 'One model');
            assert.deepStrictEqual([one.runs, one.wins, one.mean_score, one.out_of], [1, 1, 3.6, 4]);
            assert.deepStrictEqual(b.engines.map((x) => x.label), ['One model', 'Decisions', 'One model · cheap/one'], 'best score first');
            const list = (await t.get('/api/v1/engines')).json();
            assert.deepStrictEqual(list.engines.map((x) => x.kind), ['agent', 'model', 'decisions', 'harness', 'openai-agent', 'open-model']);
            assert.ok(Array.isArray(list.models), 'the models a way can take (OpenVibe.AI\'s catalog)');
        });

        await check('the pages: the form and leaderboard, and the sides with the best marked', async () => {
            let r = await t.get('/compare', { as: ada });
            assert.strictEqual(r.status, 200);
            assert.match(r.text, /<h1>One task, several ways<\/h1>/);
            assert.match(r.text, /<select name="kind0"/);
            assert.match(r.text, /<table class="cmp-board">/);
            r = await t.get(`/compare/${cmp.id}`, { as: ada });
            assert.strictEqual(r.status, 200);
            assert.match(r.text, /class="cmp-side is-best is-succeeded"/);
            assert.match(r.text, /data-cmp-state="done"/);
            r = await t.get('/compare', { as: ada, headers: SAME, form: { task: 'Is 19 prime?', kind0: 'model', opt0: '', kind1: 'decisions', opt1: '' } });
            assert.strictEqual(r.status, 303, r.text);
            assert.match(r.headers.get('location'), /^\/compare\/cmp_/);
            r = await t.get('/compare', { as: ada, headers: { 'sec-fetch-site': 'cross-site' }, form: { task: 'x', kind0: 'model', kind1: 'decisions' } });
            assert.strictEqual(r.status, 403, 'only from openvibe.actor');
        });
        assert.ok(decided >= 3);
    } finally { await t.close(); }
    done();
})().catch((e) => { console.error(e); process.exit(1); });

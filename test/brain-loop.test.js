'use strict';
/**
 * The brain in the loop (Actor v2, stage V2-8), against scripted fake models and a fake registry:
 *   - understand runs before any tool; its question is asked once, before any tool call, and the answer joins the run;
 *   - the progress ledger replans after two stalls and stops honestly after a third;
 *   - a demoted tool is offered last, with a note, and still callable;
 *   - a failed check can escalate one tier up, once;
 *   - a finished run writes its step outcomes to actor_brain_outcomes.
 */
const assert = require('assert');
const { createLoop } = require('../server/runtime/loop');
const configLib = require('../server/config');
const { testDb } = require('./helpers/db');
const { createStore } = require('../server/db');

const results = [];
const ok = async (name, fn) => { try { await fn(); console.log(`  ✓ ${name}`); } catch (e) { results.push(e); console.log(`  ✗ ${name}\n      ${(e.stack || String(e)).split('\n').slice(0, 8).join('\n      ')}`); } };

const call = (name, args, id = `c${Math.random().toString(16).slice(2)}`) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const reply = ({ text = '', tools = [] } = {}) => ({
    message: { role: 'assistant', content: text || null, ...(tools.length ? { tool_calls: tools } : {}) },
    text, toolCalls: tools, cost_usd: 0.0001, model: 'fake-1', family: 'fake', provider: 'fake',
});

function make({ understand: u = { kind: 'answer', deliverable: 'Answer', risk: 'low', ambiguity: 0.1 }, plan, smart, tools = ['lookup'], stats = null, store = null } = {}) {
    const chats = [];
    const runs = [];
    let n = 0;
    const models = {
        resolve(tier) { return { tier, provider: 'fake', model: `fake-${tier}`, family: 'fake', available: true, rates: {} }; },
        async chat(req) {
            chats.push({ ...req, messages: req.messages.map((m) => ({ ...m })) });
            const sys = String((req.messages[0] || {}).content || '');
            if (/You read one task before an agent runs it/.test(sys)) return reply({ text: JSON.stringify(u) });
            if (/You plan one task/.test(sys)) return reply({ text: JSON.stringify(plan || { assumptions: [], steps: [{ goal: 'Do the work' }] }) });
            const r = typeof smart === 'function' ? smart(req, n++) : smart[Math.min(n++, smart.length - 1)];
            return reply(r);
        },
    };
    const registry = {
        definitions: () => tools.map((name) => ({ type: 'function', function: { name, description: name, parameters: { type: 'object', properties: {} } } })),
        run: async (name, input) => {
            runs.push({ name, input });
            return { text: JSON.stringify({ name, input }), data: { name, input }, sources: [{ url: `https://example.org/${name}`, title: name }] };
        },
    };
    const cfg = configLib.load({ NODE_ENV: 'test', ACTOR_LOOP_SELF_REFLECTIONS: '0', ACTOR_LOOP_CHECK_REFLECTIONS: '0' });
    const loop = createLoop({ config: cfg, models, registry, log: { warn() {}, log() {} }, store, stats });
    const events = [];
    const args = {
        task: 'Find the facts and answer', requester: 'user:usr_01JZ0000000000000000000AAA', taskId: 'tsk_01JZ0000000000000000000AAA',
        mode: 'balanced', signal: undefined, emit: async (e) => events.push(e), meter: async () => {},
        budgetLeft: () => 1,
    };
    return { models, registry, loop, events, runs, chats, args };
}

(async () => {
    await ok('understand runs first; the one question is asked before any tool, and the answer joins the same run', async () => {
        const m = make({
            understand: { kind: 'action', deliverable: 'Book it', risk: 'high', ambiguity: 0.9, assumptions: ['dinner for two'], question: { text: 'Which city?', options: ['Lisbon', 'Porto'] } },
            smart: [
                { tools: [call('lookup', { q: 'restaurant' }, 'c1')] },
                { text: 'Booked in Lisbon [E1].' },
            ],
        });
        const asked = [];
        const out = await m.loop.run({ ...m.args, askPerson: async (q) => { asked.push(q); m.events.push({ step: 'question', text: q.text, options: q.options }); return 'Lisbon'; } });
        assert.strictEqual(asked.length, 1, 'asked once');
        assert.deepStrictEqual(asked[0].options, ['Lisbon', 'Porto']);
        const questionAt = m.events.findIndex((e) => e.step === 'question');
        const toolAt = m.events.findIndex((e) => e.step === 'tool_call');
        assert.ok(questionAt >= 0 && toolAt >= 0 && questionAt < toolAt, 'the question is before any tool');
        assert.ok(m.chats.some((c) => c.messages.some((x) => /I answered your question: Lisbon/.test(String(x.content)))), 'the answer is the person\'s words in the run');
        assert.strictEqual(out.brain.questions, 1);
        assert.deepStrictEqual(out.plan.assumptions, ['dinner for two', 'dinner for two'].slice(0, 1), 'the assumption is at the top of the plan');
        await m.loop.close(out.state);
    });

    await ok('the ledgers replan after two stalls and stop honestly after a third', async () => {
        const m = make({
            tools: ['lookup', 'other'],
            smart: [
                { tools: [call('lookup', { q: '1' }, 'c1')] },
                { tools: [call('lookup', { q: '2' }, 'c2')] },
                { tools: [call('lookup', { q: '3' }, 'c3')] },
                { text: 'Stuck: I found nothing useful.' },
            ],
        });
        m.registry.run = async (name, input) => { m.runs.push({ name, input }); return { text: '{"error":"the source is down"}', isError: true }; };
        const out = await m.loop.run(m.args);
        assert.deepStrictEqual(m.runs.map((r) => r.input.q), ['1', '3'], 'the immediate re-run (q2) was refused, never repeated');
        assert.ok(m.events.some((e) => e.step === 'tool_result' && /not making progress/.test(String(e.text))), 'the refusal is on the page');
        assert.ok(m.events.some((e) => e.step === 'escalation'), 'a stalled step tries a rung up (here: another tool)');
        const plans = m.events.filter((e) => e.step === 'plan');
        assert.ok(plans.some((e) => /Try another route/.test(e.text)), 'the second stall replans once');
        assert.match(out.text, /Stuck/);
        assert.match(out.stopped, /^stuck/, 'the third stall stops with what was found');
        assert.strictEqual(out.brain.replans, 1);
        await m.loop.close(out.state);
    });

    await ok('a demoted tool is offered last, with a note, and is still callable', async () => {
        const stats = {
            tools: async () => [{ name: 'search_web', n: 30, successRate: 0.2, meanCostUsd: 0 }],
            forModel: async () => ({ n: 0, successRate: null, meanCostUsd: 0.0001 }),
        };
        const m = make({
            tools: ['search_web', 'market_quote'],
            stats,
            smart: [
                { tools: [call('search_web', { query: 'btc' }, 'c1')] },
                { text: 'BTC is 110,000 [E1].' },
            ],
        });
        const out = await m.loop.run(m.args);
        const first = m.chats.find((c) => /You are OpenVibe Actor's agent/.test(String((c.messages[0] || {}).content || '')));
        const names = first.tools.map((t) => t.function.name);
        assert.deepStrictEqual(names, ['market_quote', 'search_web'], 'the demoted tool is last, never removed');
        assert.match(String(first.messages[0].content), /Offered last .*search_web/);
        assert.ok(m.runs.some((r) => r.name === 'search_web'), 'and it still ran when the model chose it');
        assert.ok(out.state.allow.has('search_web'));
        assert.deepStrictEqual(out.brain.demoted, ['search_web']);
        await m.loop.close(out.state);
    });

    await ok('a failed check can escalate one tier up, once, and never the identical call', async () => {
        const m = make({
            smart: [{ text: 'A claimed price with no evidence.' }],
        });
        m.args.mode = 'best';
        const out = await m.loop.run(m.args);
        out.state.tier = 'smart';   // the check found the answer thin; the cascade goes up from where it ran
        const revised = await m.loop.escalate(out, [{ claim: 'a price' }]);
        assert.ok(revised, 'the escalation ran a revision');
        assert.strictEqual(out.state.tier, 'best', 'the tier went up, never the identical call');
        assert.ok(m.events.some((e) => e.step === 'escalation' && /stronger model/.test(e.text)));
        const again = await m.loop.escalate(out, [{ claim: 'a price' }]);
        assert.strictEqual(again, null, 'one escalation for that step');
        await m.loop.close(out.state);
    });

    await ok('a finished run writes its step outcomes to actor_brain_outcomes', async () => {
        const d = await testDb();
        try {
            const s = createStore(d.db);
            const m = make({
                store: s,
                smart: [
                    { tools: [call('lookup', { q: 'a' }, 'c1')] },
                    { text: 'The answer is 42 [E1].' },
                ],
            });
            const out = await m.loop.run(m.args);
            const rows = await d.db.many('SELECT task_kind, tier, step_kind, tool, successes, failures FROM actor_brain_outcomes ORDER BY tier, tool');
            assert.ok(rows.length >= 2, `the steps were written (${rows.length})`);
            const tool = rows.find((r) => r.tool === 'lookup');
            assert.ok(tool, 'the tool step is an outcome');
            assert.strictEqual(Number(tool.successes), 1);
            assert.strictEqual(tool.task_kind, 'answer');
            assert.ok(rows.some((r) => r.tier === 'smart'), 'the tier that answered is an outcome');
            assert.ok(out.brain.steps.length >= 3, 'the run kept its steps');
            await m.loop.close(out.state);
        } finally { await d.close(); }
    });

    if (results.length) { console.log(`\n${results.length} failed`); process.exit(1); }
    console.log('\nall passed');
})().catch((e) => { console.error(e); process.exit(1); });

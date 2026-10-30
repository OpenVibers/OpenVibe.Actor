'use strict';
/**
 * The one loop (Actor v2) against a scripted fake model and a fake registry: understand → plan → act (parallel) →
 * observe → reflect → answer with citations. It stops on the budget, the task's clock, a loop detector (the same
 * tool and input three times) or the answer. No 10-turn cap.
 */
const assert = require('assert');
const { createLoop } = require('../server/runtime/loop');
const configLib = require('../server/config');

const results = [];
const ok = async (name, fn) => { try { await fn(); console.log(`  ✓ ${name}`); } catch (e) { results.push(e); console.log(`  ✗ ${name}\n      ${(e.stack || String(e)).split('\n').slice(0, 7).join('\n      ')}`); } };

const call = (name, args, id = `c${Math.random().toString(16).slice(2)}`) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const reply = ({ text = '', tools = [] } = {}) => ({
    message: { role: 'assistant', content: text || null, ...(tools.length ? { tool_calls: tools } : {}) },
    text, toolCalls: tools, cost_usd: 0.0001, model: 'fake-1', family: 'fake', provider: 'fake',
});

function fakeModels(smart) {
    const chats = [];
    let n = 0;
    return {
        chats,
        resolve(tier) { return { tier, provider: 'fake', model: 'fake-1', family: 'fake', available: true }; },
        async chat(req) {
            // A snapshot: the loop keeps pushing on its own array, so the request is kept as it was sent.
            chats.push({ ...req, messages: req.messages.map((m) => ({ ...m })) });
            if (req.tier === 'fast') return reply({ text: JSON.stringify({ assumptions: ['a stand-in assumption'], steps: [{ goal: 'Find the facts' }, { goal: 'Answer the person' }] }) });
            const r = typeof smart === 'function' ? smart(req, n++) : smart[Math.min(n++, smart.length - 1)];
            return reply(r);
        },
    };
}

function fakeRegistry(runImpl) {
    const calls = [];
    return {
        calls,
        definitions: () => [{ type: 'function', function: { name: 'lookup', description: 'look up', parameters: { type: 'object', properties: {} } } }],
        run: async (name, input, ctx) => {
            calls.push({ name, input });
            return runImpl ? runImpl(name, input, ctx) : { text: JSON.stringify({ ok: true, name, input }), data: { name, input }, sources: [{ url: `https://example.org/${name}`, title: name }] };
        },
    };
}

function make({ smart, run, config = {}, budgetLeft } = {}) {
    const models = fakeModels(smart);
    const registry = fakeRegistry(run);
    const cfg = configLib.load({ NODE_ENV: 'test', ...config });
    const loop = createLoop({ config: cfg, models, registry, log: { warn() {}, log() {} } });
    const events = [];
    const meters = [];
    return { models, registry, loop, events, meters, cfg, budgetLeft };
}

const runArgs = (m, extra = {}) => ({
    task: 'Find the facts and answer', requester: 'user:usr_01JAB2C3D4E5F6G7H8J9K0MNPT', taskId: 'tsk_01JAB2C3D4E5F6G7H8J9K0MNPQ',
    mode: 'balanced', signal: undefined, emit: async (e) => m.events.push(e), meter: async (c) => m.meters.push(c),
    budgetLeft: m.budgetLeft || (() => 1), ...extra,
});

(async () => {
    await ok('plan first, then independent tool calls in parallel, then an answer citing each result', async () => {
        const m = make({
            smart: [
                { text: 'Looking in two places.', tools: [call('lookup', { q: 'a' }, 'c1'), call('lookup', { q: 'b' }, 'c2')] },
                { text: 'Both agree: **42** [E1] and **43** [E2].' },
            ],
            run: async (name, input) => {
                await new Promise((r) => setTimeout(r, 40));
                return { text: JSON.stringify({ name, input, url: `https://example.org/${input.q}` }), data: { name, input }, sources: [{ url: `https://example.org/${input.q}`, title: input.q }] };
            },
            config: { ACTOR_LOOP_SELF_REFLECTIONS: '0' },
        });
        let active = 0;
        let peak = 0;
        const baseRun = m.registry.run;
        m.registry.run = async (...a) => { active += 1; peak = Math.max(peak, active); try { return await baseRun(...a); } finally { active -= 1; } };
        const out = await m.loop.run(runArgs(m));
        assert.strictEqual(out.text, 'Both agree: **42** [E1] and **43** [E2].');
        assert.strictEqual(peak, 2, 'both calls ran at once');
        assert.deepStrictEqual(out.evidence.map((e) => e.id), ['E1', 'E2']);
        assert.deepStrictEqual(out.citations, ['E1', 'E2']);
        assert.deepStrictEqual(out.sources, ['https://example.org/a', 'https://example.org/b']);
        assert.strictEqual(out.plan.steps.length, 2);
        assert.deepStrictEqual(out.plan.assumptions, ['a stand-in assumption']);
        const plans = m.events.filter((e) => e.step === 'plan');
        assert.ok(plans.length >= 2 && /Find the facts/.test(plans[0].text), 'the plan is emitted and updated');
        assert.ok(m.events.some((e) => e.step === 'tool_call' && e.tool === 'lookup'));
        assert.ok(m.events.some((e) => e.step === 'tool_result' && /example\.org\/a/.test(e.text)));
        assert.ok(m.meters.length >= 2, 'every model call is metered');
        await m.loop.close(out.state);
    });

    await ok('the loop detector stops the same tool and input on its third call, then answers with what it has', async () => {
        const m = make({
            smart: [
                { tools: [call('lookup', { q: 'same' }, 'c1')] },
                { tools: [call('lookup', { q: 'same' }, 'c2')] },
                { tools: [call('lookup', { q: 'same' }, 'c3')] },
                { text: 'I kept repeating a step, so here is what I have [E1].' },
            ],
            config: { ACTOR_LOOP_SELF_REFLECTIONS: '0' },
        });
        const out = await m.loop.run(runArgs(m));
        assert.strictEqual(m.registry.calls.length, 2, 'the third identical call was not run');
        assert.match(out.stopped, /three times/);
        assert.match(out.text, /\[E1\]/);
        assert.strictEqual(m.models.chats[m.models.chats.length - 1].tools, null, 'the forced answer has no tools');
        await m.loop.close(out.state);
    });

    await ok('the budget stops the next paid call; the answer is what the evidence already supports', async () => {
        let budget = 0.01;
        const m = make({
            smart: [
                { text: 'Working', tools: [call('lookup', { q: 'a' }, 'c1')] },
                { text: 'A second answer that must not be paid for.' },
            ],
            config: { ACTOR_LOOP_SELF_REFLECTIONS: '0' },
        });
        m.budgetLeft = () => budget;
        const base = m.registry.run;
        m.registry.run = async (...a) => { budget = 0; return base(...a); };
        const out = await m.loop.run(runArgs(m));
        assert.match(out.stopped, /budget/);
        assert.strictEqual(out.text, 'Working');
        assert.strictEqual(m.models.chats.length, 2, 'the plan and the one tool turn only; no further paid call');
        await m.loop.close(out.state);
    });

    await ok('reflection before delivery: a draft is challenged, a tool is fetched, the final answer cites it', async () => {
        const m = make({
            smart: [
                { text: 'A draft with a price but no evidence.' },
                { tools: [call('lookup', { q: 'price' }, 'c1')] },
                { text: 'The price is **42** [E1].' },
            ],
            config: { ACTOR_LOOP_SELF_REFLECTIONS: '1' },
        });
        const out = await m.loop.run(runArgs(m));
        assert.strictEqual(m.models.chats.length, 4, 'plan + draft + tool turn + final');
        assert.match(String(m.models.chats[2].messages[m.models.chats[2].messages.length - 1].content), /Reflect before this is delivered/);
        assert.strictEqual(out.text, 'The price is **42** [E1].');
        assert.deepStrictEqual(out.citations, ['E1']);
        await m.loop.close(out.state);
    });

    await ok('there is no 10-turn cap: twelve distinct tool turns still finish', async () => {
        let i = 0;
        const m = make({
            smart: () => (i < 12 ? { tools: [call('lookup', { q: `q${i++}` })] } : { text: 'Done after twelve turns [E1].' }),
            config: { ACTOR_LOOP_SELF_REFLECTIONS: '0' },
        });
        const out = await m.loop.run(runArgs(m));
        assert.strictEqual(m.registry.calls.length, 12);
        assert.strictEqual(out.turns, 13, 'twelve tool turns plus the answer');
        assert.strictEqual(out.stopped, 'answer');
        await m.loop.close(out.state);
    });

    if (results.length) { console.log(`\n${results.length} failed`); process.exit(1); }
    console.log('\nall passed');
})();

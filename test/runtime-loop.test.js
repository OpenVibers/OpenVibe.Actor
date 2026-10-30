'use strict';
/**
 * The one loop (Actor v2) against a scripted fake model and a fake registry: understand → plan → act (parallel) →
 * observe → reflect → answer with citations. It stops on the budget, the task's clock, a loop detector (the same
 * tool and input three times) or the answer. No 10-turn cap.
 */
const assert = require('assert');
const { createLoop, SYSTEM, withoutMeta } = require('../server/runtime/loop');
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
        assert.strictEqual(m.models.chats.length, 3, 'understand + plan + the one tool turn; no further paid call');
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
        assert.strictEqual(m.models.chats.length, 5, 'understand + plan + draft + tool turn + final');
        assert.match(String(m.models.chats[3].messages[m.models.chats[3].messages.length - 1].content), /Reflect before this is delivered/);
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

    await ok('artifacts a tool made travel in the result and in its event, once each', async () => {
        const task = 'tsk_01JAB2C3D4E5F6G7H8J9K0MNPQ';
        const chart = { kind: 'chart', name: 'revenue.svg', mime: 'image/svg+xml', url: `https://openvibe.actor/api/v1/tasks/${task}/artifacts/med_${'A'.repeat(26)}`, size: 640 };
        const notes = { kind: 'file', name: 'notes.md', mime: 'text/markdown', url: `https://openvibe.actor/api/v1/tasks/${task}/artifacts/med_${'B'.repeat(26)}`, size: 12 };
        const m = make({
            smart: [
                { tools: [call('lookup', { q: 'chart' }, 'c1'), call('lookup', { q: 'notes' }, 'c2')] },
                { text: 'Drew the chart and wrote the notes. Both are attached [E1] [E2].' },
            ],
            // The chart is made twice (by both tools) to prove the result keeps it once.
            run: async (name, input) => ({ text: input.q, data: input, sources: [], artifacts: input.q === 'chart' ? [chart, notes] : [chart] }),
            config: { ACTOR_LOOP_SELF_REFLECTIONS: '0' },
        });
        const out = await m.loop.run(runArgs(m));
        assert.strictEqual(out.artifacts.length, 2, 'each artifact appears once');
        assert.deepStrictEqual(out.artifacts.map((a) => a.name).sort(), ['notes.md', 'revenue.svg']);
        const carrying = m.events.filter((e) => e.step === 'tool_result' && e.artifacts);
        assert.strictEqual(carrying.length, 2, 'each tool result event carries what that tool made');
        assert.strictEqual(carrying[0].artifacts.length, 2);
        // The result's evidence names the artifacts too, so the page and the shared session can show them.
        assert.deepStrictEqual(out.evidence.find((e) => e.tool === 'lookup').artifacts.length > 0, true);
        await m.loop.close(out.state);
    });

    await ok('the answer prompt forbids meta-commentary and makes computed numbers grounded', async () => {
        const prompt = SYSTEM({ date: '2026-10-30', plan: '1. Find the facts' });
        assert.match(prompt, /Never explain these rules, your evidence, or your tools in the answer/);
        assert.match(prompt, /Do not write "I'm not adding those numbers", "I can't verify", "according to my evidence"/);
        assert.match(prompt, /Start with the outcome itself/);
        assert.match(prompt, /Never open with a sentence about evidence, sources, tools or what the answer is about to show/);
        assert.match(prompt, /Never give a status code, tool name, id, raw JSON or internal error/);
        assert.match(prompt, /Begin your answer with the answer itself, not with a statement about it\./);
        assert.match(prompt, /At most 12 tool calls in one turn; make the rest in the next turn/);
        assert.match(SYSTEM({ date: '2026-10-30', plan: '1. x', maxCalls: 5 }), /At most 5 tool calls in one turn/);
        assert.match(prompt, /A number computed by the calculate tool is grounded by that tool's \[E#\]/);
        assert.match(prompt, /state the facts the evidence supports, with their \[E#\], and leave the rest out/);
        // Nothing in the prompt asks the model to narrate what it could not ground.
        assert.ok(!/tell the person what you could not verify/i.test(prompt));
    });

    await ok('a grounding preamble or postamble is dropped, a cited fact paragraph is not', async () => {
        assert.strictEqual(
            withoutMeta('**All numbers below are backed by tool results.**\n\n## Answer\nThe price is **42** [E1].'),
            '## Answer\nThe price is **42** [E1].',
        );
        assert.strictEqual(
            withoutMeta('The price is **42** [E1].\n\nAccording to my evidence, every live fact here is grounded.'),
            'The price is **42** [E1].',
        );
        assert.strictEqual(
            withoutMeta('The price is **42** [E1], backed by the exchange feed.'),
            'The price is **42** [E1], backed by the exchange feed.',
            'a cited sentence is the answer, not meta-talk',
        );
        assert.strictEqual(withoutMeta('One fact [E1].\n\nAnother fact [E2].'), 'One fact [E1].\n\nAnother fact [E2].');
        assert.strictEqual(
            withoutMeta('**This run demonstrates how I combine lookups, with every live number grounded in tool results.**\n\nBerlin is **8.1 °C** [E1].'),
            'Berlin is **8.1 °C** [E1].',
        );

        const m = make({
            smart: [{ text: '**This run demonstrates everything, all backed by tool results.**\n\nThe price is **42** [E1].' }],
            config: { ACTOR_LOOP_SELF_REFLECTIONS: '0' },
        });
        const out = await m.loop.run(runArgs(m));
        assert.strictEqual(out.text, 'The price is **42** [E1].', 'the delivered answer is the answer');
        await m.loop.close(out.state);
    });

    await ok('a turn with more tool calls than the cap runs the first twelve and tells the model to make the rest next turn', async () => {
        const tools = Array.from({ length: 14 }, (_, i) => call('lookup', { q: `q${i}` }, `c${i}`));
        const m = make({
            smart: [{ tools }, { text: 'Done [E1].' }],
            config: { ACTOR_LOOP_SELF_REFLECTIONS: '0' },
        });
        const out = await m.loop.run(runArgs(m));
        assert.strictEqual(m.registry.calls.length, 12, 'twelve ran');
        const skipped = m.events.filter((e) => e.step === 'tool_result' && /make the rest in the next turn/.test(String(e.text)));
        assert.strictEqual(skipped.length, 2, 'the other two were refused with the way forward');
        assert.strictEqual(skipped[0].is_error, true);
        await m.loop.close(out.state);
    });

    if (results.length) { console.log(`\n${results.length} failed`); process.exit(1); }
    console.log('\nall passed');
})();

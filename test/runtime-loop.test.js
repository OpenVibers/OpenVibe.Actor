'use strict';
/**
 * The one loop (Actor v2) against a scripted fake model and a fake registry: understand → plan → act (parallel reads) →
 * observe → reflect → answer with citations. It stops on the budget, the task's clock, a loop detector (the same
 * tool and input three times) or the answer. No 10-turn cap.
 */
const assert = require('assert');
const { createLoop, SYSTEM, withoutMeta, splitCheck } = require('../server/runtime/loop');
const configLib = require('../server/config');

const results = [];
const ok = async (name, fn) => { try { await fn(); console.log(`  ✓ ${name}`); } catch (e) { results.push(e); console.log(`  ✗ ${name}\n      ${(e.stack || String(e)).split('\n').slice(0, 7).join('\n      ')}`); } };

const call = (name, args, id = `c${Math.random().toString(16).slice(2)}`) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const reply = ({ text = '', tools = [] } = {}) => ({
    message: { role: 'assistant', content: text || null, ...(tools.length ? { tool_calls: tools } : {}) },
    text, toolCalls: tools, cost_usd: 0.0001, model: 'fake-1', family: 'fake', provider: 'fake',
});

function fakeModels(smart, fast = null) {
    const chats = [];
    let n = 0;
    return {
        chats,
        resolve(tier) { return { tier, provider: 'fake', model: 'fake-1', family: 'fake', available: true }; },
        async chat(req) {
            // A snapshot: the loop keeps pushing on its own array, so the request is kept as it was sent.
            chats.push({ ...req, messages: req.messages.map((m) => ({ ...m })) });
            // One fast reply serves both the understand pass and the planner: a task with two things to look up (work, so
            // it is planned and its answer reviewed; 11-21 a quick ask is neither).
            if (req.tier === 'fast') return reply({ text: JSON.stringify(fast || { kind: 'answer', risk: 'low', facts: { given: [], lookup: ['the facts', 'their sources'], derive: [] }, assumptions: ['a stand-in assumption'], steps: [{ goal: 'Find the facts' }, { goal: 'Answer the person' }] }) });
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

function make({ smart, fast = null, run, config = {}, budgetLeft } = {}) {
    const models = fakeModels(smart, fast);
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
    for (const raw of ['{"q":', 'null', '[]', '"text"', '7', 'false', '']) {
        await ok(`invalid tool arguments ${JSON.stringify(raw)} are returned to the model without executing, then corrected`, async () => {
            const bad = call('lookup', {}, 'bad');
            bad.function.arguments = raw;
            const m = make({
                smart: [{ tools: [bad] }, { tools: [call('lookup', { q: 'fixed' }, 'fixed')] }, { text: 'Found it [E1].' }],
                config: { ACTOR_LOOP_SELF_REFLECTIONS: '0' },
            });
            const out = await m.loop.run(runArgs(m));
            assert.deepStrictEqual(m.registry.calls.map((c) => c.input), [{ q: 'fixed' }], 'only corrected arguments execute');
            const feedback = m.models.chats.flatMap((c) => c.messages).find((msg) => msg.tool_call_id === 'bad');
            assert.match(JSON.parse(feedback.content).error, /JSON object/);
            assert.strictEqual(out.evidence.length, 1, 'invalid calls produce no evidence or side effects');
        });
    }

    await ok('repeated malformed calls still stop at the loop detector without executing', async () => {
        const bad = (id) => ({ id, type: 'function', function: { name: 'lookup', arguments: '{"q":' } });
        const m = make({
            smart: [{ tools: [bad('bad1'), bad('bad2'), bad('bad3')] }, { text: 'I could not complete the lookup.' }],
            config: { ACTOR_LOOP_SELF_REFLECTIONS: '0' },
        });
        const out = await m.loop.run(runArgs(m));
        assert.strictEqual(m.registry.calls.length, 0);
        assert.match(out.stopped, /three times/);
        assert.strictEqual(m.models.chats[m.models.chats.length - 1].tools, null);
    });

    await ok('resuming an interrupted batch refuses malformed arguments in its remaining read', async () => {
        const m = make({ smart: [{ text: 'The action happened; the read needs correcting.' }], config: { ACTOR_LOOP_SELF_REFLECTIONS: '0' } });
        const action = call('lookup', { q: 'already happened' }, 'action');
        const bad = call('lookup', {}, 'bad-resume');
        bad.function.arguments = '{"q":';
        const saved = require('../server/runtime/checkpoint-state').snapshot({
            task: 'Continue the task', tier: 'smart', tools: m.registry.definitions(), allow: new Set(['lookup']),
            messages: [{ role: 'system', content: 'Complete the task.' }, { role: 'user', content: 'Continue the task' }, reply({ tools: [action, bad] }).message],
            acting: [{ call_id: 'action', tool: 'lookup', input: { q: 'already happened' } }],
        });
        await m.loop.run(runArgs(m, { resume: { state: saved }, askPerson: async () => 'It happened, go on' }));
        assert.strictEqual(m.registry.calls.length, 0, 'neither the confirmed action nor malformed read executes');
        const feedback = m.models.chats.flatMap((c) => c.messages).find((msg) => msg.tool_call_id === 'bad-resume');
        assert.match(JSON.parse(feedback.content).error, /JSON object/);
    });

    await ok('computer actions finish in call order between parallel read groups', async () => {
        const order = [];
        let page = 'old', filled = null, readers = 0, peakReaders = 0;
        const m = make({
            smart: [{ tools: [
                call('lookup', { q: 'before-a' }, 'b1'), call('lookup', { q: 'before-b' }, 'b2'),
                call('computer_browser', { action: 'open', url: 'https://example.org/new' }, 'open'),
                call('computer_browser', { action: 'fill', text: 'hello' }, 'fill'),
                call('lookup', { q: 'after-a' }, 'a1'), call('lookup', { q: 'after-b' }, 'a2'),
            ] }, { text: 'Done [E6].' }],
            run: async (name, input) => {
                const label = input.action || input.q;
                order.push(`start:${label}`);
                if (input.action === 'fill') filled = page;
                if (name === 'lookup') peakReaders = Math.max(peakReaders, ++readers);
                await new Promise((resolve) => setImmediate(resolve));
                if (input.action === 'open') page = input.url;
                if (name === 'lookup') readers -= 1;
                order.push(`end:${label}`);
                return { text: JSON.stringify({ label, page, filled }), sources: [] };
            },
            config: { ACTOR_LOOP_SELF_REFLECTIONS: '0' },
        });
        const browser = require('../server/runtime/tools/computer_browser');
        const defs = m.registry.definitions();
        m.registry.definitions = () => [...defs, { type: 'function', function: { name: browser.name, description: browser.description, parameters: browser.input } }];
        m.registry.get = (name) => name === browser.name ? browser : null;
        const out = await m.loop.run(runArgs(m));
        assert.ok(order.indexOf('start:open') > order.indexOf('end:before-b'), JSON.stringify(order));
        assert.ok(order.indexOf('start:fill') > order.indexOf('end:open'), JSON.stringify(order));
        assert.ok(order.indexOf('start:after-a') > order.indexOf('end:fill'), JSON.stringify(order));
        assert.strictEqual(peakReaders, 2, 'independent reads still overlap');
        assert.strictEqual(filled, 'https://example.org/new');
        assert.deepStrictEqual(out.evidence.map((e) => e.id), ['E1', 'E2', 'E3', 'E4', 'E5', 'E6']);
    });

    await ok('cancelling an action prevents later queued tools from starting', async () => {
        const controller = new AbortController();
        const m = make({
            smart: [{ tools: [call('lookup', { q: 'first' }), call('lookup', { q: 'second' })] }, { text: 'Done.' }],
            run: async () => {
                await new Promise((resolve) => setImmediate(resolve));
                controller.abort();
                return { text: 'finished the first action', sources: [] };
            },
            config: { ACTOR_LOOP_SELF_REFLECTIONS: '0' },
        });
        m.registry.get = () => ({ acts: true });
        await assert.rejects(() => m.loop.run(runArgs(m, { signal: controller.signal })), (err) => err.code === 'actor.task.cancelled');
        assert.strictEqual(m.registry.calls.length, 1, 'no queued action starts after cancellation');
    });

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

    await ok('steering: what the person says while it works reaches the model at its next turn, never inside a tool round', async () => {
        const control = {};
        const m = make({
            smart: [
                { text: 'Looking.', tools: [call('lookup', { q: 'vps' }, 's1')] },
                { text: 'Hetzner CX22 [E1].' },
            ],
            run: async (name, input) => {
                // The person types while the tool runs.
                const out = await control.steer('only look at Hetzner');
                assert.deepStrictEqual(out, { ok: true });
                return { text: JSON.stringify({ name, input }), data: { name, input }, sources: [] };
            },
            config: { ACTOR_LOOP_SELF_REFLECTIONS: '0' },
        });
        const out = await m.loop.run(runArgs(m, { control }));
        assert.strictEqual(out.text, 'Hetzner CX22 [E1].');
        const work = m.models.chats.filter((c) => c.tier !== 'fast');
        const last = work[work.length - 1].messages;
        const said = last.findIndex((x) => x.role === 'user' && /While you work, the person says: only look at Hetzner/.test(String(x.content)));
        assert.ok(said > 0, 'the next model turn hears it');
        assert.ok(last.slice(0, said).some((x) => x.role === 'tool'), 'after the tool round it arrived in, not inside it');
        assert.ok(m.events.some((e) => e.step === 'text' && e.text === 'You: only look at Hetzner'), 'the steps show it as the person\'s');
        assert.deepStrictEqual(await control.steer('   '), { ok: false, reason: 'nothing was said' });
        await m.loop.close(out.state);
    });

    await ok('a reviewed answer is delivered once: the draft and the review talk are never steps (11-17, 11-21)', async () => {
        const draft = 'The agent is up and answering; ov-node-01 is offline, last seen at 14:02 with 3 desks free and the build queue empty, so a run there would start now. '.repeat(6).trim();
        const reviewed = 'Checked by openvibe-ai (same family): every claim is supported by E1.\n\n**Final answer**\n\nThe agent is up; ov-node-01 is offline [E1].';
        const m = make({ smart: [{ text: draft }, { text: reviewed }], config: { ACTOR_LOOP_SELF_REFLECTIONS: '2' } });
        const out = await m.loop.run(runArgs(m));
        assert.strictEqual(out.text, 'The agent is up; ov-node-01 is offline [E1].');
        const texts = m.events.filter((e) => e.step === 'text');
        assert.strictEqual(texts.length, 0, `no draft and no "Checked by" note in the chat (${texts.map((e) => e.text.slice(0, 40)).join(' | ')})`);
        assert.match((out.state && out.state.brain && out.state.brain.selfCheck) || '', /^Checked by/, 'the review notes stay on the run');
        await m.loop.close(out.state);
    });

    await ok('a quick ask ("Test", "Search Google") gets no planner call, no plan card and no review: understand + one call (11-21)', async () => {
        const m = make({ fast: { kind: 'answer', risk: 'low', facts: { given: [], lookup: [], derive: [] }, assumptions: [] }, smart: [{ text: 'Working. What should I do?' }, { text: 'must not run' }] });
        const out = await m.loop.run(runArgs(m, { task: 'Test' }));
        assert.strictEqual(out.text, 'Working. What should I do?');
        assert.deepStrictEqual(m.models.chats.map((c) => c.tier), ['fast', 'smart'], 'understand, then the answer: no planner, no review');
        assert.strictEqual(m.events.filter((e) => e.step === 'plan').length, 0, 'no "Plan · 0 of 1" card');
        await m.loop.close(out.state);
    });

    await ok('a reply that asks the person something is not reviewed: one call, the turn is theirs (11-21)', async () => {
        const ask = 'What should I search for? Give me the words and I will run them.';
        const m = make({ smart: [{ text: ask }, { text: 'a review that must not run' }], config: { ACTOR_LOOP_SELF_REFLECTIONS: '2' } });
        const out = await m.loop.run(runArgs(m));
        assert.strictEqual(out.text, ask);
        assert.strictEqual(m.events.filter((e) => e.step === 'text').length, 0, 'the question is said once, as the answer');
        await m.loop.close(out.state);
    });

    await ok('a reflection written out before a "Final answer" heading is the check, not the answer (2026-11-01)', async () => {
        const leaked = 'None of the claims in the existing draft are live facts, so no evidence is required, no tools need to be called.\n\n'
            + '**Claim-by-claim reflection**\n\nYour rule applies to:\n\n- Prices\n- Scores or standings\n\nThe draft I gave earlier only contains:\n\n- Descriptions of my capabilities\n\n'
            + 'Therefore:\n\n- There are **no claims that need tool-backed evidence or [E#] citations**.\n\n'
            + '**Final answer (unchanged in substance, now with your constraints in mind)**\n\n'
            + 'I can help you think, create, fix, and decide.\n\nIf you tell me what you are working on, I can start.';
        assert.strictEqual(withoutMeta(leaked), 'I can help you think, create, fix, and decide.\n\nIf you tell me what you are working on, I can start.');
        assert.match(splitCheck(leaked).check, /^None of the claims/);
        assert.match(splitCheck(leaked).check, /no claims that need tool-backed evidence/);
        // A heading named "Final answer" in an answer that has no check before it stays as it is.
        const plain = 'Here are the scores.\n\n## Final answer\nArsenal won 2–1 [E1].';
        assert.strictEqual(splitCheck(plain).text, plain);
        assert.strictEqual(splitCheck('Final answer: 42 [E1].').text, 'Final answer: 42 [E1].');
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

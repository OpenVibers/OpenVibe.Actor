'use strict';
/**
 * Sub-agents (Actor v2, stage V2-7) and the allow-list under them, against a scripted fake model and a fake registry:
 *   - only the tools a run was offered may run, whatever a model asks for;
 *   - `delegate` is offered in "best" mode only;
 *   - a sub-agent never gets more than its parent: the parent's tools at most, narrowed by the call, never `delegate`
 *     (depth 1), and it cannot call anything outside that (the Attenu rule: hand-offs must not widen authority);
 *   - its evidence joins the parent's ledger, renumbered, its answer's citations follow, and its report is not
 *     evidence;
 *   - at most 4 at once; its share of the budget and its cap on model calls stop it.
 */
const assert = require('assert');
const { createLoop, DELEGATE, MAX_SUB_AGENTS } = require('../server/runtime/loop');
const configLib = require('../server/config');

const results = [];
const ok = async (name, fn) => { try { await fn(); console.log(`  ✓ ${name}`); } catch (e) { results.push(e); console.log(`  ✗ ${name}\n      ${(e.stack || String(e)).split('\n').slice(0, 7).join('\n      ')}`); } };

let seq = 0;
const call = (name, args) => ({ id: `c${++seq}`, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const reply = ({ text = '', tools = [], cost = 0.0001 } = {}) => ({
    message: { role: 'assistant', content: text || null, ...(tools.length ? { tool_calls: tools } : {}) },
    text, toolCalls: tools, cost_usd: cost, model: 'fake-1', family: 'fake', provider: 'fake',
});
const isChild = (req) => String((req.messages[0] || {}).content || '').includes('You are a sub-agent');
const toolNames = (req) => (req.tools || []).map((t) => t.function.name);

function make({ parent, child, mode = 'best', config = {}, budget = 1 } = {}) {
    const chats = [];
    const ran = [];
    let p = 0;
    const c = new Map();
    const models = {
        resolve(tier) { return { tier, provider: 'fake', model: 'fake-1', family: 'fake', available: true }; },
        async chat(req) {
            chats.push({ ...req, messages: req.messages.map((m) => ({ ...m })) });
            if (req.tier === 'fast') return reply({ text: JSON.stringify({ assumptions: [], steps: [{ goal: 'Split the work' }, { goal: 'Answer' }] }) });
            if (isChild(req)) {
                const goal = String(req.messages[1].content).split('\n')[0];
                const n = c.get(goal) || 0; c.set(goal, n + 1);
                return reply(child(goal, n, req));
            }
            return reply(parent(p++, req));
        },
    };
    const registry = {
        definitions: () => ['lookup', 'fetch'].map((name) => ({ type: 'function', function: { name, description: name, parameters: { type: 'object', properties: {} } } })),
        run: async (name, input) => { ran.push({ name, input }); return { text: JSON.stringify({ name, input, value: 42 }), data: { name, input }, sources: [{ url: `https://example.org/${name}/${input.q || ''}`, title: name }] }; },
    };
    const cfg = configLib.load({ NODE_ENV: 'test', ACTOR_LOOP_SELF_REFLECTIONS: '0', ...config });
    const loop = createLoop({ config: cfg, models, registry, log: { warn() {}, log() {} } });
    let spent = 0;
    const events = [];
    const args = {
        task: 'Compare two things and answer', requester: 'user:usr_01JAB2C3D4E5F6G7H8J9K0MNPT', taskId: 'tsk_01JAB2C3D4E5F6G7H8J9K0MNPQ',
        mode, signal: undefined, emit: async (e) => events.push(e), meter: async (usd) => { spent += Number(usd) || 0; },
        budgetLeft: () => budget - spent,
    };
    return { loop, chats, ran, events, args, spent: () => spent };
}
const toolMessages = (chats) => {
    const last = chats.filter((r) => !isChild(r) && r.tier !== 'fast').pop();
    return last.messages.filter((m) => m.role === 'tool').map((m) => JSON.parse(m.content));
};

(async () => {
    await ok('only the tools a run was offered may run: any other name is refused, whatever its scope', async () => {
        const m = make({ mode: 'balanced', parent: (n) => (n === 0 ? { tools: [call('make_payment', { to: 'x' }), call('lookup', { q: 'a' })] } : { text: 'It is **42** [E1].' }) });
        const out = await m.loop.run(m.args);
        assert.deepStrictEqual(m.ran.map((r) => r.name), ['lookup'], 'make_payment never ran');
        const msgs = toolMessages(m.chats);
        assert.deepStrictEqual(msgs[0], { error: 'that tool is not offered for this task', tool: 'make_payment' });
        assert.strictEqual(out.evidence.length, 1, 'and it is no evidence');
    });

    await ok('delegate is offered in "best" mode only', async () => {
        const best = make({ parent: () => ({ text: 'Done.' }) });
        await best.loop.run(best.args);
        assert.ok(toolNames(best.chats.find((r) => r.tier !== 'fast')).includes('delegate'));
        const balanced = make({ mode: 'balanced', parent: () => ({ text: 'Done.' }) });
        await balanced.loop.run(balanced.args);
        assert.ok(!toolNames(balanced.chats.find((r) => r.tier !== 'fast')).includes('delegate'));
        const off = make({ config: { ACTOR_LOOP_SUB_AGENTS: '0' }, parent: () => ({ text: 'Done.' }) });
        await off.loop.run(off.args);
        assert.ok(!toolNames(off.chats.find((r) => r.tier !== 'fast')).includes('delegate'), 'and the operator can turn it off');
    });

    await ok('a sub-agent gets the parent\'s tools at most, narrowed by the call, never delegate, and cannot call past them', async () => {
        const m = make({
            parent: (n) => (n === 0 ? { tools: [call('delegate', { goal: 'Price of A', tools: ['lookup', 'make_payment', 'delegate'] })] } : { text: 'A costs **42** [E1].' }),
            child: (goal, n) => (n === 0 ? { tools: [call('fetch', { q: 'A' }), call('delegate', { goal: 'deeper' }), call('make_payment', { to: 'x' }), call('lookup', { q: 'A' })] } : { text: 'A is 42 [E1].' }),
        });
        await m.loop.run(m.args);
        const childReq = m.chats.find(isChild);
        assert.deepStrictEqual(toolNames(childReq), ['lookup'], 'only lookup: make_payment is not the parent\'s, delegate is never a child\'s, fetch was not asked for');
        assert.deepStrictEqual(m.ran.map((r) => r.name), ['lookup'], 'fetch, delegate and make_payment were refused inside the child');
        const childTools = m.chats.filter(isChild).pop().messages.filter((x) => x.role === 'tool').map((x) => JSON.parse(x.content));
        assert.deepStrictEqual(childTools.slice(0, 3).map((x) => x.error), ['that tool is not offered for this task', 'that tool is not offered for this task', 'that tool is not offered for this task']);
    });

    await ok('its evidence joins the parent\'s ledger renumbered, its citations follow, and its report is not evidence', async () => {
        const m = make({
            parent: (n) => (n === 0 ? { tools: [call('lookup', { q: 'mine' })] }
                : n === 1 ? { tools: [call('delegate', { goal: 'Price of B' })] }
                    : { text: 'Mine is 42 [E1] and B is 42 [E2].' }),
            child: (goal, n) => (n === 0 ? { tools: [call('lookup', { q: 'B' })] } : { text: 'B is **42** [E1].' }),
        });
        const out = await m.loop.run(m.args);
        assert.deepStrictEqual(out.evidence.map((e) => [e.id, e.tool]), [['E1', 'lookup'], ['E2', 'lookup']], 'two items: the parent\'s and the child\'s, renumbered; no delegate item');
        assert.ok(out.evidence[1].sources[0].url.endsWith('/lookup/B'), 'the child\'s item is what its tool returned');
        const report = toolMessages(m.chats).find((x) => x.sub_agent);
        assert.deepStrictEqual([report.answer, report.evidence], ['B is **42** [E2].', ['E2']], 'the report cites the parent\'s new id');
        assert.deepStrictEqual(out.citations, ['E1', 'E2']);
        const shown = m.events.filter((e) => e.tool === 'delegate');
        assert.deepStrictEqual(shown.map((e) => e.step), ['tool_call', 'tool_result'], 'one step on the page');
        assert.ok(/^Sub-agent: 2 steps, 1 finding\. B is/.test(shown[1].text));
    });

    await ok(`at most ${MAX_SUB_AGENTS} sub-agents at once`, async () => {
        const m = make({
            parent: (n) => (n === 0 ? { tools: ['a', 'b', 'c', 'd', 'e'].map((g) => call('delegate', { goal: `Part ${g}` })) } : { text: 'Done.' }),
            child: () => ({ text: 'Nothing found.' }),
        });
        await m.loop.run(m.args);
        const childGoals = new Set(m.chats.filter(isChild).map((r) => String(r.messages[1].content).split('\n')[0]));
        assert.strictEqual(childGoals.size, MAX_SUB_AGENTS, 'four ran');
        assert.ok(toolMessages(m.chats).some((x) => /at most 4 sub-agents at once/.test(x.error || '')), 'the fifth is told to wait for the next turn');
    });

    await ok('its share of the budget, and its cap on model calls, stop it; its cost is the task\'s', async () => {
        // Budget 1.0, share 0.25: the child stops once its calls cost 0.25, then answers from what it has.
        const m = make({
            config: { ACTOR_LOOP_SUB_AGENT_SHARE: '0.25', ACTOR_LOOP_SUB_AGENT_CALLS: '50' },
            parent: (n) => (n === 0 ? { tools: [call('delegate', { goal: 'Dig' })] } : { text: 'Done.' }),
            child: (goal, n) => ({ tools: [call('lookup', { q: `dig ${n}` })], cost: 0.1 }),
        });
        await m.loop.run(m.args);
        const childCalls = m.chats.filter(isChild).length;
        assert.ok(childCalls >= 3 && childCalls <= 4, `three model calls reach the share, then one answer (${childCalls})`);
        assert.ok(m.spent() >= 0.3 && m.spent() < 0.5, `the child's cost is metered into the task (${m.spent()})`);

        const capped = make({
            config: { ACTOR_LOOP_SUB_AGENT_CALLS: '2' },
            parent: (n) => (n === 0 ? { tools: [call('delegate', { goal: 'Dig' })] } : { text: 'Done.' }),
            child: (goal, n) => ({ tools: [call('lookup', { q: `dig ${n}` })] }),
        });
        await capped.loop.run(capped.args);
        assert.strictEqual(capped.chats.filter(isChild).length, 3, 'two steps, then the answer from what it found');
    });

    if (results.length) { console.log(`\n${results.length} failed`); process.exit(1); }
    console.log('\nall passed');
})().catch((e) => { console.error(e); process.exit(1); });

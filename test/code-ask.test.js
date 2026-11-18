'use strict';
/**
 * ask(question, data) in a code-mode script (plan §AD.26): a small model boils a long result down inside the script.
 * The answer goes back to the script and is shown and metered like any call; it is never evidence.
 */
const assert = require('assert');

const results = [];
async function ok(name, fn) {
    try { await fn(); console.log(`  ✓ ${name}`); } catch (err) { results.push(name); console.log(`  ✗ ${name}\n    ${err && err.stack}`); }
}

(async () => {
    console.log('code-ask: a script asks a small model about its own data');

    await ok('a script reads a long result, asks about it, and returns only the answer; the ask is metered, shown and no evidence', async () => {
        const { createLoop } = require('../server/runtime/loop');
        const configLib = require('../server/config');
        const chats = [];
        const metered = [];
        let n = 0;
        const r = (x) => ({ message: { role: 'assistant', content: x.text || null, ...(x.tools ? { tool_calls: x.tools } : {}) }, text: x.text || '', toolCalls: x.tools || [], cost_usd: x.cost || 0.0001, model: 'fake-1', provider: 'fake', usage: { input: 10, output: 10 } });
        const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
        const JOBS = Array.from({ length: 40 }, (_, i) => ({ title: `Job ${i}`, remote: i % 10 === 0, blurb: 'z'.repeat(200) }));
        const models = {
            resolve: (tier) => ({ tier, provider: 'fake', model: 'fake-1', family: 'fake', available: true }),
            async chat(req) {
                chats.push({ ...req, messages: req.messages.map((m) => ({ ...m })) });
                const sys = (req.messages.find((m) => m.role === 'system') || {}).content || '';
                if (/answer one question about the data you are given/.test(sys)) {
                    assert.match(req.messages[1].content, /^Which jobs are remote\?\n\nThe data:\n\[\{"title":"Job 0"/);
                    return r({ text: 'Job 0, Job 10, Job 20 and Job 30 are remote.', cost: 0.0002 });
                }
                if (req.tier === 'fast') return r({ text: JSON.stringify({ assumptions: [], steps: [{ goal: 'Look' }, { goal: 'Answer' }] }) });
                n += 1;
                if (n === 1) return r({ tools: [call('c1', 'tools_code', { code: 'const page = await tools.jobs({ q: "design" }); const gist = await ask("Which jobs are remote?", page); return { count: page.length, gist };' })] });
                return r({ text: 'Four of the forty are remote [E1].' });
            },
        };
        const DEFS = [
            { type: 'function', function: { name: 'jobs', description: 'Search job listings.', parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] } } },
            { type: 'function', function: { name: 'calculate', description: 'Work out a sum.', parameters: { type: 'object', properties: { expr: { type: 'string' } } } } },
        ];
        const registry = { definitions: () => DEFS, get: () => ({ acts: false, scope: 'public' }), run: async (name) => ({ text: JSON.stringify(JOBS) }) };
        const loop = createLoop({ config: configLib.load({ NODE_ENV: 'test', ACTOR_LOOP_SELF_REFLECTIONS: '0' }), models, registry, log: { warn() {}, log() {} } });
        const events = [];
        await loop.run({ task: 'Which design jobs are remote?', requester: 'user:usr_01JAB2C3D4E5F6G7H8J9K0MNPT', taskId: 'tsk_01JAB2C3D4E5F6G7H8J9K0MNPQ', mode: 'balanced', emit: async (e) => events.push(e), meter: async (usd) => metered.push(usd), budgetLeft: () => 1, codeMode: true });
        const work = chats.filter((c) => c.tier !== 'fast');
        const scripted = JSON.parse(JSON.parse(work[1].messages.filter((m) => m.role === 'tool').pop().content).result);
        assert.deepStrictEqual(scripted.result, { count: 40, gist: 'Job 0, Job 10, Job 20 and Job 30 are remote.' }, 'only the answer comes back, not forty listings');
        assert.deepStrictEqual(scripted.evidence.length, 1, 'the listing is evidence; the ask is not');
        assert.ok(metered.includes(0.0002), 'the ask is metered');
        assert.deepStrictEqual(events.filter((e) => e.step === 'tool_call').map((e) => [e.tool, e.call_id]), [['jobs', 'c1.1'], ['ask', 'c1.2'], ['tools_code', 'c1']], 'the ask is shown in the script\'s calls');
        assert.ok(work[1].messages.filter((m) => m.role === 'tool').pop().content.length < 2000, 'the run\'s context holds the answer, not the page');
    });

    await ok('without budget the ask refuses in words; the script can carry on', async () => {
        const CODE = require('../server/runtime/code-mode');
        const out = await CODE.runCode('let said; try { said = await ask("x", [1]); } catch (e) { said = "refused: " + e.message; } return said;', { names: [], call: async () => ({ ok: true, value: 1 }), onAsk: async () => ({ ok: false, error: 'the task\'s budget is spent' }) });
        assert.deepStrictEqual([out.ok, out.value], [true, 'refused: the task\'s budget is spent']);
        const none = await CODE.runCode('return typeof ask;', { names: [], call: async () => ({ ok: true, value: 1 }) });
        assert.strictEqual(none.value, 'undefined', 'no onAsk: no ask in the script');
    });

    console.log(results.length ? `\n${results.length} failed` : '\nall passed');
    process.exit(results.length ? 1 : 0);
})();

'use strict';
/**
 * Context editing (plan §AD.26, server/runtime/context-edit.js): a long run's model calls are sent older tool results cut
 * to an excerpt, the most recent ones whole; the run's own messages and evidence are never changed.
 */
const assert = require('assert');
const { contextView } = require('../server/runtime/context-edit');

const results = [];
async function ok(name, fn) {
    try { await fn(); console.log(`  ✓ ${name}`); } catch (err) { results.push(name); console.log(`  ✗ ${name}\n    ${err && err.stack}`); }
}

const toolMsg = (i, chars) => ({ role: 'tool', tool_call_id: `c${i}`, content: JSON.stringify({ evidence: `E${i}`, tool: 'read_page', result: `page ${i}: ${'x'.repeat(chars)}` }) });
const asked = (i) => ({ role: 'assistant', content: null, tool_calls: [{ id: `c${i}`, type: 'function', function: { name: 'read_page', arguments: '{}' } }] });

(async () => {
    console.log('context-edit: older tool results cut once a run is long');

    await ok('short: the same array, nothing cut', async () => {
        const m = [{ role: 'system', content: 'sys' }, { role: 'user', content: 'go' }, asked(1), toolMsg(1, 5000)];
        const v = contextView(m);
        assert.strictEqual(v.messages, m);
        assert.deepStrictEqual([v.cleared, v.savedChars], [0, 0]);
    });

    await ok('long: all but the eight most recent results cut, each with its evidence named; the input untouched', async () => {
        const m = [{ role: 'system', content: 'sys' }, { role: 'user', content: 'go' }];
        for (let i = 1; i <= 12; i++) m.push(asked(i), toolMsg(i, 6000));
        const before = JSON.stringify(m);
        const v = contextView(m);
        assert.strictEqual(JSON.stringify(m), before, 'the run\'s own messages are never changed');
        assert.strictEqual(v.cleared, 4);
        const tools = v.messages.filter((x) => x.role === 'tool').map((x) => JSON.parse(x.content));
        for (const t of tools.slice(0, 4)) {
            assert.strictEqual(t.cleared, true);
            assert.match(t.result, new RegExp(`^page ${t.evidence.slice(1)}: x{290,}… \\[cut to save room: 60\\d\\d characters; ${t.evidence} keeps all of it and can be cited; call the tool again for the rest\\]$`));
        }
        for (const t of tools.slice(4)) assert.strictEqual(t.result.length > 6000 && !t.cleared, true, 'the recent ones whole');
        assert.ok(v.savedChars > 4 * 5000, `saved ${v.savedChars}`);
        assert.deepStrictEqual(v.messages.filter((x) => x.role === 'assistant').map((x) => x.tool_calls[0].id), m.filter((x) => x.role === 'assistant').map((x) => x.tool_calls[0].id), 'every call keeps its result');
        // Cutting again changes nothing more; small results and errors are left as they are.
        assert.strictEqual(contextView(v.messages).cleared, 0);
        const small = [...m.slice(0, 2), asked(1), { role: 'tool', tool_call_id: 'c1', content: JSON.stringify({ error: 'no', tool: 'x' }) }, ...m.slice(2)];
        assert.strictEqual(JSON.parse(contextView(small).messages[3].content).error, 'no');
        // Off: a trigger of 0.
        assert.strictEqual(contextView(m, { triggerChars: 0 }).messages, m);
    });

    await ok('in a run: a long run\'s later calls carry the older results cut and the eight most recent whole', async () => {
        const { createLoop } = require('../server/runtime/loop');
        const configLib = require('../server/config');
        const chats = [];
        let n = 0;
        const r = (x) => ({ message: { role: 'assistant', content: x.text || null, ...(x.tools ? { tool_calls: x.tools } : {}) }, text: x.text || '', toolCalls: x.tools || [], cost_usd: 0.0001, model: 'fake-1', provider: 'fake', usage: { input: 10, output: 10 } });
        const call = (id, args) => ({ id, type: 'function', function: { name: 'read_page', arguments: JSON.stringify(args) } });
        const models = {
            resolve: (tier) => ({ tier, provider: 'fake', model: 'fake-1', family: 'fake', available: true }),
            async chat(req) {
                chats.push({ ...req, messages: req.messages.map((m) => ({ ...m })) });
                if (req.tier === 'fast') return r({ text: JSON.stringify({ assumptions: [], steps: [{ goal: 'Read' }, { goal: 'Answer' }] }) });
                n += 1;
                if (n <= 12) return r({ tools: [call(`c${n}`, { url: `https://example.com/${n}` })] });
                return r({ text: 'Page 1 says x [E1].' });
            },
        };
        const DEFS = [{ type: 'function', function: { name: 'read_page', description: 'Read a page.', parameters: { type: 'object', properties: { url: { type: 'string' } } } } }];
        const registry = { definitions: () => DEFS, get: () => ({ acts: false, scope: 'public' }), run: async (name, input) => ({ text: `${input.url}: ${'y'.repeat(5800)}` }) };
        const loop = createLoop({ config: configLib.load({ NODE_ENV: 'test', ACTOR_LOOP_SELF_REFLECTIONS: '0' }), models, registry, log: { warn() {}, log() {} } });
        await loop.run({ task: 'Read twelve pages', requester: 'user:usr_01JAB2C3D4E5F6G7H8J9K0MNPT', taskId: 'tsk_01JAB2C3D4E5F6G7H8J9K0MNPQ', mode: 'balanced', emit: async () => {}, meter: async () => {}, budgetLeft: () => 1 });
        const work = chats.filter((c) => c.tier !== 'fast');
        const last = work[work.length - 1];
        const sent = last.messages.filter((m) => m.role === 'tool').map((m) => JSON.parse(m.content));
        assert.ok(sent.length >= 12, `${sent.length} results sent`);
        assert.ok(sent.slice(0, -8).every((t) => t.cleared === true && /cut to save room/.test(t.result)), 'the older ones cut');
        assert.ok(sent.slice(-8).every((t) => !t.cleared), 'the eight most recent whole');
        const size = (c) => c.messages.reduce((x, m) => x + (typeof m.content === 'string' ? m.content.length : 0), 0);
        assert.ok(size(last) < 70000, `the last call sent ${size(last)} characters, not every page whole`);
    });

    console.log(results.length ? `\n${results.length} failed` : '\nall passed');
    process.exit(results.length ? 1 : 0);
})();

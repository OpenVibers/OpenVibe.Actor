'use strict';
/**
 * The Design specialist (plan §AD.25; the owner, 2026-11-17: "create a Design bot as a default next to Actor and Codes
 * which is interconnected with all our design tools"): Actor's own loop with Design's brief and tools.
 *   • the engine takes { kind: 'agent', specialist: 'design' } and nothing else takes a specialist;
 *   • the brief holds the review checklist and the rules of the design areas, one line a rule, from openvibe.design;
 *   • the tools are design_rules (a rule's detail by id or words) and Design's MCP tools, each called on Design;
 *   • the rules and tool list are read once in ten minutes; Design not answering leaves a working brief that says so;
 *   • in a run, the system message carries the brief and the model is offered and can call the tools.
 *   node test/specialist-design.test.js
 */
const assert = require('assert');
const { createSpecialists } = require('../server/specialists');
const engines = require('../server/engines');
const { createLoop } = require('../server/runtime/loop');
const configLib = require('../server/config');

const results = [];
const ok = async (name, fn) => { try { await fn(); console.log(`  ✓ ${name}`); } catch (e) { results.push(e); console.log(`  ✗ ${name}\n      ${(e.stack || e).toString().split('\n').slice(0, 6).join('\n      ')}`); } };

const RULES = {
    count: 4, updated: '2026-11-17',
    rules: [
        { id: 'no-fake-content', area: 'honest', rule: 'Never show content that is not real.', detail: 'No sample rows.', why: 'Pages looked full and said nothing.', url: 'https://openvibe.design/rules#no-fake-content' },
        { id: 'targets-44', area: 'phone', rule: 'Touch targets are at least 44 px.', detail: 'Measured on the element.', url: 'https://openvibe.design/rules#targets-44' },
        { id: 'mark-for-waiting', area: 'motion', rule: 'Waiting uses the OpenVibe mark, never a spinner.', url: 'https://openvibe.design/rules#mark-for-waiting' },
        { id: 'one-db-per-service', area: 'building', rule: 'Each service owns its own database.', url: 'https://openvibe.design/rules#one-db-per-service' },
    ],
};
const TOOLS = [
    { name: 'openvibe_design_icon_search', description: 'Find OpenVibe icons.', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }, annotations: { readOnlyHint: true } },
    { name: 'openvibe_design_make_vector', description: 'Make a vector.', inputSchema: { type: 'object', properties: {} } },
    { name: 'Bad Name!', description: 'dropped' },
];

function fakes({ down = false } = {}) {
    const asked = { rules: 0, list: 0, calls: [] };
    let t = 1_000_000;
    const s = createSpecialists({
        log: { warn() {} }, now: () => t,
        fetchJson: async (url) => { asked.rules++; assert.strictEqual(url, 'https://openvibe.design/api/v1/rules'); if (down) throw new Error('ECONNREFUSED'); return RULES; },
        listTools: async (conn) => { asked.list++; assert.strictEqual(conn.url, 'https://openvibe.design/mcp'); if (down) throw new Error('ECONNREFUSED'); return TOOLS; },
        callTool: async (conn, name, args) => { asked.calls.push([name, args]); return { text: JSON.stringify({ icons: [{ name: 'gear' }] }), isError: false }; },
    });
    return { s, asked, later: (ms) => { t += ms; } };
}

(async () => {
    await ok('the agent engine takes the design specialist; no other engine does', async () => {
        assert.deepStrictEqual(engines.parseEngine({ kind: 'agent', specialist: 'design' }), { engine: { kind: 'agent', specialist: 'design' } });
        assert.match(engines.parseEngine({ kind: 'harness', harness: 'codex', specialist: 'design' }).error, /only the agent engine/);
        assert.match(engines.parseEngine({ kind: 'agent', specialist: 'chef' }).error, /one of design/);
        assert.strictEqual(engines.label({ kind: 'agent', specialist: 'design' }), 'Design');
    });

    await ok('the brief: the review checklist and the design areas\' rules, one line a rule', async () => {
        const { s } = fakes();
        const b = await s.brief('design');
        assert.match(b, /^You are Design, OpenVibe's designer/);
        assert.match(b, /touch targets at least 44 px/);
        assert.match(b, /OpenVibe's design rules \(3 of 4, updated 2026-11-17/);
        assert.match(b, /- no-fake-content: Never show content that is not real\./);
        assert.match(b, /- mark-for-waiting: Waiting uses the OpenVibe mark/);
        assert.ok(!/one-db-per-service/.test(b), 'an engineering rule is not a reviewer\'s');
        assert.strictEqual(await s.brief('chef'), '');
    });

    await ok('the tools: design_rules and Design\'s MCP tools (a bad name dropped), each answered by Design', async () => {
        const { s, asked } = fakes();
        const t = await s.tools('design');
        assert.deepStrictEqual(t.definitions.map((d) => d.function.name), ['design_rules', 'openvibe_design_icon_search', 'openvibe_design_make_vector']);
        const rules = await t.byAlias.get('design_rules').run({ query: 'touch targets' });
        assert.deepStrictEqual(JSON.parse(rules.text).rules.map((r) => r.id), ['targets-44']);
        const byId = JSON.parse((await t.byAlias.get('design_rules').run({ query: 'no-fake-content' })).text).rules[0];
        assert.deepStrictEqual([byId.id, byId.why], ['no-fake-content', 'Pages looked full and said nothing.']);
        const icon = await t.byAlias.get('openvibe_design_icon_search').run({ query: 'settings' });
        assert.deepStrictEqual(asked.calls, [['openvibe_design_icon_search', { query: 'settings' }]]);
        assert.match(icon.text, /gear/);
        assert.deepStrictEqual([t.byAlias.get('openvibe_design_icon_search').acts, t.byAlias.get('openvibe_design_make_vector').acts], [false, true], 'a read is no act; making is');
        assert.deepStrictEqual((await s.tools('chef')).definitions, []);
    });

    await ok('read once in ten minutes; Design down leaves a brief that says the rules were not checked', async () => {
        const { s, asked, later } = fakes();
        await s.brief('design'); await s.tools('design'); await s.brief('design'); await s.tools('design');
        assert.deepStrictEqual([asked.rules, asked.list], [1, 1]);
        later(11 * 60 * 1000);
        await s.brief('design');
        assert.strictEqual(asked.rules, 2, 'asked again after ten minutes');
        const down = fakes({ down: true });
        assert.match(await down.s.brief('design'), /The rules register did not answer just now/);
        const t = await down.s.tools('design');
        assert.deepStrictEqual(t.definitions.map((d) => d.function.name), ['design_rules'], 'the rules tool stays');
        assert.ok((await t.byAlias.get('design_rules').run({ query: 'x' })).isError);
        await down.s.brief('design');
        assert.strictEqual(down.asked.rules, 1, 'not asked again on the next turn');
    });

    await ok('in a run: the system message carries the brief, the model is offered the tools and calls one', async () => {
        const { s, asked } = fakes();
        const chats = [];
        let n = 0;
        const models = {
            resolve: (tier) => ({ tier, provider: 'fake', model: 'fake-1', family: 'fake', available: true }),
            async chat(req) {
                chats.push({ ...req, messages: req.messages.map((m) => ({ ...m })) });
                const r = (x) => ({ message: { role: 'assistant', content: x.text || null, ...(x.tools ? { tool_calls: x.tools } : {}) }, text: x.text || '', toolCalls: x.tools || [], cost_usd: 0.0001, model: 'fake-1', family: 'fake', provider: 'fake' });
                if (req.tier === 'fast') return r({ text: JSON.stringify({ assumptions: [], steps: [{ goal: 'Look' }, { goal: 'Answer' }] }) });
                n += 1;
                if (n === 1) return r({ text: 'Checking the icon.', tools: [{ id: 'c1', type: 'function', function: { name: 'openvibe_design_icon_search', arguments: JSON.stringify({ query: 'settings' }) } }] });
                return r({ text: 'Use the gear glyph.\nAPPROVED' });
            },
        };
        // As the real registry (server/runtime/tools): a run's dynamic tool is run by its own module.
        const registry = { definitions: () => [], run: async (name, input, ctx) => { const d = ctx && ctx.dynamicTools && ctx.dynamicTools.get(name); return d ? d.run(input, ctx) : { text: '{}' }; } };
        const loop = createLoop({ config: configLib.load({ NODE_ENV: 'test', ACTOR_LOOP_SELF_REFLECTIONS: '0' }), models, registry, log: { warn() {}, log() {} }, specialists: s });
        const events = [];
        const out = await loop.run({ task: 'Review the settings icon', requester: 'user:usr_01JAB2C3D4E5F6G7H8J9K0MNPT', taskId: 'tsk_01JAB2C3D4E5F6G7H8J9K0MNPQ', mode: 'balanced', emit: async (e) => events.push(e), meter: async () => {}, budgetLeft: () => 1, specialist: 'design' });
        const work = chats.filter((c) => c.tier !== 'fast');
        const sys = work[0].messages.find((m) => m.role === 'system').content;
        assert.match(sys, /You are Design, OpenVibe's designer/);
        assert.match(sys, /- targets-44: Touch targets are at least 44 px\./);
        assert.ok(work[0].tools.some((t) => t.function.name === 'design_rules') && work[0].tools.some((t) => t.function.name === 'openvibe_design_icon_search'), 'offered');
        assert.deepStrictEqual(asked.calls, [['openvibe_design_icon_search', { query: 'settings' }]], 'called on Design');
        assert.match(out.text, /gear glyph/);
        await loop.close(out.state);

        // Without a specialist: no brief and no Design tools.
        chats.length = 0; n = 0;
        const plain = await loop.run({ task: 'Review the settings icon', requester: 'user:usr_01JAB2C3D4E5F6G7H8J9K0MNPT', taskId: 'tsk_01JAB2C3D4E5F6G7H8J9K0MNPR', mode: 'balanced', emit: async () => {}, meter: async () => {}, budgetLeft: () => 1 });
        const w2 = chats.filter((c) => c.tier !== 'fast');
        assert.ok(!/You are Design/.test(w2[0].messages.find((m) => m.role === 'system').content));
        assert.ok(!(w2[0].tools || []).some((t) => t.function.name === 'design_rules'));
        await loop.close(plain.state);
    });

    console.log(results.length ? `\n${results.length} failed` : '\nall passed');
    process.exit(results.length ? 1 : 0);
})();

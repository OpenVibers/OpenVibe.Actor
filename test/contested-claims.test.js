'use strict';
/**
 * Contested claims (Actor v2, stage V2-7b): the check marks a supported claim whose evidence items disagree; in "best"
 * mode one judgement lays out the sides with their evidence and picks the better-supported one (or says it cannot be
 * settled); only ids from the run survive; the task page shows the sides; no other mode spends on it.
 */
const assert = require('assert');
const { adjudicate } = require('../server/runtime/adjudicate');
const { boot, check, done } = require('./helpers/boot');

const evidence = [
    { id: 'E1', tool: 'read_page', text: 'OVH VPS-1: €7.60 a month', sources: [{ url: 'https://www.ovhcloud.com/en/vps/' }], at: '2026-10-30T10:00:00Z' },
    { id: 'E2', tool: 'search_web', text: 'A 2025 review lists OVH VPS-1 at €5.50', sources: [{ url: 'https://reviews.example/ovh' }], at: '2026-10-30T10:01:00Z' },
];
const fakeModels = (text, seen = []) => ({
    resolve: () => ({ available: true }),
    chat: async (req) => { seen.push(req); return { text, cost_usd: 0.0007, family: 'openai', model: 'fake-best' }; },
});

(async () => {
    await check('the judgement lays out the sides with their evidence and picks the better-supported one', async () => {
        const seen = [];
        const j = await adjudicate({
            claim: { claim: 'OVH VPS-1 costs €7.60 a month', evidence: ['E1', 'E2'], contested: true },
            evidence, task: 'Compare VPS prices', writerFamily: 'deepseek',
            models: fakeModels(JSON.stringify({ sides: [{ says: '€7.60 a month', evidence: ['E1'] }, { says: '€5.50 a month', evidence: ['E2', 'E9'] }], pick: 0, reason: 'The provider\'s own page is the primary source and is current.' }), seen),
        });
        assert.deepStrictEqual(j.sides, [{ says: '€7.60 a month', evidence: ['E1'] }, { says: '€5.50 a month', evidence: ['E2'] }], 'an id the run does not have is dropped');
        assert.strictEqual(j.pick, 0);
        assert.match(j.reason, /primary source/);
        assert.strictEqual(seen[0].avoidFamily, 'deepseek', 'judged by another family than the writer');
        assert.ok(seen[0].messages[1].content.includes('[E1] read_page'), 'it reads the evidence, not memory');
    });

    await check('a judgement that cannot settle it says so; a broken one is no judgement', async () => {
        const unclear = await adjudicate({
            claim: { claim: 'x', evidence: ['E1', 'E2'] }, evidence,
            models: fakeModels(JSON.stringify({ sides: [{ says: 'a', evidence: ['E1'] }, { says: 'b', evidence: ['E2'] }], pick: null, reason: 'A dated price list from OVH would settle it.' })),
        });
        assert.strictEqual(unclear.pick, null);
        const broken = await adjudicate({ claim: { claim: 'x', evidence: ['E1', 'E2'] }, evidence, models: fakeModels('not json') });
        assert.ok(broken.failed && !broken.sides.length);
        assert.strictEqual(await adjudicate({ claim: { claim: 'x', evidence: ['E1'] }, evidence: [evidence[0]], models: fakeModels('{}') }), null, 'one item is not a disagreement');
    });

    const t = await boot();
    const kim = t.network.addUser('kim');
    const SAME = { 'sec-fetch-site': 'same-origin' };
    try {
        await check('"best" mode weighs contested claims and the page shows both sides; other modes never spend on it', async () => {
            t.config.loop.selfReflections = 0;
            // The writer answers; the check marks the price contested; the judgement picks the provider's page.
            t.providers.reset();
            t.providers.state.script = [
                { content: 'Reading two places.', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'calculate', arguments: JSON.stringify({ expression: '7.6' }) } }, { id: 'c2', type: 'function', function: { name: 'calculate', arguments: JSON.stringify({ expression: '5.5' }) } }] },
                { content: 'OVH VPS-1 is about €7.60 [E1], one review says €5.50 [E2].' },
            ];
            t.providers.state.checkClaims = () => [{ claim: 'OVH VPS-1 costs €7.60', kind: 'live', evidence: ['E1', 'E2'], supported: true, contested: true }];
            t.providers.state.judge = JSON.stringify({ sides: [{ says: '€7.60 a month', evidence: ['E1'] }, { says: '€5.50 a month', evidence: ['E2'] }], pick: 0, reason: 'The first is the provider’s own figure.' });
            const best = (await t.get('/api/v1/tasks', { as: kim, json: { task: 'OVH VPS-1 price?', mode: 'best' }, headers: SAME })).json();
            await t.waitFor(best.id);
            const task = (await t.get(`/api/v1/tasks/${best.id}`, { as: kim })).json();
            assert.strictEqual(task.state, 'succeeded', JSON.stringify(task.error));
            assert.ok(Array.isArray(task.result.contested) && task.result.contested.length === 1, JSON.stringify(task.result.contested));
            assert.strictEqual(task.result.contested[0].pick, 0);
            const page = (await t.get(`/tasks/${best.id}`, { as: kim })).text;
            assert.ok(page.includes('Sources disagree on 1 point'), 'the card');
            assert.ok(page.includes('<li class="is-pick"><span class="ct-says">€7.60 a month</span>'), 'the better-supported side is marked');

            t.providers.reset();
            t.providers.state.script = [
                { content: 'Reading two places.', tool_calls: [{ id: 'c3', type: 'function', function: { name: 'calculate', arguments: JSON.stringify({ expression: '7.6' }) } }, { id: 'c4', type: 'function', function: { name: 'calculate', arguments: JSON.stringify({ expression: '5.5' }) } }] },
                { content: 'OVH VPS-1 is about €7.60 [E1], one review says €5.50 [E2].' },
            ];
            t.providers.state.checkClaims = () => [{ claim: 'OVH VPS-1 costs €7.60', kind: 'live', evidence: ['E1', 'E2'], supported: true, contested: true }];
            const balanced = (await t.get('/api/v1/tasks', { as: kim, json: { task: 'OVH VPS-1 price, again?' }, headers: SAME })).json();
            await t.waitFor(balanced.id);
            const plain = (await t.get(`/api/v1/tasks/${balanced.id}`, { as: kim })).json();
            assert.strictEqual(plain.state, 'succeeded');
            assert.ok(!plain.result.contested, 'no judgement outside "best" mode');
        });
    } finally {
        await t.close();
    }
    done();
})().catch((e) => { console.error(e && e.stack || e); process.exit(1); });

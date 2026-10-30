'use strict';
/**
 * GET /api/v1/agents is a contract: actor.agent-list-result@2 (OpenVibe.Contracts v0.248.0). Every @1 field keeps its
 * place for one version; v2 adds the model each tier resolves to and the models the server's keys reach. The old @1
 * forbids extra properties, so the new answer is exactly why a v2 exists — and it must not validate as @1.
 */
const assert = require('assert');
const contracts = require('openvibe-contracts');
const { boot, check, done } = require('./helpers/boot');

const V1_AGENT = ['id', 'name', 'kind', 'provider', 'trust', 'can', 'rate_card', 'available'];

(async () => {
    const t = await boot();
    try {
        const res = await t.get('/api/v1/agents');
        const body = res.json();

        await check('the answer is actor.agent-list-result@2 and validates', () => {
            assert.strictEqual(res.status, 200);
            assert.deepStrictEqual(contracts.validate('actor.agent-list-result@2', body).errors, []);
            assert.ok(contracts.catalog, 'the pin carries a catalog');
        });

        await check('every @1 field is still there, with its meaning; an @1-shaped answer still validates as @1', () => {
            assert.ok(Array.isArray(body.agents) && body.agents.length >= 4);
            for (const a of body.agents) for (const k of V1_AGENT) assert.ok(k in a, `${a.id} lost ${k}`);
            const old = { agents: body.agents };
            assert.deepStrictEqual(contracts.validate('actor.agent-list-result@1', old).errors, []);
            // The whole v2 answer is not a v1 result: v1 forbids extras, which is what a new version is for.
            assert.notDeepStrictEqual(contracts.validate('actor.agent-list-result@1', body).errors, []);
        });

        await check('five tiers, each naming its provider, model, family and availability; smart is never a mini', () => {
            assert.deepStrictEqual(Object.keys(body.tiers).sort(), ['best', 'check', 'fast', 'smart', 'vision']);
            for (const [tier, d] of Object.entries(body.tiers)) {
                for (const k of ['provider', 'model', 'family', 'available']) assert.ok(k in d, `${tier} has no ${k}`);
                assert.strictEqual(typeof d.available, 'boolean', tier);
                if (d.available) assert.ok(d.model, `${tier} is available but names no model`);
            }
            assert.strictEqual(body.tiers.smart.available, true);
            assert.strictEqual(body.tiers.smart.provider, 'openai');
            assert.strictEqual(body.tiers.smart.model, 'gpt-5.1');
            assert.ok(!/mini|nano|flash/i.test(body.tiers.smart.model), `smart resolved to ${body.tiers.smart.model}`);
            assert.ok(!/mini|nano|flash/i.test(body.tiers.best.model), `best resolved to ${body.tiers.best.model}`);
            assert.strictEqual(body.tiers.fast.model, 'gpt-5-nano');
        });

        await check('the check tier is another family from the writer', () => {
            assert.strictEqual(body.tiers.check.provider, 'deepseek');
            assert.strictEqual(body.tiers.check.model, 'deepseek-reasoner');
            assert.notStrictEqual(body.tiers.check.family, body.tiers.smart.family);
        });

        await check('models lists what the keys reach, provider:model, including every tier\'s own model', () => {
            assert.ok(Array.isArray(body.models) && body.models.length >= 3);
            const ids = body.models.map((m) => `${m.provider}:${m.model}`);
            assert.ok(new Set(ids).size === ids.length, 'no duplicates');
            for (const d of Object.values(body.tiers)) if (d.available) assert.ok(ids.includes(`${d.provider}:${d.model}`), `${d.provider}:${d.model} missing`);
            for (const m of body.models) assert.ok(m.provider && m.model && m.family);
        });

        await check('the contract rejects a tier on an unknown provider and any extra field', () => {
            const bad = JSON.parse(JSON.stringify(body));
            bad.tiers.smart.provider = 'somebody';
            assert.notDeepStrictEqual(contracts.validate('actor.agent-list-result@2', bad).errors, []);
            const extra = JSON.parse(JSON.stringify(body));
            extra.extra = true;
            assert.notDeepStrictEqual(contracts.validate('actor.agent-list-result@2', extra).errors, []);
        });
    } finally { await t.close(); }
    done();
})().catch((e) => { console.error(e); process.exit(1); });

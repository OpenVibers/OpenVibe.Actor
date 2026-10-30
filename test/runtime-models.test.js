'use strict';
/**
 * The tiered model layer (Actor v2): tiers from config, or the strongest model each configured key offers from its
 * own /models list, ranked by a dated preference list. Never a mini model for smart while a stronger one exists.
 * Cost is usage × the rate card, as before.
 */
const assert = require('assert');
const { createModels, PREFERRED_CHECKED } = require('../server/runtime/models');
const configLib = require('../server/config');
const { RATES } = require('../server/agents/catalog');

const results = [];
const ok = async (name, fn) => { try { await fn(); console.log(`  ✓ ${name}`); } catch (e) { results.push(e); console.log(`  ✗ ${name}\n      ${(e.stack || String(e)).split('\n').slice(0, 6).join('\n      ')}`); } };

function fakeFetch({ openai = [], deepseek = [], compatible = [], usage = {}, failModels = false } = {}) {
    const seen = [];
    const fetchImpl = async (url, opts = {}) => {
        const u = String(url);
        seen.push({ url: u, body: opts.body ? JSON.parse(opts.body) : null });
        if (u.endsWith('/models')) {
            if (failModels) return { ok: false, status: 500, json: async () => ({}) };
            const ids = u.includes('openai') ? openai : u.includes('deepseek') ? deepseek : u.includes('compat') ? compatible : [];
            return { ok: true, status: 200, json: async () => ({ data: ids.map((id) => ({ id })) }) };
        }
        const model = opts.body ? JSON.parse(opts.body).model : 'x';
        const body = { model, choices: [{ message: { role: 'assistant', content: `answer from ${model}` }, finish_reason: 'stop' }], usage: { prompt_tokens: usage.input || 1000, completion_tokens: usage.output || 500, prompt_cache_hit_tokens: 0 } };
        return { ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body };
    };
    return { fetchImpl, seen };
}

const baseEnv = {
    NODE_ENV: 'test',
    ACTOR_OPENAI_API_KEY: 'oa', ACTOR_OPENAI_BASE_URL: 'https://openai.test/v1',
    ACTOR_DEEPSEEK_API_KEY: 'ds', ACTOR_DEEPSEEK_BASE_URL: 'https://deepseek.test',
};
const quiet = { log() {}, warn() {} };

(async () => {
    await ok('the preference list is dated and smart/best take the strongest the key offers, never a mini', async () => {
        assert.strictEqual(PREFERRED_CHECKED, '2026-10-30');
        const { fetchImpl } = fakeFetch({ openai: ['gpt-5.1', 'gpt-5-mini', 'gpt-5-nano', 'text-embedding-3-small'], deepseek: ['deepseek-chat', 'deepseek-reasoner'] });
        const config = configLib.load(baseEnv);
        const models = createModels({ config, rates: RATES, fetchImpl, log: quiet });
        const tiers = await models.warm();
        assert.strictEqual(tiers.smart.provider, 'openai');
        assert.strictEqual(tiers.smart.model, 'gpt-5.1');
        assert.strictEqual(tiers.best.model, 'gpt-5.1');
        assert.strictEqual(tiers.fast.model, 'gpt-5-nano', 'fast takes the small one');
        assert.strictEqual(tiers.check.provider, 'deepseek', 'the check is another family');
        assert.strictEqual(tiers.check.model, 'deepseek-reasoner');
        assert.strictEqual(tiers.vision.model, 'gpt-5.1');
        assert.deepStrictEqual(models.modelList().map((m) => m.model), ['gpt-5.1', 'gpt-5-mini', 'gpt-5-nano', 'deepseek-reasoner', 'deepseek-chat']);
    });

    await ok('a tier pinned in config wins; a bare model takes the first configured provider', async () => {
        const { fetchImpl } = fakeFetch({ openai: ['gpt-5.1', 'gpt-5-mini'], deepseek: ['deepseek-chat', 'deepseek-reasoner'] });
        const pinned = createModels({ config: configLib.load({ ...baseEnv, ACTOR_MODEL_SMART: 'deepseek:deepseek-reasoner', ACTOR_MODEL_FAST: 'gpt-5-nano' }), rates: RATES, fetchImpl, log: quiet });
        const t = await pinned.warm();
        assert.deepStrictEqual([t.smart.provider, t.smart.model], ['deepseek', 'deepseek-reasoner']);
        assert.deepStrictEqual([t.fast.provider, t.fast.model], ['openai', 'gpt-5-nano']);
    });

    await ok('the check skips the writer\'s family even when check is pinned to it, and says when it could not', async () => {
        const { fetchImpl } = fakeFetch({ openai: ['gpt-5.1'], deepseek: ['deepseek-reasoner'] });
        const both = createModels({ config: configLib.load({ ...baseEnv, ACTOR_MODEL_CHECK: 'openai:gpt-5.1' }), rates: RATES, fetchImpl, log: quiet });
        await both.warm();
        assert.strictEqual(both.resolve('check', { avoidFamily: 'openai' }).family, 'deepseek');
        const onlyOpenAi = createModels({ config: configLib.load({ ...baseEnv, ACTOR_DEEPSEEK_API_KEY: '', ACTOR_MODEL_CHECK: 'openai:gpt-5.1' }), rates: RATES, fetchImpl, log: quiet });
        await onlyOpenAi.warm();
        const d = onlyOpenAi.resolve('check', { avoidFamily: 'openai' });
        assert.strictEqual(d.family, 'openai', 'no second family exists, so the pin stands');
        assert.strictEqual(onlyOpenAi.resolve('check').available, true);
    });

    await ok('two keys: cheapest/strongest choice is explainable, and an unknown provider is refused, not guessed', async () => {
        const { fetchImpl } = fakeFetch({ openai: ['gpt-5.1'], deepseek: ['deepseek-reasoner'] });
        const models = createModels({ config: configLib.load({ ...baseEnv, ACTOR_MODEL_SMART: 'nobody:gpt-9' }), rates: RATES, fetchImpl, log: quiet });
        const t = await models.warm();
        assert.strictEqual(t.smart.available, false);
        assert.match(t.smart.reason, /unknown provider/);
        await assert.rejects(() => models.chat({ tier: 'smart', messages: [{ role: 'user', content: 'x' }] }), /unknown provider/);
    });

    await ok('when a provider\'s model list cannot be read, its configured model is the fallback', async () => {
        const { fetchImpl } = fakeFetch({ failModels: true });
        const models = createModels({ config: configLib.load({ ...baseEnv, ACTOR_OPENAI_MODEL: 'gpt-5-mini', ACTOR_DEEPSEEK_API_KEY: '' }), rates: RATES, fetchImpl, log: quiet });
        const t = await models.warm();
        assert.strictEqual(t.smart.available, true);
        assert.strictEqual(t.smart.model, 'gpt-5-mini');
        assert.match(JSON.stringify(models.listErrors()), /HTTP 500/);
    });

    await ok('a call is metered from its usage at the rate card, as before', async () => {
        const { fetchImpl } = fakeFetch({ openai: ['gpt-5.1'], usage: { input: 1000, output: 500 } });
        const models = createModels({ config: configLib.load(baseEnv), rates: RATES, fetchImpl, log: quiet });
        await models.warm();
        const r = await models.chat({ tier: 'smart', messages: [{ role: 'user', content: 'x' }] });
        // 1000 in at $0.25/M + 500 out at $2.00/M = 0.00025 + 0.001 = 0.00125
        assert.ok(Math.abs(r.cost_usd - 0.00125) < 1e-9, String(r.cost_usd));
        assert.strictEqual(r.model, 'gpt-5.1');
        assert.strictEqual(r.family, 'openai');
    });

    await ok('any OpenAI-compatible endpoint is a provider, with the operator\'s price', async () => {
        const { fetchImpl, seen } = fakeFetch({ compatible: ['llama-4-70b'] });
        const config = configLib.load({ ...baseEnv, ACTOR_DEEPSEEK_API_KEY: '', ACTOR_COMPAT_URL: 'https://compat.test/v1', ACTOR_COMPAT_API_KEY: 'ck', ACTOR_COMPAT_MODEL: 'llama-4-70b', ACTOR_COMPAT_INPUT_USD_PER_MTOK: '1', ACTOR_COMPAT_OUTPUT_USD_PER_MTOK: '2', ACTOR_MODEL_SMART: 'compatible:llama-4-70b' });
        const models = createModels({ config, rates: RATES, fetchImpl, log: quiet });
        const t = await models.warm();
        assert.deepStrictEqual([t.smart.provider, t.smart.model], ['compatible', 'llama-4-70b']);
        const r = await models.chat({ tier: 'smart', messages: [{ role: 'user', content: 'x' }] });
        assert.strictEqual(r.provider, 'compatible');
        assert.ok(seen.some((s) => s.url === 'https://compat.test/v1/chat/completions'));
        assert.ok(Math.abs(r.cost_usd - (1000 * 1 + 500 * 2) / 1e6) < 1e-9, String(r.cost_usd));
    });

    await ok('DeepSeek Flash leads its family when the provider offers it (the owner prefers it to Pro)', async () => {
        const { fetchImpl } = fakeFetch({ openai: ['gpt-5.1', 'gpt-5-nano'], deepseek: ['deepseek-v4-pro', 'deepseek-flash', 'deepseek-chat'] });
        const models = createModels({ config: configLib.load(baseEnv), rates: RATES, fetchImpl, log: quiet });
        const t = await models.warm();
        assert.strictEqual(t.check.provider, 'deepseek');
        assert.strictEqual(t.check.model, 'deepseek-flash');
    });

    await ok('a research agent or a dated snapshot is not a chat model; fast takes the cheapest small one first', async () => {
        const { fetchImpl } = fakeFetch({
            openai: ['o4-mini-deep-research', 'gpt-5.1', 'gpt-5-nano', 'gpt-4o-mini', 'o3-mini', 'gpt-5.1-2025-11-13'],
            deepseek: ['deepseek-v4-pro', 'deepseek-chat'],
        });
        const models = createModels({ config: configLib.load(baseEnv), rates: RATES, fetchImpl, log: quiet });
        const t = await models.warm();
        assert.strictEqual(t.fast.model, 'gpt-5-nano', 'nano before mini before the rest');
        assert.strictEqual(t.smart.model, 'gpt-5.1');
        assert.strictEqual(t.check.provider, 'deepseek');
        assert.strictEqual(t.check.model, 'deepseek-v4-pro', 'without Flash on offer, Pro leads what is left');
        const listed = models.modelList().map((m) => m.model);
        assert.ok(!listed.includes('o4-mini-deep-research') && !listed.includes('gpt-5.1-2025-11-13'), listed.join(', '));
    });

    await ok('a reasoning chat model gets effort "low"; a DeepSeek check has its thinking off so the verdict fits', async () => {
        const { fetchImpl, seen } = fakeFetch({ openai: ['gpt-5.1', 'gpt-5-nano'], deepseek: ['deepseek-v4-pro'] });
        const models = createModels({ config: configLib.load(baseEnv), rates: RATES, fetchImpl, log: quiet });
        await models.warm();
        await models.chat({ tier: 'smart', messages: [{ role: 'user', content: 'x' }] });
        const openaiBody = seen.filter((s) => s.body && s.body.model === 'gpt-5.1').at(-1).body;
        assert.strictEqual(openaiBody.reasoning_effort, 'low');
        assert.ok(openaiBody.max_completion_tokens > 0 && !('max_tokens' in openaiBody));
        const v = await models.chat({ tier: 'check', messages: [{ role: 'user', content: 'x' }], json: true });
        assert.strictEqual(v.model, 'deepseek-v4-pro');
        const dsBody = seen.filter((s) => s.body && s.body.model === 'deepseek-v4-pro').at(-1).body;
        assert.deepStrictEqual(dsBody.thinking, { type: 'disabled' });
        assert.strictEqual(dsBody.response_format.type, 'json_object');
        const loopOnDeepseek = createModels({ config: configLib.load({ ...baseEnv, ACTOR_MODEL_SMART: 'deepseek:deepseek-v4-pro', ACTOR_MODEL_CHECK: 'openai:gpt-5.1' }), rates: RATES, fetchImpl, log: quiet });
        await loopOnDeepseek.warm();
        await loopOnDeepseek.chat({ tier: 'smart', messages: [{ role: 'user', content: 'x' }] });
        const smartBody = seen.filter((s) => s.body && s.body.model === 'deepseek-v4-pro').at(-1).body;
        assert.ok(!('thinking' in smartBody), 'the loop keeps the model thinking');
    });

    if (results.length) { console.log(`\n${results.length} failed`); process.exit(1); }
    console.log('\nall passed');
})();

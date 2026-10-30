'use strict';
/**
 * The claim-level check (Actor v2). Another model family extracts the answer's claims and maps each to the evidence
 * items the tools returned. A live fact with no evidence fails the answer — the old prompt's "do not fail an answer
 * only because it states prices you cannot verify" is gone, because that is exactly how a price, the weather and NFL
 * standings were once delivered with no tool behind them. General knowledge may stand.
 */
const assert = require('assert');
const { check, failing, SYSTEM } = require('../server/runtime/check');
const configLib = require('../server/config');

const results = [];
const ok = async (name, fn) => { try { await fn(); console.log(`  ✓ ${name}`); } catch (e) { results.push(e); console.log(`  ✗ ${name}\n      ${(e.stack || String(e)).split('\n').slice(0, 7).join('\n      ')}`); } };

/** A model layer where the check tier is deepseek and the writer is openai. */
function fakeModels({ verdict, throwFacts = [], checkAvailable = true, pinnedToWriter = false } = {}) {
    const chats = [];
    return {
        chats,
        resolve(tier, { avoidFamily = null } = {}) {
            if (tier !== 'check') return { tier, provider: 'openai', model: 'gpt-5.1', family: 'openai', available: true };
            if (!checkAvailable) return { tier, provider: 'deepseek', model: '', family: 'deepseek', available: false, reason: 'no deepseek key is configured on this server' };
            const family = pinnedToWriter
                ? (avoidFamily === 'openai' ? 'deepseek' : 'openai')
                : (avoidFamily === 'deepseek' ? 'openai' : 'deepseek');
            return { tier, provider: family, model: family === 'deepseek' ? 'deepseek-reasoner' : 'gpt-5.1', family, available: true };
        },
        async chat(req) {
            chats.push(req);
            if (throwFacts.includes(req.provider)) throw new Error(`${req.provider} is down`);
            const v = typeof verdict === 'function' ? verdict(req) : verdict;
            return { text: JSON.stringify(v), cost_usd: 0.0002, model: req.model, family: req.provider, provider: req.provider, usage: {} };
        },
    };
}

const answer = 'The BTC price is **$87,432** [E1]. It rose 2% today.';
const evidence = [{ id: 'E1', tool: 'search_web', input: { query: 'btc price' }, text: '{"price_usd":87432,"change_pct":2}' }];

(async () => {
    await ok('a live price with no evidence fails the claim, and the verdict names it', async () => {
        const models = fakeModels({ verdict: { claims: [{ claim: 'The BTC price is $87,432', kind: 'live', evidence: [], supported: false }], ok: false, reason: 'the price has no source' } });
        const v = await check({ task: 'What is the BTC price?', answer: 'The BTC price is **$87,432**.', evidence: [], models, writerFamily: 'openai' });
        assert.strictEqual(v.ok, false);
        assert.strictEqual(v.unsupported.length, 1);
        assert.match(v.unsupported[0].claim, /87,432/);
        assert.match(v.reason, /without evidence/);
        assert.strictEqual(v.by, 'deepseek');
        assert.strictEqual(v.cross, true);
        assert.match(v.model, /deepseek/);
    });

    await ok('the same answer passes once an evidence item states the price', async () => {
        const models = fakeModels({ verdict: { claims: [{ claim: 'The BTC price is $87,432', kind: 'live', evidence: ['E1'], supported: true }, { claim: 'It rose 2% today', kind: 'live', evidence: ['E1'], supported: true }], ok: true, reason: 'both claims cite the price result' } });
        const v = await check({ task: 'What is the BTC price?', answer, evidence, models, writerFamily: 'openai' });
        assert.strictEqual(v.ok, true);
        assert.deepStrictEqual(v.unsupported, []);
        assert.strictEqual(v.claims.length, 2);
        // The checker was shown the evidence itself, not just its ids.
        assert.match(models.chats[0].messages[1].content, /87432/);
        assert.match(models.chats[0].messages[1].content, /E1/);
    });

    await ok('a live claim the checker calls supported but cites nothing still fails; general knowledge may stand', async () => {
        const lying = fakeModels({ verdict: { claims: [{ claim: 'The BTC price is $99,000', kind: 'live', evidence: [], supported: true }], ok: true } });
        const v1 = await check({ task: 't', answer: 'The BTC price is $99,000.', evidence, models: lying, writerFamily: 'openai' });
        assert.strictEqual(v1.ok, false, 'supported=true does not override the missing citation');
        const general = fakeModels({ verdict: { claims: [{ claim: 'Bitcoin is a cryptocurrency', kind: 'general', evidence: [], supported: false }], ok: true, reason: 'general knowledge' } });
        const v2 = await check({ task: 't', answer: 'Bitcoin is a cryptocurrency.', evidence: [], models: general, writerFamily: 'openai' });
        assert.strictEqual(v2.ok, true);
        assert.deepStrictEqual(v2.unsupported, []);
        // failing() is the rule, whatever the model concluded.
        assert.deepStrictEqual(failing([{ claim: 'a price', kind: 'live', evidence: [], supported: true }]).length, 1);
        assert.deepStrictEqual(failing([{ claim: 'a definition', kind: 'general', evidence: [], supported: false }]).length, 0);
    });

    await ok('the old "prices you cannot verify" exemption is absent from the prompt', async () => {
        assert.ok(!/do not fail an answer only because it states prices/i.test(SYSTEM));
        assert.match(SYSTEM, /A live claim with no supporting evidence is supported=false/);
        assert.match(SYSTEM, /Never mark a live claim supported because it sounds plausible/);
        assert.match(SYSTEM, /search result that merely mentions the topic does not support a number/);
    });

    await ok('when the other family cannot answer, the same family checks and the verdict says it is not cross-family', async () => {
        const models = fakeModels({ pinnedToWriter: true, throwFacts: ['deepseek'], verdict: { claims: [], ok: true, reason: 'nothing to check' } });
        const v = await check({ task: 't', answer: 'No facts here.', evidence: [], models, writerFamily: 'openai' });
        assert.strictEqual(v.ok, true);
        assert.strictEqual(v.by, 'openai');
        assert.strictEqual(v.cross, false);
        assert.strictEqual(models.chats.length, 2, 'the other family was tried first');
    });

    await ok('no checker at all is unavailable, never a pass; and check reflections are capped at two', async () => {
        const v = await check({ task: 't', answer, evidence, models: fakeModels({ checkAvailable: false }), writerFamily: 'openai' });
        assert.strictEqual(v.ok, false);
        assert.strictEqual(v.unavailable, true);
        assert.match(v.reason, /no deepseek key/);
        assert.strictEqual(configLib.load({ NODE_ENV: 'test', ACTOR_LOOP_CHECK_REFLECTIONS: '9' }).loop.checkReflections, 2);
        assert.strictEqual(configLib.load({ NODE_ENV: 'test', ACTOR_LOOP_CHECK_REFLECTIONS: '1' }).loop.checkReflections, 1);
    });

    await ok('a checker that answers with prose instead of a verdict is unavailable, not a pass', async () => {
        const models = fakeModels({ verdict: 'I think it is fine.' });
        const v = await check({ task: 't', answer, evidence, models, writerFamily: 'openai' });
        assert.strictEqual(v.ok, false);
        assert.strictEqual(v.unavailable, true);
        assert.match(v.reason, /gave no verdict/);
    });

    if (results.length) { console.log(`\n${results.length} failed`); process.exit(1); }
    console.log('\nall passed');
})();

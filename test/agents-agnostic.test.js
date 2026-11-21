'use strict';
// Model- and harness-agnostic (the owner, 2026-11-21: "anything that's DeepSeek reliant or reliant on a specific model
// … should be using OpenVibe.exchange and be customizable … everything should be agnostic of model or harness"; and on
// /agents: "improve this for mobile especially … less wordy … choose different models or harnesses"):
//   - /agents lists the ways a task can be worked (the chat's own list), each a link that opens the chat on it, and
//     names no maker as Actor's own;
//   - the Exchange reader groups the live list by maker, keeps a good read ten minutes, and survives a failed one;
//   - the check asks OpenVibe.AI's Decisions API first, then its check tier for a verdict in words, and private mode
//     never leaves OpenVibe.
const assert = require('assert');
const { boot, check: step, done } = require('./helpers/boot');
const { createExchangeModels } = require('../server/http/exchange-models');
const { check, makerOf } = require('../server/agents/check');

(async () => {
    await step('the Exchange reader groups by maker, caches, and survives a failure', async () => {
        let calls = 0;
        let fail = false;
        const models = [
            { model: 'gpt-5.1', provider: 'openai', status: 'available', type: 'chat', supports: { tools: true } },
            { model: 'openai/gpt-5-nano', provider: 'openrouter', status: 'available', type: 'chat' },
            { model: 'claude-haiku-4-5', provider: 'anthropic', status: 'available', type: 'chat', supports: { vision: true } },
            { model: 'deepseek-flash', provider: 'deepseek', status: 'available', type: 'chat' },
            { model: 'mystery-1', provider: 'somehost', status: 'available', type: 'chat' },
            { model: 'gpt-old', provider: 'openai', status: 'retired', type: 'chat' },
        ];
        let t = 0;
        const fetchImpl = async () => { calls += 1; if (fail) throw new Error('down'); return { ok: true, json: async () => ({ count: models.length, models }) }; };
        const ex = createExchangeModels({ url: 'https://exchange.test/api/v1/models', fetchImpl, now: () => t });
        const s = await ex.summary();
        assert.strictEqual(s.count, 5, 'available chat models only');
        assert.strictEqual(s.providers, 5, 'hosts counted apart from makers (openai, openrouter, anthropic, deepseek, somehost)');
        assert.deepStrictEqual(s.makers.map((m) => [m.name, m.n, m.q]), [['OpenAI', 2, 'gpt'], ['Anthropic', 1, 'claude'], ['DeepSeek', 1, 'deepseek']]);
        await ex.summary();
        assert.strictEqual(calls, 1, 'kept ten minutes');
        t = 11 * 60_000; fail = true;
        assert.strictEqual((await ex.summary()).count, 5, 'a failed read keeps the last good list');
    });

    await step('makerOf names the maker of a model id', () => {
        assert.deepStrictEqual(['openai/gpt-5.1', 'deepseek-flash', 'claude-haiku-4-5', 'gemini-decision-1', 'o3', 'qwen3-max', ''].map(makerOf),
            ['openai', 'deepseek', 'anthropic', 'google', 'openai', 'qwen', '']);
    });

    await step('the check: Decisions first, then a verdict in words from the check tier, private stays home', async () => {
        const asked = [];
        const decide = (p) => async (body) => { asked.push(['decide', body.kind, body.questions.good.type]); return { answers: { good: { type: 'noul', noul: p } }, receipt: { model: 'gemini-decision-1', cost_usd: 0.00001 } }; };
        const routed = (verdict) => ({ chat: async (args) => { asked.push(['chat', args.tier]); return { text: JSON.stringify(verdict), cost_usd: 0.0001, model: 'openai/gpt-5-nano' }; } });
        const legacy = { deepseek: async () => { asked.push(['legacy']); return { text: '{"ok":true,"reason":"legacy"}', cost_usd: 0 }; } };

        const pass = await check({ task: 'Hi', answer: 'Hello!', agentId: 'codes', mode: 'balanced', checkers: legacy, decide: decide(0.93), routed: routed({ ok: false, reason: 'no' }), wroteWith: 'deepseek-flash' });
        assert.strictEqual(pass.ok, true);
        assert.strictEqual(pass.by, 'gemini-decision-1');
        assert.strictEqual(pass.cross, true, 'another maker read it');
        assert.deepStrictEqual(asked, [['decide', 'grading', 'noul']], 'a clear yes needs nothing more');

        asked.length = 0;
        const no = await check({ task: 'What is 2+2?', answer: '5', agentId: 'codes', mode: 'balanced', checkers: legacy, decide: decide(0.1), routed: routed({ ok: false, reason: 'The sum is wrong.' }), wroteWith: 'openai/gpt-5.1' });
        assert.strictEqual(no.ok, false);
        assert.strictEqual(no.reason, 'The sum is wrong.', 'a no comes with words');
        assert.strictEqual(no.cross, false, 'same maker says so');
        assert.deepStrictEqual(asked, [['decide', 'grading', 'noul'], ['chat', 'check']], 'the check tier, never a provider key of Actor\'s own');

        asked.length = 0;
        const local = { local: async () => { asked.push(['local']); return { text: '{"ok":true,"reason":"fine"}', cost_usd: 0 }; } };
        const priv = await check({ task: 'Hi', answer: 'Hello', agentId: 'open-model', mode: 'private', checkers: local, decide: decide(0.99), routed: routed({ ok: true }), wroteWith: 'local' });
        assert.strictEqual(priv.ok, true);
        assert.deepStrictEqual(asked, [['local']], 'private mode never leaves OpenVibe');
    });

    const t = await boot();
    try {
        await step('/agents: the ways to work, each opening the chat on it, no maker named as Actor\'s', async () => {
            const r = await t.get('/agents');
            assert.strictEqual(r.status, 200);
            for (const name of ['Actor\'s agent', 'One model', 'Decisions', 'A coding harness', 'Private']) assert.ok(r.text.includes(name.replace(/'/g, '&#39;')) || r.text.includes(name), name);
            for (const href of ['/chat?way=agent', '/chat?way=model', '/chat?way=decisions']) assert.ok(r.text.includes(`href="${href}"`), href);
            assert.ok(/Claude Code/.test(r.text) && /Codex/.test(r.text) && /OpenCode/.test(r.text), 'the harnesses by name');
            assert.ok(!/DeepSeek/.test(r.text.replace(/<script[\s\S]*?<\/script>/g, '')), 'no maker named as Actor\'s own');
            assert.ok(r.text.includes('https://openvibe.exchange/models'), 'the models are Exchange\'s');
            assert.ok(/class="aw-ways"/.test(r.text) && !/class="ag-cards"/.test(r.text), 'the new layout');
        });
    } finally { await t.close(); }
    done();
})();

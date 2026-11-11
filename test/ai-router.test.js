'use strict';
/**
 * The AI layer (ACTOR_AI_ROUTER): every tier is a run of ai.complete on OpenVibe.AI's router, with Actor's own
 * service token. No provider key is read, the person the task belongs to rides as on_behalf_of (their allowance
 * pays), the tier's name is the policy, and the answer's model is whatever AI says ran. Also the streamed run.
 */
const assert = require('assert');
const configLib = require('../server/config');
const { createModels } = require('../server/runtime/models');

const USR = 'usr_01JAB2C3D4E5F6G7H8J9K0MNPQ';
const quiet = { log() {}, warn() {} };
const reply = (status, obj) => ({ ok: status >= 200 && status < 300, status, headers: new Headers({ 'content-type': 'application/json' }), json: async () => obj, text: async () => JSON.stringify(obj) });
const headerOf = (headers, name) => (headers && typeof headers.get === 'function' ? headers.get(name) : (headers || {})[name]);

function fakeAi({ answer = 'Hello from the router', model = 'deepseek/deepseek-chat' } = {}) {
    const calls = [];
    const fetchImpl = async (url, opts = {}) => {
        const u = String(url);
        if (u.includes('/oauth/token')) return reply(200, { access_token: 'tok_router', token_type: 'Bearer', expires_in: 300, scope: 'ai.run.create' });
        calls.push({ url: u, headers: opts.headers, body: opts.body ? JSON.parse(opts.body) : null });
        if (u.includes('stream=1')) {
            const enc = new TextEncoder();
            const body = new ReadableStream({
                start(c) {
                    for (const piece of ['Hel', 'lo from', ' the router']) c.enqueue(enc.encode(`event: delta\ndata: ${JSON.stringify({ text: piece })}\n\n`));
                    c.enqueue(enc.encode(`event: run\ndata: ${JSON.stringify({ run: { id: 'run_s', status: 'succeeded', output: { choices: [{ message: { role: 'assistant', content: answer }, finish_reason: 'stop' }], model }, usage: { tokens_in: 9, tokens_out: 4, cost_usd: 0.00004 }, provenance: { model } } })}\n\n`));
                    c.close();
                },
            });
            return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
        }
        if (u.includes('/api/v1/runs')) {
            return reply(201, { run: { id: 'run_1', status: 'succeeded', output: { choices: [{ message: { role: 'assistant', content: answer }, finish_reason: 'stop' }], model }, usage: { tokens_in: 12, tokens_out: 4, cost_usd: 0.00003 }, provenance: { model } } });
        }
        return reply(404, {});
    };
    return { fetchImpl, calls };
}

const env = {
    NODE_ENV: 'test',
    OV_NETWORK_URL: 'https://network.test', OV_NETWORK_INTERNAL_URL: 'https://network.internal',
    OV_OAUTH_CLIENT_ID: 'actor', OV_OAUTH_CLIENT_SECRET: 'actor-secret',
    OV_AI_URL: 'https://ai.test', ACTOR_AI_ROUTER: '1',
    // No provider key at all: the router is the model layer.
    ACTOR_DEEPSEEK_API_KEY: '', ACTOR_OPENAI_API_KEY: '', ACTOR_LOCAL_LLM_URL: '',
};

const results = [];
const ok = async (name, fn) => { try { await fn(); console.log(`  ✓ ${name}`); } catch (e) { results.push(e); console.log(`  ✗ ${name}\n      ${(e.stack || String(e)).split('\n').slice(0, 6).join('\n      ')}`); } };

(async () => {
    await ok('every tier resolves to its policy on the router, and a pinned tier still wins', async () => {
        const models = createModels({ config: configLib.load(env), fetchImpl: fakeAi().fetchImpl, log: quiet });
        assert.deepStrictEqual([models.resolve('fast').provider, models.resolve('fast').model, models.resolve('fast').available], ['openvibe-ai', 'openvibe/economy', true]);
        assert.strictEqual(models.resolve('smart').model, 'openvibe/balanced');
        assert.strictEqual(models.resolve('best').model, 'openvibe/auto');
        assert.strictEqual(models.resolve('check').model, 'openvibe/economy');
        const pinned = createModels({ config: configLib.load({ ...env, ACTOR_AI_MODEL_SMART: 'openvibe/private' }), fetchImpl: fakeAi().fetchImpl, log: quiet });
        assert.strictEqual(pinned.resolve('smart').model, 'openvibe/private');
        assert.ok(models.modelList().some((m) => m.provider === 'openvibe-ai' && m.model === 'openvibe/balanced'));
    });

    await ok('a call is a run of ai.complete: service token, tier policy, the person in on_behalf_of, AI\'s price', async () => {
        const { fetchImpl, calls } = fakeAi();
        const models = createModels({ config: configLib.load(env), fetchImpl, log: quiet });
        const r = await models.withChoice({ subject: USR }, () => models.chat({ tier: 'smart', messages: [{ role: 'user', content: 'Say hello' }] }));
        assert.strictEqual(r.text, 'Hello from the router');
        assert.strictEqual(r.provider, 'openvibe-ai');
        assert.strictEqual(r.model, 'deepseek/deepseek-chat', 'the model that ran, not the wish');
        assert.ok(Math.abs(r.cost_usd - 0.00003) < 1e-12, 'AI prices the call');
        const run = calls.find((c) => c.url.includes('/api/v1/runs'));
        assert.ok(run, 'a run was made');
        assert.strictEqual(headerOf(run.headers, 'authorization'), 'Bearer tok_router');
        assert.strictEqual(run.body.workflow, 'ai.complete');
        assert.strictEqual(run.body.input.model, 'openvibe/balanced');
        assert.deepStrictEqual(run.body.on_behalf_of, { type: 'user', id: USR });
        assert.strictEqual(run.body.input.messages[0].content, 'Say hello');
        assert.ok(!calls.some((c) => /api\.(deepseek|openai)/.test(c.url)), 'no provider key or address');
    });

    await ok('a personal Actor model choice pins the catalogue model on the router without naming an own-key credential', async () => {
        const { fetchImpl, calls } = fakeAi();
        const models = createModels({ config: configLib.load(env), fetchImpl, log: quiet });
        await models.withChoice({ subject: USR, model: 'example/brain@v1' }, () => models.chat({ messages: [{ role: 'user', content: 'Hello' }] }));
        const call = calls.find((c) => c.url.includes('/api/v1/runs'));
        assert.strictEqual(call.body.input.model, 'example/brain@v1');
        assert.deepStrictEqual(call.body.on_behalf_of, { type: 'user', id: USR });
        assert.ok(!headerOf(call.headers, 'x-openvibe-credential'));
    });

    await ok('a streamed call sends the deltas as they come and ends with the run', async () => {
        const { fetchImpl, calls } = fakeAi();
        const models = createModels({ config: configLib.load(env), fetchImpl, log: quiet });
        const pieces = [];
        const r = await models.withChoice({ subject: USR }, () => models.chat({ tier: 'smart', messages: [{ role: 'user', content: 'Stream' }], onDelta: (t) => pieces.push(t) }));
        assert.deepStrictEqual(pieces, ['Hel', 'lo from', ' the router']);
        assert.strictEqual(r.text, 'Hello from the router');
        assert.ok(calls.some((c) => c.url.includes('stream=1')), 'the streamed run endpoint');
    });

    await ok('without the router a keyless server has no model, as before', async () => {
        const models = createModels({ config: configLib.load({ ...env, ACTOR_AI_ROUTER: '0' }), fetchImpl: fakeAi().fetchImpl, log: quiet });
        assert.strictEqual(models.resolve('smart').available, false);
        await assert.rejects(() => models.chat({ tier: 'smart', messages: [{ role: 'user', content: 'x' }] }), /model|provider/i);
    });

    await ok('the content tier rides the run to AI: uncensored reaches it with the person, standard never asks', async () => {
        const { fetchImpl, calls } = fakeAi();
        const models = createModels({ config: configLib.load(env), fetchImpl, log: quiet });
        await models.withChoice({ subject: USR, policy: 'uncensored' }, () => models.chat({ tier: 'smart', messages: [{ role: 'user', content: 'Say hello' }] }));
        const run = calls.find((c) => c.url.includes('/api/v1/runs'));
        assert.ok(run, 'a run was made');
        // AI reads the tier as a control field on the run, and decides about the person it names.
        assert.strictEqual(run.body.options && run.body.options.policy, 'uncensored', 'the tier reaches AI');
        assert.deepStrictEqual(run.body.on_behalf_of, { type: 'user', id: USR }, 'and the person it is for');

        const plain = fakeAi();
        const models2 = createModels({ config: configLib.load(env), fetchImpl: plain.fetchImpl, log: quiet });
        await models2.withChoice({ subject: USR }, () => models2.chat({ tier: 'smart', messages: [{ role: 'user', content: 'Say hello' }] }));
        const run2 = plain.calls.find((c) => c.url.includes('/api/v1/runs'));
        assert.ok(!run2.body.options || run2.body.options.policy === undefined, 'a standard run never asks for the adult tier');
    });

    await ok('the content tier never reaches a provider directly: without AI it is refused, not downgraded', async () => {
        const env2 = { ...env, ACTOR_AI_ROUTER: '0', ACTOR_DEEPSEEK_API_KEY: 'sk-test', ACTOR_LOCAL_LLM_URL: '' };
        const models = createModels({ config: configLib.load(env2), fetchImpl: fakeAi().fetchImpl, log: quiet });
        await assert.rejects(
            () => models.withChoice({ subject: USR, policy: 'uncensored' }, () => models.chat({ tier: 'smart', messages: [{ role: 'user', content: 'x' }] })),
            /uncensored|AI/i,
            'the adult tier is OpenVibe.AI\'s, and it is said so'
        );
    });

    if (results.length) { console.error(`${results.length} failed`); process.exit(1); }
    console.log('ai-router: all passed');
})();

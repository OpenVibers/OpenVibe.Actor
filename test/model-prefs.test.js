'use strict';
/**
 * Plan L55 C3: the person chooses the model their tasks run on — with their OWN provider key (sealed in OpenVibe.AI's
 * vault, never in Actor) or with OpenVibe's.
 *
 * What is proved here:
 *   the choice is the person's own (GET/PUT /api/v1/me/model), and a bad one is refused, not stored;
 *   a run whose person chose their own key calls OpenVibe.AI with x-openvibe-credential: <provider>:<usr_…>;
 *   NO key material ever reaches Actor: the request carries Actor's service token and the provider's name, nothing
 *   else — the key stays in AI's vault;
 *   AI's refusal (no key for that provider) becomes a plain error that says where to add the key;
 *   'auto' keeps today's behaviour: the operator's own providers, and no call to AI at all.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const { createModels } = require('../server/runtime/models');
const prefs = require('../server/runtime/model-prefs');

const SAME = { 'sec-fetch-site': 'same-origin' };
const PERSON = 'usr_01JZ0000000000000000000AAA';

const reply = (status, obj) => ({ ok: status >= 200 && status < 300, status, json: async () => obj, text: async () => JSON.stringify(obj) });

/** A config with one operator provider and OpenVibe.AI, and no real network. */
function aiConfig() {
    return {
        models: { tiers: {}, providerOrder: ['openai'], listTimeoutMs: 200 },
        providers: { openai: { apiKey: 'sk-fixture-operator-key', baseUrl: 'https://api.openai.test/v1', model: 'gpt-5-mini' } },
        ai: { url: 'https://ai.openvibe.services', audience: 'openvibe.ai', scope: 'ai.run.create', clientId: 'actor', clientSecret: 'actor-secret', timeoutMs: 5000 },
        networkInternalUrl: 'https://network.test', networkUrl: 'https://openvibe.network',
        oauth: { clientId: 'actor', clientSecret: 'actor-secret' },
    };
}

/** The fetch every model call in this file goes through: the token endpoint, a model list and a chat call. */
function fakeFetch(calls, chatAnswer) {
    return async (url, opts = {}) => {
        const u = String(url);
        if (u.includes('/oauth/token')) return reply(200, { access_token: 'tok_service_token', token_type: 'Bearer', expires_in: 300, scope: 'ai.run.create' });
        const call = { url: u, method: opts.method || 'GET', headers: opts.headers || {}, body: opts.body ? JSON.parse(opts.body) : null };
        calls.push(call);
        if (u.endsWith('/models')) return reply(200, { data: [{ id: 'gpt-5.1' }, { id: 'gpt-5-mini' }] });
        return chatAnswer ? chatAnswer(call) : reply(200, { choices: [{ message: { role: 'assistant', content: 'from the operator key' }, finish_reason: 'stop' }], model: 'gpt-5.1', usage: { prompt_tokens: 10, completion_tokens: 5 }, x_openvibe: { cost_usd: 0.001 } });
    };
}

(async () => {
    const t = await boot();
    try {
        const alice = t.network.addUser('model-alice');

        await check('the choice is the person\'s own, and a bad one is refused', async () => {
            const before = await t.get('/api/v1/me/model', { as: alice });
            assert.strictEqual(before.status, 200);
            assert.strictEqual(before.json().choice, 'auto', 'the default is today\'s behaviour');
            assert.strictEqual(before.json().keys, null, 'AI has no route that lists a person\'s providers to a service');

            const put = await t.get('/api/v1/me/model', { as: alice, method: 'PUT', json: { choice: 'own:openai', model: 'gpt-5.1' }, headers: SAME });
            assert.strictEqual(put.status, 200);
            assert.strictEqual(put.json().choice, 'own:openai');
            assert.strictEqual(put.json().provider, 'openai');
            assert.strictEqual(put.json().model, 'gpt-5.1');

            const read = await t.get('/api/v1/me/model', { as: alice });
            assert.strictEqual(read.json().choice, 'own:openai');

            // A provider AI does not know a person's key for, and a model id that is not one.
            assert.strictEqual((await t.get('/api/v1/me/model', { as: alice, method: 'PUT', json: { choice: 'own:not-a-provider' }, headers: SAME })).status, 422);
            assert.strictEqual((await t.get('/api/v1/me/model', { as: alice, method: 'PUT', json: { choice: 'own:openai', model: 'a model id with spaces' }, headers: SAME })).status, 422);
            assert.strictEqual((await t.get('/api/v1/me/model', { as: alice, method: 'PUT', json: { choice: 'whatever' }, headers: SAME })).status, 422);
            // The bad ones never landed.
            assert.strictEqual((await t.get('/api/v1/me/model', { as: alice })).json().choice, 'own:openai');

            // A signed-in write from another site is refused (the session rule), and a service never reaches it.
            assert.strictEqual((await t.get('/api/v1/me/model', { as: alice, method: 'PUT', json: { choice: 'auto' }, headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
        });

        await check('the row is the person\'s, and it goes with them (account data)', async () => {
            const { TABLES } = require('../server/identity/account-data');
            const map = TABLES.find((x) => x.table === 'actor_model_prefs');
            assert.ok(map, 'the table is in the account-data map');
            assert.strictEqual(map.subject, 'requester');
            assert.strictEqual(map.value(PERSON), 'user:' + PERSON);
            assert.ok(!JSON.stringify(map.columns).includes('key'), 'no key material is exported');
        });

        await check('a run with the person\'s own key goes to OpenVibe.AI, and no key reaches Actor', async () => {
            const calls = [];
            const models = createModels({ config: aiConfig(), fetchImpl: fakeFetch(calls), log: { log() {}, warn() {}, error() {} } });
            const r = await models.withChoice({ subject: PERSON, provider: 'openai', model: 'gpt-5.1' }, () => models.chat({
                tier: 'smart', messages: [{ role: 'user', content: 'hello' }],
                tools: [{ type: 'function', function: { name: 'noop', parameters: { type: 'object', properties: {} } } }],
            }));
            assert.strictEqual(calls.length, 1, 'one call, to AI');
            const call = calls[0];
            assert.strictEqual(call.url, 'https://ai.openvibe.services/v1/chat/completions');
            assert.strictEqual(call.headers['x-openvibe-credential'], 'openai:' + PERSON, 'the provider and the bare usr_… id');
            assert.ok(call.body.messages && call.body.messages.length, 'the same OpenAI chat format');
            assert.ok(Array.isArray(call.body.tools), 'tools go with it');
            assert.strictEqual(call.body.prefer.provider, 'openai');
            // NO key material: the only credential in the request is Actor's own service token, and the operator's
            // key never travels with a person's run.
            const authHeader = Object.entries(call.headers).find(([k]) => k.toLowerCase() === 'authorization');
            assert.strictEqual(authHeader && authHeader[1], 'Bearer tok_service_token', 'Actor\'s own service token, nothing else');
            assert.ok(!JSON.stringify(call).includes('sk-'), 'no provider key is in the request');
            assert.ok(!JSON.stringify(call).includes('fixture'), 'not the operator\'s key either');
            assert.strictEqual(r.provider, 'openvibe-ai');
            assert.strictEqual(r.text, 'from the operator key');
        });

        await check('AI\'s refusal becomes a plain error that says where to add the key', async () => {
            const calls = [];
            const models = createModels({ config: aiConfig(), fetchImpl: fakeFetch(calls, () => reply(404, { error: { message: 'no credential', type: 'invalid_request_error', code: 'credential.not_found' } })), log: { log() {}, warn() {}, error() {} } });
            await assert.rejects(
                () => models.withChoice({ subject: PERSON, provider: 'openai', model: null }, () => models.chat({ tier: 'smart', messages: [{ role: 'user', content: 'hello' }] })),
                (err) => {
                    assert.strictEqual(err.code, 'actor.model.no_own_key');
                    assert.strictEqual(err.message, 'Add your openai key at ai.openvibe.services first');
                    return true;
                },
            );
        });

        await check('\'auto\' keeps today\'s behaviour: the operator\'s provider, and no call to AI', async () => {
            const calls = [];
            const models = createModels({ config: aiConfig(), fetchImpl: fakeFetch(calls), log: { log() {}, warn() {}, error() {} } });
            const r = await models.chat({ tier: 'smart', messages: [{ role: 'user', content: 'hello' }] });
            assert.ok(calls.every((c) => !c.url.includes('ai.openvibe.services')), 'AI is not called');
            assert.ok(calls.some((c) => c.url.includes('api.openai.test')), 'the operator\'s provider answers');
            assert.strictEqual(r.provider, 'openai');
        });

    } finally { await t.close(); }

    done();
})();

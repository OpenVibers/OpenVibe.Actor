'use strict';
const assert = require('assert');
const { load } = require('../server/config');
const { createModels } = require('../server/runtime/models');

const subject = 'usr_01JAB2C3D4E5F6G7H8J9K0MNPQ';
const env = { NODE_ENV: 'production', OV_NETWORK_INTERNAL_URL: 'https://network.test', OV_OAUTH_CLIENT_SECRET: 'fixture-secret' };
const calls = [];
const fetchImpl = async (url, opts = {}) => {
    if (String(url).endsWith('/oauth/token')) return new Response(JSON.stringify({ access_token: 'fixture-token', expires_in: 300 }), { status: 200, headers: { 'content-type': 'application/json' } });
    calls.push({ url: String(url), headers: opts.headers, body: JSON.parse(opts.body) });
    if (JSON.parse(opts.body).stream) {
        const chunks = [
            { model: 'local/model', choices: [{ index: 0, delta: { content: 'canary ' } }] },
            { choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] },
            { usage: { prompt_tokens: 8, completion_tokens: 3 }, x_openvibe: { cost_usd: 0.00002, receipt_id: 'rcpt_test' } },
        ];
        return new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    return new Response(JSON.stringify({ model: 'local/model', choices: [{ message: { role: 'assistant', content: 'canary ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 8, completion_tokens: 3 }, x_openvibe: { cost_usd: 0.00002, receipt_id: 'rcpt_test' } }), { status: 200, headers: { 'content-type': 'application/json' } });
};

(async () => {
    const config = load(env);
    assert.strictEqual(config.ai.router, true);
    assert.strictEqual(config.ai.exchangeRouter, true);
    assert.strictEqual(load({ ...env, ACTOR_SELF_HOSTED: '1' }).ai.router, false);
    assert.strictEqual(load({ ...env, ACTOR_EXCHANGE_ROUTER: '0' }).ai.exchangeRouter, false);
    const models = createModels({ config, fetchImpl, log: { warn() {} } });
    const result = await models.chat({ tier: 'smart', subject, messages: [{ role: 'user', content: 'Reply exactly: canary ok' }], tools: [{ type: 'function', function: { name: 'ping', parameters: { type: 'object' } } }] });
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].url, 'https://api.openvibe.exchange/v1/chat/completions');
    assert.strictEqual(calls[0].headers.authorization, 'Bearer fixture-token');
    assert.deepStrictEqual(calls[0].body.on_behalf_of, { type: 'user', id: subject });
    assert.strictEqual(calls[0].body.model, 'openvibe/balanced');
    assert.strictEqual(calls[0].body.tools[0].function.name, 'ping');
    assert.strictEqual(result.text, 'canary ok');
    assert.strictEqual(result.model, 'local/model');
    assert.strictEqual(result.cost_usd, 0.00002);
    assert.deepStrictEqual(result.usage, { input: 8, cached: 0, output: 3 });
    const pieces = [];
    const streamed = await models.chat({ tier: 'fast', subject, messages: [{ role: 'user', content: 'Stream' }], onDelta: (piece) => pieces.push(piece) });
    assert.deepStrictEqual(pieces, ['canary ', 'ok']);
    assert.strictEqual(streamed.text, 'canary ok');
    assert.strictEqual(streamed.cost_usd, 0.00002);
    assert.strictEqual(calls[1].body.stream, true);
    console.log('exchange-router: all passed');
})().catch((err) => { console.error(err); process.exitCode = 1; });

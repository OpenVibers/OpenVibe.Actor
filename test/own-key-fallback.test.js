'use strict';
// When the free allowance is spent, the person's own key answers (the owner, 11-17: "make it so users can configure their
// own API keys … all the different methods work interconnected"). Over a stand-in Exchange and OpenVibe.AI: Auto's call
// through Exchange answers 402 ai.allowance_spent; Actor asks AI which of the person's keys it may use and calls once on
// the first provider key (never the computer when a key is there), as that person; with no key allowed, the 402 stands;
// any other failure is never retried on the person's key.
//   node test/own-key-fallback.test.js
const assert = require('assert');
const { load } = require('../server/config');
const { createModels } = require('../server/runtime/models');

const subject = 'usr_01JAB2C3D4E5F6G7H8J9K0MNPQ';
const env = { NODE_ENV: 'production', OV_NETWORK_INTERNAL_URL: 'https://network.test', OV_OAUTH_CLIENT_SECRET: 'fixture-secret' };
const SPENT = { error: { code: 'ai.allowance_spent', message: `The free AI allowance for ${subject} is spent, and the calling service has no budget to cover this run. Add a key for the person, or wait for the allowance to reset.` } };
const OK = { model: 'anthropic/claude', choices: [{ message: { role: 'assistant', content: 'on your key' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 3 } };
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function stand({ keys, exchange = () => json(402, SPENT) }) {
    const calls = [];
    const fetchImpl = async (url, opts = {}) => {
        const u = String(url);
        if (u.endsWith('/oauth/token')) return json(200, { access_token: 'fixture-token', expires_in: 300 });
        calls.push({ url: u, headers: opts.headers || {}, body: opts.body ? JSON.parse(opts.body) : null });
        if (u.includes('/api/v1/allowed-keys/')) return keys ? json(200, { subject, providers: keys }) : json(404, { error: { code: 'credential.not_found' } });
        if (opts.headers && opts.headers['x-openvibe-credential']) return json(200, OK);
        return exchange();
    };
    return { calls, models: createModels({ config: load(env), fetchImpl, log: { warn() {} } }) };
}

(async () => {
    {
        const { calls, models } = stand({ keys: ['link', 'anthropic'] });
        const r = await models.chat({ tier: 'smart', subject, messages: [{ role: 'user', content: 'hi' }] });
        assert.strictEqual(r.text, 'on your key');
        assert.strictEqual(r.own_key, 'anthropic', 'a provider key before their computer');
        const own = calls.find((c) => c.headers['x-openvibe-credential']);
        assert.strictEqual(own.headers['x-openvibe-credential'], `anthropic:${subject}`, 'as that person, on that key');
        assert.ok(calls.some((c) => c.url.endsWith(`/api/v1/allowed-keys/${subject}`)), 'asks which keys it may use');
    }
    {
        const { models } = stand({ keys: ['link'] });
        const r = await models.chat({ tier: 'smart', subject, messages: [{ role: 'user', content: 'hi' }] });
        assert.strictEqual(r.own_key, 'link', 'their computer when it is all they allowed');
    }
    {
        const { calls, models } = stand({ keys: null });
        await assert.rejects(models.chat({ tier: 'smart', subject, messages: [{ role: 'user', content: 'hi' }] }), (e) => e.status === 402 && /free AI allowance/.test(e.message), 'no key allowed: the 402 stands');
        assert.ok(!calls.some((c) => c.headers['x-openvibe-credential']));
    }
    {
        const { calls, models } = stand({ keys: ['anthropic'], exchange: () => json(500, { error: { message: 'upstream broke' } }) });
        await assert.rejects(models.chat({ tier: 'smart', subject, messages: [{ role: 'user', content: 'hi' }] }));
        assert.ok(!calls.some((c) => c.url.includes('/allowed-keys/')), 'another failure never reaches for the person\'s key');
    }
    console.log('own-key-fallback: all passed');
})().catch((err) => { console.error(err); process.exitCode = 1; });

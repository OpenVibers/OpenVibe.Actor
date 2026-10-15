'use strict';
/**
 * A self-hosted Actor's runtime on OpenVibe's hosted models (docs/self-host.md, "OpenVibe's hosted models"): an
 * OpenVibe app's client credentials become the five-minute token ai.openvibe.services takes (audience openvibe.ai),
 * cached until 30 s before it expires and shared by concurrent calls; a 401 from the model refreshes it once; a
 * refusal from Network is a provider error that names it; a run's cost is what OpenVibe's answer says
 * (x_openvibe.cost_usd); and the env turns it on only with both the id and the secret. Network and the model are
 * fakes: nothing here touches a real network.
 */
const assert = require('assert');
const { check, done } = require('./helpers/boot');
const { appTokenSource } = require('../server/agents/app-token');
const { chatClient, ProviderError } = require('../server/agents/providers');
const { load } = require('../server/config');

const CLIENT = 'app_01JZ00000000000000000000A1';
const SECRET = 'c'.repeat(43);

function fakeNetwork({ refuse = false } = {}) {
    const calls = [];
    let n = 0;
    const fetchImpl = async (url, init) => {
        calls.push({ url, body: Object.fromEntries(new URLSearchParams(init.body)) });
        if (refuse) return new Response(JSON.stringify({ error: 'invalid_client', error_description: 'unknown or revoked app' }), { status: 401 });
        n++;
        return new Response(JSON.stringify({ access_token: `tok-${n}`, token_type: 'Bearer', expires_in: 300 }), { status: 200 });
    };
    return { calls, fetchImpl };
}

(async () => {
    await check('client credentials for audience openvibe.ai, cached until 30 s before expiry, one fetch for concurrent calls', async () => {
        let t = 1_000_000;
        const net = fakeNetwork();
        const token = appTokenSource({ networkUrl: 'https://network.test', clientId: CLIENT, clientSecret: SECRET, fetchImpl: net.fetchImpl, now: () => t });
        const [a, b] = await Promise.all([token(), token()]);
        assert.strictEqual(a, 'tok-1'); assert.strictEqual(b, 'tok-1');
        assert.strictEqual(net.calls.length, 1, 'concurrent calls share one fetch');
        assert.strictEqual(net.calls[0].url, 'https://network.test/oauth/token');
        assert.deepStrictEqual(net.calls[0].body, { grant_type: 'client_credentials', client_id: CLIENT, client_secret: SECRET, audience: 'openvibe.ai' });
        t += 269_000;
        assert.strictEqual(await token(), 'tok-1', 'still cached at 269 s');
        t += 2_000;
        assert.strictEqual(await token(), 'tok-2', 'fetched again inside the last 30 s');
        token.refresh();
        assert.strictEqual(await token(), 'tok-3', 'refresh() drops it');
    });

    await check('a refusal from Network is an error that names it', async () => {
        const token = appTokenSource({ networkUrl: 'https://network.test', clientId: CLIENT, clientSecret: SECRET, fetchImpl: fakeNetwork({ refuse: true }).fetchImpl });
        await assert.rejects(token(), /OpenVibe refused the app's token: unknown or revoked app/);
    });

    await check('the model call carries the token; a 401 refreshes it once; the cost is OpenVibe\'s', async () => {
        const net = fakeNetwork();
        const token = appTokenSource({ networkUrl: 'https://network.test', clientId: CLIENT, clientSecret: SECRET, fetchImpl: net.fetchImpl });
        const seen = [];
        let reject = 1;
        const model = async (url, init) => {
            seen.push(init.headers.authorization);
            if (reject-- > 0) return new Response(JSON.stringify({ error: { message: 'token expired' } }), { status: 401 });
            return new Response(JSON.stringify({
                model: 'deepseek-flash', choices: [{ message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
                usage: { prompt_tokens: 1000, completion_tokens: 100 }, x_openvibe: { run_id: 'run_1', provider: 'deepseek', cost_usd: 0.00042 },
            }), { status: 200 });
        };
        const chat = chatClient({ baseUrl: 'https://ai.test/v1', apiKey: token, model: 'default', rates: { input_usd_per_mtok: 0, output_usd_per_mtok: 0 }, fetchImpl: model });
        const out = await chat({ messages: [{ role: 'user', content: 'hello' }] });
        assert.deepStrictEqual(seen, ['Bearer tok-1', 'Bearer tok-2'], 'the 401 brought a new token, once');
        assert.strictEqual(out.text, 'hi');
        assert.strictEqual(out.cost_usd, 0.00042, 'the cost OpenVibe reported, not the (zero) rate card');

        reject = 5;
        seen.length = 0;
        await assert.rejects(chat({ messages: [{ role: 'user', content: 'hello' }] }), (e) => e instanceof ProviderError && e.status === 401);
        assert.strictEqual(seen.length, 2, 'retried once, not more');
    });

    await check('a key that is a string is sent as it is, and an answer without x_openvibe is priced by the rate card', async () => {
        let auth = null;
        const chat = chatClient({ baseUrl: 'https://llm.test/v1', apiKey: 'sk-local', model: 'qwen', rates: { input_usd_per_mtok: 1, output_usd_per_mtok: 2 },
            fetchImpl: async (_u, init) => { auth = init.headers.authorization; return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 1_000_000, completion_tokens: 500_000 } }), { status: 200 }); } });
        const out = await chat({ messages: [] });
        assert.strictEqual(auth, 'Bearer sk-local');
        assert.strictEqual(out.cost_usd, 2);
    });

    await check('the env turns it on only with both the client id and the secret', () => {
        const base = { NODE_ENV: 'test', ACTOR_RUNTIME_URL: 'https://ai.openvibe.services/v1', ACTOR_RUNTIME_MODEL: 'default' };
        let c = load({ ...base, ACTOR_RUNTIME_OPENVIBE_CLIENT_ID: CLIENT, ACTOR_RUNTIME_OPENVIBE_CLIENT_SECRET: SECRET });
        assert.deepStrictEqual(c.providers.runtime.openvibeApp, { clientId: CLIENT, clientSecret: SECRET, networkUrl: 'https://openvibe.network' });
        c = load({ ...base, ACTOR_RUNTIME_OPENVIBE_CLIENT_ID: CLIENT });
        assert.strictEqual(c.providers.runtime.openvibeApp, null);
    });

    done();
})();

'use strict';
/**
 * PLAN G-P9: Actor uses OpenVibe.AI's catalog through what it already has, behind ACTOR_AI_CATALOG (off).
 *
 * What is proved here:
 *   the catalog parses aliases first and then exact ids, with the output price exact in nano-USD → dollars;
 *   the flag off, a failed read, and AI's legacy single `openvibe` all leave today's model field/behaviour unchanged;
 *   an exact id is sent unchanged as `model` (never rewritten or substituted);
 *   x_openvibe.resolved_model and the cost are the model and cost the run records and shows;
 *   an exact id AI refuses is that refusal, with one call and no retry on another model.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const { createModels } = require('../server/runtime/models');
const aiCatalog = require('../server/runtime/ai-catalog');
require('../server/tasks/engine'); // the end-to-end check below: an exact id AI refuses becomes the task's error

const SAME = { 'sec-fetch-site': 'same-origin' };
const PERSON = 'usr_01JZ0000000000000000000AAA';
const EXACT = 'acme/m1:q4_k_m@rev1';
const LOG = { log() {}, warn() {}, error() {} };
const reply = (status, obj, headers = {}) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ 'content-type': 'application/json', ...headers }),
    json: async () => obj,
    text: async () => JSON.stringify(obj),
});

/** A config with OpenVibe.AI (and no operator providers). */
function aiConfig(catalog = true) {
    return {
        models: { tiers: {}, providerOrder: [], listTimeoutMs: 200 },
        providers: {},
        ai: { url: 'https://ai.test', audience: 'openvibe.ai', scope: 'ai.run.create', clientId: 'actor', clientSecret: 'actor-secret', timeoutMs: 5000, catalog },
        networkInternalUrl: 'https://network.test', networkUrl: 'https://openvibe.network',
        oauth: { clientId: 'actor', clientSecret: 'actor-secret' },
    };
}

/** The token endpoint, then whatever the test wants for GET /v1/models and POST /v1/chat/completions. */
function fakeFetch({ models = null, chat = null } = {}) {
    const calls = [];
    const fetchImpl = async (url, opts = {}) => {
        const u = String(url);
        if (u.includes('/oauth/token')) return reply(200, { access_token: 'tok_service_token', token_type: 'Bearer', expires_in: 300, scope: 'ai.run.create' });
        const call = { url: u, method: opts.method || 'GET', headers: opts.headers || {}, body: opts.body ? JSON.parse(opts.body) : null };
        calls.push(call);
        if (u.endsWith('/v1/models')) return models(call);
        return chat(call);
    };
    return { calls, fetchImpl };
}

// The ai.model@1 catalog as AI serves it (OpenVibe.AI #289): aliases carry dynamic:true and no price; a registry
// model carries an exact id, its availability and integer nano-USD prices. The legacy `openvibe` is the alias name.
const CATALOG = {
    object: 'list',
    data: [
        { id: 'acme/m1:q4_k_m@rev1', object: 'model', dynamic: false, display_name: 'm1', availability: 'available', retail_rate: { input_nano_usd_per_m: '1000000000', output_nano_usd_per_m: '2500000000' }, capabilities: { tools: true } },
        { id: 'openvibe/fast', object: 'model', dynamic: true, policy: 'fastest', display_name: 'Fast', availability: 'available' },
        { id: 'acme/no-revision', object: 'model', dynamic: false, display_name: 'no exact id' },
        { id: 'openvibe', object: 'model', dynamic: true, display_name: 'OpenVibe AI' },
        { id: 'openvibe/auto', object: 'model', dynamic: true, policy: 'auto', display_name: 'Auto', availability: 'available' },
        { id: 'openvibe/private', object: 'model', dynamic: true, policy: 'private', display_name: 'Private', availability: 'available' },
        { id: 'acme/m2@rev2', object: 'model', dynamic: false, display_name: 'm2', availability: 'unavailable', retail_rate: { output_nano_usd_per_m: '123456789' } },
    ],
};

/** The OpenAI chat answer AI gives, with the route disclosure in x_openvibe. */
function answer({ status = 200, resolved = EXACT, cost = 0.0012, body = null } = {}) {
    if (body) return reply(status, body);
    return reply(status, {
        model: 'm1',
        choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
        x_openvibe: { resolved_model: resolved, revision: 'rev1', provider_access: 'OWN_DEPLOYMENT', rate_version: 'rr-1', policy: 'exact', fallback_reason: null, cost_usd: cost },
    });
}

(async () => {
    let t = null;
    try {
        await check('the catalog parses aliases first, then exact ids, with the output price exact', async () => {
            const entries = aiCatalog.parse(CATALOG);
            assert.ok(entries, 'a catalog with aliases and exact ids is usable');
            assert.deepStrictEqual(entries.map((e) => e.id), ['openvibe/auto', 'openvibe/fast', 'openvibe/private', 'acme/m1:q4_k_m@rev1', 'acme/m2@rev2'], 'aliases in D3 order, then exact ids; legacy openvibe and a non-exact id are left out');
            assert.deepStrictEqual([entries[0].dynamic, entries[3].dynamic], [true, false]);
            assert.deepStrictEqual(entries.slice(0, 3).map((e) => e.output_nano_usd_per_m), [null, null, null], 'an alias has no price of its own');
            assert.strictEqual(aiCatalog.priceDescription(entries[3].output_nano_usd_per_m), '$2.50 per million output tokens');
            assert.strictEqual(aiCatalog.priceDescription(entries[4].output_nano_usd_per_m), '$0.123456789 per million output tokens', 'nano-USD to dollars without a float');
            assert.strictEqual(aiCatalog.priceDescription('0'), '$0.00 per million output tokens');
            assert.strictEqual(aiCatalog.priceDescription('1000000000000'), '$1000.00 per million output tokens');
            assert.strictEqual(aiCatalog.priceDescription(null), 'Output price not listed');
            assert.deepStrictEqual(entries.map((e) => e.state), ['ok', 'ok', 'ok', 'ok', 'off'], 'availability as the select state');
            assert.strictEqual(entries[4].available, false, 'an unavailable exact id is not a choice');

            // The flag-off AI answer (one legacy model), an empty answer and rubbish are today's behaviour.
            assert.strictEqual(aiCatalog.parse({ object: 'list', data: [{ id: 'openvibe', object: 'model' }] }), null);
            assert.strictEqual(aiCatalog.parse({ object: 'list', data: [] }), null);
            assert.strictEqual(aiCatalog.parse(null), null);
            assert.strictEqual(aiCatalog.parse({ object: 'list', data: 'nope' }), null);
        });

        await check('flag off: no catalog call, and the page keeps the plain model field', async () => {
            const offline = fakeFetch({ models: () => { throw new Error('the catalog must not be read'); } });
            const models = createModels({ config: aiConfig(false), fetchImpl: offline.fetchImpl, log: LOG });
            assert.strictEqual(await models.aiCatalog(), null);
            assert.strictEqual(offline.calls.length, 0, 'no GET /v1/models and no token while the flag is off');

            t = await boot();
            const alice = t.network.addUser('catalog-off');
            const page = await t.get('/chat/model', { as: alice });
            assert.strictEqual(page.status, 200);
            assert.match(page.text, /<input name="model" value="" maxlength="120"/);
            assert.ok(!page.text.includes('<select name="model"'), 'no catalog select without the flag');
        });

        await check('flag on: GET /v1/models is read with Actor\'s service token and cached about five minutes', async () => {
            let clock = 1_000_000;
            const f = fakeFetch({ models: () => reply(200, CATALOG) });
            const models = createModels({ config: aiConfig(true), fetchImpl: f.fetchImpl, log: LOG, now: () => clock });
            const first = await models.aiCatalog();
            assert.deepStrictEqual(first.map((e) => e.id).slice(0, 3), ['openvibe/auto', 'openvibe/fast', 'openvibe/private']);
            assert.strictEqual(f.calls.length, 1);
            assert.strictEqual(f.calls[0].url, 'https://ai.test/v1/models');
            assert.strictEqual(f.calls[0].headers.Authorization, 'Bearer tok_service_token', 'the token Actor already uses');
            assert.ok(!JSON.stringify(f.calls[0]).includes('actor-secret'), 'the client secret never travels');
            const second = await models.aiCatalog();
            assert.deepStrictEqual(second, first);
            assert.strictEqual(f.calls.length, 1, 'a second read is cached');
            clock += aiCatalog.CACHE_MS + 1;
            await models.aiCatalog();
            assert.strictEqual(f.calls.length, 2, 'after five minutes it is read again');
        });

        await check('flag on, AI catalog off or a failed read: null, and the next use is today\'s behaviour', async () => {
            const legacy = fakeFetch({ models: () => reply(200, { object: 'list', data: [{ id: 'openvibe', object: 'model' }] }) });
            const a = createModels({ config: aiConfig(true), fetchImpl: legacy.fetchImpl, log: LOG });
            assert.strictEqual(await a.aiCatalog(), null, 'the legacy single model means no picker');

            const down = fakeFetch({ models: () => reply(503, { error: { message: 'down' } }) });
            const b = createModels({ config: aiConfig(true), fetchImpl: down.fetchImpl, log: LOG });
            assert.strictEqual(await b.aiCatalog(), null);
            assert.strictEqual(await b.aiCatalog(), null, 'a failure is cached too, not retried on every page');
            assert.strictEqual(down.calls.length, 1);
        });

        await check('an exact id is sent unchanged as model, and its disclosure is the run\'s model and cost', async () => {
            const f = fakeFetch({ chat: () => answer() });
            const models = createModels({ config: aiConfig(true), fetchImpl: f.fetchImpl, log: LOG });
            const r = await models.withChoice({ subject: PERSON, provider: 'openai', model: EXACT }, () => models.chat({
                tier: 'smart', messages: [{ role: 'user', content: 'hello' }],
            }));
            assert.strictEqual(f.calls.length, 1, 'one call to AI');
            assert.strictEqual(f.calls[0].body.model, EXACT, 'the exact id is sent unchanged');
            assert.strictEqual(f.calls[0].body.prefer.model, EXACT, 'the soft preference names the same id');
            assert.strictEqual(f.calls[0].headers['x-openvibe-credential'], 'openai:' + PERSON);
            assert.strictEqual(r.model, EXACT, 'the model the run records is x_openvibe.resolved_model');
            assert.strictEqual(r.resolved_model, EXACT);
            assert.strictEqual(r.cost_usd, 0.0012, 'the cost is x_openvibe.cost_usd');
            assert.strictEqual(r.text, 'hello');
            // The same id is what the pages show and the trace records, not split at the quant or sanitised.
            const { modelName } = require('../server/http/pages');
            const { safeName } = require('../server/runtime/trace');
            assert.strictEqual(modelName(EXACT), EXACT);
            assert.strictEqual(safeName(EXACT), EXACT);

            // A dynamic alias is likewise sent unchanged.
            const g = fakeFetch({ chat: () => answer({ resolved: 'acme/m1@rev1' }) });
            const models2 = createModels({ config: aiConfig(true), fetchImpl: g.fetchImpl, log: LOG });
            const a = await models2.withChoice({ subject: PERSON, provider: 'openai', model: 'openvibe/economy' }, () => models2.chat({ tier: 'smart', messages: [{ role: 'user', content: 'hi' }] }));
            assert.strictEqual(g.calls[0].body.model, 'openvibe/economy');
            assert.strictEqual(a.model, 'acme/m1@rev1', 'the alias says which model answered');
        });

        await check('a streamed answer records the final x_openvibe too', async () => {
            const chunk = (o) => `data: ${JSON.stringify(o)}\n\n`;
            const sse = chunk({ model: 'm1', choices: [{ index: 0, delta: { role: 'assistant', content: 'hel' }, finish_reason: null }] })
                + chunk({ model: 'm1', choices: [{ index: 0, delta: { content: 'lo' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } })
                + chunk({ model: 'm1', choices: [], x_openvibe: { resolved_model: EXACT, cost_usd: 0.003 } });
            const f = fakeFetch({ chat: () => new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } }) });
            const models = createModels({ config: aiConfig(true), fetchImpl: f.fetchImpl, log: LOG });
            const r = await models.withChoice({ subject: PERSON, provider: 'openai', model: EXACT }, () => models.chat({ tier: 'smart', messages: [{ role: 'user', content: 'hello' }], onDelta: () => {} }));
            assert.strictEqual(r.model, EXACT);
            assert.strictEqual(r.cost_usd, 0.003);
        });

        await check('an exact id AI refuses is that error, one call, never another model', async () => {
            const cases = [
                [404, 'ai.model_not_found', 'no artifact ' + EXACT, 'No artifact'],
                [400, 'ai.model_unavailable', 'the artifact ' + EXACT + ' has no active deployment', 'no active deployment'],
            ];
            for (const [status, code, message] of cases) {
                const f = fakeFetch({ chat: () => reply(status, { error: { message, type: 'invalid_request_error', code, param: null } }) });
                const models = createModels({ config: aiConfig(true), fetchImpl: f.fetchImpl, log: LOG });
                await assert.rejects(
                    () => models.withChoice({ subject: PERSON, provider: 'openai', model: EXACT }, () => models.chat({ tier: 'smart', messages: [{ role: 'user', content: 'hello' }] })),
                    (err) => {
                        assert.strictEqual(err.code, code, 'AI\'s own code is shown');
                        assert.strictEqual(err.message, message, 'AI\'s own detail is shown');
                        return true;
                    },
                );
                assert.strictEqual(f.calls.length, 1, `${code}: no retry on another model`);
            }
        });

        await check('a refused exact id fails the person\'s task with AI\'s error, never another model', async () => {
            const aiCalls = [];
            const f = fakeFetch({
                models: () => reply(200, { data: [{ id: 'gpt-5-mini' }] }),
                chat: (call) => {
                    aiCalls.push(call);
                    return reply(404, { error: { message: 'no artifact ' + EXACT, type: 'invalid_request_error', code: 'ai.model_not_found', param: null } });
                },
            });
            // The operator's own tier must resolve for the loop to start; this checks the person's AI choice does win.
            const cfg = aiConfig(true);
            cfg.providers = { openai: { apiKey: 'sk-fixture-operator-key', baseUrl: 'https://api.openai.test/v1', model: 'gpt-5-mini' } };
            const models = createModels({ config: cfg, fetchImpl: f.fetchImpl, log: LOG });
            const tb = await boot({ env: { ACTOR_AI_CATALOG: '1' }, models });
            try {
                const user = tb.network.addUser('catalog-refused');
                const put = await tb.get('/api/v1/me/model', { as: user, method: 'PUT', json: { choice: 'own:openai', model: EXACT }, headers: SAME });
                assert.strictEqual(put.status, 200, put.text);
                const read = await tb.get('/api/v1/me/model', { as: user });
                assert.deepStrictEqual([read.json().choice, read.json().model], ['own:openai', EXACT], read.text);
                const made = await tb.get('/api/v1/tasks', { as: user, json: { task: 'Say hello', mode: 'balanced' }, headers: SAME });
                assert.strictEqual(made.status, 201, made.text);
                const row = await tb.waitFor(made.json().id);
                assert.strictEqual(row.state, 'failed');
                assert.strictEqual(row.error_code, 'ai.model_not_found', `the task shows AI's own error code (${row.error_code}: ${row.error_detail})`);
                assert.strictEqual(row.error_detail, 'no artifact ' + EXACT, 'and AI\'s own detail');
                const chats = aiCalls.filter((c) => c.url.endsWith('/v1/chat/completions'));
                assert.ok(chats.length >= 1, 'the run asked OpenVibe.AI');
                assert.ok(chats.every((c) => c.body.model === EXACT), 'every call names the exact id; nothing is substituted');
            } finally { await tb.close(); }
        });

        await check('the page offers aliases first, then exact ids, priced and available; a saved exact id is kept', async () => {
            const entries = aiCatalog.parse(CATALOG);
            const stub = { warm: async () => ({}), aiCatalog: async () => entries };
            const tb = await boot({ env: { ACTOR_AI_CATALOG: '1' }, models: stub });
            try {
                const alice = tb.network.addUser('catalog-on');
                const page = await tb.get('/chat/model', { as: alice });
                assert.strictEqual(page.status, 200);
                assert.match(page.text, /<select name="model" data-ov-title="A model for OpenVibe.AI">/);
                assert.ok(page.text.indexOf('openvibe/auto') < page.text.indexOf(EXACT), 'aliases come before exact ids');
                assert.match(page.text, /<option value="openvibe\/auto"[^>]*data-badge="Dynamic"[^>]*data-desc="Dynamic: the router picks/);
                assert.match(page.text, new RegExp(`<option value="${EXACT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^>]*data-desc="\\$2.50 per million output tokens"[^>]*data-state="ok"`));
                assert.match(page.text, /<option value="acme\/m2@rev2"[^>]*data-desc="\$0.123456789 per million output tokens"[^>]*data-state="off" disabled>/, 'unavailable is shown as off and cannot be chosen');

                const put = await tb.get('/api/v1/me/model', { as: alice, method: 'PUT', json: { choice: 'own:openai', model: EXACT }, headers: SAME });
                assert.strictEqual(put.status, 200, put.text);
                assert.strictEqual(put.json().model, EXACT, 'the exact id is stored unchanged');
                const after = await tb.get('/chat/model', { as: alice });
                assert.match(after.text, new RegExp(`<option value="${EXACT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}" selected`));
            } finally { await tb.close(); }
        });

        await check('flag off: an exact id is still refused by today\'s model rule', async () => {
            t = t || await boot();
            const alice = t.network.addUser('catalog-off-exact');
            const put = await t.get('/api/v1/me/model', { as: alice, method: 'PUT', json: { choice: 'own:openai', model: EXACT }, headers: SAME });
            assert.strictEqual(put.status, 422);
            assert.strictEqual(put.json().code, 'actor.model.invalid');
        });
    } finally {
        if (t) await t.close();
    }

    done();
})();

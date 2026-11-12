'use strict';
/**
 * The AI meter for Actor's own model calls (ai-metrics.md): every call through the tier layer carries the task id,
 * its provider and model, TTFT, tokens per second and its tokens; a failure carries its class; the one process client
 * posts the records to AI's /api/v1/usage/calls with Actor's service token.
 */
const assert = require('assert');
const http = require('node:http');
const configLib = require('../server/config');
const { createModels } = require('../server/runtime/models');
const { createAiMeter } = require('../server/runtime/ai-meter');
const { RATES } = require('../server/agents/catalog');

const results = [];
const ok = async (name, fn) => { try { await fn(); console.log(`  ✓ ${name}`); } catch (e) { results.push(e); console.log(`  ✗ ${name}\n      ${(e.stack || String(e)).split('\n').slice(0, 7).join('\n      ')}`); } };

const quiet = { log() {}, warn() {} };
const json = (status, obj) => ({ ok: status >= 200 && status < 300, status, headers: { get: () => 'application/json' }, json: async () => obj, text: async () => JSON.stringify(obj) });

const env = {
    NODE_ENV: 'test',
    ACTOR_DEEPSEEK_API_KEY: 'ds', ACTOR_DEEPSEEK_BASE_URL: 'https://deepseek.test',
    ACTOR_MODEL_SMART: 'deepseek:deepseek-v4-flash',
};

function provider({ usage, answer = 'the answer', toolCalls = null, status = 200, error = null, onFetched = null } = {}) {
    const seen = [];
    const fetchImpl = async (url, opts = {}) => {
        const u = String(url);
        if (u.endsWith('/models')) return json(200, { data: [{ id: 'deepseek-v4-flash' }] });
        seen.push({ url: u, body: opts.body ? JSON.parse(opts.body) : null });
        if (onFetched) onFetched();
        if (status !== 200) return json(status, error || { error: { message: 'no' } });
        const message = { role: 'assistant', content: answer, ...(toolCalls ? { tool_calls: toolCalls } : {}) };
        return json(200, { model: 'deepseek-v4-flash', choices: [{ message, finish_reason: 'stop' }], usage });
    };
    return { fetchImpl, seen };
}

const tickingMeter = () => ({ records: [], record(rec) { this.records.push(rec); return true; } });

(async () => {
    await ok('a provider call records TTFT, TPS, tokens, the provider and the task id', async () => {
        let t = 10000;
        const usage = { prompt_tokens: 1200, completion_tokens: 300, prompt_tokens_details: { cached_tokens: 1000 } };
        const stub = provider({ usage, onFetched: () => { t += 800; } });
        const meter = tickingMeter();
        const models = createModels({ config: configLib.load(env), rates: RATES, fetchImpl: stub.fetchImpl, log: quiet, meter, now: () => t });
        await models.warm();
        const meta = { taskId: 'tsk_meter', task: 'actor.task', startedAt: 10000, seq: 0 };
        const r = await models.withMetering(meta, () => models.chat({
            tier: 'smart', messages: [{ role: 'user', content: 'x' }], onDelta: () => { t += 3000; }, taskEnd: true,
        }));
        assert.strictEqual(r.provider, 'deepseek');
        assert.strictEqual(r.text, 'the answer');
        assert.strictEqual(meter.records.length, 1);
        const rec = meter.records[0];
        assert.strictEqual(rec.system, 'actor');
        assert.strictEqual(rec.task_id, 'tsk_meter');
        assert.strictEqual(rec.turn_id, 'tsk_meter:1');
        assert.strictEqual(rec.provider, 'deepseek');
        assert.strictEqual(rec.model, 'deepseek-v4-flash');
        assert.strictEqual(rec.operation, 'chat');
        assert.strictEqual(rec.task, 'actor.task');
        assert.strictEqual(rec.harness, 'openvibe');
        assert.strictEqual(rec.place, 'provider');
        assert.strictEqual(rec.streamed, true);
        assert.strictEqual(rec.outcome, 'succeeded');
        assert.deepStrictEqual([rec.input, rec.output, rec.cache_read], [200, 300, 1000]);
        assert.deepStrictEqual([rec.ttft_ms, rec.latency_ms, rec.tps], [800, 3800, 100]);
        assert.strictEqual(rec.task_ms, 3800, 'the task\'s wall time on its last step');
    });

    await ok('tool calls are counted, and a step with tools is not the task\'s last', async () => {
        let t = 5000;
        const calls = [{ id: 'c1', type: 'function', function: { name: 'lookup', arguments: '{}' } }, { id: 'c2', type: 'function', function: { name: 'search_web', arguments: '{}' } }];
        const stub = provider({ usage: { prompt_tokens: 100, completion_tokens: 10 }, toolCalls: calls, onFetched: () => { t += 100; } });
        const meter = tickingMeter();
        const models = createModels({ config: configLib.load(env), rates: RATES, fetchImpl: stub.fetchImpl, log: quiet, meter, now: () => t });
        await models.warm();
        const meta = { taskId: 'tsk_tools', startedAt: 5000, seq: 0 };
        const r = await models.withMetering(meta, () => models.chat({ tier: 'smart', messages: [{ role: 'user', content: 'x' }], taskEnd: true }));
        assert.strictEqual(r.toolCalls.length, 2);
        assert.strictEqual(meter.records[0].tool_calls, 2);
        assert.strictEqual(meter.records[0].task_ms, undefined);
    });

    await ok('a failed call records outcome failed and its class; metering never hides the error', async () => {
        const stub = provider({ status: 429, error: { error: { message: 'slow down' } } });
        const meter = tickingMeter();
        const models = createModels({ config: configLib.load(env), rates: RATES, fetchImpl: stub.fetchImpl, log: quiet, meter });
        await models.warm();
        await assert.rejects(
            () => models.withMetering({ taskId: 'tsk_fail', startedAt: 1, seq: 0 }, () => models.chat({ tier: 'smart', messages: [{ role: 'user', content: 'x' }] })),
            (err) => err && err.code === 'actor.provider.rate_limited',
        );
        assert.strictEqual(meter.records.length, 1);
        assert.strictEqual(meter.records[0].outcome, 'failed');
        assert.strictEqual(meter.records[0].error_class, 'actor.provider.rate_limited');
        assert.strictEqual(meter.records[0].task_id, 'tsk_fail');
        assert.strictEqual(meter.records[0].turn_id, 'tsk_fail:1');
    });

    await ok('the meter client posts the records to a stub AI with Actor\'s service token', async () => {
        const seen = [];
        const tokenRequests = [];
        const server = http.createServer((req, res) => {
            let body = '';
            req.on('data', (c) => { body += c; });
            req.on('end', () => {
                if (req.url === '/oauth/token') {
                    tokenRequests.push(body);
                    res.writeHead(200, { 'content-type': 'application/json' });
                    return res.end(JSON.stringify({ access_token: 'tok_actor', token_type: 'Bearer', expires_in: 300, scope: 'ai.usage.report' }));
                }
                seen.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body) });
                res.writeHead(202, { 'content-type': 'application/json' });
                res.end('{}');
            });
        });
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        const url = `http://127.0.0.1:${server.address().port}`;
        let meter = null;
        try {
            const config = configLib.load({
                NODE_ENV: 'production', OV_OAUTH_CLIENT_SECRET: 'secret', OV_NETWORK_INTERNAL_URL: url,
                OV_AI_URL: url, ACTOR_AI_ROUTER: '0',
            });
            meter = createAiMeter({ config, log: quiet });
            assert.ok(meter, 'a hosted Actor with a secret has a meter');
            meter.record({ system: 'actor', turn_id: 'tsk_post:1', provider: 'deepseek', model: 'deepseek-v4-flash', outcome: 'succeeded', at: new Date().toISOString(), input: 1, output: 1 });
            await meter.flush();
            assert.strictEqual(seen.length, 1);
            assert.strictEqual(seen[0].url, '/api/v1/usage/calls');
            assert.strictEqual(seen[0].auth, 'Bearer tok_actor');
            assert.strictEqual(seen[0].body.calls.length, 1);
            assert.strictEqual(seen[0].body.calls[0].turn_id, 'tsk_post:1');
            assert.strictEqual(new URLSearchParams(tokenRequests[0]).get('scope'), 'ai.usage.report');
            assert.strictEqual(createAiMeter({ config: configLib.load({ ...env, ACTOR_DRILL: '1' }), log: quiet }), null, 'off in a drill');
            assert.strictEqual(createAiMeter({ config: configLib.load(env), log: quiet }), null, 'off in tests');
        } finally {
            if (meter) await meter.close();
            await new Promise((resolve) => server.close(resolve));
        }
    });

    if (results.length) { console.log(`\n${results.length} failed`); process.exit(1); }
    console.log('\nall passed');
})();

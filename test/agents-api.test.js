'use strict';
const assert = require('assert');
const crypto = require('crypto');
const { serviceAuth } = require('openvibe-contracts');
const { boot, check, done } = require('./helpers/boot');

const SAME = { 'sec-fetch-site': 'same-origin' };
const data = (name) => ({ name, instructions: `Help with ${name}.`, mode: 'balanced', budget_per_run_usd: 0.02, daily_runs_max: 2, schedule: 'off', status: 'active' });

(async () => {
    const t = await boot();
    try {
        const alice = t.network.addUser('agent-alice');
        const bob = t.network.addUser('agent-bob');
        const post = (path, json, as = alice) => t.get(path, { as, json, headers: SAME });
        await check('agent CRUD, validation and owner 404', async () => {
            assert.strictEqual((await post('/api/v1/me/agents', { ...data('bad'), name: '' })).status, 422);
            const created = await post('/api/v1/me/agents', data('News'));
            assert.strictEqual(created.status, 201);
            const id = created.json().id;
            assert.ok(id.startsWith('agt_'));
            assert.strictEqual((await t.get(`/api/v1/me/agents/${id}`, { as: bob })).status, 404);
            assert.strictEqual((await t.get('/api/v1/me/agents', { as: alice })).json().agents.length, 1);
            const patched = await t.get(`/api/v1/me/agents/${id}`, { as: alice, method: 'PATCH', json: { name: 'Reports' }, headers: SAME });
            assert.strictEqual(patched.status, 200);
            assert.strictEqual(patched.json().name, 'Reports');
            const run = await post(`/api/v1/me/agents/${id}/run`, { input: 'Say hello.' });
            assert.strictEqual(run.status, 201);
            const taskId = run.json().id;
            const deleted = await t.get(`/api/v1/me/agents/${id}`, { as: alice, method: 'DELETE', headers: SAME });
            assert.strictEqual(deleted.status, 204);
            assert.strictEqual((await t.get(`/api/v1/me/agents/${id}`, { as: alice })).status, 404);
            assert.strictEqual((await t.get(`/api/v1/tasks/${taskId}`, { as: alice })).status, 200);
            await t.waitFor(taskId);
        });
        await check('ten agent maximum', async () => {
            for (let i = 0; i < 10; i++) assert.strictEqual((await post('/api/v1/me/agents', data(`Agent ${i}`))).status, 201);
            const over = await post('/api/v1/me/agents', data('Over'));
            assert.strictEqual(over.status, 429);
            assert.strictEqual(over.json().code, 'actor.agent.limit');
        });
        await check('token capabilities are checked', async () => {
            const mint = (cap) => { const now = Math.floor(Date.now() / 1000); return serviceAuth.signServiceToken({ iss: t.network.url, sub: 'svc:watch', actor_type: 'service', aud: ['openvibe.actor'], cap, iat: now, exp: now + 300, jti: crypto.randomUUID() }, t.network.privatePem); };
            const headers = { 'x-ov-subject': alice.subject };
            assert.strictEqual((await t.get('/api/v1/me/agents', { bearer: mint([]), headers })).status, 403);
            assert.strictEqual((await t.get('/api/v1/me/agents', { bearer: mint(['actor.agent.manage']), headers })).status, 200);
            const created = await t.get('/api/v1/me/agents', { bearer: mint(['actor.agent.manage']), headers, json: data('Service') });
            // Owner is already at its ten-agent cap, so the grant passes the guard and the limit answers.
            assert.strictEqual(created.status, 429);
            const run = await t.get('/api/v1/me/agents/agt_01JZ0000000000000000000AAA/run', { bearer: mint(['actor.agent.manage']), headers, json: {} });
            assert.strictEqual(run.status, 403);
        });
    } finally { await t.close(); }
    done();
})();

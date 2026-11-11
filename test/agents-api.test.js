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
        await check('ten agent maximum, Vibe included', async () => {
            // The run above created Vibe, the person's first contact (A-1); the ten-agent cap counts it.
            assert.strictEqual(Number(await t.ctx.s.db.value('SELECT count(*) FROM actor_agents WHERE owner = $1 AND is_vibe', [`user:${alice.subject}`])), 1);
            for (let i = 0; i < 9; i++) assert.strictEqual((await post('/api/v1/me/agents', data(`Agent ${i}`))).status, 201);
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
        await check('Chat can follow only the personal agent run it started for its owner', async () => {
            const person = t.network.addUser('channel-agent-owner');
            const created = await post('/api/v1/me/agents', data('Researcher'), person);
            assert.strictEqual(created.status, 201, created.text);
            const id = created.json().id;
            const now = Math.floor(Date.now() / 1000);
            const mint = (sub, cap) => serviceAuth.signServiceToken({ iss: t.network.url, sub, actor_type: 'service', aud: ['openvibe.actor'], cap,
                iat: now, exp: now + 300, jti: crypto.randomUUID() }, t.network.privatePem);
            const chat = mint('svc:chat', ['actor.agent.run', 'actor.task.read']);
            const other = mint('svc:watch', ['actor.task.read']);
            const headers = { 'X-OV-Subject': person.subject };
            const started = await t.get(`/api/v1/me/agents/${id}/run`, { bearer: chat, headers, json: { input: 'Say hello to the channel.' } });
            assert.strictEqual(started.status, 201, started.text);
            const taskId = started.json().id;
            const row = await require('../server/tasks/store').getTask(t.ctx.s, taskId);
            assert.deepStrictEqual([row.via, row.delegated_via], [`agent:${id}`, 'service:chat']);
            assert.strictEqual((await t.get(`/api/v1/tasks/${taskId}`, { bearer: chat, headers })).status, 200);
            assert.strictEqual((await t.get(`/api/v1/tasks/${taskId}`, { bearer: other, headers })).status, 404);
            assert.strictEqual((await t.get(`/api/v1/tasks/${taskId}`, { as: person })).status, 200);
            const ownRun = await post(`/api/v1/me/agents/${id}/run`, { input: 'Private work.' }, person);
            assert.strictEqual(ownRun.status, 201, ownRun.text);
            assert.strictEqual((await t.get(`/api/v1/tasks/${ownRun.json().id}`, { bearer: chat, headers })).status, 404);
        });
    } finally { await t.close(); }
    done();
})();

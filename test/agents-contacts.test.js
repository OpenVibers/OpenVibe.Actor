'use strict';
/**
 * A-1 (plan §12): agents are contacts. A person's GET /api/v1/agents is their own list, with Vibe created on that first
 * read and never deletable; GET /api/v1/agent-systems (and the old public GET without a person) is still the catalog.
 * The four presets are data a create can copy; CRUD is owner-scoped; PUT .../level takes actor.level-change@1. Tasks
 * gain the contact they run as (default Vibe) and their own level, and the effective level is inherited only along the
 * same person's parent chain.
 */
const assert = require('assert');
const contracts = require('openvibe-contracts');
const { boot, check, done } = require('./helpers/boot');
const store = require('../server/tasks/store');
const contacts = require('../server/agents/contacts');

const SAME = { 'sec-fetch-site': 'same-origin' };
const PRESET_NAMES = ['Researcher', 'Inbox', 'Studio editor', 'Party host'];

(async () => {
    const t = await boot();
    try {
        const alice = t.network.addUser('contacts-alice');
        const bob = t.network.addUser('contacts-bob');
        const owner = `user:${alice.subject}`;
        const post = (path, json, as = alice) => t.get(path, { as, json, headers: SAME });
        let vibe;

        await check('a signed-in GET /api/v1/agents is the person\'s contacts, Vibe first and created on the first read', async () => {
            const r = await t.get('/api/v1/agents', { as: alice });
            assert.strictEqual(r.status, 200, r.text);
            const body = r.json();
            assert.deepStrictEqual(contracts.validate('actor.agent-list@1', body).errors, []);
            assert.strictEqual(body.agents.length, 1);
            vibe = body.agents[0];
            assert.strictEqual(vibe.name, 'Vibe');
            assert.match(vibe.id, /^agt_/);
            assert.deepStrictEqual([vibe.owner, vibe.level, vibe.model.engine], [owner, 'ask', 'runtime']);
            assert.strictEqual(Number(await t.ctx.s.db.value('SELECT count(*) FROM actor_agents WHERE owner = $1 AND is_vibe', [owner])), 1, 'one Vibe');
            // A second read does not make a second Vibe.
            assert.deepStrictEqual((await t.get('/api/v1/agents', { as: alice })).json().agents.map((a) => a.id), [vibe.id]);
        });

        await check('the public catalog stays: no person gets the systems, and /agent-systems always does', async () => {
            const anon = await t.get('/api/v1/agents');
            assert.strictEqual(anon.status, 200);
            assert.deepStrictEqual(contracts.validate('actor.agent-list-result@2', anon.json()).errors, []);
            const explicit = await t.get('/api/v1/agent-systems', { as: alice });
            assert.deepStrictEqual(explicit.json(), anon.json(), 'a signed-in caller can still read the catalog');
            assert.ok(anon.json().agents.some((a) => a.id === 'openvibe-runtime'));
        });

        await check('GET /api/v1/agents/presets answers the four presets as data; none is a person\'s row', async () => {
            const r = await t.get('/api/v1/agents/presets');
            assert.strictEqual(r.status, 200);
            const presets = r.json().presets;
            assert.deepStrictEqual(presets.map((p) => p.name), PRESET_NAMES);
            for (const p of presets) {
                for (const k of ['id', 'name', 'face', 'voice', 'model', 'computer', 'apps', 'memory', 'level', 'instructions']) assert.ok(k in p, `${p.id} has no ${k}`);
                assert.strictEqual(p.level, 'ask');
            }
            assert.strictEqual(Number(await t.ctx.s.db.value('SELECT count(*) FROM actor_agents WHERE preset IS NOT NULL')), 0);
        });

        await check('creating from a preset copies it; CRUD is owner-scoped and PATCH is partial', async () => {
            const made = await post('/api/v1/agents', { preset: 'researcher', name: 'Ada' });
            assert.strictEqual(made.status, 201, made.text);
            const agent = made.json();
            assert.deepStrictEqual(contracts.validate('actor.agent@1', agent).errors, []);
            assert.deepStrictEqual([agent.name, agent.owner, agent.model.engine, agent.level], ['Ada', owner, 'runtime', 'ask']);
            assert.deepStrictEqual(agent.computer, { kind: 'kept-browser', placement: 'auto' });
            assert.match(made.headers.get('location'), new RegExp(agent.id));
            const read = await t.get(`/api/v1/agents/${agent.id}`, { as: alice });
            assert.deepStrictEqual(read.json(), agent);
            const patched = await t.get(`/api/v1/agents/${agent.id}`, { as: alice, method: 'PATCH', json: { name: 'Researcher Ada', level: 'auto-edits' }, headers: SAME });
            assert.strictEqual(patched.status, 200, patched.text);
            assert.deepStrictEqual([patched.json().name, patched.json().level, patched.json().model.engine], ['Researcher Ada', 'auto-edits', 'runtime']);
            if (bob) {
                assert.strictEqual((await t.get(`/api/v1/agents/${agent.id}`, { as: bob })).status, 404);
                assert.strictEqual((await t.get(`/api/v1/agents/${agent.id}`, { as: bob, method: 'PATCH', json: { name: 'x' }, headers: SAME })).status, 404);
                assert.strictEqual((await t.get(`/api/v1/agents/${agent.id}`, { as: bob, method: 'DELETE', headers: SAME })).status, 404);
            }
            assert.strictEqual((await t.get('/api/v1/agents', { as: alice })).json().agents.length, 2);
        });

        await check('PUT .../level takes actor.level-change@1 and refuses anything else', async () => {
            const r = await t.get(`/api/v1/agents/${vibe.id}/level`, { as: alice, method: 'PUT', json: { level: 'full' }, headers: SAME });
            assert.strictEqual(r.status, 200, r.text);
            assert.deepStrictEqual(contracts.validate('actor.agent@1', r.json()).errors, []);
            assert.strictEqual(r.json().level, 'full');
            const bad = await t.get(`/api/v1/agents/${vibe.id}/level`, { as: alice, method: 'PUT', json: { level: 'everything' }, headers: SAME });
            assert.strictEqual(bad.status, 422);
            assert.strictEqual(bad.json().code, 'actor.agent.invalid');
            const extra = await t.get(`/api/v1/agents/${vibe.id}/level`, { as: alice, method: 'PUT', json: { level: 'ask', owner: 'somebody' }, headers: SAME });
            assert.strictEqual(extra.status, 422);
        });

        await check('Vibe is not deletable on either route; other contacts are', async () => {
            const old = await t.get(`/api/v1/me/agents/${vibe.id}`, { as: alice, method: 'DELETE', headers: SAME });
            assert.strictEqual(old.status, 409);
            assert.strictEqual(old.json().code, 'actor.agent.vibe');
            const fresh = await t.get(`/api/v1/agents/${vibe.id}`, { as: alice, method: 'DELETE', headers: SAME });
            assert.strictEqual(fresh.status, 409);
            assert.strictEqual(fresh.json().code, 'actor.agent.vibe');
            const mine = (await t.get('/api/v1/agents', { as: alice })).json().agents.find((a) => a.id !== vibe.id);
            assert.strictEqual((await t.get(`/api/v1/agents/${mine.id}`, { as: alice, method: 'DELETE', headers: SAME })).status, 204);
            assert.strictEqual((await t.get(`/api/v1/agents/${mine.id}`, { as: alice })).status, 404);
        });

        await check('bad creates are 422 with a reason; a signed-out create is a 401, not a row', async () => {
            for (const body of [
                { name: '' }, { name: 'x', level: 'sometimes' }, { name: 'x', model: { engine: 'toaster', model: 'x' } },
                { name: 'x', computer: { kind: 'toaster', placement: 'auto' } }, { name: 'x', apps: ['Not An App'] },
                { name: 'x', owner: 'user:someone' }, { preset: 'unknown' },
            ]) {
                const r = await post('/api/v1/agents', body);
                assert.strictEqual(r.status, 422, `${JSON.stringify(body)} answered ${r.status}`);
                assert.strictEqual(r.json().code, 'actor.agent.invalid');
            }
            assert.strictEqual((await t.get('/api/v1/agents', { json: { name: 'Nope' } })).status, 401);
        });

        await check('a task records its contact (default Vibe) and its level; effective max comes from the person\'s own line', async () => {
            const aliceAgent = (await t.get('/api/v1/agents', { as: alice })).json().agents[0];
            const made = await post('/api/v1/tasks', { task: 'Say hello in one word.', agent_id: aliceAgent.id, level: 'auto-edits' });
            assert.strictEqual(made.status, 201, made.text);
            const task = made.json();
            assert.deepStrictEqual([task.agent_id, task.agent_level, task.level, task.effective_level], [aliceAgent.id, 'full', 'auto-edits', 'full']);
            await t.waitFor(task.id);
            const later = await t.get(`/api/v1/tasks/${task.id}`, { as: alice });
            assert.deepStrictEqual([later.json().agent_id, later.json().effective_level], [aliceAgent.id, 'full']);

            // A parent of the same person raises it; another person's parent never does.
            const mk = (requester, level, parent = null, agent = null) => store.insertTask(t.ctx.s, {
                id: t.ctx.s.newId('tsk'), requester, task: 'thread', mode: 'balanced', agent: null,
                budget_task: 0.01, budget_day: 1, created_at: t.ctx.s.iso(), agent_id: agent, level, parent_id: parent,
            });
            const parent = await mk(owner, 'auto-edits');
            const child = await mk(owner, 'ask', parent.id);
            assert.strictEqual(await contacts.effectiveLevelFor(t.ctx.s, child, aliceAgent), 'full');
            const otherParent = await mk(`user:${bob.subject}`, 'full');
            const outside = await mk(owner, 'ask', otherParent.id);
            assert.strictEqual(await contacts.effectiveLevelFor(t.ctx.s, outside, { ...aliceAgent, level: 'ask' }), 'ask', 'never inherit from outside work');
            const ownAgent = { ...aliceAgent, level: 'approve-for-me' };
            assert.strictEqual(await contacts.effectiveLevelFor(t.ctx.s, { ...child, level: 'ask' }, ownAgent), 'approve-for-me');
        });
    } finally { await t.close(); }
    done();
})().catch((e) => { console.error(e); process.exit(1); });

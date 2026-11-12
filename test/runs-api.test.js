'use strict';
/**
 * The one agent system's read-only view of Actor's runs (agents.run@1, agents.step@1; OpenVibe.Contracts
 * docs/agents-runs.md). Actor's task is the run: the person's own tasks are listed and read, their task events are
 * the steps, and nobody else sees them. The older agent.run@1 snapshot stays at GET /runs/:id unless the reader asks
 * for the new shape with the media type or ?shape=agents.run@1.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

const AGENTS = 'application/vnd.openvibe.agents.run+json';
const STATUS = new Set(['planning', 'running', 'waiting', 'done', 'failed', 'stopped']);
const KIND = new Set(['think', 'tool', 'message', 'approval', 'child', 'file']);

(async () => {
    const t = await boot();
    const kim = t.network.addUser('kim');
    const lee = t.network.addUser('lee');
    const create = async (user, task) => {
        t.providers.reset();
        t.providers.state.script = [{ content: 'The answer is 42.' }];
        const r = await t.get('/api/v1/tasks', { as: user, json: { task }, headers: { 'sec-fetch-site': 'same-origin' } });
        assert.strictEqual(r.status, 201, r.text);
        const id = r.json().id;
        await t.waitFor(id);
        return id;
    };

    try {
        const kimTask = await create(kim, 'What is the answer?');
        const leeTask = await create(lee, 'What is my answer?');

        await check('GET /api/v1/runs lists only the person\'s own runs in the agents.run@1 shape', async () => {
            const r = await t.get('/api/v1/runs', { as: kim });
            assert.strictEqual(r.status, 200, r.text);
            const body = r.json();
            assert.ok(Array.isArray(body.runs) && body.runs.length === 1, JSON.stringify(body));
            const run = body.runs[0];
            assert.strictEqual(run.id, kimTask);
            assert.strictEqual(run.owner.type, 'user');
            assert.strictEqual(run.owner.id, kim.subject);
            assert.strictEqual(run.agent.product, 'actor');
            assert.ok(run.agent.id);
            assert.ok(STATUS.has(run.status), run.status);
            assert.ok(run.created_at && run.updated_at);
            assert.ok(run.budget && Number.isFinite(run.budget.usd));
            assert.ok(run.cost && Number.isFinite(run.cost.usd));
            assert.ok(!body.runs.some((x) => x.id === leeTask), 'another person\'s run is not listed');
            assert.strictEqual(body.next, null);
        });

        await check('GET /api/v1/runs/:id returns agents.run@1 when asked, scoped to its owner', async () => {
            const next = await t.get(`/api/v1/runs/${kimTask}`, { as: kim, headers: { accept: AGENTS } });
            assert.strictEqual(next.status, 200, next.text);
            const run = next.json();
            assert.strictEqual(run.id, kimTask);
            assert.strictEqual(run.owner.id, kim.subject);
            assert.ok(STATUS.has(run.status));
            const query = await t.get(`/api/v1/runs/${kimTask}?shape=agents.run@1`, { as: kim });
            assert.strictEqual(query.status, 200, query.text);
            assert.strictEqual(query.json().id, kimTask);
            const elsewhere = await t.get(`/api/v1/runs/${leeTask}`, { as: kim, headers: { accept: AGENTS } });
            assert.strictEqual(elsewhere.status, 404);
            const stranger = await t.get(`/api/v1/runs/${kimTask}`, { as: lee, headers: { accept: AGENTS } });
            assert.strictEqual(stranger.status, 404);
        });

        await check('GET /api/v1/runs/:id/steps reads the task event log as agents.step@1', async () => {
            const r = await t.get(`/api/v1/runs/${kimTask}/steps`, { as: kim });
            assert.strictEqual(r.status, 200, r.text);
            const body = r.json();
            assert.strictEqual(body.run_id, kimTask);
            assert.ok(Array.isArray(body.steps) && body.steps.length > 0, JSON.stringify(body));
            let previous = 0;
            for (const step of body.steps) {
                assert.strictEqual(step.run_id, kimTask);
                assert.ok(Number.isInteger(step.seq) && step.seq > previous, `seq ${step.seq} after ${previous}`);
                assert.ok(KIND.has(step.kind), step.kind);
                assert.ok(step.started_at);
                previous = step.seq;
            }
            assert.ok(body.steps.some((s) => s.kind === 'message'), 'the answer is a message step');
            const after = await t.get(`/api/v1/runs/${kimTask}/steps?after=${previous}`, { as: kim });
            assert.deepStrictEqual(after.json().steps, []);
            const stranger = await t.get(`/api/v1/runs/${kimTask}/steps`, { as: lee });
            assert.strictEqual(stranger.status, 404);
        });

        await check('the run read is behind the task grants and refuses a bad status filter', async () => {
            assert.strictEqual((await t.get('/api/v1/runs')).status, 401);
            const bad = await t.get('/api/v1/runs?status=almost', { as: kim });
            assert.strictEqual(bad.status, 400);
            assert.strictEqual(bad.json().code, 'agents.run.status');
            const doneRuns = await t.get('/api/v1/runs?status=done', { as: kim });
            assert.strictEqual(doneRuns.status, 200);
            assert.ok(doneRuns.json().runs.some((x) => x.id === kimTask));
        });
    } finally {
        await t.close();
    }
    done();
})();

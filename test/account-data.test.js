'use strict';
/**
 * ADR-033: Actor's part of an account export (a person's tasks and their daily spend) and of an account deletion,
 * applied through the service's own /internal/events route with a stand-in Network. Real rows are made through the
 * service's store, the signed delivery is answered by openvibe-sdk/account-data, and the part only ever carries person
 * A's rows. A redelivery erases nothing twice, and the route refuses a bad signature and a forwarded request.
 */
const assert = require('assert');
const http = require('http');
const { boot, check, done } = require('./helpers/boot');
const { createNetworkSender, uncovered } = require('openvibe-sdk/account-data');
const { signDeliveryHeaders } = require('openvibe-sdk/events');
const taskStore = require('../server/tasks/store');
const personal = require('../server/agents/personal');
const { TABLES } = require('../server/identity/account-data');
const { testDb } = require('./helpers/db');

const A = 'usr_01JZ0000000000000000000AAA';
const B = 'usr_01JZ0000000000000000000BBB';
const OLD = 'usr_01JZ0000000000000000000MRG';
const EXP = 'exp_01JZ0000000000000000000EXP';
const DEL = 'del_01JZ0000000000000000000DEX';
// Fixture secrets, built so they never look like a real key to a scanner.
const SECRET = `whsec_${'fixture'.repeat(6)}`;
const WRONG = `whsec_${'mismatch'.repeat(5)}`;

const exportEvent = { event_id: 'evt_01JZ0000000000000000000E01', event_type: 'network.account.export_requested', source: 'network', payload: { export_id: EXP, subject: A } };
const deleteEvent = { event_id: 'evt_01JZ0000000000000000000D01', event_type: 'network.account.deleted', source: 'network', payload: { deletion_id: DEL, subject: A, aliases: [OLD] } };
const bodyOf = (ev) => JSON.stringify({ event: ev, seq: 1 });

/** A stand-in for Network's internal routes: the token endpoint, the export part and the deletion confirmation. */
async function startNetworkStub({ partStatus = 201, confirmStatus = 201 } = {}) {
    const calls = [];
    const statusOf = (v) => (typeof v === 'function' ? v() : v);
    const server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            const raw = Buffer.concat(chunks);
            const json = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
            if (req.url === '/oauth/token') return json(200, { access_token: 'tok_actor', token_type: 'Bearer', expires_in: 300, scope: 'openvibe.network' });
            calls.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(raw.toString() || 'null') });
            return json(req.url.includes('/parts') ? statusOf(partStatus) : statusOf(confirmStatus), {});
        });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    return { url: `http://127.0.0.1:${server.address().port}`, calls, close: () => new Promise((r) => server.close(r)) };
}

/**
 * Make a task and one of its events for one person, through the store the API writes with (server/tasks/store.js).
 * insertTask also writes the person's spend row for today and bumps the requester `*` row, so a spend row exists too.
 */
async function makeTask(t, subject, title) {
    const s = t.ctx.s;
    const id = s.newId('tsk');
    await taskStore.insertTask(s, { id, requester: `user:${subject}`, task: title, mode: 'balanced', budget_task: 0.05, budget_day: 0.25, created_at: s.iso() });
    await taskStore.appendEvent(s, id, { kind: 'state', state: 'running' });
    return id;
}

/** One file a task made: a row in Actor's own artifact table (Actor v2, stage V2-4), owned by the person. */
async function makeArtifact(t, subject, taskId, name, content) {
    const s = t.ctx.s;
    await s.db.query(
        'INSERT INTO actor_artifacts (id, task_id, owner, name, mime, size, bytes, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7::bytea, $8)',
        [s.newId('art'), taskId, `user:${subject}`, name, 'text/markdown', Buffer.byteLength(content), Buffer.from(content, 'utf8'), s.iso()],
    );
}

(async () => {
    await check('every table that names a person is covered or exempted with a reason', async () => {
        const d = await testDb();
        try {
            const missing = await uncovered(d.db, {
                tables: TABLES,
                exempt: {account_data_events: 'the ledger of requests itself: which export and deletion Actor applied'},
            });
            assert.deepStrictEqual(missing, [], `a table with a person column is neither covered nor exempted: ${missing.join(', ')}`);
        } finally { await d.close(); }
    });

    await check('an export part carries only the person\'s tasks and daily spend, and no secret', async () => {
        const stub = await startNetworkStub();
        const sender = createNetworkSender({ networkInternalUrl: stub.url, clientId: 'actor', clientSecret: 'actor-secret' });
        const t = await boot({ env: { ACTOR_EVENTS_SECRET: SECRET }, accountSend: sender });
        try {
            const aTask = await makeTask(t, A, 'person-a');
            const bTask = await makeTask(t, B, 'person-b');
            await makeArtifact(t, A, aTask, 'notes.md', 'A private notes');
            await makeArtifact(t, B, bTask, 'other.md', 'B private notes');
            const ownAgent = (await personal.create(t.ctx.s, t.config, `user:${A}`, { name: 'A helper', instructions: 'Help A.', mode: 'balanced', budget_per_run_usd: 0.01, daily_runs_max: 1, schedule: 'off', status: 'active' })).row;
            await personal.addMemory(t.ctx.s, `user:${A}`, ownAgent.id, 'A private note.');
            const otherAgent = (await personal.create(t.ctx.s, t.config, `user:${B}`, { name: 'B helper', instructions: 'Help B.', mode: 'balanced', budget_per_run_usd: 0.01, daily_runs_max: 1, schedule: 'off', status: 'active' })).row;
            await personal.addMemory(t.ctx.s, `user:${B}`, otherAgent.id, 'B private note.');

            const res = await t.get('/internal/events', { method: 'POST', body: bodyOf(exportEvent), headers: { 'Content-Type': 'application/json', ...signDeliveryHeaders(bodyOf(exportEvent), SECRET) } });
            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.json().outcome, 'exported');

            const part = stub.calls.find((c) => c.url === `/internal/account-exports/${EXP}/parts`);
            assert.ok(part, 'the part was pushed to Network');
            assert.strictEqual(part.auth, 'Bearer tok_actor', 'with this service\'s own token');
            assert.strictEqual(part.body.subject, A);
            assert.deepStrictEqual(part.body.files.map((f) => f.name).sort(), ['agent-memory.json', 'agents.json', 'artifacts-content.json', 'artifacts.json', 'spend.json', 'tasks.json']);
            const artifacts = part.body.files.find((f) => f.name === 'artifacts.json').content;
            assert.strictEqual(artifacts.length, 1, 'only A\'s artifact row');
            assert.strictEqual(artifacts[0].name, 'notes.md');
            assert.strictEqual(artifacts[0].owner, `user:${A}`);
            assert.strictEqual(artifacts[0].bytes, undefined, 'the bytes travel in their own part, not in the row');
            const content = part.body.files.find((f) => f.name === 'artifacts-content.json').content;
            assert.strictEqual(content.length, 1, 'only A\'s file content');
            assert.strictEqual(Buffer.from(content[0].content_base64, 'base64').toString('utf8'), 'A private notes');
            assert.strictEqual(part.body.files.find((f) => f.name === 'agents.json').content[0].name, 'A helper');
            const memRow = part.body.files.find((f) => f.name === 'agent-memory.json').content[0];
            assert.strictEqual(memRow.text, 'A private note.');
            assert.strictEqual(memRow.kind, 'fact');
            assert.strictEqual(memRow.status, 'active');
            assert.strictEqual(memRow.source, 'person');
            const tasks = part.body.files.find((f) => f.name === 'tasks.json').content;
            assert.strictEqual(tasks.length, 1);
            assert.strictEqual(tasks[0].task, 'person-a');
            const spend = part.body.files.find((f) => f.name === 'spend.json').content;
            assert.strictEqual(spend.length, 1, 'only A\'s spend row, not B\'s and not the `*` row');
            assert.strictEqual(spend[0].requester, `user:${A}`);
            assert.ok(!JSON.stringify(part.body).includes('person-b'), 'nobody else\'s rows');
            assert.ok(!JSON.stringify(part.body).includes(B), 'not B\'s requester either');
            assert.ok(!JSON.stringify(part.body).includes('"*"'), 'not the operator\'s `*` spend row');
            assert.ok(!/token|secret|password/i.test(JSON.stringify(part.body)), 'no secret is exported');
        } finally { await t.close(); await stub.close(); }
    });

    await check('a deletion erases the person\'s tasks, their events (cascade) and spend once, keeps someone else and the `*` row, and confirms with counts', async () => {
        const stub = await startNetworkStub();
        const sender = createNetworkSender({ networkInternalUrl: stub.url, clientId: 'actor', clientSecret: 'actor-secret' });
        const t = await boot({ env: { ACTOR_EVENTS_SECRET: SECRET }, accountSend: sender });
        try {
            const aTask = await makeTask(t, A, 'person-a');
            const bTask = await makeTask(t, B, 'person-b');
            await makeArtifact(t, A, aTask, 'notes.md', 'A private notes');
            await makeArtifact(t, B, bTask, 'other.md', 'B private notes');
            const agent = (await personal.create(t.ctx.s, t.config, `user:${A}`, { name: 'Erase me', instructions: 'Help A.', mode: 'balanced', budget_per_run_usd: 0.01, daily_runs_max: 1, schedule: 'off', status: 'active' })).row;
            await personal.addMemory(t.ctx.s, `user:${A}`, agent.id, 'Erase this.');
            const db = t.ctx.s.db;
            const count = async (sql, args = []) => await db.value(sql, args);

            const res = await t.get('/internal/events', { method: 'POST', body: bodyOf(deleteEvent), headers: { 'Content-Type': 'application/json', ...signDeliveryHeaders(bodyOf(deleteEvent), SECRET) } });
            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.json().outcome, 'erased');
            assert.strictEqual(await count('SELECT count(*)::int FROM tasks WHERE requester = $1', [`user:${A}`]), 0, 'the person\'s tasks are gone');
            assert.strictEqual(await count('SELECT count(*)::int FROM task_events WHERE task_id = $1', [aTask]), 0, 'their events went with them (cascade)');
            assert.strictEqual(await count('SELECT count(*)::int FROM spend_daily WHERE requester = $1', [`user:${A}`]), 0, 'their spend rows are gone');
            assert.strictEqual(await count('SELECT count(*)::int FROM actor_agents WHERE owner = $1', [`user:${A}`]), 0);
            assert.strictEqual(await count('SELECT count(*)::int FROM actor_agent_memory WHERE owner = $1', [`user:${A}`]), 0);
            assert.strictEqual(await count('SELECT count(*)::int FROM actor_artifacts WHERE owner = $1', [`user:${A}`]), 0, 'their files are gone');
            assert.strictEqual(await count('SELECT count(*)::int FROM actor_artifacts WHERE owner = $1', [`user:${B}`]), 1, 'someone else\'s file stays');
            assert.strictEqual(await count('SELECT count(*)::int FROM tasks WHERE requester = $1', [`user:${B}`]), 1, 'someone else\'s task stays');
            assert.strictEqual(await count('SELECT count(*)::int FROM spend_daily WHERE requester = $1', [`user:${B}`]), 1, 'someone else\'s spend stays');
            assert.strictEqual(await count("SELECT count(*)::int FROM spend_daily WHERE requester = '*'"), 1, 'the operator\'s `*` ceiling row is kept');

            const confirmation = stub.calls.find((c) => c.url === `/internal/account-deletions/${DEL}/confirmations`);
            assert.ok(confirmation, 'the confirmation was sent');
            assert.deepStrictEqual(confirmation.body.erased, { actor_artifacts: 1, tasks: 1, spend_daily: 1, actor_agent_memory: 1, actor_agents: 1 });
            assert.deepStrictEqual(confirmation.body.retained, {});
            assert.ok(!Number.isNaN(Date.parse(confirmation.body.completed_at)));

            // A redelivery must not erase again: rows written after the deletion stay.
            await makeTask(t, A, 'written-later');
            const again = await t.get('/internal/events', { method: 'POST', body: bodyOf(deleteEvent), headers: { 'Content-Type': 'application/json', ...signDeliveryHeaders(bodyOf(deleteEvent), SECRET) } });
            assert.strictEqual(again.status, 200);
            assert.strictEqual(again.json().outcome, 'unchanged');
            assert.strictEqual(await count('SELECT count(*)::int FROM tasks WHERE requester = $1', [`user:${A}`]), 1, 'nothing was erased twice');
        } finally { await t.close(); await stub.close(); }
    });

    await check('the internal route refuses a bad signature (401) and a forwarded request (403)', async () => {
        const stub = await startNetworkStub();
        const sender = createNetworkSender({ networkInternalUrl: stub.url, clientId: 'actor', clientSecret: 'actor-secret' });
        const t = await boot({ env: { ACTOR_EVENTS_SECRET: SECRET }, accountSend: sender });
        try {
            const bad = await t.get('/internal/events', { method: 'POST', body: bodyOf(exportEvent), headers: { 'Content-Type': 'application/json', ...signDeliveryHeaders(bodyOf(exportEvent), WRONG) } });
            assert.strictEqual(bad.status, 401);

            const forwarded = await t.get('/internal/events', { method: 'POST', body: bodyOf(exportEvent), headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '203.0.113.9', ...signDeliveryHeaders(bodyOf(exportEvent), SECRET) } });
            assert.strictEqual(forwarded.status, 403);
        } finally { await t.close(); await stub.close(); }
    });

    done();
})();

'use strict';
// Actor's control API (ADR-048, plan T13 step 10): OpenVibe.Services stops a person's task, or a task of a project the
// person administers, with a first-party service token carrying actor.resource.control.
const assert = require('assert');
const crypto = require('crypto');
const { ids, serviceAuth, validate } = require('openvibe-contracts');
const { boot, check, done } = require('./helpers/boot');

const SAME = { 'sec-fetch-site': 'same-origin' };

(async () => {
    const admins = new Set();
    let networkDown = false;
    const projects = { isAdmin: async (project, subject) => { if (networkDown) throw new Error('down'); return admins.has(`${project}|${subject}`); } };
    const t = await boot({ projects });
    try {
        const kim = t.network.addUser('kim');
        const lee = t.network.addUser('lee');
        const project = ids.newId('project');
        const other = ids.newId('project');
        const token = (cap, sub = 'svc:services') => {
            const now = Math.floor(Date.now() / 1000);
            return serviceAuth.signServiceToken({ iss: t.network.url, sub, actor_type: sub.startsWith('svc:') ? 'service' : 'app',
                aud: ['openvibe.actor'], cap, iat: now, exp: now + 300, jti: crypto.randomUUID(),
                ...(sub.startsWith('app:') ? { project_id: project, ns: [project], env: 'production' } : {}) }, t.network.privatePem);
        };
        const services = { bearer: token(['actor.resource.control']) };
        const ovrn = (id, prj = project) => `ovrn:actor:${prj}:task/${id}`;
        const control = async (body, auth = services) => {
            const r = await t.get('/api/v1/resources/control', { ...auth, method: 'POST', json: body });
            return { status: r.status, body: r.json(), text: r.text };
        };
        const ask = (id, who, extra = {}) => ({ action: 'stop', resource: ovrn(id), project_id: project, idempotency_key: `k-${crypto.randomUUID()}`,
            on_behalf_of: { type: 'user', id: who.subject }, ...extra });
        const ok = (body) => assert.deepStrictEqual(validate('common.resource-control-result@1', body).errors, [], JSON.stringify(body));
        async function add(requester, state, prj = project) {
            const id = ids.newId('task');
            await t.ctx.s.db.query(`INSERT INTO tasks (id, requester, project_id, task, mode, budget_task, budget_day, state, created_at)
                VALUES ($1, $2, $3, 'a task', 'balanced', 1, 1, $4, $5)`, [id, requester, prj, state, new Date().toISOString()]);
            return id;
        }
        const stateOf = async (id) => (await t.ctx.s.db.maybe('SELECT state FROM tasks WHERE id = $1', [id])).state;

        await check('only a service token with actor.resource.control may send control requests', async () => {
            const id = await add(`user:${kim.subject}`, 'succeeded');
            const body = ask(id, kim);
            assert.strictEqual((await t.get('/api/v1/resources/control', { method: 'POST', json: body })).status, 401);
            assert.strictEqual((await t.get('/api/v1/resources/control', { as: kim, method: 'POST', json: body, headers: SAME })).status, 403);
            assert.strictEqual((await control(body, { bearer: token(['actor.resource.read']) })).status, 403);
            assert.strictEqual((await control(body, { bearer: token(['actor.resource.control'], `app:${ids.newId('app')}`) })).status, 403);
            assert.strictEqual((await control({ action: 'stop' })).status, 400, 'a malformed request is a 400 problem');
        });

        await check('the person stops their running task: pending, then it ends cancelled; a repeat replays the answer', async () => {
            t.providers.reset();
            t.providers.state.cls = 'lookup';
            t.providers.state.runtime = 'hang';
            const id = (await t.get('/api/v1/tasks', { as: kim, json: { task: 'MX of example.com please' }, headers: SAME })).json().id;
            await t.ctx.s.db.query('UPDATE tasks SET project_id = $1 WHERE id = $2', [project, id]);
            await t.waitFor(id, ['running']);
            await new Promise((r) => setTimeout(r, 150));
            const body = ask(id, kim);
            const first = await control(body);
            assert.strictEqual(first.status, 200, first.text);
            ok(first.body);
            assert.deepStrictEqual([first.body.state, first.body.result.stopping], ['pending', true]);
            await t.waitFor(id, ['cancelled']);
            const task = (await t.get(`/api/v1/tasks/${id}`, { as: kim })).json();
            assert.strictEqual(task.cancel.requested_by.id, kim.subject, 'the cancel is recorded as the person\'s');
            const again = await control(body);
            assert.deepStrictEqual(again.body, first.body, 'the same key answers the stored result');
            const conflict = await control({ ...body, dry_run: true });
            assert.deepStrictEqual([conflict.status, conflict.body.code], [409, 'control.idempotency_conflict']);
            const ended = await control(ask(id, kim));
            ok(ended.body);
            assert.deepStrictEqual([ended.body.state, ended.body.result], ['done', { status: 'cancelled', changed: false }]);
        });

        await check('an admin of the project stops a task its app started; anyone else is told it does not exist', async () => {
            const id = await add(`app:${ids.newId('app')}`, 'queued');
            const refused = await control(ask(id, lee));
            ok(refused.body);
            assert.deepStrictEqual([refused.body.state, refused.body.problem.code], ['refused', 'resources.unknown_resource']);
            admins.add(`${project}|${lee.subject}`);
            const dry = await control(ask(id, lee, { dry_run: true }));
            ok(dry.body);
            assert.deepStrictEqual([dry.body.state, dry.body.result.dry_run], ['done', true]);
            assert.strictEqual(await stateOf(id), 'queued', 'a dry run applies nothing');
            const mine = await add(`user:${kim.subject}`, 'running');
            const adminOnPerson = await control(ask(mine, lee, { dry_run: true }));
            assert.strictEqual(adminOnPerson.body.state, 'done', 'a project admin governs every task of the project');
            networkDown = true;
            const down = await control(ask(id, lee));
            ok(down.body);
            assert.deepStrictEqual([down.body.state, down.body.problem.code], ['failed', 'identity.unavailable']);
            networkDown = false;
            admins.clear();
        });

        await check('only stop, only an actor task, only inside its own project', async () => {
            const id = await add(`user:${kim.subject}`, 'running');
            const del = await control({ ...ask(id, kim), action: 'delete' });
            ok(del.body);
            assert.deepStrictEqual([del.body.state, del.body.problem.code], ['refused', 'control.unsupported_action']);
            const elsewhere = await add(`user:${kim.subject}`, 'running', other);
            const wrong = await control({ ...ask(elsewhere, kim), resource: ovrn(elsewhere, project) });
            assert.strictEqual(wrong.body.problem.code, 'resources.unknown_resource', 'a task of another project is not found here');
            const media = await control({ ...ask(id, kim), resource: `ovrn:media:${project}:object/med_${'0'.repeat(26)}` });
            assert.strictEqual(media.body.problem.code, 'resources.unknown_resource');
            assert.strictEqual(await stateOf(id), 'running');
        });
    } finally { await t.close(); }
    done();
})().catch((err) => { console.error(err); process.exit(1); });

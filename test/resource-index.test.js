'use strict';
// Actor's task index is a first-party, capability-guarded authority page for OpenVibe.Services.
const assert = require('assert');
const crypto = require('crypto');
const { ids, serviceAuth, resources, validate } = require('openvibe-contracts');
const { boot, check, done } = require('./helpers/boot');

(async () => {
    const t = await boot();
    try {
        const user = t.network.addUser('resource-reader');
        const projectA = ids.newId('project');
        const projectB = ids.newId('project');
        async function add(requester, project, task, state = 'succeeded') {
            const id = ids.newId('task');
            const created = new Date().toISOString();
            await t.ctx.s.db.query(
                `INSERT INTO tasks (id, requester, project_id, task, mode, budget_task, budget_day, state, created_at)
                 VALUES ($1, $2, $3, $4, 'balanced', 1, 1, $5, $6)`,
                [id, requester, project, task, state, created]);
            return id;
        }
        const a = await add(`user:${user.subject}`, projectA, 'First line\nprivate second line with secret text');
        const b = await add('service:codes', projectB, `${'B'.repeat(90)}\nsecret`, 'failed');
        const c = await add(`user:${user.subject}`, null, 'C task');
        const d = await add('agent:agt_01J8ZQ4Y7N3M2K1H0G9F8E7D6C', null, 'D task');
        const erased = await add(`user:${user.subject}`, projectA, 'Erased task');
        await t.ctx.s.db.query('DELETE FROM tasks WHERE id = $1', [erased]);

        const token = (cap, sub = 'svc:services') => {
            const now = Math.floor(Date.now() / 1000);
            return serviceAuth.signServiceToken({ iss: t.network.url, sub, actor_type: sub.startsWith('svc:') ? 'service' : 'app',
                aud: ['openvibe.actor'], cap, iat: now, exp: now + 300, jti: crypto.randomUUID(),
                ...(sub.startsWith('app:') ? { project_id: projectA, ns: [projectA], env: 'production' } : {}) }, t.network.privatePem);
        };
        const auth = { bearer: token(['actor.resource.read']) };
        const page = async (query = '') => {
            const response = await t.get(`/api/v1/resources${query}`, auth);
            assert.strictEqual(response.status, 200, response.text);
            const body = response.json();
            assert.deepStrictEqual(Object.keys(body).sort(), ['next_cursor', 'resources']);
            assert.deepStrictEqual(validate('common.resource-list-result@1', body).errors, []);
            return body;
        };

        await check('only service tokens with actor.resource.read may list or read resources', async () => {
            for (const path of ['/api/v1/resources', `/api/v1/resources/${encodeURIComponent(`ovrn:actor:${projectA}:task/${a}`)}`]) {
                const anonymous = await t.get(path);
                assert.strictEqual(anonymous.status, 401);
                assert.strictEqual(anonymous.json().code, 'token.required');
                const person = await t.get(path, { as: user });
                assert.strictEqual(person.status, 403);
                assert.strictEqual(person.json().code, 'capability.denied');
                const without = await t.get(path, { bearer: token(['actor.task.read']) });
                assert.strictEqual(without.status, 403);
                assert.strictEqual(without.json().code, 'capability.denied');
                const app = await t.get(path, { bearer: token(['actor.resource.read'], `app:${ids.newId('app')}`) });
                assert.strictEqual(app.status, 403);
                assert.strictEqual(app.json().code, 'capability.denied');
                assert.strictEqual((await t.get(path, auth)).status, 200);
            }
        });

        await check('a page validates and reveals only the allowed task summary fields', async () => {
            const body = await page();
            assert.deepStrictEqual(body.resources.map((x) => x.id), [a, b, c, d].sort());
            assert.ok(body.resources.every((x) => x.kind === 'actor.task' && x.service === 'actor'));
            assert.strictEqual(body.next_cursor, null);
            const byId = new Map(body.resources.map((x) => [x.id, x]));
            assert.strictEqual(byId.get(a).name, 'First line private second line with secret text');
            assert.deepStrictEqual(byId.get(a).owner, { type: 'user', id: user.subject });
            assert.strictEqual(byId.get(a).project_id, projectA);
            assert.strictEqual(byId.get(a).ovrn, resources.nameOf(byId.get(a)));
            assert.strictEqual(byId.get(b).state, 'failed');
            assert.strictEqual(byId.get(b).name, 'B'.repeat(80));
            assert.ok(!('owner' in byId.get(b)));
            assert.ok(!('project_id' in byId.get(c)) && !('ovrn' in byId.get(c)));
            assert.ok(!('owner' in byId.get(d)) && !('ovrn' in byId.get(d)));
            for (const summary of body.resources) {
                assert.deepStrictEqual(validate('common.resource-summary@1', summary).errors, []);
                assert.deepStrictEqual(Object.keys(summary).sort(), ['id', 'kind', 'service', 'project_id', 'ovrn', 'owner', 'name', 'state', 'created_at'].filter((key) => key in summary).sort());
                assert.ok(!JSON.stringify(summary).includes('Erased task'));
            }
        });

        await check('the keyset cursor walks every row once with limit=1', async () => {
            const expected = (await page()).resources.map((x) => x.id);
            const seen = [];
            let cursor = null;
            do {
                const body = await page(`?limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
                assert.strictEqual(body.resources.length, 1);
                seen.push(body.resources[0].id);
                cursor = body.next_cursor;
                assert.ok(seen.length <= expected.length);
            } while (cursor);
            assert.deepStrictEqual(seen, expected);
            assert.deepStrictEqual((await page('?limit=1000')).resources.map((x) => x.id), expected);
        });

        await check('project and kind filters narrow the page; invalid project is a 400 problem', async () => {
            assert.deepStrictEqual((await page(`?project=${projectA}`)).resources.map((x) => x.id), [a]);
            assert.deepStrictEqual((await page(`?project=${projectB}`)).resources.map((x) => x.id), [b]);
            assert.deepStrictEqual((await page('?kind=actor.task')).resources.map((x) => x.id), [a, b, c, d].sort());
            assert.deepStrictEqual((await page('?kind=actor.other')).resources, []);
            const bad = await t.get('/api/v1/resources?project=wrong', auth);
            assert.strictEqual(bad.status, 400);
            assert.strictEqual(bad.json().code, 'resources.bad_query');
            for (const query of ['?limit=0', '?limit=1001', '?cursor=broken']) {
                const response = await t.get(`/api/v1/resources${query}`, auth);
                assert.strictEqual(response.status, 400);
                assert.strictEqual(response.json().code, 'resources.bad_query');
            }
        });

        await check('one OVRN resolves only a present task in its actual project', async () => {
            const name = `ovrn:actor:${projectA}:task/${a}`;
            const one = await t.get(`/api/v1/resources/${encodeURIComponent(name)}`, auth);
            assert.strictEqual(one.status, 200, one.text);
            assert.deepStrictEqual(validate('common.resource-summary@1', one.json()).errors, []);
            assert.deepStrictEqual(one.json(), (await page()).resources.find((x) => x.id === a));
            for (const other of [
                `ovrn:actor:${projectB}:task/${a}`,
                `ovrn:actor:${projectA}:task/${erased}`,
                `ovrn:actor:${projectA}:task/${c}`,
                `ovrn:actor:${projectA}:task/${d}`,
                `ovrn:network:${projectA}:task/${a}`,
                'invalid',
            ]) {
                const response = await t.get(`/api/v1/resources/${encodeURIComponent(other)}`, auth);
                assert.strictEqual(response.status, 404, other);
                assert.strictEqual(response.json().code, 'resources.unknown_resource');
            }
        });
    } finally { await t.close(); }
    done();
})().catch((error) => { console.error(error); process.exit(1); });

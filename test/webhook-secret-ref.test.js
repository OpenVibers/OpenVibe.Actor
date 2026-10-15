'use strict';
/**
 * Task webhooks signed with a project secret (ADR-056, secret_ref): a project's app names the secret; Actor mints no
 * secret of its own for that webhook and never sees the value; each delivery is signed by OpenVibe.Network (here a
 * stand-in signer holding the secret) over "<t>.<raw body>" and verifies with openvibe-sdk/events verifyDeliveryV2
 * under the project secret; a secret Network refuses fails the delivery at once; Network being unreachable is retried
 * on the backoff; a person's task (no project) cannot name one. (An app token always carries env: Network refuses one without.)
 */
const assert = require('assert');
const crypto = require('crypto');
const contracts = require('openvibe-contracts');
const { verifyDeliveryV2 } = require('openvibe-sdk/events');
const { boot, check, done } = require('./helpers/boot');
const { checkWebhookUrl } = require('../server/net/webhook-post');
const { SecretRefused } = require('../server/net/secret-signer');

const HOOK = 'https://hooks.example.com/openvibe/actor';
const PROJECT = 'prj_01JAB2C3D4E5F6G7H8J9K0MNPR';
const SECRET = `ovs_${crypto.randomBytes(24).toString('hex')}`;

(async () => {
    let clock = Date.now();
    const sent = [];
    const webhookPost = async (url, { headers, body }) => { checkWebhookUrl(url); sent.push({ url, headers, body }); return { status: 200 }; };
    // OpenVibe.Network's sign, as the project granted it: one secret, in production, to actor.
    const signs = [];
    let networkDown = false;
    const secretSigner = {
        enabled: true,
        async sign({ project_id, environment, name, message }) {
            signs.push({ project_id, environment, name, message });
            if (networkDown) throw new Error('connect ECONNREFUSED 127.0.0.1:4000');
            if (project_id !== PROJECT || environment !== 'production' || name !== 'webhook-signing') throw new SecretRefused(`project secret ${name} (${environment}) does not exist or is not granted to actor for sign`);
            return { signature: crypto.createHmac('sha256', SECRET).update(message).digest('hex'), version: 3 };
        },
    };
    const t = await boot({ webhookPost, secretSigner, now: () => clock });
    const kim = t.network.addUser('kim');
    const now = Math.floor(Date.now() / 1000);
    const appToken = (extra = {}) => contracts.serviceAuth.signServiceToken({ iss: t.network.url, sub: 'app:app_01JAB2C3D4E5F6G7H8J9K0MNPT', actor_type: 'app', aud: ['openvibe.actor'], cap: ['actor.task.create', 'actor.task.read'], ns: [PROJECT], project_id: PROJECT, env: 'production', iat: now, exp: now + 300, jti: `tok_${crypto.randomBytes(6).toString('hex')}`, ...extra }, t.network.privatePem);
    const deliveries = (taskId) => t.ctx.s.db.many('SELECT * FROM webhook_deliveries WHERE task_id = $1 ORDER BY created_at, id', [taskId]);
    async function queued(taskId, n) {
        for (let i = 0; i < 200; i++) { if ((await deliveries(taskId)).length >= n) return; await new Promise((res) => setTimeout(res, 20)); }
        throw new Error(`${taskId}: ${n} deliveries never queued`);
    }

    let task;
    await check('a project\'s app names a project secret: no webhook_secret is minted, and the task shows the name only', async () => {
        t.providers.reset();
        const r = await t.get('/api/v1/tasks', { bearer: appToken(), json: { task: 'Say hello from an app', webhooks: [{ url: HOOK, events: ['succeeded'], secret_ref: 'webhook-signing' }] } });
        assert.strictEqual(r.status, 201, r.text);
        task = r.json();
        assert.strictEqual('webhook_secret' in task, false, 'nothing minted');
        assert.deepStrictEqual(task.webhooks, [{ url: HOOK, events: ['succeeded'], secret_ref: 'webhook-signing' }]);
        assert.ok(contracts.validate('platform.task@1', task).valid, JSON.stringify(contracts.validate('platform.task@1', task).errors));
        assert.strictEqual(await t.ctx.s.db.value('SELECT webhook_secret FROM tasks WHERE id = $1', [task.id]), null);
    });

    await check('the delivery is signed by Network over "<t>.<raw body>" and verifies under the project secret', async () => {
        await t.waitFor(task.id);
        await queued(task.id, 1);
        await t.ctx.webhooks.tick();
        assert.strictEqual(sent.length, 1);
        const d = sent[0];
        assert.ok(verifyDeliveryV2(d.body, d.headers, SECRET, { now: clock }), 'verifyDeliveryV2 accepts it with the project secret');
        assert.ok(!verifyDeliveryV2(d.body, d.headers, 'whsec_someone-elses', { now: clock }));
        assert.deepStrictEqual([signs[0].project_id, signs[0].environment, signs[0].name], [PROJECT, 'production', 'webhook-signing']);
        assert.strictEqual(signs[0].message, `${d.headers['X-OpenVibe-Timestamp']}.${d.body}`, 'Network signed exactly the timestamp and the body sent');
        assert.strictEqual((await deliveries(task.id))[0].status, 'delivered');
    });

    await check('a secret Network refuses fails that delivery at once; Network unreachable is retried on the backoff', async () => {
        t.providers.reset();
        const r = await t.get('/api/v1/tasks', { bearer: appToken(), json: { task: 'Say hello again', webhooks: [{ url: HOOK, events: ['succeeded'], secret_ref: 'not-granted' }] } });
        assert.strictEqual(r.status, 201, r.text);
        await t.waitFor(r.json().id);
        await queued(r.json().id, 1);
        await t.ctx.webhooks.tick();
        const refused = (await deliveries(r.json().id))[0];
        assert.deepStrictEqual([refused.status, refused.attempts], ['failed', 1]);
        assert.match(refused.last_error, /not granted to actor/);

        t.providers.reset();
        const r2 = await t.get('/api/v1/tasks', { bearer: appToken(), json: { task: 'And once more', webhooks: [{ url: HOOK, events: ['succeeded'], secret_ref: 'webhook-signing' }] } });
        await t.waitFor(r2.json().id);
        await queued(r2.json().id, 1);
        networkDown = true;
        const before = sent.length;
        await t.ctx.webhooks.tick();
        let row = (await deliveries(r2.json().id))[0];
        assert.deepStrictEqual([row.status, row.attempts], ['pending', 1], 'retried later, with the attempt counted');
        assert.match(row.last_error, /signing with the project secret/);
        assert.strictEqual(sent.length, before, 'nothing unsigned was sent');
        networkDown = false;
        clock += 11_000;
        await t.ctx.webhooks.tick();
        row = (await deliveries(r2.json().id))[0];
        assert.strictEqual(row.status, 'delivered');
    });

    await check('a person\'s own task cannot name a project secret; a webhook without one still gets the task\'s own secret', async () => {
        const person = await t.get('/api/v1/tasks', { as: kim, json: { task: 'x', webhooks: [{ url: HOOK, events: ['succeeded'], secret_ref: 'webhook-signing' }] }, headers: { 'sec-fetch-site': 'same-origin' } });
        assert.deepStrictEqual([person.status, person.json().code], [422, 'actor.webhook.secret_unavailable']);
        const mixed = await t.get('/api/v1/tasks', { bearer: appToken(), json: { task: 'Mixed hooks', webhooks: [{ url: HOOK, events: ['succeeded'], secret_ref: 'webhook-signing' }, { url: `${HOOK}/2`, events: ['succeeded'] }] } });
        assert.strictEqual(mixed.status, 201, mixed.text);
        assert.match(mixed.json().webhook_secret, /^whsec_/, 'a webhook without secret_ref still gets the task\'s own secret');
    });

    await t.close();
    done();
})();

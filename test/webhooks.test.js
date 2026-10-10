'use strict';
/**
 * Task webhooks (plan T17, actor.task-webhook@1): a task registers https endpoints and the states each wants; the
 * creating answer carries the task's signing secret once (reads and lists never do); each delivery is signed like an
 * Events delivery (openvibe-sdk/events verifyDeliveryV2 accepts it), carries the task as it was and a delivery id that
 * stays the same across retries; 2xx is delivered, 410 or a refused URL ends it, anything else is retried on the
 * backoff and then fails; the secret is erased once the task has ended and its deliveries are done, and it is never
 * exported. A URL that is not a public https address on 443/8443 is refused at creation, and the real poster refuses
 * a name that resolves to a private address at send time.
 */
const assert = require('assert');
const contracts = require('openvibe-contracts');
const { verifyDeliveryV2 } = require('openvibe-sdk/events');
const { createSafeLookup } = require('openvibe-shared/egress');
const { boot, check, done } = require('./helpers/boot');
const { checkWebhookUrl, createWebhookPoster, WebhookRefused } = require('../server/net/webhook-post');

const SAME = { 'sec-fetch-site': 'same-origin' };
const HOOK = 'https://hooks.example.com/openvibe/actor';

(async () => {
    // Actor's clock (the store's, which sign-in checks token expiry against too): real time, moved on by the retry checks.
    let clock = Date.now();
    const sent = [];
    let answers = [];             // what the stand-in receiver answers next: a status, or an Error to throw
    const webhookPost = async (url, { headers, body }) => {
        checkWebhookUrl(url);     // the same check the real poster makes first
        sent.push({ url, headers, body });
        const a = answers.length ? answers.shift() : 200;
        if (a instanceof Error) throw a;
        return { status: a };
    };
    const t = await boot({ webhookPost, now: () => clock });
    const kim = t.network.addUser('kim');
    const create = (json) => t.get('/api/v1/tasks', { as: kim, json, headers: SAME });
    const tick = () => t.ctx.webhooks.tick();
    const deliveries = (taskId) => t.ctx.s.db.many('SELECT * FROM webhook_deliveries WHERE task_id = $1 ORDER BY created_at, id', [taskId]);
    const secretOf = (taskId) => t.ctx.s.db.value('SELECT webhook_secret FROM tasks WHERE id = $1', [taskId]);

    let first;
    await check('the creating answer carries the signing secret once; reads and lists show the webhooks but never the secret', async () => {
        t.providers.reset();
        const r = await create({ task: 'Who handles mail for openvibe.network?', webhooks: [{ url: HOOK, events: ['queued', 'succeeded', 'failed'] }] });
        assert.strictEqual(r.status, 201, r.text);
        first = r.json();
        assert.match(first.webhook_secret, /^whsec_[A-Za-z0-9_-]{43}$/);
        assert.ok(contracts.validate('platform.task@1', first).valid, JSON.stringify(contracts.validate('platform.task@1', first).errors));
        assert.deepStrictEqual(first.webhooks, [{ url: HOOK, events: ['queued', 'succeeded', 'failed'] }]);
        const read = (await t.get(`/api/v1/tasks/${first.id}`, { as: kim })).json();
        assert.strictEqual('webhook_secret' in read, false, 'a read never carries the secret');
        assert.deepStrictEqual(read.webhooks, first.webhooks);
        const list = (await t.get('/api/v1/tasks', { as: kim })).json();
        assert.ok(!JSON.stringify(list).includes(first.webhook_secret), 'a list never carries the secret');
    });

    await check('each delivery is signed like an Events delivery, carries the task as it was, and validates', async () => {
        await t.waitFor(first.id);
        await tick();
        assert.deepStrictEqual(sent.map((d) => d.url), [HOOK, HOOK]);
        for (const d of sent) {
            assert.ok(verifyDeliveryV2(d.body, d.headers, first.webhook_secret, { now: clock }), 'verifyDeliveryV2 accepts it with the task\'s secret');
            assert.ok(!verifyDeliveryV2(d.body, d.headers, 'whsec_someone-elses-secret', { now: clock }), 'and nothing else');
            const body = JSON.parse(d.body);
            const v = contracts.validate('actor.task-webhook@1', body);
            assert.ok(v.valid, JSON.stringify(v.errors));
            assert.strictEqual(body.task.id, first.id);
            assert.strictEqual(d.headers['X-OpenVibe-Delivery-Id'], body.delivery_id);
            assert.strictEqual(d.headers['X-OpenVibe-Task-Id'], first.id);
            assert.strictEqual(d.headers['X-OpenVibe-Task-State'], body.state);
            assert.strictEqual(d.headers['X-OpenVibe-Delivery-Attempt'], '1');
            assert.ok(!d.body.includes(first.webhook_secret), 'the body never carries the secret');
        }
        assert.deepStrictEqual(sent.map((d) => JSON.parse(d.body).state), ['queued', 'succeeded']);
        assert.strictEqual(JSON.parse(sent[0].body).task.state, 'queued', 'the queued delivery has the task as it was then');
        assert.strictEqual(JSON.parse(sent[1].body).task.result.agent, 'openvibe-runtime');
        assert.deepStrictEqual((await deliveries(first.id)).map((d) => d.status), ['delivered', 'delivered']);
        assert.strictEqual(await secretOf(first.id), null, 'the task ended and its deliveries are done: the secret is gone');
        const pageHtml = (await t.get(`/tasks/${first.id}`, { as: kim })).text;
        assert.match(pageHtml, /<summary>Webhooks \(2\)<\/summary>/, 'the task page lists its deliveries');
        assert.ok(pageHtml.includes('Delivered') && pageHtml.includes(HOOK) && !pageHtml.includes('whsec_'), 'with how each went, and never the secret');
    });

    await check('an idempotent repeat answers the same secret while the task still has one', async () => {
        t.providers.reset();
        const body = { task: 'Say hi', idempotency_key: 'hooks-idem-1', webhooks: [{ url: HOOK, events: ['failed'] }] };
        const a = await create(body);
        const b = await create(body);
        assert.deepStrictEqual([a.status, b.status], [201, 200]);
        assert.strictEqual(b.json().webhook_secret, a.json().webhook_secret);
        assert.strictEqual((await create({ ...body, webhooks: [{ url: `${HOOK}/other`, events: ['failed'] }] })).status, 409, 'other webhooks are another body');
        await t.waitFor(a.json().id);
        await tick();
        assert.strictEqual(await secretOf(a.json().id), null, 'no delivery for its end state: the secret goes when it ends');
    });

    await check('a failing receiver is retried on the backoff with the same delivery id; 2xx then delivers it', async () => {
        t.providers.reset();
        sent.length = 0;
        const r = (await create({ task: 'Who handles mail for openvibe.network?', webhooks: [{ url: HOOK, events: ['succeeded'] }] })).json();
        await t.waitFor(r.id);
        answers = [500, Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })];
        await tick();
        let [d] = await deliveries(r.id);
        assert.deepStrictEqual([d.status, d.attempts, d.last_status, Number(d.next_at)], ['pending', 1, 500, clock + 10_000]);
        await tick();
        assert.strictEqual(sent.length, 1, 'not due yet: nothing sent');
        clock += 10_000;
        await tick();
        [d] = await deliveries(r.id);
        assert.deepStrictEqual([d.status, d.attempts, Number(d.next_at)], ['pending', 2, clock + 60_000]);
        assert.match(d.last_error, /ECONNREFUSED/);
        clock += 60_000;
        await tick();
        [d] = await deliveries(r.id);
        assert.strictEqual(d.status, 'delivered');
        assert.deepStrictEqual(sent.map((x) => x.headers['X-OpenVibe-Delivery-Id']), [d.id, d.id, d.id], 'one delivery id across the attempts');
        assert.deepStrictEqual(sent.map((x) => x.headers['X-OpenVibe-Delivery-Attempt']), ['1', '2', '3']);
        assert.ok(verifyDeliveryV2(sent[2].body, sent[2].headers, r.webhook_secret, { now: clock }), 'each attempt is signed afresh (its own timestamp)');
        assert.strictEqual(await secretOf(r.id), null);
    });

    await check('410 Gone or a URL refused at send time ends the delivery at once; endless failures end after the backoff', async () => {
        t.providers.reset();
        const r = (await create({ task: 'Who handles mail for openvibe.network?', webhooks: [{ url: `${HOOK}/a`, events: ['succeeded'] }, { url: `${HOOK}/b`, events: ['succeeded'] }, { url: `${HOOK}/c`, events: ['succeeded'] }] })).json();
        await t.waitFor(r.id);
        answers = [410, new WebhookRefused('hooks.example.com is not a public address')];
        for (let i = 0; i < 20; i++) answers.push(503);
        await tick();
        const byUrl = async () => Object.fromEntries((await deliveries(r.id)).map((d) => [d.url.slice(-1), d]));
        let d = await byUrl();
        assert.deepStrictEqual([d.a.status, d.a.last_status], ['failed', 410]);
        assert.strictEqual(d.b.status, 'failed');
        assert.match(d.b.last_error, /not a public address/);
        assert.strictEqual(d.c.status, 'pending');
        for (const wait of t.ctx.webhooks.BACKOFF_MS) { clock += wait; await tick(); }
        d = await byUrl();
        assert.deepStrictEqual([d.c.status, d.c.attempts, d.c.last_status], ['failed', t.ctx.webhooks.BACKOFF_MS.length + 1, 503]);
        assert.strictEqual(await secretOf(r.id), null, 'nothing left to send: the secret is gone');
        clock = Date.now();   // back to real time: the next checks sign in with tokens that expire in real time
        answers = [];
    });

    await check('cancel is delivered to a webhook that asked for it', async () => {
        t.providers.reset();
        sent.length = 0;
        t.providers.state.cls = 'lookup';
        t.providers.state.runtime = 'hang';
        const r = (await create({ task: 'MX of example.com please', webhooks: [{ url: HOOK, events: ['cancelled'] }] })).json();
        await t.waitFor(r.id, ['running']);
        await new Promise((res) => setTimeout(res, 150));
        await t.get(`/api/v1/tasks/${r.id}/cancel`, { as: kim, method: 'POST', headers: SAME });
        await t.waitFor(r.id, ['cancelled']);
        await tick();
        assert.deepStrictEqual(sent.map((x) => JSON.parse(x.body).state), ['cancelled']);
        assert.strictEqual(JSON.parse(sent[0].body).task.cancel.requested_by.id, kim.subject);
        assert.deepStrictEqual((await deliveries(r.id)).map((d) => d.status), ['delivered']);
        assert.strictEqual(await secretOf(r.id), null);
    });

    await check('a URL Actor may not deliver to is refused at creation; a project secret by reference is not accepted yet', async () => {
        for (const url of ['https://127.0.0.1/x', 'https://localhost/x', 'https://10.0.0.7/x', 'https://[::1]/x', 'https://169.254.169.254/latest', 'https://hooks.example.com:8080/x', 'https://user:pw@hooks.example.com/x', 'https://intranet/x']) {
            const r = await create({ task: 'x', webhooks: [{ url, events: ['succeeded'] }] });
            assert.strictEqual(r.status, 422, `${url}: ${r.status} ${r.text.slice(0, 200)}`);
            assert.strictEqual(r.json().code, 'actor.webhook.refused', url);
        }
        const http = await create({ task: 'x', webhooks: [{ url: 'http://hooks.example.com/x', events: ['succeeded'] }] });
        assert.deepStrictEqual([http.status, http.json().code], [422, 'actor.task.invalid'], 'plain http is not a webhook URL');
        const ref = await create({ task: 'x', webhooks: [{ url: HOOK, events: ['succeeded'], secret_ref: 'HOOK_KEY' }] });
        assert.deepStrictEqual([ref.status, ref.json().code], [422, 'actor.task.invalid']);
        assert.ok(checkWebhookUrl('https://hooks.example.com:8443/x'), 'port 8443 is allowed');
    });

    await check('the real poster refuses a name that resolves to a private address, at send time', async () => {
        const lookup = createSafeLookup({ lookup: (host, opts, cb) => cb(null, [{ address: '10.1.2.3', family: 4 }]) });
        const post = createWebhookPoster({ lookup, timeoutMs: 2000 });
        await assert.rejects(post('https://hooks.example.com/x', { body: '{}' }), /10\.1\.2\.3|not public|no public|EGRESS|denied/i);
        await assert.rejects(post('https://127.0.0.1/x', { body: '{}' }), WebhookRefused);
    });

    await check('the signing secret is never exported with the person\'s tasks', async () => {
        const { TABLES } = require('../server/identity/account-data');
        const tasks = TABLES.find((x) => x.table === 'tasks');
        assert.ok(Array.isArray(tasks.columns) && tasks.columns.includes('webhooks') && !tasks.columns.includes('webhook_secret'));
        const cols = (await t.ctx.s.db.many("SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'tasks'")).map((r) => r.column_name);
        assert.deepStrictEqual(cols.filter((c) => !tasks.columns.includes(c)), ['webhook_secret'], 'every other column of tasks is exported');
    });

    await t.close();
    done();
})().catch((e) => { console.error(e); process.exit(1); });

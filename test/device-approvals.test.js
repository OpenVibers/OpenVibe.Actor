'use strict';

const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const contacts = require('../server/agents/contacts');
const approvals = require('../server/agents/approvals');
const device = require('../server/runtime/tools/_device');
const noticeTool = require('../server/runtime/tools/notify_phone');
const items = require('../server/actions/items');

const SAME = { 'sec-fetch-site': 'same-origin' };
const DEVICE = 'dev_01JAB2C3D4E5F6G7H8J9K0MNPS';
const PHOTO = 'med_01JAB2C3D4E5F6G7H8J9K0MNPS';

(async () => {
    const t = await boot();
    try {
        const ada = t.network.addUser('ada');
        const bo = t.network.addUser('bo');
        const owner = `user:${ada.subject}`;
        const agent = (await contacts.create(t.ctx.s, t.config, owner, { name: 'Scout', level: 'full' })).row;
        const taskId = t.ctx.s.newId('tsk');
        const wakes = [];
        t.ctx.waits.wakeDevice = async (row, result) => { wakes.push({ row, result }); return row; };
        t.ctx.media.putPhoto = async () => ({ id: PHOTO });
        t.ctx.media.photoUrl = async () => 'https://media.example.test/private-photo?expires=soon';
        const run = {
            store: t.ctx.s, waits: { create: async () => ({ id: t.ctx.s.newId('wai'), deadline_at: new Date(Date.now() + 6 * 3600_000).toISOString() }) },
            config: t.config, requester: owner, agentId: agent.id, taskId,
        };

        await check('an offline targeted phone fails before a request exists', async () => {
            const out = await device.ask(run, 'device.camera', { why: 'Read a sign', device: DEVICE });
            assert.strictEqual(out.isError, true);
            assert.match(out.text, /offline/);
            assert.strictEqual((await approvals.list(t.ctx.s, owner)).length, 0);
            const heartbeat = await t.get('/api/v1/me/devices/presence', { as: ada, headers: SAME,
                json: { device_id: DEVICE } });
            assert.strictEqual(heartbeat.status, 204, heartbeat.text);
        });

        let location;
        await check('location asks fresh even at full access and cannot be always allowed', async () => {
            const asked = await device.ask(run, 'device.location', { why: 'Find a shelter nearby', device: DEVICE });
            assert.ok(asked.park.wait_id);
            location = (await approvals.list(t.ctx.s, owner))[0];
            assert.strictEqual(location.kind, 'device.location');
            assert.strictEqual(location.task_id, taskId);
            assert.strictEqual(location.agent_id, agent.id);
            assert.strictEqual(location.device_wait_id, asked.park.wait_id);
            const page = await t.get(`/me/approvals/${location.id}`, { as: ada });
            assert.match(page.text, /Share where I am once/);
            assert.match(page.text, /Find a shelter nearby/);
            assert.doesNotMatch(page.text, /Always allow this for/);
            const generic = await t.get(`/me/approvals/${location.id}`, { as: ada, form: { decision: 'approve_always' }, headers: SAME });
            assert.strictEqual(generic.status, 422);
        });

        await check('location is owner-only, coarse, one-time, and sent only to the asking run', async () => {
            const path = `/api/v1/me/approvals/${location.id}/answer`;
            assert.strictEqual((await t.get(path, { as: bo, headers: SAME,
                json: { decision: 'answer', location: { lat: 37.77, lng: -122.42, accuracy_m: 100, precise: false } } })).status, 404);
            assert.strictEqual((await t.get(path, { as: ada, headers: { 'sec-fetch-site': 'cross-site' },
                json: { decision: 'answer', location: { lat: 37.77, lng: -122.42, accuracy_m: 100, precise: false } } })).status, 403);
            assert.strictEqual((await t.get(path, { as: ada, headers: SAME,
                json: { decision: 'answer', location: { lat: 37.777, lng: -122.42, accuracy_m: 100, precise: false } } })).status, 422);
            assert.strictEqual((await t.get(path, { as: ada, headers: SAME,
                json: { decision: 'answer', location: { lat: 37.77, lng: -122.42, accuracy_m: 10, precise: true } } })).status, 422);
            assert.strictEqual((await t.get(path, { as: ada, headers: SAME,
                json: { decision: 'answer', location: { lat: 37.77, lng: -122.42, accuracy_m: 100001, precise: false } } })).status, 422);
            assert.strictEqual((await t.get(path, { as: ada, headers: SAME,
                json: { decision: 'answer', photo: { media_id: PHOTO }, location: { lat: 37.77, lng: -122.42, accuracy_m: 100, precise: false } } })).status, 422);
            const good = await t.get(path, { as: ada, headers: SAME,
                json: { decision: 'answer', location: { lat: 37.77, lng: -122.42, accuracy_m: 100, precise: false } } });
            assert.strictEqual(good.status, 200, good.text);
            assert.strictEqual(good.json().state, 'approved');
            assert.strictEqual((await t.get(path, { as: ada, headers: SAME,
                json: { decision: 'answer', location: { lat: 0, lng: 0, accuracy_m: 1, precise: false } } })).status, 409);
            assert.strictEqual(wakes.length, 1);
            assert.strictEqual(wakes[0].row.task_id, taskId);
            assert.deepStrictEqual(wakes[0].result.location, { lat: 37.77, lng: -122.42, accuracy_m: 1000, precise: false });
            const again = await device.ask(run, 'device.location', { why: 'Find the next stop' });
            assert.ok(again.park);
            assert.strictEqual((await approvals.list(t.ctx.s, owner)).filter((a) => a.state === 'pending').length, 1);
        });

        await check('a photo must be uploaded for its own approval before its media id is answered', async () => {
            const asked = await device.ask(run, 'device.camera', { why: 'Read the street sign' });
            const row = await approvals.get(t.ctx.s, owner, asked.data.approval_id);
            const page = await t.get(`/me/approvals/${row.id}`, { as: ada });
            assert.match(page.text, /data-photo-picker/);
            assert.match(page.text, /ov-upload\.css/);
            assert.match(page.text, /ov-upload\.js/);
            const path = `/api/v1/me/approvals/${row.id}`;
            const answer = { decision: 'answer', photo: { media_id: PHOTO } };
            assert.strictEqual((await t.get(`${path}/answer`, { as: ada, headers: SAME, json: answer })).status, 422);
            assert.strictEqual((await t.get(`${path}/photo`, { as: bo, headers: { ...SAME, 'content-type': 'image/jpeg' }, body: Buffer.from('photo') })).status, 404);
            const uploaded = await t.get(`${path}/photo`, { as: ada, headers: { ...SAME, 'content-type': 'image/jpeg' }, body: Buffer.from('photo') });
            assert.strictEqual(uploaded.status, 201, uploaded.text);
            assert.strictEqual(uploaded.json().media_id, PHOTO);
            assert.strictEqual((await t.get(`${path}/answer`, { as: ada, headers: SAME, json: answer })).status, 200);
            assert.strictEqual(wakes.at(-1).row.id, row.id);
            assert.match(wakes.at(-1).result.photo_url, /^https:\/\/media\.example\.test\/private-photo/);
        });

        await check('notification consent creates one Action Center item for this agent', async () => {
            const ask = await approvals.request(t.ctx.s, { owner, agentId: agent.id, taskId,
                kind: 'device.notify', summary: 'Notify your phone: Report ready', target: agent.name,
                payload: { title: 'Report ready', text: 'Open the finished report.' } });
            const approved = await t.get(`/me/approvals/${ask.id}`, { as: ada,
                form: { decision: 'approve_always' }, headers: SAME });
            assert.strictEqual(approved.status, 303, approved.text);
            const row = await t.ctx.s.db.maybe('SELECT * FROM actor_device_notices WHERE id = $1', [`ntf_${ask.id.slice(4)}`]);
            assert.ok(row);
            assert.strictEqual(items.deviceNotice(row, agent.name).summary, 'notify · Open the finished report.');
            const direct = await noticeTool.run({ title: 'Next report', text: 'Ready now.' }, { store: t.ctx.s,
                requester: owner, agentId: agent.id, taskId });
            assert.ok(direct.data.notice_id.startsWith('ntf_'));
        });
    } finally { await t.close(); }
    done();
})().catch((e) => { console.error(e); process.exit(1); });

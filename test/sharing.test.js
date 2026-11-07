'use strict';
/**
 * Sharing an agent's run (design 2026-11-06, visibility step 2): the one Share sheet (openvibe-sdk/share) and the
 * one check, canView, on the run's page, its turns, its details and its files.
 *
 *   - a new run is Only me; the Share button is its owner's;
 *   - Anyone with the link reads the conversation and its Details page, with no composer and no owner moves;
 *   - Specific people shows the gate, never the question or an answer, to somebody not on the list;
 *   - the person's default for new runs, and "apply to all", work.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

const SAME = { 'sec-fetch-site': 'same-origin' };

(async () => {
    const t = await boot();
    const kim = t.network.addUser('kim');
    const bo = t.network.addUser('bo');
    const cy = t.network.addUser('cy');
    t.config.loop.selfReflections = 0;
    const s = t.ctx.s;

    const say = async (text, { as = kim, answer = 'Hetzner CX22 at €4.51 a month [E1].' } = {}) => {
        t.providers.state.script = [{ content: answer }];
        return await t.get('/chat', { as, form: { task: text }, headers: SAME });
    };
    const call = (pathname, o = {}) => {
        const { headers, ...rest } = o;
        return t.get(pathname, { ...rest, headers: { 'x-requested-with': 'ov-share', ...(headers || {}) } });
    };
    const share = (id, o = {}) => call(`/api/v1/run/${encodeURIComponent(id)}/share`, o);
    const setShare = async (id, body, as) => {
        const first = await share(id, { as });
        assert.strictEqual(first.status, 200, first.text);
        const etag = first.headers.get('etag');
        assert.ok(etag);
        return await share(id, { as, method: 'PUT', json: body, headers: { 'if-match': etag } });
    };
    const audienceRow = async (id) => await s.db.maybe(
        'SELECT audience FROM shares WHERE service = $1 AND kind = $2 AND resource_id = $3', ['actor', 'run', id]);

    try {
        let taskId;
        await check('a new run is Only me, and its page carries the Share button for its owner', async () => {
            const made = await say('What is the cheapest Hetzner VPS?');
            assert.strictEqual(made.status, 303, made.text);
            taskId = /^\/chat\/(tsk_[0-9A-Z]{26})/.exec(made.headers.get('location'))[1];
            await t.waitFor(taskId, ['succeeded']);
            assert.deepStrictEqual(await audienceRow(taskId), { audience: 'private' });
            const mine = await t.get(`/chat/${taskId}`, { as: kim });
            assert.strictEqual(mine.status, 200, mine.text);
            assert.ok(mine.text.includes('data-ov-share-sheet') && mine.text.includes('data-kind="run"'));
            assert.ok(mine.text.includes('ov-share.js'));
            const other = await t.get(`/chat/${taskId}`, { as: bo });
            assert.strictEqual(other.status, 404);
            assert.ok(!other.text.includes('Hetzner CX22'), 'never the answer');
        });

        await check('Anyone with the link reads the conversation and Details, with no composer and no owner moves', async () => {
            const saved = await setShare(taskId, { audience: 'link' }, kim);
            assert.strictEqual(saved.status, 200, saved.text);
            assert.strictEqual(saved.json().audience, 'link');
            const guest = await t.get(`/chat/${taskId}`);
            assert.strictEqual(guest.status, 200, guest.text);
            assert.ok(guest.text.includes('What is the cheapest Hetzner VPS?'));
            assert.ok(guest.text.includes('Hetzner CX22'));
            assert.ok(guest.text.includes('This run was shared with you'));
            assert.ok(!guest.text.includes('ovt-composer'), 'a reader cannot carry the run on');
            assert.ok(!guest.text.includes('name="task"'), 'no send box');
            const turn = await t.get(`/chat/turn/${taskId}`, { as: bo });
            assert.strictEqual(turn.status, 200, turn.text);
            const details = await t.get(`/tasks/${taskId}?view=details`);
            assert.strictEqual(details.status, 200, details.text);
            assert.ok(details.text.includes('What is the cheapest Hetzner VPS?'));
            assert.ok(details.text.includes('This run was shared with you'));
            assert.ok(!details.text.includes('action="/tasks/' + taskId + '/answer"'), 'no answer form for a reader');
        });

        await check('Specific people: on the list reads it, a stranger gets the gate and no question', async () => {
            const saved = await setShare(taskId, { audience: 'people', members: [{ name: 'bo', role: 'viewer' }] }, kim);
            assert.strictEqual(saved.status, 200, saved.text);
            assert.strictEqual(saved.json().audience, 'people');
            const member = await t.get(`/chat/${taskId}`, { as: bo });
            assert.strictEqual(member.status, 200, member.text);
            assert.ok(member.text.includes('Hetzner CX22'));
            const stranger = await t.get(`/chat/${taskId}`, { as: cy });
            assert.strictEqual(stranger.status, 404);
            assert.ok(stranger.text.includes('shared with specific people'));
            assert.ok(!stranger.text.includes('Hetzner CX22'), 'the gate never reveals an answer');
            const details = await t.get(`/tasks/${taskId}?view=details`, { as: cy });
            assert.strictEqual(details.status, 404);
        });

        await check('the default applies to the next run, and "apply to all" moves the existing one', async () => {
            const saved = await t.get('/chat/defaults', { as: kim, form: { audience: 'public', apply_all: '1' }, headers: SAME });
            assert.strictEqual(saved.status, 303, saved.text);
            assert.deepStrictEqual(await audienceRow(taskId), { audience: 'public' });
            const guest = await t.get(`/chat/${taskId}`);
            assert.strictEqual(guest.status, 200);
            const next = await say('And the second cheapest?');
            const nextId = /^\/chat\/(tsk_[0-9A-Z]{26})/.exec(next.headers.get('location'))[1];
            assert.deepStrictEqual(await audienceRow(nextId), { audience: 'public' });
            const start = await t.get('/chat', { as: kim });
            assert.ok(start.text.includes('New runs'), 'the default is on the product page');
        });
    } finally {
        await t.close();
        done();
    }
})();

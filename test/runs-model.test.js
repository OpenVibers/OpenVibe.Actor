'use strict';
/**
 * A run's model (11-15: the session's context chip picked a model, the Frame forwarded it, and Actor dropped it). The
 * model a conversation starts with rides as its task's model, resolved by OpenVibe.AI like one the person picked; the
 * next message keeps it, or names another (a swap mid-session); "Auto" leaves it to the person's own preference.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

(async () => {
    const t = await boot();
    const kim = t.network.addUser('kim-model');
    const kimB = t.network.userToken(kim);
    const db = t.ctx.s.db;
    const answer = (content) => { t.providers.reset(); t.providers.state.script = [{ content }, { content }, { content }, { content }]; };
    const modelOfTask = async (id) => (await db.maybe('SELECT model FROM tasks WHERE id = $1', [id])).model;
    const newest = async () => (await db.maybe('SELECT id FROM tasks WHERE requester = $1 ORDER BY id DESC LIMIT 1', [`user:${kim.subject}`])).id;
    try {
        let runId = null;

        await check('a conversation starts on the model the chip named (the Frame\'s { id, source, name })', async () => {
            answer('Hello.');
            const r = await t.get('/api/v1/runs', { bearer: kimB, json: { text: 'Plan my week', model: { id: 'anthropic/claude-sonnet-5-5', source: 'openvibe', name: 'Sonnet 5.5' } } });
            assert.strictEqual(r.status, 201, r.text);
            runId = r.json().id;
            await t.waitFor(runId);
            assert.strictEqual(await modelOfTask(runId), 'anthropic/claude-sonnet-5-5');
        });

        await check('the next message keeps the conversation\'s model', async () => {
            answer('Sure.');
            const r = await t.get(`/api/v1/runs/${runId}/messages`, { bearer: kimB, json: { text: 'Add a gym day' } });
            assert.strictEqual(r.status, 202, r.text);
            const second = await newest();
            assert.notStrictEqual(second, runId);
            await t.waitFor(second);
            assert.strictEqual(await modelOfTask(second), 'anthropic/claude-sonnet-5-5');
        });

        await check('a message that names another model swaps it for that turn and the ones after', async () => {
            answer('Done.');
            const r = await t.get(`/api/v1/runs/${runId}/messages`, { bearer: kimB, json: { text: 'Shorter, please', model: 'deepseek/deepseek-v4-flash' } });
            assert.strictEqual(r.status, 202, r.text);
            const third = await newest();
            await t.waitFor(third);
            assert.strictEqual(await modelOfTask(third), 'deepseek/deepseek-v4-flash');
        });

        await check('Auto, nothing or a bad model leaves it to the person\'s own preference', async () => {
            answer('Hi.');
            const auto = await t.get('/api/v1/runs', { bearer: kimB, json: { text: 'Another thing', model: { id: 'openvibe/auto' } } });
            assert.strictEqual(auto.status, 201, auto.text);
            await t.waitFor(auto.json().id);
            assert.strictEqual(await modelOfTask(auto.json().id), null);
            answer('Hi.');
            const long = await t.get('/api/v1/runs', { bearer: kimB, json: { text: 'And another', model: { id: 'x'.repeat(300) } } });
            assert.strictEqual(long.status, 201, long.text);
            await t.waitFor(long.json().id);
            assert.strictEqual(await modelOfTask(long.json().id), null, 'an over-long id is ignored, not stored');
        });
    } finally {
        await done(t);
    }
})();

'use strict';
/**
 * Rename a conversation (plan §AD.8, the session's ⋯ menu): the person names it and every read says that name; an
 * empty name gives it back its first message; someone else cannot rename it; a later message keeps the name.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

(async () => {
    const t = await boot();
    const kim = t.network.addUser('kim-rename');
    const lee = t.network.addUser('lee-rename');
    const kimB = t.network.userToken(kim);
    const answer = (content) => { t.providers.reset(); t.providers.state.script = [{ content }, { content }, { content }, { content }]; };
    try {
        let runId = null;
        await check('a conversation is named by the person', async () => {
            answer('Hello.');
            const r = await t.get('/api/v1/runs', { bearer: kimB, json: { text: 'Plan my week' } });
            assert.strictEqual(r.status, 201, r.text);
            runId = r.json().id;
            await t.waitFor(runId);
            const named = await t.get(`/api/v1/runs/${runId}`, { bearer: kimB, method: 'PATCH', json: { title: '  Week   plan\n' } });
            assert.strictEqual(named.status, 200, named.text);
            assert.strictEqual(named.json().title, 'Week plan');
            const list = await t.get('/api/v1/runs?conversations=1', { bearer: kimB });
            assert.strictEqual((list.json().runs || []).find((x) => x.id === runId).title, 'Week plan', 'the list says the name');
        });

        await check('the next message keeps the name', async () => {
            answer('Sure.');
            const r = await t.get(`/api/v1/runs/${runId}/messages`, { bearer: kimB, json: { text: 'Add a gym day' } });
            assert.strictEqual(r.status, 202, r.text);
            assert.strictEqual(r.json().run.title, 'Week plan');
        });

        await check('someone else cannot rename it, and a name must be words', async () => {
            const other = await t.get(`/api/v1/runs/${runId}`, { bearer: t.network.userToken(lee), method: 'PATCH', json: { title: 'Mine now' } });
            assert.strictEqual(other.status, 404);
            const bad = await t.get(`/api/v1/runs/${runId}`, { bearer: kimB, method: 'PATCH', json: { title: 42 } });
            assert.strictEqual(bad.status, 422);
        });

        await check('an empty name gives it back its first message', async () => {
            const cleared = await t.get(`/api/v1/runs/${runId}`, { bearer: kimB, method: 'PATCH', json: { title: '' } });
            assert.strictEqual(cleared.status, 200, cleared.text);
            assert.strictEqual(cleared.json().title, 'Plan my week');
        });
    } finally {
        await done(t);
    }
})();

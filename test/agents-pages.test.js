'use strict';
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const SAME = { 'sec-fetch-site': 'same-origin' };

(async () => {
    const t = await boot();
    try {
        const a = t.network.addUser('pages-a');
        const b = t.network.addUser('pages-b');
        await check('signed-out pages redirect and signed-in forms work without JS', async () => {
            assert.strictEqual((await t.get('/me/agents')).status, 303);
            const listing = await t.get('/me/agents', { as: a });
            assert.strictEqual(listing.status, 200);
            assert.match(listing.text, /<form method="post" action="\/me\/agents">/);
            assert.match(listing.text, /href="\/css\/agents\.css\?v=[^"]+"/, 'the agents stylesheet loads only here');
            assert.strictEqual((await t.get('/css/agents.css')).status, 200);
            const cross = await t.get('/me/agents', { as: a, form: { name: 'Cross site' }, headers: { 'sec-fetch-site': 'cross-site' } });
            assert.strictEqual(cross.status, 403);
            const create = await t.get('/me/agents', { as: a, form: { name: 'Plain form', instructions: 'Help me.', mode: 'balanced', budget_per_run_usd: '0.02', daily_runs_max: '2', schedule: 'off', schedule_at: '', schedule_dow: '', status: 'active' }, headers: SAME });
            assert.strictEqual(create.status, 303);
            const id = create.headers.get('location').split('/').pop();
            const own = await t.get(`/me/agents/${id}`, { as: a });
            assert.match(own.text, /Run now/);
            assert.match(own.text, /Forget everything/);
            assert.strictEqual((await t.get(`/me/agents/${id}/memory`, { as: a, form: { text: 'Remember this.' }, headers: SAME })).status, 303);
            const withNote = await t.get(`/me/agents/${id}`, { as: a });
            assert.match(withNote.text, /Remember this\./);
            assert.strictEqual((await t.get(`/me/agents/${id}/forget`, { as: a, method: 'POST', form: {}, headers: SAME })).status, 303);
            assert.ok(!(await t.get(`/me/agents/${id}`, { as: a })).text.includes('Remember this.'));
            assert.strictEqual((await t.get(`/me/agents/${id}`, { as: b })).status, 404);
            assert.strictEqual((await t.get(`/me/agents/${id}/forget`, { as: a })).status, 200);
            assert.strictEqual((await t.get(`/me/agents/${id}/forget`, { as: b })).status, 404);
        });
    } finally { await t.close(); }
    done();
})();

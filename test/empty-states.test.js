'use strict';
/** Owner ask 81: an agent's empty panels draw the shared kit's empty state, and the page loads kit.css. */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

const SAME = { 'sec-fetch-site': 'same-origin' };
const BASE = { name: 'Empty panels', instructions: 'Help me.', mode: 'balanced', budget_per_run_usd: '0.02', daily_runs_max: '2', schedule: 'off', schedule_at: '', schedule_dow: '', status: 'active' };

(async () => {
    const t = await boot();
    try {
        const a = t.network.addUser('empty-panels');
        await check('an agent with nothing yet draws the kit empty states', async () => {
            const create = await t.get('/me/agents', { as: a, form: BASE, headers: SAME });
            assert.strictEqual(create.status, 303);
            const id = create.headers.get('location').split('/').pop();
            const page = await t.get(`/me/agents/${id}`, { as: a });
            assert.strictEqual(page.status, 200);
            for (const text of ['No skills yet', 'No letter answered yet', 'Nothing spent yet', 'No channel accounts yet']) {
                assert.ok(page.text.includes(text), `expected ${text}`);
            }
            assert.ok(page.text.includes('class="ovk-empty"'), 'the kit empty state is drawn');
            assert.ok(page.text.includes('Browse the skills registry'), 'the one next action is a kit button');
            assert.match(page.text, /kit\.css/, 'the page loads kit.css');
        });
        await check('the connections page loads the kit it draws its tool empty state with', async () => {
            const r = await t.get('/connections', { as: a });
            assert.strictEqual(r.status, 200);
            assert.match(r.text, /kit\.css/);
        });
    } finally { await t.close(); }
    done();
})();

'use strict';
/**
 * The free allowance (plan L6196): $0.05 a day per person by default, one measured Actor run, shown where a person
 * starts a run, and refused in plain words — with the way to add their own key — once it is spent.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

const SAME = { 'sec-fetch-site': 'same-origin' };

(async () => {
    const t = await boot({ env: { ACTOR_FREE_PER_DAY_USD: '0.05' } });
    const store = require('../server/tasks/store');

    await check('the default free allowance is $0.05 a day, the price of about one measured run', async () => {
        // The default itself, with the test harness's generous day out of the way.
        const fresh = require('../server/config').load({ NODE_ENV: 'test', PORT: '0', BASE_URL: 'https://openvibe.actor' });
        assert.strictEqual(fresh.allowance.perDayUsd, 0.05);
        assert.strictEqual(fresh.allowance.perTaskUsd, 0.05);
        assert.strictEqual(t.config.allowance.perDayUsd, 0.05);
        const limits = (await t.get('/limits.json')).json();
        assert.deepStrictEqual([limits.free_tier.per_day_usd, limits.free_tier.per_task_usd], [0.05, 0.05]);
    });

    await check('one line says what is left, and what runs still hold', async () => {
        const { leftLine } = require('../server/tasks/allowance');
        assert.strictEqual(leftLine({ perDayUsd: 0.05 }, { usd: 0.01, reserved: 0.02 }), '$0.02 of the $0.05 free allowance left today ($0.02 held by runs in progress).');
        assert.strictEqual(leftLine({ perDayUsd: 0.05 }, { usd: 0.05, reserved: 0 }), 'The free allowance is used for today.');
        assert.strictEqual(leftLine({ perDayUsd: 0.05 }, { usd: 0, reserved: 0 }), '$0.05 of the $0.05 free allowance left today.');
    });

    await check('what is left counts what was spent and what open runs may still spend', async () => {
        const u = t.network.addUser('left');
        const who = `user:${u.subject}`;
        await store.addSpend(t.ctx.s, who, 0.01);
        let today = await store.spendToday(t.ctx.s, who);
        assert.deepStrictEqual([today.usd, today.reserved], [0.01, 0], 'nothing open yet');
        await store.insertTask(t.ctx.s, { id: t.ctx.s.newId('tsk'), requester: who, task: 'open', mode: 'balanced', budget_task: 0.02, budget_day: 0.05, created_at: t.ctx.s.iso() });
        today = await store.spendToday(t.ctx.s, who);
        assert.strictEqual(today.reserved, 0.02);
        // The console is where a person starts a run: $0.05 - $0.01 spent - $0.02 held = $0.02 left.
        assert.strictEqual(typeof require('../server/http/console-pages').createConsolePages, 'function');
        const consolePage = await t.get('/console', { as: u });
        assert.strictEqual(consolePage.status, 200);
        assert.match(consolePage.text, /\$0\.02 of the \$0\.05 free allowance left today \(\$0\.02 held by runs in progress\)/);
        await t.ctx.s.db.query("UPDATE tasks SET state = 'cancelled' WHERE requester = $1", [who]);
    });

    await check('past the day\'s allowance a task is refused in plain words, with the way to add a key', async () => {
        const u = t.network.addUser('spent');
        await store.addSpend(t.ctx.s, `user:${u.subject}`, 0.05);
        const r = await t.get('/api/v1/tasks', { as: u, json: { task: 'one more' }, headers: SAME });
        assert.strictEqual(r.status, 429);
        assert.strictEqual(r.json().code, 'actor.budget.day_spent');
        assert.match(r.json().detail, /You have used today's free allowance/);
        assert.match(r.json().detail, /add your own model key at https:\/\/openvibe\.actor\/chat\/model/);
        assert.ok(Number(r.headers.get('retry-after')) > 0);

        // The site's own form says the same, where the person typed the task.
        const page = await t.get('/tasks', { as: u, form: { task: 'one more', mode: 'balanced' }, headers: SAME });
        assert.strictEqual(page.status, 429);
        assert.match(page.text, /add your own model key/);
        assert.match(page.text, /chat\/model/);
    });

    await check('the chat composer and the task box show the allowance left today', async () => {
        const u = t.network.addUser('shown');
        await store.addSpend(t.ctx.s, `user:${u.subject}`, 0.0123);
        const chat = await t.get('/chat', { as: u });
        assert.strictEqual(chat.status, 200);
        assert.match(chat.text, /\$0\.0377 of the \$0\.05 free allowance left today/);
        const home = await t.get('/', { as: u });
        assert.strictEqual(home.status, 200);
        assert.match(home.text, /\$0\.0377 of the \$0\.05 free allowance left today/);
    });

    await t.close();
    done();
})().catch((e) => { console.error(e); process.exit(1); });

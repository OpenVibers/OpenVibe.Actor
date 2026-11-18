'use strict';
/**
 * Try an Expert before installing it (plan §AD.28 item 9; migration 0083): Try it on an Expert's page starts a chat with
 * a trial of it, its first message one of the Expert's starters. The trial is the Expert's persona with nothing it may
 * do granted (no apps, no computer, no memory, level ask) and sample details for its inputs; it is hidden from the
 * person's agents and counts against no limit; a second try of the same Expert reuses it. Signed out signs in first;
 * a cross-site post is refused.
 *   node test/expert-try.test.js
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

const SAME = { 'sec-fetch-site': 'same-origin', origin: 'http://127.0.0.1' };

(async () => {
    const t = await boot();
    const ada = t.network.addUser('ada');
    const answer = (content) => { t.providers.reset(); t.providers.state.script = [{ content }, { content }, { content }, { content }]; };
    const taskOf = (location) => /\/chat\/(tsk_[0-9A-Za-z]+)/.exec(String(location || ''))[1];
    try {
        await check('an Expert\'s page offers Try it beside Install, and its starters to try', async () => {
            const r = await t.get('/experts/bp_budget_coach');
            assert.strictEqual(r.status, 200);
            assert.match(r.text, /<form method="post" action="\/experts\/bp_budget_coach\/try"><input type="hidden" name="starter" value="0"><button type="submit" class="ex-btn ex-btn--primary">/);
            assert.match(r.text, /Try it now/);
            assert.match(r.text, /nothing is installed/);
        });

        let trialId;
        await check('Try it: a chat with a trial of the Expert, its persona and nothing it may do, hidden from your agents', async () => {
            answer('Start with what came in last month.');
            const r = await t.get('/experts/bp_budget_coach/try', { as: ada, method: 'POST', headers: SAME, form: { starter: '0' } });
            assert.strictEqual(r.status, 303, r.text.slice(0, 300));
            assert.match(r.headers.get('location'), /^\/chat\/tsk_/);
            const task = await t.ctx.s.db.maybe('SELECT agent_id, task FROM tasks WHERE id = $1', [taskOf(r.headers.get('location'))]);
            const agent = await t.ctx.s.db.maybe('SELECT * FROM actor_agents WHERE id = $1', [task.agent_id]);
            assert.strictEqual(agent.trial_of, 'bp_budget_coach');
            assert.ok(agent.trial_until, 'it says when a fresh one is made');
            assert.deepStrictEqual([agent.apps, agent.computer, agent.memory_scope, agent.level], [[], null, null, 'ask'], 'nothing it may do is granted');
            assert.strictEqual(agent.name, 'Budget coach');
            assert.ok(task.task.length > 0, 'its first message is a starter');
            trialId = agent.id;
            await t.waitFor(taskOf(r.headers.get('location')));
            const mine = await t.get('/api/v1/agents', { as: ada });
            assert.ok(!JSON.stringify(mine.json()).includes(trialId), 'not one of your agents');
        });

        await check('a second try of the same Expert reuses the trial; another starter is the first message', async () => {
            answer('Pick the three biggest subscriptions.');
            const r = await t.get('/experts/bp_budget_coach/try', { as: ada, method: 'POST', headers: SAME, form: { starter: '1' } });
            assert.strictEqual(r.status, 303, r.text.slice(0, 300));
            const task = await t.ctx.s.db.maybe('SELECT agent_id FROM tasks WHERE id = $1', [taskOf(r.headers.get('location'))]);
            assert.strictEqual(task.agent_id, trialId);
            assert.strictEqual(Number(await t.ctx.s.db.value("SELECT count(*) FROM actor_agents WHERE owner = $1 AND trial_of = 'bp_budget_coach'", [`user:${ada.subject}`])), 1);
            await t.waitFor(taskOf(r.headers.get('location')));
        });

        await check('an Expert with an input is tried with sample details (a channel: your own)', async () => {
            answer('I will watch for the moments.');
            const r = await t.get('/experts/bp_clip_finder/try', { as: ada, method: 'POST', headers: SAME, form: {} });
            assert.strictEqual(r.status, 303, r.text.slice(0, 300));
            const task = await t.ctx.s.db.maybe('SELECT agent_id FROM tasks WHERE id = $1', [taskOf(r.headers.get('location'))]);
            const agent = await t.ctx.s.db.maybe('SELECT instructions, trial_of FROM actor_agents WHERE id = $1', [task.agent_id]);
            assert.strictEqual(agent.trial_of, 'bp_clip_finder');
            await t.waitFor(taskOf(r.headers.get('location')));
        });

        await check('signed out signs in first; a post from another site is refused; a draft or unknown id is missing', async () => {
            const out = await t.get('/experts/bp_budget_coach/try', { method: 'POST', headers: SAME, form: {} });
            assert.strictEqual(out.status, 303);
            assert.match(out.headers.get('location'), /^\/auth\/login\?next=%2Fexperts%2Fbp_budget_coach$/);
            const cross = await t.get('/experts/bp_budget_coach/try', { as: ada, method: 'POST', headers: { 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' }, form: {} });
            assert.strictEqual(cross.status, 403);
            const none = await t.get('/experts/bp_no_such_one/try', { as: ada, method: 'POST', headers: SAME, form: {} });
            assert.strictEqual(none.status, 404);
        });
    } finally {
        await t.close?.();
    }
    done();
})().catch((err) => { console.error(err); process.exit(1); });

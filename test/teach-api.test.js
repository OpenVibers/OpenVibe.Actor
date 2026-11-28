'use strict';
// Teach as an API (plan AD.39 item 11, §AD.33): POST /api/v1/me/agents/:id/lessons starts a lesson for one of the
// person's agents (shown on a desk or told in words) and answers with the lesson and its task; GET lists the agent's
// lessons. Another person's agent is not there; a lesson with nothing said is refused with the same words as the page.
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const personal = require('../server/agents/personal');

const SAME = { 'sec-fetch-site': 'same-origin' };

(async () => {
    const t = await boot({});
    const s = t.ctx.s;
    const kim = t.network.addUser('kim-teach-api');
    const lee = t.network.addUser('lee-teach-api');
    const agent = (await personal.create(s, t.config, `user:${kim.subject}`, { name: 'Shopper', instructions: 'Shop for me.', mode: 'balanced', budget_per_run_usd: 0.05, daily_runs_max: 20, schedule: 'off', status: 'active' })).row;
    const post = (path, json, as = kim) => t.get(path, { as, method: 'POST', json, headers: SAME });
    try {
        await check('a lesson told in words starts over the API, with its task and where to watch it', async () => {
            const r = await post(`/api/v1/me/agents/${agent.id}/lessons`, { what: 'Find a product in the shop', how: 'words', words: 'Open the shop, type the product in the search box and press Enter, then open the first result.', practice: 'off' });
            assert.strictEqual(r.status, 201, r.text);
            const j = r.json();
            assert.strictEqual(j.lesson.agent_id, agent.id);
            assert.strictEqual(j.lesson.how, 'words');
            assert.strictEqual(j.lesson.what, 'Find a product in the shop');
            assert.ok(j.task && j.task.id && j.lesson.task_id === j.task.id);
            assert.ok(j.watch_url.endsWith(`/tasks/${j.task.id}`));
            assert.strictEqual(r.headers.get('location'), `/api/v1/tasks/${j.task.id}`);
        });

        await check('the agent\'s lessons are listed; another person\'s agent is not there; nothing said is refused', async () => {
            const list = await t.get(`/api/v1/me/agents/${agent.id}/lessons`, { as: kim });
            assert.strictEqual(list.status, 200, list.text);
            assert.strictEqual(list.json().lessons.length, 1);
            assert.strictEqual(list.json().lessons[0].how, 'words');
            assert.strictEqual((await t.get(`/api/v1/me/agents/${agent.id}/lessons`, { as: lee })).status, 404, 'not lee\'s agent');
            const empty = await post(`/api/v1/me/agents/${agent.id}/lessons`, { what: '' });
            assert.strictEqual(empty.status, 422);
            assert.strictEqual(empty.json().code, 'actor.teach.invalid');
        });
    } finally {
        await t.close();
    }
    done();
})();

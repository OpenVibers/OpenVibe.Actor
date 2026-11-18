'use strict';
// The conversation's approval level (agents.run@1 1.5.0 `level`; the owner, 11-18: "make these approvals just built into
// the chat … adjust the approval methods in the little composer area"):
//   - a conversation's run says the level its next turn runs at, the agent's own, what always asks, and that it can be set;
//   - PATCH { level } sets it on every turn, so the walk up the turns finds it; a level that does not exist is refused;
//   - a title still renames; another person never sets it.
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

(async () => {
    const t = await boot();
    try {
        const ada = t.network.addUser('ada-level');
        const bo = t.network.addUser('bo-level');
        const db = t.ctx.s.db;
        const root = 'tsk_01M7P78K4FGZ6J3PNXDMT9N9KA';
        const next = 'tsk_01M7P78K4FGZ6J3PNXDMT9N9KB';
        const at = new Date().toISOString();
        const row = (id, parent, level) => ({ id, requester: `user:${ada.subject}`, project_id: 'prj_01M7A6T4Y2ZNWTMM8VR6HW5T17', task: 'Tidy the docs', mode: 'balanced', state: 'succeeded',
            budget_task: 0.05, budget_day: 0.5, last_seq: 1, webhooks: [], level, parent_id: parent, created_at: at, finished_at: at, result: { answer: 'Done.', agent: 'openvibe-runtime', class: 'answer' } });
        await db.exec('INSERT INTO tasks SELECT * FROM jsonb_populate_record(NULL::tasks, $1::jsonb)', [JSON.stringify(row(root, null, 'full'))]);
        await db.exec('INSERT INTO tasks SELECT * FROM jsonb_populate_record(NULL::tasks, $1::jsonb)', [JSON.stringify(row(next, root, 'ask'))]);
        const SAME = { 'sec-fetch-site': 'same-origin' };

        await check('the run says its level, the agent\'s own, what always asks, and that it can be set', async () => {
            const r = await t.get(`/api/v1/runs/${root}?conversation=1&shape=agents.run@1`, { as: ada });
            assert.strictEqual(r.status, 200, r.text);
            const level = r.json().level;
            assert.ok(level, JSON.stringify(r.json()));
            assert.strictEqual(level.now, 'full', 'the conversation was started at full');
            assert.strictEqual(level.agent, 'ask');
            assert.deepStrictEqual(level.always_asks, ['money', 'password', 'delete', 'new_recipient']);
            assert.strictEqual(level.can_set, true);
        });

        await check('PATCH { level } sets it on every turn; the next turn runs at it', async () => {
            const r = await t.get(`/api/v1/runs/${root}`, { as: ada, headers: SAME, method: 'PATCH', json: { level: 'auto-edits' } });
            assert.strictEqual(r.status, 200, r.text);
            assert.strictEqual(r.json().level.now, 'auto-edits', 'lowered from full: every turn, so no older one keeps it higher');
            const kept = await db.many('SELECT id, level FROM tasks WHERE id = ANY($1::text[]) ORDER BY id', [[root, next]]);
            assert.deepStrictEqual(kept.map((x) => x.level), ['auto-edits', 'auto-edits']);
            const contacts = require('../server/agents/contacts');
            const third = { id: 'tsk_x', requester: `user:${ada.subject}`, parent_id: next, level: 'ask' };
            assert.strictEqual(await contacts.effectiveLevelFor(t.ctx.s, third, { level: 'ask' }), 'auto-edits', 'a new turn inherits it');
        });

        await check('a level that does not exist is refused; a title still renames; another person never sets it', async () => {
            const bad = await t.get(`/api/v1/runs/${root}`, { as: ada, headers: SAME, method: 'PATCH', json: { level: 'whatever' } });
            assert.strictEqual(bad.status, 422);
            const named = await t.get(`/api/v1/runs/${root}`, { as: ada, headers: SAME, method: 'PATCH', json: { title: 'Docs tidy-up' } });
            assert.strictEqual(named.status, 200, named.text);
            assert.strictEqual(named.json().title, 'Docs tidy-up');
            const theirs = await t.get(`/api/v1/runs/${root}`, { as: bo, headers: SAME, method: 'PATCH', json: { level: 'full' } });
            assert.ok([403, 404].includes(theirs.status), `not theirs (${theirs.status})`);
            const still = await db.one('SELECT level FROM tasks WHERE id = $1', [root]);
            assert.strictEqual(still.level, 'auto-edits');
        });
    } finally { await t.close(); }
    done();
})();

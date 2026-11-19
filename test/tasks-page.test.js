'use strict';
// Your tasks, redesigned (the owner's screenshot, 2026-11-19: "Improve, Redesign" over a task box whose five mode cards
// filled a phone). What this proves:
//   - today's allowance is one meter with its numbers once;
//   - the task box offers the mode as a row of pills (plain radios) with the chosen one's meaning, not five cards;
//   - the tasks are rows with their state in words, and the filters show only their states;
//   - an unknown filter is All, and an empty filter says so with a way back.
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

(async () => {
    const t = await boot({ adapters: {
        checkers: { local: async () => ({ text: '{"ok":true,"reason":"answers"}', cost_usd: 0 }) },
        run: { 'open-model': async () => ({ text: 'Mars is the fourth planet.', sources: [], model: 'fake' }) },
    } });
    try {
        const ada = t.network.addUser('tasks-page-ada');
        const start = async (task) => {
            const r = await t.get('/api/v1/tasks', { as: ada, json: { task, mode: 'private' }, headers: { 'sec-fetch-site': 'same-origin' } });
            assert.strictEqual(r.status, 201, r.text);
            return t.waitFor(r.json().id);
        };
        const done1 = await start('Which planet is fourth from the sun?');
        const failed = await start('Tell me about Mars.');
        await t.ctx.s.db.query("UPDATE tasks SET state = 'failed' WHERE id = $1", [failed.id]);

        await check('the allowance is one meter, the box has the mode as pills', async () => {
            const html = (await t.get('/tasks', { as: ada })).text;
            assert.ok(html.includes('class="tk-meter"'), 'one meter');
            assert.ok(/<b>2<\/b> of \d+ free tasks today/.test(html), 'its numbers once');
            assert.strictEqual((html.match(/<label class="mode"/g) || []).length, 5, 'five mode pills');
            assert.ok(!/<label class="mode"><input[^>]*><span><b>/.test(html), 'not the old cards');
            assert.ok(html.includes('class="mode-say"') && html.includes('data-mode="balanced"'), 'the chosen mode said in one line');
            assert.ok(html.includes('js/tasks.js'), 'the box grows and older tasks load as you scroll');
        });
        await check('rows with their state in words; the filters show only their states', async () => {
            const all = (await t.get('/tasks', { as: ada })).text;
            assert.strictEqual((all.match(/<li class="tk-row">/g) || []).length, 2);
            assert.ok(all.includes('>Done</span>') && all.includes('>Didn&#39;t finish</span>') || all.includes(">Didn't finish</span>"), 'states in words');
            assert.ok(all.includes('aria-current="page">All</a>'));
            const stopped = (await t.get('/tasks?show=stopped', { as: ada })).text;
            assert.strictEqual((stopped.match(/<li class="tk-row">/g) || []).length, 1);
            assert.ok(stopped.includes(`/tasks/${failed.id}`) && !stopped.includes(`/tasks/${done1.id}"`));
            const doneOnly = (await t.get('/tasks?show=done', { as: ada })).text;
            assert.ok(doneOnly.includes(`/tasks/${done1.id}`) && !doneOnly.includes(`/tasks/${failed.id}"`));
        });
        await check('an unknown filter is All; an empty one says so with a way back', async () => {
            const odd = (await t.get('/tasks?show=everything-please', { as: ada })).text;
            assert.ok(odd.includes('aria-current="page">All</a>'));
            const none = (await t.get('/tasks?show=needs_you', { as: ada })).text;
            assert.ok(none.includes('Nothing here') && none.includes('href="/tasks">Show all your tasks'));
        });
    } finally { await t.close(); }
    done('tasks page');
})();

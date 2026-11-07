'use strict';
/**
 * Your agents as contacts, on the pages (plan §12 A-1): the roster puts Vibe first, a preset makes an agent in one
 * press, and the agent's sheet sets its level with the always-ask floor in view. Another person's agent is a 404.
 *
 *   node test/agents-roster-pages.test.js
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const SAME = { 'sec-fetch-site': 'same-origin' };

(async () => {
    const t = await boot();
    try {
        const a = t.network.addUser('roster-a');
        const b = t.network.addUser('roster-b');
        let inbox = null;

        await check('the roster: Vibe first, with what each agent uses and its level', async () => {
            const page = await t.get('/me/agents', { as: a });
            assert.strictEqual(page.status, 200);
            const rows = [...page.text.matchAll(/<a class="ac-row" href="\/me\/agents\/(agt_[0-9A-Z]{26})">[\s\S]*?<strong>([^<]+)<\/strong>/g)];
            assert.strictEqual(rows[0][2], 'Vibe', 'Vibe is first');
            assert.ok(page.text.includes('Your first agent'));
            assert.ok(page.text.includes('<span class="ac-level" data-level="ask">Asks first</span>'), 'its level in two words');
            assert.ok(page.text.includes('<span class="ac-row-uses">OpenVibe AI</span>'), 'what it uses');
            for (const id of ['researcher', 'inbox', 'studio-editor', 'party-host']) assert.ok(page.text.includes(`name="preset" value="${id}"`), `the ${id} preset`);
        });

        await check('a preset makes an agent in one press', async () => {
            const made = await t.get('/me/agents/preset', { as: a, form: { preset: 'inbox' }, headers: SAME });
            assert.strictEqual(made.status, 303, made.text);
            inbox = String(made.headers.get('location')).split('/').pop();
            const sheet = await t.get(`/me/agents/${inbox}`, { as: a });
            assert.match(sheet.text, /<h1>Inbox<\/h1>/);
            assert.ok(sheet.text.includes('OpenVibe AI, fast · Email, Slack'), 'what it uses, in words');
            assert.strictEqual((await t.get('/me/agents/preset', { as: a, form: { preset: 'nope' }, headers: SAME })).status, 422, 'an unknown preset');
            assert.strictEqual((await t.get('/me/agents/preset', { as: a, form: { preset: 'inbox' }, headers: { 'sec-fetch-site': 'cross-site' } })).status, 403, 'only from Actor itself');
        });

        await check('the level picker saves, and the floor is always in view', async () => {
            const sheet = await t.get(`/me/agents/${inbox}`, { as: a });
            assert.ok(sheet.text.includes('value="ask" checked'), 'asks first by default');
            assert.match(sheet.text, /Always asks, at every level:<\/b> spending money · a password or key · deleting something · messaging someone new\./);
            const saved = await t.get(`/me/agents/${inbox}/level`, { as: a, form: { level: 'approve-for-me' }, headers: SAME });
            assert.strictEqual(saved.status, 303);
            assert.strictEqual(saved.headers.get('location'), `/me/agents/${inbox}#level`);
            const after = await t.get(`/me/agents/${inbox}`, { as: a });
            assert.ok(after.text.includes('value="approve-for-me" checked'));
            assert.ok(after.text.includes('<span class="ac-level" data-level="approve-for-me">A second model checks</span>'));
            assert.strictEqual((await t.get(`/me/agents/${inbox}/level`, { as: a, form: { level: 'everything' }, headers: SAME })).status, 422, 'an unknown level');
        });

        await check('another person cannot see or change it', async () => {
            assert.strictEqual((await t.get(`/me/agents/${inbox}`, { as: b })).status, 404);
            assert.strictEqual((await t.get(`/me/agents/${inbox}/level`, { as: b, form: { level: 'full' }, headers: SAME })).status, 404);
            assert.ok((await t.get(`/me/agents/${inbox}`, { as: a })).text.includes('value="approve-for-me" checked'), 'unchanged');
        });
    } finally {
        await done(t);
    }
})();

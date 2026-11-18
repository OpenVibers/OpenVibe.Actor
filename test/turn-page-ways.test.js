'use strict';
/**
 * A spent free allowance on Actor's own turn page (/chat/:id; the owner, 11-17, on the raw 402: "This should guide the
 * user to set up their different coding agents or the harnesses … or their own computer … rather than just being a
 * lame ass message"). When OpenVibe's free AI is used up and nothing of the person's took the turn, the page says so in
 * words and offers the ways to keep going (your own AI key, your computer, coding agents) and a retry; the router's raw
 * 402, with the person's id in it, is never shown, in the card or in the work list.
 *   node test/turn-page-ways.test.js
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const taskEvents = require('../public/js/task-events');

const SAME = { 'sec-fetch-site': 'same-origin', accept: 'application/json' };
const SPENT = 'OpenVibe.Exchange HTTP 402: The free AI allowance for usr_01KKT9AC60KM7CRTB3WN1Z8P56 is spent, and the calling service has no budget to cover this run.';

(async () => {
    await check('the work list says it in words', async () => {
        const lines = taskEvents.lines([{ seq: 1, kind: 'output', step: 'text', text: SPENT, is_error: true }], { final: true, state: 'failed' });
        const said = JSON.stringify(lines);
        assert.ok(/free AI is used up for today/.test(said), said);
        assert.ok(!/HTTP 402|usr_/.test(said), said);
        const other = JSON.stringify(taskEvents.lines([{ seq: 1, kind: 'output', step: 'text', text: 'upstream broke', is_error: true }], { final: true, state: 'failed' }));
        assert.ok(/upstream broke/.test(other), 'another error keeps its words');
    });

    const t = await boot({
        loop: { close: async () => {}, run: async () => { throw Object.assign(new Error(SPENT), { status: 402, code: 'actor.provider.error' }); } },
        adapters: { checkers: { local: async () => ({ text: '{"ok":true,"reason":"answers"}', cost_usd: 0 }) } },
        bot: { computers: { enabled: true, mine: async () => [] } },
    });
    try {
        const ada = t.network.addUser('ada');
        await check('the turn page offers the ways to keep going, never the raw 402', async () => {
            const id = (await t.get('/api/v1/tasks', { as: ada, json: { task: 'Find me three cheap GPU rentals' }, headers: SAME })).json().id;
            const row = await t.waitFor(id);
            assert.strictEqual(row.state, 'failed');
            const page = await t.get(`/chat/${id}`, { as: ada, headers: { accept: 'text/html' } });
            assert.strictEqual(page.status, 200, page.text.slice(0, 300));
            const html = page.text;
            assert.ok(html.includes('OpenVibe&#39;s free AI is used up for today') || html.includes("OpenVibe's free AI is used up for today"), 'says it in words');
            assert.ok(html.includes('href="/chat/model"'), 'your own AI key');
            assert.ok(/href="https:\/\/openvibe\.link\/add-computer\?return_to=[^"]+%2Fchat%2Ftsk_/.test(html), 'your computer, back to this turn');
            assert.ok(html.includes('href="https://openvibe.codes/setup"'), 'coding agents');
            assert.ok(html.includes('class="ct-retry"'), 'and a retry');
            assert.ok(!html.includes('HTTP 402') && !html.includes('usr_01KKT9AC60KM7CRTB3WN1Z8P56'), 'never the raw 402 or the id');
        });
    } finally {
        await t.close();
    }
    done();
})().catch((err) => { console.error(err); process.exit(1); });

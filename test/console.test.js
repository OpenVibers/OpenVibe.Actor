'use strict';
/**
 * The Console folded into the chat (one-agent system, stage 1: the owner, 11-12, "having this thing on the console
 * doesn't make any sense … you should just chat with it"). /console answers 301 to /chat, carrying the Frame's "Ask
 * Actor" prefill (?ask= and ?from=) into the composer; its one non-conversation page, /me/spend, stays. The APIs and
 * pages the console linked to (approvals, your agents, computers and robots) are kept.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const store = require('../server/tasks/store');

(async () => {
    const t = await boot();
    try {
        const ada = t.network.addUser('ada');
        const bo = t.network.addUser('bo');
        const owner = `user:${ada.subject}`;

        await check('/console answers 301 to the chat, signed in or not, and keeps no page of its own', async () => {
            const out = await t.get('/console');
            assert.strictEqual(out.status, 301, 'a permanent redirect');
            assert.strictEqual(out.headers.get('location'), '/chat');
            assert.ok(!/<h1>Console<\/h1>/.test(out.text), 'no console markup');
            const mine = await t.get('/console', { as: ada });
            assert.strictEqual(mine.status, 301);
            assert.strictEqual(mine.headers.get('location'), '/chat');
        });

        await check('?ask= and ?from= go to the chat composer, escaped, and nothing runs; another site\'s address is dropped', async () => {
            const before = (await t.ctx.s.db.maybe('SELECT count(*)::int AS n FROM tasks')).n;
            const q = `?ask=${encodeURIComponent('Summarise <this> & explain')}&from=${encodeURIComponent('https://openvibe.wiki/s/openvibe/actor')}`;
            const r = await t.get(`/console${q}`, { as: ada });
            assert.strictEqual(r.status, 301);
            assert.strictEqual(r.headers.get('location'), `/chat?ask=${encodeURIComponent('Summarise <this> & explain\n\n(On this page: https://openvibe.wiki/s/openvibe/actor)')}`);
            const chat = await t.get(r.headers.get('location'), { as: ada });
            assert.strictEqual(chat.status, 200);
            assert.ok(chat.text.includes('>Summarise &lt;this&gt; &amp; explain\n\n(On this page: https://openvibe.wiki/s/openvibe/actor)</textarea>'), 'escaped, in the fallback box and data-text');
            const foreign = await t.get(`/console?ask=hi&from=${encodeURIComponent('https://evil.example/x')}`);
            assert.strictEqual(foreign.headers.get('location'), '/chat?ask=hi', 'another site\'s address is not carried');
            assert.strictEqual((await t.ctx.s.db.maybe('SELECT count(*)::int AS n FROM tasks')).n, before, 'nothing ran');
        });

        await check('/me/spend: the last 30 days as bars and a table, signed in only; it is linked from Settings', async () => {
            await store.addSpend(t.ctx.s, owner, 0.0012, { tasks: 2 });
            const r = await t.get('/me/spend', { as: ada });
            assert.strictEqual(r.status, 200);
            assert.match(r.text, /<h1>Spend<\/h1>/);
            assert.match(r.text, /Last 30 days: <b>\$0\.0012<\/b>, 2 tasks/);
            assert.strictEqual((r.text.match(/class="cn-bar"/g) || []).length, 30);
            assert.strictEqual((await t.get('/me/spend')).status, 302, 'signed out: sign in first');
            assert.match((await t.get('/chat/settings', { as: ada })).text, /href="\/me\/spend"/, 'Settings links it');
        });

        await check('the pages and modules the console used are still here (approvals, agents, computers, robots)', async () => {
            assert.strictEqual(typeof require('../server/http/console-pages').createConsolePages, 'function');
            assert.strictEqual(typeof require('../server/http/memory-pages').createMemoryPages, 'function');
            for (const mod of ['../server/agents/computers', '../server/agents/robots', '../server/agents/approvals', '../server/agents/personal']) {
                assert.ok(Object.keys(require(mod)).length, `${mod} still exports its API`);
            }
            assert.strictEqual((await t.get('/me/approvals', { as: ada })).status, 200);
            assert.strictEqual((await t.get('/me/agents', { as: ada })).status, 200);
            assert.match((await t.get('/memory', { as: ada })).text, /href="\/chat\/settings"/, 'the old Console link is Settings');
            assert.ok(!(await t.get('/chat', { as: bo })).text.includes('ada'), 'the Now strip is the person\'s own');
        });
    } finally { await t.close(); }
    done();
})().catch((e) => { console.error(e); process.exit(1); });

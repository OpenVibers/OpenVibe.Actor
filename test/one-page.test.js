'use strict';
/**
 * One agent system, stage 1: Actor's chat is the one place you use Actor.
 *   - the empty chat shows four compact suggestion chips, not a wall of cards; a chat with messages shows none;
 *   - the run settings ("New runs: Only me … Apply to all my existing runs") are in Settings, not under the composer;
 *   - /console is 301 to /chat, and the phone tab bar is Home, Chat, Agents;
 *   - a running task is a card in the conversation (title, state, the last steps, Stop) that updates in place, and the
 *     "Now" strip at the top of the chat has one line per running task, Stop on each, hidden when nothing runs.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const store = require('../server/tasks/store');

(async () => {
    const t = await boot();
    const s = t.ctx.s;
    const SAME = { 'sec-fetch-site': 'same-origin' };
    try {
        const kim = t.network.addUser('kim');
        const bo = t.network.addUser('bo');
        const owner = `user:${kim.subject}`;
        const task = async (text, state = 'running', who = owner) => {
            const id = s.newId('tsk');
            await store.insertTask(s, { id, requester: who, task: text, mode: 'balanced', budget_task: 0.05, budget_day: 0.5, created_at: s.iso() });
            if (state !== 'queued') await store.updateTask(s, id, { state });
            return id;
        };
        const event = (body) => store.appendEvent(s, running, { kind: 'output', at: s.iso(), ...body });
        const running = await task('Check the certificate of example.com');

        await check('an empty chat: four compact suggestion chips, one line each, and no run-settings form', async () => {
            const r = await t.get('/chat', { as: kim });
            assert.strictEqual(r.status, 200);
            assert.strictEqual((r.text.match(/class="ct-suggest-chip"/g) || []).length, 4);
            assert.strictEqual((r.text.match(/data-ovt-starter="/g) || []).length, 4, 'one starter per chip, no more');
            assert.ok(!/class="ct-starters"/.test(r.text), 'the card grid is gone');
            assert.ok(!/ct-share-defaults/.test(r.text), 'the run settings are off the chat');
            assert.match(r.text, /data-cc-composer/, 'composer v2 host');
        });

        await check('a chat with messages shows no suggestion chips', async () => {
            const r = await t.get(`/chat/${running}`, { as: kim });
            assert.strictEqual(r.status, 200);
            assert.ok(!/data-ovt-starter=/.test(r.text), 'no suggestions once there is a conversation');
        });

        await check('the run settings live in Settings, with the same route and behaviour', async () => {
            const page = await t.get('/chat/settings', { as: kim });
            assert.strictEqual(page.status, 200);
            assert.match(page.text, /<h1>Settings<\/h1>/);
            assert.match(page.text, /<form class="ct-share-defaults" method="post" action="\/chat\/defaults">/);
            assert.match(page.text, /name="from" value="settings"/);
            assert.match(page.text, /Apply to all my existing runs/);
            assert.match(page.text, /href="\/chat\/model"/, 'the model settings are one link away');
            const saved = await t.get('/chat/defaults', { as: kim, form: { audience: 'private', from: 'settings' }, headers: SAME });
            assert.strictEqual(saved.status, 303);
            assert.strictEqual(saved.headers.get('location'), '/chat/settings?saved=1');
            assert.match((await t.get('/chat/settings?saved=1', { as: kim })).text, /Saved\. Your next run starts as Only me/);
            assert.strictEqual((await t.get('/chat/settings')).status, 303, 'signed out: sign in first');
        });

        await check('a running task is a card in the conversation: title, state, last steps, Stop', async () => {
            await event({ step: 'tool_call', tool: 'web_search', input: 'example.com certificate' });
            await event({ step: 'text', text: 'Reading the certificate page' });
            const page = await t.get(`/chat/${running}`, { as: kim });
            assert.strictEqual(page.status, 200);
            assert.match(page.text, new RegExp(`<article class="ovt-card ct-run" data-ct-run="${running}">`));
            assert.match(page.text, /Check the certificate of example\.com/);
            assert.match(page.text, /data-ct-run-state>Working…</);
            assert.match(page.text, /data-ovt-live>Reading the certificate page</, 'the last step, not a whole panel');
            assert.match(page.text, /data-ovt-work>/, 'the card keeps the steps for the live refresh');
            assert.match(page.text, new RegExp(`<form class="ct-run-stop" method="post" action="/chat/${running}/cancel">`));
        });

        await check('the card updates in place: the fragment has the new step, then the finished turn has no card', async () => {
            await event({ step: 'tool_call', tool: 'read_page', input: 'https://example.com' });
            const open = await t.get(`/chat/turn/${running}`, { as: kim });
            assert.strictEqual(open.status, 200);
            assert.match(open.text, /Read a page/, 'the newest step is in the refresh');
            await store.updateTask(s, running, { state: 'verifying' });
            const checking = await t.get(`/chat/turn/${running}`, { as: kim });
            assert.match(checking.text, /data-ct-run-state>Checking the answer…</);
            await store.updateTask(s, running, { state: 'succeeded', finished_at: s.iso(), result: { answer: 'It is valid.' } });
            const finished = await t.get(`/chat/turn/${running}`, { as: kim });
            assert.ok(!/data-ct-run=/.test(finished.text), 'a finished turn is the ordinary answer');
            assert.match(finished.text, /It is valid\./);
        });

        await check('the Now strip: one line per running task with Stop, hidden when nothing runs', async () => {
            const live = await task('Read the news for me');
            const queued = await task('Summarise the release notes', 'queued');
            const page = await t.get('/chat', { as: kim });
            assert.strictEqual((page.text.match(/class="ct-now-item"/g) || []).length, 1, 'only what is running now');
            const strip = page.text.slice(page.text.indexOf('<section class="ct-now"'), page.text.indexOf('</section>', page.text.indexOf('<section class="ct-now"')));
            assert.match(strip, /Read the news for me/);
            assert.ok(!/Summarise the release notes/.test(strip), 'a queued task is not running yet');
            assert.match(page.text, /class="ct-now-stop" method="post" action="\/chat\/tsk_[0-9A-Z]{26}\/cancel"/);
            const now = await t.get('/chat/now', { as: kim });
            assert.strictEqual(now.status, 200);
            assert.match(now.text, /Read the news for me/);
            const empty = await t.get('/chat', { as: bo });
            assert.match(empty.text, /<section class="ct-now" data-ct-now hidden><\/section>/, 'nothing runs: no strip');
            assert.strictEqual((await t.get('/chat/now')).status, 401);
            await store.updateTask(s, live, { state: 'cancelled' });
            await store.updateTask(s, queued, { state: 'cancelled' });
        });

        await check('Stop on the card (and on the strip) cancels the run and comes back to the chat', async () => {
            const stop = await task('Watch this page');
            const before = t.ctx.engine.cancel;
            const cancelled = [];
            t.ctx.engine.cancel = async (id) => { cancelled.push(id); await store.updateTask(s, id, { state: 'cancelled' }); };
            try {
                const card = await t.get(`/chat/${stop}/cancel`, { as: kim, form: { do: 'stop' }, headers: SAME });
                assert.strictEqual(card.status, 303);
                assert.strictEqual(card.headers.get('location'), `/chat/${stop}`);
                assert.deepStrictEqual(cancelled, [stop], 'the run was stopped');
                assert.strictEqual((await store.getTask(s, stop)).state, 'cancelled');
                const theirs = await t.get(`/chat/${stop}/cancel`, { as: bo, form: { do: 'stop' }, headers: SAME });
                assert.deepStrictEqual([theirs.status, theirs.headers.get('location')], [303, '/chat'], 'another person: nothing');
                assert.strictEqual((await t.get(`/chat/${stop}/cancel`, { as: kim, form: { do: 'stop' }, headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
            } finally { t.ctx.engine.cancel = before; }
        });

        await check('/console is 301 to the chat, and the phone tab bar is Home, Chat, Agents', async () => {
            const out = await t.get('/console', { as: kim });
            assert.strictEqual(out.status, 301);
            assert.strictEqual(out.headers.get('location'), '/chat');
            const page = await t.get('/chat', { as: kim });
            const bar = /"appBar":\[(.*?)\]/.exec(page.text);
            assert.ok(bar, 'the app bar is in the page config');
            assert.deepStrictEqual([...bar[1].matchAll(/"label":"([^"]+)"/g)].map((m) => m[1]), ['Home', 'Chat', 'Agents']);
            assert.ok(!/"label":"Console"/.test(page.text), 'no Console anywhere in the navigation');
        });

        await check('phone first: the controls the change adds are at least 44 px and the layout can shrink', async () => {
            const css = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'css', 'chat.css'), 'utf8');
            assert.match(css, /@media \(max-width: 640px\)[\s\S]*\.cc-composer \.ovc-v2 \.ovt-btn, \.cc-composer \.ovc-v2 \.ovt-send \{ width: 44px; height: 44px; min-width: 44px; min-height: 44px; \}/);
            assert.match(css, /\.ct-now-stop button \{[^}]*min-height: 44px/);
            assert.match(css, /\.ct-now-task \{[^}]*min-height: 44px/);
            assert.match(css, /\.ct-run-stop \.ovt-card-btn \{[^}]*min-height: 44px/);
            assert.match(css, /\.ct-suggest-chip \{[^}]*min-height: 44px/);
            assert.match(css, /\.ct-now-item \{[^}]*minmax\(0,/, 'every track can shrink: nothing is wider than the phone');
            const page = await t.get('/chat', { as: kim });
            assert.match(page.text, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
        });
    } finally { await t.close(); }
    done();
})().catch((e) => { console.error(e); process.exit(1); });

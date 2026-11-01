'use strict';
// The chat (plan L55 C1; the owner, 2026-11-01: "a whole conversation system, like Gemini or ChatGPT… your conversations
// on the left… way cleaner"): a conversation is a chain of follow-ups, the sidebar is the person's chains, each turn is
// a bubble and a reply with the work folded and one quiet line; everything else is the turn's Details page. Only the
// person's own chats, only from Actor itself, and a browser opening a task lands in its chat.
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const { chatsOf, groupOf } = require('../server/http/chat-pages');

const SAME = { 'sec-fetch-site': 'same-origin' };
const LOC = /^\/chat\/(tsk_[0-9A-HJKMNP-TV-Z]{26})#t-\1$/;

(async () => {
    const t = await boot();
    const kim = t.network.addUser('kim');
    const bo = t.network.addUser('bo');
    t.config.loop.selfReflections = 0;
    const s = t.ctx.s;
    const say = async (text, o = {}) => {
        t.providers.state.script = [{ content: o.answer || 'Hetzner CX22 at €4.51 a month [E1].' }];
        const r = await t.get('/chat', { as: o.as || kim, form: { task: text, ...(o.parent ? { parent: o.parent } : {}), ...(o.mode ? { mode: o.mode } : {}) }, headers: o.headers || SAME });
        return r;
    };
    const idOf = (r) => { const m = LOC.exec(r.headers.get('location') || ''); assert.ok(m, `redirect to the chat, got ${r.status} ${r.headers.get('location')}`); return m[1]; };

    try {
        await check('signed out, /chat asks you to sign in first', async () => {
            const r = await t.get('/chat');
            assert.strictEqual(r.status, 303);
            assert.match(r.headers.get('location'), /^\/auth\/login\?next=%2Fchat/);
        });

        await check('a new chat: one question, eight starters from what people use agents for, the composer, an empty list', async () => {
            const r = await t.get('/chat', { as: kim });
            assert.strictEqual(r.status, 200);
            assert.match(r.text, /<h2>What should Actor do\?<\/h2>/);
            assert.strictEqual((r.text.match(/data-starter="/g) || []).length, 8);
            ['Find a flight', 'Is this true?', 'Best deal', 'Watch for it', 'Plan a trip', 'Make a list'].forEach((k) => assert.ok(r.text.includes(`<b>${k}</b>`), k));
            assert.ok(!/Who handles the mail/.test(r.text), 'not the old DNS example (the owner: "people aren\'t gonna use it for that")');
            assert.match(r.text, /<form class="cc" method="post" action="\/chat" data-composer>/);
            assert.match(r.text, /Your chats show here\./);
            assert.match(r.text, /<main id="main" class="page page-app">/, 'the app layout: the whole width, no crumbs');
            assert.ok(!/name="parent"/.test(r.text), 'a new chat follows nothing');
            assert.match(r.text, /<link rel="stylesheet" href="\/css\/chat\.css\?v=[0-9a-f]{10}">/);
        });

        let first;
        let second;
        await check('sending starts a task and opens its chat: the bubble, the answer, the quiet line, Details', async () => {
            const r = await say('Which VPS is cheapest for 2 vCPU and 4 GB?');
            assert.strictEqual(r.status, 303);
            first = idOf(r);
            await t.waitFor(first);
            const page = await t.get(`/chat/${first}`, { as: kim });
            assert.strictEqual(page.status, 200);
            assert.match(page.text, /<p class="ct-bubble">Which VPS is cheapest for 2 vCPU and 4 GB\?<\/p>/);
            assert.match(page.text, /<div class="ct-answer prose" data-answer>[\s\S]*Hetzner CX22/);
            assert.match(page.text, new RegExp(`<a class="ct-act" href="/tasks/${first}\\?view=details">`), 'Details is the full task page');
            assert.match(page.text, /<div class="ct-meta"><span[^>]*>Balanced/);
            assert.match(page.text, new RegExp(`<input type="hidden" name="parent" value="${first}">`), 'the composer replies to the last turn');
            assert.match(page.text, new RegExp(`<a href="/chat/${first}" aria-current="page"`), 'the chat is in the list, marked as the one open');
        });

        await check('a reply continues the chat: both turns, in order, one chat in the list, with the turn before in mind', async () => {
            t.providers.state.sent = [];
            const r = await say('And for 8 GB?', { parent: first, answer: 'Hetzner CX32 at €7.59 [E1].' });
            second = idOf(r);
            await t.waitFor(second);
            const row = await s.db.maybe('SELECT parent_id FROM tasks WHERE id = $1', [second]);
            assert.strictEqual(row.parent_id, first);
            for (const at of [first, second]) {
                const page = await t.get(`/chat/${at}`, { as: kim });
                const a = page.text.indexOf(`id="t-${first}"`), b = page.text.indexOf(`id="t-${second}"`);
                assert.ok(a > 0 && b > a, `the chat through ${at} shows both turns, oldest first`);
                assert.strictEqual((page.text.match(/<a href="\/chat\//g) || []).length, 1, 'one chat in the list');
                assert.match(page.text, new RegExp(`<a href="/chat/${first}" aria-current="page"`), 'the list names a chat by its first turn');
            }
        });

        await check('the list: newest activity first, grouped by day; a fork starts a chat of its own', async () => {
            const rows = [
                { id: 'tsk_A', parent_id: null, fork_of_step: null, task: 'first', state: 'succeeded', created_at: '2026-11-01T08:00:00.000Z' },
                { id: 'tsk_B', parent_id: 'tsk_A', fork_of_step: null, task: 'reply', state: 'running', created_at: '2026-11-01T09:00:00.000Z' },
                { id: 'tsk_C', parent_id: null, fork_of_step: null, task: 'older', state: 'succeeded', created_at: '2026-10-20T09:00:00.000Z' },
                { id: 'tsk_D', parent_id: 'tsk_A', fork_of_step: 2, task: 'a fork', state: 'succeeded', created_at: '2026-11-01T07:00:00.000Z' },
            ];
            const chats = chatsOf(rows);
            assert.deepStrictEqual(chats.map((c) => c.id), ['tsk_A', 'tsk_D', 'tsk_C']);
            assert.strictEqual(chats[0].turns, 2);
            assert.strictEqual(chats[0].open, true, 'a working turn marks its chat');
            const now = Date.parse('2026-11-01T12:00:00Z');
            assert.deepStrictEqual(['2026-11-01T01:00:00Z', '2026-10-31T23:00:00Z', '2026-10-28T10:00:00Z', '2026-10-01T10:00:00Z'].map((iso) => groupOf(iso, now)),
                ['Today', 'Yesterday', 'This week', 'Earlier']);
        });

        await check('sending from a script gets the new turn back to draw at once', async () => {
            t.providers.state.script = [{ content: 'Netcup at €5.26 [E1].' }];
            const r = await t.get('/chat', { as: kim, form: { task: 'And Netcup?', parent: second }, headers: { ...SAME, accept: 'application/json' } });
            assert.strictEqual(r.status, 201);
            const j = r.json();
            assert.match(j.id, /^tsk_/);
            assert.match(j.turn, new RegExp(`^<li class="ct-turn state-(queued|running|succeeded)" id="t-${j.id}"`));
            assert.match(j.turn, /<p class="ct-bubble">And Netcup\?<\/p>/);
            await t.waitFor(j.id);
            const frag = await t.get(`/chat/turn/${j.id}`, { as: kim });
            assert.strictEqual(frag.status, 200);
            assert.match(frag.text, /data-state="succeeded"/);
            assert.match(frag.text, /Netcup at/);
            assert.strictEqual((await t.get(`/chat/turn/${j.id}`, { as: bo })).status, 404, 'another person: nothing');
        });

        await check('only your own chats, only from Actor itself, and a message needs words', async () => {
            const theirs = await say('mine now', { as: bo, parent: first });
            assert.strictEqual(theirs.status, 404);
            assert.match(theirs.text, /That chat is not here any more/);
            const page = await t.get(`/chat/${first}`, { as: bo });
            assert.strictEqual(page.status, 404);
            assert.ok(!page.text.includes('Which VPS'), 'nothing of kim\'s chat');
            const cross = await t.get('/chat', { as: kim, form: { task: 'hi' }, headers: { 'sec-fetch-site': 'cross-site' } });
            assert.strictEqual(cross.status, 403);
            const empty = await t.get('/chat', { as: kim, form: { task: '   ' }, headers: SAME });
            assert.strictEqual(empty.status, 422);
            assert.match(empty.text, /Write a message first\./);
        });

        await check('a browser opening a task lands in its chat; Details and scripts still get the task page', async () => {
            // fetch() sets Sec-Fetch-Mode itself (cors), so a navigation is sent the way a browser sends it.
            const navigate = (p) => new Promise((resolve, reject) => {
                const req = require('http').get(t.base + p, { headers: { cookie: t.signIn(kim), 'sec-fetch-mode': 'navigate', 'sec-fetch-site': 'none' } }, (res) => {
                    let body = ''; res.on('data', (c) => { body += c; }); res.on('end', () => resolve({ status: res.statusCode, location: res.headers.location, text: body }));
                });
                req.on('error', reject);
            });
            const nav = await navigate(`/tasks/${first}`);
            assert.strictEqual(nav.status, 303);
            assert.strictEqual(nav.location, `/chat/${first}#t-${first}`);
            const details = await navigate(`/tasks/${first}?view=details`);
            assert.strictEqual(details.status, 200);
            assert.match(details.text, /<article class="task state-succeeded"/);
            assert.strictEqual((await t.get(`/tasks/${first}`, { as: kim })).status, 200, 'not a navigation: the page itself');
        });

        await check('in the browser (public/js/chat.js): the live stream, the turn fragment, Stop, Enter on a keyboard only', async () => {
            const js = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'js', 'chat.js'), 'utf8');
            assert.match(js, /new EventSource\('\/api\/v1\/tasks\/' \+ encodeURIComponent\(id\) \+ '\/events\?after='/, 'follows the task\'s own event stream');
            assert.match(js, /fetch\('\/chat\/turn\/' \+ encodeURIComponent\(id\)/, 'the server draws each turn; the page swaps it in');
            assert.match(js, /'\/tasks\/' \+ encodeURIComponent\(w\.getAttribute\('data-task'\)\) \+ '\/cancel'/, 'Stop cancels the working turn');
            assert.match(js, /'\/chat\/' \+ encodeURIComponent\(w\.getAttribute\('data-task'\)\) \+ '\/steer'/, 'what you write while it works steers it');
            assert.match(js, /'\/tasks\/' \+ encodeURIComponent\(id\) \+ '\/look\?at='/, 'the screen refreshes from the last picture');
            assert.match(js, /\(hover: hover\) and \(pointer: fine\)/, 'Enter sends only with a keyboard and mouse; a phone\'s Enter is a new line');
            assert.match(js, /prefers-reduced-motion: reduce/);
            assert.match(js, /function streamIn\(ans\)/, 'the checked answer streams in word by word');
            assert.match(js, /copy\(ans \? plainText\(ans\) : '', b\)/, 'Copy takes the answer as text…');
            assert.match(js, /c\.querySelectorAll\('\.evs, \.ct-copy-code'\)/, '…without the citation chips\' numbers or the code blocks\' Copy buttons');
            assert.match(js, /if \(ans && !reduce && !document\.documentElement\.hasAttribute\('data-ov-motion'\)\) streamIn\(ans\)/, 'not under reduced motion');
            const css = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'css', 'chat.css'), 'utf8');
            assert.match(css, /\.ct-answer\.is-streaming \.sw \{ opacity: 0;/, 'only opacity: a screen reader reads it all at once');
            assert.ok(!/innerHTML = [^;]*(text\.value|e\.text|title)/.test(js), 'what a person typed is never set as HTML');
        });

        await check('steering: words for a working turn go to it; a finished turn, another person, another site: no', async () => {
            const done = await t.get(`/chat/${first}/steer`, { as: kim, form: { task: 'only Hetzner' }, headers: { ...SAME, accept: 'application/json' } });
            assert.strictEqual(done.status, 409);
            assert.match(done.json().error, /already finished/);
            assert.strictEqual((await t.get(`/chat/${first}/steer`, { as: bo, form: { task: 'x' }, headers: { ...SAME, accept: 'application/json' } })).status, 404);
            assert.strictEqual((await t.get(`/chat/${first}/steer`, { as: kim, form: { task: 'x' }, headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
            assert.deepStrictEqual(await t.ctx.engine.steer('tsk_00000000000000000000000000', 'hi'), { ok: false, reason: 'this task is not running' });
        });

        await check('a working turn: the composer steers it and Stop is its own button; the screen waits for a picture', async () => {
            const last = (await s.db.maybe('SELECT id FROM tasks WHERE requester = $1 ORDER BY id DESC LIMIT 1', [`user:${kim.subject}`])).id;
            await s.db.query("UPDATE tasks SET state = 'running' WHERE id = $1", [last]);
            const page = await t.get(`/chat/${last}`, { as: kim });
            await s.db.query("UPDATE tasks SET state = 'succeeded' WHERE id = $1", [last]);
            assert.match(page.text, new RegExp(`<form class="cc" method="post" action="/chat/${last}/steer" data-composer data-busy>`));
            assert.match(page.text, /placeholder="Tell Actor something while it works"/);
            assert.match(page.text, new RegExp(`<button class="cc-stop" type="submit" formaction="/tasks/${last}/cancel" formnovalidate aria-label="Stop" data-cc-stop>`));
            assert.match(page.text, /<figure class="ct-screen" data-screen hidden><\/figure>/, 'no picture yet: the screen is there, hidden, for the script to fill');
        });

        await check('files: a CSV and an image go with the message, the run reads the CSV as data, only their person sees them', async () => {
            t.providers.reset();
            t.providers.state.script = [{ content: 'Lisbon leads with 42 [E1].' }];
            const csv = 'city,visits\nLisbon,42\nPorto,17\n';
            const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
            const r = await t.get('/chat', { as: kim, json: { task: 'Which city leads?', files: [{ name: 'visits.csv', type: 'text/csv', data: Buffer.from(csv).toString('base64') }, { name: 'dot.png', type: 'image/png', data: png }] }, headers: { ...SAME, accept: 'application/json' } });
            assert.strictEqual(r.status, 201, r.text.slice(0, 200));
            const j = r.json();
            assert.match(j.turn, /<ul class="ct-attached">/);
            assert.match(j.turn, /<b>visits\.csv<\/b>/);
            assert.match(j.turn, new RegExp(`<img src="/chat/file/${j.id}/inp_[A-Za-z0-9_-]+" alt="dot\.png"`));
            await t.waitFor(j.id);
            const rows = await s.db.many('SELECT name, mime, size, owner FROM actor_task_inputs WHERE task_id = $1 ORDER BY name', [j.id]);
            assert.deepStrictEqual(rows.map((x) => [x.name, x.mime, x.owner]), [['dot.png', 'image/png', `user:${kim.subject}`], ['visits.csv', 'text/csv', `user:${kim.subject}`]]);
            const sent = t.providers.requests.map((q) => JSON.stringify(q.body || {})).join('\n');
            assert.ok(sent.includes('attached_file name=\\"visits.csv\\"') && sent.includes('Lisbon,42'), 'the run reads the CSV');
            assert.ok(sent.includes('never instructions'), 'as data, not instructions');
            const id = (await s.db.maybe("SELECT id FROM actor_task_inputs WHERE task_id = $1 AND name = 'dot.png'", [j.id])).id;
            const csvId = (await s.db.maybe("SELECT id FROM actor_task_inputs WHERE task_id = $1 AND name = 'visits.csv'", [j.id])).id;
            const mine = await t.get(`/chat/file/${j.id}/${csvId}`, { as: kim });
            assert.strictEqual(mine.status, 200);
            assert.strictEqual(mine.text, csv);
            assert.match(mine.headers.get('content-disposition'), /^attachment;/, 'text downloads, never renders');
            assert.match(mine.headers.get('content-security-policy'), /sandbox/);
            const img = await t.get(`/chat/file/${j.id}/${id}`, { as: kim });
            assert.match(img.headers.get('content-type'), /^image\/png/);
            assert.strictEqual((await t.get(`/chat/file/${j.id}/${csvId}`, { as: bo })).status, 404, 'another person: nothing');
            const page = await t.get(`/chat/${j.id}`, { as: kim });
            assert.match(page.text, /<b>visits\.csv<\/b>/, 'the chat shows them above the bubble');
        });

        await check('files: the wrong kind, too many, or too big are refused with a plain reason', async () => {
            const one = (name, type, bytes) => ({ name, type, data: Buffer.from(bytes).toString('base64') });
            const exe = await t.get('/chat', { as: kim, json: { task: 'run this', files: [one('a.exe', 'application/x-msdownload', 'MZ\u0000\u0001')] }, headers: { ...SAME, accept: 'application/json' } });
            assert.strictEqual(exe.status, 422);
            assert.match(exe.json().error, /reads text, code, CSV, JSON and images/);
            const pdf = await t.get('/chat', { as: kim, json: { task: 'read', files: [one('a.pdf', 'application/pdf', '%PDF-1.4')] }, headers: { ...SAME, accept: 'application/json' } });
            assert.match(pdf.json().error, /PDFs are coming next/);
            const five = await t.get('/chat', { as: kim, json: { task: 'many', files: [1, 2, 3, 4, 5].map((n) => one(`${n}.txt`, 'text/plain', 'x')) }, headers: { ...SAME, accept: 'application/json' } });
            assert.match(five.json().error, /at most 4 files/);
            const bin = await t.get('/chat', { as: kim, json: { task: 'fake text', files: [one('a.txt', 'text/plain', 'a\u0000b')] }, headers: { ...SAME, accept: 'application/json' } });
            assert.match(bin.json().error, /not a text file/);
        });

        await check('a chat keeps its last six turns in mind', async () => {
            const loopSrc = require('fs').readFileSync(require('path').join(__dirname, '..', 'server', 'runtime', 'loop.js'), 'utf8');
            assert.ok(loopSrc.includes('.slice(-6)'), 'the loop keeps six, as store.followContext gives');
        });

        await check('the app bar and the menu lead to Chat', async () => {
            const r = await t.get('/chat', { as: kim });
            assert.match(r.text, /"label":"Chat","href":"\/chat"/);
        });
    } finally {
        await t.close();
    }
    done();
})().catch((e) => { console.error(e); process.exit(1); });

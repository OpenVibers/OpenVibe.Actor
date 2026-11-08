'use strict';
/**
 * An agent's live panel (plan HO9, actor.canvas@1, ADR-059): the tool validates the released document and only ever
 * grows its version; a picture from outside openvibe.media and a markup block are refused with the schema's plain
 * reason; a button asks as the person's own message (nothing else happens) and a checklist tick flips the item and is
 * told to the next turn; another person's canvas is 404; the conversation page carries the panel (wide and phone).
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const { createRegistry } = require('../server/runtime/tools');
const canvases = require('../server/canvases');
const contracts = require('openvibe-contracts');

const SAME = { 'sec-fetch-site': 'same-origin' };
const JSON_ACCEPT = { ...SAME, accept: 'application/json' };

const CHECKLIST = [{ type: 'heading', text: 'Lisbon, 12–14 March' },
    { type: 'text', text: 'Three days, two people, one quiet hotel.' },
    { type: 'checklist', id: 'packing', items: [{ id: 'bags', text: 'Pack the bags', done: false }, { id: 'passport', text: 'Passport in the bag', done: false }] },
    { type: 'metric', label: 'Budget', value: '€480', note: 'Hotel and trains' }];

(async () => {
    // What each run was handed (the loop is the only model Actor talks to in this file). The plan and understand
    // calls still use the stand-in providers.
    const seen = [];
    const loop = {
        close: async () => {},
        run: async (args) => {
            seen.push(args);
            return { text: 'Done.', sources: [], evidence: [], model: 'fake' };
        },
    };
    const t = await boot({ loop });
    try {
        const alice = t.network.addUser('canvas-alice');
        const bob = t.network.addUser('canvas-bob');
        const owner = `user:${alice.subject}`;
        const s = t.ctx.s;
        const agentId = s.newId('agt');
        const registry = createRegistry({ strict: true, log: { warn() {}, log() {} } });
        const toolCtx = (taskId, extra = {}) => ({ store: s, requester: owner, taskId, agentId, canvasWrites: 0, ...extra });
        const setCanvas = (taskId, input, extra) => registry.run('canvas_set', input, toolCtx(taskId, extra));

        const makeTurn = async (user, text, parent = null) => {
            const res = parent
                ? await t.get('/chat', { as: user, form: { task: text, parent, mode: 'balanced' }, headers: SAME })
                : await t.get('/api/v1/tasks', { as: user, json: { task: text }, headers: SAME });
            if (parent) {
                assert.strictEqual(res.status, 303, res.text);
                const id = /\/chat\/(tsk_[0-9A-HJKMNP-TV-Z]{26})/.exec(String(res.headers.get('location') || ''))[1];
                return await t.waitFor(id);
            }
            assert.strictEqual(res.status, 201, res.text);
            const body = res.json();
            const id = (body.task && body.task.id) || body.id;
            return await t.waitFor(id);
        };

        const root = await makeTurn(alice, 'Plan three days in Lisbon for two');
        let doc = null;
        let canvasId = null;

        await check('canvas_set validates the released document and only ever grows its version', async () => {
            const first = await setCanvas(root.id, { title: 'Lisbon, 12–14 March', blocks: CHECKLIST });
            assert.strictEqual(first.isError, false, first.text);
            doc = first.data.canvas;
            canvasId = doc.id;
            assert.match(canvasId, /^cnv_/);
            assert.strictEqual(doc.canvas, 'actor.canvas@1');
            assert.strictEqual(doc.version, 1);
            assert.strictEqual(doc.thread, root.id, 'the canvas sits beside the conversation, not one follow-up');
            assert.strictEqual(doc.agent_id, agentId);
            assert.ok(contracts.validate('actor.canvas@1', doc).valid, JSON.stringify(contracts.validate('actor.canvas@1', doc).errors));
            assert.strictEqual(await canvases.countOf(doc), 4);

            const again = await setCanvas(root.id, { title: 'Lisbon, packed', blocks: CHECKLIST.slice(0, 3) });
            assert.strictEqual(again.isError, false, again.text);
            assert.strictEqual(again.data.canvas.id, canvasId, 'the same canvas, not a second one');
            assert.strictEqual(again.data.canvas.version, 2);
            assert.strictEqual(again.data.canvas.title, 'Lisbon, packed');
            assert.strictEqual(await s.db.value('SELECT count(*)::int FROM actor_canvases WHERE thread = $1', [root.id]), 1);

            const spent = await setCanvas(root.id, { title: 'One too many', blocks: CHECKLIST }, { canvasWrites: 20 });
            assert.strictEqual(spent.isError, true);
            assert.match(spent.text, /at most 20 canvas_set calls/);
        });

        await check('a picture outside openvibe.media and a markup block are refused, and nothing is written', async () => {
            const before = await s.db.maybe('SELECT version FROM actor_canvases WHERE id = $1', [canvasId]);
            const foreign = await setCanvas(root.id, { title: 'Bad picture', blocks: [{ type: 'image', src: 'https://tracker.example/x.png', alt: 'x' }] });
            assert.strictEqual(foreign.isError, true);
            assert.match(foreign.text, /openvibe\.media/);
            const markup = await setCanvas(root.id, { title: 'Markup', blocks: [{ type: 'html', text: '<b>wide</b>' }] });
            assert.strictEqual(markup.isError, true);
            assert.match(markup.text, /not a canvas block/);
            const missing = await setCanvas(root.id, { title: 'Missing alt', blocks: [{ type: 'image', src: 'https://openvibe.media/photo.png' }] });
            assert.strictEqual(missing.isError, true);
            assert.match(missing.text, /alt/);
            const after = await s.db.maybe('SELECT version FROM actor_canvases WHERE id = $1', [canvasId]);
            assert.strictEqual(Number(after.version), Number(before.version), 'a refused document leaves the version alone');
        });

        await check('a canvas is the owner\'s: another person gets the same 404 as one that does not exist', async () => {
            const res = await t.get(`/api/v1/me/canvases/${canvasId}`, { as: bob, headers: JSON_ACCEPT });
            assert.strictEqual(res.status, 404, res.text);
            assert.strictEqual((await t.get(`/api/v1/me/canvases?thread=${root.id}`, { as: bob })).json().canvases.length, 0);
            assert.strictEqual((await t.get(`/api/v1/me/canvases/${canvasId}/events`, { as: bob, json: { kind: 'check', block_id: 'packing', item_id: 'bags', done: true }, headers: SAME })).status, 404);
            assert.strictEqual((await t.get(`/chat/${root.id}`, { as: bob })).status, 404);
            assert.strictEqual((await t.get(`/api/v1/me/canvases/${canvasId}`, { as: alice })).status, 200);
        });

        await check('ask posts the label as the person\'s own message and starts exactly one turn; nothing else happens', async () => {
            const beforeTasks = Number(await s.db.value('SELECT count(*)::int FROM tasks'));
            const beforeCanvas = Number(await s.db.value('SELECT version FROM actor_canvases WHERE id = $1', [canvasId]));
            const latest = await s.db.maybe('SELECT id FROM tasks WHERE requester = $1 ORDER BY id DESC LIMIT 1', [owner]);
            const res = await t.get(`/api/v1/me/canvases/${canvasId}/events`, {
                as: alice, json: { kind: 'ask', label: 'Book the quiet hotel' }, headers: JSON_ACCEPT,
            });
            assert.strictEqual(res.status, 201, res.text);
            const made = res.json();
            assert.match(made.task.id, /^tsk_/);
            const row = await t.waitFor(made.task.id);
            assert.strictEqual(row.task, 'Book the quiet hotel', 'the words are the message, with no prefix');
            assert.strictEqual(row.requester, owner);
            assert.strictEqual(row.parent_id, latest.id, 'a normal follow-up of the conversation');
            assert.strictEqual(Number(await s.db.value('SELECT count(*)::int FROM tasks')), beforeTasks + 1, 'one turn, no other action');
            assert.strictEqual(Number(await s.db.value('SELECT version FROM actor_canvases WHERE id = $1', [canvasId])), beforeCanvas, 'asking does not change the canvas');
            // The text typed by the person is also a plain same-origin form: no JSON needed.
            const form = await t.get(`/api/v1/me/canvases/${canvasId}/events`, { as: alice, form: { kind: 'ask', label: 'Send it to the hotel' }, headers: SAME });
            assert.strictEqual(form.status, 303, form.text);
            assert.match(String(form.headers.get('location') || ''), /\/chat\/tsk_/);
            const typed = await t.waitFor(/\/chat\/(tsk_[0-9A-HJKMNP-TV-Z]{26})/.exec(String(form.headers.get('location') || ''))[1]);
            assert.strictEqual(typed.task, 'Send it to the hotel');
        });

        await check('check flips the item, grows the version, and the next turn is told which item was ticked', async () => {
            const before = await s.db.maybe('SELECT version FROM actor_canvases WHERE id = $1', [canvasId]);
            const res = await t.get(`/api/v1/me/canvases/${canvasId}/events`, {
                as: alice, json: { kind: 'check', block_id: 'packing', item_id: 'bags', done: true }, headers: JSON_ACCEPT,
            });
            assert.strictEqual(res.status, 200, res.text);
            const checked = res.json().canvas;
            assert.strictEqual(checked.version, Number(before.version) + 1);
            const item = checked.blocks.find((b) => b.type === 'checklist').items.find((i) => i.id === 'bags');
            assert.strictEqual(item.done, true);
            const stored = canvases.docOf(await s.db.maybe('SELECT * FROM actor_canvases WHERE id = $1', [canvasId]));
            assert.strictEqual(stored.version, checked.version, 'the version is the stored one');
            const notice = (await s.db.maybe('SELECT notices FROM actor_canvases WHERE id = $1', [canvasId])).notices;
            assert.strictEqual((typeof notice === 'string' ? JSON.parse(notice) : notice).length, 1);
            // A tick starts no turn by itself; the next one is told as context.
            const latest = await s.db.maybe('SELECT id FROM tasks WHERE requester = $1 ORDER BY id DESC LIMIT 1', [owner]);
            const next = await makeTurn(alice, 'Now pack for the trip', latest.id);
            const handed = seen[seen.length - 1];
            assert.ok(Array.isArray(handed.context), 'the run gets a context');
            assert.ok(handed.context.some((c) => /Pack the bags/.test(c.answer) && /Canvas "Lisbon, packed"/.test(c.task)), JSON.stringify(handed.context));
            assert.strictEqual(next.task, 'Now pack for the trip');
            const left = (await s.db.maybe('SELECT notices FROM actor_canvases WHERE id = $1', [canvasId])).notices;
            assert.deepStrictEqual(typeof left === 'string' ? JSON.parse(left) : left, [], 'told once, then cleared');
        });

        await check('the conversation page carries the canvas: a third column wide, a closed fold above the composer', async () => {
            const page = await t.get(`/chat/${root.id}`, { as: alice });
            assert.strictEqual(page.status, 200, page.text.slice(0, 300));
            assert.match(page.text, /data-cc-canvas/);
            assert.match(page.text, /cc-canvas-wide/);
            assert.match(page.text, /cc-canvas-phone/);
            assert.match(page.text, /<details class="cc-canvas cc-canvas-phone" data-cc-canvas/);
            assert.ok(!/cc-canvas-phone" open/.test(page.text), 'the phone fold starts closed');
            assert.match(page.text, /data-cc-canvas-updated[^>]*hidden/);
            assert.match(page.text, /Canvas[\s\S]{0,120}items/);
            assert.match(page.text, /shared\/ov-canvas\.js/);
            assert.match(page.text, /Lisbon, packed/);
            assert.match(page.text, /Passport in the bag/);
            // The wide copy is a real panel beside the conversation (thread.css's third column); the phone fold's
            // body scrolls inside at most 45vh and its containment keeps that scroll out of the page's height.
            assert.match(page.text, /class="ovt-panel cc-canvas cc-canvas-wide"/);
            const css = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'css', 'chat.css'), 'utf8');
            assert.match(css, /min\(45vh, 420px\)/);
            assert.match(css, /contain: layout paint/);
        });

        await check('only openvibe.chat reads a canvas cross-origin, only with the person\'s Bearer', async () => {
            const CHAT = 'https://openvibe.chat';
            const read = { origin: CHAT, accept: 'application/json' };
            const bearer = t.network.userToken(alice);
            const one = await t.get(`/api/v1/me/canvases?thread=${root.id}`, { bearer, headers: read });
            assert.strictEqual(one.status, 200, one.text);
            assert.strictEqual(one.headers.get('access-control-allow-origin'), CHAT);
            assert.match(String(one.headers.get('vary') || ''), /Origin/i);
            assert.strictEqual(one.headers.get('access-control-allow-credentials'), null, 'no credentials mode');
            assert.strictEqual(one.json().canvases[0].id, canvasId);

            const byId = await t.get(`/api/v1/me/canvases/${canvasId}`, { bearer, headers: read });
            assert.strictEqual(byId.status, 200, byId.text);
            assert.strictEqual(byId.headers.get('access-control-allow-origin'), CHAT);
            assert.strictEqual(byId.json().id, canvasId);
        });

        await check('another origin gets no CORS headers, a cookie without Bearer is refused, and a canvas POST is refused', async () => {
            const CHAT = 'https://openvibe.chat';
            const bearer = t.network.userToken(alice);
            const other = await t.get(`/api/v1/me/canvases?thread=${root.id}`, { bearer, headers: { origin: 'https://example.net' } });
            assert.strictEqual(other.status, 403, other.text);
            assert.strictEqual(other.headers.get('access-control-allow-origin'), null);

            const cookieOnly = await t.get(`/api/v1/me/canvases?thread=${root.id}`, { as: alice, headers: { origin: CHAT } });
            assert.strictEqual(cookieOnly.status, 401, cookieOnly.text);
            assert.strictEqual(cookieOnly.headers.get('access-control-allow-credentials'), null);

            const before = await s.db.maybe('SELECT version FROM actor_canvases WHERE id = $1', [canvasId]);
            const post = await t.get(`/api/v1/me/canvases/${canvasId}/events`, {
                bearer, json: { kind: 'check', block_id: 'packing', item_id: 'bags', done: true }, headers: { origin: CHAT },
            });
            assert.strictEqual(post.status, 403, post.text);
            assert.strictEqual(post.headers.get('access-control-allow-origin'), null, 'a write is never a CORS route');
            assert.strictEqual(Number((await s.db.maybe('SELECT version FROM actor_canvases WHERE id = $1', [canvasId])).version), Number(before.version), 'the refused POST changed nothing');
        });

        await check('the canvas preflight allows a GET with Authorization from openvibe.chat only', async () => {
            const CHAT = 'https://openvibe.chat';
            const pre = await t.get(`/api/v1/me/canvases?thread=${root.id}`, {
                method: 'OPTIONS',
                headers: { origin: CHAT, 'access-control-request-method': 'GET', 'access-control-request-headers': 'authorization' },
            });
            assert.strictEqual(pre.status, 204, pre.text);
            assert.strictEqual(pre.headers.get('access-control-allow-origin'), CHAT);
            assert.match(String(pre.headers.get('access-control-allow-methods') || ''), /GET/);
            assert.match(String(pre.headers.get('access-control-allow-headers') || ''), /authorization/i);
            assert.strictEqual(pre.headers.get('access-control-allow-credentials'), null);
            const evil = await t.get(`/api/v1/me/canvases?thread=${root.id}`, {
                method: 'OPTIONS', headers: { origin: 'https://example.net', 'access-control-request-method': 'GET' },
            });
            assert.strictEqual(evil.status, 403);
            assert.strictEqual(evil.headers.get('access-control-allow-origin'), null);
        });

        await check('account data names the canvas table (export and deletion cover it)', async () => {
            const { TABLES } = require('../server/identity/account-data');
            const entry = TABLES.find((x) => x.table === 'actor_canvases');
            assert.ok(entry, 'actor_canvases is in the account-data map');
            assert.strictEqual(entry.subject, 'owner');
            assert.strictEqual(entry.value('usr_TEST'), 'user:usr_TEST');
            assert.ok(entry.columns.includes('document') && entry.columns.includes('version'));
        });
    } finally { await t.close(); }
    done();
})().catch((e) => { console.error(e); process.exit(1); });

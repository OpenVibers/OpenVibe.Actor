'use strict';
// See it work (W1): a running task's desk tile, the private Live stream's view ticket, the still fallback, the person's
// take-over and hand-back (Run lease / Link input as the person), the Ask that opens the viewer in control, and a
// finished run's replay with the still each step saw. Typed text is never in a replay.
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const store = require('../server/tasks/store');
const stills = require('../server/tasks/stills');

const SAME = { 'sec-fetch-site': 'same-origin' };
const MACHINE = 'dev_01JZ0000000000000000000000';
const SESSION = 'ses_01JZ0000000000000000000000';
const STREAM = 'ags_01JZ0000000000000000000000';
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

(async () => {
    const calls = [];
    const computers = {
        async still(subject, id) { calls.push(['still', subject, id]); return { bytes: Buffer.from(PNG, 'base64'), type: 'image/png' }; },
        async screen(subject, machine, opts) { calls.push(['screen', subject, machine, opts]); return { format: 'png', width: 640, height: 400, content_b64: PNG }; },
        async personSession(subject, id, action, body) { calls.push(['session', subject, id, action, body]); return { lease: { holder: action === 'take' ? 'person' : 'ai' }, done: true }; },
        async personInput(subject, token, machine, args) { calls.push(['input', subject, token, machine, args]); return { done: true, action: args.action }; },
        async deskStream() { return { error: 'not used in this test' }; },
    };
    const live = {
        enabled: true,
        async viewTicket(token, id) { calls.push(['ticket', token, id]); return { view_ticket: 'wvt_private', expires_at: new Date(Date.now() + 600e3).toISOString(), page_url: `https://openvibe.live/embed/agent/${id}?vt=wvt_private` }; },
    };
    const t = await boot({ bot: { computers }, live });
    const kim = t.network.addUser('kim');
    const bo = t.network.addUser('bo');
    const s = t.ctx.s;
    const owner = `user:${kim.subject}`;
    const token = t.network.userToken(kim);
    const event = (id, body) => store.appendEvent(s, id, { kind: 'output', at: s.iso(), ...body });
    const make = async (state = 'running') => {
        const id = s.newId('tsk');
        await store.insertTask(s, { id, requester: owner, task: 'Book the cheapest train to Porto', mode: 'balanced', budget_task: 0.05, budget_day: 0.5, created_at: s.iso() });
        if (state !== 'queued') await store.updateTask(s, id, { state });
        return id;
    };
    try {
        const id = await make();
        await event(id, { step: 'tool_result', tool: 'computer_desk', text: JSON.stringify({ watch: `https://openvibe.link/machines/${MACHINE}/screen?desk=desk-trains`, running: true, kind: 'browser', stream: { id: STREAM, page_url: `https://openvibe.live/embed/agent/${STREAM}`, visibility: 'private', expires_at: new Date(Date.now() + 4 * 3600e3).toISOString() } }) });
        await event(id, { step: 'tool_call', tool: 'computer_input', call_id: 'c1', args: { action: 'click', x: 320, y: 200, width: 1280, height: 800 }, input: 'click' });
        await event(id, { step: 'tool_result', tool: 'computer_input', call_id: 'c1', text: '{"done":true}' });
        await event(id, { step: 'tool_call', tool: 'computer_browser', call_id: 'c2', args: { action: 'open', url: 'https://example.com/trains' }, input: 'open' });
        await event(id, { step: 'tool_result', tool: 'computer_browser', call_id: 'c2', text: '{"url":"https://example.com/trains","title":"Trains"}' });

        await check('the running card has the desk tile: label, caption, ring, page address and the watch button', async () => {
            const page = await t.get(`/chat/${id}`, { as: kim });
            assert.strictEqual(page.status, 200);
            assert.match(page.text, new RegExp(`<figure class="ct-desk-tile" data-ct-desk data-task="${id}" data-desk="link:${MACHINE}:desk-trains" data-where="link" data-kind="browser"`));
            assert.match(page.text, /Opening a page/);
            assert.match(page.text, /style="left:25\.00%;top:25\.00%"/, 'the ring is where it clicked');
            assert.match(page.text, /example\.com\/trains/, 'the browser address');
            assert.match(page.text, /Your PC · its own desk/);
            assert.match(page.text, /data-ct-desk-open/);
            assert.match(page.text, new RegExp(`src="/api/v1/tasks/${id}/desk-still\\?desk=desk-trains"`), 'the still fallback');
        });

        await check('the desks call names the private Live stream with a view ticket; the still is Bot\'s picture at 640', async () => {
            const r = await t.get(`/api/v1/tasks/${id}/desks`, { as: kim, bearer: token, headers: SAME });
            assert.strictEqual(r.status, 200, r.text);
            const d = r.json().desks[0];
            assert.strictEqual(d.id, `link:${MACHINE}:desk-trains`);
            assert.strictEqual(d.label, 'Your PC · its own desk');
            assert.strictEqual(d.live.stream_id, STREAM);
            assert.match(d.live.embed_url, new RegExp(`/embed/agent/${STREAM}\\?vt=wvt_private`));
            assert.ok(calls.some((c) => c[0] === 'ticket' && c[1] === token && c[2] === STREAM), 'Live got the person\'s own token');
            const still = await t.get(`/api/v1/tasks/${id}/desk-still?desk=desk-trains`, { as: kim });
            assert.strictEqual(still.status, 200);
            assert.match(still.headers.get('content-type'), /^image\/png/);
            assert.deepStrictEqual(still.buffer, Buffer.from(PNG, 'base64'));
            assert.strictEqual((await t.get(`/api/v1/tasks/${id}/desks`, { as: bo })).status, 404, 'another person: not there');
        });

        await check('take over, person input, hand back with a note (Link: the person\'s own token to Bot)', async () => {
            const take = await t.get(`/api/v1/tasks/${id}/desks/${encodeURIComponent(`link:${MACHINE}:desk-trains`)}/take-over`, { as: kim, method: 'POST', headers: SAME });
            assert.strictEqual(take.status, 200, take.text);
            assert.ok(take.json().desk, 'the desk is in the answer');
            assert.strictEqual((await t.get(`/api/v1/tasks/${id}/desks`, { as: kim, bearer: token })).json().desks[0].driving, true);
            const input = await t.get(`/api/v1/tasks/${id}/desks/${encodeURIComponent(`link:${MACHINE}:desk-trains`)}/input`, { as: kim, bearer: token, json: { action: 'click', x: 100, y: 120, width: 640, height: 400 }, headers: SAME });
            assert.strictEqual(input.status, 200, input.text);
            const got = calls.find((c) => c[0] === 'input');
            assert.deepStrictEqual([got[1], got[2], got[3], got[4].action, got[4].x, got[4].y, got[4].width, got[4].height], [kim.subject, token, MACHINE, 'click', 100, 120, 640, 400]);
            let steered = null;
            const before = t.ctx.engine.steer;
            t.ctx.engine.steer = async (taskId, note) => { steered = [taskId, note]; return { ok: true }; };
            try {
                const back = await t.get(`/api/v1/tasks/${id}/desks/${encodeURIComponent(`link:${MACHINE}:desk-trains`)}/hand-back`, { as: kim, json: { note: 'signed in, carry on' }, headers: SAME });
                assert.strictEqual(back.status, 200, back.text);
                assert.strictEqual((await t.get(`/api/v1/tasks/${id}/desks`, { as: kim, bearer: token })).json().desks[0].driving, false);
                assert.deepStrictEqual(steered, [id, 'signed in, carry on'], 'the note goes to the task as the person\'s message');
            } finally { t.ctx.engine.steer = before; }
            const again = await t.get(`/api/v1/tasks/${id}/desks/${encodeURIComponent(`link:${MACHINE}:desk-trains`)}/input`, { as: kim, bearer: token, json: { action: 'click', x: 1, y: 1 }, headers: SAME });
            assert.strictEqual(again.status, 409, 'not driving: no input');
        });

        await check('a step that meets a sign-in becomes an Ask whose button opens the viewer in control', async () => {
            const other = await make();
            await event(other, { step: 'tool_result', tool: 'computer_desk', text: JSON.stringify({ watch: `https://openvibe.link/machines/${MACHINE}/screen?desk=desk-signin`, running: true, stream: { id: STREAM, visibility: 'private' } }) });
            await event(other, { step: 'tool_call', tool: 'hand_to_person', call_id: 'h1', args: { machine: MACHINE, what: 'Sign in to your train account.' } });
            const page = await t.get(`/chat/${other}`, { as: kim });
            assert.match(page.text, /data-ct-desk-ask/);
            assert.match(page.text, /Actor needs you:/);
            assert.match(page.text, /Sign in to your train account\./);
            assert.match(page.text, /data-ct-takeover>Take over</);
        });

        await check('a Run desk uses its session still and the Run lease; take over, input and hand back go through the session', async () => {
            const runId = await make();
            await event(runId, { step: 'tool_result', tool: 'computer_desk', text: JSON.stringify({ machine: `run:${SESSION}`, running: true, kind: 'browser', where: 'an OpenVibe computer', computer: { session_id: SESSION, machine: 'an OpenVibe desk host', where: 'network' } }), computer: { session_id: SESSION, machine: 'an OpenVibe desk host', where: 'network' } });
            const listed = (await t.get(`/api/v1/tasks/${runId}/desks`, { as: kim, bearer: token })).json();
            assert.strictEqual(listed.desks[0].id, `run:${SESSION}`);
            assert.strictEqual(listed.desks[0].live, null);
            assert.match(listed.desks[0].still, new RegExp(`/api/v1/tasks/${runId}/still$`));
            calls.length = 0;
            const take = await t.get(`/api/v1/tasks/${runId}/desks/${encodeURIComponent(`run:${SESSION}`)}/take-over`, { as: kim, method: 'POST', headers: SAME });
            assert.strictEqual(take.status, 200, take.text);
            assert.deepStrictEqual(calls.find((c) => c[0] === 'session').slice(0, 4), ['session', kim.subject, SESSION, 'take']);
            const input = await t.get(`/api/v1/tasks/${runId}/desks/${encodeURIComponent(`run:${SESSION}`)}/input`, { as: kim, bearer: token, json: { action: 'key', keys: 'Return' }, headers: SAME });
            assert.strictEqual(input.status, 200, input.text);
            const sent = calls.filter((c) => c[0] === 'session').at(-1);
            assert.deepStrictEqual(sent[4], { kind: 'input', value: { action: 'key', keys: 'Return' } });
            const back = await t.get(`/api/v1/tasks/${runId}/desks/${encodeURIComponent(`run:${SESSION}`)}/hand-back`, { as: kim, json: {}, headers: SAME });
            assert.strictEqual(back.status, 200, back.text);
            assert.deepStrictEqual(calls.filter((c) => c[0] === 'session').at(-1).slice(0, 4), ['session', kim.subject, SESSION, 'back']);
        });

        await check('a finished run has a replay: each step keeps its still, and typed text is never returned', async () => {
            const doneId = await make('succeeded');
            await store.updateTask(s, doneId, { finished_at: s.iso(), result: { answer: 'Booked.' } });
            const typeCall = await event(doneId, { step: 'tool_call', tool: 'computer_input', call_id: 't1', args: { action: 'type', text: 'hunter2', desk: 'private' }, input: 'type' });
            await stills.save(s, doneId, typeCall.seq + 1, { format: 'png', data: Buffer.from(PNG, 'base64'), width: 1280, height: 800, tool: 'computer_input' });
            await event(doneId, { step: 'tool_result', tool: 'computer_input', call_id: 't1', text: '{"done":true}' });
            const clickCall = await event(doneId, { step: 'tool_call', tool: 'computer_input', call_id: 't2', args: { action: 'click', x: 64, y: 32, width: 640, height: 400 }, input: 'click' });
            await stills.save(s, doneId, clickCall.seq + 1, { format: 'png', data: Buffer.from(PNG, 'base64'), width: 640, height: 400, tool: 'computer_input' });
            await event(doneId, { step: 'tool_result', tool: 'computer_input', call_id: 't2', text: '{"done":true}' });
            const r = await t.get(`/api/v1/tasks/${doneId}/replay`, { as: kim });
            assert.strictEqual(r.status, 200, r.text);
            const steps = r.json().steps;
            assert.strictEqual(steps.length, 2);
            assert.strictEqual(steps[0].secret, true, 'typed text is marked secret');
            assert.strictEqual(steps[0].action, 'secret');
            assert.ok(!JSON.stringify(steps).includes('hunter2'), 'the typed text is never returned');
            assert.strictEqual(steps[1].action, 'click');
            assert.deepStrictEqual([steps[1].x, steps[1].y, steps[1].width, steps[1].height], [64, 32, 640, 400]);
            assert.ok(steps[0].still && steps[1].still, 'both steps keep a picture');
            const shot = await t.get(new URL(steps[0].still.url).pathname, { as: kim });
            assert.strictEqual(shot.status, 200);
            assert.match(shot.headers.get('content-type'), /^image\/webp/);
            assert.strictEqual((await t.get(new URL(steps[0].still.url).pathname, { as: bo })).status, 404, 'another person: no picture');
            const page = await t.get(`/chat/${doneId}`, { as: kim });
            assert.match(page.text, /data-ct-replay/);
            assert.match(page.text, /Replay · 2 steps/);
            assert.match(page.text, /Clicked at 64, 32/);
            assert.ok(!page.text.includes('hunter2'), 'the page does not carry the typed text either');
        });
        await check('the Live client only mints a person\'s view ticket for an ags_ stream', async () => {
            const { createLive } = require('../server/agents/live');
            const asked = [];
            const live = createLive({ config: { services: { liveUrl: 'https://live.test', livePublicUrl: 'https://openvibe.live' } }, fetchImpl: async (url, init) => {
                asked.push([url, init.headers.Authorization]);
                return new Response(JSON.stringify({ view_ticket: 'wvt_x', expires_at: '2030-01-01T00:00:00Z' }), { status: 200, headers: { 'content-type': 'application/json' } });
            } });
            const view = await live.viewTicket('person-token', STREAM);
            assert.match(view.page_url, new RegExp(`https://openvibe\\.live/embed/agent/${STREAM}\\?vt=wvt_x`));
            assert.deepStrictEqual(asked, [[`https://live.test/api/streams/agent/${STREAM}/view-ticket`, 'Bearer person-token']]);
            assert.match((await live.viewTicket('person-token', 'not-a-stream')).error, /not an agent stream/);
            assert.strictEqual(asked.length, 1, 'a malformed id never reaches Live');
            assert.match((await live.viewTicket(null, STREAM)).error, /own session/);
            const replayLib = require('../server/tasks/replay');
            assert.strictEqual(typeof replayLib.steps, 'function');
            assert.strictEqual(replayLib.caption({ tool: 'computer_screen' }), 'Looked at the screen');
            assert.strictEqual(require('../server/runtime/tools/computer_desk').name, 'computer_desk');
            assert.ok(require('fs').existsSync(require('path').join(__dirname, '..', 'public', 'js', 'desks.js')));
        });

        await check('the page uses the SDK names, pauses a stream off screen, and polls a still at 1/s', async () => {
            const js = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'js', 'desks.js'), 'utf8');
            assert.match(js, /desks\(run\)/);
            assert.match(js, /takeOver\(run, desk\)/);
            assert.match(js, /handBack\(run, desk, note\)/);
            assert.match(js, /replay\(run\)/);
            assert.match(js, /IntersectionObserver/);
            assert.match(js, /stopStream\(st\)/);
            assert.match(js, /setInterval\(function \(\) \{ show\(img, tile\.getAttribute\('data-still'\)\); \}, 1000\)/);
            assert.match(js, /data-ct-replay-step/);
            const loop = require('fs').readFileSync(require('path').join(__dirname, '..', 'server', 'runtime', 'loop.js'), 'utf8');
            assert.match(loop, /computer_input.*type.*\[redacted: typed on the desk\]/, 'typed desk text never reaches an event');
            const css = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'css', 'chat.css'), 'utf8');
            assert.match(css, /\.ct-desk-frame \{[^}]*aspect-ratio: 16 \/ 9/);
            assert.match(css, /@media \(min-width: 900px\)[\s\S]*\.ct-viewer-side \{/);
            assert.match(css, /\.ct-viewer-bar button[^}]*min-height: 44px/);
        });

        await check('the desk stream starts with the desk and stops with the task (Link desk.stream)', async () => {
            const { startDeskStream, closeDesks } = require('../server/runtime/tools/_person');
            const core = { pcs: {
                isSession: () => false,
                async deskStream(subject, machine, args) { calls.push(['stream', subject, machine, args]); return args.action === 'start' ? { id: STREAM, page_url: 'https://openvibe.live/embed/agent/' + STREAM } : { stopped: true }; },
                async desk(subject, machine, args) { calls.push(['desk', subject, machine, args]); return { running: false }; },
            } };
            const run = { streams: new Map(), used: new Set([MACHINE]), placed: null, name: 'desk-stream-test' };
            await startDeskStream(run, kim.subject, core, { taskId: id, personText: 'Book the cheapest train to Porto', config: { baseUrl: 'https://openvibe.actor' } }, MACHINE, 'desk-trains', { running: true });
            const start = calls.find((c) => c[0] === 'stream' && c[3].action === 'start');
            assert.ok(start, 'the stream started');
            assert.deepStrictEqual([start[3].desk, start[3].visibility, start[3].task.ref], ['desk-trains', 'private', id]);
            assert.ok(run.streams.has(MACHINE), 'the run remembers the stream for its end');
            await closeDesks(run, owner, core);
            const stop = calls.find((c) => c[0] === 'stream' && c[3].action === 'stop');
            assert.ok(stop, 'the stream stopped with the task');
            assert.strictEqual(run.streams.size, 0);
        });

    } finally { await t.close(); }
    done();
})().catch((e) => { console.error(e); process.exit(1); });

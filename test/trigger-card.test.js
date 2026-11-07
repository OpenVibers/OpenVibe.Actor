'use strict';
/**
 * A routine's card in the chat (plan §12 A-4): the turn that made a trigger shows it (what runs and when, its state,
 * the next run) with plain-form moves for its owner: Pause and Resume, Run now, Undo in the first ten minutes. Another
 * person cannot move it, a cross-site form is refused, and an undone routine stays in the turn as Deleted, with no moves.
 */
const assert = require('assert');
const http = require('http');
const { ids } = require('openvibe-contracts');
const { boot, check, done } = require('./helpers/boot');
const contacts = require('../server/agents/contacts');

const SAME = { 'sec-fetch-site': 'same-origin' };

/** OpenVibe.Watch as the person's token reaches it: records every call and answers like the service. */
async function watchStub() {
    const calls = [];
    const server = http.createServer(async (req, res) => {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        const text = Buffer.concat(chunks).toString('utf8');
        let body = null;
        try { body = text ? JSON.parse(text) : null; } catch { body = text; }
        calls.push({ method: req.method, url: req.url, body, auth: req.headers.authorization });
        const send = (status, value) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
        if (req.method === 'POST' && req.url === '/api/v1/watches') {
            const id = ids.newId('watch');
            return send(201, { watch: { id, status: body.status || 'active', name: body.name, labels: body.labels || {}, source: body.source } });
        }
        if (req.method === 'POST' && /^\/api\/v1\/watches\/wch_[^/]+\/schedule$/.test(req.url)) {
            return send(200, { id: req.url.split('/')[4], schedule: body, next_due_at: '2026-11-10T08:00:00.000Z' });
        }
        if (req.method === 'POST' && /^\/api\/v1\/watches\/wch_[^/]+\/(pause|resume)$/.test(req.url)) {
            return send(200, { id: req.url.split('/')[4], status: req.url.endsWith('/resume') ? 'active' : 'paused' });
        }
        if (req.method === 'PATCH' && /^\/api\/v1\/watches\/wch_[^/]+$/.test(req.url)) {
            return send(200, { watch: { id: req.url.split('/')[4], status: 'active', ...body } });
        }
        if (req.method === 'GET' && /^\/api\/v1\/watches\/wch_[^/]+$/.test(req.url)) {
            return send(200, { watch: { id: req.url.split('/')[4], status: 'active', health: { last_state: 'condition_met', consecutive_failures: 0, next_due_at: '2026-11-10T08:00:00.000Z' } } });
        }
        if (req.method === 'DELETE' && /^\/api\/v1\/watches\/wch_[^/]+$/.test(req.url)) return send(200, { id: req.url.split('/')[4], deleted: true });
        return send(404, { code: 'watch.not_found' });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    return { url: `http://127.0.0.1:${server.address().port}`, calls, close: () => new Promise((r) => server.close(r)) };
}

(async () => {
    const watch = await watchStub();
    const t = await boot({ env: { ACTOR_WATCH_URL: watch.url }, loop: { close: async () => {}, run: async () => ({ text: 'Done.', sources: [], evidence: [], model: 'fake' }) } });
    try {
        const ada = t.network.addUser('ada');
        const bo = t.network.addUser('bo');
        const owner = `user:${ada.subject}`;
        const s = t.ctx.s;
        const vibe = await contacts.ensureVibe(s, t.config, owner);
        const as = (u, method, p, o = {}) => t.get(p, { as: u, method, headers: SAME, ...o });
        const loc = (r) => (r.headers && typeof r.headers.get === 'function' ? r.headers.get('location') : r.headers && r.headers.location);
        let turn, trg;

        await check('the turn that made a routine shows its card, on, with Pause, Run now and Undo', async () => {
            const made = await as(ada, 'POST', '/api/v1/tasks', { json: { task: 'every weekday at 9, summarise my inbox' } });
            assert.ok(made.status === 201 || made.status === 202, made.text);
            turn = (made.json().task && made.json().task.id) || made.json().id;
            await t.waitFor(turn);
            const res = await as(ada, 'POST', '/api/v1/triggers', { json: { agent_id: vibe.id, task: 'summarise my inbox', kind: 'schedule', cron: '0 9 * * 1-5', timezone: 'Europe/Berlin', turn_task_id: turn } });
            assert.strictEqual(res.status, 201, res.text);
            trg = res.json().trigger.id;
            const page = await as(ada, 'GET', `/chat/turn/${turn}`);
            assert.strictEqual(page.status, 200, page.text);
            assert.ok(page.text.includes(`data-ct-trigger="${trg}"`), 'the card is in the turn');
            assert.ok(page.text.includes('summarise my inbox'));
            assert.match(page.text, /class="ct-trig-state">On</);
            assert.match(page.text, /Next run <time datetime="[^"]+" data-ct-local>/);
            assert.ok(['pause', 'run', 'undo'].every((m) => page.text.includes(`value="${m}"`)), 'Pause, Run now and Undo');
            assert.ok(!page.text.includes('value="delete"'), 'Undo, not Delete, in the first ten minutes');
        });

        await check('a schedule is said in words, never as a raw cron where a person would say it', async () => {
            const { wordsFor } = require('../server/triggers/parse');
            const said = (c) => wordsFor(c, 'UTC').replace(/ \(UTC\)$/, '');
            assert.deepStrictEqual(['30 * * * *', '0 * * * *', '*/15 * * * *', '0 */6 * * *', '0 8,20 * * *', '0 9 1 * *', '0 9 25 12 *'].map(said), [
                'Every hour at :30', 'Every hour', 'Every 15 minutes', 'Every 6 hours', 'Every day at 08:00 and 20:00',
                'Every month on the 1st at 09:00', 'Every year on 25 December at 09:00',
            ]);
            assert.match(said('0 9 1-7 * 1'), /^On a custom schedule, 0 9 1-7 \* 1$/, 'a rule with no plain phrase says so and shows it');
        });

        await check('Pause from the card, and the card says so with Resume', async () => {
            const res = await as(ada, 'POST', `/chat/${turn}/trigger/${trg}`, { form: { do: 'pause' } });
            assert.strictEqual(res.status, 303, res.text);
            const page = await as(ada, 'GET', `/chat/turn/${turn}`);
            assert.match(page.text, /class="ct-trig-state">Paused</);
            assert.ok(page.text.includes('Paused by you.'));
            assert.ok(page.text.includes('value="resume"') && !page.text.includes('value="pause"'));
            assert.ok(watch.calls.some((c) => /\/pause$/.test(c.url) && String(c.auth).startsWith('Bearer ')), 'Watch paused it, as the person');
        });

        await check('another person cannot move it, and a cross-site form is refused', async () => {
            const other = await as(bo, 'POST', `/chat/${turn}/trigger/${trg}`, { form: { do: 'resume' } });
            assert.strictEqual(other.status, 303);
            assert.strictEqual(loc(other), '/chat');
            const cross = await t.get(`/chat/${turn}/trigger/${trg}`, { as: ada, method: 'POST', headers: { 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' }, form: { do: 'resume' } });
            assert.strictEqual(cross.status, 403);
            const page = await as(ada, 'GET', `/chat/turn/${turn}`);
            assert.match(page.text, /class="ct-trig-state">Paused</, 'still paused');
        });

        await check('Undo removes it; the turn keeps the card as Deleted, with no moves', async () => {
            const res = await as(ada, 'POST', `/chat/${turn}/trigger/${trg}`, { form: { do: 'undo' } });
            assert.strictEqual(res.status, 303, res.text);
            const page = await as(ada, 'GET', `/chat/turn/${turn}`);
            assert.match(page.text, /class="ct-trig-state">Deleted</);
            assert.ok(!/value="(pause|resume|run|undo|delete)"/.test(page.text), 'no moves on a deleted routine');
            const again = await as(ada, 'POST', `/chat/${turn}/trigger/${trg}`, { form: { do: 'resume' } });
            assert.ok(again.status >= 400, `nothing to resume: ${again.status}`);
        });
    } finally {
        await t.close();
        await watch.close();
    }
    done();
})().catch((e) => { console.error(e); process.exit(1); });

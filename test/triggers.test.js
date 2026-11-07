'use strict';
/**
 * Triggers made in a conversation (plan §12 A-4): the sentence parses or asks back, the subscription is
 * a Watch the person owns, its runs are assignment roots at the person's level, the card has the last
 * result and the next run, and the four moves (edit, pause, resume, undo/delete) plus Run now are the
 * person's alone — another person gets 404. Five failed runs in a row pause it and say so.
 */
const assert = require('assert');
const http = require('http');
const crypto = require('crypto');
const { serviceAuth } = require('openvibe-contracts');
const { ids } = require('openvibe-contracts');
const { boot, check, done } = require('./helpers/boot');
const { parseRequest } = require('../server/triggers/parse');
const contacts = require('../server/agents/contacts');
const triggerStore = require('../server/triggers/store');
const { createRegistry } = require('../server/runtime/tools');

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
        const cy = t.network.addUser('cy');
        const owner = `user:${ada.subject}`;
        const s = t.ctx.s;
        const vibe = await contacts.ensureVibe(s, t.config, owner);
        const full = (await contacts.create(s, t.config, owner, { name: 'Full', level: 'full' })).row;
        const call = (method, p, o = {}) => t.get(p, { as: ada, method, headers: SAME, ...o });
        const json = (method, p, body) => call(method, p, { json: body });
        const triggered = (id) => (async () => (await call('POST', `/api/v1/triggers/${id}/run`)).json().task)();

        await check('the three examples parse; two ambiguous ones ask back', async () => {
            const weekday = parseRequest('every weekday at 9, summarise my inbox', { timezone: 'Europe/Berlin' });
            assert.deepStrictEqual([weekday.status, weekday.kind, weekday.cron, weekday.timezone, weekday.task], ['ok', 'schedule', '0 9 * * 1-5', 'Europe/Berlin', 'summarise my inbox']);
            const issue = parseRequest('when a new issue lands in my repo, triage it', { timezone: 'Europe/Berlin' });
            assert.deepStrictEqual([issue.status, issue.kind, issue.event.pattern, issue.task], ['ok', 'event', 'github.issue.opened', 'triage it']);
            const sunday = parseRequest('every Sunday evening, plan my week', { timezone: 'Europe/Berlin' });
            assert.deepStrictEqual([sunday.status, sunday.cron, sunday.task], ['ok', '0 19 * * 0', 'plan my week']);
            const vague = parseRequest('every so often, check my email', { timezone: 'Europe/Berlin' });
            assert.strictEqual(vague.status, 'ask');
            assert.match(vague.question, /how often/i);
            const nothing = parseRequest('when something happens, tell me', { timezone: 'Europe/Berlin' });
            assert.strictEqual(nothing.status, 'ask');
            assert.match(nothing.question, /what exactly/i);
            // A clear schedule with no known timezone is a question, never a UTC guess.
            const noZone = parseRequest('every weekday at 9, summarise my inbox', {});
            assert.strictEqual(noZone.status, 'ask');
            assert.match(noZone.question, /timezone/i);
        });

        await check('the tool creates on a clear sentence and asks back on a vague one', async () => {
            const registry = createRegistry({ strict: true, log: { warn() {}, log() {} } });
            const events = [];
            const ctx = {
                config: t.config, requester: owner, store: s, triggers: t.ctx.triggers,
                personToken: 'a-person-token', timezone: 'Europe/Berlin', agentId: vibe.id, taskId: null, level: 'ask',
                emit: async (e) => events.push(e),
            };
            const before = Number(await s.db.value('SELECT count(*) FROM actor_triggers WHERE owner = $1', [ada.subject]));
            const out = await registry.run('schedule_trigger', { request: 'every weekday at 9, summarise my inbox' }, ctx);
            assert.ok(!out.isError, out.text);
            const cardEvent = events.find((e) => e.step === 'trigger');
            assert.ok(cardEvent, 'the card is a trigger step on the turn');
            assert.strictEqual(cardEvent.trigger.kind, 'schedule');
            assert.strictEqual(cardEvent.trigger.when.cron, '0 9 * * 1-5');
            const asked = await registry.run('schedule_trigger', { request: 'every so often, check my email' }, ctx);
            assert.match(asked.text, /how often/i);
            const after = Number(await s.db.value('SELECT count(*) FROM actor_triggers WHERE owner = $1', [ada.subject]));
            assert.strictEqual(after, before + 1, 'the vague sentence made nothing');
        });

        await check('creating a schedule makes a paused Watch, gives it the cron, then resumes it — with the person\'s token', async () => {
            const res = await json('POST', '/api/v1/triggers', { agent_id: vibe.id, task: 'summarise my inbox', kind: 'schedule', cron: '0 9 * * 1-5', timezone: 'Europe/Berlin' });
            assert.strictEqual(res.status, 201, res.text);
            const card = res.json().trigger;
            assert.match(card.id, /^trg_/);
            assert.deepStrictEqual([card.kind, card.when.cron, card.when.timezone, card.state], ['schedule', '0 9 * * 1-5', 'Europe/Berlin', 'active']);
            const made = watch.calls.find((c) => c.method === 'POST' && c.url === '/api/v1/watches' && c.body.labels && c.body.labels.actor_trigger === card.id);
            assert.strictEqual(made.body.status, 'paused');
            assert.deepStrictEqual(made.body.labels, { actor_trigger: card.id });
            assert.ok(String(made.auth).startsWith('Bearer ') && !String(made.auth).includes('actor-secret'), 'the person\'s own bearer, not Actor\'s service secret');
            assert.ok(watch.calls.some((c) => /\/schedule$/.test(c.url)));
            assert.ok(watch.calls.some((c) => /\/resume$/.test(c.url)));
            const row = await s.db.maybe('SELECT * FROM actor_triggers WHERE id = $1', [card.id]);
            assert.strictEqual(row.state, 'active');
        });

        await check('the card has the next run, the last result, and the watch\'s own health', async () => {
            const list = await call('GET', '/api/v1/triggers');
            assert.strictEqual(list.status, 200, list.text);
            assert.ok(list.json().triggers.length >= 1);
            const id = list.json().triggers[0].id;
            const one = await call('GET', `/api/v1/triggers/${id}`);
            assert.strictEqual(one.status, 200, one.text);
            const card = one.json().trigger;
            assert.ok(card.next_run_at, 'next run is computed');
            assert.strictEqual(card.watch.status, 'active');
            assert.strictEqual(card.last_run, null);
            assert.ok(card.undo_until);
        });

        await check('pause, resume, edit and Run now are the person\'s; another person gets 404', async () => {
            const made = await json('POST', '/api/v1/triggers', { agent_id: vibe.id, task: 'plan my week', kind: 'schedule', cron: '0 19 * * 0', timezone: 'Europe/Berlin' });
            const id = made.json().trigger.id;
            const paused = await call('POST', `/api/v1/triggers/${id}/pause`);
            assert.strictEqual(paused.status, 200, paused.text);
            assert.strictEqual(paused.json().trigger.state, 'paused');
            const resumed = await call('POST', `/api/v1/triggers/${id}/resume`);
            assert.strictEqual(resumed.status, 200, resumed.text);
            assert.strictEqual(resumed.json().trigger.state, 'active');
            const edited = await call('PATCH', `/api/v1/triggers/${id}`, { json: { task: 'plan the next week' } });
            assert.strictEqual(edited.status, 200, edited.text);
            assert.strictEqual(edited.json().trigger.task, 'plan the next week');
            assert.ok(watch.calls.some((c) => c.method === 'PATCH' && c.url.endsWith(id.replace('trg_', 'wch_')) === false)); // patched by the id returned at create

            assert.strictEqual((await t.get(`/api/v1/triggers/${id}`, { as: bo })).status, 404);
            assert.strictEqual((await t.get(`/api/v1/triggers/${id}/pause`, { as: bo, method: 'POST', headers: SAME })).status, 404);
            assert.strictEqual((await t.get(`/api/v1/triggers/${id}/run`, { as: bo, method: 'POST', headers: SAME })).status, 404);
        });

        await check('Run now makes an origin-routine root at the trigger\'s level, never the agent\'s higher one', async () => {
            const made = await json('POST', '/api/v1/triggers', { agent_id: full.id, task: 'say hi', kind: 'schedule', cron: '0 9 * * *', timezone: 'UTC' });
            const id = made.json().trigger.id;
            const run = await call('POST', `/api/v1/triggers/${id}/run`);
            assert.strictEqual(run.status, 201, run.text);
            const task = await t.waitFor(run.json().task.id);
            const root = await s.db.maybe('SELECT * FROM actor_assignments WHERE task_id = $1 AND depth = 0', [task.id]);
            assert.ok(root, 'the run is a root');
            assert.strictEqual(root.origin, 'routine');
            assert.strictEqual(root.level, 'ask');
            assert.strictEqual(root.effective_level, 'ask', 'the routine cannot borrow the agent\'s full level');
            const card = (await call('GET', `/api/v1/triggers/${id}`)).json().trigger;
            assert.deepStrictEqual([card.last_run.state, card.last_run.task_id], ['ok', task.id]);
        });

        await check('event triggers subscribe the event source, not a webhook', async () => {
            const made = await json('POST', '/api/v1/triggers', { agent_id: vibe.id, task: 'triage it', kind: 'event', event: { pattern: 'github.issue.opened', filter: { repo: 'openvibe/actor' } } });
            assert.strictEqual(made.status, 201, made.text);
            const callMade = watch.calls.filter((c) => c.method === 'POST' && c.url === '/api/v1/watches').pop();
            assert.strictEqual(callMade.body.source.kind, 'event');
            assert.strictEqual(callMade.body.source.pattern, 'github.issue.opened');
            assert.strictEqual(callMade.body.source.filter.repo, 'openvibe/actor');
            assert.strictEqual(made.json().trigger.kind, 'event');
        });

        await check('undo within ten minutes removes it with no trace; delete needs confirmation after', async () => {
            const made = await json('POST', '/api/v1/triggers', { agent_id: vibe.id, task: 'undo me', kind: 'schedule', cron: '0 9 * * *', timezone: 'UTC' });
            const id = made.json().trigger.id;
            const undone = await call('DELETE', `/api/v1/triggers/${id}?undo=1`);
            assert.strictEqual(undone.status, 200, undone.text);
            assert.strictEqual(undone.json().undone, true);
            assert.strictEqual((await call('GET', `/api/v1/triggers/${id}`)).status, 404);
            assert.strictEqual(await s.db.maybe('SELECT * FROM actor_triggers WHERE id = $1', [id]), null, 'no row remains');
            assert.ok(watch.calls.some((c) => c.method === 'DELETE'));

            const old = await json('POST', '/api/v1/triggers', { agent_id: vibe.id, task: 'delete me', kind: 'schedule', cron: '0 9 * * *', timezone: 'UTC' });
            const oldId = old.json().trigger.id;
            await s.db.query('UPDATE actor_triggers SET created_at = $2 WHERE id = $1', [oldId, Date.now() - 11 * 60_000]);
            assert.strictEqual((await call('DELETE', `/api/v1/triggers/${oldId}`)).status, 409, 'no confirmation, no delete');
            const expired = await call('DELETE', `/api/v1/triggers/${oldId}?undo=1`);
            assert.strictEqual(expired.status, 409, 'the undo window has passed');
            const deleted = await call('DELETE', `/api/v1/triggers/${oldId}?confirm=delete`);
            assert.strictEqual(deleted.status, 200, deleted.text);
            assert.strictEqual((await call('GET', `/api/v1/triggers/${oldId}`)).status, 404);
        });

        await check('at most twenty active triggers; a paused one does not count', async () => {
            const boOwner = `user:${bo.subject}`;
            const boVibe = await contacts.ensureVibe(s, t.config, boOwner);
            const boCall = (method, p, o = {}) => t.get(p, { as: bo, method, headers: SAME, ...o });
            for (let i = 0; i < 20; i += 1) {
                const made = await boCall('POST', '/api/v1/triggers', { json: { agent_id: boVibe.id, task: `filler ${i}`, kind: 'schedule', cron: '0 9 * * *', timezone: 'UTC' } });
                assert.strictEqual(made.status, 201, made.text);
            }
            const over = await boCall('POST', '/api/v1/triggers', { json: { agent_id: boVibe.id, task: 'one too many', kind: 'schedule', cron: '0 9 * * *', timezone: 'UTC' } });
            assert.strictEqual(over.status, 409, over.text);
            assert.strictEqual(over.json().code, 'actor.trigger.limit');
            const one = await s.db.maybe("SELECT id FROM actor_triggers WHERE owner = $1 AND state = 'active' AND deleted_at IS NULL LIMIT 1", [bo.subject]);
            assert.strictEqual((await boCall('POST', `/api/v1/triggers/${one.id}/pause`)).status, 200);
            const again = await boCall('POST', '/api/v1/triggers', { json: { agent_id: boVibe.id, task: 'room now', kind: 'schedule', cron: '0 9 * * *', timezone: 'UTC' } });
            assert.strictEqual(again.status, 201, again.text);
        });

        await check('five failed runs in a row pause the trigger and say so on its card', async () => {
            const cyVibe = await contacts.ensureVibe(s, t.config, `user:${cy.subject}`);
            const made = await t.get('/api/v1/triggers', { as: cy, method: 'POST', headers: SAME, json: { agent_id: cyVibe.id, task: 'fails a lot', kind: 'schedule', cron: '0 9 * * *', timezone: 'UTC' } });
            const id = made.json().trigger.id;
            for (let i = 0; i < 5; i += 1) {
                const taskId = ids.newId('task');
                await s.db.query("INSERT INTO tasks (id, requester, task, mode, budget_task, budget_day, state, created_at) VALUES ($1,$2,'a failed run','balanced',0.01,1,'failed',$3) ON CONFLICT DO NOTHING", [taskId, `user:${cy.subject}`, new Date().toISOString()]);
                await triggerStore.addRun(s, id, taskId, 'queued', Date.now());
                await t.ctx.triggers.taskState({ id: taskId, state: 'failed' });
            }
            const card = (await t.get(`/api/v1/triggers/${id}`, { as: cy })).json().trigger;
            assert.deepStrictEqual([card.state, card.paused_reason, card.failures], ['paused', 'failed', 5]);
            assert.strictEqual(card.last_run.state, 'failed');
        });
        await check('Watch waking an agent is an origin-routine run linked to the trigger', async () => {
            const made = await json('POST', '/api/v1/triggers', { agent_id: vibe.id, task: 'look into it', kind: 'schedule', cron: '0 9 * * *', timezone: 'UTC' });
            const trigger = made.json().trigger;
            const row = await s.db.maybe('SELECT watch_id FROM actor_triggers WHERE id = $1', [trigger.id]);
            const now = Math.floor(Date.now() / 1000);
            const token = serviceAuth.signServiceToken({
                iss: t.network.url, sub: 'svc:watch', actor_type: 'service', aud: ['openvibe.actor'],
                cap: ['actor.agent.run'], ns: [], iat: now, exp: now + 300, jti: `tok_${crypto.randomBytes(6).toString('hex')}`,
            }, t.network.privatePem);
            const res = await t.get(`/api/v1/me/agents/${vibe.id}/run`, {
                bearer: token, headers: { 'X-OV-Subject': ada.subject },
                json: { input: 'the watch fired', watch_id: row.watch_id, trigger_id: trigger.id },
            });
            assert.strictEqual(res.status, 201, res.text);
            const task = await t.waitFor(res.json().id);
            const root = await s.db.maybe('SELECT * FROM actor_assignments WHERE task_id = $1 AND depth = 0', [task.id]);
            assert.deepStrictEqual([root.origin, root.effective_level], ['routine', 'ask']);
            const run = await s.db.maybe('SELECT * FROM actor_trigger_runs WHERE task_id = $1', [task.id]);
            assert.strictEqual(run.trigger_id, trigger.id, 'the run is linked back to its card');
        });

    } finally {
        await t.close();
        await watch.close();
    }
    done();
})().catch((e) => { console.error(e); process.exit(1); });

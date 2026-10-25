'use strict';
// Each run is a chat you can open (consumer plan §4; server/agents/vibe-deliver.js, migration 0013, chat.vibe.deliver):
// a personal agent's run that passed its check goes to its owner's Vibe chat named after it, once, with the task id as
// the key; a failure waits and is tried again, Chat refusing it ends it; an agent with send_to_vibe off sends nothing;
// the switch is on by default, in the API and on the form.
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const personal = require('../server/agents/personal');
const { createVibeDelivery } = require('../server/agents/vibe-deliver');
const SAME = { 'sec-fetch-site': 'same-origin' };

(async () => {
    const sent = [];
    let answer = () => ({ ok: true, status: 201, url: 'https://openvibe.chat/vibe/v-0123456789ab', repeated: false });
    const chat = { enabled: true, deliverEnabled: true, post: async () => ({ ok: true, status: 201 }), deliver: async (b) => { sent.push(b); return answer(b); } };
    const t = await boot({ chatClient: chat, adapters: {
        checkers: { local: async () => ({ text: '{"ok":true,"reason":"answers"}', cost_usd: 0 }) },
        run: { 'open-model': async () => ({ text: '**Two new jobs** today.\nREMEMBER: Saw two jobs', sources: [], model: 'fake' }) },
    } });
    try {
        const who = t.network.addUser('vibe-runner');
        const owner = `user:${who.subject}`;
        const made = (await personal.create(t.ctx.s, t.config, owner, { name: 'Remote jobs', instructions: 'Find remote jobs.', mode: 'private', budget_per_run_usd: 0.02, daily_runs_max: 5, schedule: 'off', status: 'active' })).row;
        const delivery = createVibeDelivery({ s: t.ctx.s, config: t.config, chat, log: { warn() {} } });
        const runOnce = async () => { const out = await personal.run(t.ctx, made, ''); assert.strictEqual(out.status, 201); await t.waitFor(out.task.id); return out.task.id; };

        await check('a run that passed its check goes to Vibe once: the owner, the agent, the answer, its page, the task id as key', async () => {
            assert.strictEqual(made.send_to_vibe, true, 'on by default');
            const id = await runOnce();
            assert.strictEqual(await delivery.tick(), 1);
            assert.deepStrictEqual(sent.pop(), { subject: who.subject, agent: { id: made.id, name: 'Remote jobs' }, text: '**Two new jobs** today.', url: `${t.config.baseUrl}/tasks/${id}`, key: id });
            assert.strictEqual(await delivery.tick(), 0, 'sent once');
            const row = await t.ctx.s.db.maybe('SELECT state, attempts, chat_url FROM actor_vibe_deliveries WHERE task_id = $1', [id]);
            assert.deepStrictEqual([row.state, Number(row.attempts), row.chat_url], ['sent', 1, 'https://openvibe.chat/vibe/v-0123456789ab']);
            assert.match((await t.get(`/me/agents/${made.id}`, { as: who })).text, /lands in <a href="https:\/\/openvibe\.chat\/vibe\/v-0123456789ab">its Vibe chat<\/a>/, 'the agent page links its chat');
        });

        await check('Chat down: it waits and is tried again later; Chat refusing it ends it', async () => {
            answer = () => ({ ok: false, status: 503, error: 'Chat answered 503' });
            const id = await runOnce();
            assert.strictEqual(await delivery.tick(), 0);
            let row = await t.ctx.s.db.maybe('SELECT state, attempts, next_at FROM actor_vibe_deliveries WHERE task_id = $1', [id]);
            assert.deepStrictEqual([row.state, Number(row.attempts)], ['pending', 1]);
            assert.ok(Date.parse(row.next_at) > Date.now() + 60_000, 'waits before the next try');
            const tries = sent.length;
            assert.strictEqual(await delivery.tick(), 0);
            assert.strictEqual(sent.length, tries, 'not before its time');
            await t.ctx.s.db.query('UPDATE actor_vibe_deliveries SET next_at = $1 WHERE task_id = $2', ['2000-01-01T00:00:00.000Z', id]);
            answer = () => ({ ok: false, status: 422, error: 'unknown person' });
            await delivery.tick();
            row = await t.ctx.s.db.maybe('SELECT state, attempts, error FROM actor_vibe_deliveries WHERE task_id = $1', [id]);
            assert.deepStrictEqual([row.state, Number(row.attempts), row.error], ['failed', 2, 'unknown person']);
            answer = () => ({ ok: true, status: 201, url: 'https://openvibe.chat/vibe/v-0123456789ab' });
            assert.strictEqual(await delivery.tick(), 0, 'a refused run is not sent again');
        });

        await check('send_to_vibe off: nothing goes; the API takes only true or false; the form keeps the box', async () => {
            const off = await personal.update(t.ctx.s, t.config, owner, made.id, { send_to_vibe: false });
            assert.strictEqual(off.row.send_to_vibe, false);
            await runOnce();
            const before = sent.length;
            assert.strictEqual(await delivery.tick(), 0);
            assert.strictEqual(sent.length, before);
            assert.match((await personal.update(t.ctx.s, t.config, owner, made.id, { send_to_vibe: 'yes' })).error, /true or false/);
            const page = await t.get(`/me/agents/${made.id}`, { as: who });
            assert.match(page.text, /name="send_to_vibe" value="1"> Send each run to Vibe/, 'unticked while off');
            const fresh = await t.get('/me/agents', { as: who });
            assert.match(fresh.text, /name="send_to_vibe" value="1" checked> Send each run to Vibe/, 'a new agent starts with it on');
            const api = await t.get(`/api/v1/me/agents/${made.id}`, { as: who });
            assert.strictEqual(api.json().send_to_vibe, false);
            const on = await t.get(`/api/v1/me/agents/${made.id}`, { as: who, method: 'PATCH', json: { send_to_vibe: true }, headers: SAME });
            assert.strictEqual(on.json().send_to_vibe, true, on.text);
        });
    } finally { await t.close(); }
    done();
})();

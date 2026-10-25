'use strict';
// Playbooks from outcomes (consumer plan step 4, server/agents/personal.js, migration 0012): after a run that passed its
// check, a personal agent's IMPROVE: line becomes a suggestion for its instructions (REMEMBER: still saves a note), both
// taken off the answer; the person adds it, dismisses it or undoes it (only while the instructions are as it left them);
// at most three wait at once and the same line once; the page and the API do the same.
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const personal = require('../server/agents/personal');
const SAME = { 'sec-fetch-site': 'same-origin' };

(async () => {
    const t = await boot({ adapters: {
        checkers: { local: async () => ({ text: '{"ok":true,"reason":"answers"}', cost_usd: 0 }) },
        run: { 'open-model': async () => ({ text: 'Mars is the fourth planet.\nREMEMBER: Likes Mars\nIMPROVE: Give distances in kilometres and miles.', sources: [], model: 'fake' }) },
    } });
    try {
        const who = t.network.addUser('suggest-runner');
        const owner = `user:${who.subject}`;
        const made = (await personal.create(t.ctx.s, t.config, owner, { name: 'Planets', instructions: 'Explain planets.', mode: 'private', budget_per_run_usd: 0.02, daily_runs_max: 3, schedule: 'off', status: 'active' })).row;

        await check('a passed run\'s IMPROVE: line waits as a suggestion; REMEMBER: is a note; both come off the answer', async () => {
            const out = await personal.run(t.ctx, made, 'Mars');
            assert.strictEqual(out.status, 201);
            const row = await t.waitFor(out.task.id);
            const result = typeof row.result === 'string' ? JSON.parse(row.result) : row.result;
            assert.strictEqual(result.answer, 'Mars is the fourth planet.');
            assert.deepStrictEqual((await personal.memory(t.ctx.s, owner, made.id)).map((n) => n.text), ['Likes Mars']);
            const list = await personal.proposals(t.ctx.s, owner, made.id);
            assert.deepStrictEqual(list.map((p) => [p.text, p.state, p.from_task]), [['Give distances in kilometres and miles.', 'pending', out.task.id]]);
            assert.strictEqual((await personal.get(t.ctx.s, owner, made.id)).instructions, 'Explain planets.', 'nothing changes without the person');
        });

        await check('add it, then undo it; once the instructions are edited by hand, undo is refused', async () => {
            const [p] = await personal.proposals(t.ctx.s, owner, made.id);
            const applied = await personal.decide(t.ctx.s, owner, made.id, p.id, 'apply');
            assert.strictEqual(applied.agent.instructions, 'Explain planets.\n- Give distances in kilometres and miles.');
            assert.strictEqual((await personal.decide(t.ctx.s, owner, made.id, p.id, 'apply')).status, 409, 'decided once');
            const undone = await personal.decide(t.ctx.s, owner, made.id, p.id, 'undo');
            assert.strictEqual(undone.agent.instructions, 'Explain planets.');
            const again = await personal.addProposal(t.ctx.s, owner, made.id, 'Name one moon.');
            await personal.decide(t.ctx.s, owner, made.id, again.id, 'apply');
            await personal.update(t.ctx.s, t.config, owner, made.id, { instructions: 'Explain planets simply.' });
            const late = await personal.decide(t.ctx.s, owner, made.id, again.id, 'undo');
            assert.deepStrictEqual([late.status, /changed since/.test(late.error)], [409, true]);
        });

        await check('at most three wait at once, the same line once; too long or someone else\'s agent is nothing', async () => {
            assert.ok(await personal.addProposal(t.ctx.s, owner, made.id, 'One.'));
            assert.strictEqual(await personal.addProposal(t.ctx.s, owner, made.id, 'one.'), null, 'the same line, any case');
            assert.ok(await personal.addProposal(t.ctx.s, owner, made.id, 'Two.'));
            assert.ok(await personal.addProposal(t.ctx.s, owner, made.id, 'Three.'));
            assert.strictEqual(await personal.addProposal(t.ctx.s, owner, made.id, 'Four.'), null, 'three waiting already');
            assert.strictEqual(await personal.addProposal(t.ctx.s, owner, made.id, 'x'.repeat(301)), null);
            assert.strictEqual(await personal.addProposal(t.ctx.s, 'user:usr_01JABCDEFGHJKMNPQRSTVWXYZ0', made.id, 'Mine.'), null);
        });

        await check('the agent page shows them with Add and Dismiss; the form decides; another person reaches nothing', async () => {
            const pageOf = await t.get(`/me/agents/${made.id}`, { as: who });
            assert.match(pageOf.text, /Suggestions from your agent/);
            assert.match(pageOf.text, /Add to its instructions/);
            assert.match(pageOf.text, /<span class="pa-run-gist">Mars is the fourth planet\.<\/span>/, 'the run journal: each run\'s first line');
            const one = (await personal.proposals(t.ctx.s, owner, made.id)).find((p) => p.text === 'One.');
            const r = await t.get(`/me/agents/${made.id}/suggestions/${one.id}`, { as: who, form: { decision: 'dismiss' }, headers: SAME });
            assert.strictEqual(r.status, 303);
            assert.strictEqual((await personal.proposals(t.ctx.s, owner, made.id)).find((p) => p.id === one.id).state, 'dismissed');
            const stranger = t.network.addUser('suggest-stranger');
            const two = (await personal.proposals(t.ctx.s, owner, made.id)).find((p) => p.text === 'Two.');
            assert.strictEqual((await t.get(`/me/agents/${made.id}/suggestions/${two.id}`, { as: stranger, form: { decision: 'apply' }, headers: SAME })).status, 404);
        });
    } finally { await t.close(); }
    done();
})();

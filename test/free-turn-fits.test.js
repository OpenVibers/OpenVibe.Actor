'use strict';
/**
 * A turn that cannot finish never starts on the free AI (plan §AD.17; 11-17: two probe turns on production spent 22k
 * free tokens and answered nothing, each refused halfway). Before an agent turn the engine reads what the person has
 * left (models.allowanceFor, OpenVibe.AI's service read); when it is less than a turn takes (ACTOR_FREE_TURN_TOKENS,
 * 12,000 by default):
 *   • their own key takes it (they allowed Actor to use one), and the timeline says why;
 *   • else their computer takes it, through Codes;
 *   • else it fails at once with ai.allowance_spent (the ways to keep going), the loop never called;
 * plenty left, no cap, or no read at all: the turn runs as before.
 *   node test/free-turn-fits.test.js
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

const SAME = { 'sec-fetch-site': 'same-origin', accept: 'application/json' };

(async () => {
    const state = { loopRuns: 0, machines: [], codesAsked: [], allowance: null, ownKey: null };
    const t = await boot({
        loop: { close: async () => {}, run: async () => { state.loopRuns++; return { text: 'Done.', sources: [], evidence: [], model: 'fake' }; } },
        adapters: {
            checkers: { local: async () => ({ text: '{"ok":true,"reason":"answers"}', cost_usd: 0 }) },
            run: { codes: async (args) => { state.codesAsked.push(args.task); return { text: 'From your computer.', sources: [], model: 'claude-code' }; } },
        },
        bot: { computers: { enabled: true, mine: async () => state.machines } },
    });
    t.ctx.models.allowanceFor = async () => state.allowance;
    t.ctx.models.ownKeyFor = async () => state.ownKey;
    const day = (left) => ({ tier: 'standard', unlimited: false, tokens: 20000, used: 20000 - left, left, resets_at: '2026-11-18T00:00:00.000Z' });
    try {
        const ada = t.network.addUser('ada');
        const create = async (task) => (await t.get('/api/v1/tasks', { as: ada, json: { task }, headers: SAME })).json().id;
        const said = async (id) => JSON.stringify((await t.ctx.s.db.many('SELECT body FROM task_events WHERE task_id = $1 ORDER BY seq', [id]).catch(() => [])).map((r) => r.body));

        await check('not enough left, no key, no computer: it says so at once and spends nothing', async () => {
            state.allowance = day(8900); state.ownKey = null; state.machines = []; state.loopRuns = 0;
            const row = await t.waitFor(await create('Find me three cheap GPU rentals'));
            assert.strictEqual(row.state, 'failed');
            assert.strictEqual(row.error_code, 'ai.allowance_spent');
            assert.match(row.error_detail, /8,900 tokens left today/);
            assert.match(row.error_detail, /free AI allowance is spent/, 'the words every reader of a spent allowance knows');
            assert.strictEqual(state.loopRuns, 0, 'the loop never ran');
        });

        await check('not enough left, a key Actor may use: the key takes it, and the timeline says why', async () => {
            state.allowance = day(8900); state.ownKey = { provider: 'anthropic', subject: 'usr_01JAB2C3D4E5F6G7H8J9K0MNPQ' }; state.loopRuns = 0;
            const row = await t.waitFor(await create('Plan my week'));
            // The loop ran on the key (its answer's check goes to OpenVibe.AI with the same key, which this test has not).
            assert.strictEqual(state.loopRuns, 1, row.error_detail);
            assert.notStrictEqual(row.error_code, 'ai.allowance_spent');
            assert.match(await said(row.id), /free AI has 8,900 tokens left today, not enough for this, so your own anthropic key takes it/);
        });

        await check('not enough left, no key, a computer online: the computer takes it', async () => {
            state.allowance = day(500); state.ownKey = null; state.machines = [{ id: 'dev_1', name: 'Studio PC', online: true }]; state.codesAsked = []; state.loopRuns = 0;
            const row = await t.waitFor(await create('Say hi'));
            assert.strictEqual(row.state, 'succeeded', row.error_detail);
            assert.deepStrictEqual(state.codesAsked, ['Say hi']);
            assert.strictEqual(state.loopRuns, 0);
        });

        await check('plenty left, no cap, or no read: the turn runs as before', async () => {
            state.machines = []; state.ownKey = null;
            for (const a of [day(19000), { tier: 'owner', unlimited: true, tokens: null, used: 0, left: null }, null]) {
                state.allowance = a; state.loopRuns = 0;
                const row = await t.waitFor(await create('What is new this week?'));
                assert.strictEqual(row.state, 'succeeded', `${JSON.stringify(a)}: ${row.error_detail}`);
                assert.strictEqual(state.loopRuns, 1);
            }
        });
    } finally {
        await t.close();
    }
    done();
})().catch((err) => { console.error(err); process.exit(1); });

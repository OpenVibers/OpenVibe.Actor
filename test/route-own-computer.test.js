'use strict';
/**
 * The route always finds a way (plan §AD.17; the owner, 11-17: "it can use different harnesses … smart … it can use
 * Actor"). Actor's loop ends on OpenVibe's spent free allowance (Exchange's 402) and no key of the person's answered:
 * when one of their computers is online, the same task goes there through Codes and succeeds, saying which computer
 * took it and why; with no computer online, or a computer that cannot take it, the task fails with the allowance's own
 * words; another failure is never rerouted.
 *   node test/route-own-computer.test.js
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

const SAME = { 'sec-fetch-site': 'same-origin', accept: 'application/json' };
const SPENT = 'OpenVibe.Exchange HTTP 402: The free AI allowance for usr_01KKT9AC60KM7CRTB3WN1Z8P56 is spent, and the calling service has no budget to cover this run.';

(async () => {
    const state = { loop: 'spent', machines: [{ id: 'dev_1', name: 'Studio PC', online: true }], codes: 'ok', codesAsked: [] };
    const t = await boot({
        loop: {
            close: async () => {},
            run: async () => {
                if (state.loop === 'spent') throw Object.assign(new Error(SPENT), { status: 402, code: 'actor.provider.error' });
                if (state.loop === 'broken') throw Object.assign(new Error('upstream broke'), { status: 500, code: 'actor.provider.error' });
                return { text: 'Done.', sources: [], evidence: [], model: 'fake' };
            },
        },
        adapters: {
            checkers: { local: async () => ({ text: '{"ok":true,"reason":"answers"}', cost_usd: 0 }) },
            run: {
                codes: async (args) => {
                    state.codesAsked.push(args.task);
                    if (state.codes === 'fail') throw new Error('No machine of yours took the task in time.');
                    return { text: 'Three GPU rentals: A, B, C.', sources: [], model: 'claude-code' };
                },
            },
        },
        bot: { computers: { enabled: true, mine: async () => state.machines } },
    });
    try {
        const ada = t.network.addUser('ada');
        const create = async (task) => (await t.get('/api/v1/tasks', { as: ada, json: { task }, headers: SAME })).json().id;
        const resultOf = (row) => (typeof row.result === 'string' ? JSON.parse(row.result) : row.result);

        await check('free AI spent, a computer online: that computer takes the same task, and says so', async () => {
            const row = await t.waitFor(await create('Find me three cheap GPU rentals'));
            assert.strictEqual(row.state, 'succeeded', row.error_detail);
            const r = resultOf(row);
            assert.deepStrictEqual([r.answer, r.agent, r.route], ['Three GPU rentals: A, B, C.', 'codes', { road: 'own-computer', where: 'Studio PC', because: 'the free AI was used up' }]);
            assert.deepStrictEqual(state.codesAsked, ['Find me three cheap GPU rentals'], 'the same words');
            const events = await t.ctx.s.db.query('SELECT payload FROM task_events WHERE task_id = $1', [row.id]).catch(() => null);
            if (events && events.rows) assert.ok(events.rows.some((e) => /free AI is used up for today, so Studio PC takes it/.test(JSON.stringify(e.payload))), 'the timeline says which road and why');
        });

        await check('no computer online, or one that cannot take it: the allowance\'s own words', async () => {
            state.machines = [{ id: 'dev_1', name: 'Studio PC', online: false }];
            let row = await t.waitFor(await create('Plan my week'));
            assert.strictEqual(row.state, 'failed');
            assert.match(row.error_detail, /free AI allowance/);
            state.machines = [{ id: 'dev_1', name: 'Studio PC', online: true }]; state.codes = 'fail';
            row = await t.waitFor(await create('Plan my week again'));
            assert.strictEqual(row.state, 'failed');
            assert.match(row.error_detail, /free AI allowance/, 'the first failure stands');
        });

        await check('another failure is never rerouted', async () => {
            state.codes = 'ok'; state.loop = 'broken'; state.codesAsked = [];
            const row = await t.waitFor(await create('Say hi'));
            assert.strictEqual(row.state, 'failed');
            assert.deepStrictEqual(state.codesAsked, []);
        });
    } finally {
        await t.close();
    }
    done();
})().catch((err) => { console.error(err); process.exit(1); });

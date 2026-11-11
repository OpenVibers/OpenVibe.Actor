'use strict';
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

(async () => {
    const calls = [];
    let ranCodes = false;
    const loop = {
        async run(args) {
            calls.push(args);
            return {
                text: ranCodes ? 'Codes started the requested change. [E1]' : 'I changed the code.',
                evidence: ranCodes ? [{ id: 'E1', tool: 'codes_task', input: { instruction: 'Edit the README' }, text: 'Codes started the task.', sources: [], artifacts: [], refs: [] }] : [],
                sources: [], family: 'deepseek', brain: { steps: ranCodes ? [{ tool: 'codes_task', ok: true }] : [] },
            };
        },
        async close() {},
    };
    const t = await boot({ loop });
    try {
        const person = t.network.addUser('code-owner');
        t.providers.state.cls = 'code';
        await check('a direct coding task cannot claim success without a Codes handoff', async () => {
            const r = await t.get('/api/v1/tasks', { as: person, headers: { 'sec-fetch-site': 'same-origin' }, json: { task: 'Edit the README in https://github.com/octocat/Hello-World' } });
            assert.strictEqual(r.status, 201, r.text);
            const row = await t.waitFor(r.json().id);
            assert.deepStrictEqual([row.state, row.error_code], ['failed', 'actor.codes.not_run']);
            assert.strictEqual(calls.length, 1, JSON.stringify(row.error));
            assert.deepStrictEqual(calls[0].allowedTools, ['codes_task']);
            assert.match(calls[0].requester, /^user:usr_[0-9A-HJKMNP-TV-Z]{26}$/);
            assert.strictEqual(row.explanation[0].selected, 'openvibe-runtime');
        });
        await check('the same runtime accepts a successful Codes handoff', async () => {
            ranCodes = true;
            const r = await t.get('/api/v1/tasks', { as: person, headers: { 'sec-fetch-site': 'same-origin' }, json: { task: 'Edit the docs in https://github.com/octocat/Hello-World' } });
            assert.strictEqual(r.status, 201, r.text);
            const row = await t.waitFor(r.json().id);
            assert.strictEqual(row.state, 'succeeded', row.error_detail || row.error_code);
            assert.strictEqual(row.result.agent, 'openvibe-runtime');
        });
        const load = require('../server/config').load;
        const defaults = load({});
        assert.deepStrictEqual([defaults.unifiedCodeRuns, defaults.a4ModelSwitch, defaults.codesSessionBridge], [true, true, true]);
        const rollback = load({ ACTOR_UNIFIED_CODE_RUNS: '0', ACTOR_A4_MODEL_SWITCH: '0', ACTOR_CODES_SESSION_BRIDGE: '0' });
        assert.deepStrictEqual([rollback.unifiedCodeRuns, rollback.a4ModelSwitch, rollback.codesSessionBridge], [false, false, false]);
    } finally { await t.close(); }
    done();
})().catch((err) => { console.error(err); process.exit(1); });

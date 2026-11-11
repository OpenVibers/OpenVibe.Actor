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
        let approvalId;
        await check('a direct coding task at ask level waits for approval before Codes runs', async () => {
            const r = await t.get('/api/v1/tasks', { as: person, headers: { 'sec-fetch-site': 'same-origin' }, json: { task: 'Edit the README in https://github.com/octocat/Hello-World' } });
            assert.strictEqual(r.status, 201, r.text);
            const row = await t.waitFor(r.json().id);
            assert.strictEqual(row.state, 'succeeded');
            assert.ok(row.result.approval && row.result.approval.id);
            approvalId = row.result.approval.id;
            assert.strictEqual(calls.length, 0, 'the loop must wait for approval too');
        });
        await check('an approved coding task restarts in the same runtime', async () => {
            ranCodes = true;
            const approved = await t.get(`/me/approvals/${approvalId}`, { as: person, form: { decision: 'approve' }, headers: { 'sec-fetch-site': 'same-origin' } });
            assert.strictEqual(approved.status, 303, approved.text);
            const taskId = /\/tasks\/(tsk_[0-9A-Z]{26})/.exec(approved.headers.get('location'))[1];
            const row = await t.waitFor(taskId);
            assert.strictEqual(row.state, 'succeeded', row.error_detail || row.error_code);
            assert.strictEqual(row.result.agent, 'openvibe-runtime');
            assert.deepStrictEqual(calls[0].allowedTools, ['codes_task']);
            ranCodes = false;
        });
        await check('a direct coding task cannot claim success without a Codes handoff', async () => {
            const r = await t.get('/api/v1/tasks', { as: person, headers: { 'sec-fetch-site': 'same-origin' }, json: { task: 'Edit the README in https://github.com/octocat/Hello-World', level: 'full' } });
            assert.strictEqual(r.status, 201, r.text);
            const row = await t.waitFor(r.json().id);
            assert.deepStrictEqual([row.state, row.error_code], ['failed', 'actor.codes.not_run']);
            assert.strictEqual(calls.length, 2, JSON.stringify(row.error));
            assert.deepStrictEqual(calls[1].allowedTools, ['codes_task']);
            assert.match(calls[1].requester, /^user:usr_[0-9A-HJKMNP-TV-Z]{26}$/);
            assert.strictEqual(row.explanation[0].selected, 'openvibe-runtime');
        });
        await check('the same runtime accepts a successful Codes handoff', async () => {
            ranCodes = true;
            const r = await t.get('/api/v1/tasks', { as: person, headers: { 'sec-fetch-site': 'same-origin' }, json: { task: 'Edit the docs in https://github.com/octocat/Hello-World', level: 'full' } });
            assert.strictEqual(r.status, 201, r.text);
            const row = await t.waitFor(r.json().id);
            assert.strictEqual(row.state, 'succeeded', row.error_detail || row.error_code);
            assert.strictEqual(row.result.agent, 'openvibe-runtime');
        });
        await check('an explicitly selected Codes agent uses the shared loop', async () => {
            const r = await t.get('/api/v1/tasks', { as: person, headers: { 'sec-fetch-site': 'same-origin' }, json: { task: 'Edit the docs in https://github.com/octocat/Hello-World', agent: 'codes', level: 'full' } });
            assert.strictEqual(r.status, 201, r.text);
            const row = await t.waitFor(r.json().id);
            assert.strictEqual(row.state, 'succeeded', row.error_detail || row.error_code);
            assert.strictEqual(row.result.agent, 'openvibe-runtime');
            assert.deepStrictEqual(calls.at(-1).allowedTools, ['codes_task']);
        });
        const load = require('../server/config').load;
        const defaults = load({});
        assert.deepStrictEqual([defaults.unifiedCodeRuns, defaults.a4ModelSwitch, defaults.codesSessionBridge], [true, true, true]);
        const rollback = load({ ACTOR_UNIFIED_CODE_RUNS: '0', ACTOR_A4_MODEL_SWITCH: '0', ACTOR_CODES_SESSION_BRIDGE: '0' });
        assert.deepStrictEqual([rollback.unifiedCodeRuns, rollback.a4ModelSwitch, rollback.codesSessionBridge], [false, false, false]);
    } finally { await t.close(); }
    done();
})().catch((err) => { console.error(err); process.exit(1); });

'use strict';
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

(async () => {
    const calls = [];
    const loop = {
        async run(args) {
            calls.push(args);
            return { text: 'The coding request is ready for Codes on your machine.', evidence: [], sources: [], family: 'deepseek' };
        },
        async close() {},
    };
    const t = await boot({ env: { ACTOR_UNIFIED_CODE_RUNS: '1' }, loop });
    try {
        const person = t.network.addUser('code-owner');
        t.providers.state.cls = 'code';
        await check('a direct coding task uses the shared loop with only the Codes tool', async () => {
            const r = await t.get('/api/v1/tasks', { as: person, headers: { 'sec-fetch-site': 'same-origin' }, json: { task: 'Edit the README in https://github.com/octocat/Hello-World' } });
            assert.strictEqual(r.status, 201, r.text);
            const row = await t.waitFor(r.json().id);
            assert.strictEqual(calls.length, 1, JSON.stringify(row.error));
            assert.deepStrictEqual(calls[0].allowedTools, ['codes_task']);
            assert.match(calls[0].requester, /^user:usr_[0-9A-HJKMNP-TV-Z]{26}$/);
            assert.strictEqual(row.explanation[0].selected, 'openvibe-runtime');
        });
    } finally { await t.close(); }
    done();
})().catch((err) => { console.error(err); process.exit(1); });

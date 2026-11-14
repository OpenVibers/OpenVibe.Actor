'use strict';
// POST /api/v1/tasks with setup (plan §AB.44): the person's own task to set up one provider key with their grant. The task's
// text never carries the grant id; the grant waits in memory beside the task; an app, a bad grant, a provider whose keys
// cannot be read from its page, or a page that is not https are each refused.
const assert = require('assert');
const { boot, done } = require('./helpers/boot');
const grants = require('../server/setup/grants');
const GRANT = 'sgr_' + 'B'.repeat(32);
(async () => {
    const t = await boot();
    try {
        const ada = t.network.addUser('setupada');
        const SAME = { origin: t.base, 'sec-fetch-site': 'same-origin' };
        const post = (json, as = ada) => t.get('/api/v1/tasks', { as, json: { setup: json }, headers: SAME });
        const body = { grant: GRANT, keys: ['deepseek.api_key'], provider: 'deepseek', label: 'DeepSeek', get_it_at: 'https://platform.deepseek.com/api_keys' };
        const r = await post(body);
        assert.strictEqual(r.status, 201, r.text);
        const task = r.json();
        assert.ok(task.id && /DeepSeek/.test(task.task) && /setup_save_key/.test(task.task), 'a task in words');
        assert.ok(!r.text.includes(GRANT) && !String(task.task).includes(GRANT), 'the grant id is never in the task or the answer');
        assert.deepStrictEqual(task.setup, { provider: 'deepseek', label: 'DeepSeek', keys: ['deepseek.api_key'] });
        assert.strictEqual(grants.grantFor(task.id).grantId, GRANT, 'the grant waits beside its task');
        assert.strictEqual((await post({ ...body, grant: 'nope' })).status, 422, 'a bad grant');
        assert.strictEqual((await post({ ...body, provider: 'mistral' })).status, 422, 'a provider whose keys cannot be read from its page');
        assert.strictEqual((await post({ ...body, get_it_at: 'http://example.test' })).status, 422, 'not https');
        console.log('setup tasks route: a person\'s task, the grant beside it in memory, refusals in words');
    } finally { await t.close(); }
})().then(() => done()).catch((e) => { process.stderr.write((e.stack || String(e)) + '\n'); process.exit(1); });

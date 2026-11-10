'use strict';
// Actor can read titles and links through Network only with the signed-in person's task token; Network enforces opt-in.
const assert = require('assert');
const { createOpenVibeTools } = require('../server/agents/tools');
const runTokens = require('../server/triggers/tokens');

const taskId = 'history-fixture-task';
const requester = 'user:usr_01M4W5JBFEG3QG9ER8W1A2K0RX';
const config = { networkInternalUrl: 'http://network.test', services: { searchUrl: '', toolsUrl: '' } };

(async () => {
    const calls = [];
    let status = 200;
    const fetchImpl = async (url, init = {}) => {
        calls.push({ url, authorization: init.headers?.Authorization });
        return new Response(JSON.stringify(status === 200 ? { items: [{ title: 'A watched stream' }] } : { error: 'not_allowed' }), { status, headers: { 'content-type': 'application/json' } });
    };
    const tools = createOpenVibeTools({ config, fetchImpl });
    assert.ok(!(await tools.definitions({ requester, taskId })).some((d) => d.function.name === 'read_my_history'), 'no user token means no history tool');
    runTokens.put(taskId, { token: 'fixture-user-token' });
    try {
        assert.ok((await tools.definitions({ requester, taskId })).some((d) => d.function.name === 'read_my_history'));
        const result = JSON.parse(await tools.call('read_my_history', { limit: 7 }, { requester, taskId }));
        assert.strictEqual(result.items[0].title, 'A watched stream');
        assert.strictEqual(calls[0].url, 'http://network.test/api/v1/history/agents/recent?limit=7');
        assert.strictEqual(calls[0].authorization, 'Bearer fixture-user-token');
        status = 403;
        const denied = JSON.parse(await tools.call('read_my_history', {}, { requester, taskId }));
        assert.strictEqual(denied.error, 'not_allowed', 'Network opt-in refusal is preserved');
        assert.strictEqual(calls.length, 2);
    } finally { runTokens.drop(taskId); }
    console.log('Actor history tool: all checks passed');
})().catch((err) => { console.error(err); process.exitCode = 1; });

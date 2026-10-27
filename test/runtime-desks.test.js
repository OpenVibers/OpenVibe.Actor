'use strict';
// The runtime's desks (Desks plan D1): one desk run per task, handed to every tool call, and closed when the run ends,
// whether it answered or failed, so a task never leaves a desk running on the person's machine.
const assert = require('assert');
const { startProviders } = require('./helpers/providers');
const { createAdapters } = require('../server/agents/adapters');
const { RATES } = require('../server/agents/catalog');
const configLib = require('../server/config');
const { check, done } = require('./helpers/boot');

(async () => {
    const p = await startProviders();
    const config = configLib.load({ ...p.env, NODE_ENV: 'test', OV_NETWORK_URL: 'http://network.test', OV_OAUTH_CLIENT_ID: 'actor', OV_OAUTH_CLIENT_SECRET: 'actor-secret' });
    const seen = { calls: [], closed: [] };
    const run = { name: 'desk-0123456789', used: new Set(['dev_x']) };
    const tools = {
        definitions: async () => [{ type: 'function', function: { name: 'run_tool', description: 'x', parameters: { type: 'object', properties: {} } } }],
        call: async (name, args, opts) => { seen.calls.push(opts.desks); return JSON.stringify({ ok: true }); },
        deskRun: () => run,
        closeDesks: async (r, requester) => { seen.closed.push([r, requester]); },
    };
    const adapters = createAdapters({ config, rates: RATES, tools });
    const ctx = (requester) => ({ task: 'look something up', requester, signal: new AbortController().signal, emit: async () => {}, meter: async () => {}, budgetLeft: () => 1 });

    await check('every tool call gets the run\'s desks, and the run closes them when it answers', async () => {
        p.state.runtime = 'tool';
        const out = await adapters.run['openvibe-runtime'](ctx('user:usr_01M4W5JBFEG3QG9ER8W1A2K0RX'));
        assert.ok(out.text);
        assert.ok(seen.calls.length >= 1 && seen.calls.every((d) => d === run), 'the same desk run on every call');
        assert.deepStrictEqual(seen.closed, [[run, 'user:usr_01M4W5JBFEG3QG9ER8W1A2K0RX']]);
    });

    await check('and when it fails', async () => {
        seen.closed.length = 0;
        p.state.runtime = 'fail';
        await assert.rejects(() => adapters.run['openvibe-runtime'](ctx('user:usr_01M4W5JBFEG3QG9ER8W1A2K0RX')));
        assert.strictEqual(seen.closed.length, 1, 'closed even though the model failed');
    });

    await p.close();
    done();
})();

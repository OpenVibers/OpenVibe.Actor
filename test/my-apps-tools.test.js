'use strict';
/**
 * my_apps_search and my_apps_run (server/runtime/tools/_connect.js): the person's own OpenVibe apps through Connect.
 *
 * - Actor asks Network for a token naming the person (client_credentials, audience openvibe.network, scope
 *   network.connect.act, on_behalf_of) and keeps it a few minutes per person; it goes to Connect's /mcp/all only;
 * - search and run are /mcp/all's search and execute, as the person; the answer is the tool's text and structure;
 * - a missing grant says where the person allows Actor (the Apps page); a person who never signed in to Actor is told so;
 * - person scope only (a task with no signed-in person is refused); search reads, run acts; the token is in no answer.
 */
const assert = require('assert');
const { createRegistry } = require('../server/runtime/tools');

const ME = 'usr_01M4W5JBFEG3QG9ER8W1A2K0RX';
const OTHER = 'usr_01M4W5JBFEG3QG9ER8W1A2K0RY';
const json = (v, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });

function fakeNetwork({ consent = true } = {}) {
    const calls = [];
    let minted = 0;
    const fetchImpl = async (url, opts = {}) => {
        const u = new URL(url);
        const headers = opts.headers || {};
        const call = { path: u.pathname, auth: headers.authorization || headers.Authorization || null, body: opts.body };
        calls.push(call);
        if (u.pathname === '/oauth/token') {
            const form = new URLSearchParams(String(opts.body));
            call.form = Object.fromEntries(form);
            if (!consent) return json({ error: 'consent_required', error_description: 'that person has not signed in to this service' }, 403);
            minted += 1;
            return json({ access_token: `tok-${form.get('on_behalf_of')}-${minted}`, token_type: 'Bearer', expires_in: 300 });
        }
        if (u.pathname === '/mcp/all') {
            const rpc = JSON.parse(String(opts.body));
            call.rpc = rpc;
            const { name, arguments: args } = rpc.params;
            if (name === 'search') return json({ jsonrpc: '2.0', id: rpc.id, result: { content: [{ type: 'text', text: 'finance_month(input: { month?: string }): Promise<any> [Runs as you in OpenVibe Finance]' }], isError: false } });
            if (/finance_goals/.test(args.code)) return json({ jsonrpc: '2.0', id: rpc.id, result: { content: [{ type: 'text', text: 'this key may only read in OpenVibe Finance, and finance.goals is not granted' }], isError: true } });
            return json({ jsonrpc: '2.0', id: rpc.id, result: { content: [{ type: 'text', text: '{"spent_cents":123400}' }], structuredContent: { spent_cents: 123400 }, isError: false } });
        }
        return json({ detail: 'no such route' }, 404);
    };
    return { fetchImpl, calls, minted: () => minted };
}

(async () => {
    const reg = createRegistry({ strict: true, log: { warn() {}, log() {} } });
    const search = reg.get('my_apps_search');
    const run = reg.get('my_apps_run');
    assert.ok(search && run, 'both tools are in the registry');
    assert.deepStrictEqual([search.scope, run.scope], ['person', 'person'], 'they act for a signed-in person only');
    assert.strictEqual(search.acts, undefined, 'search reads');
    assert.strictEqual(run.acts, true, 'run may change something (with a write grant), so it acts');

    const config = { networkInternalUrl: 'http://network.test', oauth: { clientId: 'actor', clientSecret: 'actor-secret' }, services: {} };
    const net = fakeNetwork();
    const ctx = (requester = `user:${ME}`) => ({ config, fetch: net.fetchImpl, requester, log: console });

    let out = await search.run({ query: 'my spending this month' }, ctx());
    assert.ok(!out.isError, out.text);
    assert.match(out.text, /finance_month/);
    const mint = net.calls.find((c) => c.path === '/oauth/token');
    assert.deepStrictEqual(mint.form, { grant_type: 'client_credentials', client_id: 'actor', client_secret: 'actor-secret', audience: 'openvibe.network', scope: 'network.connect.act', on_behalf_of: ME },
        'a token naming the person, for Connect alone');
    const first = net.calls.find((c) => c.path === '/mcp/all');
    assert.strictEqual(first.auth, `Bearer tok-${ME}-1`);
    assert.deepStrictEqual(first.rpc.params, { name: 'search', arguments: { query: 'my spending this month', limit: 12 } });

    out = await run.run({ code: 'const m = await tools.finance_month({}); return { spent_cents: m.spent_cents };' }, ctx());
    assert.ok(!out.isError, out.text);
    assert.deepStrictEqual(out.data, { spent_cents: 123400 });
    assert.strictEqual(net.calls.filter((c) => c.path === '/mcp/all').pop().rpc.params.name, 'execute');
    assert.strictEqual(net.minted(), 1, 'the token is kept for the next call');
    assert.ok(!JSON.stringify(out).includes('tok-'), 'the token is in no answer');

    out = await run.run({ code: 'return await tools.finance_goals({});' }, ctx());
    assert.strictEqual(out.isError, true);
    assert.match(out.text, /may only read in OpenVibe Finance.*Apps page: https:\/\/openvibe\.network\/apps/, 'a missing grant says where to allow it');

    await search.run({ query: 'x' }, ctx(`user:${OTHER}`));
    assert.strictEqual(net.calls.filter((c) => c.path === '/oauth/token').pop().form.on_behalf_of, OTHER, 'each person has their own token');
    assert.strictEqual(net.minted(), 2);

    out = await search.run({ query: 'x' }, ctx('agent:agt_x'));
    assert.strictEqual(out.isError, true, 'no signed-in person, nothing');
    out = await run.run({ code: '' }, ctx());
    assert.strictEqual(out.isError, true);

    const refused = fakeNetwork({ consent: false });
    const config2 = { ...config };
    out = await search.run({ query: 'x' }, { config: config2, fetch: refused.fetchImpl, requester: `user:${ME}`, log: console });
    assert.match(out.text, /not signed in to Actor/, 'a person who never signed in to Actor is told so');
    assert.ok(!refused.calls.some((c) => c.path === '/mcp/all'), 'and Connect is never called');

    const noSecret = { networkInternalUrl: 'http://network.test', oauth: { clientId: 'actor' }, services: {} };
    out = await search.run({ query: 'x' }, { config: noSecret, fetch: net.fetchImpl, requester: `user:${ME}`, log: console });
    assert.match(out.text, /no Network client secret/);

    console.log('my-apps tools: a token naming the person for Connect alone, kept per person; search and run; grants and consent said plainly');
})().catch((err) => { console.error(err); process.exit(1); });

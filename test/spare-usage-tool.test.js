'use strict';
// spare_usage (plan §AD.37): Actor reads and changes the person's spare-usage list on OpenVibe.Codes with its own service
// token for that person (X-OV-Subject): show, add, turn on/off; a model sees each agent's time left and the list.
const assert = require('assert');
const tool = require('../server/runtime/tools/spare_usage');

(async () => {
    const calls = [];
    let state = { settings: { enabled: false, reset_within_hours: 12, min_left_pct: 15 }, tasks: [], agents: [{ agent: 'codex', name: 'Codex', windows: [{ name: 'week', used_pct: 30, resets_at: '2026-11-25T07:00:00Z' }], take: false, why: 'its next reset is in 80 h' }] };
    const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    const fetch = async (url, init = {}) => {
        const u = new URL(url);
        if (u.pathname === '/oauth/token') return json(200, { access_token: 'svc-token', token_type: 'Bearer', expires_in: 300 });
        calls.push({ method: init.method || 'GET', path: u.pathname, subject: init.headers['X-OV-Subject'], auth: init.headers.Authorization || init.headers.authorization, body: init.body ? JSON.parse(init.body) : null });
        if (u.pathname === '/api/v1/me/spare' && (init.method || 'GET') === 'GET') return json(200, state);
        if (u.pathname === '/api/v1/me/spare' && init.method === 'PUT') { state.settings.enabled = JSON.parse(init.body).enabled; return json(200, { settings: state.settings }); }
        if (u.pathname === '/api/v1/me/spare/tasks' && init.method === 'POST') { const b = JSON.parse(init.body); state.tasks.push({ id: 'spt_01J8Z3Q4R5S6T7V8W9X0Y1Z2A3', title: b.title || b.prompt || `${b.loop} loop`, state: 'queued', agent: b.agent || 'any', priority: b.priority || 3, repeat: !!b.repeat, runs: 0 }); return json(201, { task: state.tasks[0] }); }
        return json(404, { detail: 'no' });
    };
    const ctx = {
        config: { services: { codesUrl: 'http://codes.test' }, networkInternalUrl: 'http://network.test', oauth: { clientId: 'actor', clientSecret: 's' } },
        fetch, requester: 'user:usr_01J8Z3Q4R5S6T7V8W9X0Y1Z2AB', agentId: 'agt_x',
    };
    assert.ok(tool.available(ctx));
    const shown = JSON.parse((await tool.run({}, ctx)).text);
    assert.strictEqual(shown.on, false);
    assert.deepStrictEqual(shown.agents[0].windows, [{ name: 'week', left_pct: 70, resets_at: '2026-11-25T07:00:00Z' }]);
    assert.strictEqual(calls[0].subject, 'usr_01J8Z3Q4R5S6T7V8W9X0Y1Z2AB', 'for the person, named in X-OV-Subject');
    assert.match(String(calls[0].auth), /^Bearer svc-token$/);
    const added = JSON.parse((await tool.run({ action: 'add', prompt: 'Add tests for fleet.js', repo: 'OpenVibers/OpenVibe.Codes', priority: 2 }, ctx)).text);
    assert.strictEqual(added.list[0].title, 'Add tests for fleet.js');
    assert.deepStrictEqual(calls.find((c) => c.method === 'POST').body, { prompt: 'Add tests for fleet.js', repo: 'OpenVibers/OpenVibe.Codes', priority: 2 });
    assert.strictEqual(JSON.parse((await tool.run({ action: 'turn_on' }, ctx)).text).on, true);
    await tool.run({ action: 'add', loop: 'security', repo: 'OpenVibers/OpenVibe.Live', site: 'https://openvibe.live' }, ctx);
    assert.deepStrictEqual(calls.filter((c) => c.method === 'POST').pop().body, { loop: 'security', repo: 'OpenVibers/OpenVibe.Live', site: 'https://openvibe.live' }, 'a loop goes as a loop');
    const bad = await tool.run({ action: 'add', prompt: 'x' }, ctx);
    assert.ok(bad.isError && /repo/.test(bad.text));
    assert.ok(!tool.available({ ...ctx, requester: 'service:x' }), 'only for a person');
    console.log('spare-usage-tool: 5 checks passed');
})().catch((e) => { console.error(e); process.exit(1); });

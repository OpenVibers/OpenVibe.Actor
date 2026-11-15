'use strict';
// The runtime's parallel tools (11-15, the owner: the agent "should be able to do shit in parallel eg search multiple
// specific sites or runs tools"): run_tools runs up to 8 OpenVibe.Tools calls at once with run_tool's own rules, each
// answered under its call; search_sites asks one question of up to 6 named sites at once (site: per site, the web
// scope as the person), each site's results under its name. Both really overlap.
const assert = require('assert');
const { check, done } = require('./helpers/boot');
const { createOpenVibeTools } = require('../server/agents/tools');

const config = {
    networkInternalUrl: 'http://network.test', oauth: { clientId: 'actor', clientSecret: 'actor-secret' },
    services: { searchUrl: 'http://search.test', toolsUrl: 'http://tools.test', botUrl: '', botPublicUrl: 'https://openvibe.bot' },
};
const tokens = { authHeaders: async () => ({ Authorization: 'Bearer svc-token' }) };
const ME = 'usr_01M4W5JBFEG3QG9ER8W1A2K0RX';

function fake() {
    const calls = [];
    let inFlight = 0;
    let most = 0;
    const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    const fetchImpl = async (url, init = {}) => {
        const u = new URL(url);
        const body = init.body ? JSON.parse(init.body) : null;
        calls.push({ host: u.host, path: u.pathname, body, subject: (init.headers || {})['x-ov-subject'] || null });
        inFlight++; most = Math.max(most, inFlight);
        await new Promise((r) => setTimeout(r, 40));
        inFlight--;
        if (u.host === 'tools.test' && u.pathname === '/api/v1/tools') return reply(200, { tools: [{ id: 'dns', api: true, execution: 'sync', auth: { anonymous: true } }, { id: 'hash', api: true, execution: 'sync', auth: { anonymous: true } }] });
        if (u.host === 'tools.test' && /\/run$/.test(u.pathname)) {
            const id = u.pathname.split('/')[4];
            return reply(200, { state: 'succeeded', tool: id, result: { data: { answered: id, input: body.input } } });
        }
        if (u.pathname === '/api/v1/query') {
            const site = /site:(\S+)/.exec(body.q)[1];
            return reply(200, { results: [{ title: `On ${site}`, snippet: 's', url: `https://${site}/a`, site }], route: { explain: [] } });
        }
        return reply(404, {});
    };
    return { calls, fetchImpl, most: () => most };
}

(async () => {
    await check('run_tools: several tools at once, each answer under its call, run_tool\'s own rules', async () => {
        const f = fake();
        const t = createOpenVibeTools({ config, fetchImpl: f.fetchImpl, searchTokens: tokens });
        const names = (await t.definitions({ requester: `user:${ME}` })).map((d) => d.function.name);
        assert.ok(names.includes('run_tools') && names.includes('search_sites'), names.join(','));
        const out = JSON.parse(await t.call('run_tools', { calls: [{ tool: 'dns', input: { name: 'openvibe.live' } }, { tool: 'hash', input: { text: 'x' } }, { tool: 'nope', input: {} }] }, { requester: `user:${ME}` }));
        assert.deepStrictEqual(out.results.map((r) => r.tool), ['dns', 'hash', 'nope']);
        assert.deepStrictEqual(out.results[0].result, { data: { answered: 'dns', input: { name: 'openvibe.live' } } });
        assert.match(out.results[2].result.error, /no callable tool "nope"/, 'a tool the catalog does not offer is refused, as in run_tool');
        assert.ok(f.most() >= 2, `the runs overlapped (${f.most()} at once)`);
        const many = JSON.parse(await t.call('run_tools', { calls: Array.from({ length: 10 }, () => ({ tool: 'hash', input: {} })) }, { requester: `user:${ME}` }));
        assert.strictEqual(many.results.length, 8);
        assert.match(many.note, /first 8 of 10/);
        assert.match(JSON.parse(await t.call('run_tools', { calls: [] }, {})).error, /at most 8/);
    });

    await check('search_sites: one question of several sites at once, each under its name, asked as the person', async () => {
        const f = fake();
        const t = createOpenVibeTools({ config, fetchImpl: f.fetchImpl, searchTokens: tokens });
        const out = JSON.parse(await t.call('search_sites', { query: 'best standing desk', sites: ['https://Reddit.com/r/desks', 'github.com', 'github.com', 'not a site', 'wirecutter.com'] }, { requester: `user:${ME}` }));
        assert.deepStrictEqual(Object.keys(out.sites), ['reddit.com', 'github.com', 'wirecutter.com'], 'names cleaned, repeats and junk dropped');
        assert.strictEqual(out.sites['reddit.com'].results[0].title, 'On reddit.com');
        const asked = f.calls.filter((c) => c.path === '/api/v1/query');
        assert.deepStrictEqual(asked.map((c) => c.body.q).sort(), ['best standing desk site:github.com', 'best standing desk site:reddit.com', 'best standing desk site:wirecutter.com']);
        assert.ok(asked.every((c) => c.subject === ME), 'as the person');
        assert.ok(f.most() >= 2, 'the sites were asked at the same time');
        assert.match(JSON.parse(await t.call('search_sites', { query: 'x', sites: [] }, {})).error, /site names/);
    });

    done();
})().catch((e) => { console.error(e); process.exit(1); });

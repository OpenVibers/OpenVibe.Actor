'use strict';
// Actor on the Search Fabric (plan 2026-10-28 §4.5): search_openvibe asks GET /api/v1/query for the network scope and
// falls back to /api/v1/search on a Search without it; search_web asks POST /api/v1/query for the web scope with Actor's
// service token and the task's person as X-OV-Subject, returns cited results and the step that found them, and is
// offered only when Actor can get a token.
const assert = require('assert');
const { createOpenVibeTools } = require('../server/agents/tools');
const { check, done } = require('./helpers/boot');

const ME = 'usr_01M4W5JBFEG3QG9ER8W1A2K0RX';
const config = {
    networkInternalUrl: 'http://network.test', oauth: { clientId: 'actor', clientSecret: 'actor-secret' },
    services: { searchUrl: 'http://search.test', toolsUrl: 'http://tools.test', botUrl: '', botPublicUrl: 'https://openvibe.bot' },
};
const tokens = { authHeaders: async () => ({ Authorization: 'Bearer svc-token' }) };

function fakeSearch({ fabric = true } = {}) {
    const calls = [];
    const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    const fetchImpl = async (url, init = {}) => {
        const u = new URL(url);
        const headers = init.headers || {};
        calls.push({ method: init.method || 'GET', path: u.pathname, query: Object.fromEntries(u.searchParams), auth: headers.Authorization || null, subject: headers['x-ov-subject'] || null, body: init.body ? JSON.parse(init.body) : null });
        if (u.host === 'tools.test') return reply(200, { tools: [] });
        if (u.pathname === '/api/v1/query' && !fabric) return reply(404, { code: 'not_found' });
        if (u.pathname === '/api/v1/query' && (init.method || 'GET') === 'GET') {
            return reply(200, { results: [{ scope: 'network', kind: 'document', title: 'Night owls recap', snippet: 'what happened', url: 'https://openvibe.live/@goosely', type: 'stream', owner: 'live', published_at: '2026-10-27T10:00:00Z' }], route: { explain: [] } });
        }
        if (u.pathname === '/api/v1/query') {
            return reply(200, {
                results: [{ scope: 'web', kind: 'document', title: 'RFC 5545', snippet: 'iCalendar', url: 'https://www.rfc-editor.org/rfc/rfc5545', site: 'www.rfc-editor.org', published_at: null }],
                route: { explain: [{ scope: 'web', step: 'open_index', answered: false }, { scope: 'web', step: 'wikipedia', answered: true }] },
            });
        }
        if (u.pathname === '/api/v1/search') return reply(200, { results: [{ title: 'Old', summary: 's', canonical_url: 'https://openvibe.community/p/1', type: 'post', owner: 'community' }] });
        return reply(404, {});
    };
    return { calls, fetchImpl };
}

(async () => {
    await check('search_openvibe asks the fabric\'s network scope, anonymously', async () => {
        const s = fakeSearch();
        const t = createOpenVibeTools({ config, fetchImpl: s.fetchImpl, searchTokens: tokens });
        const out = JSON.parse(await t.call('search_openvibe', { query: 'night owls' }));
        assert.deepStrictEqual(out, [{ title: 'Night owls recap', summary: 'what happened', url: 'https://openvibe.live/@goosely', type: 'stream', from: 'live', published_at: '2026-10-27T10:00:00Z' }]);
        const q = s.calls.find((c) => c.path === '/api/v1/query');
        assert.deepStrictEqual([q.method, q.query.scopes, q.query.limit, q.auth], ['GET', 'network', '8', null]);
    });

    await check('an older Search without the fabric: the old search answers', async () => {
        const s = fakeSearch({ fabric: false });
        const t = createOpenVibeTools({ config, fetchImpl: s.fetchImpl, searchTokens: tokens });
        const out = JSON.parse(await t.call('search_openvibe', { query: 'x' }));
        assert.strictEqual(out[0].url, 'https://openvibe.community/p/1');
    });

    await check('search_web: Actor\'s token, the person as X-OV-Subject, cited results and the step that found them', async () => {
        const s = fakeSearch();
        const t = createOpenVibeTools({ config, fetchImpl: s.fetchImpl, searchTokens: tokens });
        const names = (await t.definitions({ requester: `user:${ME}` })).map((d) => d.function.name);
        assert.ok(names.includes('search_web'), 'offered when Actor can get a token');
        const out = JSON.parse(await t.call('search_web', { query: 'icalendar spec' }, { requester: `user:${ME}` }));
        assert.deepStrictEqual(out, { results: [{ title: 'RFC 5545', summary: 'iCalendar', url: 'https://www.rfc-editor.org/rfc/rfc5545', site: 'www.rfc-editor.org', published_at: null }], found_by: 'wikipedia' });
        const q = s.calls.find((c) => c.path === '/api/v1/query' && c.method === 'POST');
        assert.deepStrictEqual([q.auth, q.subject, q.body.scopes, q.body.limit], ['Bearer svc-token', ME, ['web'], 6]);
    });

    await check('search_web for a task with no signed-in person: no subject header', async () => {
        const s = fakeSearch();
        const t = createOpenVibeTools({ config, fetchImpl: s.fetchImpl, searchTokens: tokens });
        await t.call('search_web', { query: 'x' }, { requester: 'app:app_1' });
        assert.strictEqual(s.calls.find((c) => c.method === 'POST').subject, null);
    });

    await check('without a client secret, search_web is not offered and says so if called', async () => {
        const s = fakeSearch();
        const t = createOpenVibeTools({ config: { ...config, oauth: { clientId: 'actor', clientSecret: '' } }, fetchImpl: s.fetchImpl });
        const names = (await t.definitions({})).map((d) => d.function.name);
        assert.ok(!names.includes('search_web'));
        assert.match(JSON.parse(await t.call('search_web', { query: 'x' })).error, /not connected/);
    });

    done();
})();

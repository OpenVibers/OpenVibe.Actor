'use strict';
// The tools people make, in Actor's agents (plan 2026-11-13 §AD.12 (b); Contracts 0.437.0 tools.made.run): find_tools
// offers the person's own made tools and the public ones next to the catalogue, and run_tool runs an mtl_ id as the
// person the task is for (Actor's service token, X-OV-Subject), so their allowance pays. A task with no signed-in person
// cannot run one, and the catalogue still answers when the made tools do not.
const assert = require('assert');
const { check, done } = require('./helpers/boot');
const { createOpenVibeTools } = require('../server/agents/tools');

const ME = 'usr_01M4W5JBFEG3QG9ER8W1A2K0RX';
const MINE = 'mtl_01JCZ3NDEKTSV4RRFFQ69G5FA1';
const PUB = 'mtl_01JCZ3NDEKTSV4RRFFQ69G5FA2';
const config = {
    networkInternalUrl: 'http://network.test', oauth: { clientId: 'actor', clientSecret: 'actor-secret' },
    services: { searchUrl: '', toolsUrl: 'http://tools.test', botUrl: '', botPublicUrl: 'https://openvibe.bot' },
};
const madeTokens = { authHeaders: async () => ({ Authorization: 'Bearer svc-actor' }) };
const makeTokens = { authHeaders: async () => ({ Authorization: 'Bearer svc-actor-make' }) };

function fake({ madeDown = false } = {}) {
    const calls = [];
    const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    const fetchImpl = async (url, init = {}) => {
        const u = new URL(url);
        const h = init.headers || {};
        calls.push({ path: u.pathname + u.search, auth: h.Authorization || null, subject: h['X-OV-Subject'] || null, body: init.body ? JSON.parse(init.body) : null });
        if (u.pathname === '/api/v1/tools') return reply(200, { tools: [{ id: 'dns', name: 'DNS lookup', summary: 'DNS records of a domain', api: true, execution: 'sync', auth: { anonymous: true } }] });
        if (u.pathname === '/api/v1/tools/dns/schema') return reply(200, { $defs: { input: { type: 'object' } } });
        if (u.pathname === '/api/v1/made-tools' && init.method === 'POST') {
            const b = JSON.parse(init.body);
            if (b.slug === 'meeting-notes') return reply(409, { title: 'You already have a tool called meeting-notes' });
            return reply(201, { id: 'mtl_01JCZ3NDEKTSV4RRFFQ69G5FA9', slug: b.slug, name: b.name, summary: b.summary, kind: b.kind, visibility: b.visibility, input: b.input });
        }
        if (u.pathname === '/api/v1/made-tools' && madeDown) return reply(503, {});
        if (u.pathname === '/api/v1/made-tools' && u.searchParams.get('mine') === '1') {
            return h['X-OV-Subject'] === ME ? reply(200, { tools: [{ id: MINE, slug: 'meeting-notes', name: 'Meeting notes', summary: 'Turns meeting notes into decisions and actions', input: { type: 'object' } }] }) : reply(401, {});
        }
        if (u.pathname === '/api/v1/made-tools') return reply(200, { tools: [{ id: PUB, slug: 'email-summary', name: 'Email summary', summary: 'Summarizes an email', input: { type: 'object' } }] });
        if (u.pathname === `/api/v1/made-tools/${MINE}/run`) return reply(200, { state: 'succeeded', tool: MINE, result: { data: { decisions: ['ship it'] } } });
        if (u.pathname === `/api/v1/made-tools/${PUB}/run`) return reply(200, { state: 'failed', tool: PUB, error: { detail: 'The model did not answer with a JSON object' } });
        if (u.pathname === '/api/v1/made-tools/draft') return reply(200, { draft: { name: 'Price with tax' }, body: { slug: 'meeting-notes', name: 'Price with tax', summary: 'Adds tax.', kind: 'code', input: { type: 'object', properties: { price: { type: 'number' } } }, output: { kind: 'text' }, source_code: 'function run(input) { return String(input.price * 1.1); }', visibility: 'private' } });
        return reply(404, {});
    };
    return { calls, fetchImpl };
}

(async () => {
    await check('find_tools: the catalogue, then the person\'s own made tools and the public ones', async () => {
        const f = fake();
        const t = createOpenVibeTools({ config, fetchImpl: f.fetchImpl, madeTokens });
        const found = JSON.parse(await t.call('find_tools', { need: 'meeting notes decisions' }, { requester: `user:${ME}` }));
        const mine = found.find((x) => x.tool === MINE);
        assert.ok(mine && mine.made && mine.yours, `the person's own tool (${JSON.stringify(found)})`);
        assert.ok(found.some((x) => x.tool === PUB && x.made && !x.yours), 'a public one');
        const asked = f.calls.find((c) => c.path === '/api/v1/made-tools?mine=1');
        assert.deepStrictEqual([asked.auth, asked.subject], ['Bearer svc-actor', ME], 'asked as Actor, for the person');
        const def = (await t.definitions({ requester: `user:${ME}` })).find((d) => d.function.name === 'find_tools');
        assert.match(def.function.description, /tools people made/);
    });

    await check('run_tool: a made tool runs as the person; a failed one says why; no person, no run', async () => {
        const f = fake();
        const t = createOpenVibeTools({ config, fetchImpl: f.fetchImpl, madeTokens });
        const out = JSON.parse(await t.call('run_tool', { tool: MINE, input: { note: 'we ship friday' } }, { requester: `user:${ME}` }));
        assert.deepStrictEqual(out, { data: { decisions: ['ship it'] } });
        const ran = f.calls.find((c) => c.path === `/api/v1/made-tools/${MINE}/run`);
        assert.deepStrictEqual([ran.auth, ran.subject, ran.body.input.note], ['Bearer svc-actor', ME, 'we ship friday'], 'paid by the person this task is for');
        assert.match(JSON.parse(await t.call('run_tool', { tool: PUB, input: {} }, { requester: `user:${ME}` })).error, /did not answer with a JSON object/);
        assert.match(JSON.parse(await t.call('run_tool', { tool: MINE, input: {} }, { requester: null })).error, /signed-in person/, 'a task with nobody to pay');
        const both = JSON.parse(await t.call('run_tools', { calls: [{ tool: 'dns', input: {} }, { tool: MINE, input: {} }] }, { requester: `user:${ME}` }));
        assert.deepStrictEqual(both.results.map((r) => r.tool), ['dns', MINE], 'made tools run in parallel with the catalogue');
    });

    await check('make_tool: Tools drafts and saves a private tool for the person, as them', async () => {
        const f = fake();
        const t = createOpenVibeTools({ config, fetchImpl: f.fetchImpl, madeTokens, makeTokens });
        const defs = await t.definitions({ requester: `user:${ME}` });
        assert.ok(defs.some((d) => d.function.name === 'make_tool'), 'offered for a signed-in person');
        assert.ok(!(await t.definitions({ requester: null })).some((d) => d.function.name === 'make_tool'), 'never for a task with nobody');
        const made = JSON.parse(await t.call('make_tool', { description: 'Add sales tax to a price', kind: 'code' }, { requester: `user:${ME}` }));
        assert.deepStrictEqual([made.made.tool, made.made.kind, made.page], ['mtl_01JCZ3NDEKTSV4RRFFQ69G5FA9', 'code', 'https://openvibe.tools/make#mtl_01JCZ3NDEKTSV4RRFFQ69G5FA9']);
        const writes = f.calls.filter((c) => c.path.startsWith('/api/v1/made-tools') && c.body);
        assert.deepStrictEqual(writes.map((c) => [c.path, c.auth, c.subject]), [
            ['/api/v1/made-tools/draft', 'Bearer svc-actor-make', ME], ['/api/v1/made-tools', 'Bearer svc-actor-make', ME], ['/api/v1/made-tools', 'Bearer svc-actor-make', ME],
        ], 'drafted, then saved twice (the slug was taken), with the make token, as the person');
        assert.deepStrictEqual([writes[0].body.kind, writes[2].body.visibility], ['code', 'private']);
        assert.match(writes[2].body.slug, /^meeting-notes-[a-z0-9]{1,4}$/);
        assert.match(JSON.parse(await t.call('make_tool', { description: 'Add sales tax to a price' }, { requester: null })).error, /signed-in person/);
        assert.match(JSON.parse(await t.call('make_tool', { description: 'tax' }, { requester: `user:${ME}` })).error, /sentence or two/);
    });

    await check('the catalogue still answers when the made tools do not', async () => {
        const f = fake({ madeDown: true });
        const t = createOpenVibeTools({ config, fetchImpl: f.fetchImpl, madeTokens });
        const found = JSON.parse(await t.call('find_tools', { need: 'dns records' }, { requester: `user:${ME}` }));
        assert.ok(found.some((x) => x.tool === 'dns'));
    });
    await done();
})();

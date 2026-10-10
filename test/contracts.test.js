'use strict';
/**
 * The released contracts (the pinned openvibe-contracts tag, 0.115.0 or later) describe what Actor does. The
 * released `actor` service manifest and its five capability manifests are checked against the code: the domain,
 * port, health and ready paths, the capabilities (routes in server/http/api.js and server/registry/resource-index.js, each
 * route guarded by the one capability it names), no events but the account ones (ADR-033), and the shapes Actor answers with (the contracts'
 * actor.agent-list-result@1, platform.placement-result@1 and platform.task@1).
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const contracts = require('openvibe-contracts');
const configLib = require('../server/config');
const { boot, check, done } = require('./helpers/boot');

const CAPS = ['actor.task.create', 'actor.task.read', 'actor.task.list', 'actor.agent.read', 'actor.resource.read'];
const INDEX_ROUTES = ['GET /api/v1/resources', 'GET /api/v1/resources/:ovrn'];
const API_SRC = fs.readFileSync(path.join(__dirname, '..', 'server', 'http', 'api.js'), 'utf8');
const INDEX_SRC = fs.readFileSync(path.join(__dirname, '..', 'server', 'registry', 'resource-index.js'), 'utf8');

/** `METHOD /api/v1/path` for every API and resource index route, with its capability guard (null: public). */
function codeRoutes() {
    const out = new Map();
    for (const [source, prefix] of [[API_SRC, '/api/v1'], [INDEX_SRC, '/api/v1/resources']]) {
        for (const m of source.matchAll(/^\s*r\.(get|post)\('([^']+)'(.*)$/gm)) {
            const guard = m[3].match(/requireCapability\('([a-z.]+)'\)/);
            const read = m[3].match(/limits\.reads\('([a-z.]+)'\)/);
            out.set(`${m[1].toUpperCase()} ${prefix}${m[2] === '/' ? '' : m[2]}`, { guard: guard ? guard[1] : null, limit: read ? read[1] : null });
        }
    }
    return out;
}

(async () => {
    const manifest = contracts.services.get('actor');
    const routes = codeRoutes();

    await check('the actor service manifest is released as alpha, live, on openvibe.actor, with the contract range this pin satisfies', () => {
        assert.ok(manifest, 'no actor manifest in openvibe-contracts');
        assert.strictEqual(manifest.status, 'alpha');
        assert.deepStrictEqual(manifest.domains, ['openvibe.actor']);
        assert.strictEqual(manifest.publicOrigin, 'https://openvibe.actor');
        assert.strictEqual(manifest.exposure.state, 'live');
        assert.deepStrictEqual(manifest.namespacesOwned, ['actor.*']);
        const range = manifest.contractRanges['openvibe-contracts'];
        assert.ok(require('openvibe-sdk/core').satisfiesRange(require('openvibe-contracts/package.json').version, range), `pin ${require('openvibe-contracts/package.json').version} outside ${range}`);
        assert.strictEqual(manifest.site.icon, 'actor');
    });

    await check('port, internal origin, health and ready paths are the ones the code serves', async () => {
        const config = configLib.load({ NODE_ENV: 'test' });
        assert.strictEqual(config.port, 4950);
        assert.strictEqual(manifest.internalOrigin, `http://127.0.0.1:${config.port}`);
        assert.strictEqual(manifest.health, '/api/health');
        assert.strictEqual(manifest.ready, '/api/ready');
        assert.ok(/openvibe-actor\.service/.test(manifest.notes) && /Port 4950/.test(manifest.notes), 'the notes name the unit and the port');
        const t = await boot();
        try {
            assert.strictEqual((await t.get(manifest.health)).status, 200);
            assert.strictEqual((await t.get(manifest.ready)).status, 200);
            const rel = (await t.get('/release.json')).json();
            assert.strictEqual(rel.service, 'actor');
            assert.deepStrictEqual(contracts.validate('registry.release-manifest@1', rel).errors, []);
        } finally { await t.close(); }
    });

    await check('the manifest lists five capabilities, owned by actor, and the code guards all five', () => {
        assert.deepStrictEqual([...manifest.capabilities].sort(), [...CAPS].sort());
        for (const id of CAPS) {
            const c = contracts.capabilities.get(id);
            assert.ok(c, `${id} not released`);
            // actor.resource.read was planned in contracts 0.129.0 and is active from 0.130.0.
            if (id === 'actor.resource.read') assert.ok(['planned', 'active'].includes(c.status), id);
            else assert.strictEqual(c.status, 'active', id);
            assert.strictEqual(c.owner, 'actor', id);
        }
        const principalSrc = fs.readFileSync(path.join(__dirname, '..', 'server', 'http', 'principal.js'), 'utf8');
        const listed = principalSrc.match(/const CAPABILITIES = \[([^\]]+)\]/)[1].match(/'([a-z.]+)'/g).map((s) => s.slice(1, -1));
        assert.deepStrictEqual([...listed].sort(), [...CAPS].sort(), 'principal.js accepts exactly Actor\'s capabilities');
        const appSrc = fs.readFileSync(path.join(__dirname, '..', 'server', 'app.js'), 'utf8');
        assert.match(appSrc, /app\.use\('\/api\/v1\/resources', resourceIndex\.router\(ctx\)\)/);
    });

    await check('every capability is implemented by routes that exist, and every route is some capability\'s', () => {
        const declared = new Set();
        for (const id of CAPS) {
            const impl = contracts.capabilities.get(id).implementedBy;
            // A planned resource capability lists no routes; an active one lists exactly the index's two.
            const expected = id === 'actor.resource.read' ? INDEX_ROUTES : impl;
            if (id === 'actor.resource.read') assert.ok(impl.length === 0 || JSON.stringify([...impl].sort()) === JSON.stringify(INDEX_ROUTES), `${id} implementedBy: ${impl}`);
            else assert.ok(impl && impl.length > 0, `${id} implementedBy is empty`);
            for (const r of expected) {
                declared.add(r);
                assert.ok(routes.has(r), `${id} says ${r}, but the code registers no such route`);
            }
        }
        for (const r of routes.keys()) assert.ok(declared.has(r), `the code registers ${r}, which no capability lists`);
    });

    await check('each guarded route requires the capability that lists it; the agent reads are public', () => {
        for (const id of CAPS) {
            const implemented = id === 'actor.resource.read' ? INDEX_ROUTES : contracts.capabilities.get(id).implementedBy;
            for (const r of implemented) {
                const route = routes.get(r);
                if (id === 'actor.agent.read') {
                    assert.strictEqual(route.guard, null, `${r} must stay public`);
                    assert.strictEqual(contracts.capabilities.get(id).visibility, 'public');
                } else {
                    assert.strictEqual(route.guard, id, `${r} is guarded by ${route.guard}, not ${id}`);
                }
            }
        }
    });

    await check('events: the manifest produces none and consumes only the two account events (ADR-033); the capabilities declare none', () => {
        assert.deepStrictEqual(manifest.eventsProduced, []);
        assert.deepStrictEqual([...manifest.eventsConsumed].sort(), ['network.account.deleted', 'network.account.export_requested']);
        for (const id of CAPS) assert.deepStrictEqual(contracts.capabilities.get(id).events, [], id);
    });

    await check('what the API answers is what the contracts describe: agents, placement and task', async () => {
        const t = await boot();
        try {
            const kim = t.network.addUser('kim');
            const agents = await t.get('/api/v1/agents');
            assert.strictEqual(agents.status, 200);
            assert.deepStrictEqual(contracts.validate('actor.agent-list-result@1', agents.json()).errors, []);
            const routed = await t.get('/api/v1/route', { json: { task: 'Write a short poem about the sea', mode: 'cheapest' } });
            assert.strictEqual(routed.status, 200, routed.text);
            const body = routed.json();
            const { class: _cls, ...placement } = body;
            assert.deepStrictEqual(contracts.validate('platform.placement-result@1', placement).errors, [], 'the dry run is a placement result (plus its class)');
            const req = { task: 'Write a short poem about the sea' };
            assert.deepStrictEqual(contracts.validate('actor.task-create-request@1', req).errors, []);
            const made = await t.get('/api/v1/tasks', { as: kim, json: req, headers: { 'sec-fetch-site': 'same-origin' } });
            assert.strictEqual(made.status, 201, made.text);
            assert.deepStrictEqual(contracts.validate('platform.task@1', made.json()).errors, []);
            await t.waitFor(made.json().id);
        } finally { await t.close(); }
    });

    done();
})().catch((e) => { console.error(e); process.exit(1); });

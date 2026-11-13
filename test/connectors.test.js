'use strict';
/**
 * The connectors (plan §Z.6): the groups of tools a person and the owner can switch off.
 *
 * - every tool module names its connector, or is one of the documented core tools;
 * - the manifest's defaults: reads and writes on; sends, spends and secrets (saved logins) off;
 * - the owner's switch beats the person's, and a connector the owner turned off is off for everyone;
 * - a person's own switch hides the tools of that connector and refuses to run them;
 * - the owner's daily cap counts the calls of one person per UTC day and refuses past it;
 * - both APIs keep their guard: a person may not change the owner's switches, and another person's rows are
 *   never read;
 * - both pages render: the person's Connectors section on their Settings page, and the owner's own page.
 */
const assert = require('assert');
const path = require('path');
const { boot, check, done } = require('./helpers/boot');
const connectors = require('../server/runtime/connectors');
const { createRegistry } = require('../server/runtime/tools');

const TOOLS_DIR = path.join(__dirname, '..', 'server', 'runtime', 'tools');
const note = (out) => String((out && out.text) || '');
// A write made with the session cookie must come from this site (the house rule).
const SAME_SITE = { 'sec-fetch-site': 'same-origin' };

(async () => {
    const t = await boot();
    const s = t.ctx.s;
    const registry = t.ctx.registry;

    await check('every tool module names a connector of the manifest, or is one of the documented core tools', async () => {
        const reg = createRegistry({ dir: TOOLS_DIR, strict: true, log: { warn() {} } });
        const core = reg.tools.filter((tool) => tool.connector == null).map((tool) => tool.name).sort();
        for (const tool of reg.tools) {
            assert.ok(tool.connector == null || connectors.isConnectorId(tool.connector),
                `${tool.name} names the connector "${tool.connector}", which is not in the manifest`);
        }
        assert.deepStrictEqual(core, [...connectors.CORE_TOOLS].sort());
        // Every connector of the manifest has at least one tool, except the three the next job fills in.
        const used = new Set(reg.tools.map((tool) => tool.connector).filter(Boolean));
        for (const id of ['openvibe', 'tools', 'computers', 'robots', 'codes', 'space', 'phone', 'schedules', 'money', 'logins']) {
            assert.ok(used.has(id), `no tool names the connector ${id}`);
        }
        // An unknown connector is a problem with the module, like a bad scope.
        const { validateTool } = require('../server/runtime/tools');
        const bad = validateTool({ name: 'x_tool', description: 'x', input: { type: 'object' }, scope: 'public', connector: 'nope', run: () => ({}) });
        assert.strictEqual(bad.length, 1, bad.join('; '));
        assert.match(bad[0], /connector/);
        assert.deepStrictEqual(validateTool({ name: 'x_tool', description: 'x', input: { type: 'object' }, scope: 'public', connector: 'files', run: () => ({}) }), []);
    });

    await check('the manifest is whole, and sends and spends are off until the person turns them on', async () => {
        const list = connectors.manifest();
        for (const c of list) {
            assert.deepStrictEqual(Object.keys(c).sort(), ['default', 'id', 'name', 'risk', 'service', 'what']);
            assert.ok(['reads', 'writes', 'sends', 'spends', 'secrets'].includes(c.risk), c.id);
            assert.strictEqual(typeof c.default, 'boolean');
            assert.ok(c.name && c.service && c.what, c.id);
        }
        const ids = list.map((c) => c.id);
        for (const id of ['files', 'email', 'shared_nodes']) assert.ok(ids.includes(id), id);
        for (const c of list) {
            if (c.risk === 'sends' || c.risk === 'spends' || c.risk === 'secrets') assert.strictEqual(c.default, false, c.id);
            else assert.strictEqual(c.default, true, c.id);
        }
        assert.strictEqual(list.find((c) => c.id === 'money').default, false);
        assert.strictEqual(list.find((c) => c.id === 'email').default, false);
        assert.strictEqual(list.find((c) => c.id === 'logins').default, false, 'saved logins wait for the person');
    });

    await check('a connector that is off is left out of the tools and refused when it is called', async () => {
        const reg = createRegistry({ dir: TOOLS_DIR, strict: true, log: { warn() {} } });
        const config = t.config;
        const requester = 'user:usr_01JAB2C3D4E5F6G7H8J9K0MNPT';
        const state = { off: new Set(['openvibe']), connectors: {}, take: async () => ({ ok: true, used: 0 }) };
        const names = reg.definitions({ config, requester, connectorSwitches: state }).map((d) => d.function.name);
        assert.ok(!names.includes('weather_now') && !names.includes('search_web'), 'the tools of an off connector are not offered');
        assert.ok(names.includes('calculate'), 'the core tools stay');
        const out = await reg.run('weather_now', { place: 'Berlin' }, { config, requester, connectorSwitches: state });
        assert.strictEqual(out.isError, true);
        assert.match(note(out), /is off for your agent/);
        assert.match(note(out), /Settings → Connectors/);
        // The same tool runs when the connector is on.
        const on = { off: new Set(), connectors: {}, take: async () => ({ ok: true, used: 0 }) };
        assert.ok(reg.definitions({ config, requester, connectorSwitches: on }).map((d) => d.function.name).includes('weather_now'));
    });

    await check('the daily cap refuses the call past the limit', async () => {
        const reg = createRegistry({ dir: TOOLS_DIR, strict: true, log: { warn() {} } });
        const requester = 'user:usr_01JAB2C3D4E5F6G7H8J9K0MNPT';
        const state = { off: new Set(), connectors: { openvibe: { cap: 2 } }, take: async () => ({ ok: false, used: 2 }) };
        const out = await reg.run('weather_now', { place: 'Berlin' }, { config: t.config, requester, connectorSwitches: state });
        assert.strictEqual(out.isError, true);
        assert.match(note(out), /all 2 calls of today/);
    });

    const owner = t.network.addUser('owner', { isOwner: true });
    const kim = t.network.addUser('kim');
    const nora = t.network.addUser('nora');
    const kimReq = `user:${kim.subject}`;
    const noraReq = `user:${nora.subject}`;

    await check("the person's own list: the defaults, and the switches the person changes", async () => {
        const first = await t.get('/api/v1/me/connectors', { as: kim });
        assert.strictEqual(first.status, 200, first.text.slice(0, 200));
        const list = first.json().connectors;
        assert.strictEqual(list.length, connectors.manifest().length);
        const byId = new Map(list.map((c) => [c.id, c]));
        assert.strictEqual(byId.get('money').enabled, false, 'spending is off until the person turns it on');
        assert.strictEqual(byId.get('email').enabled, false);
        assert.strictEqual(byId.get('openvibe').enabled, true);
        assert.strictEqual(byId.get('openvibe').risk_text, 'reads your things');

        const saved = await t.get('/api/v1/me/connectors', {
            as: kim, method: 'PUT', json: { connectors: [{ id: 'openvibe', enabled: false }] }, headers: SAME_SITE,
        });
        assert.strictEqual(saved.status, 200, saved.text.slice(0, 200));
        assert.strictEqual(saved.json().connectors.find((c) => c.id === 'openvibe').enabled, false);

        // Their tools are gone and refused.
        const state = await connectors.load(s, { requester: kimReq });
        const names = registry.definitions({ requester: kimReq, config: t.config, connectorSwitches: state }).map((d) => d.function.name);
        assert.ok(!names.includes('weather_now'), 'the tools of a connector the person turned off are not offered');
        const out = await registry.run('weather_now', { place: 'Berlin' }, { requester: kimReq, config: t.config, connectorSwitches: state });
        assert.match(note(out), /is off for your agent/);

        // Another person's rows are never read: nora still has it.
        const other = await t.get('/api/v1/me/connectors', { as: nora });
        assert.strictEqual(other.json().connectors.find((c) => c.id === 'openvibe').enabled, true);
        const otherState = await connectors.load(s, { requester: noraReq });
        assert.ok(registry.definitions({ requester: noraReq, config: t.config, connectorSwitches: otherState }).map((d) => d.function.name).includes('weather_now'));
    });

    await check("the owner's switch beats the person's, and a connector off for everyone says so", async () => {
        // The owner turns a connector off for everyone.
        const off = await t.get('/api/v1/admin/connectors', {
            as: owner, method: 'PUT', json: { connectors: [{ id: 'openvibe', enabled: false }] }, headers: SAME_SITE,
        });
        assert.strictEqual(off.status, 200, off.text.slice(0, 200));
        assert.strictEqual(off.json().connectors.find((c) => c.id === 'openvibe').enabled, false);

        // The person had turned it off as well; the owner's switch is the one that counts.
        const view = await t.get('/api/v1/me/connectors', { as: kim });
        const row = view.json().connectors.find((c) => c.id === 'openvibe');
        assert.strictEqual(row.off_for_everyone, true);
        assert.strictEqual(row.enabled, false);

        // The owner turns it back on: the person's own switch (off) is what counts again.
        await t.get('/api/v1/admin/connectors', {
            as: owner, method: 'PUT', json: { connectors: [{ id: 'openvibe', enabled: true }] }, headers: SAME_SITE,
        });
        const again = await t.get('/api/v1/me/connectors', { as: kim });
        const back = again.json().connectors.find((c) => c.id === 'openvibe');
        assert.strictEqual(back.off_for_everyone, false);
        assert.strictEqual(back.enabled, false, 'the person\'s own switch still says off');
        assert.strictEqual(back.person_enabled, false);
    });

    await check('the daily cap counts the calls of one person per day', async () => {
        await t.get('/api/v1/admin/connectors', {
            as: owner, method: 'PUT', json: { connectors: [{ id: 'openvibe', enabled: true, daily_cap: 2 }] }, headers: SAME_SITE,
        });
        const state = await connectors.load(s, { requester: kimReq });
        assert.strictEqual(state.connectors.openvibe.cap, 2);
        const first = await state.take('openvibe', 2);
        assert.strictEqual(first.ok, true);
        const second = await state.take('openvibe', 2);
        assert.strictEqual(second.ok, true);
        const third = await state.take('openvibe', 2);
        assert.strictEqual(third.ok, false, 'the third call of the day is refused');
        // Another person's own day is not touched by kim's calls.
        const other = await connectors.load(s, { requester: noraReq });
        assert.strictEqual((await other.take('openvibe', 2)).ok, true);
        // The owner's list says what the limit is.
        const list = await t.get('/api/v1/admin/connectors', { as: owner });
        assert.strictEqual(list.json().connectors.find((c) => c.id === 'openvibe').daily_cap, 2);
    });

    await check('both APIs keep their guard', async () => {
        const anon = await t.get('/api/v1/me/connectors');
        assert.strictEqual(anon.status, 401, anon.text.slice(0, 200));
        const notOwner = await t.get('/api/v1/admin/connectors', { as: kim });
        assert.strictEqual(notOwner.status, 403, notOwner.text.slice(0, 200));
        assert.strictEqual(notOwner.json().code, 'actor.connector.forbidden');
        const refused = await t.get('/api/v1/admin/connectors', {
            as: kim, method: 'PUT', json: { connectors: [{ id: 'money', enabled: false }] }, headers: SAME_SITE,
        });
        assert.strictEqual(refused.status, 403, refused.text.slice(0, 200));
        // The owner's switches did not change.
        const list = await t.get('/api/v1/admin/connectors', { as: owner });
        assert.strictEqual(list.json().connectors.find((c) => c.id === 'money').enabled, true);
        // A bad request is refused in the house shape.
        const bad = await t.get('/api/v1/me/connectors', { as: kim, method: 'PUT', json: { connectors: [{ id: 'nope', enabled: true }] }, headers: SAME_SITE });
        assert.strictEqual(bad.status, 422, bad.text.slice(0, 200));
        assert.strictEqual(bad.json().code, 'actor.connector.invalid');
        const bad2 = await t.get('/api/v1/me/connectors', { as: kim, method: 'PUT', json: { connectors: [{ id: 'files', enabled: 'yes' }] }, headers: SAME_SITE });
        assert.strictEqual(bad2.status, 422, bad2.text.slice(0, 200));
    });

    await check('both pages render', async () => {
        // The owner turns one connector off for everyone: the person's page says so and offers no switch.
        await t.get('/api/v1/admin/connectors', {
            as: owner, method: 'PUT', json: { connectors: [{ id: 'email', enabled: false }] }, headers: SAME_SITE,
        });
        const settings = await t.get('/chat/settings', { as: kim });
        assert.strictEqual(settings.status, 200, settings.text.slice(0, 200));
        assert.match(settings.text, /Connectors/);
        assert.match(settings.text, /OpenVibe search/);
        assert.match(settings.text, /c_openvibe/, 'the switches of the connectors');
        assert.match(settings.text, /Off for everyone/, 'a connector the owner turned off');

        // The person's own form saves the switch.
        const saved = await t.get('/chat/connectors', { as: kim, method: 'POST', form: { c_openvibe: '0' }, headers: { 'sec-fetch-site': 'same-origin' } });
        assert.strictEqual(saved.status, 303, saved.text.slice(0, 200));
        const after = await t.get('/api/v1/me/connectors', { as: kim });
        assert.strictEqual(after.json().connectors.find((c) => c.id === 'openvibe').enabled, false);

        // The owner's own page.
        const ownerPage = await t.get('/owner/connectors', { as: owner });
        assert.strictEqual(ownerPage.status, 200, ownerPage.text.slice(0, 200));
        assert.match(ownerPage.text, /Connectors/);
        assert.match(ownerPage.text, /Calls a day/);
        assert.match(ownerPage.text, /weather_now/, 'the tools of a connector are named');
        const notOwner = await t.get('/owner/connectors', { as: kim });
        assert.strictEqual(notOwner.status, 404);
        const guest = await t.get('/owner/connectors');
        assert.strictEqual(guest.status, 302);
        await t.get('/api/v1/admin/connectors', {
            as: owner, method: 'PUT', json: { connectors: [{ id: 'email', enabled: true }] }, headers: SAME_SITE,
        });
    });

    await t.close();
    done();
})().catch((err) => { console.error(err); process.exit(1); });

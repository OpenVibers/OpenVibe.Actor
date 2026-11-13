'use strict';
/**
 * Run settings and permission rules (plan 11c).
 *
 * - every tool module says what it needs (files, network); a module that does not is network on, files none;
 * - the run's settings leave out and refuse what they do not give: network off, files none or read;
 * - rules: the last matching rule wins; a matching site rule is final; args match as globs; risk comes from the
 *   connector; a deny is left out of the list and refused with its why;
 * - the approval gate: a site ask asks at full level and no standing permission covers it, a person's allow passes the
 *   level, a person's ask is covered by their standing permission for that exact step, and nothing lowers the floor;
 * - an ask on a call the gate would not see goes through the gate, or is refused when nobody can be asked; an
 *   unattended run says it goes on without the answer;
 * - the API: defaults, presets, validation, the owner's list, and the guards; a task stores the settings it started
 *   with and shows them as its first steps.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { boot, check, done } = require('./helpers/boot');
const runPolicy = require('../server/runtime/run-policy');
const levels = require('../server/agents/levels');
const { createRegistry, validateTool } = require('../server/runtime/tools');

const TOOLS_DIR = path.join(__dirname, '..', 'server', 'runtime', 'tools');
const ME = 'user:usr_01M4W5JBFEG3QG9ER8W1A2K0RX';
const SAME = { 'sec-fetch-site': 'same-origin' };
const note = (out) => String((out && out.text) || '');
const policy = (settings, site = [], person = []) => ({ settings: { files: 'write', network: 'on', unattended: null, ...settings }, site, person });

/** A registry of three stand-in tools: one that reads Space, one that acts on a computer, one that reaches the web. */
function standIns() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'actor-policy-'));
    const mod = (name, extra) => fs.writeFileSync(path.join(dir, `${name}.js`), `module.exports = {
        name: '${name}', description: 'test ${name}', input: { type: 'object', properties: {} }, ${extra},
        async run(input) { globalThis.__ran = (globalThis.__ran || []).concat('${name}'); return { text: 'ran ${name}' }; },
    };`);
    mod('space_files_read', "scope: 'person', connector: 'space', needs: { files: 'read', network: false }");
    mod('computer_run', "scope: 'person', acts: true, connector: 'computers', needs: { files: 'write', network: false }");
    mod('search_web', "scope: 'public', connector: 'openvibe', needs: { files: 'none', network: true }");
    mod('calculate', "scope: 'public'");
    return createRegistry({ dir, strict: true, log: { warn() {} } });
}

(async () => {
    const t = await boot();

    await check('every tool module says what it needs, and a module that does not is network on, files none', async () => {
        const reg = createRegistry({ dir: TOOLS_DIR, strict: true, log: { warn() {} } });
        for (const tool of reg.tools) {
            assert.ok(tool.needs && typeof tool.needs === 'object', `${tool.name} does not say what it needs`);
            assert.ok(runPolicy.FILES.includes(tool.needs.files), tool.name);
            assert.strictEqual(typeof tool.needs.network, 'boolean', tool.name);
        }
        const byName = new Map(reg.tools.map((x) => [x.name, x]));
        assert.strictEqual(byName.get('search_web').needs.network, true);
        assert.strictEqual(byName.get('calculate').needs.network, false);
        assert.strictEqual(byName.get('space_files_write').needs.files, 'write');
        assert.strictEqual(byName.get('space_files_read').needs.files, 'read');
        assert.deepStrictEqual(runPolicy.needsOf({ name: 'x' }), { files: 'none', network: true });
        const bad = validateTool({ name: 'x_tool', description: 'x', input: { type: 'object' }, scope: 'public', needs: { files: 'all' }, run: () => ({}) });
        assert.ok(bad.some((e) => /needs\.files/.test(e)), bad.join('; '));
        assert.ok(validateTool({ name: 'x_tool', description: 'x', input: { type: 'object' }, scope: 'public', needs: { disk: 1 }, run: () => ({}) }).length);
    });

    await check("the run's settings leave out and refuse what they do not give", async () => {
        const reg = standIns();
        const names = (p) => reg.definitions({ requester: ME, runPolicy: p }).map((d) => d.function.name).sort();
        assert.deepStrictEqual(names(policy({})), ['calculate', 'computer_run', 'search_web', 'space_files_read']);
        assert.deepStrictEqual(names(policy({ network: 'off' })), ['computer_run', 'space_files_read'], 'calculate says nothing, so it is network on');
        assert.deepStrictEqual(names(policy({ files: 'read' })), ['calculate', 'search_web', 'space_files_read']);
        assert.deepStrictEqual(names(policy({ files: 'none' })), ['calculate', 'search_web']);
        const off = await reg.run('search_web', {}, { requester: ME, runPolicy: policy({ network: 'off' }) });
        assert.strictEqual(off.isError, true);
        assert.match(note(off), /network off/);
        const ro = await reg.run('computer_run', {}, { requester: ME, runPolicy: policy({ files: 'read' }) });
        assert.match(note(ro), /may only read your files/);
        // No policy (an old caller) changes nothing.
        assert.strictEqual(reg.definitions({ requester: ME }).length, 4);
    });

    await check('rules: the last match wins, a site rule is final, args are globs and risk comes from the connector', async () => {
        const reg = standIns();
        const tool = reg.get('computer_run');
        const call = { tool, args: { argv: ['git', 'status'], cwd: '/home/kim/site' } };
        assert.strictEqual(runPolicy.riskOf(tool), 'writes');
        assert.strictEqual(runPolicy.riskOf(reg.get('search_web')), 'reads');
        assert.strictEqual(runPolicy.riskOf({ name: 'x', acts: true }), 'writes');
        const person = [
            { match: { risk: 'writes' }, decision: 'ask', why: 'ask before changes' },
            { match: { tool: 'computer_*', args: { cwd: '/home/kim/*' } }, decision: 'allow', why: 'my own folders' },
        ];
        assert.deepStrictEqual(runPolicy.decide(policy({}, [], person), call), { decision: 'allow', why: 'my own folders', source: 'person', index: 1 });
        assert.strictEqual(runPolicy.decide(policy({}, [], person), { tool, args: { cwd: '/etc' } }).decision, 'ask', 'the args rule does not match, so the earlier one decides');
        assert.strictEqual(runPolicy.decide(policy({}, [], person.slice().reverse()), call).decision, 'ask', 'order is the rule: the last match wins');
        const site = [{ match: { connector: 'computers' }, decision: 'deny', why: 'no computers on this site' }];
        assert.deepStrictEqual(runPolicy.decide(policy({}, site, person), call), { decision: 'deny', why: 'no computers on this site', source: 'site', index: 0 });
        assert.strictEqual(runPolicy.decide(policy({}, [], []), call), null, 'no match falls to the level');
        assert.match(runPolicy.decide(policy({}, [], [{ match: { tool: 'computer_run' }, decision: 'deny' }]), call).why, /your rules do not allow it/);
    });

    await check('a deny is left out of the list and refused with its why; an args deny is checked at the call', async () => {
        const reg = standIns();
        const p = policy({}, [{ match: { tool: 'search_web' }, decision: 'deny', why: 'no web on this site' }],
            [{ match: { tool: 'computer_run', args: { cwd: '/etc*' } }, decision: 'deny', why: 'never in /etc' }]);
        const names = reg.definitions({ requester: ME, runPolicy: p }).map((d) => d.function.name);
        assert.ok(!names.includes('search_web'));
        assert.ok(names.includes('computer_run'), 'an args rule cannot know the call yet');
        globalThis.__ran = [];
        const out = await reg.run('computer_run', { cwd: '/etc/nginx' }, { requester: ME, runPolicy: p });
        assert.match(note(out), /not run: never in \/etc/);
        assert.deepStrictEqual(globalThis.__ran, []);
        const fine = await reg.run('computer_run', { cwd: '/home/kim' }, { requester: ME, runPolicy: p });
        assert.strictEqual(fine.isError, false, note(fine));
    });

    await check('the gate: site first and final, the standing permission, the person, the level; never the floor', async () => {
        const site = { decision: 'ask', why: 'the owner asks before computers', source: 'site' };
        const mine = { decision: 'ask', why: 'I ask before changes', source: 'person' };
        const allowMine = { decision: 'allow', why: 'go ahead', source: 'person' };
        const held = { kind: 'computer.run', target: 'git status on dev_x', rules: [{ kind: 'computer.run', target: 'git status on dev_x' }] };
        assert.strictEqual((await levels.decide({ level: 'full', rule: site })).ask, true, 'a site ask asks at full level');
        assert.strictEqual((await levels.decide({ level: 'full', rule: site, allow: held })).ask, true, "the person's standing permission does not cover the owner's ask");
        assert.strictEqual((await levels.decide({ level: 'full', rule: mine })).ask, true);
        assert.strictEqual((await levels.decide({ level: 'full', rule: mine, allow: held })).ask, false, 'the exact standing permission covers their own general ask');
        assert.strictEqual((await levels.decide({ level: 'ask', rule: allowMine })).ask, false, "the person's allow passes the level");
        const floor = await levels.decide({ level: 'full', rule: { decision: 'allow', why: 'all', source: 'site' }, categories: ['money'] });
        assert.strictEqual(floor.ask, true, 'nothing lowers the floor');
        assert.strictEqual(floor.floor, 'money');
        assert.strictEqual((await levels.decide({ level: 'ask', rule: { decision: 'deny', source: 'person' } })).ask, true, 'a deny never reaches the gate as an allow');
    });

    await check('an ask goes through the gate, is refused when nobody can be asked, and an unattended run goes on', async () => {
        const reg = standIns();
        const asked = [];
        const gate = (answer) => async (step) => { asked.push(step); return answer; };
        const p = policy({}, [], [{ match: { connector: 'space' }, decision: 'ask', why: 'ask before reading my space' }]);
        // A read the gate would not see asks through it, with the rule.
        const pending = { pending: true, id: 'apr_1', url: 'https://openvibe.actor/me/approvals/apr_1' };
        const out = await reg.run('space_files_read', { path: 'a.md' }, { requester: ME, runPolicy: p, requestApproval: gate(pending) });
        assert.match(note(out), /must approve it first/);
        assert.strictEqual(asked[0].rule.why, 'ask before reading my space');
        assert.strictEqual(asked[0].target, 'space_files_read');
        // With nobody to ask, it does not run.
        globalThis.__ran = [];
        const none = await reg.run('space_files_read', {}, { requester: ME, runPolicy: p });
        assert.match(note(none), /nobody to ask/);
        assert.deepStrictEqual(globalThis.__ran, []);
        // The gate said go ahead: it runs.
        const ok = await reg.run('space_files_read', {}, { requester: ME, runPolicy: p, requestApproval: gate(null) });
        assert.strictEqual(ok.isError, false, note(ok));
        // An unattended run's ask: the card stays, and the step says the run goes on without it.
        const away = await reg.run('space_files_read', {}, { requester: ME, runPolicy: p, requestApproval: gate({ ...pending, unattended: 'schedule' }) });
        assert.match(note(away), /This run is unattended \(schedule\), so it goes on without it/);
    });

    await check('starter presets and validation', async () => {
        for (const [id, rules] of Object.entries(runPolicy.PRESETS)) {
            assert.deepStrictEqual(runPolicy.validateRules(rules).value.map((r) => r.decision), rules.map((r) => r.decision), id);
        }
        assert.deepStrictEqual(Object.keys(runPolicy.PRESETS), ['careful', 'balanced', 'hands-off']);
        for (const bad of [
            [{ match: {}, decision: 'allow' }],
            [{ match: { tool: 'a b' }, decision: 'allow' }],
            [{ match: { risk: 'eats' }, decision: 'ask' }],
            [{ match: { tool: 'x' }, decision: 'maybe' }],
            [{ match: { connector: 'nope' }, decision: 'deny' }],
            [{ match: { args: {} }, decision: 'deny' }],
            [{ match: { tool: 'x', colour: 'red' }, decision: 'deny' }],
            [{ match: { tool: 'x' }, decision: 'deny', why: 'line\nbreak' }],
            new Array(101).fill({ match: { tool: 'x' }, decision: 'deny' }),
            'all of them',
        ]) assert.ok(runPolicy.validateRules(bad).error, JSON.stringify(bad).slice(0, 80));
        assert.ok(runPolicy.validateSettings({ files: 'everything' }).error);
        assert.ok(runPolicy.validateSettings({ speed: 'fast' }).error);
        assert.deepStrictEqual(runPolicy.runSettings({ defaults: { files: 'read', network: 'on' } }, { network: 'off' }, 'schedule'), { files: 'read', network: 'off', unattended: 'schedule' });
        assert.deepStrictEqual(runPolicy.runSettings(null, null, null), { files: 'write', network: 'on', unattended: null }, 'the defaults');
    });

    const owner = t.network.addUser('owner', { isOwner: true });
    const kim = t.network.addUser('kim');
    const nora = t.network.addUser('nora');

    await check("the person's run settings and rules: defaults, a preset, their own list, validation", async () => {
        const first = await t.get('/api/v1/me/run-policy', { as: kim });
        assert.strictEqual(first.status, 200, first.text.slice(0, 200));
        const view = first.json();
        assert.deepStrictEqual([view.files, view.network, view.rules, view.site_rules], [null, null, [], []]);
        assert.deepStrictEqual(view.defaults, { files: 'write', network: 'on' });
        assert.deepStrictEqual(view.presets.map((p) => p.id), ['careful', 'balanced', 'hands-off']);

        const careful = await t.get('/api/v1/me/run-policy', { as: kim, method: 'PUT', json: { preset: 'careful', network: 'off' }, headers: SAME });
        assert.strictEqual(careful.status, 200, careful.text.slice(0, 300));
        assert.strictEqual(careful.json().network, 'off');
        assert.strictEqual(careful.json().rules.length, runPolicy.PRESETS.careful.length);

        const own = await t.get('/api/v1/me/run-policy', { as: kim, method: 'PUT', json: { rules: [{ match: { tool: 'search_web' }, decision: 'deny', why: 'no web' }] }, headers: SAME });
        assert.strictEqual(own.status, 200, own.text.slice(0, 300));
        assert.deepStrictEqual(own.json().rules, [{ match: { tool: 'search_web' }, decision: 'deny', why: 'no web' }]);
        assert.strictEqual(own.json().network, 'off', 'a write of rules keeps the settings');

        const loaded = await runPolicy.load(t.ctx.s, `user:${kim.subject}`);
        assert.deepStrictEqual(loaded.defaults, { files: 'write', network: 'off' });
        assert.strictEqual(loaded.person.length, 1);
        assert.deepStrictEqual((await runPolicy.load(t.ctx.s, `user:${nora.subject}`)).person, [], "another person's rules are never read");

        for (const body of [{ preset: 'reckless' }, { rules: 'x' }, { files: 'all' }, { preset: 'careful', rules: [] }, { colour: 'red' }]) {
            const bad = await t.get('/api/v1/me/run-policy', { as: kim, method: 'PUT', json: body, headers: SAME });
            assert.strictEqual(bad.status, 422, JSON.stringify(body));
        }
        assert.strictEqual((await t.get('/api/v1/me/run-policy')).status, 401);
    });

    await check("the owner's rules: only the owner writes them, and every person reads them", async () => {
        const refused = await t.get('/api/v1/admin/run-policy', { as: kim, method: 'PUT', json: { rules: [] }, headers: SAME });
        assert.strictEqual(refused.status, 403);
        assert.strictEqual((await t.get('/api/v1/admin/run-policy', { as: kim })).status, 403);
        const rules = [{ match: { risk: 'spends' }, decision: 'deny', why: 'no spending on this site' }];
        const saved = await t.get('/api/v1/admin/run-policy', { as: owner, method: 'PUT', json: { rules }, headers: SAME });
        assert.strictEqual(saved.status, 200, saved.text.slice(0, 300));
        assert.deepStrictEqual(saved.json().rules, rules);
        assert.deepStrictEqual((await t.get('/api/v1/me/run-policy', { as: nora })).json().site_rules, rules);
        assert.deepStrictEqual((await runPolicy.load(t.ctx.s, `user:${nora.subject}`)).site, rules);
        const bad = await t.get('/api/v1/admin/run-policy', { as: owner, method: 'PUT', json: { rules: [{ match: {}, decision: 'deny' }] }, headers: SAME });
        assert.strictEqual(bad.status, 422);
        await t.get('/api/v1/admin/run-policy', { as: owner, method: 'PUT', json: { rules: [] }, headers: SAME });
    });

    await check('the Settings page: the starting points, the settings, the rules, and the forms that save them', async () => {
        await t.get('/api/v1/admin/run-policy', { as: owner, method: 'PUT', json: { rules: [{ match: { connector: 'money' }, decision: 'deny', why: 'no spending here' }] }, headers: SAME });
        const page = await t.get('/chat/settings', { as: kim });
        assert.strictEqual(page.status, 200, page.text.slice(0, 200));
        assert.match(page.text, /How your agent asks/);
        for (const label of ['Careful', 'Balanced', 'Hands-off']) assert.match(page.text, new RegExp(`<b>${label}</b>`));
        assert.match(page.text, /Rules for everyone/);
        assert.match(page.text, /no spending here/);
        const preset = await t.get('/chat/run-policy', { as: kim, method: 'POST', form: { preset: 'hands-off' }, headers: SAME });
        assert.strictEqual(preset.status, 303, preset.text.slice(0, 200));
        assert.strictEqual(runPolicy.presetOf((await runPolicy.read(t.ctx.s, `user:${kim.subject}`)).rules), 'hands-off');
        const again = await t.get('/chat/settings', { as: kim });
        assert.match(again.text, /rp-preset is-current" type="submit" name="preset" value="hands-off"/);
        assert.match(again.text, /Goes ahead/);
        const removed = await t.get('/chat/run-policy', { as: kim, method: 'POST', form: { remove: '0' }, headers: SAME });
        assert.strictEqual(removed.status, 303);
        assert.strictEqual((await runPolicy.read(t.ctx.s, `user:${kim.subject}`)).rules.length, runPolicy.PRESETS['hands-off'].length - 1);
        const settings = await t.get('/chat/run-policy', { as: kim, method: 'POST', form: { files: 'read', network: 'on', save: '1' }, headers: SAME });
        assert.strictEqual(settings.status, 303);
        assert.strictEqual((await runPolicy.read(t.ctx.s, `user:${kim.subject}`)).files, 'read');
        const cross = await t.get('/chat/run-policy', { as: kim, method: 'POST', form: { preset: 'careful' }, headers: { 'sec-fetch-site': 'cross-site' } });
        assert.strictEqual(cross.status, 403, 'a write from another site is refused');
        await t.get('/api/v1/admin/run-policy', { as: owner, method: 'PUT', json: { rules: [] }, headers: SAME });
    });

    await check('a task stores the settings it started with, and its card says them', async () => {
        const r = await t.get('/api/v1/tasks', { as: nora, json: { task: 'What is 2 + 2?', settings: { files: 'read' } }, headers: SAME });
        assert.strictEqual(r.status, 201, r.text.slice(0, 300));
        const row = await t.waitFor(r.json().id);
        const stored = typeof row.run_settings === 'string' ? JSON.parse(row.run_settings) : row.run_settings;
        assert.deepStrictEqual(stored, { files: 'read', network: 'on', unattended: null });
        const events = await t.ctx.s.db.many('SELECT body FROM task_events WHERE task_id = $1 ORDER BY seq', [row.id]);
        const shown = events.map((e) => (typeof e.body === 'string' ? JSON.parse(e.body) : e.body)).find((b) => b.step === 'plan' && /^Settings: /.test(b.text || ''));
        assert.ok(shown, 'the settings are a step on the card');
        assert.match(shown.text, /reads your files · network on/);
        const bad = await t.get('/api/v1/tasks', { as: nora, json: { task: 'x', settings: { network: 'maybe' } }, headers: SAME });
        assert.strictEqual(bad.status, 422);
    });

    await done(t);
})();

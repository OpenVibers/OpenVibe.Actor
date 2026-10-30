'use strict';
/**
 * The tool registry (Actor v2): every module in server/runtime/tools is loaded and its shape validated at boot; a
 * malformed module is rejected in tests and skipped (logged) in production. Tools are offered by scope (public,
 * person for a signed-in requester, private-ok for private mode) and the ported OpenVibe tools keep the old gates.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createRegistry, validateTool } = require('../server/runtime/tools');
const configLib = require('../server/config');

const results = [];
const ok = async (name, fn) => { try { await fn(); console.log(`  ✓ ${name}`); } catch (e) { results.push(e); console.log(`  ✗ ${name}\n      ${(e.stack || String(e)).split('\n').slice(0, 6).join('\n      ')}`); } };

function tempTools(files) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'actor-tools-'));
    for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), body);
    return dir;
}

const good = (name, scope = 'public') => `module.exports = {
    name: '${name}', description: 'does ${name}', input: { type: 'object', properties: {} }, scope: '${scope}', costUsd: 0, timeoutMs: 1000,
    async run(input, ctx) { return { text: '${name} ran', data: { name: '${name}' } }; },
};`;

(async () => {
    await ok('validateTool accepts the plan\'s shape and names every problem', async () => {
        assert.deepStrictEqual(validateTool({ name: 'weather_now', description: 'Weather', input: { type: 'object' }, scope: 'public', costUsd: 0, timeoutMs: 10, run: () => ({}) }), []);
        const bad = validateTool({ name: 'Bad-Name', description: '', input: { type: 'string' }, scope: 'everyone', costUsd: -1, timeoutMs: 0, run: null });
        assert.strictEqual(bad.length, 7, bad.join('; '));
    });

    await ok('a malformed module fails the boot in tests and is skipped (with a reason) in production', async () => {
        const dir = tempTools({ 'bad.js': 'module.exports = { name: "bad", description: "", input: {}, scope: "public", run: 1 };', 'fine.js': good('fine') });
        assert.throws(() => createRegistry({ dir, strict: true, log: { warn() {} } }), /invalid tool module/);
        const warnings = [];
        const reg = createRegistry({ dir, strict: false, log: { warn: (m) => warnings.push(m) } });
        assert.deepStrictEqual(reg.report().names, ['fine']);
        assert.strictEqual(reg.errors.length, 1);
        assert.match(warnings.join('\n'), /bad\.js/);
    });

    await ok('a duplicate name and a module that throws on require are rejected too', async () => {
        const dir = tempTools({ 'a.js': good('same'), 'b.js': good('same'), 'c.js': 'throw new Error("boom")' });
        const reg = createRegistry({ dir, strict: false, log: { warn() {} } });
        assert.deepStrictEqual(reg.report().names, ['same']);
        assert.ok(reg.errors.some((e) => /duplicate/.test(e.errors.join(' '))));
        assert.ok(reg.errors.some((e) => /require failed/.test(e.errors.join(' '))));
        assert.throws(() => createRegistry({ dir, strict: true, log: { warn() {} } }), /duplicate/);
    });

    await ok('helper files (_name.js), index.js and subfolders are not modules', async () => {
        const dir = tempTools({ '_lib.js': 'module.exports = 1;', 'one.js': good('one') });
        fs.mkdirSync(path.join(dir, 'fixtures'));
        const reg = createRegistry({ dir, strict: true, log: { warn() {} } });
        assert.deepStrictEqual(reg.report().names, ['one']);
    });

    await ok('definitions are filtered by scope: private mode sees only private-ok, and person tools need a person', async () => {
        const dir = tempTools({ 'pub.js': good('pub', 'public'), 'per.js': good('per', 'person'), 'priv.js': good('priv', 'private-ok') });
        const reg = createRegistry({ dir, strict: true, log: { warn() {} } });
        const names = (o) => reg.definitions(o).map((d) => d.function.name).sort();
        assert.deepStrictEqual(names({}), ['priv', 'pub']);
        assert.deepStrictEqual(names({ requester: 'user:usr_01JAB2C3D4E5F6G7H8J9K0MNPT' }), ['per', 'priv', 'pub']);
        assert.deepStrictEqual(names({ requester: 'user:usr_01JAB2C3D4E5F6G7H8J9K0MNPT', mode: 'private' }), ['priv']);
        assert.deepStrictEqual(names({ requester: 'app:app_1' }), ['priv', 'pub']);
        assert.deepStrictEqual(names({ mode: 'private' }), ['priv']);
        // A module may narrow itself further (a service that is not connected this boot).
        const dir2 = tempTools({ 'off.js': `module.exports = { name: 'off', description: 'off', input: { type: 'object' }, scope: 'public', available: () => false, run: async () => ({ text: 'x' }) };`, 'on.js': good('on') });
        assert.deepStrictEqual(createRegistry({ dir: dir2, strict: true, log: { warn() {} } }).definitions({}).map((d) => d.function.name), ['on']);
    });

    await ok('run refuses a person tool with no person, and any non-private tool in private mode', async () => {
        const dir = tempTools({ 'per.js': good('per', 'person'), 'pub.js': good('pub', 'public'), 'priv.js': good('priv', 'private-ok') });
        const reg = createRegistry({ dir, strict: true, log: { warn() {} } });
        const noPerson = await reg.run('per', {}, {});
        assert.match(note(noPerson), /not available for this task/);
        const privatePub = await reg.run('pub', {}, { mode: 'private' });
        assert.match(note(privatePub), /not available for this task/);
        const allowed = await reg.run('priv', {}, { mode: 'private' });
        assert.strictEqual(allowed.text, 'priv ran');
        const unknown = await reg.run('nope', {}, {});
        assert.match(note(unknown), /unknown tool/);
    });

    await ok('a tool that honours ctx.signal is stopped at its timeout, and the model sees an error result', async () => {
        const dir = tempTools({
            'slow.js': `module.exports = { name: 'slow', description: 'slow', input: { type: 'object' }, scope: 'public', timeoutMs: 30,
                run: (input, ctx) => new Promise((resolve, reject) => { const h = setTimeout(() => resolve({ text: 'late' }), 500); ctx.signal.addEventListener('abort', () => { clearTimeout(h); reject(new Error('aborted')); }); }) };`,
        });
        const reg = createRegistry({ dir, strict: true, log: { warn() {} } });
        const out = await reg.run('slow', {}, {});
        assert.match(note(out), /timed out after 30 ms/);
        assert.strictEqual(out.isError, true);
    });

    await ok('the ported tools keep their gates: requester rules, private mode, and the services this boot has', async () => {
        const real = path.join(__dirname, '..', 'server', 'runtime', 'tools');
        const withBot = configLib.load({ NODE_ENV: 'test', ACTOR_SEARCH_URL: 'https://search.example', ACTOR_TOOLS_URL: 'https://tools.example', ACTOR_BOT_URL: 'https://bot.example', ACTOR_CODES_URL: 'https://codes.example', OV_OAUTH_CLIENT_SECRET: 's' });
        const noBot = configLib.load({ NODE_ENV: 'test', ACTOR_SEARCH_URL: 'https://search.example', ACTOR_TOOLS_URL: 'https://tools.example', ACTOR_BOT_URL: '', ACTOR_CODES_URL: '', OV_OAUTH_CLIENT_SECRET: '' });
        const reg = createRegistry({ dir: real, strict: true, log: { warn() {} } });
        assert.ok(reg.report().count >= 18, String(reg.report().count));
        const models = { chat: async () => ({ text: 'a reading of the screen' }) };
        const names = (o) => reg.definitions({ models, ...o }).map((d) => d.function.name);
        const anon = names({ config: withBot });
        assert.ok(anon.includes('search_openvibe') && anon.includes('search_web') && anon.includes('find_tools') && anon.includes('run_tool') && anon.includes('read_page'));
        assert.ok(!anon.includes('list_my_robots') && !anon.includes('codes_task'), 'no person tools without a signed-in person');
        const person = names({ config: withBot, requester: 'user:usr_01JAB2C3D4E5F6G7H8J9K0MNPT' });
        for (const n of ['list_my_robots', 'robot_steps', 'list_my_computers', 'computer_run', 'computer_desk', 'hand_to_person', 'codes_task', 'computer_screen']) assert.ok(person.includes(n), n);
        assert.deepStrictEqual(names({ config: withBot, requester: 'user:usr_01JAB2C3D4E5F6G7H8J9K0MNPT', mode: 'private' }), [], 'private mode has no network tools');
        // Files and charts need the signed-in person and a Media store. A public-chat task has no requester, so the
        // person gate never opens; a server without Media has nothing to store into.
        const store = { available: true, maxBytes: 1024 * 1024 };
        const withFiles = names({ config: withBot, requester: 'user:usr_01JAB2C3D4E5F6G7H8J9K0MNPT', artifacts: store });
        assert.ok(withFiles.includes('make_file') && withFiles.includes('make_chart'), 'offered with a person and Media');
        assert.ok(!anon.includes('make_file') && !anon.includes('make_chart'), 'a public-chat task gets no files');
        const noStore = names({ config: withBot, requester: 'user:usr_01JAB2C3D4E5F6G7H8J9K0MNPT' });
        assert.ok(!noStore.includes('make_file') && !noStore.includes('make_chart'), 'no Media, no files');
        assert.ok(!names({ config: withBot, requester: 'user:usr_01JAB2C3D4E5F6G7H8J9K0MNPT', artifacts: { available: false } }).includes('make_file'));
        const off = names({ config: noBot, requester: 'user:usr_01JAB2C3D4E5F6G7H8J9K0MNPT' });
        assert.ok(!off.includes('list_my_robots') && !off.includes('codes_task') && !off.includes('search_web'), 'a service this boot lacks is not offered');
        const runNoPerson = await reg.run('list_my_robots', {}, { config: withBot });
        assert.match(note(runNoPerson), /not available for this task/);
        const runPrivate = await reg.run('search_openvibe', { query: 'x' }, { config: withBot, mode: 'private' });
        assert.match(note(runPrivate), /not available for this task/);
    });

    if (results.length) { console.log(`\n${results.length} failed`); process.exit(1); }
    console.log('\nall passed');
})();

function note(out) { return String((out && out.text) || ''); }

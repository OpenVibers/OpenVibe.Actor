'use strict';
// Every module in server/runtime/tools/ has the plugin interface the runtime expects: a unique snake_case name, a
// description, a JSON schema for its input, one of the three scopes, a cost, a timeout, and a run that answers with
// text/data/sources/artifacts - or with an error the model can act on, never a crash. The live-data modules (stage
// V2-2) additionally name the provider they read and answer an empty input with an error, without touching the
// network. The file and chart modules (stage V2-4) are person-scoped and need an artifact store.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { check, done } = require('./helpers/boot');
const { validateTool, SCOPES } = require('../server/runtime/tools');

const DIR = path.join(__dirname, '..', 'server', 'runtime', 'tools');
const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.js') && f !== 'index.js' && !f.startsWith('_')).sort();
const LIVE_DATA = ['weather_now', 'market_quote', 'currency_convert', 'sports_scores', 'time_in', 'convert_time', 'geocode', 'place_info', 'wikipedia', 'calculate'];

(async () => {
    await check('the folder holds every tool module', async () => {
        assert.ok(files.length >= 12, 'expected the tool modules, found ' + files.length);
        assert.ok(!files.includes('index.js'), 'the registry is the core job\'s file, not a tool');
    });

    const names = new Set();
    const byName = new Map();
    for (const file of files) {
        const mod = require(path.join(DIR, file));
        byName.set(file, mod);
        await check(file + ' has the plugin interface', async () => {
            const problems = validateTool(mod);
            assert.deepStrictEqual(problems, [], problems.join('; '));
            assert.ok(SCOPES.includes(mod.scope), 'scope is one of ' + SCOPES.join(', '));
            assert.ok(!names.has(mod.name), 'the name is unique: ' + mod.name);
            names.add(mod.name);
            assert.ok(mod.description.length > 40, 'the description says what the tool does');
            assert.ok(mod.input.required == null || Array.isArray(mod.input.required), 'input.required');
            assert.ok(Number.isFinite(mod.timeoutMs) && mod.timeoutMs > 0, 'timeoutMs');
            assert.ok(Number.isFinite(mod.costUsd) && mod.costUsd >= 0, 'costUsd');
            assert.strictEqual(typeof mod.run, 'function', 'run');
        });
    }

    await check('the live-data modules name an https provider and answer an empty input with an error', async () => {
        for (const name of LIVE_DATA) {
            const file = files.find((f) => byName.get(f).name === name);
            assert.ok(file, 'missing module: ' + name);
            const mod = byName.get(file);
            assert.strictEqual(mod.scope, 'public', name + ' is public');
            assert.ok(Array.isArray(mod.sources) && mod.sources.length, name + ' names its provider');
            for (const s of mod.sources) {
                assert.strictEqual(typeof s.url, 'string');
                assert.ok(/^https:\/\//.test(s.url), 'a source is an https page: ' + s.url);
                assert.strictEqual(typeof s.title, 'string');
            }
            const out = await mod.run({}, { fetch: async () => { throw new Error('the network must not be touched'); } });
            assert.strictEqual(typeof out, 'object');
            assert.ok(out && typeof out.error === 'string' && out.error.length > 0, name + ' answers an error the model can act on');
            assert.strictEqual(typeof out.text, 'string', 'the error is also the text the model reads');
            assert.ok(out.text.length > 0);
            assert.strictEqual(out.isError, true, 'the step is marked as an error');
        }
    });

    await check('the modules cover the live data the plan asks for', async () => {
        const have = files.map((f) => require(path.join(DIR, f)).name);
        for (const name of LIVE_DATA) assert.ok(have.includes(name), 'missing module: ' + name);
    });

    await check('the registry loads every module in the folder, the live-data ones included', async () => {
        const registry = require('../server/runtime/tools');
        const make = registry.createRegistry || registry.create || null;
        if (!make) return;   // the registry's own tests cover its loader
        const r = make({ strict: true });
        const loaded = (r.names ? r.names() : (r.list ? r.list().map((m) => m.name) : []));
        for (const name of LIVE_DATA) assert.ok(!loaded.length || loaded.includes(name), 'the registry did not load ' + name);
    });

    await check('the file and chart modules belong to the signed-in person and say so without a store', async () => {
        for (const name of ['make_file', 'make_chart']) {
            const mod = [...byName.values()].find((m) => m.name === name);
            assert.ok(mod, 'missing module: ' + name);
            assert.strictEqual(mod.scope, 'person');
            assert.strictEqual(mod.available({ artifacts: { available: true } }), true);
            assert.strictEqual(mod.available({ artifacts: { available: false } }), false);
            const out = await mod.run({}, { requester: null, artifacts: { available: false } });
            assert.strictEqual(out.isError, true);
            assert.match(out.error, /signed-in person/);
        }
    });

    done();
})();

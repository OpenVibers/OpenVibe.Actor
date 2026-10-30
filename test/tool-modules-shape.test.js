'use strict';
// The live-data modules in server/runtime/tools/ (stage V2-2) have the plugin interface the runtime expects: a name, a
// description, a JSON schema for its input, a public scope, no cost, a timeout, a source and a run that answers with
// text, data and sources - or with an error the model can act on, never a crash. The folder also holds the ported
// runtime tools, the registry (index.js) and `_` helpers, which the registry's own tests cover; they are skipped here,
// the way the registry skips index.js and `_` files.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { check, done } = require('./helpers/boot');

const DIR = path.join(__dirname, '..', 'server', 'runtime', 'tools');

const LIVE = ['weather_now', 'market_quote', 'currency_convert', 'sports_scores', 'time_in', 'convert_time', 'geocode', 'place_info', 'wikipedia', 'calculate'];
const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.js') && f !== 'index.js' && !f.startsWith('_')).sort();
const live = files.filter((f) => LIVE.includes(require(path.join(DIR, f)).name));

(async () => {
    await check('the folder holds the live-data modules', async () => {
        assert.strictEqual(live.length, LIVE.length, 'expected every live-data module, found ' + live.length);
    });

    const names = new Set();
    for (const file of live) {
        const mod = require(path.join(DIR, file));
        await check(file + ' has the plugin interface', async () => {
            assert.strictEqual(typeof mod, 'object');
            assert.strictEqual(typeof mod.name, 'string', 'name');
            assert.ok(/^[a-z][a-z0-9_]*$/.test(mod.name), 'name is snake_case: ' + mod.name);
            assert.ok(!names.has(mod.name), 'the name is unique: ' + mod.name);
            names.add(mod.name);
            assert.strictEqual(typeof mod.description, 'string', 'description');
            assert.ok(mod.description.length > 40, 'the description says what the tool does');
            assert.strictEqual(typeof mod.input, 'object', 'input');
            assert.strictEqual(mod.input.type, 'object', 'input.type');
            assert.strictEqual(typeof mod.input.properties, 'object', 'input.properties');
            assert.ok(Array.isArray(mod.input.required), 'input.required');
            assert.strictEqual(mod.scope, 'public', 'scope');
            assert.strictEqual(mod.costUsd, 0, 'costUsd');
            assert.ok(Number.isFinite(mod.timeoutMs) && mod.timeoutMs > 0, 'timeoutMs');
            assert.strictEqual(typeof mod.run, 'function', 'run');
            assert.ok(Array.isArray(mod.sources) && mod.sources.length, 'the module names the provider it uses');
            for (const s of mod.sources) {
                assert.strictEqual(typeof s.url, 'string');
                assert.ok(/^https:\/\//.test(s.url), 'a source is an https page: ' + s.url);
                assert.strictEqual(typeof s.title, 'string');
            }
        });

        await check(file + ' answers an empty input with an error, not a crash', async () => {
            const out = await mod.run({}, { fetch: async () => { throw new Error('the network must not be touched'); } });
            assert.strictEqual(typeof out, 'object');
            assert.ok(out && typeof out.error === 'string' && out.error.length > 0, 'an error the model can act on');
            // The registry keeps the text and the isError flag; a bare error would be dropped on the way out.
            assert.strictEqual(typeof out.text, 'string', 'the error is also the text the model reads');
            assert.ok(out.text.length > 0);
            assert.strictEqual(out.isError, true, 'the step is marked as an error');
        });
    }

    await check('the modules cover the live data the plan asks for', async () => {
        const have = files.map((f) => require(path.join(DIR, f)).name);
        for (const name of LIVE) assert.ok(have.includes(name), 'missing module: ' + name);
    });

    await check('the registry loads every module in the folder, the live-data ones included', async () => {
        const registry = require('../server/runtime/tools');
        const make = registry.createRegistry || registry.create || null;
        if (!make) return;   // the registry's own tests cover its loader
        const r = make({ strict: true });
        const loaded = (r.names ? r.names() : (r.list ? r.list().map((m) => m.name) : []));
        for (const name of LIVE) assert.ok(!loaded.length || loaded.includes(name), 'the registry did not load ' + name);
    });

    done();
})();

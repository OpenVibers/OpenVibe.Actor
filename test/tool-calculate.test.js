'use strict';
// calculate: exact arithmetic, the fixed set of functions, unit conversion, and no way out of the
// parser (no eval, no Function, no shell).
const assert = require('assert');
const calculate = require('../server/runtime/tools/calculate');
const { check, done } = require('./helpers/boot');

const noNetwork = { fetch: async () => { throw new Error('this tool must not touch the network'); } };

const run = async (expression) => await calculate.run({ expression }, noNetwork);

(async () => {
    await check('arithmetic is done exactly', async () => {
        const out = await run('((12 + 8) * 3) / 4');
        assert.ok(!out.error, out.error);
        assert.strictEqual(out.data.value, 15);
        assert.ok(out.text.includes('15'), out.text);
    });

    await check('whole numbers stay whole, to the last digit', async () => {
        const out = await run('123456789012345678901 * 2');
        assert.ok(!out.error, out.error);
        assert.strictEqual(out.data.value, '246913578024691357802');
        assert.strictEqual(out.data.exact, true);
        assert.ok(out.text.includes('exact'), out.text);
    });

    await check('powers, brackets and division work', async () => {
        assert.strictEqual((await run('2^10')).data.value, 1024);
        assert.strictEqual((await run('7 / 2')).data.value, 3.5);
        assert.strictEqual((await run('1 / 3')).data.value, 0.333333333333);
        assert.strictEqual((await run('-2^2')).data.value, -4);
        assert.strictEqual((await run('(2 + 3) * (4 - 1)')).data.value, 15);
        assert.strictEqual((await run('17 % 5')).data.value, 2);
    });

    await check('the functions and the constants are there', async () => {
        assert.strictEqual((await run('sqrt(144) + 2^3')).data.value, 20);
        assert.strictEqual((await run('round(3.14159, 2)')).data.value, 3.14);
        assert.strictEqual((await run('max(3, 9, 4)')).data.value, 9);
        assert.strictEqual((await run('gcd(12, 18)')).data.value, 6);
        assert.strictEqual((await run('fact(5)')).data.value, 120);
        assert.ok(Math.abs((await run('pi')).data.value - Math.PI) < 1e-9);
    });

    await check('units are converted', async () => {
        const km = await run('10 km to miles');
        assert.ok(!km.error, km.error);
        assert.ok(Math.abs(km.data.value - 6.21371) < 0.0001, km.data.value);
        assert.strictEqual(km.data.kind, 'conversion');
        const f = await run('72 F to C');
        assert.ok(Math.abs(f.data.value - 22.2222) < 0.001, f.data.value);
        const kg = await run('100 kg in pounds');
        assert.ok(Math.abs(kg.data.value - 220.462) < 0.001, kg.data.value);
        const hours = await run('90 minutes to hours');
        assert.strictEqual(hours.data.value, 1.5);
    });

    await check('two different kinds of unit are not converted into each other', async () => {
        const out = await run('10 kg to miles');
        assert.ok(out.error, 'there is an error');
        assert.ok(out.error.includes('not a'), out.error);
    });

    await check('nothing but arithmetic gets through', async () => {
        for (const expression of ['process.exit(1)', 'require("fs")', 'globalThis', 'constructor', 'foo()', '2 +', 'sqrt(-1)', '1 / 0']) {
            const out = await run(expression);
            assert.ok(out.error, 'the expression was refused: ' + expression);
            assert.strictEqual(typeof out.error, 'string');
        }
    });

    await check('an empty expression is an error, not a crash', async () => {
        const out = await calculate.run({}, noNetwork);
        assert.ok(out.error && out.error.includes('expression'), out.error);
    });

    done();
})();

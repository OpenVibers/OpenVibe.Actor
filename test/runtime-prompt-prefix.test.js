'use strict';
/**
 * The prompt prefix stays byte-identical between tasks (stage S3, cache-stable prompts).
 *
 *   - the system prompt keeps its rules first and today's date, the plan, the ledger and a demoted-tools note last,
 *     so two tasks share the whole stable prefix and a provider's cache breakpoint never covers a date;
 *   - the tool definitions serialize the same way on every assembly, so a cache is not lost to tool order.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { SYSTEM } = require('../server/runtime/loop');
const { createRegistry } = require('../server/runtime/tools');

const results = [];
const ok = async (name, fn) => { try { await fn(); console.log(`  ✓ ${name}`); } catch (e) { results.push(e); console.log(`  ✗ ${name}\n      ${(e.stack || String(e)).split('\n').slice(0, 8).join('\n      ')}`); } };

function tempTools(files) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'actor-prefix-'));
    for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), body);
    return dir;
}
const tool = (name) => `module.exports = { name: ${JSON.stringify(name)}, description: ${JSON.stringify(`The ${name} tool.`)}, input: { type: 'object', properties: { q: { type: 'string' } } }, scope: 'public', run: async () => ({ text: 'ok' }) };\n`;

(async () => {
    await ok('two tasks share the whole rules prefix; the date and the plan come after it', async () => {
        const a = SYSTEM({ date: '2026-11-09', plan: '1. Look up the price' });
        const b = SYSTEM({ date: '2027-01-01', plan: '1. Compare two offers', ledger: 'Progress: 1 of 2', note: 'Offered last: slow_tool.' });
        const at = a.indexOf('Today is ');
        const stableAt = a.indexOf('Your plan:');
        assert.ok(at > 0, 'the date is in the prompt');
        assert.ok(a.indexOf('How the answer is grounded:') < stableAt, 'the rules come before the plan');
        assert.ok(stableAt > 1500, `the stable prefix is the whole rules block (${stableAt} bytes)`);
        assert.strictEqual(a.slice(0, stableAt), b.slice(0, stableAt), 'the rules prefix is byte-identical between two tasks');
        assert.ok(at > stableAt && b.indexOf('Today is ') > stableAt, 'the date comes after the rules');
        assert.strictEqual(a.split('Today is ').length, 2, 'the date appears once');
        assert.ok(b.indexOf('1. Compare two offers') < b.indexOf('Today is '), 'the plan stays before the date');
        assert.ok(b.indexOf('Progress: 1 of 2') < b.indexOf('Today is '), 'the ledger stays before the date');
        assert.ok(b.indexOf('Offered last: slow_tool.') < b.indexOf('Today is '), 'the demoted-tools note stays before the date');
    });

    await ok('tool definitions serialize identically on every assembly', async () => {
        const dir = tempTools({ 'zebra.js': tool('zebra'), 'alpha.js': tool('alpha'), 'middle.js': tool('middle') });
        const first = createRegistry({ dir, strict: true, log: { warn() {} } }).definitions({ requester: 'user:usr_1' });
        const second = createRegistry({ dir, strict: true, log: { warn() {} } }).definitions({ requester: 'user:usr_1' });
        assert.strictEqual(JSON.stringify(first), JSON.stringify(second));
        assert.deepStrictEqual(first.map((d) => d.function.name), ['alpha', 'middle', 'zebra'], 'files load in a fixed order');
    });

    if (results.length) {
        for (const e of results) console.error(e.stack || String(e));
        process.exitCode = 1;
    }
})();

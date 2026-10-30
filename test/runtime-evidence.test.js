'use strict';
/**
 * The evidence ledger (Actor v2): every tool result is one item E1, E2, …; the answer cites [E3]; only existing ids
 * count, the prompt block carries each item, and the result form is clipped.
 */
const assert = require('assert');
const { createLedger } = require('../server/runtime/evidence');

(async () => {
    const results = [];
    const ok = async (name, fn) => { try { await fn(); console.log(`  ✓ ${name}`); } catch (e) { results.push(e); console.log(`  ✗ ${name}\n      ${(e.stack || String(e)).split('\n').slice(0, 5).join('\n      ')}`); } };

    await ok('ids are assigned E1, E2, … in the order the tools answered', async () => {
        const t0 = 1_700_000_000_000;
        const ledger = createLedger({ now: () => t0 });
        const a = ledger.add({ tool: 'search_web', input: { query: 'btc' }, text: '{"price":87432}', data: { price: 87432 }, sources: [{ url: 'https://example.org/btc', title: 'BTC' }] });
        const b = ledger.add({ tool: 'run_tool', input: { tool: 'mx' }, text: '{"records":[]}' });
        assert.strictEqual(a.id, 'E1');
        assert.strictEqual(b.id, 'E2');
        assert.deepStrictEqual(a.sources, [{ url: 'https://example.org/btc', title: 'BTC' }]);
        assert.strictEqual(a.at, new Date(t0).toISOString());
        assert.strictEqual(ledger.size(), 2);
        assert.strictEqual(ledger.sourceUrls().length, 1);
    });

    await ok('citations are the [E#] an answer carries, existing and once each, in order', async () => {
        const ledger = createLedger();
        ledger.add({ tool: 'a', text: 'one' });
        ledger.add({ tool: 'b', text: 'two' });
        assert.deepStrictEqual(ledger.citations('A [E2], then [E1], again [E2], and a fake [E9] and [E0].'), ['E2', 'E1']);
        assert.deepStrictEqual(ledger.citations('no citations here'), []);
    });

    await ok('the prompt block names each item and clips long text; the result form is smaller', async () => {
        const ledger = createLedger({ clip: 50 });
        ledger.add({ tool: 'search_web', input: { query: 'q' }, text: 'x'.repeat(500), sources: [{ url: 'https://example.org/a', title: 'A' }, { url: 'https://example.org/b', title: 'B' }] });
        const block = ledger.forPrompt(2000);
        assert.match(block, /^E1 \[search_web\]/);
        assert.match(block, /x{10}/);
        const result = ledger.forResult()[0];
        assert.strictEqual(result.id, 'E1');
        assert.strictEqual(result.sources.length, 2);
        assert.ok(result.text.length <= 2000);
        assert.strictEqual(ledger.get('E1').tool, 'search_web');
        assert.strictEqual(ledger.get('E9'), null);
    });

    if (results.length) { console.log(`\n${results.length} failed`); process.exit(1); }
    console.log('\nall passed');
})();

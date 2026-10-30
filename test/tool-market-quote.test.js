'use strict';
// market_quote and currency_convert: the price, the change, the time of the quote and the source.
const assert = require('assert');
const quote = require('../server/runtime/tools/market_quote');
const convert = require('../server/runtime/tools/currency_convert');
const { fixtureFetch, ctxOf } = require('./helpers/tool-fixtures');
const { check, done } = require('./helpers/boot');

const cryptoRoutes = {
    'api.coingecko.com/api/v3/simple/price': (url) => (url.includes('ids=ethereum') ? 'coingecko-ethereum-usd.json' : 'coingecko-bitcoin-usd.json'),
    'api.frankfurter.dev/v1/latest': 'frankfurter-usd-eur.json',
};

(async () => {
    await check('market_quote prices a coin and says when the price was', async () => {
        const f = fixtureFetch(cryptoRoutes);
        const out = await quote.run({ asset: 'bitcoin' }, ctxOf(f.fetchImpl));
        assert.ok(!out.error, out.error);
        assert.strictEqual(out.data.kind, 'crypto');
        assert.strictEqual(out.data.price, 77933);
        assert.strictEqual(out.data.currency, 'USD');
        assert.ok(Math.abs(out.data.change_24h_percent + 2.5489) < 0.001, 'the 24 hour change');
        assert.strictEqual(out.data.quote_time, new Date(1793350664 * 1000).toISOString());
        assert.ok(out.text.includes('77,933'), out.text);
        assert.ok(out.sources.some((s) => s.url.includes('coingecko.com')), 'the source is CoinGecko');
    });

    await check('market_quote takes a ticker as well as a name', async () => {
        const f = fixtureFetch(cryptoRoutes);
        const out = await quote.run({ asset: 'ETH' }, ctxOf(f.fetchImpl));
        assert.ok(!out.error, out.error);
        assert.ok(f.calls[0].url.includes('ids=ethereum'), f.calls[0].url);
    });

    await check('market_quote answers a currency pair from the ECB rates', async () => {
        const f = fixtureFetch(cryptoRoutes);
        const out = await quote.run({ asset: 'USD/EUR' }, ctxOf(f.fetchImpl));
        assert.ok(!out.error, out.error);
        assert.strictEqual(out.data.kind, 'fx');
        assert.strictEqual(out.data.base, 'USD');
        assert.strictEqual(out.data.quote, 'EUR');
        assert.strictEqual(out.data.price, 0.89847);
        assert.strictEqual(out.data.quote_time, '2026-10-29');
        assert.ok(out.text.includes('Central Bank reference rate'), out.text);
        assert.ok(out.sources.some((s) => s.url.includes('frankfurter')), 'the source is Frankfurter');
    });

    await check('market_quote says it has no stock source rather than inventing one', async () => {
        const f = fixtureFetch(cryptoRoutes);
        const out = await quote.run({ asset: 'AAPL' }, ctxOf(f.fetchImpl));
        assert.ok(out.error, 'a stock is not quoted');
        assert.ok(quote.description.toLowerCase().includes('stocks are not'), 'the description says stocks are left out');
    });

    await check('currency_convert converts an amount and names the rate day', async () => {
        const f = fixtureFetch({
            'api.frankfurter.dev/v1/currencies': 'frankfurter-currencies.json',
            'api.frankfurter.dev/v1/latest': 'frankfurter-usd-eur.json',
        });
        const out = await convert.run({ amount: 250, from: 'USD', to: 'EUR' }, ctxOf(f.fetchImpl));
        assert.ok(!out.error, out.error);
        assert.strictEqual(out.data.rates[0].currency, 'EUR');
        assert.strictEqual(out.data.rates[0].rate, 0.89847);
        assert.ok(Math.abs(out.data.rates[0].value - 224.6175) < 0.001, 'the converted amount');
        assert.strictEqual(out.data.date, '2026-10-29');
        assert.ok(out.text.includes('2026-10-29'), out.text);
        assert.ok(out.sources.some((s) => s.url.includes('frankfurter')), 'the source is Frankfurter');
    });

    await check('currency_convert refuses a currency the rates do not have', async () => {
        const f = fixtureFetch({
            'api.frankfurter.dev/v1/currencies': 'frankfurter-currencies.json',
            'api.frankfurter.dev/v1/latest': 'frankfurter-usd-eur.json',
        });
        const out = await convert.run({ from: 'USD', to: 'XYZ' }, ctxOf(f.fetchImpl));
        assert.ok(out.error && out.error.includes('XYZ'), out.error);
    });

    done();
})();

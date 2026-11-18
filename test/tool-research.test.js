'use strict';
// Research like a person checking offers (the owner, 11-18: a screenshot of an agent reading OVHcloud's order catalog
// and availability API and reading many sites side by side, "improve our system so that it can do shit like this"):
//   - fetch_data reads a public API's JSON, narrows it with pick and find, gives a big answer's shape, reads CSV,
//     sends a web page to read_page, says a redirect and an error status, and refuses a private address (the guard);
//   - read_pages reads up to 8 pages at once, each under its URL, a failure beside the others.
const assert = require('assert');
const fetchData = require('../server/runtime/tools/fetch_data');
const readPages = require('../server/runtime/tools/read_pages');
const { check, done } = require('./helpers/boot');

const catalog = {
    catalogId: 1234, locale: { currencyCode: 'USD' },
    plans: [
        { planCode: '24sysgame02-v1-us', invoiceName: 'SYS-GAME-2', pricings: [{ interval: 1, price: 5610000000 }], blobs: { technical: { memory: { size: 64 } } } },
        { planCode: '24sysgame02-128-us', invoiceName: 'SYS-GAME-2 128 GB', pricings: [{ interval: 1, price: 8410000000 }] },
        { planCode: '24rise01-us', invoiceName: 'RISE-1', pricings: [{ interval: 1, price: 4999000000 }] },
    ],
    addons: Array.from({ length: 400 }, (_, i) => ({ planCode: `addon-${i}`, invoiceName: `Addon ${i}`, pricings: [{ price: i }] })),
};
const fake = (answers) => async (url) => {
    const a = answers[url];
    if (!a) throw new Error('getaddrinfo ENOTFOUND');
    if (a instanceof Error) throw a;
    return { status: a.status || 200, headers: a.headers || { 'content-type': 'application/json' }, body: Buffer.from(typeof a.body === 'string' ? a.body : JSON.stringify(a.body)) };
};

(async () => {
    const api = 'https://api.us.ovhcloud.com/1.0/order/catalog/public/eco?ovhSubsidiary=US';
    const ctx = { request: fake({
        [api]: { body: catalog },
        'https://example.com/prices.csv': { headers: { 'content-type': 'text/csv' }, body: 'plan,ram,usd\nVPS-3,24,12.32\nVPS-4,48,23.37\nRS-4000,32,44.10' },
        'https://example.com/offer': { headers: { 'content-type': 'text/html' }, body: '<!doctype html><title>Offer</title>' },
        'https://example.com/moved': { status: 301, headers: { location: 'https://example.com/new' }, body: '' },
        'https://example.com/missing.json': { status: 404, body: { error: 'not found' } },
    }) };

    await check('fetch_data: a big catalog comes back as its shape, so the next call can pick', async () => {
        const out = await fetchData.run({ url: api }, ctx);
        assert.ok(!out.error, out.error);
        assert.match(out.text, /answered 200, JSON/);
        assert.match(out.text, /Too big to read whole/);
        assert.strictEqual(out.data.shape.plans.items, 3);
        assert.strictEqual(out.data.shape.addons.items, 400);
        assert.deepStrictEqual(out.sources, [{ url: api, title: 'api.us.ovhcloud.com' }]);
    });

    await check('fetch_data: find keeps the items that mention every word; pick narrows to a path, * fans out', async () => {
        const found = await fetchData.run({ url: api, find: 'SYS-GAME-2 us' }, ctx);
        assert.match(found.text, /2 items mention "sys-game-2 us"/);
        assert.ok(/24sysgame02-v1-us/.test(found.text) && /24sysgame02-128-us/.test(found.text) && !/24rise01/.test(found.text), found.text);
        assert.ok(found.text.includes('5610000000'), 'the price came with it');
        const codes = await fetchData.run({ url: api, pick: 'plans.*.planCode' }, ctx);
        assert.ok(codes.text.endsWith('["24sysgame02-v1-us","24sysgame02-128-us","24rise01-us"]'), codes.text);
        const first = await fetchData.run({ url: api, pick: 'plans.0.blobs.technical.memory.size' }, ctx);
        assert.ok(first.text.endsWith('\n64'), first.text);
        const none = await fetchData.run({ url: api, pick: 'nothing.here' }, ctx);
        assert.match(none.text, /Nothing is at "nothing.here"/);
    });

    await check('fetch_data: CSV lines filtered with their header; a web page goes to read_page; a redirect and an error say so', async () => {
        const csv = await fetchData.run({ url: 'https://example.com/prices.csv', find: 'vps' }, ctx);
        assert.ok(/plan,ram,usd\nVPS-3,24,12.32\nVPS-4,48,23.37$/.test(csv.text), csv.text);
        const page = await fetchData.run({ url: 'https://example.com/offer' }, ctx);
        assert.match(page.text, /use read_page/);
        const moved = await fetchData.run({ url: 'https://example.com/moved' }, ctx);
        assert.match(moved.text, /answered 301: it moved to https:\/\/example.com\/new/);
        const missing = await fetchData.run({ url: 'https://example.com/missing.json' }, ctx);
        assert.match(missing.text, /answered 404 \(an error\)/);
    });

    await check('fetch_data: the guard refuses http, a private address and a password in the URL', async () => {
        for (const url of ['http://example.com/a.json', 'https://127.0.0.1/a.json', 'https://169.254.169.254/latest/meta-data', 'https://user:pw@example.com/a.json']) {
            const out = await fetchData.run({ url }, {});
            assert.ok(out.error && /could not be read/.test(out.error), `${url}: ${JSON.stringify(out)}`);
        }
    });

    await check('read_pages: up to 8 at once, each under its URL, a failure beside the others', async () => {
        const seen = [];
        let inFlight = 0;
        let most = 0;
        const runTool = async (id, input) => {
            assert.strictEqual(id, 'read');
            assert.strictEqual(input.max_chars, 4000);
            seen.push(input.url);
            inFlight += 1; most = Math.max(most, inFlight);
            await new Promise((ok) => setTimeout(ok, 20));
            inFlight -= 1;
            if (input.url.includes('down')) throw new Error('the site did not answer');
            return { title: `Page ${input.url.slice(-1)}`, text: `Offer text of ${input.url}` };
        };
        const urls = ['https://a.example/1', 'https://b.example/2', 'https://down.example/3', 'https://c.example/4', 'https://a.example/1'];
        const out = await readPages.run({ urls }, { service: { runTool }, config: { services: { toolsUrl: 'http://tools.test' } } });
        assert.strictEqual(seen.length, 4, 'the same page once');
        assert.ok(most >= 3, `read at once (${most} together)`);
        const data = out.data.pages;
        assert.deepStrictEqual(data.map((p) => p.url), ['https://a.example/1', 'https://b.example/2', 'https://down.example/3', 'https://c.example/4']);
        assert.match(data[2].error, /did not answer/);
        assert.strictEqual(out.sources.length, 3);
        assert.match(out.text, /"read":3,"failed":1/);
        const many = await readPages.run({ urls: Array.from({ length: 12 }, (_, i) => `https://x.example/${i}`) }, { service: { runTool }, config: {} });
        assert.strictEqual(many.data.pages.length, 8, 'at most 8');
    });

    done();
})();

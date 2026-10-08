'use strict';
/**
 * The public crawl artifacts (plan T11), fetched from the booted app: /robots.txt, /sitemap.xml,
 * /llms.txt, /llms-full.txt and the home page's JSON-LD. Each is served with the right status and
 * content type, carries at least one real entry, lists public pages only, and takes lastmod from the
 * site's own data (STATUS.json) — never from the clock.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { boot, check, done } = require('./helpers/boot');

const STATUS_UPDATED = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'STATUS.json'), 'utf8')).updated;
// llms.txt names the public machine endpoints (/api/v1/agents, /api/v1/route, /limits.json) on purpose, so only tasks and sign-in are private there.
const PRIVATE = ['/tasks', '/auth/', '/api/', '/limits.json'];

(async () => {
    const t = await boot();
    try {
        await check('robots.txt: 200 text/plain, sign-in, the API and tasks disallowed, the public pages crawlable, sitemap named', async () => {
            const r = await t.get('/robots.txt');
            assert.strictEqual(r.status, 200);
            assert.match(r.headers.get('content-type'), /^text\/plain/);
            assert.match(r.headers.get('cache-control') || '', /public, max-age=\d+/);
            for (const d of ['/auth/', '/api/', '/tasks']) assert.ok(r.text.includes(`Disallow: ${d}`), `missing Disallow: ${d}`);
            for (const d of ['/agents', '/docs', '/updates']) assert.ok(!r.text.includes(`Disallow: ${d}`), `${d} must stay crawlable`);
            assert.ok(r.text.includes('Sitemap: https://openvibe.actor/sitemap.xml'), 'sitemap not named');
            assert.ok(/^User-agent: \*$/m.test(r.text), 'no User-agent: * group');
        });

        await check('sitemap.xml: 200 application/xml, real entries, lastmod from the data', async () => {
            const r = await t.get('/sitemap.xml');
            assert.strictEqual(r.status, 200);
            assert.match(r.headers.get('content-type'), /^application\/xml/);
            assert.match(r.headers.get('cache-control') || '', /public, max-age=\d+/);
            for (const p of ['/', '/agents', '/docs', '/updates']) assert.ok(r.text.includes(`<loc>https://openvibe.actor${p}</loc>`), `no ${p} entry`);
            for (const p of ['/tasks', '/api/v1/agents', '/limits.json']) assert.ok(!r.text.includes(`<loc>https://openvibe.actor${p}</loc>`), `${p} is not a public page`);
            const lastmods = [...r.text.matchAll(/<lastmod>([^<]+)<\/lastmod>/g)].map((m) => m[1]);
            assert.ok(lastmods.length > 0, 'no lastmod anywhere');
            assert.ok(lastmods.every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)), `bad lastmod: ${lastmods.slice(0, 3)}`);
            assert.ok(lastmods.every((d) => d === STATUS_UPDATED), `lastmod must come from STATUS.json (${STATUS_UPDATED}), got ${[...new Set(lastmods)].join(', ')}`);
            for (const p of PRIVATE) assert.ok(!r.text.includes(`https://openvibe.actor${p}`), `private path in sitemap: ${p}`);
        });

        await check('llms.txt: 200 text/plain, real links, nothing private', async () => {
            const r = await t.get('/llms.txt');
            assert.strictEqual(r.status, 200);
            assert.match(r.headers.get('content-type'), /^text\/plain/);
            assert.match(r.headers.get('cache-control') || '', /public, max-age=\d+/);
            assert.ok(r.text.startsWith('# OpenVibe.Actor'), 'no title');
            assert.ok(r.text.includes('(https://openvibe.actor/agents)'), 'no agents link');
            assert.ok(r.text.includes('(https://openvibe.actor/docs)'), 'no API link');
            assert.ok(r.text.includes('(https://openvibe.services)'), 'no pointer to the developer platform');
            assert.ok(r.text.includes('https://openvibe.actor/sitemap.xml'), 'sitemap not listed');
            assert.ok(r.text.includes('(https://openvibe.actor/llms-full.txt)'), 'llms-full.txt not listed');
            for (const p of ['/tasks', '/auth/']) assert.ok(!r.text.includes(`https://openvibe.actor${p}`), `private path in llms.txt: ${p}`);
        });

        await check('llms-full.txt: 200 text/plain, the site title, and every page the sitemap lists', async () => {
            const r = await t.get('/llms-full.txt');
            assert.strictEqual(r.status, 200);
            assert.match(r.headers.get('content-type'), /^text\/plain/);
            assert.match(r.headers.get('cache-control') || '', /public, max-age=\d+/);
            assert.ok(r.text.startsWith('# OpenVibe.Actor'), 'no title');
            const sitemap = await t.get('/sitemap.xml');
            const locs = [...sitemap.text.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
            assert.ok(locs.length >= 4, `sitemap too small: ${locs.length}`);
            for (const loc of locs) assert.ok(r.text.includes(loc), `llms-full.txt is missing ${loc}`);
            assert.ok(r.text.includes('URL: https://openvibe.actor/agents\n'), 'no /agents entry');
            for (const p of PRIVATE) assert.ok(!r.text.includes(`https://openvibe.actor${p}`), `private path in llms-full.txt: ${p}`);
            assert.ok(!r.text.includes('https://openvibe.actor/tasks'), 'tasks path in llms-full.txt');
        });

        await check('home page: WebSite + the site\'s primary type, the same for every crawler', async () => {
            const r = await t.get('/');
            assert.strictEqual(r.status, 200);
            const blocks = [...r.text.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));
            const types = blocks.map((b) => b['@type']);
            assert.ok(types.includes('WebSite'), `no WebSite node: ${types}`);
            assert.ok(types.includes('WebApplication'), `no primary-type node: ${types}`);
            const site = blocks.find((b) => b['@type'] === 'WebSite');
            assert.strictEqual(site.url, 'https://openvibe.actor');
            assert.strictEqual(site.name, 'OpenVibe.Actor');
            const page = blocks.find((b) => b['@type'] === 'WebPage');
            assert.strictEqual(page.url, 'https://openvibe.actor/');
        });
    } finally { await t.close(); }
    done();
})();

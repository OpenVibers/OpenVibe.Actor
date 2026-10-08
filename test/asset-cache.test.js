'use strict';
/**
 * The one cache rule Actor serves assets with (openvibe-shared/cache-policy, plan T11): a URL
 * whose ?v= is the asset's current hash is immutable for a year, because those bytes can never
 * change under the same URL; a wrong or missing ?v= may change at any moment, so it gets the
 * short public window with a day of stale-while-revalidate. The values are pinned here against
 * the module, not re-stated: the site never picks its own numbers.
 */
const assert = require('assert');
const cache = require('openvibe-shared/cache-policy');
const { assetVersion } = require('../server/render/layout');
const { boot, check, done } = require('./helpers/boot');

const ASSET = 'css/actor.css';
const SHORT = 'public, max-age=300, stale-while-revalidate=86400';

(async () => {
    const t = await boot();
    try {
        await check('the current ?v=<assetVersion> is immutable for a year', async () => {
            const r = await t.get(`/${ASSET}?v=${assetVersion(ASSET)}`);
            assert.strictEqual(r.status, 200);
            assert.strictEqual(r.headers.get('cache-control'), 'public, max-age=31536000, immutable');
        });

        await check('a wrong-but-hex ?v= is never pinned', async () => {
            const r = await t.get(`/${ASSET}?v=deadbeefdeadbeef`);
            assert.strictEqual(r.status, 200);
            assert.strictEqual(r.headers.get('cache-control'), SHORT);
        });

        await check('no ?v= gets the short public window', async () => {
            const r = await t.get(`/${ASSET}`);
            assert.strictEqual(r.status, 200);
            assert.strictEqual(r.headers.get('cache-control'), SHORT);
        });

        await check('those values are the module\'s, not Actor\'s own', () => {
            assert.strictEqual(cache.assetHeaders(ASSET, { hashed: true }), 'public, max-age=31536000, immutable');
            assert.strictEqual(cache.assetHeaders(ASSET, { hashed: false }), SHORT);
            assert.strictEqual(cache.htmlHeaders({ private: true }), 'private, no-store');
        });
    } finally { await t.close(); }
    done();
})().catch((e) => { console.error(e); process.exit(1); });

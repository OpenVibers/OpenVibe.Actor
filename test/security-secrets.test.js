'use strict';
/**
 * Codes' own secrets never leave in a response, an event or a log line (roadmap WS-R task 5, the
 * internal-secret class). Codes' environment holds one: its Network OAuth client secret, a sentinel here. Every route
 * the booted app has (listed from Express's router stack) is requested as anonymous, a signed-in person and a Network
 * admin with real and nonsense ids, plus the sign-in callback with a forged code (it posts the client secret to
 * Network), the developer console's old addresses (now redirects), unknown paths and every write route with a broken
 * body. No body or header may carry it, nor may the database or the captured log lines.
 *
 *   node test/security-secrets.test.js
 */
const assert = require('assert');
const appModule = require('../server/app');
let capturedApp = null;
const realCreate = appModule.createApp;
appModule.createApp = async (...a) => { const built = await realCreate(...a); capturedApp = built.app; return built; };
const { boot, check, done } = require('./helpers/boot');
const { getPaths, crawl, listRoutes, expand, leaks, nextAddress } = require('./security-crawl');

const SECRETS = { OV_OAUTH_CLIENT_SECRET: 'sentinel-not-a-secret-codes-oauth-client' };

(async () => {
    const t = await boot({ env: SECRETS });
    const dev = t.network.addUser('dev');
    const staff = t.network.addUser('root', { role: 'admin' });

    await check('every GET route, as three people, with real and nonsense ids: no sentinel', async () => {
        const nonsense = ['nope', "'\"<x>", 'x'.repeat(300)];
        const values = () => ['claude-code', ...nonsense];
        const paths = getPaths(capturedApp, values, {
            query: 'q=x&code=forged&state=forged&next=%2F',
            extra: ['/api/health', '/api/ready', '/metrics', '/release.json', '/auth/callback?code=forged&state=forged', '/callback?code=forged&state=forged', '/api/nope', '/nope', '/.env', '/api/%',
                '/projects', '/docs/api', '/oauth/test-callback?code=x', '/api/v1/releases/rel_x', '/docs/harnesses'],
        });
        const r = await crawl(t, paths, { anonymous: null, dev, staff }, () => SECRETS);
        assert.ok(r.answered >= paths.length * 2, `${r.answered} answers`);
        assert.deepStrictEqual(r.found, []);
    });

    await check('every write route with a broken body, anonymous and as the developer: no sentinel', async () => {
        const found = [];
        const values = () => ['x'];
        for (const route of listRoutes(capturedApp)) {
            for (const method of route.methods.filter((m) => ['post', 'put', 'patch', 'delete'].includes(m))) {
                for (const p of expand(route.path, values)) {
                    for (const as of [null, dev]) {
                        const r = await t.get(p, { method: method.toUpperCase(), ...(as ? { as } : {}), body: '{"broken": ', headers: { 'content-type': 'application/json', 'x-forwarded-for': nextAddress() } });
                        for (const l of leaks(r, SECRETS)) found.push(`${method} ${p} → ${r.status} carries ${l.label}`);
                    }
                }
            }
        }
        assert.deepStrictEqual(found, []);
    });

    await check('the database and the captured log lines carry no sentinel', async () => {
        const text = await t.dbDump() + t.logs();
        for (const [k, v] of Object.entries(SECRETS)) assert.ok(!text.includes(v), `${k} in the database or the logs`);
    });

    await t.close();
    done();
})().catch((e) => { console.error(e); process.exit(1); });

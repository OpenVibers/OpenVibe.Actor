'use strict';
/**
 * D11 owner settings: the actor.ai namespace and /internal/config.
 * Env pins win; actor.config.manage is required; an owner change applies live; no KEK still works;
 * a secret-class value never leaves a summary, snapshot or history.
 */
const assert = require('assert');
const { serviceAuth } = require('openvibe-contracts');
const { boot, check, done } = require('./helpers/boot');

const CAP = ['actor.config.manage'];
const OWNER = 'usr_01JAB2C3D4E5F6G7H8J9K0MNPQ';
const SECRET = 'fixture-actor-d11-not-a-credential';

function mint(t, cap = CAP) {
    const now = Math.floor(Date.now() / 1000);
    return serviceAuth.signServiceToken({
        iss: t.network.url, sub: 'svc:network', actor_type: 'service', aud: ['openvibe.actor'], cap,
        iat: now, exp: now + 300, jti: 'tok_actor_config',
    }, t.network.privatePem);
}

(async () => {
    const t = await boot({ env: { ACTOR_AI_CATALOG: '1' } });
    try {
        await check('the summary: schema, the env pin, sealed:false without a KEK', async () => {
            const r = await t.get('/internal/config/actor.ai', { bearer: mint(t) });
            assert.strictEqual(r.status, 200, r.text.slice(0, 300));
            assert.strictEqual(r.json().namespace, 'actor.ai');
            assert.strictEqual(r.json().sealed, false);
            assert.strictEqual(r.json().values.catalog, true);
            assert.deepStrictEqual(r.json().pins.catalog, { env: 'ACTOR_AI_CATALOG', pinned: true });
            assert.ok(!r.text.includes(SECRET));
        });

        await check('a service token without actor.config.manage is refused', async () => {
            const r = await t.get('/internal/config/actor.ai', { bearer: mint(t, ['actor.task.read']) });
            assert.strictEqual(r.status, 403);
            assert.strictEqual(r.json().code, 'capability.denied');
        });

        await check('an env-pinned key is read-only', async () => {
            const r = await t.get('/internal/config/actor.ai', {
                method: 'POST', bearer: mint(t), headers: { 'x-ov-subject': OWNER }, json: { values: { catalog: false }, reason: 'off' },
            });
            assert.strictEqual(r.status, 409, r.text.slice(0, 300));
            assert.strictEqual(r.json().code, 'config.pinned_in_env');
        });
    } finally { await t.close(); }

    const live = await boot();
    try {
        await check('an owner change applies live', async () => {
            assert.strictEqual(live.config.ai.catalog, false);
            const r = await live.get('/internal/config/actor.ai', {
                method: 'POST', bearer: mint(live), headers: { 'x-ov-subject': OWNER }, json: { values: { catalog: true }, reason: 'owner turned it on' },
            });
            assert.strictEqual(r.status, 200, r.text.slice(0, 300));
            assert.strictEqual(r.json().revision, 2);
            assert.strictEqual(live.config.ai.catalog, true);
            assert.ok(live.logs().includes('by user:' + OWNER));
            assert.ok(!live.logs().includes(SECRET));
        });

        await check('with a KEK the store is sealed and boot reseals', async () => {
            const sealed = await boot({ env: { OV_CONFIG_KEKS: 'k1:MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=', OV_CONFIG_KEK_CURRENT: 'k1' } });
            try {
                const r = await sealed.get('/internal/config/actor.ai', { bearer: mint(sealed) });
                assert.strictEqual(r.status, 200, r.text.slice(0, 300));
                assert.strictEqual(r.json().sealed, true);
                assert.strictEqual(r.json().kek, 'k1');
            } finally { await sealed.close(); }
        });

        await check('a secret is write-only and never appears in a summary, snapshot or history', async () => {
            const shared = require('openvibe-shared/config');
            const extra = await shared.createConfigStore({
                db: live.ctx.s.db, service: 'actor', namespace: 'actor.test_secrets',
                schema: { type: 'object', additionalProperties: false, properties: { api_key: { type: 'string' } } },
                classify: () => 'secret',
            });
            const marker = await extra.setSecret('api_key', SECRET, { actor: { type: 'user', id: OWNER }, reason: 'test' });
            assert.strictEqual(marker.redacted, true);
            assert.ok(!JSON.stringify(marker).includes(SECRET));
            const summary = await extra.summary();
            assert.strictEqual(summary.values.api_key.redacted, true);
            assert.ok(!JSON.stringify(summary).includes(SECRET));
            assert.ok(!JSON.stringify(await extra.history()).includes(SECRET));
            assert.ok(!JSON.stringify(await extra.snapshot(1)).includes(SECRET));
        });
    } finally { await live.close(); }
    done();
})().catch((e) => { console.error(e); process.exit(1); });

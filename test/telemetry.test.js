'use strict';
/**
 * Request telemetry (openvibe-sdk/service, plan T1 step 10): app.js builds one collector for service 'actor' with a
 * PostgreSQL sink, a page hit five times flushes as ONE aggregated http.request sample (route template, 2xx, count 5),
 * /metrics and /shared files make none, and the 14-day retention deletes only older rows.
 */
const assert = require('assert');
const { pruneTelemetry } = require('openvibe-sdk/telemetry');
const { boot, check, done } = require('./helpers/boot');
const fs = require('fs');
const path = require('path');

(async () => {
    await check('index.js flushes the collector every minute and clears that tick before the last flush on stop', () => {
        const index = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
        assert.match(index, /ctx\.telemetryTick = setInterval\(\(\) => \{ ctx\.telemetry\.flush\(\)/);
        assert.match(index, /clearInterval\(ctx\.telemetryTick\); if \(ctx\.retention\) await ctx\.retention\.stop\(\); if \(ctx\.telemetry\) await ctx\.telemetry\.stop\(\);/);
    });

    const samples = [];
    const t = await boot({ telemetrySink: async (batch) => { samples.push(...batch); } });
    const requests = () => samples.filter((s) => s.operation === 'http.request');
    try {
        await check('five hits on the home page flush as one http.request sample: template, 2xx, count 5', async () => {
            for (let i = 0; i < 5; i++) assert.strictEqual((await t.get('/')).status, 200);
            await t.ctx.telemetry.flush();
            const home = requests().filter((s) => s.resource === '/' && s.status === '2xx');
            assert.strictEqual(home.length, 1, JSON.stringify(requests()));
            assert.strictEqual(home[0].service, 'actor');
            assert.strictEqual(home[0].extra.count, 5);
        });

        await check('/metrics and a /shared file make no sample', async () => {
            samples.length = 0;
            await t.get('/metrics');
            await t.get('/shared/navbar.js');
            await t.ctx.telemetry.flush();
            assert.deepStrictEqual(requests(), []);
        });

        await check('the table exists and the retention deletes rows older than 14 days, keeping newer ones', async () => {
            const db = t.ctx.s.db;
            await db.query("DELETE FROM telemetry_samples");
            const insert = (days) => db.query("INSERT INTO telemetry_samples (at, service, operation) VALUES (now() - make_interval(days => $1), 'actor', 'http.request')", [days]);
            await insert(20);
            await insert(1);
            assert.strictEqual(await pruneTelemetry({ db, olderThanDays: 14 }), 1);
            assert.strictEqual((await db.query('SELECT count(*)::int AS n FROM telemetry_samples')).rows[0].n, 1);
        });
    } finally { await t.close(); }
    done();
})().catch((e) => { console.error(e); process.exit(1); });

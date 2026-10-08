'use strict';

/**
 * OpenVibe.Actor — process entry. `node server/index.js`
 * Listens on PORT (4950) behind nginx (deploy/).
 */
const { createApp } = require('./app');
const { gracefulStop } = require('openvibe-sdk/service');
const store = require('./tasks/store');

const PRUNE_EVERY_MS = 6 * 60 * 60_000;

/**
 * The process stop (openvibe-sdk/service): the HTTP drain runs, then running tasks are stopped and recorded as
 * interrupted (the person can ask again; nothing re-runs behind their back), the Events subscriptions stop, the JWKS
 * refresher stops and the store closes. Exported so a test can inject `exit` and `signals: false`. `extra` is what the
 * product adds (the Events subscriptions); a test that passes none keeps the skeleton's order.
 */
function createLifecycle({ server, ctx, exit, signals, timers = [], extra = [] }) {
    return gracefulStop({
        name: 'Actor', server, deadlineExitCode: 0, exit, signals, deadlineMs: 10_000,
        close: [() => { for (const t of timers) clearInterval(t); }, () => ctx.engine.stop(), () => ctx.keys.client.stop(), () => ctx.s.close(), ...extra],
    });
}

async function start() {
    const { app, ctx } = await createApp();
    const { config } = ctx;
    // A task a stopped process left open did not finish: it is recorded so, never re-run.
    const interrupted = await store.failInterrupted(ctx.s);
    if (interrupted.length) console.warn(`[Actor] ${interrupted.length} task(s) interrupted by the last stop were marked failed`);

    const server = app.listen(config.port, config.host, () => {
        const available = require('./agents/catalog').list(config).filter((a) => a.available).map((a) => a.id);
        console.log(`[Actor] ${config.nodeEnv} on http://${config.host}:${config.port} → ${config.baseUrl} (db ${ctx.s.db.store}); agents available: ${available.join(', ') || 'none'}`);
    });
    server.keepAliveTimeout = 65_000;
    ctx.keys.client.start();
    // Tasks older than the retention window (tasks/store.js RETENTION_DAYS) go, with their events.
    const prune = setInterval(() => { store.prune(ctx.s).catch((err) => console.warn('[Actor] prune failed:', err && err.message)); }, PRUNE_EVERY_MS);
    prune.unref();

    // Subscribe to the two ADR-033 topics at OpenVibe.Events (idempotent; off without ACTOR_EVENTS_URL and
    // ACTOR_EVENTS_SECRET). The consumer itself is mounted in server/app.js.
    const subscriptions = require('./events-consumer').startSubscriptions({ config, port: config.port, secret: config.events.secrets[0] || '' });
    const extra = [() => { if (subscriptions) subscriptions.stop(); }];
    createLifecycle({ server, ctx, timers: [prune], extra });
    return { server, ctx };
}

if (require.main === module) {
    start().catch((err) => { console.error('[Actor] failed to start:', err); process.exit(1); });
}

module.exports = { start, createLifecycle };

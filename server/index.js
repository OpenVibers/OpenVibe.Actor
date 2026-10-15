'use strict';

/**
 * OpenVibe.Actor — process entry. `node server/index.js`
 * Listens on PORT (4950) behind nginx (deploy/).
 */
const { createApp } = require('./app');
const { gracefulStop } = require('openvibe-sdk/service');
const { startTelemetryRetention } = require('openvibe-sdk/telemetry');
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
        close: [() => { for (const t of timers) clearInterval(t); }, () => ctx.engine.stop(), () => ctx.webhooks.stop(), () => ctx.chatAsks.stop(), () => ctx.keys.client.stop(), async () => { clearInterval(ctx.telemetryTick); if (ctx.retention) await ctx.retention.stop(); if (ctx.telemetry) await ctx.telemetry.stop(); }, () => ctx.s.close(), ...extra],
    });
}

async function start() {
    const { app, ctx } = await createApp();
    const { config } = ctx;
    // A task a stopped process left open did not finish: it is recorded so, never re-run.
    const interrupted = await store.failInterrupted(ctx.s);
    if (interrupted.length) console.warn(`[Actor] ${interrupted.length} task(s) interrupted by the last stop were marked failed`);
    // Their webhooks hear `failed` like any other end; deliveries a stop left half-sent go out again (same delivery id).
    for (const id of interrupted) await ctx.webhooks.enqueue(id, 'failed').catch((err) => console.warn('[Actor] webhook enqueue failed:', id, err && err.message));
    await ctx.webhooks.recover();
    ctx.webhooks.start();
    // Replies to "@actor …" in chat (chat/asks.js), posted once their task has ended.
    ctx.chatAsks.start();

    const server = app.listen(config.port, config.host, () => {
        const available = require('./agents/catalog').list(config).filter((a) => a.available).map((a) => a.id);
        console.log(`[Actor] ${config.nodeEnv} on http://${config.host}:${config.port} → ${config.baseUrl} (db ${ctx.s.db.store}); agents available: ${available.join(', ') || 'none'}`);
    });
    server.keepAliveTimeout = 65_000;
    // telemetry_samples rows older than 14 days go: a minute after start, then daily (openvibe-sdk/telemetry).
    ctx.retention = startTelemetryRetention({ db: ctx.s.db, log: ctx.log || console, olderThanDays: 14 });
    // The request collector aggregates in memory and has no timer of its own (openvibe-sdk 0.46 createHttpTelemetry):
    // this tick writes each minute's samples; the stop clears it and flushes once more.
    ctx.telemetryTick = setInterval(() => { ctx.telemetry.flush().catch(() => {}); }, 60_000);
    ctx.telemetryTick.unref();
    // The Network's signing keys, for its tokens: a self-hosted Actor takes none.
    if (!config.selfHosted.on) ctx.keys.client.start();
    // Tasks older than the retention window (tasks/store.js RETENTION_DAYS) go, with their events.
    const prune = setInterval(() => { store.prune(ctx.s).catch((err) => console.warn('[Actor] prune failed:', err && err.message)); }, PRUNE_EVERY_MS);
    prune.unref();
    const agentTick = setInterval(() => { require('./agents/personal').tick(ctx).catch((err) => console.warn('[Actor] agent tick failed:', err && err.message)); }, 60_000);
    agentTick.unref();

    // Subscribe to the two ADR-033 topics at OpenVibe.Events (idempotent; off without ACTOR_EVENTS_URL and
    // ACTOR_EVENTS_SECRET). The consumer itself is mounted in server/app.js.
    const subscriptions = require('./events-consumer').startSubscriptions({ config, port: config.port, secret: config.events.secrets[0] || '',
        topics: config.chat.asks ? ['chat.message.created'] : [] });
    const extra = [() => { if (subscriptions) subscriptions.stop(); }];
    createLifecycle({ server, ctx, timers: [prune, agentTick], extra });
    return { server, ctx };
}

if (require.main === module) {
    start().catch((err) => { console.error('[Actor] failed to start:', err); process.exit(1); });
}

module.exports = { start, createLifecycle };

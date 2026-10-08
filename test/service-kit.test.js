'use strict';
/**
 * openvibe-sdk/service (plan T16/J2): the entry point's graceful stop runs its close steps in order
 * (the prune timer clears, the task engine stops and records running tasks as cancelled, the JWKS refresher stops, then the
 * store closes: the order the manifest's shutdown.drains lists) and resolves exit 0; a second signal while stopping is a no-op.
 */
const assert = require('assert');
const http = require('http');
const { check, done } = require('./helpers/boot');
const { createLifecycle } = require('../server/index');

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

(async () => {
    await check('the entry point stop clears the timers, stops the engine, stops the JWKS refresher, then closes the store, then exits 0', async () => {
        const steps = [];
        const ctx = {
            engine: { stop: async () => { steps.push('engine.stop'); } },
            keys: { client: { stop: () => { steps.push('keys.stop'); } } },
            s: { close: async () => { steps.push('store.close'); } },
        };
        const server = http.createServer((req, res) => res.end('ok'));
        await listen(server);

        const exits = [];
        const timer = setInterval(() => steps.push('tick'), 1_000_000);
        const lifecycle = createLifecycle({ server, ctx, exit: (code) => exits.push(code), signals: false, timers: [timer] });
        const code = await lifecycle.stop('SIGTERM');

        assert.strictEqual(code, 0);
        assert.deepStrictEqual(exits, [0]);
        assert.deepStrictEqual(steps, ['engine.stop', 'keys.stop', 'store.close']);
        assert.strictEqual(server.listening, false);
    });

    await check('a second signal while stopping is a no-op', async () => {
        let stops = 0; let closes = 0; let exits = 0; let engineStops = 0;
        const ctx = {
            engine: { stop: async () => { engineStops += 1; } },
            keys: { client: { stop: () => { stops += 1; } } },
            s: { close: async () => { closes += 1; } },
        };
        const server = http.createServer((req, res) => res.end('ok'));
        await listen(server);

        const lifecycle = createLifecycle({ server, ctx, exit: () => { exits += 1; }, signals: false });
        const first = lifecycle.stop('SIGTERM');
        const second = lifecycle.stop('SIGINT');

        assert.strictEqual(first, second);
        assert.deepStrictEqual(await Promise.all([first, second]), [0, 0]);
        assert.strictEqual(engineStops, 1);
        assert.strictEqual(stops, 1);
        assert.strictEqual(closes, 1);
        assert.strictEqual(exits, 1);
    });

    done();
})().catch((err) => { console.error(err); process.exit(1); });

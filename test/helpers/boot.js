'use strict';
// Many requests per test file: the per-address limits would answer 429 part-way. The per-caller limits
// (server/http/caller-limits.js) count nobody unless a test asks: boot({ callerLimits: true, limitsNow }).
process.env.ACTOR_RATE_LIMIT_PER_MIN = process.env.ACTOR_RATE_LIMIT_PER_MIN || '100000';
process.env.ACTOR_API_RATE_LIMIT_PER_MIN = process.env.ACTOR_API_RATE_LIMIT_PER_MIN || '100000';
/**
 * Boots Actor on a temp database with a mock Network and stand-in providers (test/helpers/providers.js), captures every
 * log line, and returns a small HTTP client. Every test file gets its own.
 *
 *   const t = await boot();
 *   t.get(path, { as: user, bearer, json, form, headers, method, cookie })
 *   t.signIn(user) → cookie header value (actor_at = a Network user token, as after /auth/callback)
 *   t.waitFor(taskId, states) → the task row once it reaches one of the states
 *   t.providers (state, requests), t.logs(), t.dbDump()
 */
const http = require('http');
const { startNetwork } = require('./mocks');
const { startProviders } = require('./providers');

const captured = [];
for (const m of ['log', 'info', 'warn', 'error']) {
    const orig = console[m].bind(console);
    console[m] = (...a) => { captured.push(a.map(String).join(' ')); if (process.env.VERBOSE) orig(...a); };
}

async function boot(opts = {}) {
    const network = await startNetwork(opts.network || {});
    const providers = await startProviders();
    const env = {
        NODE_ENV: 'test', PORT: '0', BASE_URL: 'https://openvibe.actor', TRUST_PROXY: '1',
        OV_NETWORK_URL: network.url, OV_NETWORK_INTERNAL_URL: network.url,
        OV_OAUTH_CLIENT_ID: 'actor', OV_OAUTH_CLIENT_SECRET: 'actor-secret', COOKIE_SECURE: 'false',
        ...providers.env,
        ...(opts.env || {}),
    };
    for (const [k, v] of Object.entries(opts.env || {})) if (v === null) delete env[k];
    const configLib = require('../../server/config');
    const { createApp } = require('../../server/app');
    const log = { log: (...a) => captured.push(a.map(String).join(' ')), warn: (...a) => captured.push(a.map(String).join(' ')), error: (...a) => captured.push(a.map(String).join(' ')), info: (...a) => captured.push(a.map(String).join(' ')) };

    const config = configLib.load(env);
    const { createStore } = require('../../server/db');
    const testdb = await require('./db').testDb();
    const store = createStore(testdb.db, { now: opts.now });
    const built = await createApp({ config, store, log, limitsNow: opts.limitsNow, callerLimits: opts.callerLimits === true, adapters: opts.adapters, accountSend: opts.accountSend, webhookPost: opts.webhookPost });
    await built.ctx.keys.ensure();
    const server = await new Promise((resolve) => { const s = http.createServer(built.app); s.listen(0, '127.0.0.1', () => resolve(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;

    const signIn = (user) => `actor_at=${network.userToken(user)}`;

    async function get(p, o = {}) {
        const headers = { ...(o.headers || {}) };
        if (o.as) headers.cookie = [signIn(o.as), headers.cookie].filter(Boolean).join('; ');
        if (o.cookie) headers.cookie = o.cookie;
        if (o.bearer) headers.authorization = `Bearer ${o.bearer}`;
        let body = o.body;
        if (o.json !== undefined) { body = JSON.stringify(o.json); headers['content-type'] = 'application/json'; }
        if (o.form) { body = new URLSearchParams({ ...o.form }).toString(); headers['content-type'] = 'application/x-www-form-urlencoded'; }
        const res = await fetch(base + p, { method: o.method || (body ? 'POST' : 'GET'), headers, body, redirect: 'manual' });
        const buf = Buffer.from(await res.arrayBuffer());
        const text = buf.toString('utf8');
        return { status: res.status, headers: res.headers, text, buffer: buf, json() { return JSON.parse(text); } };
    }

    /** Wait until a task reaches one of `states` (default: any end state); returns its row. */
    async function waitFor(id, states = ['succeeded', 'failed', 'cancelled'], timeoutMs = 15_000) {
        const until = Date.now() + timeoutMs;
        for (;;) {
            const row = await require('../../server/tasks/store').getTask(built.ctx.s, id);
            if (row && states.includes(row.state)) return row;
            if (Date.now() > until) throw new Error(`task ${id} stuck in ${row && row.state}`);
            await new Promise((r) => setTimeout(r, 25));
        }
    }

    async function dbDump() {
        const db = built.ctx.s.db;
        const tables = (await db.many("SELECT table_name AS name FROM information_schema.tables WHERE table_schema = current_schema()")).map((r) => r.name);
        return (await Promise.all(tables.map(async (tname) => JSON.stringify(await db.many(`SELECT * FROM "${tname}"`))))).join('\n');
    }

    const t = {
        base, network, providers, config, ctx: built.ctx, get, signIn, waitFor, dbDump,
        logs: () => captured.join('\n'),
        async close() {
            await built.ctx.engine.stop();
            await built.ctx.webhooks.stop();
            await new Promise((r) => server.close(r));
            built.ctx.keys.client.stop();
            await testdb.close();
            await providers.close();
            await network.close();
        },
    };
    return t;
}

let failures = 0;
async function check(name, fn) {
    try { await fn(); process.stdout.write(`  ✓ ${name}\n`); } catch (e) { failures++; process.stdout.write(`  ✗ ${name}\n      ${(e.stack || String(e)).split('\n').slice(0, 8).join('\n      ')}\n`); }
}
function done() { process.stdout.write(failures ? `\n${failures} failed\n` : '\nall passed\n'); process.exit(failures ? 1 : 0); }

module.exports = { boot, check, done };

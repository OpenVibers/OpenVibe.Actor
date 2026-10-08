'use strict';
/**
 * Truthful readiness for GET /api/ready (openvibe-shared/ready, Track O).
 *
 *   db              required  a real round trip to Actor's PostgreSQL store (tasks, events, spend)
 *   agents          required  at least one agent system can take a task (a provider key or an open model is configured)
 *   network_jwks    optional  the Network signing key is loaded; without it nobody can sign in or call the task API
 *   oauth_client    optional  OV_OAUTH_CLIENT_SECRET is set (sign-in needs it)
 *   valkey          optional  shared per-caller limit counters
 */
const { jwksStatus } = require('openvibe-sdk/auth');
const { createReadiness } = require('openvibe-shared/ready');
const catalog = require('./agents/catalog');

function createActorReadiness({ s, config, engine, valkey = null, release = null }) {
    return createReadiness({
        service: 'actor',
        release,
        checks: [
            {
                name: 'db', required: true,
                check: async () => {
                    const r = await s.db.ready();
                    return r.ok ? { ok: true, detail: r.detail } : r.error;
                },
            },
            {
                name: 'agents', required: true,
                check: () => {
                    const list = catalog.list(config);
                    const up = list.filter((a) => a.available).map((a) => a.id);
                    return up.length ? { ok: true, detail: { available: up, tasks: engine.status() } } : 'no agent system is configured (set a provider key or an open model)';
                },
            },
            { name: 'valkey', required: false, check: async () => (valkey ? valkey.ready() : { skipped: 'VALKEY_URL not set: per-caller limits count in this process only' }) },
            {
                name: 'network_jwks', required: false,
                check: () => {
                    const statuses = jwksStatus();
                    if (!statuses.length) return 'no JWKS clients (misconfigured)';
                    const first = statuses[0];
                    if (!first.ready) return 'Network signing key not loaded yet: sign-in and the task API are unavailable';
                    return { ok: true, detail: { keys: first.keys, failures: first.failures, stale: first.stale, fetched_at: first.fetchedAt } };
                },
            },
            { name: 'oauth_client', required: false, check: () => (config.oauth.clientSecret ? true : 'OV_OAUTH_CLIENT_SECRET unset: sign-in cannot complete') },
        ],
    });
}

module.exports = { createActorReadiness };

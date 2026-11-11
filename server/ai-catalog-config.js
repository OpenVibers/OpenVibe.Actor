'use strict';
/**
 * The `actor.ai` namespace (D11 owner settings): the switch that lets Actor's model pickers read OpenVibe.AI's
 * catalog. ACTOR_AI_CATALOG stays the pin: while it is set it wins, is read-only in the summary and a write
 * answers 409 config.pinned_in_env.
 *
 * /internal/config is openvibe-shared/config's adminRoutes, guarded by actor.config.manage (Network's service
 * token only). actor is the owner Network names in X-OV-Subject; X-OV-Fresh: 1 gates a secret or x-danger write
 * (this namespace has neither). Every activation writes one audit line with the actor and the keys, never a value.
 */
const express = require('express');
const shared = require('openvibe-shared/config');
const { serviceAuth, capabilities, http, ids } = require('openvibe-contracts');

const SERVICE = 'actor';
const NAMESPACE = 'actor.ai';
const CAPABILITY = 'actor.config.manage';

const SCHEMA = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'OpenVibe.AI in Actor',
    description: 'Read OpenVibe.AI\'s model catalog so the model picker offers its aliases and exact ids.',
    type: 'object',
    additionalProperties: false,
    required: ['catalog'],
    properties: {
        agentRuns: { type: 'boolean', title: 'Agent run streams', 'x-group': 'Agent activity', 'x-env': 'ACTOR_AGENT_UI', description: 'Serve authorized AG-UI run snapshots and resumable events. Enable after the production check.' },
        catalog: {
            type: 'boolean', title: 'AI model catalog', 'x-group': 'AI Exchange', 'x-env': 'ACTOR_AI_CATALOG',
            description: 'Read GET /v1/models with Actor\'s own service token and cache the answer about five minutes. Off, the model field is the plain one it was before.',
        },
    },
};
const DEFAULTS = Object.freeze({ catalog: false, agentRuns: false });

function bearer(req) {
    const h = String((req.headers && req.headers.authorization) || '');
    return h.startsWith('Bearer ') ? h.slice(7).trim() : null;
}

function capabilityGuard({ keys, config, log }) {
    return async function guard(req, res, next) {
        try {
            const token = bearer(req);
            if (!token) return http.sendProblem(res, 401, 'token.missing', { detail: 'a Network service token is required', ctx: req.ov });
            const publicKey = typeof keys.pemForToken === 'function' ? await keys.pemForToken(token) : keys.get();
            if (!publicKey) return http.sendProblem(res, 503, 'identity.unavailable', { detail: 'the Network signing key is not loaded yet', ctx: req.ov });
            const r = serviceAuth.verifyServiceToken(token, { publicKey, issuer: config.networkIssuer, audience: config.audience });
            if (!r.ok) return http.sendProblem(res, 401, r.code || 'token.invalid', { detail: r.reason || 'the token does not verify', ctx: req.ov });
            const sub = String((r.claims && r.claims.sub) || '');
            if (!sub.startsWith('svc:')) return http.sendProblem(res, 403, 'capability.denied', { detail: `${CAPABILITY} is first-party; an app may not change Actor configuration`, ctx: req.ov });
            const decision = capabilities.check(r.claims, CAPABILITY);
            if (!decision.allowed) return http.sendProblem(res, 403, decision.code || 'capability.denied', { detail: decision.reason || `${CAPABILITY} not granted`, ctx: req.ov });
            req.configClaims = r.claims;
            return next();
        } catch (err) {
            log.error(`[config] actor.ai guard failed: ${(err && err.message) || err}`);
            return http.sendProblem(res, 500, 'internal.error', { detail: 'the configuration request failed', ctx: req.ov });
        }
    };
}

function actor(req) {
    const named = String((req.headers && req.headers['x-ov-subject']) || '').trim();
    return ids.isSubjectId('user', named) ? { type: 'user', id: named } : null;
}

const requireFresh = (req) => String((req.headers && req.headers['x-ov-fresh']) || '') === '1';

async function create({ db, keys, config, env = process.env, log = console, onActivate = null }) {
    // ACTOR_AI_CATALOG has always accepted 1/true; the shared store's boolean pin reads true/1.
    const storeEnv = { ...env };
    if (['1', 'true'].includes(String(storeEnv.ACTOR_AI_CATALOG || '').trim().toLowerCase())) storeEnv.ACTOR_AI_CATALOG = '1';
    const store = await shared.createConfigStore({
        db, service: SERVICE, namespace: NAMESPACE, schema: SCHEMA, defaults: DEFAULTS, env: storeEnv, log,
        onActivate: async (values) => { if (onActivate) await onActivate(values); },
        onChange: ({ namespace, keys: changed, actor: who, revision }) => {
            log.info(`[config] ${SERVICE} ${namespace} revision ${revision} by ${who && who.id ? `${who.type}:${who.id}` : 'unknown'}: ${changed.join(', ')}`);
        },
    });
    if (env.OV_CONFIG_KEKS) {
        try { await store.reseal(); } catch (err) { log.warn(`[config] ${NAMESPACE}: reseal failed: ${(err && err.message) || err}`); }
    }
    const router = shared.adminRoutes([store], {
        basePath: '/internal/config', requireAdmin: capabilityGuard({ keys, config, log }), actor, requireFresh, log,
    });
    return {
        store, router,
        get: (key) => store.get(key),
        mount(app) { app.use('/internal/config', express.json({ limit: '128kb' })); router.mount(app); },
    };
}

module.exports = { create, SCHEMA, NAMESPACE, CAPABILITY };

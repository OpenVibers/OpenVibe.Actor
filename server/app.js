'use strict';

/**
 * OpenVibe.Actor — OpenVibe's own agent and the router for agent work (plan T17, ADR-044). Express app factory;
 * server/index.js listens, tests build their own instance with a temp database and mock neighbours.
 *
 *   /, /agents, /docs, /tasks, /tasks/:id, /updates   the pages (http/pages.js)
 *   /api/v1/*                                         the task API (http/api.js)
 *   /auth/*                                           Network SSO with PKCE (auth/sso.js)
 *   /api/health, /api/ready, /release.json, /metrics (loopback only)
 */
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const contracts = require('openvibe-contracts');
const cache = require('openvibe-shared/cache-policy');

const configLib = require('./config');
const { openStore } = require('./db');
const { createKeyStore } = require('./auth/keys');
const { createSso } = require('./auth/sso');
const catalog = require('./agents/catalog');
const { createAdapters } = require('./agents/adapters');
const { createEngine } = require('./tasks/engine');
const { createTaskStream } = require('./tasks/stream');
const { createPrincipal } = require('./http/principal');
const { createApi } = require('./http/api');
const resourceIndex = require('./registry/resource-index');
const { createPageRoutes } = require('./http/pages');
const { createActorReadiness } = require('./observability');
const { createCallerLimits } = require('./http/caller-limits');
const accountDataLib = require('./identity/account-data');
const { createNetworkSender } = require('openvibe-sdk/account-data');
const { assetVersion, send } = require('./render/layout');
const { html } = require('./render/html');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const VERSION = require('../package.json').version;

/**
 * opts: config, store, now (clock), fetchImpl (Network), providerFetch (model providers and OpenVibe services), log,
 * limitsNow, callerLimits (false: count nobody, tests only), valkey, adapters (tests: stand-in agents),
 * accountSend (a stand-in for Network's internal routes; tests only)
 */
async function createApp(opts = {}) {
    const config = opts.config || configLib.load();
    const log = opts.log || console;
    const fetchImpl = opts.fetchImpl || globalThis.fetch;
    const s = opts.store || await openStore(config, { now: opts.now, log });

    const keys = createKeyStore({ config, fetchImpl, log });
    const sso = createSso({ config, keys, fetchImpl, now: s.now, log });
    const stream = createTaskStream({ log });
    const adapters = opts.adapters || createAdapters({ config, rates: catalog.RATES, fetchImpl: opts.providerFetch || globalThis.fetch, log });
    const engine = createEngine({ config, s, adapters, stream, now: s.now, log });
    const principal = createPrincipal({ config, keys });
    const ctx = { config, s, keys, sso, stream, adapters, engine, principal, log };

    // Account export and deletion (ADR-033, ./identity/account-data.js): the two tables that hold a person's rows.
    // The sender posts to Network's internal export/deletion routes with this service's own client-credentials token;
    // a test injects a stand-in through opts.accountSend.
    const accountData = accountDataLib.create({ db: s.db, log });
    // Without a client secret the service has no way to push a part or a confirmation: the route still answers
    // (bad signature, a forwarded request, no secret), and an event that really arrives asks Events to retry.
    const accountSend = opts.accountSend || (config.oauth.clientSecret
        ? createNetworkSender({ networkInternalUrl: config.networkInternalUrl, clientId: config.oauth.clientId, clientSecret: config.oauth.clientSecret, fetch: fetchImpl })
        : async () => { throw new Error('OV_OAUTH_CLIENT_SECRET is not set: Actor cannot answer account events'); });
    ctx.accountData = accountData;
    ctx.accountSend = accountSend;

    const app = express();
    app.disable('x-powered-by');
    app.set('trust proxy', config.trustProxy);
    const release = require('openvibe-shared/release').createRelease({ service: 'actor', root: path.join(__dirname, '..') });
    require('./render/layout').setRelease(release.release);
    const metrics = require('openvibe-shared/metrics').instrument(app, { service: 'actor', release: release.release });
    app.locals.metrics = metrics.registry;
    app.locals.ctx = ctx;
    const valkey = opts.valkey !== undefined ? opts.valkey : (config.valkey.url ? require('openvibe-sdk/valkey').createValkey({ url: config.valkey.url, prefix: config.valkey.prefix, log }) : null);
    ctx.valkey = valkey;
    ctx.limits = createCallerLimits({ config, now: opts.limitsNow || (() => Date.now()), registry: metrics.registry, log, enabled: opts.callerLimits !== false, valkey });

    app.use(contracts.http.middleware());
    app.use(helmet({
        contentSecurityPolicy: {
            directives: {
                defaultSrc: ["'self'"],
                // The OpenVibe Frame (theme-loader, navbar, footer) comes from the Network; the inline init is ours.
                scriptSrc: ["'self'", "'unsafe-inline'", 'https://openvibe.network', 'https://static.cloudflareinsights.com'],
                styleSrc: ["'self'", "'unsafe-inline'", 'https://openvibe.network', 'https://fonts.googleapis.com', 'https://cdnjs.cloudflare.com'],
                fontSrc: ["'self'", 'data:', 'https://fonts.gstatic.com', 'https://cdnjs.cloudflare.com'],
                imgSrc: ["'self'", 'data:', 'https://openvibe.network', 'https://openvibe.media'],
                connectSrc: ["'self'", 'https://openvibe.network', 'https://cloudflareinsights.com', 'https://openvibe.events'],
                frameSrc: ["'self'", 'https://openvibe.network'],
                frameAncestors: ["'none'"],
                objectSrc: ["'none'"],
                baseUri: ["'self'"],
                formAction: ["'self'", 'https://openvibe.network'],
            },
        },
        frameguard: { action: 'deny' },
        crossOriginEmbedderPolicy: false,
        crossOriginResourcePolicy: { policy: 'same-site' },
        referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    }));
    app.use(cookieParser());

    // ── Machine endpoints ───────────────────────────────────
    app.get('/api/health', (_req, res) => res.json({ status: 'ok', service: 'openvibe-actor', version: VERSION, tasks: engine.status(), streams: stream.status().streams }));
    release.mount(app, { registry: metrics.registry });
    const readiness = createActorReadiness({ s, config, engine, release: release.release, valkey });
    app.get('/api/ready', readiness.handler);

    // ── Who is asking (verified offline; refreshed when expired) ──
    app.use(sso.middleware());

    // ── Sign-in (OAuth2 + PKCE client of OpenVibe.Network) ──
    app.use('/auth/', rateLimit({ windowMs: 15 * 60_000, limit: 60, standardHeaders: true, legacyHeaders: false }));
    app.use('/auth', sso.routes());
    { const legal = require('openvibe-shared/legal'); app.get(legal.PATHS, legal.handler({ id: 'actor', service: 'actor', host: 'openvibe.actor', name: 'OpenVibe.Actor', profile: 'ugc' })); }

    // ── OpenVibe.Events → this service (loopback only) ──────
    // network.account.export_requested and network.account.deleted (ADR-033), answered by the SDK's consumer. It
    // reads the raw body itself, so it is mounted before any body parser (there is none above it), and nginx answers
    // 404 for /internal/ so this is reachable only on 127.0.0.1.
    app.use('/internal/events', accountData.consumer({ secrets: config.events.secrets, send: accountSend, log }));

    // ── Static assets (content-hashed ?v= → immutable) ──────
    app.use('/shared', require('openvibe-shared/serve').handler());
    app.use(express.static(PUBLIC_DIR, {
        index: false, redirect: false,
        setHeaders(res, filePath) {
            const rel = path.relative(PUBLIC_DIR, filePath).split(path.sep).join('/');
            const v = res.req && res.req.query && res.req.query.v;
            res.setHeader('Cache-Control', cache.assetHeaders(rel, { hashed: !!v && v === assetVersion(rel) }));
        },
    }));

    // ── API ─────────────────────────────────────────────────
    app.use('/api/v1', rateLimit({ windowMs: 60_000, limit: Number(process.env.ACTOR_API_RATE_LIMIT_PER_MIN) || 240, standardHeaders: true, legacyHeaders: false, handler: (req, res) => contracts.http.sendProblem(res, 429, 'rate_limited', { detail: 'too many requests from this address; retry shortly', ctx: req.ov }) }));
    // OpenVibe.Services reads Actor's task index through a first-party service token on loopback.
    app.use('/api/v1/resources', resourceIndex.router(ctx));
    app.use('/api/v1', createApi(ctx));
    app.use('/api', (req, res) => contracts.http.sendProblem(res, 404, 'route.not_found', { detail: 'No such API route', ctx: req.ov }));

    // ── Pages ───────────────────────────────────────────────
    app.use(rateLimit({ windowMs: 60_000, limit: Number(process.env.ACTOR_RATE_LIMIT_PER_MIN) || 300, standardHeaders: true, legacyHeaders: false }));
    app.use(createPageRoutes(ctx));
    app.use((req, res) => send(res, 404, { viewer: req.viewer, config, path: req.originalUrl, title: 'Not found', body: html`<h1>Not found</h1><p>No page here. Try <a href="/">giving Actor a task</a>, <a href="/agents">the agents</a> or <a href="/docs">the API</a>.</p>` }));

    // eslint-disable-next-line no-unused-vars
    app.use((err, req, res, _next) => {
        // Never log request bodies: tasks are people's own words.
        log.error('[Actor]', err && err.message ? err.message.slice(0, 300) : err);
        if (res.headersSent) return;
        res.set('Cache-Control', cache.htmlHeaders({ private: true }));
        if (err && err.type === 'entity.parse.failed') return contracts.http.sendProblem(res, 400, 'request.malformed_json', { ctx: req.ov });
        if (err && err.type === 'entity.too.large') return req.path.startsWith('/api/') ? contracts.http.sendProblem(res, 413, 'request.too_large', { ctx: req.ov }) : res.status(413).type('text/plain').send('That task was too long.');
        if (req.path.startsWith('/api/')) return contracts.http.sendProblem(res, 500, 'internal.error', { detail: 'Internal error', ctx: req.ov });
        res.status(500).type('text/plain').send('Something went wrong on our side. Try again in a moment.');
    });

    return { app, ctx };
}

module.exports = { createApp };

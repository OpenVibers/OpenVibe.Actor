'use strict';

/**
 * OpenVibe.Actor configuration. Every value comes from the environment (production: /etc/openvibe/actor.env, see
 * .env.example). Only environment variable NAMES appear in code and docs; secrets are never logged.
 *
 * load(env) is pure so tests can build a config without touching process.env.
 */
require('dotenv').config();
const trim = (s) => String(s || '').replace(/\/+$/, '');
const int = (v, def) => (Number.isFinite(parseInt(v, 10)) ? parseInt(v, 10) : def);
const num = (v, def) => (v != null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : def);

function load(env = process.env) {
    const nodeEnv = env.NODE_ENV || 'development';
    const isProduction = nodeEnv === 'production';
    const port = int(env.PORT, 4950);
    const baseUrl = trim(env.BASE_URL || (isProduction ? 'https://openvibe.actor' : `http://localhost:${port}`));
    const networkUrl = trim(env.OV_NETWORK_URL || 'https://openvibe.network');

    return {
        service: 'actor',
        port,
        host: env.HOST || '127.0.0.1',
        nodeEnv,
        isProduction,
        baseUrl,
        trustProxy: env.TRUST_PROXY != null ? Number(env.TRUST_PROXY) : 2,
        // Per-caller limits (server/http/caller-limits.js, roadmap WS-R task 4): the reads one caller (an app, a
        // person, else an address) may make per minute and per hour. Creating a task has its own, tighter numbers.
        limits: {
            minute: Math.max(1, int(env.ACTOR_LIMITS_MINUTE, 120)),
            hour: Math.max(1, int(env.ACTOR_LIMITS_HOUR, 3000)),
        },

        // PostgreSQL (ADR-035): DATABASE_URL serves (PgBouncer), DATABASE_DIRECT_URL migrates (owner role). In
        // development without DATABASE_URL an embedded PGlite database in data/pglite is used (ACTOR_PGLITE_DIR
        // overrides the directory).
        db: { url: env.DATABASE_URL || '', directUrl: env.DATABASE_DIRECT_URL || '', pgliteDir: env.ACTOR_PGLITE_DIR || '' },
        valkey: { url: env.VALKEY_URL || '', prefix: env.VALKEY_PREFIX || 'ov:actor:' },

        // OpenVibe.Network: SSO (OAuth2 authorization server with PKCE) and its JWKS.
        networkUrl,
        networkInternalUrl: trim(env.OV_NETWORK_INTERNAL_URL || 'http://127.0.0.1:4000'),
        networkIssuer: trim(env.OV_NETWORK_ISSUER || networkUrl),
        // The audience app, agent and service tokens for Actor's API carry (actor.task.* capabilities).
        audience: env.ACTOR_AUDIENCE || 'openvibe.actor',
        oauth: {
            clientId: env.OV_OAUTH_CLIENT_ID || 'actor',
            clientSecret: env.OV_OAUTH_CLIENT_SECRET || '',
            redirectUri: env.OV_OAUTH_REDIRECT_URI || `${baseUrl}/auth/callback`,
            scope: 'profile',
            sessionAudience: env.OV_SESSION_AUDIENCE || 'openvibe.network',
        },
        cookies: { secure: env.COOKIE_SECURE ? env.COOKIE_SECURE === 'true' : isProduction },

        // The model providers behind the agent systems (server/agents/catalog.js). A provider without its key is
        // listed as unavailable, with the reason; nothing is invented. Keys are the operator's.
        providers: {
            deepseek: { apiKey: env.ACTOR_DEEPSEEK_API_KEY || '', baseUrl: trim(env.ACTOR_DEEPSEEK_BASE_URL || 'https://api.deepseek.com'), model: env.ACTOR_DEEPSEEK_MODEL || 'deepseek-flash' },
            openai: { apiKey: env.ACTOR_OPENAI_API_KEY || '', baseUrl: trim(env.ACTOR_OPENAI_BASE_URL || 'https://api.openai.com/v1'), model: env.ACTOR_OPENAI_MODEL || 'gpt-5-mini', checkModel: env.ACTOR_OPENAI_CHECK_MODEL || 'gpt-5-nano' },
            local: { url: trim(env.ACTOR_LOCAL_LLM_URL || ''), model: env.ACTOR_LOCAL_LLM_MODEL || '' },
        },
        // The OpenVibe services the runtime acts through.
        services: {
            searchUrl: trim(env.ACTOR_SEARCH_URL || 'https://search.openvibe.network'),
            toolsUrl: trim(env.ACTOR_TOOLS_URL || 'https://openvibe.tools'),
        },

        // What one person may spend without paying (plan T17: "free tier from the bounded allowance"), and the
        // operator's ceiling over everyone in one UTC day. A request above the person's tier is refused, never lowered.
        allowance: {
            tasksPerDay: Math.max(0, int(env.ACTOR_FREE_TASKS_PER_DAY, 20)),
            perTaskUsd: num(env.ACTOR_FREE_PER_TASK_USD, 0.05),
            perDayUsd: num(env.ACTOR_FREE_PER_DAY_USD, 0.25),
        },
        spendCapUsdPerDay: num(env.ACTOR_MAX_COST_USD_PER_DAY, 2),
        // Tasks running at once in this process; more wait queued.
        maxRunning: Math.max(1, int(env.ACTOR_MAX_RUNNING, 4)),
        // A task that runs longer than this is stopped and fails (actor.task.timeout).
        taskTimeoutMs: Math.max(10_000, int(env.ACTOR_TASK_TIMEOUT_MS, 180_000)),
    };
}

module.exports = { load };

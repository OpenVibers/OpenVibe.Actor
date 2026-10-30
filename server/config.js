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
// An optional price: undefined when nobody typed one, so the provider's published card is used.
const optNum = (v) => (v != null && v !== '' && Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : undefined);

function load(env = process.env) {
    const nodeEnv = env.NODE_ENV || 'development';
    const isProduction = nodeEnv === 'production';
    // A self-hosted Actor (docs/self-host.md): one owner signs in with a password, no OpenVibe.Network, PGlite unless
    // DATABASE_URL is set; the integrations that need a Network service identity (Bot, Codes, Chat, Events) are off.
    const selfHosted = env.ACTOR_SELF_HOSTED === '1';
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
        db: { url: env.DATABASE_URL || '', directUrl: env.DATABASE_DIRECT_URL || '', pgliteDir: env.ACTOR_PGLITE_DIR || (selfHosted && env.DATA_DIR ? `${env.DATA_DIR.replace(/\/+$/, '')}/pglite` : '') },
        selfHosted: {
            on: selfHosted,
            ownerName: String(env.ACTOR_OWNER_NAME || 'owner').slice(0, 64),
            ownerSubject: env.ACTOR_OWNER_SUBJECT || '',
            passwordHash: env.ACTOR_OWNER_PASSWORD_HASH || '',
            ownerToken: env.ACTOR_OWNER_TOKEN || '',
            sessionSecret: env.ACTOR_SESSION_SECRET || '',
        },
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
            deepseek: { apiKey: env.ACTOR_DEEPSEEK_API_KEY || '', baseUrl: trim(env.ACTOR_DEEPSEEK_BASE_URL || 'https://api.deepseek.com'), model: env.ACTOR_DEEPSEEK_MODEL || 'deepseek-flash', inputUsdPerMtok: optNum(env.ACTOR_DEEPSEEK_INPUT_USD_PER_MTOK), outputUsdPerMtok: optNum(env.ACTOR_DEEPSEEK_OUTPUT_USD_PER_MTOK) },
            openai: { apiKey: env.ACTOR_OPENAI_API_KEY || '', baseUrl: trim(env.ACTOR_OPENAI_BASE_URL || 'https://api.openai.com/v1'), model: env.ACTOR_OPENAI_MODEL || 'gpt-5-mini', checkModel: env.ACTOR_OPENAI_CHECK_MODEL || 'gpt-5-nano', groundedCheckModel: env.ACTOR_OPENAI_GROUNDED_CHECK_MODEL || 'gpt-5-mini', visionModel: env.ACTOR_OPENAI_VISION_MODEL || '', inputUsdPerMtok: optNum(env.ACTOR_OPENAI_INPUT_USD_PER_MTOK), outputUsdPerMtok: optNum(env.ACTOR_OPENAI_OUTPUT_USD_PER_MTOK) },
            local: { url: trim(env.ACTOR_LOCAL_LLM_URL || ''), model: env.ACTOR_LOCAL_LLM_MODEL || '' },
            // The runtime's model on any OpenAI-compatible endpoint (Ollama, llama.cpp, vLLM, another provider) instead
            // of DeepSeek: a self-hosted Actor's usual choice. Priced per million tokens at what the operator says
            // (0 for a model on their own hardware); it also checks its own answers when no other family is configured.
            runtime: {
                url: trim(env.ACTOR_RUNTIME_URL || ''), model: env.ACTOR_RUNTIME_MODEL || '', apiKey: env.ACTOR_RUNTIME_API_KEY || '',
                inputUsdPerMtok: Math.max(0, num(env.ACTOR_RUNTIME_INPUT_USD_PER_MTOK, 0)), outputUsdPerMtok: Math.max(0, num(env.ACTOR_RUNTIME_OUTPUT_USD_PER_MTOK, 0)),
            },
            // Any other OpenAI-compatible endpoint (Actor v2, models.js): tiers may name `compatible:<model>`. Empty
            // turns it off. Priced at what the operator says.
            compatible: {
                baseUrl: trim(env.ACTOR_COMPAT_URL || ''), apiKey: env.ACTOR_COMPAT_API_KEY || '', model: env.ACTOR_COMPAT_MODEL || '',
                inputUsdPerMtok: Math.max(0, num(env.ACTOR_COMPAT_INPUT_USD_PER_MTOK, 0)), outputUsdPerMtok: Math.max(0, num(env.ACTOR_COMPAT_OUTPUT_USD_PER_MTOK, 0)),
            },
        },
        // The one agent loop's model tiers (server/runtime/models.js). A tier may be pinned as `provider:model`
        // (provider one of openai, deepseek, runtime, compatible, local). Absent, the tier takes the strongest model
        // each configured key offers, in providerOrder, from the provider's own model list at boot.
        models: {
            tiers: {
                fast: env.ACTOR_MODEL_FAST || '',
                smart: env.ACTOR_MODEL_SMART || '',
                best: env.ACTOR_MODEL_BEST || '',
                check: env.ACTOR_MODEL_CHECK || '',
                vision: env.ACTOR_MODEL_VISION || '',
            },
            providerOrder: String(env.ACTOR_MODEL_PROVIDER_ORDER || 'openai,deepseek,runtime,compatible,local').split(',').map((x) => x.trim()).filter(Boolean),
            listTimeoutMs: Math.max(500, int(env.ACTOR_MODEL_LIST_TIMEOUT_MS, 5000)),
        },
        // The OpenVibe services the runtime acts through.
        services: {
            searchUrl: trim(env.ACTOR_SEARCH_URL || 'https://search.openvibe.network'),
            toolsUrl: trim(env.ACTOR_TOOLS_URL || 'https://openvibe.tools'),
            // OpenVibe.Bot: the person's own robots (list_my_robots, robot_steps). Empty turns the robot tools off.
            botUrl: trim(env.ACTOR_BOT_URL != null ? env.ACTOR_BOT_URL : (selfHosted ? '' : 'http://127.0.0.1:4630')),
            botPublicUrl: trim(env.ACTOR_BOT_PUBLIC_URL || 'https://openvibe.bot'),
            // OpenVibe.Codes: the `codes` agent runs a person's coding task on their own machine. Empty turns it off.
            codesUrl: trim(env.ACTOR_CODES_URL != null ? env.ACTOR_CODES_URL : (selfHosted ? '' : 'http://127.0.0.1:4900')),
            codesPublicUrl: trim(env.ACTOR_CODES_PUBLIC_URL || 'https://openvibe.codes'),
            // OpenVibe.Run: a browser session on a desk host when none of the person's own machines has a desk for the
            // task (Desks plan D6). Empty turns it off.
            runUrl: trim(env.ACTOR_RUN_URL != null ? env.ACTOR_RUN_URL : (selfHosted ? '' : 'http://127.0.0.1:4920')),
        },

        // Artifacts (Actor v2, stage V2-4): what one task may make. The bytes live in Actor's own PostgreSQL,
        // private to the task's owner (server/runtime/artifacts.js says why not Media yet). 256 KB a file, 2 MB a task.
        artifacts: {
            maxFileBytes: Math.max(1024, int(env.ACTOR_ARTIFACT_MAX_FILE_BYTES, 256 * 1024)),
            maxTaskBytes: Math.max(1024, int(env.ACTOR_ARTIFACT_MAX_TASK_BYTES, 2 * 1024 * 1024)),
        },

        // What one person may spend without paying (plan T17: "free tier from the bounded allowance"), and the
        // operator's ceiling over everyone in one UTC day. A request above the person's tier is refused, never lowered.
        allowance: {
            tasksPerDay: Math.max(0, int(env.ACTOR_FREE_TASKS_PER_DAY, 20)),
            perTaskUsd: num(env.ACTOR_FREE_PER_TASK_USD, 0.05),
            perDayUsd: num(env.ACTOR_FREE_PER_DAY_USD, 0.25),
        },
        spendCapUsdPerDay: num(env.ACTOR_MAX_COST_USD_PER_DAY, 2),
        agents: {
            maxPerOwner: Math.max(1, int(env.ACTOR_AGENTS_MAX_PER_OWNER, 10)),
            tickMax: Math.max(1, int(env.ACTOR_AGENTS_TICK_MAX, 5)),
        },
        // Tasks running at once in this process; more wait queued.
        maxRunning: Math.max(1, int(env.ACTOR_MAX_RUNNING, 4)),
        // A task's own clock (Actor v2): the row keeps its timeout_ms at creation. The default is 10 minutes; a "best"
        // task may run up to an hour. Older rows (and a task without the column) use taskTimeoutMs.
        taskTimeoutMs: Math.max(10_000, int(env.ACTOR_TASK_TIMEOUT_MS, 600_000)),
        bestTimeoutMs: Math.max(10_000, int(env.ACTOR_BEST_TASK_TIMEOUT_MS, 3_600_000)),
        // The one agent loop (server/runtime/loop.js). No turn cap: it stops on the budget, the task's clock, a loop
        // (the same tool and input three times) or its answer. Reflections before answering are the writer's own;
        // `checkReflections` caps the verifier's second-family passes (the DeepSeek research: two at most).
        loop: {
            maxToolCallsPerTurn: Math.max(1, int(env.ACTOR_LOOP_MAX_TOOL_CALLS, 12)),
            selfReflections: Math.max(0, int(env.ACTOR_LOOP_SELF_REFLECTIONS, 2)),
            checkReflections: Math.min(2, Math.max(0, int(env.ACTOR_LOOP_CHECK_REFLECTIONS, 2))),
            toolResultChars: Math.max(500, int(env.ACTOR_LOOP_TOOL_RESULT_CHARS, 6000)),
        },
        // Task webhooks (server/tasks/webhooks.js): how often due deliveries are sent, and how long one may take.
        webhooks: {
            intervalMs: Math.max(1000, int(env.ACTOR_WEBHOOK_INTERVAL_MS, 5000)),
            timeoutMs: Math.max(1000, int(env.ACTOR_WEBHOOK_TIMEOUT_MS, 10_000)),
        },

        // Ask Actor from chat (server/chat/asks.js): "@actor …" in OpenVibe's global chat or the person's own channel,
        // taken from chat.message.created and answered in the same room through Chat's service API (url, loopback in
        // production). ACTOR_CHAT_ASKS=0 turns it off; the limits are per person and across everyone, per hour.
        chat: {
            asks: env.ACTOR_CHAT_ASKS !== '0' && !selfHosted,
            url: trim(env.ACTOR_CHAT_URL != null ? env.ACTOR_CHAT_URL : 'http://127.0.0.1:4400'),
            perHour: Math.max(1, int(env.ACTOR_CHAT_ASKS_PER_HOUR, 5)),
            allPerHour: Math.max(1, int(env.ACTOR_CHAT_ASKS_ALL_PER_HOUR, 60)),
            replyIntervalMs: Math.max(200, int(env.ACTOR_CHAT_REPLY_INTERVAL_MS, 2000)),
        },

        // OpenVibe.Events → this service (server/events-consumer.js). The secret signs a delivery (comma-separated
        // for rotation, 32+ characters each); unset turns POST /internal/events off (503). The url is where the
        // network.account.export_requested and network.account.deleted subscriptions are created at boot, off when
        // unset. Both topics are ADR-033: account export and deletion (server/identity/account-data.js).
        events: {
            secrets: String(env.ACTOR_EVENTS_SECRET || '').split(',').map((x) => x.trim()).filter(Boolean),
            url: trim(env.ACTOR_EVENTS_URL || env.EVENTS_URL || ''),
            endpoint: env.ACTOR_EVENTS_ENDPOINT || '',
        },
    };
}

module.exports = { load };

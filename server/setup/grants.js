'use strict';
/**
 * Setup done by your agent (plan §AB.44): the one-time grants a person handed to one of their tasks, and the one save.
 *
 * The person's guided setup on OpenVibe.Network makes a grant for exactly one Setup row (POST /api/admin/setup/grants,
 * owner, fresh sign-in) and starts a task here with it (POST /api/v1/tasks with { setup }). The grant id is kept in memory only,
 * beside its task, for at most its 30 minutes: never in the database, a step, a checkpoint or a log, and a restart simply
 * ends the setup. The task's tool setup_save_key reads the provider's page itself, finds the new key by the provider's
 * key shape, and saves it through Network's POST /internal/setup/grants/:id/save (network.setup.grant.save) with Actor's
 * own client-credentials token. The model never sees, copies or types the key; it gets "saved" and four characters.
 */
const { serviceAuth } = require('openvibe-contracts');

const GRANT_ID = /^sgr_[A-Za-z0-9_-]{32}$/;
const KEY_NAME = /^[a-z][a-z0-9_.-]{0,79}$/;
const TTL_MS = 30 * 60 * 1000;

// What a new key looks like on each provider's page (the shape alone: the page shows it once after "Create"). Only
// distinctive shapes: a provider whose keys are plain hex or letters is not listed (its row is set by hand).
const KEY_SHAPES = {
    openai: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}\b/g,
    anthropic: /\bsk-ant-[A-Za-z0-9_-]{32,}\b/g,
    deepseek: /\bsk-[a-f0-9]{32}\b/g,
    openrouter: /\bsk-or-v1-[a-f0-9]{64}\b/g,
    groq: /\bgsk_[A-Za-z0-9]{40,}\b/g,
    gemini: /\bAIza[0-9A-Za-z_-]{35}\b/g,
    kimi: /\bsk-[A-Za-z0-9]{40,}\b/g,
    xai: /\bxai-[A-Za-z0-9]{40,}\b/g,
    fireworks: /\bfw_[A-Za-z0-9]{20,}\b/g,
    resend: /\bre_[A-Za-z0-9_]{20,}\b/g,
    stripe: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{20,}\b/g,
};

const live = new Map();   // taskId → { grantId, keys, provider, label, until }

function remember(taskId, grant, now = Date.now()) {
    if (!taskId || !grant || !GRANT_ID.test(String(grant.grantId))) throw new Error('a grant id and a task');
    const keys = (Array.isArray(grant.keys) ? grant.keys : []).map(String).filter((k) => KEY_NAME.test(k)).slice(0, 4);
    if (!keys.length) throw new Error('the grant names no key');
    live.set(String(taskId), { grantId: grant.grantId, keys, provider: String(grant.provider || '').toLowerCase(), label: String(grant.label || grant.provider || 'the provider').slice(0, 60), until: now + TTL_MS });
}
function grantFor(taskId, now = Date.now()) {
    const g = live.get(String(taskId || ''));
    if (!g) return null;
    if (g.until <= now) { live.delete(String(taskId)); return null; }
    return g;
}
function forget(taskId) { live.delete(String(taskId || '')); }

/** The one new key on a page's text, by the provider's key shape: { key } or { reason } (none, or more than one). */
function findKey(text, provider) {
    const shape = KEY_SHAPES[String(provider || '').toLowerCase()];
    if (!shape) return { reason: 'unknown_provider' };
    const found = [...new Set(String(text || '').match(new RegExp(shape.source, 'g')) || [])];
    if (!found.length) return { reason: 'no_key_on_page' };
    if (found.length > 1) return { reason: 'several_keys_on_page' };
    return { key: found[0] };
}

/** The value's last four characters: all a step or an answer ever says about it. */
const hintOf = (v) => `…${String(v).slice(-4)}`;

function createSaver({ config, fetchImpl = globalThis.fetch, tokens: tokensOverride = null } = {}) {
    const enabled = !!(tokensOverride || (config && config.oauth && config.oauth.clientSecret));
    const tokens = !enabled ? null : tokensOverride || serviceAuth.createTokenClient({
        tokenUrl: `${config.networkInternalUrl}/oauth/token`, clientId: config.oauth.clientId, clientSecret: config.oauth.clientSecret,
        audience: 'openvibe.network', scope: 'network.setup.grant.save', fetchImpl,
    });
    /** → { ok: true, keys: [{ key, hint }] } or { ok: false, reason }; never the value. */
    async function save(grantId, values, run) {
        if (!tokens) return { ok: false, reason: 'not_configured' };
        if (!GRANT_ID.test(String(grantId))) return { ok: false, reason: 'no_grant' };
        let res;
        try {
            res = await fetchImpl(`${config.networkInternalUrl}/internal/setup/grants/${encodeURIComponent(grantId)}/save`, {
                method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
                headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...(await tokens.authHeaders()) },
                body: JSON.stringify({ values, ...(run ? { run: String(run).slice(0, 80) } : {}) }),
            });
        } catch { return { ok: false, reason: 'network_unreachable' }; }
        const out = await res.json().catch(() => null);
        if (!res.ok) return { ok: false, reason: (out && out.code) || `network_${res.status}` };
        const keys = (out && Array.isArray(out.keys) ? out.keys : []).map((k) => ({ key: String(k.key), hint: String(k.hint || '').slice(0, 8) }));
        return { ok: true, keys };
    }
    return { enabled, save };
}

module.exports = { remember, grantFor, forget, findKey, hintOf, createSaver, KEY_SHAPES, TTL_MS, GRANT_ID };

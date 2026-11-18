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
// The guard (11-14 review): a setup task keeps its key guard for its whole life, apart from the grant. The grant goes
// when the key is saved or after 30 minutes, but the provider's page may still show the key: page reads stay masked
// and screenshots stay checked until the task is long over. taskId → { provider, until }
const guards = new Map();
const GUARD_MS = 12 * 60 * 60 * 1000;

function remember(taskId, grant, now = Date.now()) {
    if (!taskId || !grant || !GRANT_ID.test(String(grant.grantId))) throw new Error('a grant id and a task');
    const keys = (Array.isArray(grant.keys) ? grant.keys : []).map(String).filter((k) => KEY_NAME.test(k)).slice(0, 4);
    if (!keys.length) throw new Error('the grant names no key');
    const provider = String(grant.provider || '').toLowerCase();
    live.set(String(taskId), { grantId: grant.grantId, keys, provider, label: String(grant.label || grant.provider || 'the provider').slice(0, 60), until: now + TTL_MS });
    guards.set(String(taskId), { provider, until: now + GUARD_MS });
}
/** The key guard of a setup task: { provider } while it holds (long after its grant is spent or expired), else null. */
function guardFor(taskId, now = Date.now()) {
    const g = guards.get(String(taskId || ''));
    if (!g) return null;
    if (g.until <= now) { guards.delete(String(taskId)); return null; }
    return g;
}
/** Every key shape we know, joined: a guarded task hides any provider's key, not only the one it sets up. */
const ANY_KEY = new RegExp(Object.values(KEY_SHAPES).map((r) => `(?:${r.source})`).join('|'), 'g');
/** The text with every key-shaped run replaced (a guarded task's page reads). */
function maskKeys(text, label = '[a key: hidden]') {
    return String(text).replace(new RegExp(ANY_KEY.source, 'g'), label);
}
/** Whether the text shows anything shaped like a key of any provider we know. */
const showsKey = (text) => new RegExp(ANY_KEY.source).test(String(text || ''));

/**
 * Every string anywhere in a value (an answer's fields, its elements, a receipt's lines, a link's address), at most
 * 5000 of them six levels deep: a guard reads all of a page's answer, not the few fields it expects (the 11-15 review).
 */
function stringsOf(value, out = [], depth = 0) {
    if (out.length >= 5000 || depth > 6 || value == null) return out;
    if (typeof value === 'string') out.push(value);
    else if (Array.isArray(value)) for (const v of value) stringsOf(v, out, depth + 1);
    else if (typeof value === 'object') for (const v of Object.values(value)) stringsOf(v, out, depth + 1);
    return out;
}
/** A copy of value with every key-shaped run in every string replaced (its field names kept). */
function maskDeep(value, label = '[a key: hidden]', depth = 0) {
    if (typeof value === 'string') return maskKeys(value, label);
    if (value == null || typeof value !== 'object' || depth > 8) return value;
    if (Array.isArray(value)) return value.map((v) => maskDeep(v, label, depth + 1));
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, maskDeep(v, label, depth + 1)]));
}
/**
 * Whether a page read is one a guard may trust: an answer with no error and some words on the page. An empty or
 * error-shaped answer (the read failed, the page was blank or still loading) proves nothing, so it lets nothing by.
 */
function readablePage(page) {
    if (!page || typeof page !== 'object' || Array.isArray(page)) return false;
    if (page.error || page.isError || page.ok === false) return false;
    return [page.text, page.content, page.value].some((x) => typeof x === 'string' && x.trim().length > 0);
}
function grantFor(taskId, now = Date.now()) {
    const g = live.get(String(taskId || ''));
    if (!g) return null;
    if (g.until <= now) { live.delete(String(taskId)); return null; }
    return g;
}
/** The grant is spent (or revoked): the task can no longer save. Its key guard stays (guardFor). */
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
        } catch (err) {
            // No answer in time is not "not saved": Network may still finish the write (Setup says which).
            return { ok: false, reason: err && (err.name === 'TimeoutError' || err.name === 'AbortError') ? 'network_no_answer' : 'network_unreachable' };
        }
        const out = await res.json().catch(() => null);
        if (!res.ok) return { ok: false, reason: (out && out.code) || `network_${res.status}` };
        const keys = (out && Array.isArray(out.keys) ? out.keys : []).map((k) => ({ key: String(k.key), hint: String(k.hint || '').slice(0, 8) }));
        return { ok: true, keys };
    }
    return { enabled, save };
}

module.exports = { remember, grantFor, forget, guardFor, maskKeys, maskDeep, showsKey, stringsOf, readablePage, findKey, hintOf, createSaver, KEY_SHAPES, TTL_MS, GUARD_MS, GRANT_ID };

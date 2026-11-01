'use strict';

/**
 * The person's model choice (plan L55 C3; the owner, 2026-11-01: "use your own API keys, or OpenVibe's… all the
 * features"). One row per person:
 *
 *   auto            Actor decides, as today (the operator's tiers and keys)
 *   openvibe        OpenVibe's own keys, through OpenVibe.AI (the gateway: its routing, quota and cost)
 *   own:<provider>  the person's OWN key for that provider, sealed in OpenVibe.AI's vault
 *
 * The provider is one of the six OpenVibe.AI knows a person's key for. The model id is optional: without one,
 * OpenVibe.AI routes the call (L37's soft preference), and the person's choice of provider still holds.
 *
 * No key material is ever written here: this table says which provider the person's key is for, nothing else.
 * The row belongs to the person (requester = user:usr_…), so it is exported and erased with them
 * (server/identity/account-data.js).
 */
const CHOICES = ['auto', 'openvibe'];
const OWN_PROVIDERS = ['openai', 'anthropic', 'deepseek', 'google', 'openrouter', 'mistral'];
// A model id: letters, digits and the marks providers use (gpt-5.1, claude-sonnet-4-5, deepseek/flash, org/model).
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/;

/**
 * Read a choice from a request body. Returns { choice, provider, model } or { error } (never throws: a bad choice
 * is a 422, not a crash).
 */
function parse(body) {
    const raw = body && typeof body === 'object' ? body : {};
    const choice = String(raw.choice == null ? 'auto' : raw.choice).trim();
    const model = raw.model == null ? null : String(raw.model).trim();
    if (model && !MODEL_RE.test(model)) return { error: 'model: a model id (letters, digits, and . _ : - /)' };
    if (CHOICES.includes(choice)) return { choice, provider: null, model: model || null };
    if (choice.startsWith('own:')) {
        const provider = choice.slice(4).trim().toLowerCase();
        if (!OWN_PROVIDERS.includes(provider)) return { error: 'choice: own:<provider> needs a provider of ' + OWN_PROVIDERS.join(', ') };
        return { choice: 'own:' + provider, provider, model: model || null };
    }
    return { error: 'choice: one of ' + CHOICES.join(', ') + ', own:<provider>' };
}

/** The row for a person, or null (no row: the default is 'auto'). */
async function get(s, requester) {
    if (!requester) return null;
    const row = await s.db.maybe('SELECT requester, choice, model, updated_at FROM actor_model_prefs WHERE requester = $1', [requester]);
    return row || null;
}

/** Write the person's choice. Returns { row } or { error }. */
async function put(s, requester, body, now = () => new Date().toISOString()) {
    const parsed = parse(body);
    if (parsed.error) return { error: parsed.error };
    if (!requester) return { error: 'no person' };
    const at = now();
    await s.db.query(
        'INSERT INTO actor_model_prefs (requester, choice, model, updated_at) VALUES ($1, $2, $3, $4)'
        + ' ON CONFLICT (requester) DO UPDATE SET choice = excluded.choice, model = excluded.model, updated_at = excluded.updated_at',
        [requester, parsed.choice, parsed.model, at],
    );
    return { row: { requester, choice: parsed.choice, provider: parsed.provider, model: parsed.model, updated_at: at } };
}

/**
 * The choice as the run needs it: { subject, provider, model } or null (today's behaviour). The subject is the bare
 * usr_… id OpenVibe.AI expects in x-openvibe-credential — never "user:usr_…".
 */
async function choiceFor(s, requester) {
    const row = await get(s, requester);
    if (!row || !String(row.choice || '').startsWith('own:')) return null;
    const subject = String(requester || '').startsWith('user:') ? requester.slice(5) : null;
    if (!subject) return null;
    return { subject, provider: row.choice.slice(4), model: row.model || null };
}

/** The choice as the API answers it. */
function wire(row) {
    if (!row) return { choice: 'auto', provider: null, model: null, updated_at: null };
    return {
        choice: row.choice,
        provider: String(row.choice || '').startsWith('own:') ? row.choice.slice(4) : null,
        model: row.model || null,
        updated_at: row.updated_at || null,
    };
}

module.exports = { CHOICES, OWN_PROVIDERS, parse, get, put, choiceFor, wire };

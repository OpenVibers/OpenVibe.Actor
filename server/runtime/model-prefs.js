'use strict';

/**
 * The person's model choice (plan L55 C3; the owner, 2026-11-01: "use your own API keys, or OpenVibe's… all the
 * features"). One row per person:
 *
 *   auto            Actor decides, as today (the operator's tiers and keys)
 *   openvibe        OpenVibe's own keys, through OpenVibe.AI (the gateway: its routing, quota and cost)
 *   own:<provider>  the person's OWN key for that provider, sealed in OpenVibe.AI's vault
 *   own:node        a model on the person's own computer (OpenVibe.AI's "Your computer": their OpenVibe Node, through
 *                   OpenVibe.Bot; no key, nothing billed), used only after they allow Actor there
 *
 * The provider is one of the six OpenVibe.AI knows a person's key for. The model id is optional: without one,
 * OpenVibe.AI routes the call (L37's soft preference), and the person's choice of provider still holds.
 *
 * No key material is ever written here: this table says which provider the person's key is for, nothing else.
 * The row belongs to the person (requester = user:usr_…), so it is exported and erased with them
 * (server/identity/account-data.js).
 */
const CHOICES = ['auto', 'openvibe'];
// Where the tasks run (plan L55 C3, migration 0027): OpenVibe's cloud, or the person's own paired machine through
// OpenVibe.Codes (the codes agent), for every turn but robot and computer-control tasks.
const RUNS_ON = ['openvibe', 'computer'];
const KEY_PROVIDERS = ['openai', 'anthropic', 'deepseek', 'google', 'openrouter', 'mistral'];
// Plus their own computer (plan L55 C3): node is OpenVibe.AI's name for it.
const OWN_PROVIDERS = [...KEY_PROVIDERS, 'node'];
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
    const row = await s.db.maybe('SELECT requester, choice, model, runs_on, updated_at FROM actor_model_prefs WHERE requester = $1', [requester]);
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

/** Where the person's tasks run: 'openvibe' (no row, or the default) or 'computer'. */
async function runsOnFor(s, requester) {
    const row = await get(s, requester);
    return row && RUNS_ON.includes(row.runs_on) ? row.runs_on : 'openvibe';
}

/** The model choice "Runs on: my computer" means: the person's own computer, through OpenVibe.AI's node credential. */
function computerChoice(requester) {
    const subject = String(requester || '').startsWith('user:') ? requester.slice(5) : null;
    return subject ? { subject, provider: 'node', model: null } : null;
}

/** Set where the person's tasks run. Returns { runs_on } or { error }; the model choice is left as it is. */
async function setRunsOn(s, requester, value, now = () => new Date().toISOString()) {
    const v = String(value == null ? '' : value).trim();
    if (!RUNS_ON.includes(v)) return { error: 'runs_on: one of ' + RUNS_ON.join(', ') };
    if (!requester) return { error: 'no person' };
    await s.db.query(
        "INSERT INTO actor_model_prefs (requester, choice, model, runs_on, updated_at) VALUES ($1, 'auto', NULL, $2, $3)"
        + ' ON CONFLICT (requester) DO UPDATE SET runs_on = excluded.runs_on, updated_at = excluded.updated_at',
        [requester, v, now()],
    );
    return { runs_on: v };
}

/** The choice as the API answers it. */
function wire(row) {
    if (!row) return { choice: 'auto', provider: null, model: null, runs_on: 'openvibe', updated_at: null };
    return {
        choice: row.choice,
        provider: String(row.choice || '').startsWith('own:') ? row.choice.slice(4) : null,
        model: row.model || null,
        runs_on: RUNS_ON.includes(row.runs_on) ? row.runs_on : 'openvibe',
        updated_at: row.updated_at || null,
    };
}

module.exports = { CHOICES, RUNS_ON, OWN_PROVIDERS, KEY_PROVIDERS, parse, get, put, choiceFor, runsOnFor, setRunsOn, computerChoice, wire };

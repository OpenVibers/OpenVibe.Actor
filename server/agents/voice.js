'use strict';

/**
 * An agent's voice as a file: actor.voice@1 (OpenVibe.Contracts, contracts/actor/voice.v1.json).
 *
 * A voice is a voice and nothing else. It carries the agent's name, a short bio, its instructions (the house voice it
 * speaks in), the rules it keeps, its default level, the model and the apps it prefers (ids, never a key) and an
 * optional face. It never carries memory, a connector's token or a file: a file that does is refused, not stripped.
 *
 * The document carries an INTEGRITY block, not a signature: a sha256 over the canonical JSON, which shows the file
 * was not edited after it was written. It says nothing about who wrote it — anyone can write a file that names an
 * author and compute its hash — so the author in a document is a claim, and whoever reads a file must say so. Only
 * Actor, which owns the agent, may vouch for an author, and it does so in its own record of a shared voice
 * (server/agents/voice-shares.js).
 *
 * Importing a voice makes a new agent at level ask, whatever the file says: a borrowed agent starts cautious, and
 * the person raises it themselves.
 *
 *   build(row, author)            the document for one of the person's agents
 *   read(input)                   a document in: the fields it keeps, or the reason it is refused
 *   toContact(doc, source)        the new agent a document makes
 */
const crypto = require('crypto');
const levels = require('./levels');

const CONTRACT = 'actor.voice@1';
const FIELDS = ['voice', 'name', 'bio', 'face', 'instructions', 'rules', 'level', 'model', 'apps', 'author', 'integrity', 'created_at'];
const APP = /^[a-z][a-z0-9._-]{0,63}$/;
const ENGINE = ['runtime', 'own-keys', 'open-gpu', 'link'];
const SUBJECT = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;
const HASH = /^[0-9a-f]{64}$/;
// A voice never carries these. They are refused, not stripped: a file that smuggles a memory or a token must not
// become an agent by being imported.
const NEVER = /^(memory|memories|notes?|tokens?|secret|secrets|keys?|credentials?|files?|attachments?|connectors?)$/i;

const isPlain = (v) => v && typeof v === 'object' && !Array.isArray(v);
const parse = (v) => (v == null ? null : typeof v === 'string' ? JSON.parse(v) : v);

/** The canonical JSON of a document: the fields the contract names, in the order it names them. */
function canonical(doc) {
    const o = { voice: doc.voice, name: doc.name };
    if (doc.bio) o.bio = doc.bio;
    if (doc.face) o.face = doc.face;
    o.instructions = doc.instructions;
    if (doc.rules && doc.rules.length) o.rules = doc.rules;
    o.level = doc.level;
    if (doc.model) o.model = { engine: doc.model.engine, model: doc.model.model };
    if (doc.apps && doc.apps.length) o.apps = doc.apps;
    if (doc.author) o.author = doc.author.name ? { subject: doc.author.subject, name: doc.author.name } : { subject: doc.author.subject };
    return JSON.stringify(o);
}

/** The sha256 of the canonical JSON: the document's integrity hash. It says nothing about who wrote the file. */
const hashOf = (doc) => crypto.createHash('sha256').update(canonical(doc), 'utf8').digest('hex');

const rulesOf = (row) => { const r = parse(row && row.rules); return Array.isArray(r) ? r.filter((x) => typeof x === 'string') : []; };
const appsOf = (row) => { const a = parse(row && row.apps); return Array.isArray(a) ? a.filter((x) => typeof x === 'string') : []; };
const modelOf = (row) => (row && row.model_engine && row.model_id ? { engine: row.model_engine, model: row.model_id } : null);

/** The document for one of the person's agents. It never carries the agent's memory, its connectors or any file. */
function build(row, { subject, name = null, at = null } = {}) {
    const created_at = at || new Date().toISOString();
    const doc = {
        voice: CONTRACT,
        name: String((row && row.name) || '').trim(),
        instructions: String((row && row.instructions) || ''),
        level: levels.LEVELS.includes(row && row.level) ? row.level : 'ask',
        created_at,
        integrity: { alg: 'sha256', hash: '' },
    };
    if (subject) {
        const who = { subject: String(subject).replace(/^user:/, '') };
        if (name) who.name = String(name).slice(0, 80);
        doc.author = who;
    }
    if (row && row.bio) doc.bio = String(row.bio);
    if (row && row.face) doc.face = String(row.face);
    const rules = rulesOf(row);
    if (rules.length) doc.rules = rules;
    const model = modelOf(row);
    if (model) doc.model = model;
    const apps = appsOf(row);
    if (apps.length) doc.apps = apps;
    doc.integrity.hash = hashOf(doc);
    return doc;
}

/** The key of a forbidden field anywhere in a document, or null. */
function findNever(value, depth = 0) {
    if (depth > 4 || !value || typeof value !== 'object') return null;
    if (Array.isArray(value)) {
        for (const v of value) { const k = findNever(v, depth + 1); if (k) return k; }
        return null;
    }
    for (const [k, v] of Object.entries(value)) {
        if (NEVER.test(k)) return k;
        const found = findNever(v, depth + 1);
        if (found) return found;
    }
    return null;
}

/**
 * A document in: the fields it keeps (anything the contract does not know is stripped) or the reason it is refused.
 * The hash is checked last, so a document edited after it was written does not match.
 */
function read(input) {
    if (!isPlain(input)) return { error: 'A voice file must be a JSON object.' };
    if (input.voice !== CONTRACT) return { error: 'This is not a voice file: it says ' + JSON.stringify(input.voice === undefined ? null : input.voice) + '.' };
    const smuggled = findNever(input);
    if (smuggled) return { error: 'A voice never carries ' + smuggled + '.' };
    const doc = {};
    for (const k of FIELDS) if (input[k] !== undefined) doc[k] = input[k];
    if (typeof doc.name !== 'string' || !doc.name.trim() || doc.name.length > 60) return { error: 'The name must be 1–60 characters.' };
    if (doc.bio !== undefined && (typeof doc.bio !== 'string' || doc.bio.length > 280)) return { error: 'The bio must be at most 280 characters.' };
    if (doc.face !== undefined && (typeof doc.face !== 'string' || !doc.face.trim() || doc.face.length > 500)) return { error: 'The face must be an avatar ref of 1–500 characters.' };
    if (typeof doc.instructions !== 'string' || !doc.instructions.trim() || doc.instructions.length > 4000) return { error: 'The instructions must be 1–4000 characters.' };
    if (doc.rules !== undefined) {
        if (!Array.isArray(doc.rules) || doc.rules.length > 20) return { error: 'The rules must be at most 20 lines.' };
        for (const r of doc.rules) if (typeof r !== 'string' || !r.trim() || r.length > 200) return { error: 'Each rule must be 1–200 characters.' };
    }
    if (!levels.LEVELS.includes(doc.level)) return { error: 'The level must be one of ' + levels.LEVELS.join(', ') + '.' };
    if (doc.model !== undefined) {
        if (!isPlain(doc.model) || !ENGINE.includes(doc.model.engine)) return { error: 'The model engine must be one of ' + ENGINE.join(', ') + '.' };
        if (typeof doc.model.model !== 'string' || !doc.model.model.trim() || doc.model.model.length > 120) return { error: 'The model id must be 1–120 characters.' };
    }
    if (doc.apps !== undefined) {
        if (!Array.isArray(doc.apps) || doc.apps.length > 50) return { error: 'The apps must be at most 50 ids.' };
        for (const a of doc.apps) if (typeof a !== 'string' || !APP.test(a)) return { error: 'Each app id must be a connect slug.' };
    }
    // The author is a claim: the document may name nobody, and when it names somebody, nothing here checks it.
    if (doc.author !== undefined) {
        if (!isPlain(doc.author)) return { error: 'The author must be a Network subject.' };
        const author = { subject: String(doc.author.subject || '').replace(/^user:/, '') };
        if (!SUBJECT.test(author.subject)) return { error: 'The author must be a Network subject (usr_…).' };
        if (doc.author.name !== undefined) {
            if (typeof doc.author.name !== 'string' || doc.author.name.length > 80) return { error: 'The author name must be at most 80 characters.' };
            author.name = doc.author.name;
        }
        doc.author = author;
    }
    if (!isPlain(doc.integrity) || doc.integrity.alg !== 'sha256' || !HASH.test(String(doc.integrity.hash || ''))) return { error: 'The integrity block must be a sha256 hash.' };
    if (doc.created_at !== undefined && (typeof doc.created_at !== 'string' || Number.isNaN(Date.parse(doc.created_at)))) return { error: 'created_at must be a timestamp.' };
    if (hashOf(doc) !== doc.integrity.hash) return { error: 'This voice was changed after it was written: the hash does not match.' };
    return { doc };
}

/** Does this document still match its own hash? */
const verify = (doc) => { const r = read(doc); return r.error ? { ok: false, error: r.error } : { ok: true, doc: r.doc }; };

// What an imported voice may bring with it, beyond its words (Opus's review of HO10):
//   a face: only one of OpenVibe's preset marks. A picture at an address the file names would load from that server
//           every time the person opens their agents (a tracking pixel), so it is not taken;
//   a model: only OpenVibe's own runtime or its free GPU models. "own-keys" would spend the borrower's own API money,
//           and "link" would run on the borrower's machine, at the say of a file somebody else wrote;
//   apps: none. An app id binds to the borrower's own connections (their mail, their files), so the borrower adds
//         each one themselves; the file's list is kept as a suggestion the agent's page shows.
const PRESET_FACE = /^preset:[a-z0-9-]{1,40}$/;
const IMPORT_ENGINES = ['runtime', 'open-gpu'];
const DEFAULT_MODEL = { engine: 'runtime', model: 'smart' };

/**
 * The agent a document makes. The level is always ask, whatever the file says, and it keeps no memory.
 * `authorChecked` says who may be vouched for: Actor's own record of a shared voice says yes, a file says only what
 * it claims.
 */
function toContact(doc, { source = null, authorChecked = false } = {}) {
    return {
        name: doc.name.trim(),
        bio: doc.bio || null,
        face: doc.face && PRESET_FACE.test(doc.face) ? doc.face : 'preset:agent',
        instructions: doc.instructions,
        rules: doc.rules || [],
        level: 'ask',
        model: doc.model && IMPORT_ENGINES.includes(doc.model.engine) ? doc.model : DEFAULT_MODEL,
        apps: [],
        suggested_apps: doc.apps || [],
        memory: null,
        voice_author: doc.author ? doc.author.subject : null,
        voice_author_name: doc.author && doc.author.name ? doc.author.name : null,
        voice_author_checked: Boolean(authorChecked),
        voice_source: source,
    };
}

module.exports = { CONTRACT, FIELDS, PRESET_FACE, IMPORT_ENGINES, canonical, hashOf, build, read, verify, toContact, findNever };

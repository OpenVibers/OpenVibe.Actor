'use strict';

/**
 * Make your own agent (agent-blueprints.md; Contracts 0.419.0 agents.blueprint@1 and agents.install@1). A blueprint is
 * an agent as one document of ten parts; Actor stores them and the agents made from them. The rules live in
 * openvibe-sdk/agents/blueprint (validate, asks, wider, fill, compile), so a browser, Link and Actor agree on them.
 *
 *   create(s, owner, doc)                 a new blueprint with doc as its draft (version 1)
 *   list(s, owner, { scope })             mine (drafts too) or public (published only), newest first
 *   get(s, viewer, id, { version })       the version asked for, the latest published, or the owner's draft
 *   saveDraft(s, owner, id, doc)          the next version, editable until it is published
 *   publish(s, owner, id)                 freezes the draft as version N (published versions never change)
 *   remix(s, owner, id, { version })      a private copy of a version, with forked_from; the source counts it
 *   asks(s, viewer, id, { version })      the install screen: what installing it lets it do, in words
 *   install(s, config, owner, id, body)   a person's own agent (actor_agents) from one version, with agents.install@1
 *   update(s, config, owner, agentId, b)  moves an installed agent to another version; a wider one needs every new ask agreed
 *   wire(row, version) / installWire(row) the shapes the API answers with
 *
 * Who sees what: the owner sees their own blueprints and drafts; a link blueprint's published versions are readable by
 * anyone signed in who has its id; a public one is also listed. Nothing else is there (404, never 403).
 * A blueprint carries no secret and grants nothing: installing records the asks the person agreed to; a version that
 * asks for more waits as `pending` until they agree to the new asks.
 */
const contracts = require('openvibe-contracts');
const bp = require('openvibe-sdk/agents/blueprint');
const contacts = require('./contacts');

const ID = /^bp_[A-Za-z0-9_-]{3,40}$/;
const OWNER = /^(user:usr_[0-9A-HJKMNP-TV-Z]{26}|service:actor)$/;
const MAX_DRAFT_BYTES = 200 * 1024;

class BlueprintError extends Error {
    constructor(status, code, message, errors) {
        super(message);
        this.status = status;
        this.code = code;
        if (errors) this.errors = errors;
    }
}
const fail = (status, code, message, errors) => { throw new BlueprintError(status, code, message, errors); };
const parse = (v) => (v == null ? null : typeof v === 'string' ? JSON.parse(v) : v);
const subjectOf = (owner) => {
    const [type, id] = String(owner).split(':');
    return type === 'user' ? { type: 'user', id } : { type: 'service', id: id || 'actor' };
};

/** The shape and every rule: Contracts' schema, then the SDK's rules a schema cannot say. */
function check(doc) {
    const errors = [];
    const v = contracts.validate('agents.blueprint@1', doc);
    for (const e of (v && v.errors) || []) errors.push({ at: e.instancePath || e.path || '/', why: e.message || String(e) });
    const r = bp.validate(doc);
    for (const e of r.errors) if (!errors.some((x) => x.at === e.at)) errors.push(e);
    return errors;
}

/** A draft as the person sent it, with what the store owns put in: id, version, state, author, dates. */
function asDraft(row, input, version) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) fail(422, 'actor.blueprint.invalid', 'A blueprint is an object.');
    if (Buffer.byteLength(JSON.stringify(input)) > MAX_DRAFT_BYTES) fail(413, 'actor.blueprint.too_large', 'A blueprint is at most 200 KB.');
    const now = new Date().toISOString();
    const doc = { ...input, id: row.id, version, state: 'draft', author: subjectOf(row.owner), visibility: input.visibility || row.visibility || 'private' };
    delete doc.published_at;
    doc.forked_from = row.forked_from || null;
    doc.created_at = row.created_at || now;
    doc.updated_at = now;
    return doc;
}

function rowOut(row) {
    return row && { ...row, draft: parse(row.draft) };
}

async function rowFor(s, id) {
    if (!ID.test(String(id || ''))) return null;
    return rowOut(await s.db.maybe('SELECT * FROM agent_blueprints WHERE id = $1 AND deleted_at IS NULL', [id]));
}

async function versionOf(s, id, version) {
    const v = await s.db.maybe('SELECT * FROM agent_blueprint_versions WHERE blueprint_id = $1 AND version = $2', [id, version]);
    return v ? { ...v, doc: parse(v.doc) } : null;
}

/** What `viewer` may read of a blueprint: its draft and every version (owner), or its published ones (link, public). */
async function readable(s, viewer, id) {
    const row = await rowFor(s, id);
    if (!row) return null;
    const own = row.owner === viewer;
    if (!own && (row.visibility === 'private' || row.latest == null)) return null;
    return { row, own };
}

async function create(s, owner, input) {
    if (!OWNER.test(String(owner || ''))) fail(403, 'actor.blueprint.forbidden', 'Sign in to make an agent.');
    const now = new Date().toISOString();
    const id = s.newId('bp');
    const vis = ['private', 'link', 'public'].includes(input && input.visibility) ? input.visibility : 'private';
    const row = { id, owner, visibility: vis, forked_from: null, created_at: now };
    const doc = asDraft(row, input, 1);
    const errors = check(doc);
    if (errors.length) fail(422, 'actor.blueprint.invalid', errors.map((e) => `${e.at}: ${e.why}`).join('; '), errors);
    await s.db.query(`INSERT INTO agent_blueprints (id, owner, visibility, latest, draft, forked_from, created_at, updated_at)
        VALUES ($1, $2, $3, NULL, $4::jsonb, NULL, $5, $5)`, [id, owner, vis, JSON.stringify(doc), now]);
    return rowFor(s, id);
}

async function list(s, viewer, { scope = 'mine', limit = 50 } = {}) {
    const n = Math.max(1, Math.min(100, Number(limit) || 50));
    if (scope === 'public') {
        return s.db.many(`SELECT * FROM agent_blueprints WHERE visibility = 'public' AND deleted_at IS NULL AND latest IS NOT NULL
            ORDER BY updated_at DESC, id DESC LIMIT $1`, [n]).then((rows) => rows.map(rowOut));
    }
    return s.db.many('SELECT * FROM agent_blueprints WHERE owner = $1 AND deleted_at IS NULL ORDER BY updated_at DESC, id DESC LIMIT $2', [viewer, n]).then((rows) => rows.map(rowOut));
}

/** The doc a viewer asked for: an exact published version, else the latest published, else (owner only) the draft. */
async function get(s, viewer, id, { version = null, draft = false } = {}) {
    const r = await readable(s, viewer, id);
    if (!r) return null;
    if (draft || (r.row.latest == null && r.own && version == null)) {
        if (!r.own || !r.row.draft) return null;
        return { row: r.row, doc: r.row.draft, own: true };
    }
    const n = version != null ? Number(version) : r.row.latest;
    if (!Number.isInteger(n) || n < 1) return null;
    const v = await versionOf(s, id, n);
    return v ? { row: r.row, doc: v.doc, own: r.own, state: v.state } : null;
}

async function saveDraft(s, owner, id, input) {
    const row = await rowFor(s, id);
    if (!row || row.owner !== owner) return null;
    const next = (row.latest || 0) + 1;
    const doc = asDraft(row, input, next);
    const errors = check(doc);
    if (errors.length) fail(422, 'actor.blueprint.invalid', errors.map((e) => `${e.at}: ${e.why}`).join('; '), errors);
    const vis = doc.visibility;
    await s.db.query('UPDATE agent_blueprints SET draft = $2::jsonb, visibility = $3, updated_at = $4 WHERE id = $1', [id, JSON.stringify(doc), vis, doc.updated_at]);
    return rowFor(s, id);
}

async function publish(s, owner, id) {
    const row = await rowFor(s, id);
    if (!row || row.owner !== owner) return null;
    if (!row.draft) fail(409, 'actor.blueprint.no_draft', 'There is nothing new to publish.');
    const version = (row.latest || 0) + 1;
    const now = new Date().toISOString();
    const doc = { ...row.draft, version, state: 'published', published_at: now, updated_at: now };
    const errors = check(doc);
    if (errors.length) fail(422, 'actor.blueprint.invalid', errors.map((e) => `${e.at}: ${e.why}`).join('; '), errors);
    await s.db.query(`INSERT INTO agent_blueprint_versions (blueprint_id, version, doc, state, published_at) VALUES ($1, $2, $3::jsonb, 'published', $4)`,
        [id, version, JSON.stringify(doc), now]);
    await s.db.query('UPDATE agent_blueprints SET latest = $2, draft = NULL, updated_at = $3 WHERE id = $1', [id, version, now]);
    // Installs set to take what asks for no more move now; the others wait with the new version pending.
    const installs = await s.db.many('SELECT * FROM agent_installs WHERE blueprint_id = $1', [id]);
    for (const inst of installs) {
        const from = await versionOf(s, id, inst.version);
        const wider = from ? bp.wider(from.doc, doc) : [];
        if (inst.updates === 'same-or-less' && !wider.length) {
            await s.db.query('UPDATE agent_installs SET version = $2, pending = NULL, updated_at = $3 WHERE agent_id = $1', [inst.agent_id, version, now]);
            await applyToAgent(s, inst.owner, inst.agent_id, doc, parse(inst.inputs) || {});
        } else {
            await s.db.query('UPDATE agent_installs SET pending = $2, updated_at = $3 WHERE agent_id = $1', [inst.agent_id, version, now]);
        }
    }
    return { row: await rowFor(s, id), doc };
}

async function remix(s, owner, id, { version = null } = {}) {
    const src = await get(s, owner, id, { version });
    if (!src) return null;
    if (!src.own && !src.doc.licence) fail(403, 'actor.blueprint.no_licence', 'Its author has not allowed remixes (it names no licence).');
    const from = `${id}@${src.doc.version}`;
    const copy = { ...src.doc, visibility: 'private', name: src.own ? `${src.doc.name} (copy)`.slice(0, 60) : src.doc.name };
    for (const k of ['id', 'version', 'state', 'author', 'published_at', 'created_at', 'updated_at', 'forked_from']) delete copy[k];
    const now = new Date().toISOString();
    const nid = s.newId('bp');
    const row = { id: nid, owner, visibility: 'private', forked_from: src.doc.state === 'draft' ? null : from, created_at: now };
    const doc = asDraft(row, copy, 1);
    const errors = check(doc);
    if (errors.length) fail(422, 'actor.blueprint.invalid', errors.map((e) => `${e.at}: ${e.why}`).join('; '), errors);
    await s.db.query(`INSERT INTO agent_blueprints (id, owner, visibility, latest, draft, forked_from, created_at, updated_at)
        VALUES ($1, $2, 'private', NULL, $3::jsonb, $4, $5, $5)`, [nid, owner, JSON.stringify(doc), row.forked_from, now]);
    if (!src.own) await s.db.query('UPDATE agent_blueprints SET remixes = remixes + 1 WHERE id = $1', [id]);
    return rowFor(s, nid);
}

async function asks(s, viewer, id, { version = null } = {}) {
    const got = await get(s, viewer, id, { version });
    if (!got) return null;
    return { blueprint: `${id}@${got.doc.version}`, asks: bp.asks(got.doc), floor: bp.FLOOR };
}

/** The contact fields an agent made from a blueprint carries: its name and face, model, computer, apps, level. */
function contactOf(doc, inputs) {
    const d = bp.withDefaults(bp.fill(doc, inputs));
    const brain = d.brain;
    const model = brain.pick === 'exact' && brain.model
        ? { engine: 'runtime', model: String(brain.model).slice(0, 120) }
        : { engine: 'runtime', model: brain.pick === 'size' ? ({ small: 'fast', medium: 'smart', strong: 'best' }[brain.size] || 'smart') : 'smart' };
    const order = d.places.order;
    const needs = d.places.needs;
    let computer = null;
    if (order.includes('own') || order.includes('shared')) computer = { kind: 'your-computer', placement: 'link' };
    else if (order.includes('openvibe')) computer = { kind: needs.includes('gpu') ? 'gpu-desktop' : needs.includes('desk') ? 'desktop' : 'kept-browser', placement: 'auto' };
    else if (order.includes('sandbox')) computer = { kind: 'throwaway', placement: 'auto' };
    const apps = [...new Set(d.hands.tools.map((t) => /^connect:([a-z0-9][a-z0-9-]{0,60})/.exec(t.tool)).filter(Boolean).map((m) => `connect.${m[1]}`))].slice(0, 50);
    const face = d.face.avatar || `preset:${d.face.glyph || 'agent'}`;
    return {
        name: d.name, face: String(face).slice(0, 500), voice: d.face.voice || null, model, computer, apps, memory: null,
        level: d.rules.level, instructions: bp.compile(doc, { inputs, install: { agent: 'agt_pending', inputs, places: {} } }).loop.system.slice(0, 20000),
    };
}

async function applyToAgent(s, owner, agentId, doc, inputs) {
    const c = contactOf(doc, inputs);
    await s.db.query(`UPDATE actor_agents SET name = $3, face = $4, voice = $5, model_engine = $6, model_id = $7, computer = $8::jsonb,
        apps = $9::jsonb, level = $10, instructions = $11, updated_at = $12 WHERE id = $1 AND owner = $2`,
    [agentId, owner, c.name, c.face, c.voice, c.model.engine, c.model.model, c.computer ? JSON.stringify(c.computer) : null,
        JSON.stringify(c.apps), c.level, c.instructions, new Date().toISOString()]);
}

/**
 * A person's own agent from one published version. BODY (agents.install@1's inputs): { version?, inputs, agreed,
 * places, updates }. Every ask the install screen showed must be in `agreed`; the inputs are typed and checked.
 */
async function install(s, config, owner, id, body = {}) {
    const got = await get(s, owner, id, { version: body.version != null ? body.version : null });
    if (!got || got.doc.state === 'draft') return null;
    if (got.state === 'retired') fail(409, 'actor.blueprint.retired', 'That version takes no new installs.');
    const inputs = body.inputs && typeof body.inputs === 'object' && !Array.isArray(body.inputs) ? body.inputs : {};
    try { bp.fill(got.doc, inputs); } catch (e) { fail(422, 'actor.blueprint.inputs', e.message, e.errors); }
    const agreed = Array.isArray(body.agreed) ? body.agreed.map(String) : [];
    const missing = bp.unagreed(got.doc, agreed);
    if (missing.length) fail(422, 'actor.blueprint.not_agreed', `Agree to what it asks first: ${missing.map((m) => m.words).join('; ')}.`, missing.map((m) => ({ at: m.key, why: m.words })));
    const updates = body.updates === 'same-or-less' ? 'same-or-less' : 'ask';
    const places = body.places && typeof body.places === 'object' ? {
        own: Array.isArray(body.places.own) ? body.places.own.map(String).slice(0, 20) : [],
        shared: Array.isArray(body.places.shared) ? body.places.shared.map(String).slice(0, 20) : [],
    } : { own: [], shared: [] };
    const fields = contactOf(got.doc, inputs);
    const instructions = fields.instructions;
    delete fields.instructions;
    const made = await contacts.create(s, config, owner, { ...fields, instructions }, { fromBlueprint: true });
    if (!made.row) fail(made.limit ? 429 : 422, made.limit ? 'actor.agent.limit' : 'actor.agent.invalid', made.error || 'The agent could not be made.');
    const now = new Date().toISOString();
    const keys = bp.asks(got.doc).map((a) => a.key).filter((k) => agreed.includes(k));
    await s.db.query(`INSERT INTO agent_installs (agent_id, owner, blueprint_id, version, inputs, agreed, places, updates, pending, installed_at, updated_at)
        VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8, NULL, $9, $9)`,
    [made.row.id, owner, id, got.doc.version, JSON.stringify(inputs), JSON.stringify(keys), JSON.stringify(places), updates, now]);
    if (!got.own) await s.db.query('UPDATE agent_blueprints SET installs = installs + 1 WHERE id = $1', [id]);
    return { agent: made.row, install: await installOf(s, owner, made.row.id) };
}

async function installOf(s, owner, agentId) {
    return s.db.maybe('SELECT * FROM agent_installs WHERE agent_id = $1 AND owner = $2', [agentId, owner]);
}

/** Move an installed agent to VERSION (default: its pending one). A version that asks for more needs those asks agreed. */
async function update(s, config, owner, agentId, body = {}) {
    const inst = await installOf(s, owner, agentId);
    if (!inst) return null;
    const target = body.version != null ? Number(body.version) : inst.pending;
    if (!Number.isInteger(target)) fail(409, 'actor.blueprint.no_update', 'There is no newer version to take.');
    const from = await versionOf(s, inst.blueprint_id, inst.version);
    const to = await versionOf(s, inst.blueprint_id, target);
    if (!to) fail(404, 'actor.blueprint.not_found', 'No such version.');
    const agreed = new Set([...(parse(inst.agreed) || []), ...(Array.isArray(body.agreed) ? body.agreed.map(String) : [])]);
    const wider = from ? bp.wider(from.doc, to.doc) : bp.asks(to.doc);
    const missing = wider.filter((w) => !agreed.has(w.key));
    if (missing.length) fail(422, 'actor.blueprint.not_agreed', `This version asks for more: ${missing.map((m) => m.words).join('; ')}.`, missing.map((m) => ({ at: m.key, why: m.words })));
    const inputs = parse(inst.inputs) || {};
    try { bp.fill(to.doc, inputs); } catch (e) { fail(422, 'actor.blueprint.inputs', e.message, e.errors); }
    const now = new Date().toISOString();
    const keys = bp.asks(to.doc).map((a) => a.key).filter((k) => agreed.has(k) || !wider.some((w) => w.key === k));
    await s.db.query('UPDATE agent_installs SET version = $2, pending = NULL, agreed = $3::jsonb, updated_at = $4 WHERE agent_id = $1',
        [agentId, target, JSON.stringify(keys), now]);
    await applyToAgent(s, owner, agentId, to.doc, inputs);
    return installOf(s, owner, agentId);
}

function wire(row, doc) {
    return {
        id: row.id,
        visibility: row.visibility,
        latest: row.latest == null ? null : Number(row.latest),
        has_draft: !!row.draft,
        forked_from: row.forked_from || null,
        installs: Number(row.installs) || 0,
        remixes: Number(row.remixes) || 0,
        updated_at: row.updated_at,
        ...(doc ? { blueprint: doc } : {}),
    };
}

function installWire(inst) {
    if (!inst) return null;
    return {
        agent: inst.agent_id,
        owner: subjectOf(inst.owner),
        blueprint: `${inst.blueprint_id}@${inst.version}`,
        inputs: parse(inst.inputs) || {},
        agreed: parse(inst.agreed) || [],
        places: parse(inst.places) || { own: [], shared: [] },
        updates: inst.updates,
        pending: inst.pending == null ? null : `${inst.blueprint_id}@${inst.pending}`,
        installed_at: inst.installed_at,
        updated_at: inst.updated_at,
    };
}

module.exports = { create, list, get, saveDraft, publish, remix, asks, install, update, installOf, wire, installWire, contactOf, BlueprintError };

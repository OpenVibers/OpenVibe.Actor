'use strict';

/**
 * A skill is a document: actor.skill@1 (OpenVibe.Contracts, contracts/actor/skill.v1.json; ADR-058).
 *
 * A v1 skill RUNS AS A PROMPT and nothing else: no code, no binary, no install recipe. It carries a name, a
 * one-line description (the only part an agent reads before it loads the skill), Markdown instructions, up to ten
 * TEXT resources, and `requires`: the HO1 kinds (agents/kinds.js), the connected apps and the hosts it may touch.
 * `requires` DECLARES and grants nothing: the agent's level and its approvals still decide every step, and a step
 * of a kind the skill did not declare is a scan finding (server/skills/scan.js).
 *
 * The document carries an INTEGRITY block, not a signature: a sha256 over the canonical JSON, which shows the file
 * was not edited after it was written. It says nothing about who wrote it — anyone can write a file that names an
 * author and compute its hash — so the author in a document is a claim. The registry's listing
 * (actor.skill-listing@1) is the only place a publisher is vouched for.
 *
 *   canonical(doc)      the JSON the hash is taken over: the fields the contract names, in the order it names them
 *   hashOf(doc)         the sha256 of that JSON
 *   read(input)         a document in: the fields it keeps, or the reason it is refused
 *   verify(doc)         does this document still match its own hash?
 */
const crypto = require('crypto');
const kinds = require('../agents/kinds');

const CONTRACT = 'actor.skill@1';
const FIELDS = ['skill', 'slug', 'name', 'description', 'version', 'instructions', 'resources', 'requires', 'runs', 'license', 'author', 'created_at', 'integrity'];
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const SEMVER = /^(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})$/;
const HASH = /^[0-9a-f]{64}$/;
const RESOURCE_PATH = /^[a-z0-9][a-z0-9_-]{0,59}(?:\/[a-z0-9][a-z0-9_-]{0,59}){0,3}\.(md|txt|json|csv)$/;
const MEDIA = ['text/markdown', 'text/plain', 'application/json', 'text/csv'];
const APP = /^[a-z][a-z0-9._-]{0,63}$/;
const HOST = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const SUBJECT = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;

const isPlain = (v) => v && typeof v === 'object' && !Array.isArray(v);
const parse = (v) => (v == null ? null : typeof v === 'string' ? JSON.parse(v) : v);
const list = (v) => { const a = parse(v); return Array.isArray(a) ? a : []; };

/**
 * The canonical JSON of a document: the fields the contract names, in the order it names them. An optional field
 * that is absent or empty is left out; the value is the compact JSON of that object (no spaces).
 */
function canonical(doc) {
    const o = {
        skill: doc.skill,
        slug: doc.slug,
        name: doc.name,
        description: doc.description,
        version: doc.version,
        instructions: doc.instructions,
    };
    const resources = list(doc.resources);
    if (resources.length) o.resources = resources.map((r) => ({ path: r.path, media_type: r.media_type, text: r.text }));
    const requires = doc.requires || {};
    const req = {};
    const ks = list(requires.kinds);
    const apps = list(requires.apps);
    const hosts = list(requires.hosts);
    if (ks.length) req.kinds = ks;
    if (apps.length) req.apps = apps;
    if (hosts.length) req.hosts = hosts;
    if (Object.keys(req).length) o.requires = req;
    o.runs = doc.runs;
    if (doc.license) o.license = doc.license;
    if (doc.author) o.author = doc.author.name ? { subject: doc.author.subject, name: doc.author.name } : { subject: doc.author.subject };
    return JSON.stringify(o);
}

/** The sha256 of the canonical JSON: the document's integrity hash. It says nothing about who wrote the file. */
const hashOf = (doc) => crypto.createHash('sha256').update(canonical(doc), 'utf8').digest('hex');

/**
 * A document in: the fields it keeps (anything the contract does not know is stripped) or the reason it is refused.
 * The hash is checked last, so a document edited after it was written does not match.
 */
function read(input) {
    if (!isPlain(input)) return { error: 'A skill must be a JSON object.' };
    if (input.skill !== CONTRACT) return { error: 'This is not a skill: it says ' + JSON.stringify(input.skill === undefined ? null : input.skill) + '.' };
    const doc = {};
    for (const k of FIELDS) if (input[k] !== undefined) doc[k] = input[k];
    if (typeof doc.slug !== 'string' || !SLUG.test(doc.slug)) return { error: 'The slug must be lowercase letters, digits and hyphens.' };
    if (typeof doc.name !== 'string' || !doc.name.trim() || doc.name.length > 80) return { error: 'The name must be 1–80 characters.' };
    if (typeof doc.description !== 'string' || !doc.description.trim() || doc.description.length > 280) return { error: 'The description must be 1–280 characters: it is the only part an agent reads before it loads the skill.' };
    if (typeof doc.version !== 'string' || !SEMVER.test(doc.version)) return { error: 'The version must be a semantic version (1.0.0).' };
    if (typeof doc.instructions !== 'string' || !doc.instructions.trim() || doc.instructions.length > 20000) return { error: 'The instructions must be 1–20000 characters.' };
    if (doc.runs !== 'prompt') return { error: 'A v1 skill runs as a prompt and nothing else.' };
    if (doc.resources !== undefined) {
        if (!Array.isArray(doc.resources) || doc.resources.length > 10) return { error: 'A skill carries at most 10 resources.' };
        for (const r of doc.resources) {
            if (!isPlain(r)) return { error: 'Each resource must be an object.' };
            if (typeof r.path !== 'string' || !RESOURCE_PATH.test(r.path)) return { error: 'A resource path must be a relative name ending in .md, .txt, .json or .csv.' };
            if (!MEDIA.includes(r.media_type)) return { error: 'A resource media type must be ' + MEDIA.join(', ') + '.' };
            if (typeof r.text !== 'string' || r.text.length > 20000) return { error: 'A resource carries at most 20000 characters of text.' };
        }
    }
    if (doc.requires !== undefined) {
        if (!isPlain(doc.requires)) return { error: 'The requires must be an object.' };
        const ks = list(doc.requires.kinds);
        const apps = list(doc.requires.apps);
        const hosts = list(doc.requires.hosts);
        for (const k of ks) if (!kinds.isKind(k)) return { error: 'A required kind must be one of ' + kinds.KINDS.join(', ') + '.' };
        for (const a of apps) if (typeof a !== 'string' || !APP.test(a)) return { error: 'Each app must be a connect slug.' };
        for (const h of hosts) if (typeof h !== 'string' || !HOST.test(h)) return { error: 'Each host must be a web host (example.com).' };
    }
    if (doc.license !== undefined && (typeof doc.license !== 'string' || !doc.license.trim() || doc.license.length > 64)) return { error: 'The licence must be 1–64 characters.' };
    // The author is a claim: the document may name nobody, and when it names somebody, nothing here checks it.
    if (doc.author !== undefined) {
        if (!isPlain(doc.author)) return { error: 'The author must be a Network subject.' };
        const subject = String(doc.author.subject || '');
        if (!SUBJECT.test(subject)) return { error: 'The author must be a Network subject (usr_…).' };
        const author = { subject };
        if (doc.author.name !== undefined) {
            if (typeof doc.author.name !== 'string' || !doc.author.name.trim() || doc.author.name.length > 80) return { error: 'The author name must be 1–80 characters.' };
            author.name = doc.author.name;
        }
        doc.author = author;
    }
    if (!isPlain(doc.integrity) || doc.integrity.alg !== 'sha256' || !HASH.test(String(doc.integrity.hash || ''))) return { error: 'The integrity block must be a sha256 hash.' };
    if (doc.created_at !== undefined && (typeof doc.created_at !== 'string' || Number.isNaN(Date.parse(doc.created_at)))) return { error: 'created_at must be a timestamp.' };
    if (hashOf(doc) !== doc.integrity.hash) return { error: 'This skill was changed after it was written: the hash does not match.' };
    return { doc };
}

/** Does this document still match its own hash? */
const verify = (doc) => { const r = read(doc); return r.error ? { ok: false, error: r.error } : { ok: true, doc: r.doc }; };

/**
 * The document for a skill, with its hash filled in. `author` is a claim and may be left out: OpenVibe's own skills
 * carry no author, because the registry vouches for the publisher, not the document.
 */
function build(fields) {
    const doc = {
        skill: CONTRACT,
        slug: String(fields.slug || ''),
        name: String(fields.name || ''),
        description: String(fields.description || ''),
        version: String(fields.version || '1.0.0'),
        instructions: String(fields.instructions || ''),
        runs: 'prompt',
        integrity: { alg: 'sha256', hash: '' },
    };
    if (fields.resources && fields.resources.length) doc.resources = fields.resources;
    if (fields.requires) doc.requires = fields.requires;
    if (fields.license) doc.license = String(fields.license);
    if (fields.author) doc.author = fields.author;
    if (fields.created_at) doc.created_at = fields.created_at;
    doc.integrity.hash = hashOf(doc);
    return doc;
}

module.exports = { CONTRACT, FIELDS, MEDIA, canonical, hashOf, read, verify, build, parse };

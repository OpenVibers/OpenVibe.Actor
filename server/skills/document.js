'use strict';

/**
 * A skill is a document: actor.skill@1 or actor.skill@2 (OpenVibe.Contracts, contracts/actor/skill.v1.json and
 * skill.v2.json; ADR-058 and ADR-060).
 *
 * A @1 skill RUNS AS A PROMPT and nothing else: no code, no binary, no install recipe. A @2 skill may also RUN CODE in
 * a sandbox: it carries its code as ordinary TEXT resources (`<name>.js`, `text/javascript`, at most 64 KiB each) and
 * one to five TOOLS, each naming the resource its `entry` runs, its `args` (a JSON Schema subset), the network it may
 * reach (`net`: deny by default, openvibe-only, public) and its limits (wall_ms at most 30 s; mem_bytes at most
 * 256 MiB). The code never runs on an OpenVibe server: Actor stores the scanned bytes in Media and submits a Run job
 * to a Link that declared the skill runner (ADR-060).
 *
 * A skill GRANTS NOTHING in either major: `requires` DECLARES the HO1 kinds it may ask for, the apps and hosts it
 * touches, and the agent's level and approvals still decide every step.
 *
 * The document carries an INTEGRITY block, not a signature: a sha256 over the canonical JSON, which shows the file
 * was not edited after it was written. It says nothing about who wrote it — anyone can write a file that names an
 * author and compute its hash — so the author in a document is a claim. The registry's listing
 * (actor.skill-listing@1 or @2) is the only place a publisher is vouched for.
 *
 *   canonical(doc)      the JSON the hash is taken over: the fields the contract names, in the order it names them
 *   hashOf(doc)         the sha256 of that JSON
 *   read(input)         a document in: the fields it keeps, or the reason it is refused
 *   crossField(doc)     the rules a JSON Schema cannot state: entries, code resources and unique tool names
 *   verify(doc)         does this document still match its own hash?
 */
const crypto = require('crypto');
const contracts = require('openvibe-contracts');
const kinds = require('../agents/kinds');

const CONTRACTS = ['actor.skill@1', 'actor.skill@2'];
const CONTRACT = 'actor.skill@1';
const FIELDS = ['skill', 'slug', 'name', 'description', 'version', 'instructions', 'resources', 'tools', 'requires', 'runs', 'license', 'author', 'created_at', 'integrity'];
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const SEMVER = /^(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})$/;
const HASH = /^[0-9a-f]{64}$/;
const RESOURCE_PATH = /^[a-z0-9][a-z0-9_-]{0,59}(?:\/[a-z0-9][a-z0-9_-]{0,59}){0,3}\.(md|txt|json|csv|js)$/;
const MEDIA = ['text/markdown', 'text/plain', 'application/json', 'text/csv'];
const MEDIA_V2 = [...MEDIA, 'text/javascript'];
const CODE_PATH = /\.js$/;
const APP = /^[a-z][a-z0-9._-]{0,63}$/;
const HOST = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const SUBJECT = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;

const isPlain = (v) => v && typeof v === 'object' && !Array.isArray(v);
const parse = (v) => (v == null ? null : typeof v === 'string' ? JSON.parse(v) : v);
const list = (v) => { const a = parse(v); return Array.isArray(a) ? a : []; };

/** One tool as the canonical JSON carries it: absent net or limits (and absent limits fields) are left out. */
function canonicalTool(tool) {
    const t = tool || {};
    const out = { name: t.name, description: t.description, language: t.language, entry: t.entry, args: t.args };
    if (t.net !== undefined) out.net = t.net;
    if (isPlain(t.limits)) {
        const limits = {};
        if (t.limits.wall_ms !== undefined) limits.wall_ms = t.limits.wall_ms;
        if (t.limits.mem_bytes !== undefined) limits.mem_bytes = t.limits.mem_bytes;
        out.limits = limits;
    }
    return out;
}

/**
 * The canonical JSON of a document: the fields the contract names, in the order it names them. An optional field
 * that is absent or empty is left out; the value is the compact JSON of that object (no spaces). A @2 document adds
 * tools after its resources and before its requires.
 */
function canonical(doc) {
    const v2 = doc.skill === 'actor.skill@2';
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
    if (v2) {
        const tools = list(doc.tools);
        if (tools.length) o.tools = tools.map(canonicalTool);
    }
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

/** The code resources of a document: what a tool's entry must name. */
const codeResources = (doc) => list(doc.resources).filter((r) => isPlain(r) && (r.media_type === 'text/javascript' || CODE_PATH.test(String(r.path || ''))));

/**
 * The cross-field rules a JSON Schema cannot state (ADR-060): every tool's entry is one of the skill's own code
 * resources, every code resource is some tool's entry, and tool names are unique. It also refuses an args pattern
 * JavaScript cannot compile (a broken regex would be a broken tool).
 * Returns the reason it is refused, or null.
 */
function crossField(doc) {
    const resources = list(doc.resources);
    const tools = list(doc.tools);
    const paths = new Map(resources.filter(isPlain).map((r) => [String(r.path || ''), r]));
    const names = new Set();
    for (const tool of tools) {
        if (!isPlain(tool)) return 'Each tool must be an object.';
        const name = String(tool.name || '');
        if (names.has(name)) return `The tool name ${JSON.stringify(name)} is used twice: a skill's tool names must be unique.`;
        names.add(name);
        const entry = paths.get(String(tool.entry || ''));
        if (!entry) return `The tool ${JSON.stringify(name)} runs ${JSON.stringify(String(tool.entry || ''))}, which is not one of the skill's resources.`;
        if (entry.media_type !== 'text/javascript' || !CODE_PATH.test(String(entry.path || ''))) {
            return `The tool ${JSON.stringify(name)} runs ${JSON.stringify(entry.path)}, which is not a .js code resource.`;
        }
        const args = isPlain(tool.args) ? tool.args : {};
        const props = isPlain(args.properties) ? args.properties : {};
        for (const [key, schema] of Object.entries(props)) {
            if (!isPlain(schema) || typeof schema.pattern !== 'string') continue;
            try { new RegExp(schema.pattern); } catch (err) {
                return `The tool ${JSON.stringify(name)} has a pattern for ${JSON.stringify(key)} that is not a regular expression.`;
            }
        }
    }
    for (const r of codeResources(doc)) {
        const path = String(r.path || '');
        if (!tools.some((t) => isPlain(t) && t.entry === path)) {
            return `The code resource ${JSON.stringify(path)} is not the entry of any tool: every code resource must be run by a tool.`;
        }
    }
    return null;
}

/** @1: the manual checks the released contract states, kept as they were before @2. */
function readV1(doc) {
    if (typeof doc.slug !== 'string' || !SLUG.test(doc.slug)) return { error: 'The slug must be lowercase letters, digits and hyphens.' };
    if (typeof doc.name !== 'string' || !doc.name.trim() || doc.name.length > 80) return { error: 'The name must be 1–80 characters.' };
    if (typeof doc.description !== 'string' || !doc.description.trim() || doc.description.length > 280) return { error: 'The description must be 1–280 characters: it is the only part an agent reads before it loads the skill.' };
    if (typeof doc.version !== 'string' || !SEMVER.test(doc.version)) return { error: 'The version must be a semantic version (1.0.0).' };
    if (typeof doc.instructions !== 'string' || !doc.instructions.trim() || doc.instructions.length > 20000) return { error: 'The instructions must be 1–20000 characters.' };
    if (doc.runs !== 'prompt') return { error: 'A v1 skill runs as a prompt and nothing else.' };
    if (doc.tools !== undefined) return { error: 'A prompt skill carries no tools: tools are for a skill that runs in a sandbox (actor.skill@2).' };
    if (doc.resources !== undefined) {
        if (!Array.isArray(doc.resources) || doc.resources.length > 10) return { error: 'A skill carries at most 10 resources.' };
        for (const r of doc.resources) {
            if (!isPlain(r)) return { error: 'Each resource must be an object.' };
            if (typeof r.path !== 'string' || !RESOURCE_PATH.test(r.path) || CODE_PATH.test(r.path)) return { error: 'A v1 resource path must be a relative name ending in .md, .txt, .json or .csv.' };
            if (!MEDIA.includes(r.media_type)) return { error: 'A v1 resource media type must be ' + MEDIA.join(', ') + '.' };
            if (typeof r.text !== 'string' || r.text.length > 20000) return { error: 'A resource carries at most 20000 characters of text.' };
        }
    }
    if (doc.requires !== undefined) {
        if (!isPlain(doc.requires)) return { error: 'The requires must be an object.' };
        const ks = list(doc.requires.kinds);
        const apps = list(doc.requires.apps);
        const hosts = list(doc.requires.hosts);
        for (const k of ks) {
            if (!kinds.isKind(k)) return { error: 'A required kind must be one of ' + kinds.KINDS.join(', ') + '.' };
            if (k === 'skill.run') return { error: 'A v1 skill may not declare skill.run: only a sandbox skill (actor.skill@2) runs code.' };
        }
        for (const a of apps) if (typeof a !== 'string' || !APP.test(a)) return { error: 'Each app must be a connect slug.' };
        for (const h of hosts) if (typeof h !== 'string' || !HOST.test(h)) return { error: 'Each host must be a web host (example.com).' };
    }
    return null;
}

/** @2: the released schema does the shape, then the cross-field rules and the hash (checked by read()). */
function readV2(doc) {
    if (doc.runs === 'sandbox' && !isPlain(doc.requires)) return { error: 'A sandbox skill must declare its requires (including skill.run).' };
    if (doc.resources !== undefined && (!Array.isArray(doc.resources) || doc.resources.length > 10)) return { error: 'A skill carries at most 10 resources.' };
    let v;
    try { v = contracts.validate('actor.skill@2', doc); } catch (err) { return { error: String((err && err.message) || err).slice(0, 300) }; }
    if (!v.valid) {
        const first = (v.errors || []).find((e) => e && (e.message || e.instancePath)) || (v.errors || [])[0];
        const where = first && first.instancePath ? `${first.instancePath} ` : '';
        return { error: `This is not an actor.skill@2 document: ${where}${String((first && first.message) || 'the schema refused it').slice(0, 240)}` };
    }
    const cross = crossField(doc);
    if (cross) return { error: cross };
    return null;
}

/**
 * A document in: the fields it keeps (anything the contract does not know is stripped) or the reason it is refused.
 * The hash is checked last, so a document edited after it was written does not match.
 */
function read(input) {
    if (!isPlain(input)) return { error: 'A skill must be a JSON object.' };
    if (!CONTRACTS.includes(input.skill)) return { error: 'This is not a skill: it says ' + JSON.stringify(input.skill === undefined ? null : input.skill) + '.' };
    const doc = {};
    for (const k of FIELDS) if (input[k] !== undefined) doc[k] = input[k];
    const v2 = doc.skill === 'actor.skill@2';
    const bad = v2 ? readV2(doc) : readV1(doc);
    if (bad) return bad;
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
 * The document for a skill, with its hash filled in. A sandbox skill is an actor.skill@2; anything else is the
 * prompt-only actor.skill@1. `author` is a claim and may be left out: OpenVibe's own skills carry no author.
 */
function build(fields) {
    const sandbox = fields.runs ? fields.runs === 'sandbox' : (Array.isArray(fields.tools) && fields.tools.length > 0);
    const doc = {
        skill: sandbox ? 'actor.skill@2' : CONTRACT,
        slug: String(fields.slug || ''),
        name: String(fields.name || ''),
        description: String(fields.description || ''),
        version: String(fields.version || '1.0.0'),
        instructions: String(fields.instructions || ''),
        runs: sandbox ? 'sandbox' : 'prompt',
        integrity: { alg: 'sha256', hash: '' },
    };
    if (fields.resources && fields.resources.length) doc.resources = fields.resources;
    if (sandbox && Array.isArray(fields.tools) && fields.tools.length) doc.tools = fields.tools;
    if (fields.requires) doc.requires = fields.requires;
    if (fields.license) doc.license = String(fields.license);
    if (fields.author) doc.author = fields.author;
    if (fields.created_at) doc.created_at = fields.created_at;
    doc.integrity.hash = hashOf(doc);
    return doc;
}

module.exports = { CONTRACT, CONTRACTS, FIELDS, MEDIA, MEDIA_V2, canonical, canonicalTool, hashOf, read, verify, build, crossField, codeResources, parse };

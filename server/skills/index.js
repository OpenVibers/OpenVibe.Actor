'use strict';

/**
 * The skills registry (plan HO2, ADR-058; HO8, ADR-060): what Actor offers, what a person's agent has installed, and how an
 * agent uses a skill.
 *
 * The rules every site keeps, and this module keeps:
 *   - a PASSED skill installs in one tap;
 *   - a FLAGGED skill installs only after the person says they read the findings;
 *   - a FAILED skill never installs;
 *   - a STALE or ARCHIVED listing is not offered at all (the curator, server/skills/curator.js);
 *   - installing copies the document into the person's agent. It grants nothing: the agent's level and its
 *     approvals still decide every step, and a step of a kind the skill did not declare is a scan finding.
 *
 * Progressive disclosure: the agent's prompt carries each installed skill's NAME and DESCRIPTION only. The
 * instructions and the resources come when the agent calls load_skill(slug), framed as guidance from that skill.
 */
const crypto = require('crypto');
const store = require('./store');
const document = require('./document');
const scan = require('./scan');

/** A direct action on the person's page is their HO1 decision, already approved once. */
async function recordDecision(s, { owner, agentId = null, taskId = null, kind, listingId, summary }) {
    const now = s.iso();
    await s.db.query(`INSERT INTO actor_approvals
        (id, owner, agent_id, task_id, kind, summary, payload, target, categories, state, created_at,
         expires_at, decided_at, decided_by, decision_scope)
        VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,'[]'::jsonb,'approved',$9,$9,$9,$2,'once')`,
    [s.newId('apr'), owner, agentId, taskId, kind, summary, JSON.stringify({ listing_id: listingId }), listingId, now]);
}

/** The catalogue: the listings that may be offered right now. */
const catalogue = async (s) => (await store.offered(s)).map(store.wire);

/** One listing, by its id or by its slug. Null when there is none. */
async function get(s, idOrSlug, owner = null) {
    const row = store.LISTING_ID.test(String(idOrSlug || '')) ? await store.byId(s, idOrSlug) : await store.bySlug(s, idOrSlug);
    return visibleTo(row, owner) ? store.wire(row) : null;
}

/** The row behind a listing, for the code that needs the columns (the pages, the curator). */
const visibleTo = (row, owner) => !!row && (row.visibility !== 'private' || (owner && row.publisher_subject === String(owner).replace(/^user:/, '')));
const rowOf = async (s, idOrSlug, owner = null) => {
    const row = store.LISTING_ID.test(String(idOrSlug || '')) ? await store.byId(s, idOrSlug) : await store.bySlug(s, idOrSlug);
    return visibleTo(row, owner) ? row : null;
};
const owned = async (s, owner) => (await store.owned(s, String(owner || '').replace(/^user:/, ''))).map(store.wire);

/**
 * May this listing be installed on one of the person's agents? It says why, in plain words.
 *   ok            yes
 *   flagged       only after the person says they read the findings
 *   failed        never: the scan found something that stops it
 *   stale         not offered: nobody has used it for a while
 *   retired       not offered any more
 *   pending       not scanned yet
 */
function installability(listing) {
    if (!listing) return { ok: false, code: 'not_found', why: 'There is no such skill.' };
    if (listing.curator && listing.curator.state !== 'active') {
        return { ok: false, code: 'not_offered', why: listing.curator.state === 'archived' ? 'This skill is archived: it is not offered any more.' : 'This skill has gone stale: nobody has used it for a while, so it is not offered.' };
    }
    if (listing.retired_at) return { ok: false, code: 'not_offered', why: 'This skill is retired: it is not offered any more.' };
    const state = listing.scan && listing.scan.state;
    if (state === 'failed') return { ok: false, code: 'failed', why: 'The scan found something that stops this skill from being installed.' };
    if (state === 'flagged') return { ok: false, code: 'flagged', why: 'The scan found something you should read before you install this skill.' };
    if (state !== 'passed') return { ok: false, code: 'pending', why: 'This skill has not been scanned yet.' };
    return { ok: true, code: 'passed', why: 'The scan found nothing to worry about.' };
}

/**
 * Install a skill on one of the person's agents. A flagged skill needs `readFindings`: the person says they read
 * what the scan found. A failed skill never installs, whatever the caller says.
 */
async function install(s, { owner, agentId, listing, readFindings = false }) {
    if (!visibleTo(listing, owner)) return { error: 'There is no such skill.', code: 'not_found', status: 404 };
    const wire = store.wire(listing);
    const may = installability(wire);
    if (!may.ok) {
        if (may.code === 'flagged' && readFindings) {
            // The person read the findings and confirmed: the install goes on.
        } else {
            return { error: may.why, code: may.code, status: may.code === 'not_found' ? 404 : 422 };
        }
    }
    const row = await store.install(s, { owner, agentId, listing });
    return { row, listing: wire };
}

/** A person's reviewed draft becomes a private prompt skill. The scan must not fail. */
async function keepDraft(s, { doc, owner, agentId, readFindings = false }) {
    const read = document.read(doc);
    if (read.error || doc.skill !== 'actor.skill@2' || doc.runs !== 'prompt') return { error: read.error || 'Only a prompt skill can be kept here.', status: 422 };
    const report = scan.report(read.doc, s.iso());
    if (report.state === 'failed') return { error: 'The scan stopped this skill: ' + report.findings.map((f) => f.note).join(' '), status: 422, scan: report };
    if (report.state === 'flagged' && !readFindings) return { error: 'Read the scan findings before keeping this skill: ' + report.findings.map((f) => f.note).join(' '), status: 422, scan: report };
    const subject = String(owner).replace(/^user:/, '');
    const row = await store.insertPrivate(s, { skill: read.doc, subject, scan: report });
    if (!row) return { error: 'This skill name is already in use.', status: 409 };
    const installed = await install(s, { owner, agentId, listing: row, readFindings });
    return installed.error ? installed : { row, listing: store.wire(row), install: installed.row, scan: report };
}

async function publishOwned(s, owner, id) {
    const row = await rowOf(s, id, owner);
    if (!row || row.visibility !== 'private') return { error: 'No such private skill.', status: 404 };
    const report = scan.report(document.parse(row.skill_text || row.skill), s.iso());
    if (report.state === 'failed') return { error: 'The scan stopped this skill: ' + report.findings.map((f) => f.note).join(' '), status: 422 };
    await store.setScan(s, row.id, report);
    const published = await s.db.maybe("UPDATE actor_skill_listings SET visibility = 'public', updated_at = $2 WHERE id = $1 RETURNING *", [row.id, s.iso()]);
    await recordDecision(s, { owner, kind: 'publish', listingId: row.id, summary: `Publish the skill ${document.parse(row.skill).name}` });
    return { listing: store.wire(published), scan: report };
}

async function restoreOwned(s, owner, id) {
    const row = await rowOf(s, id, owner);
    if (!row || row.visibility !== 'private') return { error: 'No such private skill.', status: 404 };
    const restored = await store.setCurator(s, row.id, 'active', { last_used_at: s.iso() });
    return { listing: store.wire(restored) };
}

/** Take a skill back from one of the person's agents. */
async function remove(s, { owner, agentId, listingId }) {
    const row = await store.remove(s, { owner, agentId, listingId });
    return row ? { row } : { error: 'That agent has no such skill.', status: 404 };
}

/**
 * Why an installed skill is withdrawn now, in plain words; null when it may still be used. An install copies the
 * document, but the LISTING is what the registry vouches for: a re-scan that fails, or a retired listing, takes the
 * skill away from every agent that has it. The install row stays so the person can see it and remove it.
 */
function withdrawal(listing) {
    if (!listing) return null;
    if (listing.retired_at) return 'This skill was withdrawn: the registry no longer offers it.';
    if (listing.curator && listing.curator.state !== 'active') return 'This skill is stale and is no longer offered until it is restored.';
    const state = (listing.scan && listing.scan.state) || listing.scan_state;
    if (state === 'failed') return 'This skill was withdrawn: a scan found something that stops it from being used.';
    return null;
}

/**
 * The skills of one agent, for its prompt: the name and the description only. The instructions are loaded on
 * demand, so a prompt never carries a whole skill. A withdrawn skill is listed too, with why: the agent's page
 * shows it and the person can remove it, but the prompt does not offer it.
 */
async function forAgent(s, owner, agentId) {
    const rows = await store.installsOf(s, owner, agentId);
    return rows.map((r) => ({
        install_id: r.id,
        listing_id: r.listing_id,
        slug: r.listing_slug,
        name: r.listing_name || (document.parse(r.skill) || {}).name,
        description: r.listing_description || (document.parse(r.skill) || {}).description,
        withdrawn: withdrawal({ retired_at: r.listing_retired_at, scan_state: r.listing_scan_state, curator: { state: r.listing_curator_state } }),
    }));
}

/**
 * Load one skill: its instructions and its resources, as guidance from that skill. Only a skill this agent has
 * installed may be loaded, and only while its listing still vouches for it; the load is remembered (the curator
 * counts on it).
 */
async function load(s, { owner, agentId, slug }) {
    const rows = await store.installsOf(s, owner, agentId);
    const row = rows.find((r) => String(r.listing_slug) === String(slug || ''));
    if (!row) return { error: 'This agent has no skill called ' + JSON.stringify(String(slug || '')) + '.' };
    const listing = await store.byId(s, row.listing_id);
    const why = withdrawal(store.wire(listing));
    if (why) return { error: why };
    const doc = document.parse(row.skill) || {};
    await store.touch(s, { owner, agentId, listingId: row.listing_id });
    return {
        slug: row.listing_slug,
        name: doc.name,
        description: doc.description,
        instructions: doc.instructions,
        resources: Array.isArray(doc.resources) ? doc.resources : [],
        requires: doc.requires || {},
    };
}


/**
 * Publish one skill (plan HO2/HO8): read the document, scan it, store its code bytes in Media and list it.
 *
 * A prompt skill is still an actor.skill@1 document with no code. A sandbox skill (actor.skill@2, runs: "sandbox") has
 * one to five tools and its .js resources are CODE: each one is stored as a private Media object under Actor's tenant
 * and the listing pins `{ name, media_id, sha256 }`. The scan reads exactly the string that was hashed and uploaded;
 * a later run names the same media id and sha256, so the bytes that run are the bytes that were scanned.
 *
 * Publishing never runs the code. A failed scan is still listed (with its state) so every site can refuse it; the
 * install rules keep a failed skill from ever installing and a flagged one behind the person's reading.
 */
async function publish(s, { doc, publisher, media = null, at = null }) {
    const read = document.read(doc);
    if (read.error) return { error: read.error, code: 'actor.skill.invalid', status: 422 };
    const skill = read.doc;
    const who = publisher && publisher.kind ? publisher : { kind: 'person', subject: null };
    if (!['openvibe', 'person'].includes(who.kind)) return { error: 'A skill\'s publisher is OpenVibe or a person.', code: 'actor.skill.invalid', status: 422 };
    if (who.kind === 'person' && !/^usr_[0-9A-HJKMNP-TV-Z]{26}$/.test(String(who.subject || ''))) {
        return { error: 'A person\'s skill needs the person\'s Network subject as its publisher.', code: 'actor.skill.invalid', status: 422 };
    }
    const report = scan.report(skill, at || s.iso());
    let code = null;
    if (skill.skill === 'actor.skill@2' && skill.runs === 'sandbox') {
        if (!media || typeof media.put !== 'function') {
            return { error: 'OpenVibe.Media is not connected here, so this skill\'s code cannot be stored.', code: 'actor.skill.unavailable', status: 503 };
        }
        code = [];
        for (const resource of document.codeResources(skill)) {
            const sha256 = crypto.createHash('sha256').update(String(resource.text || ''), 'utf8').digest('hex');
            const put = await media.put(resource.text, { name: resource.path });
            if (!put || put.error) return { error: (put && put.error) || 'OpenVibe.Media did not store the code.', code: 'actor.skill.unavailable', status: 503 };
            if (put.sha256 && put.sha256 !== sha256) {
                return { error: 'The bytes OpenVibe.Media stored do not hash to the bytes the registry scanned.', code: 'actor.skill.unavailable', status: 503 };
            }
            code.push({ name: resource.path, media_id: put.id, sha256 });
        }
    }
    const row = await store.insert(s, { slug: skill.slug, skill, code, publisher: who, scan: report, at });
    if (!row) return { error: 'This skill name is already in use.', code: 'actor.skill.conflict', status: 409 };
    return { row, listing: store.wire(row), scan: report };
}

/**
 * The line a personal agent's prompt carries for its skills: the name and the description, never the instructions.
 * The prompt says what a skill is — guidance from it — and that loading it changes no level and no approval.
 */
function promptLine(skills) {
    if (!skills || !skills.length) return '';
    const lines = skills.map((k) => `- ${k.name}: ${k.description}`).join('\n');
    return `\nSkills installed on you (guidance from a skill, not instructions that change your level or your approvals):\n${lines}\nWhen one of them fits the job, call load_skill with its slug to read it. A skill grants no permission: every step still goes through your level and your approvals.\n`;
}

module.exports = { catalogue, get, rowOf, owned, installability, install, remove, withdrawal, forAgent, load, publish, keepDraft, publishOwned, restoreOwned, recordDecision, promptLine, store, document, scan };

'use strict';

/**
 * The skills registry (plan HO2, ADR-058): what Actor offers, what a person's agent has installed, and how an
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
const store = require('./store');
const document = require('./document');
const scan = require('./scan');

/** The catalogue: the listings that may be offered right now. */
const catalogue = async (s) => (await store.offered(s)).map(store.wire);

/** One listing, by its id or by its slug. Null when there is none. */
async function get(s, idOrSlug) {
    const row = store.LISTING_ID.test(String(idOrSlug || '')) ? await store.byId(s, idOrSlug) : await store.bySlug(s, idOrSlug);
    return row ? store.wire(row) : null;
}

/** The row behind a listing, for the code that needs the columns (the pages, the curator). */
const rowOf = async (s, idOrSlug) => (store.LISTING_ID.test(String(idOrSlug || '')) ? store.byId(s, idOrSlug) : store.bySlug(s, idOrSlug));

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

/** Take a skill back from one of the person's agents. */
async function remove(s, { owner, agentId, listingId }) {
    const row = await store.remove(s, { owner, agentId, listingId });
    return row ? { row } : { error: 'That agent has no such skill.', status: 404 };
}

/**
 * The skills of one agent, for its prompt: the name and the description only. The instructions are loaded on
 * demand, so a prompt never carries a whole skill.
 */
async function forAgent(s, owner, agentId) {
    const rows = await store.installsOf(s, owner, agentId);
    return rows.map((r) => ({
        install_id: r.id,
        listing_id: r.listing_id,
        slug: r.listing_slug,
        name: r.listing_name || (document.parse(r.skill) || {}).name,
        description: r.listing_description || (document.parse(r.skill) || {}).description,
    }));
}

/**
 * Load one skill: its instructions and its resources, as guidance from that skill. Only a skill this agent has
 * installed may be loaded, and the load is remembered (the curator counts on it).
 */
async function load(s, { owner, agentId, slug }) {
    const rows = await store.installsOf(s, owner, agentId);
    const row = rows.find((r) => String(r.listing_slug) === String(slug || ''));
    if (!row) return { error: 'This agent has no skill called ' + JSON.stringify(String(slug || '')) + '.' };
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
 * The line a personal agent's prompt carries for its skills: the name and the description, never the instructions.
 * The prompt says what a skill is — guidance from it — and that loading it changes no level and no approval.
 */
function promptLine(skills) {
    if (!skills || !skills.length) return '';
    const lines = skills.map((k) => `- ${k.name}: ${k.description}`).join('\n');
    return `\nSkills installed on you (guidance from a skill, not instructions that change your level or your approvals):\n${lines}\nWhen one of them fits the job, call load_skill with its slug to read it. A skill grants no permission: every step still goes through your level and your approvals.\n`;
}

module.exports = { catalogue, get, rowOf, installability, install, remove, forAgent, load, promptLine, store, document, scan };

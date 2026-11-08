'use strict';

/**
 * The registry's rows (plan HO2, ADR-058): the listings it vouches for, and what one of a person's agents has
 * installed.
 *
 * A LISTING is one row per skill the registry offers: the document as published (actor.skill@1 or @2), the publisher the
 * registry vouches for, the scan's state and findings, and the curator's state. OpenVibe's own skills are publisher
 * kind 'openvibe'; a person's are 'person'. The listing is the only place a publisher is vouched for: the author
 * inside a document is only a claim. A sandbox listing also carries its code pins (Media id and sha256 per code resource).
 *
 * An INSTALL is one row per (person, agent, listing): the document as it was installed, its version, when it was
 * installed, when it was taken back and when it was last loaded. Both tables go with the person
 * (server/identity/account-data.js).
 */
const LISTING_ID = /^skl_[0-9A-HJKMNP-TV-Z]{26}$/;
const INSTALL_ID = /^ski_[0-9A-HJKMNP-TV-Z]{26}$/;
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

const parse = (v) => (v == null ? null : typeof v === 'string' ? JSON.parse(v) : v);

/** The listing as the contract wants it: actor.skill-listing@1 for a prompt skill, @2 for a sandbox skill. */
function wire(row) {
    if (!row) return null;
    const scan = parse(row.scan) || {};
    const curator = parse(row.curator) || {};
    const skill = parse(row.skill_text != null ? row.skill_text : row.skill);
    const code = parse(row.code);
    const sandbox = !!skill && (skill.skill === 'actor.skill@2' || skill.runs === 'sandbox');
    return {
        listing: sandbox ? 'actor.skill-listing@2' : 'actor.skill-listing@1',
        id: row.id,
        skill,
        ...(sandbox && Array.isArray(code) && code.length ? { code } : {}),
        publisher: {
            kind: row.publisher_kind,
            ...(row.publisher_subject ? { subject: row.publisher_subject } : {}),
            ...(row.publisher_name ? { name: row.publisher_name } : {}),
        },
        scan: { state: row.scan_state, ...(scan.scanner ? { scanner: scan.scanner } : {}), ...(scan.scanned_at ? { scanned_at: scan.scanned_at } : {}), ...(scan.findings && scan.findings.length ? { findings: scan.findings } : {}) },
        curator: { state: row.curator_state, ...(curator.last_used_at ? { last_used_at: curator.last_used_at } : {}), ...(curator.near_duplicate_of ? { near_duplicate_of: curator.near_duplicate_of } : {}) },
        installs: Number(row.installs) || 0,
        listed_at: row.listed_at,
        ...(row.retired_at ? { retired_at: row.retired_at } : {}),
    };
}

const byId = (s, id) => (LISTING_ID.test(String(id || '')) ? s.db.maybe('SELECT * FROM actor_skill_listings WHERE id = $1', [id]) : null);
const bySlug = (s, slug) => (SLUG.test(String(slug || '')) ? s.db.maybe('SELECT * FROM actor_skill_listings WHERE slug = $1', [slug]) : null);

/** Every listing that may be offered: not retired, and not stale or archived by the curator. */
const offered = (s) => s.db.many(`SELECT * FROM actor_skill_listings
    WHERE retired_at IS NULL AND curator_state = 'active' ORDER BY listed_at DESC, id`);

/** Every listing, retired ones included: what the curator works on and what an id may still answer. */
const all = (s) => s.db.many('SELECT * FROM actor_skill_listings ORDER BY listed_at DESC, id');

/** A listing and its scan, as the catalogue shows it. */
async function insert(s, { slug, skill, code = null, publisher, scan, at = null }) {
    const now = at || s.iso();
    // The document's JSON text preserves the order it was written in; jsonb would reorder nested args objects and
    // break the integrity hash. The text is the listing's answer, the jsonb copy is for queries.
    const text = JSON.stringify(skill);
    return s.db.maybe(`INSERT INTO actor_skill_listings
        (id, slug, skill, skill_text, code, publisher_kind, publisher_subject, publisher_name, scan_state, scan, curator_state, curator, installs, listed_at, created_at, updated_at)
        VALUES ($1,$2,$3::jsonb,$4,$5::jsonb,$6,$7,$8,$9,$10::jsonb,'active','{}'::jsonb,0,$11,$11,$11)
        ON CONFLICT (slug) DO UPDATE SET skill = EXCLUDED.skill, skill_text = EXCLUDED.skill_text, code = EXCLUDED.code, scan_state = EXCLUDED.scan_state, scan = EXCLUDED.scan, updated_at = EXCLUDED.updated_at
        RETURNING *`, [
        s.newId('skl'), String(slug), JSON.stringify(skill), text, code ? JSON.stringify(code) : null, publisher.kind, publisher.subject || null, publisher.name || null,
        (scan && scan.state) || 'pending', JSON.stringify(scan || {}), now,
    ]);
}

/** The scan of a listing, kept with it: the state and the findings travel to every site. */
async function setScan(s, id, scan, at = null) {
    return s.db.maybe('UPDATE actor_skill_listings SET scan_state = $2, scan = $3::jsonb, updated_at = $4 WHERE id = $1 RETURNING *',
    [id, scan.state, JSON.stringify(scan), at || s.iso()]);
}

/** The curator's state of a listing: active, stale or archived. */
async function setCurator(s, id, state, extra = {}, at = null) {
    const row = await byId(s, id);
    if (!row) return null;
    const curator = { ...(parse(row.curator) || {}), ...extra };
    return s.db.maybe('UPDATE actor_skill_listings SET curator_state = $2, curator = $3::jsonb, updated_at = $4 WHERE id = $1 RETURNING *',
    [id, state, JSON.stringify(curator), at || s.iso()]);
}

/** A listing that is retired is not offered any more, but its id still answers. */
async function retire(s, id, at = null) {
    return s.db.maybe('UPDATE actor_skill_listings SET retired_at = $2, updated_at = $2 WHERE id = $1 RETURNING *', [id, at || s.iso()]);
}

/** The installs of one agent, newest first: what its page lists and what its prompt may name. */
const installsOf = (s, owner, agentId) => s.db.many(`SELECT i.*, l.slug AS listing_slug, l.skill AS listing_skill, l.skill_text AS listing_skill_text, l.code AS listing_code,
        l.skill->>'name' AS listing_name, l.skill->>'description' AS listing_description,
        l.scan_state AS listing_scan_state, l.scan AS listing_scan, l.retired_at AS listing_retired_at,
        l.curator_state AS listing_curator_state, l.publisher_kind AS listing_publisher_kind
    FROM actor_skill_installs i JOIN actor_skill_listings l ON l.id = i.listing_id
    WHERE i.owner = $1 AND i.agent_id = $2 AND i.removed_at IS NULL ORDER BY i.installed_at DESC`, [owner, agentId]);

/** Every install of a person: their account export and their deletion. */
const installsOfOwner = (s, owner) => s.db.many('SELECT * FROM actor_skill_installs WHERE owner = $1 ORDER BY installed_at DESC', [owner]);

const installOf = (s, owner, agentId, listingId) => s.db.maybe(
    'SELECT * FROM actor_skill_installs WHERE owner = $1 AND agent_id = $2 AND listing_id = $3', [owner, agentId, listingId]);

/** Install a skill on one of the person's agents: the document as it was installed, and the version it had. */
async function install(s, { owner, agentId, listing, at = null }) {
    const now = at || s.iso();
    const skill = parse(listing.skill) || {};
    const out = await s.tx(async () => {
        const row = await s.db.maybe(`INSERT INTO actor_skill_installs (id, owner, agent_id, listing_id, skill, version, installed_at)
            VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7)
            ON CONFLICT (owner, agent_id, listing_id) DO UPDATE SET skill = EXCLUDED.skill, version = EXCLUDED.version,
                installed_at = EXCLUDED.installed_at, removed_at = NULL
            RETURNING *`, [s.newId('ski'), owner, agentId, listing.id, JSON.stringify(skill), String(skill.version || ''), now]);
        await s.db.query('UPDATE actor_skill_listings SET installs = (SELECT count(*) FROM actor_skill_installs WHERE listing_id = $1 AND removed_at IS NULL), updated_at = $2 WHERE id = $1', [listing.id, now]);
        return row;
    });
    return out;
}

/** Take a skill back: the row stays (one per agent and listing) and says when it was removed. */
async function remove(s, { owner, agentId, listingId, at = null }) {
    const now = at || s.iso();
    const out = await s.tx(async () => {
        const row = await s.db.maybe('UPDATE actor_skill_installs SET removed_at = $4 WHERE owner = $1 AND agent_id = $2 AND listing_id = $3 AND removed_at IS NULL RETURNING *',
        [owner, agentId, listingId, now]);
        if (row) await s.db.query('UPDATE actor_skill_listings SET installs = (SELECT count(*) FROM actor_skill_installs WHERE listing_id = $1 AND removed_at IS NULL), updated_at = $2 WHERE id = $1', [listingId, now]);
        return row;
    });
    return out;
}

/** A skill was loaded: the install and the listing remember it (the curator counts on it). */
async function touch(s, { owner, agentId, listingId, at = null }) {
    const now = at || s.iso();
    await s.db.query('UPDATE actor_skill_installs SET last_used_at = $4 WHERE owner = $1 AND agent_id = $2 AND listing_id = $3', [owner, agentId, listingId, now]);
    await s.db.query(`UPDATE actor_skill_listings SET curator = jsonb_set(curator, '{last_used_at}', to_jsonb($2::text), true), updated_at = $2 WHERE id = $1`, [listingId, now]);
}

module.exports = { LISTING_ID, INSTALL_ID, SLUG, wire, byId, bySlug, offered, all, insert, setScan, setCurator, retire, installsOf, installsOfOwner, installOf, install, remove, touch };

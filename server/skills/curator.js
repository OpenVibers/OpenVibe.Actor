'use strict';

/**
 * The curator (plan HO2, ADR-058): what is used stays, what is not goes stale.
 *
 * The curator ships with the catalogue, not after it: a listing nobody has loaded for 30 days is stale, and for 90
 * days it is archived. A stale or an archived listing is not offered any more — it is still readable, and a listing
 * that is used again comes back.
 *
 * The job is DUE-BASED: it asks what is due, rather than deciding on a fixed day. It runs at night (server/index.js
 * starts it), never on a weekly setInterval, and it is off in a drill and in a test.
 */
const store = require('./store');

const STALE_DAYS = 30;
const PRIVATE_STALE_DAYS = 60;
const ARCHIVE_DAYS = 90;
const DAY = 86_400_000;

const parse = (v) => (v == null ? null : typeof v === 'string' ? JSON.parse(v) : v);

/** What is due for one listing: how long since anybody loaded it. */
function due(row, now) {
    const curator = parse(row.curator) || {};
    // A listing nobody ever loaded counts from the day it was listed.
    const since = curator.last_used_at || row.listed_at || row.created_at;
    const at = Date.parse(since || '');
    if (!Number.isFinite(at)) return { days: 0, state: row.curator_state };
    return { days: (now - at) / DAY, state: row.curator_state };
}

/**
 * One pass of the curator: what is due is marked. A listing nobody has used for 30 days goes stale; for 90 days it
 * is archived. A listing that was used since the last pass stays active.
 */
async function run(s, { at = null, log = console } = {}) {
    const now = at ? Date.parse(at) : Date.now();
    const rows = await store.all(s);
    const own = rows.filter((r) => r.visibility === 'private');
    const counts = { stale: 0, archived: 0, active: 0 };
    for (const row of rows) {
        if (row.retired_at) continue;
        const { days, state } = due(row, now);
        if (row.visibility !== 'private' && days >= ARCHIVE_DAYS) {
            if (state !== 'archived') { await store.setCurator(s, row.id, 'archived', {}, new Date(now).toISOString()); counts.archived += 1; }
            continue;
        }
        if (days >= (row.visibility === 'private' ? PRIVATE_STALE_DAYS : STALE_DAYS)) {
            if (state === 'active') { await store.setCurator(s, row.id, 'stale', {}, new Date(now).toISOString()); counts.stale += 1; }
            continue;
        }
        if (state === 'stale') { await store.setCurator(s, row.id, 'active', {}, new Date(now).toISOString()); counts.active += 1; }
    }
    // Only suggest a merge to the owner. A high overlap of distinctive words avoids pairing generic short skills.
    const words = (r) => new Set(String((parse(r.skill) || {}).instructions || '').toLowerCase().match(/[a-z0-9]{4,}/g) || []);
    for (const row of own) {
        const a = words(row);
        if (a.size < 8) continue;
        const match = own.find((other) => {
            if (other.id === row.id || other.publisher_subject !== row.publisher_subject) return false;
            const b = words(other);
            if (b.size < 8) return false;
            const overlap = [...a].filter((w) => b.has(w)).length;
            return overlap / new Set([...a, ...b]).size >= 0.8;
        });
        const curator = parse(row.curator) || {};
        if (match && curator.near_duplicate_of !== match.id) await store.setCurator(s, row.id, row.curator_state, { near_duplicate_of: match.id }, new Date(now).toISOString());
    }
    if (counts.stale || counts.archived) log.log(`[Actor] the curator: ${counts.stale} stale, ${counts.archived} archived`);
    return counts;
}

module.exports = { STALE_DAYS, PRIVATE_STALE_DAYS, ARCHIVE_DAYS, run, due };

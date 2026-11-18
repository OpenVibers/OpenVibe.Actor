'use strict';

/**
 * OpenVibe's own Experts (plan §D item 10): the blueprints in experts/ are the gallery's first ten.
 *
 * Like the skills in skills/, they are documents in the repository, not rows somebody typed in. At boot each one is
 * checked against agents.blueprint@1 and the SDK's own rules, then published through the store's own path
 * (blueprints.publish), owned by `service:actor`, public, MIT. A file that changed becomes the next version, so an
 * install never changes under anyone: installs set to "same or less" move, the others are told a new version waits.
 *
 * A broken file is skipped, never published. An id someone else already owns is never taken over. A blueprint that was
 * deleted stays deleted.
 */
const fs = require('fs');
const path = require('path');
const blueprints = require('./blueprints');

const DIR = path.join(__dirname, '..', '..', 'experts');
const OWNER = 'service:actor';
// What the store writes into a published version; the rest is the document's own.
const STORE_FIELDS = ['version', 'state', 'created_at', 'updated_at', 'published_at'];

const content = (doc) => {
    const out = { ...doc };
    for (const k of STORE_FIELDS) delete out[k];
    return JSON.stringify(out, Object.keys(out).sort());
};

/** The documents in the folder, each one checked. A broken one is skipped with a warning. */
function load({ dir = DIR, log = console } = {}) {
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort(); } catch (err) {
        if (log.warn) log.warn('[Actor] the experts folder could not be read:', err && err.message);
        return [];
    }
    const out = [];
    for (const file of files) {
        let doc;
        try { doc = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')); } catch (err) {
            if (log.warn) log.warn(`[Actor] the expert ${file} is not JSON:`, err && err.message);
            continue;
        }
        const errors = blueprints.check(doc);
        if (errors.length) {
            if (log.warn) log.warn(`[Actor] the expert ${file} was not published: ${errors.slice(0, 3).map((e) => `${e.at}: ${e.why}`).join('; ')}`);
            continue;
        }
        if (doc.author && (doc.author.type !== 'service' || doc.author.id !== 'actor')) {
            if (log.warn) log.warn(`[Actor] the expert ${file} was not published: its author is not OpenVibe (service:actor)`);
            continue;
        }
        out.push(doc);
    }
    return out;
}

/** Publish each document that is new or changed. → { published: [id@version], same: n, skipped: [id] } */
async function seed(s, { dir = DIR, log = console } = {}) {
    const result = { published: [], same: 0, skipped: [] };
    for (const doc of load({ dir, log })) {
        try {
            const row = await s.db.maybe('SELECT id, owner, latest, deleted_at FROM agent_blueprints WHERE id = $1', [doc.id]);
            if (row && (row.owner !== OWNER || row.deleted_at)) { result.skipped.push(doc.id); continue; }
            if (row && row.latest != null) {
                const v = await s.db.maybe('SELECT doc FROM agent_blueprint_versions WHERE blueprint_id = $1 AND version = $2', [doc.id, row.latest]);
                const was = v && (typeof v.doc === 'string' ? JSON.parse(v.doc) : v.doc);
                if (was && content(was) === content(doc)) { result.same += 1; continue; }
            }
            const draft = { ...doc };
            for (const k of STORE_FIELDS) delete draft[k];
            const now = new Date().toISOString();
            if (!row) {
                await s.db.query(`INSERT INTO agent_blueprints (id, owner, visibility, latest, draft, forked_from, created_at, updated_at)
                    VALUES ($1, $2, 'public', NULL, $3::jsonb, NULL, $4, $4)`, [doc.id, OWNER, JSON.stringify(draft), now]);
            } else {
                await s.db.query("UPDATE agent_blueprints SET draft = $2::jsonb, visibility = 'public', updated_at = $3 WHERE id = $1", [doc.id, JSON.stringify(draft), now]);
            }
            const out = await blueprints.publish(s, OWNER, doc.id);
            if (out) result.published.push(`${doc.id}@${out.doc.version}`);
        } catch (err) {
            result.skipped.push(doc.id);
            if (log.warn) log.warn(`[Actor] the expert ${doc.id} could not be published:`, err && err.message);
        }
    }
    if (result.published.length && log.info) log.info(`[Actor] experts published: ${result.published.join(', ')}`);
    return result;
}

module.exports = { seed, load, OWNER, DIR };

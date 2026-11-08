'use strict';

/**
 * OpenVibe's own skills (plan HO2): the documents in skills/ are the registry's first catalogue.
 *
 * They are files in the repository, not rows somebody typed in: a skill is a document, and OpenVibe publishes its
 * own as documents. Each one is read, checked against actor.skill@1 or @2 (its own integrity hash included) and scanned
 * (server/skills/scan.js) before it is listed, so a document that was edited after it was written is not published.
 * A sandbox document's code is stored in Media by the registry's publish path, with its pins on the listing.
 *
 * The publisher is OpenVibe itself: the registry vouches for it (actor.skill-listing@1), which is the only place a
 * publisher is vouched for at all. Nobody may upload a skill in this wave: the scan comes first.
 */
const fs = require('fs');
const path = require('path');
const document = require('./document');
const skills = require('./index');

const DIR = path.join(__dirname, '..', '..', 'skills');

/** The documents in the folder, each one checked against the contract. A broken one is skipped, never published. */
function load({ dir = DIR, log = console } = {}) {
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort(); } catch (err) {
        log.warn('[Actor] the skills folder could not be read:', err && err.message);
        return [];
    }
    const out = [];
    for (const file of files) {
        let raw;
        try { raw = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')); } catch (err) {
            log.warn(`[Actor] the skill ${file} is not JSON:`, err && err.message);
            continue;
        }
        const read = document.read(raw);
        if (read.error) {
            log.warn(`[Actor] the skill ${file} was not published: ${read.error}`);
            continue;
        }
        out.push(read.doc);
    }
    return out;
}

/**
 * Publish OpenVibe's own skills: one listing each, read, scanned, and — for a sandbox skill — with its code bytes in
 * Media, as publisher kind 'openvibe'. A sandbox document whose code cannot be stored is not listed.
 */
async function seed(s, { dir = DIR, log = console, at = null, media = null } = {}) {
    const docs = load({ dir, log });
    const rows = [];
    for (const doc of docs) {
        const out = await skills.publish(s, { doc, publisher: { kind: 'openvibe', name: 'OpenVibe' }, media, at: at || s.iso() });
        if (out.error) {
            if (log && log.warn) log.warn(`[Actor] the skill ${doc.slug} was not published: ${out.error}`);
            continue;
        }
        rows.push(out.row);
    }
    return rows;
}

module.exports = { DIR, load, seed };

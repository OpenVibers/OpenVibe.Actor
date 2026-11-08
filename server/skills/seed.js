'use strict';

/**
 * OpenVibe's own skills (plan HO2): the documents in skills/ are the registry's first catalogue.
 *
 * They are files in the repository, not rows somebody typed in: a skill is a document, and OpenVibe publishes its
 * own as documents. Each one is read, checked against actor.skill@1 (its own integrity hash included) and scanned
 * (server/skills/scan.js) before it is listed, so a document that was edited after it was written is not published.
 *
 * The publisher is OpenVibe itself: the registry vouches for it (actor.skill-listing@1), which is the only place a
 * publisher is vouched for at all. Nobody may upload a skill in this wave: the scan comes first.
 */
const fs = require('fs');
const path = require('path');
const document = require('./document');
const scan = require('./scan');
const store = require('./store');

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

/** Publish OpenVibe's own skills: one listing each, scanned, as publisher kind 'openvibe'. */
async function seed(s, { dir = DIR, log = console, at = null } = {}) {
    const docs = load({ dir, log });
    const rows = [];
    for (const doc of docs) {
        const report = scan.report(doc, at || s.iso());
        const row = await store.insert(s, { slug: doc.slug, skill: doc, publisher: { kind: 'openvibe', name: 'OpenVibe' }, scan: report, at });
        if (row) rows.push(row);
    }
    return rows;
}

module.exports = { DIR, load, seed };

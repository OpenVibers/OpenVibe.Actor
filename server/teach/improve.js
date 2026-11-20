'use strict';

/**
 * An agent improves its own skills (Teach a task, plan §AD.33: "self-improvement, recursive").
 *
 * After a run of one of a person's agents ends, if the run loaded one of that person's own private skills (one they
 * taught it, or one it learned and they kept) AND the run failed or the person had to take over its desk, the agent
 * writes that skill's next version from what happened: what it did, where it failed, and what the person did when they
 * took over (their steps and the pictures they clicked on, recorder.js). That version is
 *   - applied at once, with an undo on the agent's page, when the agent's skills_improve is 'auto' (the default) and the
 *     scan passes it;
 *   - otherwise a suggestion the person reads, edits and keeps or dismisses (the skill draft card).
 * A skill grants nothing either way: the agent's level and the person's approvals still decide every step.
 *
 * Each skill improves at most once per run, and only a private skill of the run's own person: a public skill from the
 * registry is never rewritten by somebody's run.
 */
const store = require('../tasks/store');
const stills = require('../tasks/stills');
const skills = require('../skills');
const recorder = require('./recorder');
const draft = require('./draft');

const ENDED = ['succeeded', 'failed'];

/** 1.0.0 → 1.1.0; anything else → 1.1.0. */
function bump(version) {
    const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(version || ''));
    return m ? `${m[1]}.${Number(m[2]) + 1}.0` : '1.1.0';
}

/** What the agent did, as short lines: each call, and each call that failed with why. */
function callLines(events) {
    const out = [];
    for (const e of events) {
        if (!e) continue;
        if (e.step === 'tool_call' && e.tool) {
            const args = typeof e.input === 'string' && e.input ? e.input : JSON.stringify(e.args || {});
            out.push(`- ${e.tool}: ${String(args).replace(/\s+/g, ' ').slice(0, 160)}`);
        } else if (e.step === 'tool_result' && e.is_error) {
            out.push(`  failed: ${String(e.text || '').replace(/\s+/g, ' ').slice(0, 200)}`);
        } else if (e.step === 'person') {
            out.push(`  (the person took over: ${String(e.text || '').slice(0, 80)})`);
        }
    }
    return out.slice(-80);
}

/** A new version of a skill document with the improved instructions, its hash renewed. */
function nextVersion(doc, instructions) {
    const { integrity, ...rest } = doc;
    const next = { ...rest, instructions, version: bump(doc.version) };
    next.integrity = { alg: 'sha256', hash: skills.document.hashOf(next) };
    return next;
}

async function insertProposal(s, { row, agentId, listing, text, next, previous, state }) {
    const now = s.iso();
    return s.db.maybe(`INSERT INTO actor_agent_proposals (id, agent_id, owner, text, kind, draft, state, from_task, created_at, decided_at, source, updates_listing, previous, listing_id)
        VALUES ($1,$2,$3,$4,'skill',$5::jsonb,$6,$7,$8,$9,'improve',$10,$11::jsonb,$10) RETURNING *`,
    [s.newId('prp'), agentId, row.requester, text, JSON.stringify(next), state, row.id, now, state === 'applied' ? now : null, listing.id, JSON.stringify(previous)]);
}

/**
 * The improvement pass for one ended run. → the proposal it left (applied or pending), or null.
 */
async function afterRun({ s, models, row, log = console }) {
    if (!row || !ENDED.includes(row.state)) return null;
    if (!/^agent:agt_/.test(String(row.via || '')) || !String(row.requester || '').startsWith('user:')) return null;
    const agentId = row.via.slice(6);
    // A teach session's own steps are the skill's first version (learn_from_person), never a correction of it.
    if (await s.db.maybe('SELECT 1 AS one FROM actor_teach_sessions WHERE task_id = $1', [row.id])) return null;
    const events = await store.eventsDetailed(s, row.id, 0);
    const slugs = [...new Set(events.filter((e) => e && e.step === 'tool_call' && e.tool === 'load_skill' && e.args && typeof e.args.slug === 'string').map((e) => e.args.slug))];
    if (!slugs.length) return learnFromHelp({ s, models, row, events, agentId });
    const tookOver = events.some((e) => e && e.step === 'person');
    if (!tookOver && row.state !== 'failed') return null;
    const subject = row.requester.slice(5);
    for (const slug of slugs) {
        const listing = await skills.store.bySlug(s, slug);
        if (!listing || listing.visibility !== 'private' || listing.publisher_subject !== subject || listing.retired_at) continue;
        const install = await skills.store.installOf(s, row.requester, agentId, listing.id);
        if (!install || install.removed_at) continue;
        if (await s.db.maybe('SELECT id FROM actor_agent_proposals WHERE from_task = $1 AND updates_listing = $2', [row.id, listing.id])) continue;
        const doc = skills.document.parse(listing.skill_text || listing.skill) || {};
        if (!doc.instructions) continue;
        const steps = tookOver ? await recorder.steps(s, row.id) : [];
        const r = await draft.improve({
            models, subject, skill: doc,
            run: { state: row.state, error: row.error_detail || row.error_code || null, calls: callLines(events) },
            steps, picture: (seq) => stills.get(s, row.id, seq),
        });
        if (r.cost_usd) await store.addSpend(s, row.requester, r.cost_usd).catch(() => {});
        if (r.error || !r.instructions || r.instructions.trim() === String(doc.instructions).trim()) continue;
        const next = nextVersion(doc, r.instructions);
        const agent = await s.db.maybe('SELECT id, skills_improve FROM actor_agents WHERE id = $1 AND owner = $2', [agentId, row.requester]);
        if (!agent) return null;
        const text = (r.change || `Improved after a run that ${row.state === 'failed' ? 'failed' : 'needed you'}`).slice(0, 300);
        if (agent.skills_improve !== 'ask') {
            const applied = await skills.updatePrivate(s, { owner: row.requester, agentId, listingId: listing.id, doc: next });
            if (!applied.error) {
                log.log && log.log(`[Actor] teach: ${agentId} improved its skill ${listing.id} to ${next.version} after ${row.id}`);
                return insertProposal(s, { row, agentId, listing, text, next, previous: doc, state: 'applied' });
            }
            // A version the scan flags waits for the person, with the findings on its card.
        }
        return insertProposal(s, { row, agentId, listing, text, next, previous: doc, state: 'pending' });
    }
    return null;
}

// The person showed something, not only signed in: at least this many clicks of theirs on the desk.
const HELP_CLICKS = 3;

/**
 * Learning from help: a run that used none of the person's skills, where the person took the desk over and showed it
 * part of the job (three clicks or more: more than a sign-in) and the run then succeeded, offers a new skill drafted
 * from what the agent did and what the person did. It waits for them like any draft (source 'helped'); the cap on
 * waiting suggestions holds, so a busy agent drops it rather than piling them up.
 */
async function learnFromHelp({ s, models, row, events, agentId }) {
    if (row.state !== 'succeeded') return null;
    const clicks = events.filter((e) => e && e.step === 'person' && e.args && /click/.test(String(e.args.action || ''))).length;
    if (clicks < HELP_CLICKS) return null;
    if (await s.db.maybe("SELECT id FROM actor_agent_proposals WHERE from_task = $1 AND kind = 'skill'", [row.id])) return null;
    const steps = await recorder.steps(s, row.id);
    const what = String(row.title || '').trim() || 'the job this run did, with the person\'s help';
    const out = await draft.write({
        models, subject: row.requester.slice(5), what, steps, picture: (seq) => stills.get(s, row.id, seq),
        context: callLines(events).filter((l) => !/^\s*\(the person took over/.test(l)),
    });
    if (out.cost_usd) await store.addSpend(s, row.requester, out.cost_usd).catch(() => {});
    if (out.error || !out.draft) return null;
    return require('../agents/personal').addSkillProposal(s, row.requester, agentId, out.draft, row.id, { source: 'helped' });
}

/**
 * The person keeps a suggested improvement (edited or not): the private skill becomes that version.
 * → { row, listing } or { error, status }
 */
async function keep(s, { owner, agentId, proposal, fields, readFindings = false }) {
    const listing = await skills.store.byId(s, proposal.updates_listing);
    if (!listing) return { error: 'That skill is gone.', status: 404 };
    const current = skills.document.parse(listing.skill_text || listing.skill) || {};
    const { integrity, ...rest } = current;
    const next = { ...rest, name: fields.name, description: fields.description, instructions: fields.instructions, version: bump(current.version) };
    // The person read this version: what its words open and ask for is declared, as when they taught it.
    const requires = draft.deriveRequires(fields, current.requires);
    if (requires) next.requires = requires;
    next.integrity = { alg: 'sha256', hash: skills.document.hashOf(next) };
    const applied = await skills.updatePrivate(s, { owner, agentId, listingId: listing.id, doc: next, readFindings });
    if (applied.error) return applied;
    const row = await s.db.maybe(`UPDATE actor_agent_proposals SET state = 'applied', draft = $2::jsonb, previous = $3::jsonb, decided_at = $4
        WHERE id = $1 AND state = 'pending' RETURNING *`, [proposal.id, JSON.stringify(next), JSON.stringify(current), s.iso()]);
    return row ? { row, listing: applied.listing } : { error: 'This suggestion was already decided.', status: 409 };
}

/**
 * Undo an applied improvement: the skill goes back to the version before it, while nothing changed it since.
 * → { row } or { error, status }
 */
async function undo(s, { owner, agentId, proposal }) {
    if (proposal.state !== 'applied' || !proposal.updates_listing || !proposal.previous) return { error: 'Only an applied improvement can be undone.', status: 409 };
    const listing = await skills.store.byId(s, proposal.updates_listing);
    if (!listing) return { error: 'That skill is gone.', status: 404 };
    const current = skills.document.parse(listing.skill_text || listing.skill) || {};
    const made = skills.document.parse(proposal.draft) || {};
    if (current.version !== made.version || current.instructions !== made.instructions) return { error: 'The skill changed since this improvement: undo the newer change first.', status: 409 };
    const previous = skills.document.parse(proposal.previous);
    const back = await skills.updatePrivate(s, { owner, agentId, listingId: listing.id, doc: previous, readFindings: true });
    if (back.error) return back;
    const row = await s.db.maybe("UPDATE actor_agent_proposals SET state = 'undone', decided_at = $2 WHERE id = $1 AND state = 'applied' RETURNING *", [proposal.id, s.iso()]);
    return row ? { row } : { error: 'This improvement was already undone.', status: 409 };
}

module.exports = { afterRun, learnFromHelp, keep, undo, bump, callLines, nextVersion, HELP_CLICKS };

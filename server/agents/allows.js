'use strict';

/**
 * "Always allow this for this agent" (plan HO1): a standing permission the person gives for one exact kind of
 * step, scoped by the kind and by the target it would touch ("publish to openvibe.blog", "run git status on
 * dev_x"). It never covers the always-ask floor: money, a password, a deletion and a new recipient ask every
 * time, whatever the person allowed before (levels.js).
 *
 * A rule is a row, not a flag: the person may revoke one, and the agent's page lists them.
 *
 *   list(s, owner, agentId)      → the active rules of one agent
 *   listAll(s, owner)            → every active rule of the person
 *   grant(s, owner, agentId, kind, target) → the rule (made or found again)
 *   revoke(s, owner, id)         → the rule, revoked
 *   matches(rules, kind, target) → true when a rule covers exactly this step
 */

const kinds = require('./kinds');

const ID = /^alw_[0-9A-HJKMNP-TV-Z]{26}$/;
const MAX_TARGET = 200;

// A rule is matched on its target string, so the string must be the step exactly: never cut and never with its
// whitespace folded (a cut target would also match a different, longer step that starts the same way). A target
// that is too long, empty or carries a control character cannot be allowed at all (agents/actions.js builds them).
const exact = (v) => (typeof v === 'string' && v.length > 0 && v.length <= MAX_TARGET && !/[\u0000-\u001f\u007f]/.test(v) ? v : null);

/** The active rules of one agent (newest first). */
async function list(s, owner, agentId) {
    if (!agentId) return [];
    return await s.db.many(`SELECT * FROM actor_approval_allows
        WHERE owner = $1 AND agent_id = $2 AND revoked_at IS NULL ORDER BY created_at DESC`, [owner, agentId]);
}

/** Every active rule of the person (all their agents). */
async function listAll(s, owner) {
    return await s.db.many(`SELECT * FROM actor_approval_allows
        WHERE owner = $1 AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 200`, [owner]);
}

/** Make the rule, or find the one that is already there. One rule per (owner, agent, kind, target). */
async function grant(s, owner, agentId, kind, target) {
    if (!kinds.allowable(kind)) return { error: 'This kind of step always asks, so it can never be always allowed.' };
    const scope = exact(target);
    if (!scope) return { error: 'This step cannot be named exactly enough to allow it always.' };
    const existing = await s.db.maybe(`SELECT * FROM actor_approval_allows
        WHERE owner = $1 AND agent_id = $2 AND kind = $3 AND target = $4 AND revoked_at IS NULL`, [owner, agentId, kind, scope]);
    if (existing) return { row: existing, made: false };
    const now = s.iso();
    const row = await s.db.one(`INSERT INTO actor_approval_allows (id, owner, agent_id, kind, target, created_at)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT DO NOTHING
        RETURNING *`, [s.newId('alw'), owner, agentId, kind, scope, now]);
    if (row) return { row, made: true };
    // The row was made and revoked in the same moment: the partial index lets it live again.
    const again = await s.db.maybe(`SELECT * FROM actor_approval_allows
        WHERE owner = $1 AND agent_id = $2 AND kind = $3 AND target = $4 AND revoked_at IS NULL`, [owner, agentId, kind, scope]);
    return { row: again, made: false };
}

/** One rule of the person, by its id. */
async function get(s, owner, id) {
    if (!ID.test(String(id || ''))) return null;
    return await s.db.maybe('SELECT * FROM actor_approval_allows WHERE id = $1 AND owner = $2', [id, owner]);
}

/** Revoke one rule of the person. */
async function revoke(s, owner, id) {
    if (!ID.test(String(id || ''))) return null;
    return await s.db.maybe(`UPDATE actor_approval_allows SET revoked_at = $3
        WHERE id = $1 AND owner = $2 AND revoked_at IS NULL RETURNING *`, [id, owner, s.iso()]);
}

/** Does a rule cover exactly this step? The kind and the target must both match. */
function matches(rules, kind, target) {
    if (!Array.isArray(rules) || !rules.length || !kinds.allowable(kind)) return false;
    const scope = exact(target);
    if (!scope) return false;
    return rules.some((r) => r && r.kind === kind && r.target === scope);
}

module.exports = { ID, MAX_TARGET, exact, list, listAll, get, grant, revoke, matches };

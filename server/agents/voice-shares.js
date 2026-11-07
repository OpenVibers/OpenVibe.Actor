'use strict';

/**
 * A voice shared by its owner: the public link (/voices/<id>) that lets somebody else borrow it.
 *
 * Actor's own record of who shared it — the only place a voice's author is vouched for, because the author in a
 * file is only a claim. One row per share: the owner, the agent it is, the document as it was shared, and when it
 * was stopped. Stopping a share does not delete the row: the link answers 410 from then on, and the owner may
 * share the voice again.
 *
 *   share(s, owner, agent, doc, name)  the public link for this agent's voice
 *   get(s, id)                          the share behind a link (a stopped one is still there)
 *   current(s, owner, agentId)          the share that is live for this agent
 *   revoke(s, owner, agentId)           stop sharing it
 */
const ID = /^shv_[0-9A-HJKMNP-TV-Z]{26}$/;

/** The share for this agent's voice: the live one, or a new row. Sharing again after a stop makes a new row. */
async function share(s, owner, agent, doc, name = null) {
    const existing = await current(s, owner, agent.id);
    if (existing) return existing;
    return s.db.maybe("INSERT INTO actor_shared_voices (id, owner, owner_name, agent_id, voice, created_at) VALUES ($1,$2,$3,$4,$5::jsonb,now()) RETURNING *",
    [s.newId('shv'), owner, name || null, agent.id, JSON.stringify(doc)]);
}

/** The share behind a public link. A stopped share is still here: the link answers 410, not 404. */
const get = (s, id) => (ID.test(String(id || '')) ? s.db.maybe('SELECT * FROM actor_shared_voices WHERE id = $1', [id]) : null);

/** The live share of one agent, if it has one. */
const current = (s, owner, agentId) => s.db.maybe('SELECT * FROM actor_shared_voices WHERE owner = $1 AND agent_id = $2 AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1', [owner, agentId]);

/** Every voice the person shares, newest first. */
const list = (s, owner) => s.db.many('SELECT * FROM actor_shared_voices WHERE owner = $1 AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 100', [owner]);

/** Stop sharing: the link answers 410 from now on. */
const revoke = (s, owner, agentId) => s.db.maybe('UPDATE actor_shared_voices SET revoked_at = now() WHERE owner = $1 AND agent_id = $2 AND revoked_at IS NULL RETURNING *', [owner, agentId]);

module.exports = { ID, share, get, current, list, revoke };

'use strict';

const KINDS = new Set(['mail', 'telegram', 'discord', 'slack']);
const ACCOUNT = /^[A-Za-z0-9:._-]{1,180}$/;
const valid = (kind, accountId) => KINDS.has(kind) && ACCOUNT.test(String(accountId || ''));

async function get(s, kind, accountId) {
    if (!valid(kind, accountId)) return null;
    return s.db.maybe('SELECT * FROM actor_channel_bindings WHERE kind = $1 AND account_id = $2', [kind, accountId]);
}

const list = (s, owner) => s.db.many('SELECT * FROM actor_channel_bindings WHERE owner = $1 ORDER BY kind, label', [owner]);

// Called only after Mail identifies the inbox, or Chat has resolved the linked account in Network.
async function ensure(s, { kind, accountId, owner, label, agentId }) {
    if (!valid(kind, accountId)) return null;
    await s.db.query(`INSERT INTO actor_channel_bindings (kind, account_id, owner, label, agent_id, changed_at)
        VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (kind, account_id) DO NOTHING`,
    [kind, accountId, owner, String(label).slice(0, 200), agentId, s.iso()]);
    return get(s, kind, accountId);
}

// Chat has just resolved this account against Network. A relink can change its owner;
// preserve a same-owner move or unbind, and reset a newly transferred account.
async function registerChat(s, { kind, accountId, owner, label, agentId }) {
    if (kind === 'mail' || !valid(kind, accountId)) return null;
    return s.db.maybe(`INSERT INTO actor_channel_bindings (kind, account_id, owner, label, agent_id, changed_at)
        VALUES ($1,$2,$3,$4,$5,$6)
        ON CONFLICT (kind, account_id) DO UPDATE SET
            owner = EXCLUDED.owner, label = EXCLUDED.label,
            agent_id = CASE WHEN actor_channel_bindings.owner = EXCLUDED.owner THEN actor_channel_bindings.agent_id ELSE EXCLUDED.agent_id END,
            changed_at = EXCLUDED.changed_at RETURNING *`,
    [kind, accountId, owner, String(label).slice(0, 200), agentId, s.iso()]);
}

// A person's move is atomic: the primary key permits one receiver, even during concurrent moves.
async function bind(s, { kind, accountId, owner, agentId }) {
    if (!valid(kind, accountId)) return null;
    const agent = await s.db.maybe('SELECT id FROM actor_agents WHERE id = $1 AND owner = $2', [agentId, owner]);
    if (!agent) return null;
    return s.db.maybe(`UPDATE actor_channel_bindings SET agent_id = $4, changed_at = $5
        WHERE kind = $1 AND account_id = $2 AND owner = $3 RETURNING *`,
    [kind, accountId, owner, agentId, s.iso()]);
}

async function unbind(s, { kind, accountId, owner, agentId }) {
    if (!valid(kind, accountId)) return null;
    return s.db.maybe(`UPDATE actor_channel_bindings SET agent_id = NULL, changed_at = $5
        WHERE kind = $1 AND account_id = $2 AND owner = $3 AND agent_id = $4 RETURNING *`,
    [kind, accountId, owner, agentId, s.iso()]);
}

module.exports = { get, list, ensure, registerChat, bind, unbind, valid };

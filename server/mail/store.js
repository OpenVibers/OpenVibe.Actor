'use strict';

/**
 * The records of an agent answering its own mail (track HO6): threads, the person's switch, and one row per letter.
 *
 *   threads   one row per mail conversation (keyed by the Message-ID chain's root), so a back-and-forth stays ONE
 *             Actor thread: the next run continues from the previous task and keeps its memory.
 *   inboxes   the switch, off unless the person turned it on, and the address Mail gave the agent.
 *   runs      one row per letter taken: the message id is the key, so a redelivery makes no second run, and the row
 *             carries what happened to the answer (sent, waiting for the person, refused, failed).
 */
const { sql } = require('openvibe-sdk/db');

const AGT = /^agt_[0-9A-HJKMNP-TV-Z]{26}$/;
const AGI = /^agi_[0-9A-HJKMNP-TV-Z]{26}$/;

const nowIso = (s) => s.iso();

// ---- threads -----------------------------------------------------------------------------------

/**
 * The conversation key of a letter: the root of its References chain when it answers something we already hold,
 * else the root of the sender's chain, else the letter's own Message-ID. Two people replying to each other stay on
 * one key because every reply repeats the chain.
 */
async function threadKeyFor({ s, owner, inboxId, agentId, chain = [], messageId = null, inReplyTo = null }) {
    // A letter that answers something we hold continues THAT thread, whatever its own headers claim about the chain.
    for (const id of [inReplyTo, ...[...chain].reverse()]) {
        if (!id) continue;
        const known = await s.db.maybe('SELECT thread_key FROM actor_mail_runs WHERE owner = $1 AND inbox_id = $2 AND agent_id = $3 AND message_rfc_id = $4', [owner, inboxId, agentId, id]);
        if (known) return known.thread_key;
    }
    // Otherwise the oldest id we have (the root), else the letter's own id, else a note that it is unknown.
    return `${agentId}:${inboxId}:${chain[0] || messageId || 'unknown'}`;
}

/** The thread's row, made on first use. */
async function ensureThread({ s, owner, threadKey, inboxId, agentId, peer }) {
    const at = nowIso(s);
    const row = await s.db.maybe(`INSERT INTO actor_mail_threads (owner, thread_key, inbox_id, agent_id, peer, created_at, updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$6)
        ON CONFLICT (owner, thread_key) DO UPDATE SET updated_at = EXCLUDED.updated_at, agent_id = EXCLUDED.agent_id
        RETURNING *`, [owner, threadKey, inboxId, agentId, peer, at]);
    return row;
}

/** Point the thread at its latest run. */
async function linkThread({ s, owner, threadKey, taskId }) {
    await s.db.query('UPDATE actor_mail_threads SET task_id = $3, updated_at = $4 WHERE owner = $1 AND thread_key = $2', [owner, threadKey, taskId, nowIso(s)]);
}

// ---- the person's switch -----------------------------------------------------------------------

/** The switch for one inbox, as Mail reports it plus what Actor last saw. Off unless a row says otherwise. */
async function getInbox({ s, owner, inboxId }) {
    if (!AGI.test(String(inboxId || ''))) return null;
    return s.db.maybe('SELECT * FROM actor_mail_inboxes WHERE owner = $1 AND inbox_id = $2', [owner, inboxId]);
}

/** Turn answering on or off for one inbox (the person's own act). */
async function setEnabled({ s, owner, inboxId, agentId, address, enabled }) {
    const at = nowIso(s);
    return s.db.maybe(`INSERT INTO actor_mail_inboxes (owner, inbox_id, agent_id, address, enabled, changed_at)
        VALUES ($1,$2,$3,$4,$5,$6)
        ON CONFLICT (owner, inbox_id) DO UPDATE
            SET enabled = EXCLUDED.enabled, changed_at = EXCLUDED.changed_at, agent_id = EXCLUDED.agent_id, address = EXCLUDED.address
        RETURNING *`, [owner, inboxId, agentId, address, Boolean(enabled), at]);
}

/** Every inbox of this person whose switch is on. */
const enabledInboxes = (s, owner) => s.db.many('SELECT * FROM actor_mail_inboxes WHERE owner = $1 AND enabled ORDER BY changed_at DESC', [owner]);

// ---- one row per letter ------------------------------------------------------------------------

/** Claim a letter. False when it was already taken: the insert is the test, so a redelivery is a no-op. */
async function claimRun({ s, owner, inboxId, agentId, mailAgentName = null, messageId, messageRfcId = null, threadKey, peer, subject }) {
    const at = nowIso(s);
    const row = await s.db.maybe(`INSERT INTO actor_mail_runs
        (message_id, owner, inbox_id, agent_id, mail_agent_name, thread_key, peer, subject, created_at, updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)
        ON CONFLICT (message_id) DO NOTHING
        RETURNING *`, [messageId, owner, inboxId, agentId, mailAgentName, threadKey, peer, subject || null, at]);
    if (!row) return null;
    if (messageRfcId) await s.db.query('UPDATE actor_mail_runs SET message_rfc_id = $2 WHERE message_id = $1', [messageId, messageRfcId]);
    return row;
}

/** Update what happened to a letter's answer. */
async function settle({ s, messageId, state, taskId = null, replyTo = null, approvalId = null, reason = null }) {
    return s.db.maybe(`UPDATE actor_mail_runs SET reply_state = $2, task_id = COALESCE($3, task_id), reply_to = COALESCE($4, reply_to),
        approval_id = COALESCE($5, approval_id), reason = $6, updated_at = $7 WHERE message_id = $1 RETURNING *`,
    [messageId, state, taskId, replyTo, approvalId, reason, nowIso(s)]);
}

/** How many letters this inbox (or this sender in this inbox) took in the last hour: the brief's two windows. */
async function countLastHour({ s, owner, inboxId, peer = null, now = Date.now() }) {
    const since = new Date(now - 3600_000).toISOString();
    const row = peer
        ? await s.db.maybe('SELECT count(*)::int AS n FROM actor_mail_runs WHERE owner = $1 AND inbox_id = $2 AND peer = $3 AND created_at >= $4', [owner, inboxId, peer, since])
        : await s.db.maybe('SELECT count(*)::int AS n FROM actor_mail_runs WHERE owner = $1 AND inbox_id = $2 AND created_at >= $3', [owner, inboxId, since]);
    return row ? Number(row.n) : 0;
}

/** The last `limit` letters this agent answered, across its bound addresses. */
async function answeredByAgent({ s, owner, agentId, limit = 10 }) {
    return s.db.many(`SELECT message_id, thread_key, peer, subject, task_id, reply_state, reply_to, approval_id, reason, created_at
        FROM actor_mail_runs WHERE owner = $1 AND agent_id = $2 ORDER BY created_at DESC LIMIT $3`, [owner, agentId, limit]);
}

/** What the thread's previous run was, so the next continues from it. */
const threadTask = (s, owner, threadKey) => s.db.maybe('SELECT task_id FROM actor_mail_threads WHERE owner = $1 AND thread_key = $2', [owner, threadKey]);

module.exports = {
    AGT, AGI,
    threadKeyFor, ensureThread, linkThread,
    getInbox, setEnabled, enabledInboxes,
    claimRun, settle, countLastHour, answeredByAgent, threadTask,
};

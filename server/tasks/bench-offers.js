'use strict';

/**
 * Tasks offered as OpenVibe.Bench cases (Actor v2, stage V2-10), with the person's consent.
 *
 * Bench has no case intake yet (checked 2026-10-30: `grep -rn "cases" OpenVibe.Bench/server` finds nothing), so an
 * offer is stored in Actor's own actor_bench_offers table until the handover stage posts it. The row holds only what
 * the confirmation page showed: the task text and the final answer. Evidence, files, memory and the trace are never
 * copied. The answer is stored as the person saw it: describing people is fine (owner, 2026-10-31).
 *
 * The offer is one per task (task_id is the primary key), belongs to the task's owner, and is withdrawn by deleting it.
 * It goes with its task (ON DELETE CASCADE) and is exported and erased with the person (server/identity/account-data.js).
 */

const clip = (s, n) => { const t = String(s == null ? '' : s); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const MAX_TASK = 20000;
const MAX_ANSWER = 200000;

const get = (s, taskId, owner) => s.db.maybe(
    'SELECT task_id, owner, text, answer, offered_at, status FROM actor_bench_offers WHERE task_id = $1 AND owner = $2',
    [taskId, owner],
);

/** The person's offers, newest first, with the task's current state for the list on /tasks. */
const list = (s, owner) => s.db.many(
    `SELECT o.task_id, o.text, o.answer, o.offered_at, o.status, t.state
       FROM actor_bench_offers o JOIN tasks t ON t.id = o.task_id
      WHERE o.owner = $1 ORDER BY o.offered_at DESC LIMIT 100`,
    [owner],
);

/**
 * Offer one finished task. The caller has already checked that the task is the person's and succeeded. `answer` is the
 * final answer as the person saw it; describing people is fine, and only the person's own answer is shared.
 */
async function offer(s, { taskId, owner, text, answer, now = () => Date.now() }) {
    if (!taskId || !owner) return { error: 'actor.bench.no_task' };
    const raw = String(answer == null ? '' : answer).trim();
    if (!raw) return { error: 'actor.bench.no_answer' };
    const clean = raw;
    await s.db.query(
        `INSERT INTO actor_bench_offers (task_id, owner, text, answer, offered_at, status)
         VALUES ($1, $2, $3, $4, $5, 'offered')
         ON CONFLICT (task_id) DO NOTHING`,
        [taskId, owner, clip(text, MAX_TASK), clip(clean, MAX_ANSWER), new Date(now()).toISOString()],
    );
    return { row: await get(s, taskId, owner) };
}

/** Withdraw an offer: its owner's to delete. Returns the deleted row, or null when there was nothing to delete. */
async function withdraw(s, taskId, owner) {
    return s.db.maybe('DELETE FROM actor_bench_offers WHERE task_id = $1 AND owner = $2 RETURNING task_id', [taskId, owner]);
}

module.exports = { get, list, offer, withdraw, MAX_TASK, MAX_ANSWER };

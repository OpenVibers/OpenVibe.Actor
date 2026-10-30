'use strict';

/**
 * "Tell me when it's done": the claim behind one notification per task per outcome (Actor v2, stage V2-6).
 *
 * The row in actor_task_notices (migrations/0017_actor_memories.sql) is inserted before the push and its primary key
 * (task_id, kind) is the dedupe: a second end, a retried call or a second hand-off in one run finds the row and stays
 * quiet. A failed push leaves the claim (no retry), which is what "at most one" means; a person told twice is worse than
 * one told once.
 */
const KINDS = Object.freeze(['succeeded', 'failed', 'needs_you']);

/** true only for the caller that won the claim; anyone else must not send. */
async function once(s, taskId, kind) {
    if (!KINDS.includes(kind)) return false;
    const row = await s.db.maybe(
        'INSERT INTO actor_task_notices (task_id, kind, sent_at) VALUES ($1, $2, $3) ON CONFLICT (task_id, kind) DO NOTHING RETURNING task_id',
        [taskId, kind, s.iso()],
    );
    return Boolean(row);
}

module.exports = { once, KINDS };

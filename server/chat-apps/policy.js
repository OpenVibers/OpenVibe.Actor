'use strict';
const { setTimeout: delay } = require('node:timers/promises');
// This is enforced by the registry before tool execution, including delegated and resumed runs.
function allowed(tool, policy) {
    if (!policy) return true;
    if (!tool) return false;
    if (policy !== 'dm' && tool.scope === 'person') return false;
    if (policy === 'answer_only' && tool.acts === true) return false;
    // Never let group text create persistent memory, waits, or private artifacts.
    if (policy !== 'dm' && ['remember', 'recall', 'wait_for', 'make_file', 'make_chart'].includes(tool.name)) return false;
    return true;
}
async function approve(s, { taskId, owner, tool, input, signal }) {
    // Exact arguments are persisted for the person's review. A model cannot change them after consent.
    if (JSON.stringify(input).length > 1200) return false; // Every argument must fit in the approval card.
    const id = s.newId('apr');
    const summary = `Allow ${tool} with ${JSON.stringify(input).slice(0, 1200)}`;
    await s.db.query(`INSERT INTO actor_chat_approvals (id, task_id, owner, summary, tool, input, expires_at)
        VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
    [id, taskId, owner, summary, tool, JSON.stringify(input), new Date(s.now() + 10 * 60_000).toISOString()]);
    for (;;) {
        signal?.throwIfAborted();
        const row = await s.db.maybe('SELECT * FROM actor_chat_approvals WHERE id = $1 AND expires_at > $2', [id, s.iso()]);
        if (!row || row.state === 'declined' || row.consumed_at) return false;
        if (row.state === 'approved') {
            const used = await s.db.maybe(`UPDATE actor_chat_approvals SET consumed_at = $2
                WHERE id = $1 AND state = 'approved' AND consumed_at IS NULL AND expires_at > $2 RETURNING id`, [id, s.iso()]);
            return Boolean(used);
        }
        await delay(500, undefined, { signal });
    }
}
async function decide(s, owner, id, decision) {
    if (!['approve', 'decline'].includes(decision)) return null;
    return s.db.maybe(`UPDATE actor_chat_approvals SET state = $3
        WHERE id = $1 AND owner = $2 AND state = 'pending' AND expires_at > $4 RETURNING id, state`,
    [id, owner, decision === 'approve' ? 'approved' : 'declined', s.iso()]);
}
module.exports = { allowed, approve, decide };

'use strict';

/**
 * The approval inbox (plan T17: "an approval inbox for consequential actions"). A person's own agent runs while they
 * are away (a schedule, a watch): when its work would act outside Actor on their behalf — today, a coding task on their
 * own machine through OpenVibe.Codes — the run asks instead of acting. The request waits on /me/approvals; approving
 * starts that work as the person's own task (they are present now), declining or letting it expire (7 days) runs
 * nothing. A person's direct task never asks: they are the one asking.
 *
 *   request(s, { owner, agentId, taskId, kind, summary, payload }) → the row (pending)
 *   list(s, owner) / get(s, owner, id)                             → rows, pending past their expiry marked expired
 *   decide(ctx, owner, id, 'approve' | 'decline')                  → { row, task? } | { error, status }
 *   KINDS, EXPIRES_DAYS
 */
const { createTask } = require('../tasks/create');

const KINDS = ['codes.task'];
const EXPIRES_DAYS = 7;
const ID = /^apr_[0-9A-HJKMNP-TV-Z]{26}$/;

async function request(s, { owner, agentId = null, taskId = null, kind, summary, payload }) {
    if (!KINDS.includes(kind)) throw new Error(`unknown approval kind ${kind}`);
    const id = s.newId('apr');
    const now = s.iso();
    const expires = new Date(Date.parse(now) + EXPIRES_DAYS * 86400_000).toISOString();
    return await s.db.one(`INSERT INTO actor_approvals (id, owner, agent_id, task_id, kind, summary, payload, state, created_at, expires_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, 'pending', $8, $9) RETURNING *`,
    [id, owner, agentId, taskId, kind, String(summary).slice(0, 500), JSON.stringify(payload), now, expires]);
}

/** Pending requests past their expiry become expired as they are read. */
async function expire(s, owner) {
    await s.db.query("UPDATE actor_approvals SET state = 'expired', decided_at = $2 WHERE owner = $1 AND state = 'pending' AND expires_at < $2", [owner, s.iso()]);
}

async function list(s, owner) {
    await expire(s, owner);
    return await s.db.many("SELECT * FROM actor_approvals WHERE owner = $1 ORDER BY (state = 'pending') DESC, created_at DESC LIMIT 100", [owner]);
}

async function get(s, owner, id) {
    if (!ID.test(String(id))) return null;
    await expire(s, owner);
    return await s.db.maybe('SELECT * FROM actor_approvals WHERE id = $1 AND owner = $2', [id, owner]);
}

async function pendingCount(s, owner) {
    await expire(s, owner);
    return Number(await s.db.value("SELECT count(*) FROM actor_approvals WHERE owner = $1 AND state = 'pending'", [owner]));
}

/** The person decides. Approving a codes.task starts it as their own task, routed to the codes agent.
 *  With `idempotent`, a request already decided answers its current state instead of a conflict (the JSON
 *  Action Center route); the HTML page keeps its 409. */
async function decide(ctx, owner, id, decision, { idempotent = false } = {}) {
    const { s, config, engine, webhooks } = ctx;
    const row = await get(s, owner, id);
    if (!row) return { error: 'No such request of yours.', status: 404 };
    if (row.state !== 'pending') {
        if (idempotent) return { row };
        return { error: `This request is already ${row.state}.`, status: 409 };
    }
    if (decision === 'decline') {
        const done = await s.db.one("UPDATE actor_approvals SET state = 'declined', decided_at = $2 WHERE id = $1 AND state = 'pending' RETURNING *", [id, s.iso()]);
        return { row: done };
    }
    if (decision !== 'approve') return { error: 'Approve or decline.', status: 422 };
    const payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
    const out = await createTask({ s, config, engine, webhooks, principal: { requester: owner, via: null, project: null }, body: { task: payload.task, agent: 'codes', mode: 'balanced' } });
    if (!out.task) return { error: out.detail || 'The task could not start.', status: out.status || 422 };
    const done = await s.db.one("UPDATE actor_approvals SET state = 'approved', decided_at = $2, result_task_id = $3 WHERE id = $1 RETURNING *", [id, s.iso(), out.task.id]);
    return { row: done, task: out.task };
}

module.exports = { request, list, get, pendingCount, decide, KINDS, EXPIRES_DAYS };

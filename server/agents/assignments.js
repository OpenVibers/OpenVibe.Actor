'use strict';

/**
 * The assignment tree (plan §12, A-2): one record for all delegated work. Every hand-off is one node —
 * a person giving Actor a task, a routine or Watch trigger starting a run, an agent handing work to
 * another agent, or Actor starting a Codes or Space task. A task that predates the tree gets its root
 * node lazily, the first time one is needed.
 *
 * The fields are actor.assignment@1. The effective level is the higher of the agent's own and the one
 * inherited from the parent, and only a person's or a routine's line passes a level down: outside work
 * never does. The root's budget is the tree's budget; a child is refused once it is spent. A cancel
 * cascades down the tree, and the tasks the nodes ran are stopped by the API.
 *
 *   ensureForTask(s, config, task, { origin })  → the task's root node (created lazily)
 *   openChild(s, { owner, parent, ... })       → one hand-off below a node | { error, status, code }
 *   closeChild(s, owner, id, state)            → the node, ended
 *   tree(s, owner, id)                         → { assignment, children } | null (owner-only)
 *   cancelTree(s, owner, id)                   → { assignment, cancelled } | null (owner-only)
 *   syncTaskState(s, task) / syncSpent(s, root) / spendOf(s, root)
 *   wire(row, budget), ID, ORIGINS, MODES, REPLIES, STATES, TERMINAL
 */

const levels = require('./levels');
const contacts = require('./contacts');

const ID = /^asg_[0-9A-HJKMNP-TV-Z]{26}$/;
const ORIGINS = ['person', 'routine', 'outside'];
const MODES = ['work', 'consult', 'notify'];
const REPLIES = ['resume', 'poll', 'none'];
const STATES = ['queued', 'running', 'waiting', 'succeeded', 'failed', 'cancelled'];
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);
const OPEN_STATES = new Set(['queued', 'running', 'waiting']);

const round = (n) => Math.round(Math.max(0, Number(n) || 0) * 1e6) / 1e6;
const isoOrNull = (v) => (v ? String(v) : null);

/** A task's state as the assignment state that shows it on the tree. */
const stateOf = (state) => (state === 'needs_you' ? 'waiting' : ['running', 'verifying'].includes(state) ? 'running' : STATES.includes(state) ? state : 'queued');

/** The level a node's steps run at: its own and the agent's, plus the inherited level when the line passes one down. */
function effectiveLevel(own, agentLevel = 'ask', parent = null) {
    const inherited = parent && (parent.origin === 'person' || parent.origin === 'routine') ? parent.effective_level : null;
    return levels.maxLevel(own, agentLevel, inherited);
}

/** The node as actor.assignment@1 answers it. */
function wire(row, budget = null) {
    const b = budget || {
        limit_usd: round(row.budget_usd),
        spent_usd: round(row.budget_spent_usd),
        remaining_usd: round(Math.max(0, Number(row.budget_usd) - Number(row.budget_spent_usd))),
    };
    return {
        id: row.id,
        root: row.root,
        parent: row.parent || null,
        depth: Number(row.depth) || 0,
        origin: row.origin,
        mode: row.mode,
        reply: row.reply,
        agent_id: row.agent_id || null,
        task_id: row.task_id || null,
        level: row.level,
        effective_level: row.effective_level,
        budget: { limit_usd: round(b.limit_usd), spent_usd: round(b.spent_usd), remaining_usd: round(b.remaining_usd) },
        state: row.state,
        created_at: row.created_at,
        updated_at: row.updated_at,
        started_at: isoOrNull(row.started_at),
        ended_at: isoOrNull(row.ended_at),
    };
}

const byId = (s, owner, id) => (ID.test(String(id || '')) ? s.db.maybe('SELECT * FROM actor_assignments WHERE id = $1 AND owner = $2', [id, owner]) : null);
const rootOf = async (s, row) => (row && row.root === row.id ? row : row ? s.db.maybe('SELECT * FROM actor_assignments WHERE id = $1 AND owner = $2', [row.root, row.owner]) : null);

/** What a root has spent: the task ids of its tree count once, whatever number of nodes names them. */
async function spendOf(s, rootId) {
    const value = await s.db.value(`SELECT COALESCE(SUM(cost_usd), 0) FROM tasks WHERE id IN
        (SELECT DISTINCT task_id FROM actor_assignments WHERE root = $1 AND task_id IS NOT NULL)`, [rootId]);
    return round(value);
}

/** The root's budget with what the tree has spent so far. */
async function budgetOf(s, root) {
    const limit = round(root && root.budget_usd);
    const spent = await spendOf(s, root && root.root);
    return { limit_usd: limit, spent_usd: spent, remaining_usd: round(Math.max(0, limit - spent)) };
}

/** Who started the line, when the caller did not say. */
function originOf(task, explicit) {
    if (ORIGINS.includes(explicit)) return explicit;
    if (!String((task && task.requester) || '').startsWith('user:')) return 'outside';
    // An agent-started run without a caller's origin is a routine: a person's manual run passes 'person'.
    if (/^agent:agt_/.test(String((task && task.via) || ''))) return 'routine';
    return 'person';
}

/** The agent of a task (its own, the personal agent that started it, or the person's Vibe). */
const agentOf = (s, config, task) => contacts.agentForTask(s, config, task).catch(() => null);

/** Make the task's root node, or return the one it already has. */
async function ensureForTask(s, config, task, { origin = null } = {}) {
    if (!task || !task.id || !String(task.requester || '').startsWith('user:')) return null;
    if (task.assignment_id) {
        const linked = await byId(s, task.requester, task.assignment_id);
        if (linked) return linked;
    }
    const existing = await s.db.maybe('SELECT * FROM actor_assignments WHERE task_id = $1 AND depth = 0 ORDER BY created_at, id LIMIT 1', [task.id]);
    if (existing) {
        if (!task.assignment_id) await s.db.query('UPDATE tasks SET assignment_id = $2 WHERE id = $1 AND assignment_id IS NULL', [task.id, existing.id]);
        return existing;
    }
    const agent = await agentOf(s, config, task);
    const own = levels.LEVELS.includes(task.level) ? task.level : 'ask';
    const effective = effectiveLevel(own, agent && agent.level);
    const now = s.iso();
    const id = s.newId('asg');
    let row = await s.db.maybe(`INSERT INTO actor_assignments
        (id, owner, root, parent, depth, origin, mode, reply, agent_id, task_id, level, effective_level, budget_usd, budget_spent_usd, state, created_at, updated_at, started_at, ended_at)
        VALUES ($1,$2,$1,NULL,0,$3,'work','resume',$4,$5,$6,$7,$8,0,$9,$10,$10,$11,$12)
        ON CONFLICT DO NOTHING RETURNING *`,
    [id, task.requester, originOf(task, origin), agent ? agent.id : (task.agent_id || null), task.id, own, effective,
        round(task.budget_task), stateOf(task.state), now, OPEN_STATES.has(stateOf(task.state)) ? now : null, TERMINAL.has(stateOf(task.state)) ? task.finished_at || now : null]);
    if (!row) row = await s.db.maybe('SELECT * FROM actor_assignments WHERE task_id = $1 AND depth = 0 ORDER BY created_at, id LIMIT 1', [task.id]);
    if (row) await s.db.query('UPDATE tasks SET assignment_id = $2 WHERE id = $1 AND assignment_id IS NULL', [task.id, row.id]);
    return row;
}

/** One hand-off below a node. Refused when the root's budget is spent. */
async function openChild(s, { owner, parent, origin = null, mode = 'work', reply = 'resume', agentId = null, taskId = null, level = null, state = 'queued' }) {
    if (!parent || parent.owner !== owner) return { error: 'no such assignment of yours', status: 404, code: 'actor.assignment.not_found' };
    if (TERMINAL.has(parent.state)) return { error: 'that assignment has ended', status: 409, code: 'actor.assignment.ended' };
    const root = await rootOf(s, parent);
    if (!root) return { error: 'the root of that assignment is gone', status: 409, code: 'actor.assignment.ended' };
    const budget = await budgetOf(s, root);
    if (budget.limit_usd > 0 && budget.remaining_usd <= 0) return { error: 'the assignment tree has spent its budget', status: 429, code: 'actor.assignment.budget' };
    let agentLevel = 'ask';
    if (agentId) {
        const row = await s.db.maybe('SELECT level FROM actor_agents WHERE id = $1 AND owner = $2', [agentId, owner]);
        if (row) agentLevel = row.level;
    }
    const own = levels.LEVELS.includes(level) ? level : agentLevel;
    const effective = effectiveLevel(own, agentLevel, parent);
    const now = s.iso();
    const stateNow = STATES.includes(state) ? state : 'queued';
    const row = await s.db.maybe(`INSERT INTO actor_assignments
        (id, owner, root, parent, depth, origin, mode, reply, agent_id, task_id, level, effective_level, budget_usd, budget_spent_usd, state, created_at, updated_at, started_at, ended_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,0,$14,$15,$15,$16,NULL) RETURNING *`,
    [s.newId('asg'), owner, root.id, parent.id, Number(parent.depth) + 1, ORIGINS.includes(origin) ? origin : parent.origin,
        MODES.includes(mode) ? mode : 'work', REPLIES.includes(reply) ? reply : 'resume', agentId || null, taskId || null, own, effective,
        round(root.budget_usd), stateNow, now, stateNow === 'running' || stateNow === 'waiting' ? now : null]);
    return row;
}

/** End one child node (a Codes task, a Space action, a sub-agent's consult). */
async function closeChild(s, owner, id, state) {
    const next = STATES.includes(state) ? state : 'failed';
    return s.db.maybe(`UPDATE actor_assignments SET state = $3, updated_at = $4,
        started_at = COALESCE(started_at, CASE WHEN $3 IN ('running','waiting','succeeded','failed','cancelled') THEN $4 END),
        ended_at = CASE WHEN $3 IN ('succeeded','failed','cancelled') THEN COALESCE(ended_at, $4) ELSE ended_at END
        WHERE id = $1 AND owner = $2 RETURNING *`, [id, owner, next, s.iso()]);
}

/** The node and its direct children, owner-only. */
async function tree(s, owner, id) {
    const node = await byId(s, owner, id);
    if (!node) return null;
    const root = await rootOf(s, node);
    const budget = root ? await budgetOf(s, root) : null;
    const children = await s.db.many('SELECT * FROM actor_assignments WHERE parent = $1 AND owner = $2 ORDER BY created_at, id LIMIT 100', [node.id, owner]);
    return { assignment: wire(node, budget), children: children.map((c) => wire(c, budget)) };
}

/**
 * Cancel a node and every node below it. Nodes that already ended keep their end: a cancel stops work,
 * it does not rewrite history. The caller (the API) stops the tasks the returned nodes ran.
 */
async function cancelTree(s, owner, id) {
    const node = await byId(s, owner, id);
    if (!node) return null;
    const now = s.iso();
    const cancelled = await s.db.many(`WITH RECURSIVE subtree AS (
            SELECT id FROM actor_assignments WHERE id = $1 AND owner = $2
            UNION ALL
            SELECT a.id FROM actor_assignments a JOIN subtree t ON a.parent = t.id WHERE a.owner = $2
        )
        UPDATE actor_assignments SET state = 'cancelled', updated_at = $3, ended_at = COALESCE(ended_at, $3)
        WHERE id IN (SELECT id FROM subtree) AND owner = $2
          AND state NOT IN ('succeeded', 'failed', 'cancelled')
        RETURNING *`, [id, owner, now]);
    const after = await byId(s, owner, id);
    const root = after ? await rootOf(s, after) : null;
    const budget = root ? await budgetOf(s, root) : null;
    return {
        assignment: after ? wire(after, budget) : null,
        cancelled: cancelled.map((row) => wire(row, budget)),
        task_ids: [...new Set(cancelled.map((row) => row.task_id).filter(Boolean))],
    };
}

/** Keep the root node's state with its task's (the engine calls this after every state change). */
async function syncTaskState(s, task) {
    if (!task || !task.id) return;
    const state = stateOf(task.state);
    const now = s.iso();
    await s.db.query(`UPDATE actor_assignments SET state = $2, updated_at = $3,
        started_at = COALESCE(started_at, CASE WHEN $2 IN ('running','waiting') THEN $3 END),
        ended_at = CASE WHEN $2 IN ('succeeded','failed','cancelled') THEN COALESCE(ended_at, $3) ELSE ended_at END
        WHERE task_id = $1 AND depth = 0`, [task.id, state, now]);
    const roots = await s.db.many('SELECT DISTINCT root FROM actor_assignments WHERE task_id = $1', [task.id]);
    for (const r of roots) await syncSpent(s, r.root);
}

/** Write the tree's spend onto the root (a read of the tree also computes it live). */
async function syncSpent(s, rootId) {
    const spent = await spendOf(s, rootId);
    await s.db.query('UPDATE actor_assignments SET budget_spent_usd = $2 WHERE id = $1', [rootId, spent]);
    return spent;
}

module.exports = {
    ID, ORIGINS, MODES, REPLIES, STATES, TERMINAL, stateOf, effectiveLevel, wire,
    byId, ensureForTask, openChild, closeChild, tree, cancelTree, syncTaskState, syncSpent, spendOf, budgetOf,
};

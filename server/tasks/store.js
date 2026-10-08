'use strict';

/**
 * Tasks, their event logs and daily spend in Actor's PostgreSQL database (migrations/0001_tasks.sql), and the task as
 * the wire sees it (platform.task@1). Every function takes the store (server/db.js createStore) first.
 *
 * A requester is 'type:id' (identity.subject-ref@1 in one column): user:usr_…, app:app_…, agent:agt_…, service:<slug>.
 * Spend is kept per requester and UTC day, plus requester '*' for everyone (the operator's daily ceiling).
 */

const OPEN = ['queued', 'running', 'verifying'];
const RETENTION_DAYS = 30;

const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);
const num = (v) => (v == null ? null : Number(v));
const parse = (v) => (v == null ? null : typeof v === 'string' ? JSON.parse(v) : v);

function subjectRef(requester) {
    const i = String(requester).indexOf(':');
    return { type: requester.slice(0, i), id: requester.slice(i + 1) };
}

async function insertTask(s, t) {
    await s.db.query(
        `INSERT INTO tasks (id, requester, project_id, task, mode, agent, budget_task, budget_day, state, idem_key, idem_hash, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'queued', $9, $10, $11)`,
        [t.id, t.requester, t.project_id || null, t.task, t.mode, t.agent || null, t.budget_task, t.budget_day, t.idem_key || null, t.idem_hash || null, t.created_at]);
    await addSpend(s, t.requester, 0, { tasks: 1 });
    return getTask(s, t.id);
}

const getTask = (s, id) => s.db.maybe('SELECT * FROM tasks WHERE id = $1', [id]);
const byIdempotency = (s, requester, key) => s.db.maybe('SELECT * FROM tasks WHERE requester = $1 AND idem_key = $2', [requester, key]);

async function listTasks(s, requester, { limit = 20, before = null } = {}) {
    const rows = before
        ? await s.db.many('SELECT * FROM tasks WHERE requester = $1 AND id < $2 ORDER BY id DESC LIMIT $3', [requester, before, limit + 1])
        : await s.db.many('SELECT * FROM tasks WHERE requester = $1 ORDER BY id DESC LIMIT $2', [requester, limit + 1]);
    const page = rows.slice(0, limit);
    return { rows: page, next: rows.length > limit ? page[page.length - 1].id : null };
}

/** Patch a task's columns (only the ones named). */
async function updateTask(s, id, patch) {
    const cols = Object.keys(patch);
    if (!cols.length) return getTask(s, id);
    const json = new Set(['result', 'explanation']);
    const sets = cols.map((c, i) => `${c} = $${i + 2}${json.has(c) ? '::jsonb' : ''}`);
    const vals = cols.map((c) => (json.has(c) && patch[c] != null ? JSON.stringify(patch[c]) : patch[c]));
    await s.db.query(`UPDATE tasks SET ${sets.join(', ')} WHERE id = $1`, [id, ...vals]);
    return getTask(s, id);
}

/** Append one event; returns it with its seq (the task's own counter). */
async function appendEvent(s, taskId, body) {
    return s.tx(async () => {
        const seq = await s.db.value('UPDATE tasks SET last_seq = last_seq + 1 WHERE id = $1 RETURNING last_seq', [taskId]);
        const event = { task_id: taskId, seq: Number(seq), ...body };
        await s.db.query('INSERT INTO task_events (task_id, seq, body) VALUES ($1, $2, $3::jsonb)', [taskId, event.seq, JSON.stringify(event)]);
        return event;
    });
}

async function eventsAfter(s, taskId, after = 0) {
    const rows = await s.db.many('SELECT body FROM task_events WHERE task_id = $1 AND seq > $2 ORDER BY seq', [taskId, after]);
    return rows.map((r) => parse(r.body));
}

/** Add to a requester's and everyone's spend today (tasks counts only the requester's). */
async function addSpend(s, requester, usd, { tasks = 0 } = {}) {
    const day = dayOf(s.now());
    for (const [who, n] of [[requester, tasks], ['*', 0]]) {
        await s.db.query(
            `INSERT INTO spend_daily (requester, day, usd, tasks) VALUES ($1, $2, $3, $4)
             ON CONFLICT (requester, day) DO UPDATE SET usd = spend_daily.usd + EXCLUDED.usd, tasks = spend_daily.tasks + EXCLUDED.tasks`,
            [who, day, usd, n]);
    }
}

async function spendToday(s, requester) {
    const row = await s.db.maybe('SELECT usd, tasks FROM spend_daily WHERE requester = $1 AND day = $2', [requester, dayOf(s.now())]);
    return { usd: row ? Number(row.usd) : 0, tasks: row ? Number(row.tasks) : 0 };
}

/** At boot: a task a stopped process left open did not finish, and is not re-run behind the person's back. */
async function failInterrupted(s) {
    const rows = await s.db.many(
        `UPDATE tasks SET state = 'failed', error_code = 'actor.task.interrupted',
                error_detail = 'Actor restarted while this task was running. Nothing was charged after the restart; ask again.',
                finished_at = $1, result = NULL
         WHERE state IN ('queued', 'running', 'verifying') RETURNING id`, [s.iso()]);
    return rows.map((r) => r.id);
}

/** Tasks (and their events) older than the retention window go. */
async function prune(s) {
    const cutoff = new Date(s.now() - RETENTION_DAYS * 86_400_000).toISOString();
    const n = await s.db.exec('DELETE FROM tasks WHERE created_at < $1', [cutoff]);
    await s.db.query('DELETE FROM spend_daily WHERE day < $1', [cutoff.slice(0, 10)]);
    return n;
}

/** A task row → platform.task@1. */
function toWire(row, { baseUrl }) {
    const ended = !OPEN.includes(row.state);
    const t = {
        id: row.id,
        requester: subjectRef(row.requester),
        task: row.task,
        mode: row.mode,
        budget: { per_task_usd: num(row.budget_task), per_day_usd: num(row.budget_day) },
        state: row.state,
        created_at: row.created_at,
        finished_at: row.finished_at || null,
        result: row.state === 'succeeded' ? parse(row.result) : null,
        cost: row.cost_usd == null ? null : { usd: Math.round(num(row.cost_usd) * 1e6) / 1e6, free_allowance_used: Math.round(num(row.free_usd || 0) * 1e6) / 1e6 },
        explanation: parse(row.explanation),
        progress: ended ? null : { stream_url: `${baseUrl}/api/v1/tasks/${row.id}/events`, last_seq: Number(row.last_seq || 0), events: ['output', 'state', 'end'] },
        cancel: row.cancel_at ? { requested_at: row.cancel_at, ...(row.cancel_by ? { requested_by: subjectRef(row.cancel_by) } : {}) } : null,
        error: row.error_code ? { code: row.error_code, detail: row.error_detail || '' } : null,
    };
    if (row.project_id) t.project_id = row.project_id;
    if (t.explanation && !t.explanation.length) t.explanation = null;
    return t;
}

module.exports = { insertTask, getTask, byIdempotency, listTasks, updateTask, appendEvent, eventsAfter, addSpend, spendToday, failInterrupted, prune, toWire, subjectRef, dayOf, OPEN, RETENTION_DAYS };

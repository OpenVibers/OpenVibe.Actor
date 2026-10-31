'use strict';

/**
 * The wait record (plan A2, Watch mode): a wait is a row, not a running loop.
 *
 * Every transition is one UPDATE with a WHERE on the status, so it happens once: a wait that is woken twice (the
 * same event delivered twice, two Actor processes reading the same event) changes its status in exactly one of
 * them, and the other sees no row back. The event receipt is the same idea for events: an event id is spent once
 * (server/waits/guard.js).
 *
 * Nothing here stores an event payload. A wait names the event that woke it (woken_by) and nothing more: an event
 * body is untrusted input, and a row that kept it would keep a stranger's text.
 */
const { ids } = require('openvibe-contracts');

const WAIT_ID = /^wai_[0-9A-HJKMNP-TV-Z]{26}$/;
const TASK_ID = /^tsk_[0-9A-HJKMNP-TV-Z]{26}$/;

const nowIso = (now) => new Date(now()).toISOString();

/** A wait row as it is written. */
function createWait(s, { taskId, requester, kind, until, filter, deadlineAt, onTimeout, line, traceId = null, step = null, at = null }) {
    const id = ids.newId('wait');
    const ts = at || nowIso(s.now);
    return s.db.query(
        `INSERT INTO actor_waits (id, task_id, requester, step, kind, until, filter, deadline_at, on_timeout, line, status, trace_id, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10, 'waiting', $11, $12, $12)`,
        [id, taskId, requester, step == null ? null : Number(step), kind, JSON.stringify(until || {}), JSON.stringify(filter || {}),
            deadlineAt, onTimeout, line, traceId, ts],
    ).then(() => getWait(s, id));
}

const getWait = (s, id) => (WAIT_ID.test(String(id || '')) ? s.db.maybe('SELECT * FROM actor_waits WHERE id = $1', [id]) : null);

/** The waits a task holds, newest first (any status). */
const waitsForTask = (s, taskId) => s.db.many('SELECT * FROM actor_waits WHERE task_id = $1 ORDER BY created_at DESC', [taskId]);

/** The waits still waiting, newest first. */
const openWaits = (s, { requester = null } = {}) => (requester
    ? s.db.many("SELECT * FROM actor_waits WHERE status = 'waiting' AND requester = $1 ORDER BY created_at DESC", [requester])
    : s.db.many("SELECT * FROM actor_waits WHERE status = 'waiting' ORDER BY created_at DESC", []));

/** The open waits of one task. */
const openWaitsForTask = (s, taskId) => s.db.many("SELECT * FROM actor_waits WHERE task_id = $1 AND status = 'waiting' ORDER BY created_at DESC", [taskId]);

const countOpen = (s, requester) => s.db.maybe("SELECT count(*)::int AS n FROM actor_waits WHERE requester = $1 AND status = 'waiting'", [requester]).then((r) => (r && r.n) || 0);
const countTask = (s, taskId) => s.db.maybe('SELECT count(*)::int AS n FROM actor_waits WHERE task_id = $1', [taskId]).then((r) => (r && r.n) || 0);
const countOpenTask = (s, taskId) => s.db.maybe("SELECT count(*)::int AS n FROM actor_waits WHERE task_id = $1 AND status = 'waiting'", [taskId]).then((r) => (r && r.n) || 0);

/**
 * The wait woke: one row back, or null when another delivery already woke it. This is the "resume once" the
 * engine relies on.
 */
const markWoken = (s, id, wokenBy) => s.db.maybe(
    `UPDATE actor_waits SET status = 'woken', woken_by = $2::jsonb, updated_at = $3, finished_at = $3
     WHERE id = $1 AND status = 'waiting' RETURNING *`,
    [id, JSON.stringify(wokenBy || {}), nowIso(s.now)],
);

/** The deadline fired: one row back, or null when it already fired. */
const markTimedOut = (s, id, detail = null) => s.db.maybe(
    `UPDATE actor_waits SET status = 'timed_out', updated_at = $2, finished_at = $2, woken_by = $3::jsonb
     WHERE id = $1 AND status = 'waiting' RETURNING *`,
    [id, nowIso(s.now), JSON.stringify(detail ? { at: nowIso(s.now), why: String(detail).slice(0, 200) } : { at: nowIso(s.now) })],
);

/** The person cancelled the wait (or the task). */
const cancelWait = (s, id, by = null) => s.db.maybe(
    `UPDATE actor_waits SET status = 'cancelled', updated_at = $2, finished_at = $2
     WHERE id = $1 AND status = 'waiting' RETURNING *`,
    [id, nowIso(s.now)],
);

/** A wait that failed (its task did). */
const failWait = (s, id) => s.db.maybe(
    "UPDATE actor_waits SET status = 'failed', updated_at = $2, finished_at = $2 WHERE id = $1 AND status = 'waiting' RETURNING *",
    [id, nowIso(s.now)],
);

/** One retry of the step that waited (on_timeout: 'retry' has one shot). */
const bumpRetry = (s, id) => s.db.maybe(
    "UPDATE actor_waits SET retries = retries + 1, updated_at = $2 WHERE id = $1 AND status = 'waiting' RETURNING *",
    [id, nowIso(s.now)],
);

/**
 * The event receipt: an event id is spent once. The insert is the guard — no row back means the event was already
 * used, and the matcher moves on to the next wait (server/waits/guard.js).
 */
const spendEvent = (s, { eventId, waitId, eventType }) => s.db.maybe(
    `INSERT INTO actor_wait_events (event_id, wait_id, event_type, at) VALUES ($1, $2, $3, $4)
     ON CONFLICT (event_id) DO NOTHING RETURNING event_id`,
    [eventId, waitId, eventType, nowIso(s.now)],
);

/** The cursor of one topic (the position in Events is opaque and is only ever handed back to Events). */
const getCursor = (s, topic) => s.db.maybe('SELECT * FROM actor_event_cursors WHERE topic = $1', [topic]);
const setCursor = (s, topic, cursor) => s.db.query(
    `INSERT INTO actor_event_cursors (topic, cursor, updated_at) VALUES ($1, $2, $3)
     ON CONFLICT (topic) DO UPDATE SET cursor = EXCLUDED.cursor, updated_at = EXCLUDED.updated_at`,
    [topic, cursor || null, nowIso(s.now)],
);

module.exports = {
    WAIT_ID, TASK_ID,
    createWait, getWait, waitsForTask, openWaits, openWaitsForTask,
    countOpen, countTask, countOpenTask,
    markWoken, markTimedOut, cancelWait, failWait, bumpRetry,
    spendEvent, getCursor, setCursor,
};

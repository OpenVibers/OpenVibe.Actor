'use strict';

/**
 * Actor's Action Center items (plan 2026-10-28 §3.10, common.action-item@1): the person's tasks, the approvals
 * waiting on them, and their personal agents' next scheduled runs. The mapping from Actor's own states to the five
 * Action Center buckets lives in bucketFor(), so the table can be tested on its own.
 */

const PUBLIC_ORIGIN = 'https://openvibe.actor';
const OPEN = ['queued', 'running', 'verifying'];

// Actor's own word → the Action Center bucket. A task whose newest event is a "Needs you:" line is waiting, though
// its state is still running; the route passes needsYou for that.
const STATE_BUCKET = Object.freeze({
    queued: 'running',
    running: 'running',
    verifying: 'running',
    needs_you: 'waiting',
    pending: 'waiting',
    scheduled: 'scheduled',
    succeeded: 'done',
    approved: 'done',
    done: 'done',
    failed: 'failed',
    declined: 'failed',
    cancelled: 'failed',
    expired: 'failed',
});

function bucketFor(state, { needsYou = false } = {}) {
    if (needsYou && OPEN.includes(state)) return 'waiting';
    return STATE_BUCKET[state] || 'failed';
}

/** What the person may do from the list (common.action-item@1.actions). */
function actionsFor(bucket, { approval = false, canCancel = false, canRetry = false } = {}) {
    if (bucket === 'waiting' && approval) return ['approve', 'decline', 'open'];
    if (bucket === 'running') return canCancel ? ['open', 'cancel'] : ['open'];
    if (bucket === 'failed') return canRetry ? ['open', 'retry'] : ['open'];
    return ['open'];
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: ' ' };

/** Plain text (no HTML or Markdown), single line, at most `max` characters. */
function plain(value, max = 400) {
    let s = value == null ? '' : String(value);
    s = s.replace(/```[\s\S]*?```/g, ' ').replace(/<\/?[^>]+>/g, ' ')
        .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/&([a-zA-Z#0-9]+);/g, (m, k) => (Object.hasOwn(ENTITIES, k) ? ENTITIES[k] : m))
        .replace(/[`*_~]+/g, '').replace(/^[#>\s-]+/gm, '')
        .replace(/\s+/g, ' ').trim();
    if (s.length > max) s = `${s.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
    return s;
}

function parse(value) {
    if (value == null) return null;
    if (typeof value !== 'string') return value;
    try { return JSON.parse(value); } catch { return null; }
}

/** The "Needs you:" hand-off in a task's newest event, if it is one (tasks/store.js needsYou). */
function needsYou(event) {
    if (!event || event.step !== 'text' || !/^Needs you: /.test(String(event.text || ''))) return null;
    const text = String(event.text).replace(/^Needs you: /, '');
    const url = (text.match(/https:\/\/\S+$/) || [])[0] || null;
    return { seq: Number(event.seq), what: text.replace(/\s*Open your agent's desk.*$/s, '').trim().slice(0, 300), url };
}

function answerOf(result) {
    const r = parse(result);
    if (!r || typeof r !== 'object') return '';
    for (const key of ['answer', 'text', 'summary']) if (typeof r[key] === 'string') return r[key];
    return '';
}

/**
 * The quiet line a waiting task shows (plan A2): the wait's own words and how long it has waited. The task's
 * state is still running (a wait is a row beside the task, not a new state), so this is where the person sees
 * that nothing is happening on purpose.
 */
function waitLineOf(wait, now = () => Date.now()) {
    const line = plain(wait && wait.line ? wait.line : '', 200);
    if (!line) return null;
    const started = Date.parse(String(wait.created_at || ''));
    if (!Number.isFinite(started)) return line;
    const mins = Math.max(0, Math.round((now() - started) / 60_000));
    return `${line} · ${mins} min`;
}

function taskItem(row, { lastEvent = null, steps = null, wait = null, now = () => Date.now() } = {}) {
    const needs = needsYou(lastEvent);
    const state = needs ? 'needs_you' : row.state;
    const bucket = bucketFor(row.state, { needsYou: Boolean(needs) });
    const updated = row.finished_at || (lastEvent && lastEvent.at) || row.created_at;
    const last = lastEvent && (lastEvent.text || (lastEvent.tool ? `Using ${lastEvent.tool}` : ''));
    const waiting = waitLineOf(wait, now);
    const summary = waiting || (needs ? needs.what : (row.state === 'failed' ? row.error_detail : (answerOf(row.result) || last)));
    return {
        service: 'actor',
        id: row.id,
        kind: 'agent_task',
        title: plain(row.task || row.id, 160) || row.id,
        summary: summary ? plain(summary, 400) : null,
        bucket,
        state,
        agent: row.agent ? plain(row.agent, 80) : (lastEvent && lastEvent.agent ? plain(lastEvent.agent, 80) : null),
        cost_usd: row.cost_usd == null ? null : Number(row.cost_usd),
        steps: steps == null ? null : Number(steps),
        error: row.error_detail ? plain(row.error_detail, 400) : null,
        created_at: row.created_at,
        updated_at: updated,
        href: `${PUBLIC_ORIGIN}/tasks/${row.id}`,
        actions: actionsFor(bucket, { canCancel: OPEN.includes(row.state) }),
    };
}

function approvalItem(row) {
    const bucket = bucketFor(row.state);
    const payload = parse(row.payload) || {};
    return {
        service: 'actor',
        id: row.id,
        kind: 'approval',
        title: plain(row.summary || row.id, 160) || row.id,
        summary: payload.task ? plain(payload.task, 400) : null,
        bucket,
        state: row.state,
        agent: row.agent_id ? plain(row.agent_id, 80) : null,
        cost_usd: null,
        steps: null,
        error: row.state === 'expired' ? 'This approval expired before it was decided.' : null,
        created_at: row.created_at,
        updated_at: row.decided_at || row.created_at,
        href: `${PUBLIC_ORIGIN}/me/approvals/${row.id}`,
        actions: actionsFor(bucket, { approval: true }),
    };
}

function scheduledItem(agent) {
    return {
        service: 'actor',
        id: agent.id,
        kind: 'agent_task',
        title: plain(agent.name || agent.id, 160) || agent.id,
        summary: agent.instructions ? plain(agent.instructions, 400) : null,
        bucket: 'scheduled',
        state: 'scheduled',
        agent: plain(agent.name || agent.id, 80),
        cost_usd: null,
        steps: null,
        error: null,
        created_at: agent.created_at,
        updated_at: agent.updated_at || agent.created_at,
        next_run_at: agent.next_run_at,
        href: `${PUBLIC_ORIGIN}/me/agents/${agent.id}`,
        actions: ['open'],
    };
}

module.exports = { PUBLIC_ORIGIN, OPEN, bucketFor, actionsFor, plain, needsYou, waitLineOf, taskItem, approvalItem, scheduledItem };

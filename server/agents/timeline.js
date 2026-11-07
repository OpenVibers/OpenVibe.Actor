'use strict';

/**
 * The one timeline behind the Dock (design 2026-11-07 §2).
 *
 * Every mode of the agent publishes agent.step.started|updated|ended on OpenVibe.Events with the person's subject;
 * Actor keeps the entries and serves them to the Dock (GET /api/v1/agent/timeline, and the live stream). No product
 * reads another's tables.
 *
 * Privacy: a row is a title, an outcome and a link (agent.timeline-entry@1). The columns are the whole shape of an
 * entry: there is no column for a prompt, a diff or a page, so one cannot be stored here even by accident. The
 * audience is 'private' (Only me) until the person shares the entry through the one Share sheet.
 */
const MODES = new Set(['talk', 'act', 'run', 'code', 'browse', 'watch', 'stream']);
const STATUSES = new Set(['running', 'waiting', 'needs_you', 'done', 'failed', 'stopped']);
const OPEN = new Set(['running', 'waiting', 'needs_you']);
const PAGE = 50;
const MAX = 200;

const subs = new Map();   // subject → Set<{ res }>: the live update stream

const iso = (v) => (v instanceof Date ? v.toISOString() : (v ? new Date(v).toISOString() : null));
const text = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
// The Computer of a step (plan 2026-11-07): a plain object with session_id, machine, where and cost_hint. Anything
// else — an array, a string, a nested payload — is not stored.
const computer = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);

/** The person an event is for: only a user subject is the agent's. */
function subjectOf(ev) {
    const s = ev && ev.subject;
    if (!s || s.type !== 'user' || typeof s.id !== 'string') return null;
    return 'user:' + s.id;
}

/** One row → one agent.timeline-entry@1. */
function entryOf(row) {
    if (!row) return null;
    return {
        id: row.id,
        subject: row.subject,
        mode: row.mode,
        product: row.product,
        ref: row.ref || null,
        title: row.title,
        started_at: iso(row.started_at),
        ended_at: iso(row.ended_at),
        status: row.status,
        placement: (row.placement_where || row.placement_why) ? { where: row.placement_where || null, why: row.placement_why || null } : null,
        computer: row.computer == null ? null : (typeof row.computer === 'object' ? row.computer : (() => { try { return JSON.parse(row.computer); } catch { return null; } })()),
        cost_usd: row.cost_usd === null || row.cost_usd === undefined ? null : Number(row.cost_usd),
        link: row.link || null,
        reason: row.reason || null,
        transition: row.transition || null,
        approval: row.approval_id ? { product: row.approval_product || null, id: row.approval_id, kind: row.approval_kind || null } : null,
        audience: row.audience || 'private',
        shared: Boolean(row.shared),
    };
}

/** Write a step into the timeline (started, updated or ended: the same row, brought forward). */
async function upsert(s, subject, payload) {
    const step = payload || {};
    if (!subject || !MODES.has(step.mode) || !STATUSES.has(step.status) || !text(step.step_id, 80)) return null;
    const now = s.iso();
    const row = await s.db.one(`INSERT INTO agent_timeline (id, subject, step_id, product, mode, ref, title, status, placement_where, placement_why,
                cost_usd, link, reason, transition, approval_product, approval_id, approval_kind, audience, shared, started_at, ended_at, created_at, updated_at, computer)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'private',false,$18,$19,$20,$20,$21)
        ON CONFLICT (subject, product, step_id) DO UPDATE SET
            mode = EXCLUDED.mode, ref = EXCLUDED.ref, title = EXCLUDED.title, status = EXCLUDED.status,
            placement_where = EXCLUDED.placement_where, placement_why = EXCLUDED.placement_why, cost_usd = EXCLUDED.cost_usd,
            link = EXCLUDED.link, reason = EXCLUDED.reason, transition = EXCLUDED.transition,
            approval_product = EXCLUDED.approval_product, approval_id = EXCLUDED.approval_id, approval_kind = EXCLUDED.approval_kind,
            ended_at = EXCLUDED.ended_at, updated_at = EXCLUDED.updated_at, computer = EXCLUDED.computer
        RETURNING *`,
    [s.newId('tl'), subject, text(step.step_id, 80), text(step.product, 40) || 'agent', step.mode, text(step.ref, 120),
        text(step.title, 160) || 'A step of the agent', step.status,
        text(step.placement && step.placement.where, 160), text(step.placement && step.placement.why, 240),
        num(step.cost_usd), text(step.link, 2048), text(step.reason, 240), text(step.transition, 240),
        text(step.approval && step.approval.product, 40), text(step.approval && step.approval.id, 80), text(step.approval && step.approval.kind, 40),
        iso(step.started_at) || now, iso(step.ended_at), now, computer(step.computer) ? JSON.stringify(computer(step.computer)) : null]);
    publish(subject, entryOf(row));
    return row;
}

/** An event from OpenVibe.Events → the timeline. */
async function onEvent(s, ev) {
    if (!ev || !String(ev.event_type || '').startsWith('agent.step.')) return 'ignored:type';
    const subject = subjectOf(ev);
    if (!subject) return 'ignored:subject';
    const row = await upsert(s, subject, ev.payload);
    return row ? 'applied' : 'ignored:payload';
}

const encode = (v) => Buffer.from(JSON.stringify(v)).toString('base64url');
const decode = (v) => { try { return JSON.parse(Buffer.from(String(v), 'base64url').toString('utf8')); } catch { return null; } };

/**
 * The person's timeline: what is happening now, what needs them, the entries (newest first), the next cursor and the
 * per-mode counts. The filters are the Dock's chips (mode, needs you); the counts say what a filter would hide.
 */
async function list(s, subject, { cursor = null, mode = null, needs_you = false, scope = 'mine', limit = PAGE } = {}) {
    const where = ['subject = $1'];
    const args = [subject];
    if (mode && MODES.has(mode)) { args.push(mode); where.push('mode = $' + args.length); }
    if (needs_you) where.push("status = 'needs_you'");
    if (scope === 'shared') where.push("audience <> 'private'");
    if (cursor) {
        const c = decode(cursor);
        if (c && c.t && c.i) { args.push(c.t, c.i); where.push('(started_at < $' + (args.length - 1) + ' OR (started_at = $' + (args.length - 1) + ' AND id < $' + args.length + '))'); }
    }
    const take = Math.min(Number(limit) || PAGE, MAX);
    args.push(take);
    const rows = await s.db.many('SELECT * FROM agent_timeline WHERE ' + where.join(' AND ') + ' ORDER BY started_at DESC, id DESC LIMIT $' + args.length, args);
    const entries = rows.map(entryOf);
    const last = rows[rows.length - 1];
    const next_cursor = rows.length >= take && last ? encode({ t: iso(last.started_at), i: last.id }) : null;

    const now = await s.db.maybe("SELECT * FROM agent_timeline WHERE subject = $1 AND status = 'running' ORDER BY started_at DESC LIMIT 1", [subject]);
    const asks = await s.db.many("SELECT * FROM agent_timeline WHERE subject = $1 AND status = 'needs_you' ORDER BY started_at ASC LIMIT 50", [subject]);
    const counted = await s.db.many('SELECT mode, count(*) AS n FROM agent_timeline WHERE subject = $1 GROUP BY mode', [subject]);
    const counts = {};
    for (const row of counted) counts[row.mode] = Number(row.n);
    counts.needs_you = Number(asks.length);
    return { now: entryOf(now), needs_you: asks.map(entryOf), entries, next_cursor, counts };
}

/** The steps that are still open (running, waiting, needs the person). */
async function open(s, subject) {
    const rows = await s.db.many('SELECT * FROM agent_timeline WHERE subject = $1 AND status = ANY($2) ORDER BY started_at ASC', [subject, [...OPEN]]);
    return rows.map(entryOf);
}

/** The kill switch: the person pauses the agent (paused) or lets it run again. */
async function setPaused(s, subject, paused) {
    const now = s.iso();
    await s.db.one(`INSERT INTO agent_state (subject, paused, updated_at) VALUES ($1,$2,$3)
        ON CONFLICT (subject) DO UPDATE SET paused = EXCLUDED.paused, updated_at = EXCLUDED.updated_at RETURNING subject`, [subject, Boolean(paused), now]);
    return { subject, paused: Boolean(paused) };
}

async function isPaused(s, subject) {
    const row = await s.db.maybe('SELECT paused FROM agent_state WHERE subject = $1', [subject]);
    return Boolean(row && row.paused);
}

/** One entry of theirs: another person's entry is the same 404 as one that does not exist. */
async function get(s, subject, id) {
    const row = await s.db.maybe('SELECT * FROM agent_timeline WHERE id = $1 AND subject = $2', [String(id || ''), subject]);
    return row ? entryOf(row) : null;
}

/** Delete one entry of theirs (the person may remove a step they do not want to see). */
async function remove(s, subject, id) {
    const out = await s.db.maybe('DELETE FROM agent_timeline WHERE id = $1 AND subject = $2 RETURNING id', [String(id || ''), subject]);
    return Boolean(out);
}

// ── The live update stream ─────────────────────────────────────────────
function publish(subject, entry) {
    for (const sub of subs.get(subject) || []) {
        try { sub.res.write('event: entry\ndata: ' + JSON.stringify(entry) + '\n\n'); } catch (err) { /* the reader is gone */ }
    }
}

/** A reader of the live stream: the Dock's panel. It gets every new entry of its own timeline. */
function subscribe(subject, res) {
    if (!subs.has(subject)) subs.set(subject, new Set());
    const sub = { res };
    subs.get(subject).add(sub);
    return () => {
        const set = subs.get(subject);
        if (!set) return;
        set.delete(sub);
        if (!set.size) subs.delete(subject);
    };
}

/** Where a mode lives: the URL the person answers it or stops it on. */
function productUrl(ctx, product) {
    const c = (ctx && ctx.config) || {};
    const direct = c[product] && c[product].url;
    if (direct) return String(direct).replace(/\/+$/, '');
    const env = process.env['ACTOR_' + String(product).toUpperCase() + '_URL'];
    return env ? String(env).replace(/\/+$/, '') : null;
}

/** The person's own token, so the mode sees the person answering, not a service. */
function bearer(req) {
    const h = String((req && req.headers && req.headers.authorization) || '');
    return h.startsWith('Bearer ') ? h : null;
}

/**
 * The approvals proxy: the person answers in the Dock, and the mode that owns the approval decides it there.
 * The token goes with it, so the mode sees the person's own request.
 */
async function proxyApproval(ctx, req, { product, id, decision }) {
    const base = productUrl(ctx, product);
    if (!base) return { error: product + ' has no address here', status: 502, code: 'actor.approval.no_product' };
    const auth = bearer(req);
    try {
        const res = await fetch(base + '/api/v1/agent/approvals/' + encodeURIComponent(id) + '/decide', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: auth } : {}) },
            body: JSON.stringify({ decision }),
            signal: AbortSignal.timeout(15000),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) return { error: body.detail || body.title || (product + ' refused the answer'), status: res.status === 404 ? 404 : 502, code: body.code || 'actor.approval.proxy_failed' };
        return { state: body.state || decision };
    } catch (err) {
        return { error: product + ' did not answer: ' + err.message, status: 502, code: 'actor.approval.proxy_failed' };
    }
}

/** The mode's own stop route: the Dock's Stop for Code and Run, End for Stream. */
async function stopInProduct(ctx, req, entry) {
    const base = productUrl(ctx, entry.product);
    if (!base || !entry.ref) return false;
    const auth = bearer(req);
    const p = entry.product === 'codes' ? '/api/v1/tasks/' + encodeURIComponent(entry.ref) + '/cancel'
        : entry.product === 'run' ? '/api/v1/jobs/' + encodeURIComponent(entry.ref) + '/cancel'
        : entry.product === 'live' ? '/api/v1/agent-streams/' + encodeURIComponent(entry.ref) + '/end'
        : null;
    if (!p) return false;
    try {
        const res = await fetch(base + p, { method: 'POST', headers: auth ? { Authorization: auth } : {}, signal: AbortSignal.timeout(15000) });
        return res.ok;
    } catch (err) {
        return false;
    }
}

/**
 * The kill switch: stop every step that is still open (the mode's own stop route where it has one) and pause the
 * agent until the person resumes it.
 */
async function killSwitch(ctx, req, action) {
    const { s } = ctx;
    const subject = req.principal.requester;
    if (action === 'resume') {
        await setPaused(s, subject, false);
        return { paused: false, stopped: [] };
    }
    const openEntries = await open(s, subject);
    const stopped = [];
    for (const entry of openEntries) {
        const at = s.iso();
        await s.db.query("UPDATE agent_timeline SET status = 'stopped', ended_at = COALESCE(ended_at, $2), reason = COALESCE(reason, 'Stopped by you'), updated_at = $2 WHERE id = $1", [entry.id, at]);
        stopped.push({ id: entry.id, product: entry.product, ref: entry.ref, mode: entry.mode });
        await stopInProduct(ctx, req, entry);
    }
    await setPaused(s, subject, true);
    publish(subject, { paused: true });
    return { paused: true, stopped };
}

module.exports = { upsert, onEvent, list, open, get, remove, setPaused, isPaused, entryOf, subscribe, killSwitch, proxyApproval, productUrl, MODES, STATUSES, OPEN };

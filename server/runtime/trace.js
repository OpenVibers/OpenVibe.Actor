'use strict';

/**
 * The task trace (Actor v2, stage V2-10): one actor_spans row per model call, tool call, check, judgement and
 * sub-agent hand-off.
 *
 * A span is numbers and names only. The caller passes the model id or the tool name, never a prompt, a tool input or
 * a tool output; an error is reduced to a short code (never an error message, which could quote the person's text).
 *
 * A failed insert never fails the task: the tracer logs the first failure once and every later span write is a no-op
 * for the rest of that run. The engine's own work continues.
 *
 * createTracer({ store, taskId, log, now }) → {
 *   enabled, taskId, newId(), record(span), scoped(parentId)
 * }
 * `scoped(parentId)` is the child tracer for a sub-agent: everything it records hangs under that delegate span.
 */

const KINDS = new Set(['model', 'tool', 'check', 'judge', 'delegate']);
const MAX_NAME = 120;
const MAX_SHORT = 64;

const clip = (s, n) => { const t = String(s == null ? '' : s); return t.length > n ? t.slice(0, n) : t; };
// A name is an identifier (a model id or a tool name), never a sentence: anything that is not identifier-shaped becomes
// an underscore, so a provider echoing a prompt in its model id cannot put the person's words in a span.
const safeName = (s) => clip(String(s == null ? '' : s).replace(/[^a-zA-Z0-9._:/-]+/g, '_'), MAX_NAME);
const short = (v, n = MAX_SHORT) => (typeof v === 'string' && /^[a-zA-Z0-9_.:-]+$/.test(v) ? v.slice(0, n) : null);
const intOrNull = (v) => (v == null || v === '' ? null : (Number.isFinite(Number(v)) && Number(v) >= 0 ? Math.round(Number(v)) : null));

/** A thrown call's code as a short, safe token: a known contract code, else a fixed generic one (never the message). */
function codeOf(err, fallback = 'actor.call.failed') {
    return short(err && err.code) || fallback;
}

/** One row as the page and the API read it: camel/edge values as numbers, not pg's numeric strings. */
function wireSpan(row) {
    return {
        id: row.id,
        parent_id: row.parent_id || null,
        kind: row.kind,
        name: row.name,
        tier: row.tier || null,
        family: row.family || null,
        started_at: row.started_at,
        ms: Number(row.ms) || 0,
        cost_usd: Number(row.cost_usd) || 0,
        tokens_in: row.tokens_in == null ? null : Number(row.tokens_in),
        tokens_out: row.tokens_out == null ? null : Number(row.tokens_out),
        ok: row.ok !== false,
        error_code: row.error_code || null,
        step: row.step == null ? null : Number(row.step),
    };
}

/** A task's spans, oldest first. A span is numbers and names, so there is nothing here to redact. */
async function spansFor(s, taskId, { limit = 1000 } = {}) {
    const rows = await s.db.many(
        'SELECT id, parent_id, kind, name, tier, family, started_at, ms, cost_usd, tokens_in, tokens_out, ok, error_code, step FROM actor_spans WHERE task_id = $1 ORDER BY started_at, id LIMIT $2',
        [taskId, limit],
    );
    return rows.map(wireSpan);
}

/**
 * The page's totals: what the model calls cost (model, check and judge), what the tool calls cost, and how long the
 * traced work took from its first span to the end of its last (parallel calls are not added twice).
 */
function totals(spans) {
    let model = 0;
    let tool = 0;
    let start = Infinity;
    let end = 0;
    for (const s of spans) {
        const cost = Number(s.cost_usd) || 0;
        if (s.kind === 'tool') tool += cost; else model += cost;
        const at = Date.parse(s.started_at);
        if (Number.isFinite(at)) {
            start = Math.min(start, at);
            end = Math.max(end, at + (Number(s.ms) || 0));
        }
    }
    const round = (n) => Math.round(n * 1e8) / 1e8;
    return { model_cost_usd: round(model), tool_cost_usd: round(tool), ms: end > start ? end - start : 0 };
}

function createTracer({ store, taskId, log = console, now = () => Date.now(), parentId = null, _state = null } = {}) {
    const enabled = Boolean(store && typeof store.db === 'object' && store.db && typeof store.db.query === 'function' && taskId);
    const state = _state || { failedLogged: false };
    const newId = () => (enabled && typeof store.newId === 'function' ? store.newId('spn') : null);

    function scoped(id) {
        const child = createTracer({ store, taskId, log, now, parentId: id || null, _state: state });
        return child;
    }

    async function record(span = {}) {
        if (!enabled || !span || !KINDS.has(span.kind) || state.failedLogged) return null;
        const id = span.id || newId();
        if (!id) return null;
        const startedAt = Number.isFinite(Number(span.startedAt)) ? Number(span.startedAt) : now();
        const ms = Math.max(0, Math.round(Number(span.ms) || 0));
        const cost = Number(span.costUsd);
        const row = [
            id, taskId, span.parentId === undefined ? parentId : (span.parentId || null), span.kind, safeName(span.name || span.kind),
            short(span.tier), short(span.family), new Date(startedAt).toISOString(), ms, Number.isFinite(cost) && cost > 0 ? cost : 0,
            intOrNull(span.tokensIn), intOrNull(span.tokensOut), span.ok !== false,
            span.ok === false ? (short(span.errorCode) || 'actor.call.failed') : null,
            span.step == null ? null : (Number.isFinite(Number(span.step)) ? Math.round(Number(span.step)) : null),
        ];
        try {
            await store.db.query(
                `INSERT INTO actor_spans (id, task_id, parent_id, kind, name, tier, family, started_at, ms, cost_usd, tokens_in, tokens_out, ok, error_code, step)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
                row,
            );
        } catch (err) {
            // The trace is a record, not the work: log once, then let the run go on silently.
            if (!state.failedLogged) {
                state.failedLogged = true;
                if (log && log.warn) log.warn('[Actor] trace span not stored (the task goes on):', (err && err.message) || err);
            }
        }
        return id;
    }

    return { enabled, taskId, parentId, newId, record, scoped };
}

module.exports = { createTracer, spansFor, totals, wireSpan, codeOf, KINDS, MAX_NAME, MAX_SHORT, safeName };

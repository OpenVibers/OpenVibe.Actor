'use strict';

/**
 * Live per-tool and per-model statistics (Actor v2, stage V2-10), the numbers the brain's step choice reads (stage
 * V2-8): how often it worked, how long it took, what it cost and when it last failed, over the last 7 days.
 *
 * One aggregate query over actor_spans, cached in memory for 5 minutes. No new table: the spans are the record.
 *
 * The public API (/api/v1/stats/tools and /models) returns names and numbers only, and only rows with n >= 20, so no
 * one person's use of a tool or model shows in the numbers.
 *
 * createStats({ store, now, log }) → { forTool(name), forModel(id), tools({ publicOnly }), models({ publicOnly }),
 *                                      publicTools(), publicModels(), clear() }
 */

const WINDOW_MS = 7 * 86_400_000;
const CACHE_MS = 5 * 60_000;
const PUBLIC_MIN_N = 20;

const EMPTY = () => ({ n: 0, successRate: null, p50ms: null, p90ms: null, meanCostUsd: null, lastFailureAt: null });
const round = (v, places = 0) => (v == null ? null : Math.round(Number(v) * 10 ** places) / 10 ** places);

function shape(row) {
    return {
        n: Number(row.n) || 0,
        successRate: row.success_rate == null ? null : Number(row.success_rate),
        p50ms: round(row.p50ms, 1),
        p90ms: round(row.p90ms, 1),
        meanCostUsd: round(row.mean_cost_usd, 8),
        lastFailureAt: row.last_failure_at || null,
    };
}

/** The public shape: a name and its numbers, nothing that could point at one task or person. */
function publicRow(name, st) {
    return { name, ...st };
}

function createStats({ store, now = () => Date.now(), log = console } = {}) {
    let cache = null;
    let failedLogged = false;

    async function load() {
        if (cache && now() - cache.at < CACHE_MS) return cache;
        const since = new Date(now() - WINDOW_MS).toISOString();
        let rows = [];
        try {
            rows = await store.db.many(
                `SELECT kind, name,
                        count(*)::int AS n,
                        avg(CASE WHEN ok THEN 1.0 ELSE 0.0 END) AS success_rate,
                        percentile_cont(0.5) WITHIN GROUP (ORDER BY ms) AS p50ms,
                        percentile_cont(0.9) WITHIN GROUP (ORDER BY ms) AS p90ms,
                        avg(cost_usd) AS mean_cost_usd,
                        max(CASE WHEN ok THEN NULL ELSE started_at END) AS last_failure_at
                   FROM actor_spans
                  WHERE started_at >= $1 AND kind IN ('model', 'tool')
                  GROUP BY kind, name`,
                [since],
            );
        } catch (err) {
            // The trace is a record; a missing table (a database mid-migration) is not a task failure. One log line.
            if (!failedLogged) {
                failedLogged = true;
                if (log && log.warn) log.warn('[Actor] live stats not readable:', (err && err.message) || err);
            }
            rows = [];
        }
        const byKey = new Map();
        for (const row of rows || []) byKey.set(`${row.kind}\u0000${row.name}`, shape(row));
        cache = { at: now(), byKey };
        return cache;
    }

    const get = async (kind, name) => (await load()).byKey.get(`${kind}\u0000${name}`) || EMPTY();

    /** Every covered tool, by name; publicOnly applies the n >= 20 floor. */
    async function list(kind, { publicOnly = false } = {}) {
        const out = [];
        for (const [key, value] of (await load()).byKey) {
            const [k, name] = key.split('\u0000');
            if (k !== kind) continue;
            if (publicOnly && value.n < PUBLIC_MIN_N) continue;
            out.push(publicRow(name, value));
        }
        return out.sort((a, b) => (b.n - a.n) || a.name.localeCompare(b.name));
    }

    return {
        forTool: (name) => get('tool', String(name)),
        forModel: (id) => get('model', String(id)),
        tools: (opts) => list('tool', opts),
        models: (opts) => list('model', opts),
        publicTools: () => list('tool', { publicOnly: true }),
        publicModels: () => list('model', { publicOnly: true }),
        clear: () => { cache = null; },
    };
}

module.exports = { createStats, shape, WINDOW_MS, CACHE_MS, PUBLIC_MIN_N, EMPTY };

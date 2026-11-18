'use strict';

/**
 * Comparisons: one task worked several ways side by side (the owner, 2026-11-16: "swap between and benchmark the different
 * ways our shit works"). Each way is one engine (server/engines): Actor's agent on a model, one model, the Decisions API,
 * a coding harness, OpenAI's agent, the open model. Each side is an ordinary task of the person's (its own budget,
 * timeline and page), tied to the comparison; when every side has ended, OpenVibe.AI's Decisions API grades each answer
 * on one rubric in one call (kind grading), and the best one wins.
 *
 *   create({ principal, task, engines }) → { comparison } | { status, code, detail }
 *   get(id, requester) → the comparison with each side: its engine, state, answer, time, cost, model, score
 *   list(requester) → the person's recent comparisons
 *   leaderboard({ requester? }) → per engine (kind and model or harness): runs, wins, mean score, median seconds, mean cost
 */

const { createTask } = require('../tasks/create');
const { parseEngine, keyOf, label } = require('../engines');

const MIN = 2;
const MAX = 6;
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);
const RUBRIC = ['wrong, or no answer', 'weak', 'fair', 'good', 'excellent'];
const LETTERS = 'ABCDEF';

const jsonOf = (v) => { if (v == null) return null; if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return null; } };
const ms = (a, b) => { const x = Date.parse(a), y = Date.parse(b); return Number.isFinite(x) && Number.isFinite(y) ? Math.max(0, y - x) : null; };

function createComparisons({ s, config, engine, models = null, log = console }) {
    async function create({ principal, task, engines, personToken = null, timezone = null }) {
        const text = String(task || '').trim();
        if (!text) return { status: 422, code: 'actor.compare.invalid', detail: 'task: what every way should do' };
        if (!Array.isArray(engines) || engines.length < MIN || engines.length > MAX) return { status: 422, code: 'actor.compare.invalid', detail: `engines: ${MIN} to ${MAX} ways to compare` };
        const list = [];
        for (const [i, e] of engines.entries()) {
            const p = parseEngine(e);
            if (p.error || !p.engine) return { status: 422, code: 'actor.compare.invalid', detail: `engines[${i}]: ${p.error || 'name an engine'}` };
            if (list.some((x) => keyOf(x) === keyOf(p.engine))) return { status: 422, code: 'actor.compare.invalid', detail: `engines[${i}]: ${label(p.engine)} is already in this comparison` };
            list.push(p.engine);
        }
        const id = s.newId('cmp');
        await s.db.query('INSERT INTO actor_comparisons (id, requester, task, engines, created_at, updated_at) VALUES ($1, $2, $3, $4::jsonb, $5, $5)', [id, principal.requester, text.slice(0, 16000), JSON.stringify(list), s.iso()]);
        const sides = [];
        for (const e of list) {
            const out = await createTask({ s, config, engine, principal, body: { task: text, mode: 'balanced', engine: e }, comparisonId: id, personToken, timezone });
            if (out.code) {
                // The first side refused (a budget, a limit): nothing ran, so nothing is kept. A later one: the others run.
                if (!sides.length) { await s.db.query('DELETE FROM actor_comparisons WHERE id = $1', [id]); return out; }
                sides.push({ engine: e, error: { code: out.code, detail: out.detail } });
                continue;
            }
            sides.push({ engine: e, task_id: out.task.id });
        }
        return { comparison: await get(id, principal.requester) };
    }

    function sideOf(t) {
        const result = jsonOf(t.result) || {};
        return {
            task_id: t.id, engine: jsonOf(t.engine), label: label(jsonOf(t.engine)), state: t.state,
            answer: result.answer || null, model: result.model || null, decision: result.decision || null,
            error: t.error_code ? { code: t.error_code, detail: t.error_detail || null } : null,
            cost_usd: Number(t.cost_usd) || 0, seconds: t.finished_at ? Math.round((ms(t.created_at, t.finished_at) || 0) / 100) / 10 : null,
            url: `${String(config.baseUrl || '').replace(/\/+$/, '')}/chat/${t.id}`,
        };
    }

    /** Grade every answer at once (the Decisions API, kind grading), once per comparison: claimed, then stored. */
    async function judge(row, sides) {
        const claimed = await s.db.maybe(`UPDATE actor_comparisons SET judged = '{"state":"judging"}'::jsonb, updated_at = $2 WHERE id = $1 AND judged IS NULL RETURNING id`, [row.id, s.iso()]);
        if (!claimed) return null;
        const answered = sides.filter((x) => x.state === 'succeeded' && x.answer);
        let judged;
        if (!answered.length) judged = { state: 'none', reason: 'No way finished with an answer.' };
        else if (!models || typeof models.decide !== 'function') judged = { state: 'unavailable', reason: 'The Decisions API is not reachable from this server, so the answers are not graded.' };
        else {
            try {
                const input = `The task:\n${row.task.slice(0, 6000)}\n\n${answered.map((x, i) => `Answer ${LETTERS[i]}:\n${String(x.answer).slice(0, 5000)}`).join('\n\n')}`;
                const questions = Object.fromEntries(answered.map((x, i) => [`a${i}`, { type: 'score', instructions: `How well does answer ${LETTERS[i]} do the task: correct, complete, useful, and honest about what it does not know?`, criteria: RUBRIC }]));
                const d = await models.decide({ input, questions, kind: 'grading', model: 'auto' });
                const scores = {};
                answered.forEach((x, i) => { const a = d.answers && d.answers[`a${i}`]; if (a) scores[x.task_id] = { score: Math.round(Number(a.score) * 1000) / 1000, confidence: Number(a.confidence) || null }; });
                const ranked = Object.entries(scores).sort((a, b) => b[1].score - a[1].score);
                const r = d.receipt || {};
                judged = { state: 'judged', scores, winner: ranked.length ? ranked[0][0] : null, tie: ranked.length > 1 && Math.abs(ranked[0][1].score - ranked[1][1].score) < 0.05,
                    by: [r.provider, r.model].filter(Boolean).join('/') || 'decisions', calibrated: Boolean(d.calibrated), cost_usd: Number(r.cost_usd) || 0, out_of: RUBRIC.length - 1, rubric: RUBRIC };
            } catch (err) {
                log.warn('[Actor] comparison judge:', (err && err.message) || err);
                judged = { state: 'failed', reason: String((err && err.message) || err).slice(0, 300) };
            }
        }
        await s.db.query('UPDATE actor_comparisons SET judged = $2::jsonb, judged_at = $3, updated_at = $3 WHERE id = $1', [row.id, JSON.stringify(judged), s.iso()]);
        return judged;
    }

    async function get(id, requester) {
        const row = await s.db.maybe('SELECT * FROM actor_comparisons WHERE id = $1 AND requester = $2', [id, requester]);
        if (!row) return null;
        const tasks = await s.db.many('SELECT * FROM tasks WHERE comparison_id = $1 ORDER BY created_at, id', [id]);
        const sides = tasks.map(sideOf);
        let judged = jsonOf(row.judged);
        const done = sides.length > 0 && sides.every((x) => TERMINAL.has(x.state));
        if (done && !judged) judged = await judge(row, sides) || { state: 'judging' };
        if (judged && judged.scores) for (const x of sides) if (judged.scores[x.task_id]) { x.score = judged.scores[x.task_id].score; x.won = judged.winner === x.task_id && !judged.tie; }
        return { id: row.id, task: row.task, engines: jsonOf(row.engines), done, sides, judged: judged || null, created_at: new Date(row.created_at).toISOString(),
            url: `${String(config.baseUrl || '').replace(/\/+$/, '')}/compare/${row.id}` };
    }

    async function list(requester, { limit = 20 } = {}) {
        const rows = await s.db.many('SELECT id, task, engines, judged, created_at FROM actor_comparisons WHERE requester = $1 ORDER BY created_at DESC LIMIT $2', [requester, Math.max(1, Math.min(100, Number(limit) || 20))]);
        return rows.map((r) => ({ id: r.id, task: String(r.task).slice(0, 200), engines: (jsonOf(r.engines) || []).map(label), judged: (jsonOf(r.judged) || {}).state || null, created_at: new Date(r.created_at).toISOString() }));
    }

    /** Per engine, over graded comparisons (the person's own, or everyone's when requester is null): only numbers. */
    async function leaderboard({ requester = null, limit = 500 } = {}) {
        const rows = await s.db.many(`SELECT c.id, c.judged, t.id AS task_id, t.engine, t.state, t.cost_usd, t.created_at, t.finished_at
            FROM actor_comparisons c JOIN tasks t ON t.comparison_id = c.id
            WHERE c.judged_at IS NOT NULL${requester ? ' AND c.requester = $2' : ''} ORDER BY c.judged_at DESC LIMIT $1`, requester ? [limit * MAX, requester] : [limit * MAX]);
        const by = new Map();
        for (const r of rows) {
            const e = jsonOf(r.engine);
            const k = keyOf(e);
            if (!by.has(k)) by.set(k, { engine: e, label: label(e), runs: 0, finished: 0, wins: 0, scores: [], seconds: [], costs: [] });
            const b = by.get(k);
            const j = jsonOf(r.judged) || {};
            b.runs += 1;
            if (r.state === 'succeeded') b.finished += 1;
            if (j.winner === r.task_id && !j.tie) b.wins += 1;
            if (j.scores && j.scores[r.task_id]) b.scores.push(j.scores[r.task_id].score);
            const took = ms(r.created_at, r.finished_at);
            if (took != null && r.state === 'succeeded') b.seconds.push(took / 1000);
            b.costs.push(Number(r.cost_usd) || 0);
        }
        const mean = (a) => (a.length ? Math.round((a.reduce((x, y) => x + y, 0) / a.length) * 1000) / 1000 : null);
        const median = (a) => { if (!a.length) return null; const v = [...a].sort((x, y) => x - y); const m = Math.floor(v.length / 2); return Math.round((v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2) * 10) / 10; };
        return [...by.values()].map((b) => ({ engine: b.engine, label: b.label, runs: b.runs, finished: b.finished, wins: b.wins, mean_score: mean(b.scores), out_of: RUBRIC.length - 1,
            median_seconds: median(b.seconds), mean_cost_usd: mean(b.costs) })).sort((a, b) => (b.mean_score ?? -1) - (a.mean_score ?? -1) || b.wins - a.wins);
    }

    return { create, get, list, leaderboard, judge };
}

module.exports = { createComparisons, RUBRIC };

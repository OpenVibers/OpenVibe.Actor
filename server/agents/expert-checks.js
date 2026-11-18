'use strict';

/**
 * OpenVibe's own Experts, checked on their own examples (plan §AD.28 item 9: "a scorecard per version").
 *
 * For each public version of a `service:actor` Expert that has no check yet, each of its examples (up to three) is:
 *   1. answered from the Expert's own instructions alone: its compiled system prompt and the example's ask, one model
 *      call with no tools (so an Expert that reads the person's apps answers from what the ask says);
 *   2. graded against the example's "good" (what a good answer does) on five levels, Poor to Excellent, through the
 *      Decisions API (one closed question, calibrated).
 * The rows (migration 0084) are the scorecard; the Expert's page shows the mean and each answer with its grade.
 *
 *   run(s, { models, log, limit })   checks up to `limit` versions that have none; → { checked: [ 'bp_x@2' ], skipped }
 *   scoreOf(s, id, version)          → { mean, count, at, rows: [{ example, ask, answer, score, level }] } | null
 */
const bp = require('openvibe-sdk/agents/blueprint');
const blueprints = require('./blueprints');

const LEVELS = ['Poor', 'Weak', 'Fair', 'Good', 'Excellent'];
const MAX_EXAMPLES = 3;

async function due(s, limit) {
    return s.db.many(`SELECT b.id, b.latest, v.doc FROM agent_blueprints b
        JOIN agent_blueprint_versions v ON v.blueprint_id = b.id AND v.version = b.latest
        WHERE b.owner = 'service:actor' AND b.visibility = 'public' AND b.deleted_at IS NULL AND b.latest IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM expert_checks c WHERE c.blueprint_id = b.id AND c.version = b.latest)
        ORDER BY b.id LIMIT $1`, [limit]);
}

const parse = (v) => (v == null ? null : typeof v === 'string' ? JSON.parse(v) : v);

/** One example: the Expert's answer from its instructions, and its grade. → a row, or null when either call failed. */
async function checkOne(models, doc, ex, { signal } = {}) {
    // Each input holds the trial's sample value (blueprints.sampleInput), as Try it does.
    const inputs = Object.fromEntries((doc.inputs || []).map((inp) => [inp.id, blueprints.sampleInput(inp, null)]));
    const system = bp.compile(doc, { inputs, install: { agent: 'agt_check', inputs, places: {} } }).loop.system;
    const out = await models.chat({
        tier: 'smart', maxTokens: 900, signal,
        messages: [
            { role: 'system', content: `${system}\n\n(This is a check of how you answer: you have no tools here. Answer from what the person says.)` },
            { role: 'user', content: String(ex.ask).slice(0, 2000) },
        ],
    });
    const answer = String((out && out.text) || '').trim();
    if (!answer) return null;
    const d = await models.decide({
        input: `What the person asked:\n${String(ex.ask).slice(0, 2000)}\n\nWhat a good answer does:\n${String(ex.good).slice(0, 1000)}\n\nThe answer to grade:\n${answer.slice(0, 6000)}`,
        questions: { grade: { type: 'score', instructions: 'How well does the answer do what a good answer does, for this person and this ask?', criteria: LEVELS } },
        model: 'auto', kind: 'other',
    }, { signal });
    const a = d && d.answers && d.answers.grade;
    const raw = a ? Number(a.score) : NaN;
    if (!Number.isFinite(raw)) return null;
    const level = Math.max(0, Math.min(4, Math.round(raw)));
    return {
        answer: answer.slice(0, 8000), score: Math.round((raw + 1) * 100) / 100, level: LEVELS[level],
        model: (out && (out.model || out.provider)) || null,
        cost: (Number(out && out.cost_usd) || 0) + (Number(d && d.receipt && d.receipt.cost_usd) || 0),
    };
}

async function run(s, { models, log = console, limit = 4, signal = null } = {}) {
    const checked = [];
    let skipped = 0;
    if (!models || typeof models.chat !== 'function' || typeof models.decide !== 'function') return { checked, skipped };
    if (typeof models.decideReady === 'function' && !models.decideReady()) return { checked, skipped };
    for (const row of await due(s, limit)) {
        const doc = parse(row.doc);
        const examples = ((doc && doc.knows && doc.knows.examples) || []).filter((e) => e && e.ask && e.good).slice(0, MAX_EXAMPLES);
        if (!examples.length) { skipped += 1; continue; }
        const results = [];
        for (const [i, ex] of examples.entries()) {
            try {
                const r = await checkOne(models, doc, ex, { signal });
                if (r) results.push({ i, ex, r });
            } catch (err) {
                if (log.warn) log.warn(`[Actor] checking ${row.id}@${row.latest} example ${i}: ${String((err && err.message) || err).slice(0, 160)}`);
            }
        }
        // All of a version's examples, or none: a half-checked version is tried again later, never shown half.
        if (results.length !== examples.length) { skipped += 1; continue; }
        for (const { i, ex, r } of results) {
            await s.db.query(`INSERT INTO expert_checks (blueprint_id, version, example, ask, good, answer, score, level, model, cost_usd)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT (blueprint_id, version, example) DO NOTHING`,
            [row.id, row.latest, i, String(ex.ask).slice(0, 2000), String(ex.good).slice(0, 1000), r.answer, r.score, r.level, r.model, r.cost]);
        }
        checked.push(`${row.id}@${row.latest}`);
    }
    if (checked.length && log.info) log.info(`[Actor] Experts checked on their examples: ${checked.join(', ')}`);
    return { checked, skipped };
}

async function scoreOf(s, id, version) {
    const rows = await s.db.many('SELECT example, ask, answer, score, level, created_at FROM expert_checks WHERE blueprint_id = $1 AND version = $2 ORDER BY example', [id, version]);
    if (!rows.length) return null;
    const scores = rows.map((r) => Number(r.score));
    return {
        mean: Math.round((scores.reduce((n, x) => n + x, 0) / scores.length) * 10) / 10,
        count: rows.length, at: rows[0].created_at,
        rows: rows.map((r) => ({ example: r.example, ask: r.ask, answer: r.answer, score: Number(r.score), level: r.level })),
    };
}

module.exports = { run, scoreOf, checkOne, LEVELS };

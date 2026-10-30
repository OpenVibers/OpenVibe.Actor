'use strict';

/**
 * Step choice (Actor v2, stage V2-8): which tier (fast, smart or best) the next model turn runs on, and which tools
 * are offered first.
 *
 * The tier is a small Thompson-sampling bandit over the tiers the task's mode allows:
 *   cheapest / balanced / fastest   fast, smart
 *   best                            fast, smart, best
 *   private                         fast (the loop does not run private tasks today; kept for completeness)
 *
 * Each candidate's success probability is sampled from a Beta posterior whose prior is actor_brain_outcomes (how often
 * this task kind + step kind + tier worked before) and whose data are the live 7-day stats (stats.forModel, V2-10).
 * A sampled candidate is scored down by its expected cost against the budget left, so a tier whose next call could
 * exceed the task's allowance is never picked. If no candidate fits, the caller gets tier: null and answers from the
 * evidence it already has — never an over-budget call. The $0.05 per-task allowance is the owner's and is not changed.
 *
 * Tools: a tool whose 7-day success rate is under 50% with n ≥ 20 is demoted — offered last, with a note in the
 * prompt — never removed. Below about 40 tools the model sees them all (the DeepSeek research's rule), so there is no
 * embedding shortlist or LLM picker here; the live stats only reorder.
 *
 * loadPrior({ store, kind, tiers, stepKinds }) → Map(priorKey → { successes, failures })
 * chooseTier({ mode, kind, stepKind, budgetLeft, models, stats, prior, rng }) → Promise<{ tier, expectedUsd, p, candidates }>
 * orderTools(definitions, statsRows) → { tools, demoted, note }
 */

const STEP_KINDS = Object.freeze(['plan', 'work', 'answer', 'repair']);
const COST_WEIGHT = 0.2;
const DEMOTE_RATE = 0.5;
const DEMOTE_MIN_N = 20;

const ALLOWED = Object.freeze({
    cheapest: ['fast', 'smart'],
    balanced: ['fast', 'smart'],
    fastest: ['fast', 'smart'],
    best: ['fast', 'smart', 'best'],
    private: ['fast'],
});

function allowedTiers(mode) {
    return (ALLOWED[String(mode)] || ALLOWED.balanced).slice();
}

const priorKey = ({ kind, tier, stepKind, tool = '' }) => `${kind}\u0000${tier}\u0000${stepKind}\u0000${tool}`;

/** The learned counts for one task kind, as the bandit's prior. A missing table is an empty prior, never a failure. */
async function loadPrior({ store, kind, tiers = null, stepKinds = null, log = null } = {}) {
    const out = new Map();
    if (!store || !store.db || typeof store.db.many !== 'function' || !kind) return out;
    const args = [kind];
    let sql = 'SELECT tier, step_kind, tool, successes, failures FROM actor_brain_outcomes WHERE task_kind = $1';
    if (Array.isArray(tiers) && tiers.length) { args.push(tiers); sql += ` AND tier = ANY($${args.length}::text[])`; }
    if (Array.isArray(stepKinds) && stepKinds.length) { args.push(stepKinds); sql += ` AND step_kind = ANY($${args.length}::text[])`; }
    try {
        const rows = await store.db.many(sql, args);
        for (const r of rows || []) {
            out.set(`${r.tier}\u0000${r.step_kind}\u0000${r.tool || ''}`, { successes: Number(r.successes) || 0, failures: Number(r.failures) || 0 });
        }
    } catch (err) {
        if (log && log.warn) log.warn('[Actor] brain outcomes not readable (the bandit uses its prior alone):', (err && err.message) || err);
    }
    return out;
}

// Beta(a, b) for the small integer-shaped posteriors this table produces. Gamma(k) for a whole k is the sum of k
// exponentials, which is exact and needs no library; counts are capped so one very popular tier cannot spin here.
function gamma(k, rng) {
    let sum = 0;
    const n = Math.max(1, Math.min(200, Math.round(k)));
    for (let i = 0; i < n; i++) sum -= Math.log(Math.max(1e-12, 1 - rng()));
    return sum || 1e-9;
}
function sampleBeta(a, b, rng) {
    const x = gamma(a, rng);
    const y = gamma(b, rng);
    return x / (x + y);
}

/** A tier's usual cost: the live mean when it has one, else the rate card for a small call, else a tier prior. */
function estimateUsd(tier, { descriptor, live } = {}) {
    if (live && live.meanCostUsd != null) return Number(live.meanCostUsd);
    const rates = (descriptor && descriptor.rates) || {};
    const fromCard = ((Number(rates.input_usd_per_mtok) || 0) * 2000 + (Number(rates.output_usd_per_mtok) || 0) * 500) / 1e6 + (Number(rates.per_call_usd) || 0);
    if (fromCard > 0) return fromCard;
    return tier === 'fast' ? 0.0004 : tier === 'smart' ? 0.004 : 0.02;
}

/**
 * Pick the tier for one step. Every candidate is sampled, scored and checked against the budget left; a candidate
 * that cannot fit is not a pick. `rng` is injectable so a test can make the bandit deterministic.
 */
async function chooseTier({ mode = 'balanced', kind = 'answer', stepKind = 'work', budgetLeft = Infinity, models, stats = null, prior = new Map(), rng = Math.random, log = null, preferred = null } = {}) {
    const allowed = allowedTiers(mode);
    const candidates = [];
    for (const tier of allowed) {
        let descriptor = null;
        try { descriptor = models && typeof models.resolve === 'function' ? models.resolve(tier) : null; } catch { descriptor = null; }
        if (!descriptor || descriptor.available === false) continue;
        let live = null;
        try { live = stats ? await stats.forModel(descriptor.model) : null; } catch { live = null; }
        const learned = prior.get(`${tier}\u0000${stepKind}\u0000`) || { successes: 0, failures: 0 };
        // The outcomes table is the prior; the live stats are evidence. A model with 20 calls at 90% should outweigh
        // an old table row, and a fresh table row should still be able to explore.
        const n = Math.max(0, Math.min(20, Number(live && live.n) || 0));
        const rate = live && live.successRate != null ? Number(live.successRate) : null;
        const alpha = 1 + Math.max(0, learned.successes) + (rate == null ? 0 : rate * n);
        const beta = 1 + Math.max(0, learned.failures) + (rate == null ? 0 : (1 - rate) * n);
        const p = sampleBeta(alpha, beta, rng);
        const expectedUsd = estimateUsd(tier, { descriptor, live });
        const fits = !(Number.isFinite(budgetLeft) && expectedUsd > budgetLeft + 1e-12);
        const utility = p - COST_WEIGHT * (Number.isFinite(budgetLeft) ? Math.min(1, expectedUsd / Math.max(budgetLeft, 0.005)) : 0);
        candidates.push({ tier, p, expectedUsd, fits, utility, n: live ? live.n : 0, successRate: rate, learned });
    }
    const fitting = candidates.filter((c) => c.fits);
    if (!fitting.length) {
        return { tier: null, expectedUsd: null, candidates, reason: candidates.length ? 'budget' : 'no model is available for the allowed tiers' };
    }
    // With no evidence at all, the task's own tier is the answer: a bandit has nothing to explore yet, and moving every
    // fresh task off the configured smart/best tier would be a hidden behaviour change, not learning.
    const anyData = candidates.some((c) => c.n > 0 || ((c.learned.successes || 0) + (c.learned.failures || 0)) > 0);
    if (!anyData && preferred) {
        const base = fitting.find((c) => c.tier === preferred);
        if (base) return { tier: base.tier, expectedUsd: base.expectedUsd, p: base.p, candidates, reason: 'no data yet' };
        fitting.sort((a, b) => (a.expectedUsd - b.expectedUsd) || (allowed.indexOf(a.tier) - allowed.indexOf(b.tier)));
        return { tier: fitting[0].tier, expectedUsd: fitting[0].expectedUsd, p: fitting[0].p, candidates, reason: 'the preferred tier does not fit the budget' };
    }
    fitting.sort((a, b) => (b.utility - a.utility) || (allowed.indexOf(a.tier) - allowed.indexOf(b.tier)));
    if (log && log.log && candidates.length > 1) {
        log.log(`[Actor] brain tier for ${kind}/${stepKind}: ${fitting[0].tier} (${fitting.map((c) => `${c.tier} ${c.p.toFixed(2)}`).join(', ')})`);
    }
    return { tier: fitting[0].tier, expectedUsd: fitting[0].expectedUsd, p: fitting[0].p, candidates };
}

/**
 * Reorder the offered tools: the demoted ones last, with a note the loop puts in the prompt. Nothing is removed, so a
 * tool that is the only way to do the task is still callable.
 */
function orderTools(definitions = [], statsRows = []) {
    const rows = Array.isArray(statsRows) ? statsRows : [];
    const by = new Map(rows.filter((r) => r && r.name).map((r) => [String(r.name), r]));
    const demoted = [];
    const first = [];
    for (const d of Array.isArray(definitions) ? definitions : []) {
        const name = d && d.function && d.function.name;
        const st = by.get(name);
        if (st && Number(st.n) >= DEMOTE_MIN_N && st.successRate != null && Number(st.successRate) < DEMOTE_RATE) demoted.push(d);
        else first.push(d);
    }
    const names = demoted.map((d) => d.function.name);
    return {
        tools: first.concat(demoted),
        demoted: names,
        note: names.length ? `Offered last (a poor recent record: under 50% success in the last 7 days): ${names.join(', ')}. Use one only when no other tool fits.` : '',
    };
}

module.exports = {
    allowedTiers, loadPrior, chooseTier, orderTools, sampleBeta, estimateUsd, priorKey,
    STEP_KINDS, COST_WEIGHT, DEMOTE_RATE, DEMOTE_MIN_N, ALLOWED,
};

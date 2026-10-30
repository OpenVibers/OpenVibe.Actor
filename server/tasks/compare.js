'use strict';

/**
 * Compare two runs of one person (Actor v2, stage V2-9): the two answers, their cost and time, their steps, and the
 * claims that differ. The task page and the live demo both read this, so the demo shows exactly what the page shows.
 *
 * A "claim that differs" is a claim the verifier found in one answer and not the other, or the same claim graded at a
 * different confidence. Claim text is compared lower-cased with its punctuation and spacing folded; two runs that word
 * the same fact differently still count as different, which is honest: the comparison is between answers, not a
 * semantic diff. The rows themselves are private: the caller has already checked that both tasks are the person's.
 *
 *   summary(row, { spans, offer, now }) → the run's half of the comparison
 *   compare(rowA, rowB, { spansA, spansB, offerA, offerB, now }) → { a, b, claims }
 */

const parse = (value) => (value == null ? null : typeof value === 'string' ? JSON.parse(value) : value);
const ms = (row, now) => {
    const start = Date.parse(row.created_at);
    const end = row.finished_at ? Date.parse(row.finished_at) : now;
    return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : 0;
};
const claimKey = (text) => String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();

function claimsOf(row) {
    const result = parse(row.result);
    const checked = (result && result.checked) || {};
    return Array.isArray(checked.claims_detail) ? checked.claims_detail.filter((c) => c && c.claim) : [];
}

/** One run as the comparison shows it. `spans` are the trace rows already read for the page. */
function summary(row, { spans = [], offer = null, now = Date.now() } = {}) {
    const result = parse(row.result);
    const checked = (result && result.checked) || {};
    const spansList = Array.isArray(spans) ? spans : [];
    return {
        id: row.id,
        task: String(row.task || ''),
        state: row.state,
        answer: result && result.answer ? String(result.answer) : null,
        cost_usd: Number(row.cost_usd) || 0,
        time_ms: ms(row, now),
        created_at: row.created_at,
        finished_at: row.finished_at || null,
        turns: Number(result && result.turns) || 0,
        step_count: spansList.length,
        tool_calls: spansList.filter((s) => s.kind === 'tool').length,
        check: {
            claims: Number(checked.claims) || claimsOf(row).length,
            grounded: Number(checked.grounded) || 0,
            by: checked.by || null,
            cross_family: !!checked.cross_family,
        },
        claims: claimsOf(row),
        bench: offer ? { offered: true, at: offer.offered_at || null } : { offered: false, at: null },
        fork_of_step: row.fork_of_step == null ? null : Number(row.fork_of_step),
    };
}

/** The claims that differ: one side only, or both with another confidence/evidence. */
function compareClaims(claimsA, claimsB) {
    const a = new Map();
    const b = new Map();
    for (const c of Array.isArray(claimsA) ? claimsA : []) {
        const k = claimKey(c.claim);
        if (k && !a.has(k)) a.set(k, c);
    }
    for (const c of Array.isArray(claimsB) ? claimsB : []) {
        const k = claimKey(c.claim);
        if (k && !b.has(k)) b.set(k, c);
    }
    const onlyA = [];
    const onlyB = [];
    const changed = [];
    for (const [k, c] of a) {
        const other = b.get(k);
        if (!other) { onlyA.push(c); continue; }
        const ca = c.confidence || 'unverified';
        const cb = other.confidence || 'unverified';
        const ea = (Array.isArray(c.evidence) ? c.evidence : []).join(',');
        const eb = (Array.isArray(other.evidence) ? other.evidence : []).join(',');
        if (ca !== cb || ea !== eb) changed.push({ claim: c.claim, a: { confidence: ca, evidence: c.evidence || [] }, b: { confidence: cb, evidence: other.evidence || [] } });
    }
    for (const [k, c] of b) if (!a.has(k)) onlyB.push(c);
    return { only_a: onlyA, only_b: onlyB, changed };
}

function compare(rowA, rowB, { spansA = [], spansB = [], offerA = null, offerB = null, now = Date.now() } = {}) {
    const a = summary(rowA, { spans: spansA, offer: offerA, now });
    const b = summary(rowB, { spans: spansB, offer: offerB, now });
    return { a, b, claims: compareClaims(a.claims, b.claims) };
}

module.exports = { compare, summary, compareClaims, claimKey, claimsOf };

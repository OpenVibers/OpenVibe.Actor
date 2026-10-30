'use strict';

/**
 * Learn (Actor v2, stage V2-8): what a finished task teaches the router, and what a correction teaches it.
 *
 *   record       one step's outcome: successes += 1 or failures += 1 in actor_brain_outcomes, keyed by the understand
 *                pass's task kind, the tier, the step kind and the tool ('' for a model call).
 *   recordSteps  every step the loop kept for its run; called when the loop finishes, best-effort, never failing the
 *                task.
 *   recordCheck  the verifier's verdict for the answer step: a failed check is a failure for every tier and tool the
 *                run used, so the bandit sees what did not get delivered.
 *   correction   a follow-up that says the answer was wrong: a failure for the parent's tiers and tools, and a
 *                suggested memory (the V2-6 rule: a suggestion, never active) saying what the person corrected.
 *
 * The outcome table is counts only — no person column, no task text, no model output. A correction's words go to the
 * person's own memory as a suggestion, where they can see and accept or delete it, never to the shared table.
 */

const CORRECTION_RE = /\b(?:(?:that|this|the answer|your answer|it)(?:'s| is| was)? (?:wrong|incorrect|not right|not correct|off)|you(?:'re| are) wrong|not what i (?:asked|meant)|i (?:asked|said) (?:for )?(?:a |the )?different|(?:the )?price is (?:wrong|off)|(?:that|this) is not (?:what|right|correct)|actually,? (?:it|the|they|that))\b/i;

const clip = (s, n) => { const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

function isCorrection(text) {
    return CORRECTION_RE.test(String(text || ''));
}

/** One outcome write. The unique key makes concurrent finishes add to the same row. */
async function record({ store, kind = 'answer', tier = 'smart', stepKind = 'work', tool = '', ok = true, log = null, now = () => Date.now() } = {}) {
    if (!store || !store.db || typeof store.db.query !== 'function') return false;
    const id = typeof store.newId === 'function' ? store.newId('boc') : `boc_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
    try {
        await store.db.query(
            `INSERT INTO actor_brain_outcomes (id, task_kind, tier, step_kind, tool, successes, failures, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             ON CONFLICT (task_kind, tier, step_kind, tool) DO UPDATE
                SET successes = actor_brain_outcomes.successes + EXCLUDED.successes,
                    failures = actor_brain_outcomes.failures + EXCLUDED.failures,
                    updated_at = EXCLUDED.updated_at`,
            [id, String(kind || 'answer'), String(tier || 'smart'), String(stepKind || 'work'), String(tool || ''), ok ? 1 : 0, ok ? 0 : 1, new Date(now()).toISOString()],
        );
        return true;
    } catch (err) {
        // Learning is not the work: a missing table (a database mid-migration) never fails a task.
        if (log && log.warn) log.warn('[Actor] brain outcome not stored (the task goes on):', (err && err.message) || err);
        return false;
    }
}

/** Every step the loop kept: { tier, step_kind, tool, ok }. */
async function recordSteps({ store, kind = 'answer', steps = [], log = null, now = () => Date.now() } = {}) {
    const seen = new Set();
    let n = 0;
    for (const s of Array.isArray(steps) ? steps : []) {
        if (!s) continue;
        const key = `${s.step_kind}\u0000${s.tier}\u0000${s.tool || ''}\u0000${s.ok ? 1 : 0}`;
        if (seen.has(key)) continue;   // one row per distinct outcome is enough; repeats are the same lesson
        seen.add(key);
        if (await record({ store, kind, tier: s.tier || 'smart', stepKind: s.step_kind || 'work', tool: s.tool || '', ok: s.ok !== false, log, now })) n += 1;
    }
    return n;
}

/** The verifier's verdict for the answer step: every tier and tool of the run shares the outcome. */
async function recordCheck({ store, kind = 'answer', tiers = [], tools = [], ok = true, log = null, now = () => Date.now() } = {}) {
    let n = 0;
    for (const tier of [...new Set(tiers.filter(Boolean))]) if (await record({ store, kind, tier, stepKind: 'answer', ok, log, now })) n += 1;
    for (const tool of [...new Set(tools.filter(Boolean))]) if (await record({ store, kind, tier: 'smart', stepKind: 'work', tool, ok, log, now })) n += 1;
    return n;
}

/**
 * A follow-up that says the answer was wrong. The parent's result carries `brain.tiers` and `brain.tools` (written by
 * the loop); a failed step is recorded for each, and the person's own memory gets a suggestion — never an active note.
 */
async function correction({ store, parent = null, text = '', log = null, now = () => Date.now() } = {}) {
    if (!parent || !isCorrection(text)) return { corrected: false, outcomes: 0, memory: null };
    const result = parent.result ? (typeof parent.result === 'string' ? JSON.parse(parent.result) : parent.result) : {};
    const brain = (result && result.brain) || {};
    const tiers = [...new Set([...(brain.tiers || []), result && result.tier].filter(Boolean))];
    const tools = [...new Set(brain.tools || [])];
    let outcomes = 0;
    for (const tier of tiers) if (await record({ store, kind: brain.kind || 'answer', tier, stepKind: 'answer', ok: false, log, now })) outcomes += 1;
    for (const tool of tools) if (await record({ store, kind: brain.kind || 'answer', tier: 'smart', stepKind: 'work', tool, ok: false, log, now })) outcomes += 1;
    let memory = null;
    try {
        const memoryLib = require('../../memory');
        const owner = String(parent.requester || '');
        if (/^user:usr_/.test(owner)) {
            const agentId = /^agent:agt_/.test(String(parent.via || '')) ? String(parent.via).slice(6) : null;
            const textOut = `Correction on a task: ${clip(text, 300)}`;
            memory = await memoryLib.add(store, { owner, agentId, text: textOut, source: 'agent', status: 'suggested', sourceTask: parent.id });
        }
    } catch (err) {
        if (log && log.warn) log.warn('[Actor] correction memory not stored (the task goes on):', (err && err.message) || err);
    }
    return { corrected: true, outcomes, memory: memory && memory.row ? memory.row.id : null };
}

module.exports = { record, recordSteps, recordCheck, correction, isCorrection, CORRECTION_RE };

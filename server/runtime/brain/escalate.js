'use strict';

/**
 * Escalate, never repeat (Actor v2, stage V2-8): a failed check or a stalled step gets one rung up the cascade.
 *
 *   - a tier up: fast → smart → best, when the task's mode allows that tier and it has not been tried for this step;
 *   - or another tool: the next offered tool that has not failed for this step, when no stronger tier is allowed.
 *
 * The identical call is never the escalation: `plan` returns a different tier or a different tool, and a step that
 * already escalated has no second rung. Caps, in code: one escalation per step, two per task. A refused escalation is
 * null, and the caller falls back to its normal retry (or to an honest answer).
 *
 * Every escalation is a span (kind 'model' or 'tool', with the loop step) and an event for the page. The span is
 * written by `span()`; the event text is the plan's `text`.
 *
 * createEscalations() → { plan(input), count(), steps(), record(...) }
 * plan({ stepKey, mode, currentTier, currentTool, toolNames, triedTiers, triedTools })
 *   → { kind, tier?, tool?, text } | null
 */

const { allowedTiers } = require('./choose');

const UP = { fast: 'smart', smart: 'best', best: null };
const MAX_PER_TASK = 2;
const MAX_PER_STEP = 1;

/** The next stronger tier the mode allows, or null. `tried` keeps a step from repeating a rung. */
function nextTier({ mode = 'balanced', current = 'smart', tried = [] } = {}) {
    const allowed = allowedTiers(mode);
    let tier = UP[String(current)] || null;
    while (tier && !allowed.includes(tier)) tier = UP[tier] || null;
    return tier && !tried.includes(tier) ? tier : null;
}

/** Another tool for a step: the first offered one that is not the tool that failed and has not been tried. */
function nextTool({ current = null, toolNames = [], tried = [] } = {}) {
    for (const name of toolNames) {
        if (!name || name === current || tried.includes(name)) continue;
        return name;
    }
    return null;
}

function createEscalations({ maxPerTask = MAX_PER_TASK, maxPerStep = MAX_PER_STEP, total: restoredTotal = 0, byStep: restoredByStep = [] } = {}) {
    let total = Math.max(0, Number(restoredTotal) || 0);
    const byStep = new Map(Array.isArray(restoredByStep) ? restoredByStep.map(([k, n]) => [String(k), Math.max(0, Number(n) || 0)]) : []);
    const made = [];

    /**
     * The next rung for one step, or null. `stepKey` is the plan step (or the loop step number) the escalation is for.
     */
    function plan({ stepKey = 'step', mode = 'balanced', currentTier = 'smart', currentTool = null, toolNames = [], triedTiers = [], triedTools = [] } = {}) {
        if (total >= maxPerTask) return null;
        if ((byStep.get(stepKey) || 0) >= maxPerStep) return null;
        const tier = nextTier({ mode, current: currentTier, tried: triedTiers });
        if (tier) {
            total += 1;
            byStep.set(stepKey, (byStep.get(stepKey) || 0) + 1);
            const out = { kind: 'model', tier, text: `Tried a stronger model for this step (${currentTier} → ${tier}).`, stepKey };
            made.push(out);
            return out;
        }
        const tool = nextTool({ current: currentTool, toolNames, tried: triedTools });
        if (tool) {
            total += 1;
            byStep.set(stepKey, (byStep.get(stepKey) || 0) + 1);
            const out = { kind: 'tool', tool, text: `Tried another tool for this step: ${tool}.`, stepKey };
            made.push(out);
            return out;
        }
        return null;
    }

    /** The escalation as a span: kind model or tool, the loop step, 0 ms (the call it caused has its own span). */
    async function span(trace, escalation, { step = null, name = null, date = () => new Date().toISOString() } = {}) {
        if (!trace || !escalation || typeof trace.record !== 'function') return null;
        return trace.record({
            kind: escalation.kind === 'tool' ? 'tool' : 'model',
            name: escalation.kind === 'tool' ? escalation.tool : (name || 'escalation'),
            tier: escalation.tier || null,
            startedAt: Date.parse(date()),
            ms: 0,
            ok: true,
            step,
        });
    }

    return {
        plan,
        span,
        count: () => total,
        steps: () => new Map(byStep),
        made: () => made.slice(),
        snapshot: () => ({ total, byStep: [...byStep.entries()] }),
        caps: { maxPerTask, maxPerStep },
    };
}

module.exports = { createEscalations, nextTier, nextTool, UP, MAX_PER_TASK, MAX_PER_STEP };

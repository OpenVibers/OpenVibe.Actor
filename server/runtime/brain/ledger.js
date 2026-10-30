'use strict';

/**
 * The ledgers (Actor v2, stage V2-8, after Magentic-One): the task ledger says what the run knows and still has to
 * find out; the progress ledger says, after every step, whether it is getting anywhere.
 *
 * Task ledger — four columns, all facts, never a model's prose:
 *   given    what the task itself states (understand's facts.given, its constraints, what the person answered)
 *   lookup   what a tool still has to fetch (understand's facts.lookup, or the plan's sub-goals as they stand)
 *   derive   what must be computed or made from them (understand's facts.derive, the deliverable)
 *   plan     the sub-goals and their state
 *
 * Progress ledger — one update per step:
 *   done        the run has delivered its answer
 *   looping     the same call repeated or the tool batch refused
 *   progressing a step succeeded and was not looping
 *   next        the next sub-goal
 *
 * Rule, in code: two non-progress updates in a row replan once (the plan's step in hand is restated as a different
 * route), and a third stops the run with an honest "stuck" answer built from what was found. A successful step
 * resets the count. The ledgers are written into the existing plan events (`planText`) so the live plan shows them.
 */

const clip = (s, n) => { const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const uniq = (xs) => [...new Set((xs || []).map((x) => clip(x, 160)).filter(Boolean))];

function taskLedger({ task = '', understanding = {}, plan = { steps: [] } } = {}) {
    const facts = understanding.facts || {};
    const steps = Array.isArray(plan.steps) ? plan.steps : [];
    const given = uniq([
        ...(facts.given || []),
        ...(understanding.constraints || []),
        ...(understanding.assumptions || []).map((a) => `assumes: ${a}`),
    ]).slice(0, 8);
    if (!given.length) given.push(clip(task, 220));
    const lookup = uniq(facts.lookup && facts.lookup.length ? facts.lookup : steps.map((s) => s.goal)).slice(0, 8);
    const derive = uniq([...(facts.derive || []), ...(understanding.kind === 'file' || understanding.kind === 'action' ? [understanding.deliverable] : [])]).slice(0, 6);
    return {
        given,
        lookup,
        derive,
        plan: steps.map((s) => ({ goal: s.goal, state: s.state })),
        kind: understanding.kind || 'answer',
        risk: understanding.risk || 'low',
        deliverable: understanding.deliverable || clip(task, 300),
    };
}

/** The progress ledger: created once per run, updated after every step. */
function createProgress({ nextGoal = null } = {}) {
    const state = {
        done: false, looping: false, progressing: true, stalls: 0, replans: 0, updates: 0,
        nextGoal: nextGoal ? clip(nextGoal, 160) : null, replannedAt: null,
    };
    function snapshot() {
        return {
            done: state.done, looping: state.looping, progressing: state.progressing, stalls: state.stalls,
            replans: state.replans, next: state.nextGoal, updates: state.updates, replanned_at: state.replannedAt,
        };
    }
    /**
     * One step's update. `answered` means the run delivered an answer; `okResults` is how many tool calls succeeded;
     * `looping` is the loop detector's verdict; `nextGoal` is where the run says it goes next, if it says.
     */
    function update({ answered = false, okResults = 0, errorResults = 0, looping = false, nextGoal: next = null } = {}) {
        state.updates += 1;
        state.looping = Boolean(looping);
        const progressed = Boolean(answered) || (okResults > 0 && !looping);
        state.progressing = progressed;
        if (answered) state.done = true;
        if (!progressed && !state.done) state.stalls += 1;
        else if (progressed) state.stalls = 0;
        if (next) state.nextGoal = clip(next, 160);
        const replan = !state.done && state.stalls >= 2 && state.replans === 0;
        if (replan) { state.replans += 1; state.replannedAt = state.updates; }
        const stuck = !state.done && state.stalls >= 3;
        return { ...snapshot(), replan, stuck, errors: errorResults };
    }
    return { state, update, snapshot };
}

/** Restate the plan's step in hand as a different route after no progress. Mutates the plan (the loop owns it). */
function replan(plan, { nextGoal = null } = {}) {
    if (!plan || !Array.isArray(plan.steps) || !plan.steps.length) return { changed: false, goal: null };
    const at = Math.max(0, plan.steps.findIndex((s) => s.state === 'active'));
    const step = plan.steps[at];
    if (!step) return { changed: false, goal: null };
    const goal = nextGoal ? `Try another route: ${clip(nextGoal, 160)}` : `Try another route for: ${clip(step.goal, 150)}`;
    step.goal = clip(goal, 200);
    return { changed: true, goal: step.goal, step: at + 1 };
}

/** The two lines the plan event carries: the task ledger and the progress ledger. */
function ledgerText(ledger, progress) {
    if (!ledger) return '';
    const p = progress || {};
    const given = (ledger.given || []).join('; ') || 'none';
    const lookup = (ledger.lookup || []).join('; ') || 'none';
    const derive = (ledger.derive || []).join('; ') || 'none';
    const next = p.next ? clip(p.next, 120) : ((ledger.plan || []).find((s) => s.state === 'active') || {}).goal || 'answer';
    return [
        `Task ledger: given ${clip(given, 260)} · find ${clip(lookup, 260)} · derive ${clip(derive, 200)}`,
        `Progress: ${p.done ? 'done' : 'not done'}; ${p.looping ? 'looping' : 'not looping'}; ${p.progressing === false ? 'no progress' : 'moving'}; next ${clip(next, 140)}`,
    ].join('\n');
}

module.exports = { taskLedger, createProgress, replan, ledgerText };

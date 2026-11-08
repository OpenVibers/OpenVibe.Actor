'use strict';
/**
 * A goal that keeps going (plan HO3): "keep checking the price of X every 30 minutes until it drops under €120".
 *
 * The goal is a trigger of kind goal. Its schedule is the check interval (Watch's five-field cron, the
 * same 15-minute floor), and each run does a piece of the work and then answers the goal's done-test:
 * one short yes or no with its reason, on a line of its own. The answer is the agent's judgement, made
 * with what the run actually saw; a run that never says is not a done-test passing.
 *
 *   promptFor(goal, task)        the run input: the work, then what to answer
 *   verdictOf(answer)            { done, reason, answer } — the machine line taken out of the answer
 *   endingOf({ goal, runsUsed, spentUsd, at })  { reason, line } — how the goal ends now, or null
 */

/** "VERDICT: yes — €112 on the maker's store" (an em dash, a colon or a hyphen all do). */
const VERDICT_SOURCE = String.raw`^[ \t]*VERDICT[ \t]*:[ \t]*(yes|no|true|false)[ \t]*(?:[—–:-]+[ \t]*)?(.*)$`;
const verdictRe = () => new RegExp(VERDICT_SOURCE, 'gim');
const MAX_REASON = 300;

const clean = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
const clip = (s, n) => { const t = clean(s); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

/** What one run is asked: do a piece of the work, then answer the done-test in one line. */
function promptFor(goal, task) {
    const text = clip(goal && goal.text, 500);
    const test = clip(goal && goal.done_test, 300);
    if (!test) return String(task || '');
    return [
        `This is one run of a goal the person set: "${text}".`,
        `The goal is done only when this is true: "${test}". Each run you do a piece of the work, then check it.`,
        'End your answer with one line of exactly this shape:',
        'VERDICT: yes — <the one fact that settles it>',
        'or',
        'VERDICT: no — <what is still missing, in as few words as possible>',
        'Use what this run actually saw. Never say yes on a guess, and never write anything after that line.',
        '',
        String(task || ''),
    ].join('\n');
}

/**
 * The answer with its verdict: { done: true|false|null, reason, answer }. A run that did not answer the
 * done-test is done: null, so the goal keeps going and says the agent did not say.
 */
function verdictOf(answer) {
    const text = String(answer == null ? '' : answer);
    let found = null;
    const re = verdictRe();
    for (const m of text.matchAll(re)) found = m;
    if (!found) return { done: null, reason: '', answer: text.trim() };
    const done = /^(yes|true)$/i.test(found[1]);
    const reason = clip(found[2].replace(/^[\s—–:-]+/, ''), MAX_REASON);
    const kept = text.replace(verdictRe(), '').replace(/\n{3,}/g, '\n\n').trim();
    return { done, reason, answer: kept };
}

/**
 * How a goal ends after a run, from its own limits: the done-test passed, or the last run, the money or
 * the deadline is spent. → { reason, line } or null. `reason` is the card's paused_reason.
 */
function endingOf({ goal, verdict, runsUsed, spentUsd, at = Date.now() }) {
    const g = goal || {};
    if (verdict && verdict.done === true) {
        return { reason: 'done', line: `Goal reached: ${clip(g.done_test, 200)}${verdict.reason ? ` (${verdict.reason})` : ''}.` };
    }
    const runsMax = g.runs_max == null ? NaN : Number(g.runs_max);
    if (Number.isFinite(runsMax) && runsMax > 0 && runsUsed >= runsMax) {
        return { reason: 'budget', line: `Stopping here: the goal has used its ${runsMax} run${runsMax === 1 ? '' : 's'} and is not done.` };
    }
    const budget = g.budget_usd == null ? NaN : Number(g.budget_usd);
    if (Number.isFinite(budget) && spentUsd >= budget) {
        return { reason: 'budget', line: `Stopping here: the goal has spent its $${budget.toFixed(2)} budget and is not done.` };
    }
    const deadline = g.deadline_at ? Date.parse(g.deadline_at) : NaN;
    if (Number.isFinite(deadline) && at >= deadline) {
        return { reason: 'deadline', line: `Stopping here: ${new Date(deadline).toISOString().slice(0, 10)} passed and the goal is not done.` };
    }
    return null;
}

module.exports = { promptFor, verdictOf, endingOf, VERDICT_SOURCE, MAX_REASON };

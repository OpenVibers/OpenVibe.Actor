'use strict';

/**
 * The bounds a wait obeys (plan A2, Watch mode). A wait is a record, and a record is only as good as its limits:
 * how many a person may have open, how many one task may hold, how long a deadline may be, how big a matcher may
 * be. The numbers here are the defaults; the caps are in code, so an operator cannot widen them by accident.
 *
 *   perPerson        open waits per person          5   (cap 10)
 *   perTask          open waits per task            1   (cap 3)
 *   perTaskLifetime  waits one task may ever hold   5   (cap 20)
 *   deadlineMs       how long a wait may last       6 h (cap 24 h)
 *   filterClauses    clauses in one matcher         4   (cap 8)
 *   payloadChars     what of an event reaches the model  2 kB
 */
const DEFAULTS = {
    perPerson: 5,
    perPersonMax: 10,
    perTask: 1,
    perTaskMax: 3,
    perTaskLifetime: 5,
    perTaskLifetimeMax: 20,
    deadlineMs: 6 * 60 * 60_000,
    deadlineMaxMs: 24 * 60 * 60_000,
    filterClauses: 4,
    filterClausesMax: 8,
    filterValueChars: 200,
    lineChars: 200,
    payloadChars: 2000,
};

function int(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/** The limits in force: the configured numbers, clamped by the hard caps. */
function limits(config) {
    const w = (config && config.waits) || {};
    const l = { ...DEFAULTS };
    l.perPerson = Math.min(int(w.perPerson, l.perPerson), l.perPersonMax);
    l.perTask = Math.min(int(w.perTask, l.perTask), l.perTaskMax);
    l.perTaskLifetime = Math.min(int(w.perTaskLifetime, l.perTaskLifetime), l.perTaskLifetimeMax);
    l.deadlineMs = Math.min(int(w.deadlineMs, l.deadlineMs), l.deadlineMaxMs);
    l.filterClauses = Math.min(int(w.filterClauses, l.filterClauses), l.filterClausesMax);
    l.filterValueChars = Math.min(int(w.filterValueChars, l.filterValueChars), DEFAULTS.filterValueChars);
    l.payloadChars = Math.min(int(w.payloadChars, l.payloadChars), DEFAULTS.payloadChars);
    return l;
}

module.exports = { limits, DEFAULTS };

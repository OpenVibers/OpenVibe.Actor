'use strict';

/**
 * Today's free allowance (plan L6196), read the way every page where a person starts a run shows it: what is left
 * after what tasks cost and after what the runs still open may yet spend. One helper, so the console, the task box
 * and the chat's composer say the same thing.
 */
const round = (n) => Math.round(n * 1e6) / 1e6;
/** Dollars with the cents the allowance actually has: two decimals when exact, up to four when not ($0.0377). */
const text = (n) => {
    const v = round(n);
    if (v === 0) return '$0';
    const at = (places) => Math.abs(v * 10 ** places - Math.round(v * 10 ** places)) < 1e-9;
    return `$${v.toFixed(at(2) ? 2 : at(3) ? 3 : 4)}`;
};

/** { left, used, held } in USD today, from a tier and store.spendToday(). */
function leftToday(tier, today = {}) {
    const used = Number(today.usd) || 0;
    const held = Number(today.reserved) || 0;
    return { left: Math.max(0, round(tier.perDayUsd - used - held)), used: round(used), held: round(held) };
}

/** One plain sentence: what is left, and what runs still open are holding. */
function leftLine(tier, today = {}) {
    if (!(tier.perDayUsd > 0)) return 'No free allowance is set on this Actor.';
    const { left, held } = leftToday(tier, today);
    if (left <= 0) return held > 0
        ? `The free allowance is in use for today (${text(held)} held by runs in progress).`
        : 'The free allowance is used for today.';
    return `${text(left)} of the ${text(tier.perDayUsd)} free allowance left today${held > 0 ? ` (${text(held)} held by runs in progress)` : ''}.`;
}

module.exports = { leftToday, leftLine, text };

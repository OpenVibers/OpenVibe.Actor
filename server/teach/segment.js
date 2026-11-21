'use strict';
/**
 * A demonstration, cleaned up before a model reads it (Teach, plan §AD.33; the owner, 11-21: "build modular intelligent
 * teach feature"). Pure: the recorder's raw steps in, the actions a person meant out.
 *
 *   - scrolling in one direction is one step ("You scrolled down (6 times)");
 *   - typing, the Backspaces that corrected it and the typing after them are one step with the text as it ended;
 *   - the same click twice in a row on the same spot (a double press, a click that seemed not to take) is one;
 * Every kept step keeps its seq, its picture and its args, so the pictures still match the words.
 */
const SAME_SPOT_PX = 6;

const isType = (x) => x && x.args && x.args.action === 'type';
const isBackspace = (x) => x && x.args && x.args.action === 'key' && /^(BackSpace|Backspace)$/.test(String(x.args.keys || ''));
const isScroll = (x) => x && x.args && x.args.action === 'scroll';
const isClick = (x) => x && x.args && /click/.test(String(x.args.action || ''));
const down = (x) => Number(x.args.dy) >= 0;

/** The typed words a step kept (never private text). */
const kept = (x) => (isType(x) && !x.args.private && typeof x.args.text === 'string' ? x.args.text : null);

function sameSpot(a, b) {
    if (a.args.action !== b.args.action) return false;
    const dx = Math.abs(Number(a.args.x) - Number(b.args.x));
    const dy = Math.abs(Number(a.args.y) - Number(b.args.y));
    return Number.isFinite(dx) && Number.isFinite(dy) && dx <= SAME_SPOT_PX && dy <= SAME_SPOT_PX;
}

/**
 * steps: recorder.steps() rows ({ seq, text, args, picture }) → { actions, merged } where merged counts the raw steps
 * folded into others.
 */
function segment(steps) {
    const out = [];
    let merged = 0;
    for (const step of Array.isArray(steps) ? steps : []) {
        if (!step || !step.args) continue;
        const last = out[out.length - 1];
        // Scrolling one way: one step.
        if (isScroll(step) && last && isScroll(last) && down(step) === down(last)) {
            last.times = (last.times || 1) + 1;
            last.text = `You scrolled ${down(step) ? 'down' : 'up'} (${last.times} times)`;
            merged++;
            continue;
        }
        // Backspaces right after typing: they correct it, they are not a step of their own.
        if (isBackspace(step) && last && isType(last)) {
            last.erase = (last.erase || 0) + 1;
            if (kept(last) != null) last.args = { ...last.args, text: kept(last).slice(0, Math.max(0, kept(last).length - 1)), chars: Math.max(0, (last.args.chars || 0) - 1) };
            merged++;
            continue;
        }
        // Typing again after a correction: the same field, one text.
        if (isType(step) && last && isType(last) && last.erase) {
            const privateText = Boolean(last.args.private || step.args.private);
            const text = privateText ? null : `${kept(last) || ''}${kept(step) || ''}`;
            const chars = (last.args.chars || 0) + (step.args.chars || 0);
            last.args = { ...last.args, private: privateText, text, chars };
            last.text = privateText ? `You typed ${chars} private characters` : `You typed ${chars} character${chars === 1 ? '' : 's'}`;
            delete last.erase;
            merged++;
            continue;
        }
        // The same click twice in a row: once.
        if (isClick(step) && last && isClick(last) && sameSpot(step, last)) { merged++; continue; }
        out.push({ ...step, args: { ...step.args } });
    }
    for (const x of out) delete x.erase;
    return { actions: out, merged };
}

module.exports = { segment, SAME_SPOT_PX };

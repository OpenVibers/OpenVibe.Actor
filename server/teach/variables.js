'use strict';
/**
 * What changes each time (Teach, plan §AD.33): the details a person typed that the next run will need anew (a search, an
 * email, a date, a message), found in the demonstration and named, so the skill asks for {search} instead of copying
 * "running shoes" into every run, and so a practice run has the person's own example to try it with. Pure.
 *
 * Private text (recorder.js: password-shaped or marked private) never becomes an input: the skill hands that step to
 * the person.
 */
const KINDS = [
    ['email', /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i],
    ['link', /^(https?:\/\/|www\.)\S+$/i],
    ['date', /^(\d{4}-\d{2}-\d{2}|\d{1,2}[/.-]\d{1,2}([/.-]\d{2,4})?|today|tomorrow|yesterday|(mon|tues|wednes|thurs|fri|satur|sun)day)$/i],
    ['amount', /^[$€£¥]?\s?\d+([.,]\d{1,2})?\s?(usd|eur|gbp|dollars?|euros?)?$/i],
    ['number', /^\d+$/],
];
const MAX_INPUTS = 8;

/** The kind of one typed text. */
function kindOf(text, next) {
    const t = String(text || '').trim();
    for (const [kind, re] of KINDS) if (re.test(t)) return kind;
    // Typed, then Enter: what one searches for.
    if (next && next.args && next.args.action === 'key' && /^(Return|Enter)$/.test(String(next.args.keys || '')) && t.length <= 120) return 'search';
    if (t.split(/\s+/).length >= 6) return 'message';
    return 'detail';
}

/**
 * actions: segment().actions → [{ name, kind, example, seq }], each name unique ({search}, {search_2}, …).
 */
function inputsOf(actions) {
    const list = Array.isArray(actions) ? actions : [];
    const out = [];
    const used = new Map();
    for (let i = 0; i < list.length && out.length < MAX_INPUTS; i++) {
        const a = list[i];
        if (!a || !a.args || a.args.action !== 'type' || a.args.private || typeof a.args.text !== 'string') continue;
        const example = a.args.text.trim();
        if (!example) continue;
        const kind = kindOf(example, list[i + 1]);
        const n = (used.get(kind) || 0) + 1;
        used.set(kind, n);
        out.push({ name: n === 1 ? kind : `${kind}_${n}`, kind, example: example.slice(0, 300), seq: a.seq });
    }
    return out;
}

/** The inputs as lines a model reads: what to turn into placeholders, with the person's example. */
function inputLines(inputs) {
    return (inputs || []).map((x) => `{${x.name}}: ${x.kind === 'detail' ? 'a detail' : `a ${x.kind}`} (they typed "${String(x.example).replace(/"/g, '\'').slice(0, 120)}" at step seq ${x.seq})`).join('\n');
}

module.exports = { inputsOf, inputLines, kindOf, MAX_INPUTS };

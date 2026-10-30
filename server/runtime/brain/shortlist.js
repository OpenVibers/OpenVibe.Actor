'use strict';

/**
 * The shortlist (Actor v2, stage V2-11): when a run is offered more than about 40 tools, the model sees the ones
 * that fit the step instead of all of them.
 *
 * The similarity is a local hashed embedding, never an LLM picker and never a model call: the tool's name and
 * description and the step's goal become fixed-size vectors of hashed word counts, and the tools are ranked by
 * cosine similarity. Equal scores keep the registry's order, so the list is stable from step to step.
 */

const DIM = 256;
const LIMIT = 40;

const words = (text) => String(text == null ? "" : text).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);

/** FNV-1a: a small, stable hash of one word. */
function hash(word) {
    let h = 0x811c9dc5;
    for (let i = 0; i < word.length; i++) {
        h ^= word.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h >>> 0;
}

/** The text of one tool: its name and its description. */
function toolText(def) {
    const f = (def && def.function) || {};
    return String(f.name || "") + " " + String(f.description || "");
}

/** The step the run is in: the active plan goal and the last thing the person asked. */
function goalOf(state) {
    const steps = (state && state.plan && Array.isArray(state.plan.steps)) ? state.plan.steps : [];
    const active = steps.find((s) => s && s.state === "active") || steps[0] || null;
    const goal = active ? String(active.goal || "") : "";
    const messages = (state && Array.isArray(state.messages)) ? state.messages : [];
    let last = "";
    for (const m of messages) {
        if (m && m.role === "user" && typeof m.content === "string") last = m.content;
    }
    return (goal + " " + last).trim();
}

/** The vector of one text: hashed word counts, normalized. */
function embed(text) {
    const v = new Float64Array(DIM);
    for (const w of words(text)) {
        const h = hash(w);
        v[h % DIM] += 1;
        v[(h >>> 9) % DIM] += 0.5;
    }
    let norm = 0;
    for (let i = 0; i < DIM; i++) norm += v[i] * v[i];
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < DIM; i++) v[i] /= norm;
    return v;
}

/** The cosine of two vectors. */
function cosine(a, b) {
    let s = 0;
    for (let i = 0; i < DIM; i++) s += a[i] * b[i];
    return s;
}

/**
 * The tools the model sees this step. Below the limit every tool is offered; above it the best-fitting ones are,
 * and the delegate is always kept (a run that has it may use it).
 */
function shortlistTools(defs, state, limit = LIMIT) {
    const list = Array.isArray(defs) ? defs.filter(Boolean) : [];
    if (list.length <= limit) return list;
    const goal = embed(goalOf(state));
    const scored = list.map((def, i) => ({ def, i, score: cosine(embed(toolText(def)), goal) }));
    scored.sort((a, b) => (b.score - a.score) || (a.i - b.i));
    const keep = scored.slice(0, limit).map((s) => s.def);
    const delegate = list.find((d) => d && d.function && d.function.name === "delegate");
    if (delegate && !keep.includes(delegate)) keep.push(delegate);
    return keep;
}

module.exports = { shortlistTools, embed, cosine, goalOf, toolText, LIMIT, DIM };

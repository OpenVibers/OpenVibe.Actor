'use strict';

/**
 * Context editing (plan §AD.26; the owner sent Claude Code's and Anthropic's context-editing notes on 2026-11-17:
 * "Analyze and use to improve openvibe"). Every model call of a run sends the whole conversation again, and each tool
 * result may be 6000 characters: a twenty-step run sent about 120,000 characters (some 30,000 tokens) on every call.
 *
 * Once the conversation passes `triggerChars`, the model is sent a view in which the tool results older than the most
 * recent `keepRecent` are cut to their first `excerptChars` characters, with a note that the whole result is kept as its
 * evidence (it can still be cited by its E#, and the tool called again for the rest). The run's own messages are never
 * changed: the evidence, the reflection and the answer's citations all read the run's store, not this view.
 *
 *   contextView(messages, { keepRecent = 8, triggerChars = 60000, excerptChars = 300 })
 *       → { messages, cleared, savedChars }   (the same array when nothing is cut)
 */
const DEFAULTS = Object.freeze({ keepRecent: 8, triggerChars: 60000, excerptChars: 300 });

const sizeOf = (m) => (typeof m.content === 'string' ? m.content.length : m.content ? JSON.stringify(m.content).length : 0);

function cut(content, excerptChars) {
    let doc;
    try { doc = JSON.parse(content); } catch { return null; }
    if (!doc || typeof doc !== 'object' || Array.isArray(doc) || typeof doc.result !== 'string' || doc.cleared) return null;
    const full = doc.result;
    if (full.length <= excerptChars + 200) return null;
    const ev = typeof doc.evidence === 'string' ? doc.evidence : null;
    const note = `[cut to save room: ${full.length} characters${ev ? `; ${ev} keeps all of it and can be cited` : ''}; call the tool again for the rest]`;
    return JSON.stringify({ ...doc, result: `${full.slice(0, excerptChars)}… ${note}`, cleared: true });
}

function contextView(messages, opts = {}) {
    const o = { ...DEFAULTS, ...Object.fromEntries(Object.entries(opts).filter(([, v]) => v != null)) };
    const list = Array.isArray(messages) ? messages : [];
    if (!(o.triggerChars > 0) || !(o.keepRecent >= 0)) return { messages: list, cleared: 0, savedChars: 0 };
    const total = list.reduce((n, m) => n + (m ? sizeOf(m) : 0), 0);
    if (total <= o.triggerChars) return { messages: list, cleared: 0, savedChars: 0 };
    const tools = [];
    list.forEach((m, i) => { if (m && m.role === 'tool' && typeof m.content === 'string') tools.push(i); });
    const older = new Set(tools.slice(0, Math.max(0, tools.length - o.keepRecent)));
    if (!older.size) return { messages: list, cleared: 0, savedChars: 0 };
    let cleared = 0, savedChars = 0;
    const out = list.map((m, i) => {
        if (!older.has(i)) return m;
        const c = cut(m.content, o.excerptChars);
        if (c == null) return m;
        cleared += 1;
        savedChars += m.content.length - c.length;
        return { ...m, content: c };
    });
    return cleared ? { messages: out, cleared, savedChars } : { messages: list, cleared: 0, savedChars: 0 };
}

module.exports = { contextView, DEFAULTS };

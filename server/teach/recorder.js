'use strict';

/**
 * The person's own steps on a task's desk (Teach a task, plan §AD.33).
 *
 * Every input a person sends while they drive a task's desk (Take over, or a teach session's "Show it") is one step of
 * the task's timeline: "You clicked", "You typed 12 characters", "You pressed Enter". A click keeps the picture they
 * clicked on (the still at that event's seq), so a vision model can later read which button it was. Typed characters
 * arrive one request each; they are gathered into one step when something else happens or the typing stops.
 *
 * What a person typed is kept only in a teach session (that is what they are showing), never on another task's desk
 * (a sign-in there is the usual reason to take over). Even in a teach session, a run of typing that looks like a
 * password (no spaces, letters with digits or symbols) or that the person marked private is kept as "private text",
 * and every typed text is wiped from the task's record (forget) once the skill was written from it.
 */
const store = require('../tasks/store');
const stills = require('../tasks/stills');

const TYPE_FLUSH_MS = 4000;
const TYPE_MAX = 2000;
const KEY_WORDS = { Return: 'Enter', BackSpace: 'Backspace', Tab: 'Tab', Escape: 'Escape', Up: 'the up arrow', Down: 'the down arrow', Left: 'the left arrow', Right: 'the right arrow', Delete: 'Delete', space: 'Space' };

// taskId → { text, count, private, keep, timer, flushing }
const typing = new Map();

/** A run of typing that may be a password, a code or an address: kept as private text, never as words. */
function looksSecret(text) {
    const t = String(text || '');
    if (/\s/.test(t) || t.length < 6) return false;
    const letters = /[A-Za-z]/.test(t);
    const digits = /[0-9]/.test(t);
    const symbols = /[^A-Za-z0-9]/.test(t);
    return letters && (digits || symbols);
}

const clampInt = (v, lo, hi) => (Number.isFinite(Number(v)) ? Math.max(lo, Math.min(hi, Math.round(Number(v)))) : null);

/** One input as a step: { text, args } or null for an input that is not a step (an empty key). */
function stepOf(value) {
    const action = String((value && value.action) || '');
    const size = { width: clampInt(value.width, 1, 10000), height: clampInt(value.height, 1, 10000) };
    if (action === 'click' || action === 'right_click' || action === 'double_click') {
        const x = clampInt(value.x, 0, 10000);
        const y = clampInt(value.y, 0, 10000);
        if (x == null || y == null) return null;
        const word = action === 'right_click' ? 'You right-clicked' : action === 'double_click' ? 'You double-clicked' : 'You clicked';
        return { text: word, args: { action, x, y, ...size } };
    }
    if (action === 'scroll') {
        const dy = Number(value.dy) || 0;
        return { text: dy < 0 ? 'You scrolled up' : 'You scrolled down', args: { action, dy: clampInt(dy, -50, 50), x: clampInt(value.x, 0, 10000), y: clampInt(value.y, 0, 10000), ...size } };
    }
    if (action === 'key') {
        const keys = String(value.keys || '').slice(0, 40);
        if (!keys) return null;
        return { text: `You pressed ${KEY_WORDS[keys] || keys}`, args: { action, keys } };
    }
    return null;
}

/** Write the gathered typing of one task as one step. */
async function flush(s, taskId) {
    const t = typing.get(taskId);
    if (!t) return null;
    typing.delete(taskId);
    if (t.timer) clearTimeout(t.timer);
    if (!t.count) return null;
    const secret = t.private || looksSecret(t.text);
    const kept = t.keep && !secret ? t.text : null;
    const text = secret ? `You typed ${t.count} private character${t.count === 1 ? '' : 's'}` : `You typed ${t.count} character${t.count === 1 ? '' : 's'}`;
    return store.appendEvent(s, taskId, { at: s.iso(), kind: 'output', step: 'person', text, args: { action: 'type', chars: t.count, private: secret, text: kept } });
}

/**
 * Note one input the person sent to a task's desk.
 *   keep       a teach session: what they typed is kept (unless private) for the skill
 *   private    the person marked this typing private
 *   grab()     → { data, format, width?, height? } | null: the picture they clicked on
 * → the step's event, or null (typing is gathered; it becomes a step later).
 */
async function record(s, taskId, value, { keep = false, private: secret = false, grab = null, log = console } = {}) {
    if (!s || !taskId || !value || typeof value !== 'object') return null;
    if (value.action === 'type') {
        const ch = typeof value.text === 'string' ? value.text : '';
        if (!ch) return null;
        const t = typing.get(taskId) || { text: '', count: 0, private: false, keep, timer: null };
        t.count += [...ch].length;
        if (t.text.length < TYPE_MAX) t.text += ch;
        t.private = t.private || Boolean(secret);
        t.keep = t.keep || keep;
        if (t.timer) clearTimeout(t.timer);
        t.timer = setTimeout(() => { flush(s, taskId).catch((err) => log.warn && log.warn('[Actor] teach: typing not recorded:', err && err.message)); }, TYPE_FLUSH_MS);
        if (t.timer.unref) t.timer.unref();
        typing.set(taskId, t);
        return null;
    }
    const step = stepOf(value);
    if (!step) return null;
    await flush(s, taskId);
    // The picture first: it is what they saw when they clicked, before the click changed it.
    let shot = null;
    if (grab && /click/.test(step.args.action)) {
        try { shot = await grab(); } catch { shot = null; }
    }
    const event = await store.appendEvent(s, taskId, { at: s.iso(), kind: 'output', step: 'person', text: step.text, args: step.args });
    if (shot && event && event.seq) await stills.save(s, taskId, event.seq, { ...shot, tool: 'person' }).catch(() => false);
    return event;
}

/** The person's steps of one task after a seq, with their args and whether a picture was kept. */
async function steps(s, taskId, { after = 0 } = {}) {
    await flush(s, taskId);
    const events = await store.eventsDetailed(s, taskId, after);
    const pictures = new Set((await stills.list(s, taskId)).filter((p) => p.tool === 'person').map((p) => Number(p.seq)));
    return events.filter((e) => e && e.step === 'person').map((e) => ({
        seq: Number(e.seq), at: e.at, text: e.text, args: e.args || {}, picture: pictures.has(Number(e.seq)),
    }));
}

/** Wipe what the person typed from a task's record: the skill was written from it, and nothing else may keep it. */
async function forget(s, taskId) {
    typing.delete(taskId);
    await s.db.query(`UPDATE task_events SET ui_detail = jsonb_set(ui_detail, '{args,text}', 'null'::jsonb)
        WHERE task_id = $1 AND body->>'step' = 'person' AND ui_detail->'args'->>'text' IS NOT NULL`, [taskId]);
}

/** How many steps the person took on a task's desk after a seq (typing not yet gathered counts as one). */
async function count(s, taskId, { after = 0 } = {}) {
    const n = Number(await s.db.value("SELECT count(*)::int FROM task_events WHERE task_id = $1 AND seq > $2 AND body->>'step' = 'person'", [taskId, after]));
    return n + (typing.has(taskId) ? 1 : 0);
}

/** Pending typing, for a test or a restart: whether a task has typing not yet written. */
const pending = (taskId) => typing.has(taskId);

module.exports = { record, flush, steps, count, forget, looksSecret, stepOf, pending, TYPE_FLUSH_MS };

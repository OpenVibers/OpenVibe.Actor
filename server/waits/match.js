'use strict';

/**
 * The matcher: does this event wake this wait?
 *
 * A wait says three things: the topic pattern it wants (the same patterns OpenVibe.Events uses: a dot-separated
 * list of literal segments and `*`, where `*` stands for ONE OR MORE whole segments), a filter of paths and
 * values, and the earliest event it may match.
 *
 * The filter is a matcher, not a query: a path (`payload.a.b`, `subject.id`, `actor.id`, `trace_id`,
 * `on_behalf_of.id`) and the value the event must carry there. A list of values means one of them. The paths are
 * read from the envelope as Events delivered it; nothing is evaluated, nothing is fetched.
 */
const PATTERN_RE = /^(\*|[a-z0-9_]+)(\.(\*|[a-z0-9_]+))*$/;

/** A valid topic pattern (the same rule as Events: no `.*.`, at most 200 characters). */
function isValidPattern(pattern) {
    return typeof pattern === 'string' && pattern.length > 0 && pattern.length <= 200 && PATTERN_RE.test(pattern) && !pattern.includes('*.*');
}

/** Does an event type match a topic pattern? */
function topicMatches(pattern, eventType) {
    if (!isValidPattern(pattern)) return false;
    const body = pattern.split('.').map((seg) => (seg === '*' ? '[a-z0-9_]+(?:\\.[a-z0-9_]+)*' : seg)).join('\\.');
    return new RegExp('^' + body + '$').test(String(eventType || ''));
}

/** The value at a path in an event, or undefined. Only these paths are read. */
function valueAt(event, path) {
    const ev = event || {};
    const parts = String(path || '').split('.').filter(Boolean);
    if (!parts.length) return undefined;
    const head = parts[0];
    let node;
    if (head === 'payload') node = ev.payload;
    else if (head === 'subject') node = ev.subject;
    else if (head === 'actor') node = ev.actor;
    else if (head === 'on_behalf_of') node = ev.on_behalf_of;
    else if (parts.length === 1 && (head === 'trace_id' || head === 'event_id' || head === 'event_type' || head === 'at' || head === 'visibility')) return ev[head];
    else return undefined;
    if (node == null) return undefined;
    let cur = node;
    for (const p of parts.slice(1)) {
        if (cur == null || typeof cur !== 'object') return undefined;
        cur = cur[p];
    }
    return cur === undefined ? undefined : cur;
}

/** Does the event carry the value (or one of the values) the filter wants at that path? */
function clauseMatches(event, path, want) {
    const got = valueAt(event, path);
    if (got === undefined) return false;
    if (Array.isArray(want)) return want.some((v) => same(v, got));
    return same(want, got);
}

function same(a, b) {
    if (a === b) return true;
    if (typeof a === 'number' && typeof b === 'number') return a === b;
    if (typeof a === 'string' && typeof b === 'number') return String(a) === String(b);
    if (typeof a === 'number' && typeof b === 'string') return String(a) === String(b);
    return false;
}

/** The subject id of the person a wait belongs to (`user:usr_…` → `usr_…`). */
function personId(requester) {
    const s = String(requester || '');
    const i = s.indexOf(':');
    return i < 0 ? s : s.slice(i + 1);
}

/**
 * Does the event match the wait? The checks run in this order, and each says why it said no:
 *   topic      the event type is one the wait asked for
 *   from       the event is not older than the wait (a slow cursor must not wake a wait with the past)
 *   filter     every clause of the matcher holds
 *   scope      the event is about the wait's own person
 */
function matches(wait, event) {
    const until = (wait && wait.until) || {};
    const filter = (wait && wait.filter) || {};
    const type = String((event && event.event_type) || '');
    if (!topicMatches(until.topic, type)) return { ok: false, why: 'topic' };
    if (until.from) {
        const at = Date.parse(String((event && event.at) || ''));
        const from = Date.parse(String(until.from));
        if (Number.isFinite(at) && Number.isFinite(from) && at < from) return { ok: false, why: 'from' };
    }
    // The scope first: an event about another person never wakes this wait. An event whose subject is a job or a
    // service says nothing about a person, so the filter carries the person's id instead.
    const me = personId(wait.requester);
    const subject = event && event.subject;
    if (subject && subject.type === 'user' && subject.id && me && subject.id !== me) return { ok: false, why: 'scope' };
    const behalf = event && event.on_behalf_of;
    if (behalf && behalf.type === 'user' && behalf.id && me && behalf.id !== me) return { ok: false, why: 'scope' };
    for (const [path, want] of Object.entries(filter)) {
        if (!clauseMatches(event, path, want)) return { ok: false, why: 'filter' };
    }
    return { ok: true, why: null };
}

module.exports = { isValidPattern, topicMatches, valueAt, clauseMatches, matches, personId };

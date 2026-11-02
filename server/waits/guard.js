'use strict';

/**
 * The loop guard (plan A2): an event the agent caused never wakes the agent's own wait, and each event is used
 * once.
 *
 *   skip:self   the event carries the run's own trace id — the wait's own action, coming back
 *   skip:spent  the event id was already spent (the receipt in server/waits/store.js)
 *   skip:scope  the event is about somebody else
 *
 * A wait may say it wants its own events (`self_events`): the agent that started a Codes task and then waits for
 * that task to end wants exactly that event.
 */
const { matches, personId } = require('./match');

/** The event carries the run's own trace: the wait's own action, coming back to the wait that caused it. */
function selfCaused(wait, event) {
    if (!wait || !event) return false;
    if (wait.self_events === true) return false;
    const mine = String(wait.trace_id || '');
    const theirs = String((event && event.trace_id) || '');
    if (!mine || !theirs) return false;
    return mine === theirs;
}

/**
 * The guard, with the receipt: an event id is spent once, so two deliveries of one event wake one wait once.
 * The receipt insert is the decision — no row back means the event was already used.
 */
async function guard(s, wait, event) {
    if (!wait || !event) return { ok: false, why: 'no-wait' };
    if (selfCaused(wait, event)) return { ok: false, why: 'skip:self' };
    const m = matches(wait, event);
    if (!m.ok) return { ok: false, why: m.why };
    // The scope again, on the receipt's terms: an event about another person is never this wait's.
    const me = personId(wait.requester);
    const subject = event.subject;
    if (subject && subject.type === 'user' && subject.id && me && subject.id !== me) return { ok: false, why: 'skip:scope' };
    const spent = await s.db.maybe(
        'INSERT INTO actor_wait_events (event_id, wait_id, event_type, at) VALUES ($1, $2, $3, $4) ON CONFLICT (event_id) DO NOTHING RETURNING event_id',
        [String(event.event_id || ''), wait.id, String(event.event_type || ''), new Date(s.now()).toISOString()],
    );
    if (!spent) return { ok: false, why: 'skip:spent' };
    return { ok: true, why: null };
}

module.exports = { guard, selfCaused };

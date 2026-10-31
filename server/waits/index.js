'use strict';

/**
 * Waits (plan A2, Watch mode): a wait is a record, not a running loop.
 *
 * While a task waits, no model runs, its desk is released and its budget clock stops. The task keeps its place
 * (its checkpoint) and its budget; what it loses is time: the wall clock waits with it, and the person sees one
 * quiet line.
 *
 * The three ways a wait ends, and only these three:
 *   woken      a matching event arrived (server/waits/guard.js: the loop guard and the receipt)
 *   timed_out  the deadline fired (server/waits/deadlines.js: once, whatever the process count)
 *   cancelled  the person said so
 *
 * What wakes it is never allowed to widen it. The event's payload is untrusted input: it is matched, it is
 * marked, it is cut to size, and it reaches the model as data — never as an instruction, never as a change to
 * the task's budget, tools or permissions.
 */
const store = require('./store');
const { guard } = require('./guard');
const { topicMatches, personId, isValidPattern } = require('./match');
const { limits } = require('./limits');

/** The sources a wait may name in A2a: a Codes task, a Run job, or just time. */
const SOURCES = {
    codes: { topic: 'codes.task.*', states: ['succeeded', 'failed', 'cancelled'] },
    run: { topic: 'run.job.*', states: ['succeeded', 'failed', 'cancelled', 'expired'] },
    time: { topic: null, states: [] },
};

const REPO_RE = /^[^/\s]+\/[^/\s]+$/;
const JOB_RE = /^job_[0-9A-HJKMNP-TV-Z]{26}$/;

function createWaits({ s, config, log = console, now = () => Date.now(), events = null, engine = null }) {
    const L = limits(config);
    const iso = (ms) => new Date(ms).toISOString();
    const personOf = (requester) => {
        const r = String(requester || '');
        const i = r.indexOf(':');
        return i < 0 ? r : r.slice(i + 1);
    };

    /** The distinct topic patterns the open waits want: one subscription and one cursor each. */
    async function topics() {
        const rows = await store.openWaits(s);
        const set = new Set();
        for (const w of rows) {
            const t = w.until && w.until.topic;
            if (t) set.add(t);
        }
        return [...set];
    }

    /** One subscription per topic pattern, at Events, if it is not there yet. */
    async function ensureSubscription(topic) {
        if (!events || !events.enabled || !isValidPattern(topic)) return false;
        try {
            await events.subscribe(topic);
            return true;
        } catch (err) {
            log.warn && log.warn('[Actor waits] subscription failed:', topic, (err && err.message) || err);
            return false;
        }
    }

    /**
     * A new wait. The tool that asks for it never names the task, the person or the budget: they come from the
     * run that asked (server/runtime/tools/wait_for.js).
     */
    async function create({ taskId, requester, source, target = null, seconds = 900, onTimeout = 'ask', line = null, traceId = null, step = null, selfEvents = false }) {
        const src = SOURCES[source];
        if (!src) throw Object.assign(new Error(`unknown source "${source}"`), { code: 'actor.wait.source' });
        const ms = Math.max(60_000, Math.min(Number(seconds) * 1000 || 0, L.deadlineMs));
        const deadlineAt = iso(now() + ms);
        const me = personOf(requester);
        const until = {};
        const filter = {};
        if (src.topic) {
            until.topic = src.topic;
            until.from = iso(now());
            filter['payload.state'] = src.states;
        } else {
            until.at = deadlineAt;
        }
        if (source === 'codes') {
            const repo = String(target || '').trim();
            if (!REPO_RE.test(repo)) throw Object.assign(new Error('a Codes wait names the repository as owner/name'), { code: 'actor.wait.target' });
            filter['payload.repo'] = repo;
            filter['subject.id'] = me;
        } else if (source === 'run') {
            const job = String(target || '').trim();
            if (!JOB_RE.test(job)) throw Object.assign(new Error('a Run wait names the job id'), { code: 'actor.wait.target' });
            filter['payload.job_id'] = job;
            filter['payload.requester.id'] = me;
        }
        // The bounds: a person may not keep a hundred subscriptions, and a task may not wait on a hundred things.
        const openForPerson = await store.countOpen(s, requester);
        if (openForPerson >= L.perPerson) throw Object.assign(new Error('you already have enough waits open'), { code: 'actor.wait.limit' });
        const openForTask = await store.countOpenTask(s, taskId);
        if (openForTask >= L.perTask) throw Object.assign(new Error('this task is already waiting for something'), { code: 'actor.wait.limit' });
        const forTask = await store.countTask(s, taskId);
        if (forTask >= L.perTaskLifetime) throw Object.assign(new Error('this task has waited enough times'), { code: 'actor.wait.limit' });
        const clauses = Object.keys(filter).length;
        if (clauses > L.filterClauses) throw Object.assign(new Error('the wait needs too many conditions'), { code: 'actor.wait.limit' });
        const text = String(line || defaultLine(source, target)).replace(/\s+/g, ' ').trim().slice(0, L.lineChars);
        if (!text) throw Object.assign(new Error('a wait needs a line the person can read'), { code: 'actor.wait.line' });
        const row = await store.createWait(s, {
            taskId, requester, kind: src.topic ? 'event' : 'time', until, filter, deadlineAt,
            onTimeout: ['ask', 'retry', 'fail'].includes(onTimeout) ? onTimeout : 'ask',
            line: text, traceId, step, at: iso(now()),
        });
        if (src.topic) await ensureSubscription(src.topic);
        return row;
    }

    function defaultLine(source, target) {
        if (source === 'codes') return `waiting for your Codes task on ${target} to finish`;
        if (source === 'run') return `waiting for your run ${target} to finish`;
        return 'waiting for a while';
    }

    /** The wait woke: the row changes once, and the task goes back to the queue. */
    async function wake(wait, wokenBy, { notice = null, event = null } = {}) {
        const row = await store.markWoken(s, wait.id, wokenBy);
        if (!row) return null;      // another delivery already woke it
        if (engine && typeof engine.resumeWithEvent === 'function') {
            // The event's payload goes to the run as untrusted data (the loop marks it); the row keeps only the
            // event's name and id, never its body.
            const payload = event && event.payload ? { event_id: String(event.event_id || ''), event_type: String(event.event_type || ''), at: String(event.at || ''), payload: event.payload } : null;
            await engine.resumeWithEvent(wait.task_id, { event: payload, notice: notice || `The wait is over: ${wait.line}.` });
        }
        return row;
    }

    /** An event arrived: the waits it matches are woken, each event used once. */
    async function onEvent(event) {
        if (!event || !event.event_type) return 'ignored:type';
        const rows = await store.openWaits(s);
        let woken = 0;
        for (const w of rows) {
            const until = w.until || {};
            if (!until.topic || !topicMatches(until.topic, event.event_type)) continue;
            const g = await guard(s, w, event);
            if (!g.ok) continue;
            const row = await wake(w, {
                event_id: String(event.event_id || ''),
                event_type: String(event.event_type || ''),
                at: String(event.at || iso(now())),
                by: 'event',
            }, { notice: `The wait is over: ${w.line}.`, event });
            if (row) woken += 1;
        }
        return woken ? `woken:${woken}` : 'ignored:no-match';
    }

    /** The person says stop: the wait ends, the task carries on without it. */
    async function cancel(id, by = null) {
        const row = await store.cancelWait(s, id);
        if (!row) return null;
        if (engine && typeof engine.resumeWithNotice === 'function') {
            await engine.resumeWithNotice(row.task_id, `The person cancelled the wait: ${row.line}. Continue without it.`);
        }
        return row;
    }

    /** "Wake now" with no event: the step continues, and the model checks for itself. */
    async function wakeByPerson(id, by = null) {
        const w = await store.getWait(s, id);
        if (!w || w.status !== 'waiting') return null;
        const row = await store.markWoken(s, id, { at: iso(now()), by: 'person' });
        if (!row) return null;
        if (engine && typeof engine.resumeWithEvent === 'function') {
            await engine.resumeWithEvent(row.task_id, { event: null, notice: 'The person woke this task: the wait is over with no event. Check the state yourself (for example read the task status) before you answer.' });
        }
        return row;
    }

    /** The recovery path: the topics with open waits, read from the stored cursor. */
    async function sweep() {
        if (!events || !events.enabled) return 0;
        let seen = 0;
        for (const topic of await topics()) {
            const cur = await store.getCursor(s, topic);
            let page;
            try {
                page = await events.read(topic, cur && cur.cursor, 100);
            } catch (err) {
                log.warn && log.warn('[Actor waits] sweep failed:', topic, (err && err.message) || err);
                continue;
            }
            for (const row of page.events || []) {
                const ev = row && row.event ? row.event : row;
                if (!ev) continue;
                seen += 1;
                await onEvent(ev);
            }
            if (page.next_cursor) await store.setCursor(s, topic, page.next_cursor);
        }
        return seen;
    }

    /**
     * The deadline. It fires once: the row's status changes in one UPDATE, so two Actor processes running the
     * same loop do the work once between them.
     */
    async function runDeadlines() {
        const rows = await s.db.many(
            "SELECT * FROM actor_waits WHERE status = 'waiting' AND deadline_at <= $1 ORDER BY deadline_at LIMIT 50",
            [iso(now())],
        );
        let fired = 0;
        for (const w of rows) {
            const row = await store.markTimedOut(s, w.id, 'the deadline');
            if (!row) continue;      // it already fired
            fired += 1;
            if (!engine) continue;
            if (w.on_timeout === 'fail') {
                await engine.failTask(w.task_id, 'actor.wait.timeout', `The wait for "${w.line}" timed out.`);
                continue;
            }
            if (w.on_timeout === 'retry') {
                const retried = await store.bumpRetry(s, w.id);
                if (retried && Number(retried.retries) <= 1) {
                    await engine.resumeWithNotice(w.task_id, `The wait for "${w.line}" timed out. Try that step again.`);
                    continue;
                }
            }
            // 'ask': the person is told and the run continues; the model may ask them the usual way.
            if (typeof engine.notifyWaitTimeout === 'function') await engine.notifyWaitTimeout(w);
            await engine.resumeWithNotice(w.task_id, `The wait for "${w.line}" timed out. Tell the person what is missing, or finish with what you have.`);
        }
        return fired;
    }

    /** The wall clock the task had left when it parked (milliseconds), or null when it never parked. */
    async function remaining(taskId) {
        const rows = await store.openWaitsForTask(s, taskId);
        const w = rows[0];
        return w && w.remaining_ms != null ? Number(w.remaining_ms) : null;
    }

    /** The wall clock the task had left when it parked: the wait was not its time to spend. */
    async function setRemaining(waitId, ms) {
        return s.db.query('UPDATE actor_waits SET remaining_ms = $2, updated_at = $3 WHERE id = $1',
            [waitId, Math.max(0, Math.round(Number(ms) || 0)), iso(now())]);
    }

    /** Does this task hold a wait? A waiting task is not an interrupted one. */
    async function hasOpenWait(taskId) {
        const rows = await store.openWaitsForTask(s, taskId);
        return rows.length > 0;
    }

    return {
        limits: L, create, get: (id) => store.getWait(s, id), listForTask: (taskId) => store.waitsForTask(s, taskId),
        listOpen: () => store.openWaits(s), topics, ensureSubscription, onEvent, cancel, wakeByPerson, sweep, runDeadlines,
        remaining, setRemaining, hasOpenWait,
    };
}

module.exports = { createWaits, SOURCES };

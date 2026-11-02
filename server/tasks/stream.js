'use strict';

/**
 * Live task streams: GET /api/v1/tasks/:id/events is text/event-stream of actor.task-event@2. A reader first gets
 * every stored event after its Last-Event-ID (or ?after=), then each new one as the engine publishes it; the stream
 * closes after the `end` event. Events are stored before they are published (tasks/store.js appendEvent), and a reader
 * subscribes before reading its backlog, so nothing falls between the two; a seq it already has is never sent twice.
 * Events published while the backlog is still being read wait until the backlog is written (sending one first would
 * mark every older seq as already sent: a reader got only the `end` event, seq 9, on PostgreSQL in CI), and an `end`
 * that comes meanwhile closes the stream only after the backlog.
 * The stream is best-effort; the task record is the truth.
 *
 * The answer as it is written (plan L55 C2): a reader that asks with ?deltas=1 also gets `delta` events,
 * { text, n }: the next piece of the text the model is writing in its n-th call of the run. They are not stored and
 * carry no id (so Last-Event-ID and the backlog are unchanged), go only to a reader whose backlog is out, and are
 * gathered for DELTA_MS so a fast model sends a few events a second, not one per token. A stored event flushes the
 * gathered text first, so a reader sees them in the order they happened. The stored `output` text event, or the
 * finished task, is still the answer.
 */

const HEARTBEAT_MS = 15_000;
const DELTA_MS = 60;

function createTaskStream({ log = console } = {}) {
    const subs = new Map();     // task id → Set<{ res, last }>
    const gathered = new Map(); // task id → { text, n, timer }: delta text not yet sent

    function send(sub, event) {
        if (event.seq <= sub.last) return;
        sub.last = event.seq;
        try { sub.res.write(`id: ${event.seq}\nevent: ${event.kind}\ndata: ${JSON.stringify(event)}\n\n`); } catch (err) { log.warn('[Actor] stream write failed:', err && err.message); }
    }

    // A reader still reading its backlog keeps live events aside; serve() sends them, in seq order, after the backlog.
    function write(sub, event) {
        if (sub.ready) send(sub, event);
        else sub.pending.push(event);
    }

    function publish(taskId, event) {
        flush(taskId);
        for (const sub of subs.get(taskId) || []) write(sub, event);
    }

    function flush(taskId) {
        const g = gathered.get(taskId);
        if (!g) return;
        gathered.delete(taskId);
        clearTimeout(g.timer);
        if (!g.text) return;
        const line = `event: delta\ndata: ${JSON.stringify({ text: g.text, n: g.n })}\n\n`;
        for (const sub of subs.get(taskId) || []) {
            if (!sub.deltas || !sub.ready) continue;
            try { sub.res.write(line); } catch (err) { log.warn('[Actor] stream write failed:', err && err.message); }
        }
    }

    /** The next piece of the answer being written (not stored). n: the run's model call it belongs to. */
    function delta(taskId, { text, n = 0 } = {}) {
        if (!text) return;
        if (!wants(taskId)) return;
        let g = gathered.get(taskId);
        if (g && g.n !== n) { flush(taskId); g = null; }
        if (!g) {
            g = { text: '', n, timer: setTimeout(() => flush(taskId), DELTA_MS) };
            if (g.timer.unref) g.timer.unref();
            gathered.set(taskId, g);
        }
        g.text += String(text);
    }

    /** Whether a reader of this task asked for the answer as it is written (the loop streams only then). */
    function wants(taskId) {
        return [...(subs.get(taskId) || [])].some((sub) => sub.deltas);
    }

    function end(taskId) {
        const g = gathered.get(taskId);
        if (g) { clearTimeout(g.timer); gathered.delete(taskId); }
        const set = subs.get(taskId);
        subs.delete(taskId);
        for (const sub of set || []) {
            if (!sub.ready) { sub.ended = true; continue; }   // serve() closes it once its backlog is out
            try { sub.res.end(); } catch { /* gone */ }
        }
    }

    /**
     * Serve one reader. readBacklog() → stored events after `after`; isEnded() → whether the task has ended (read after
     * the backlog, so an end that happened meanwhile closes the stream).
     */
    async function serve(req, res, { taskId, after = 0, readBacklog, isEnded, deltas = false }) {
        res.status(200).set({ 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
        res.flushHeaders();
        res.write(': stream open\n\n');
        const sub = { res, last: after, ready: false, pending: [], ended: false, deltas: deltas === true };
        let set = subs.get(taskId);
        if (!set) { set = new Set(); subs.set(taskId, set); }
        set.add(sub);
        const beat = setInterval(() => { try { res.write(': keep-alive\n\n'); } catch { /* gone */ } }, HEARTBEAT_MS);
        beat.unref();
        const leave = () => {
            clearInterval(beat);
            const s = subs.get(taskId);
            if (s) { s.delete(sub); if (!s.size) subs.delete(taskId); }
        };
        req.on('close', leave);
        for (const e of await readBacklog()) send(sub, e);
        sub.ready = true;
        for (const e of sub.pending.sort((a, b) => a.seq - b.seq)) send(sub, e);
        sub.pending = [];
        if (sub.ended || await isEnded()) { leave(); res.end(); }
    }

    const status = () => ({ streams: [...subs.values()].reduce((n, s) => n + s.size, 0) });

    return { publish, delta, wants, end, serve, status };
}

module.exports = { createTaskStream };

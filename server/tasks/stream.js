'use strict';

/**
 * Live task streams: GET /api/v1/tasks/:id/events is text/event-stream of actor.task-event@1. A reader first gets
 * every stored event after its Last-Event-ID (or ?after=), then each new one as the engine publishes it; the stream
 * closes after the `end` event. Events are stored before they are published (tasks/store.js appendEvent), and a reader
 * subscribes before reading its backlog, so nothing falls between the two; a seq it already has is never sent twice.
 * The stream is best-effort; the task record is the truth.
 */

const HEARTBEAT_MS = 15_000;

function createTaskStream({ log = console } = {}) {
    const subs = new Map();     // task id → Set<{ res, last }>

    function write(sub, event) {
        if (event.seq <= sub.last) return;
        sub.last = event.seq;
        try { sub.res.write(`id: ${event.seq}\nevent: ${event.kind}\ndata: ${JSON.stringify(event)}\n\n`); } catch (err) { log.warn('[Actor] stream write failed:', err && err.message); }
    }

    function publish(taskId, event) {
        for (const sub of subs.get(taskId) || []) write(sub, event);
    }

    function end(taskId) {
        const set = subs.get(taskId);
        subs.delete(taskId);
        for (const sub of set || []) { try { sub.res.end(); } catch { /* gone */ } }
    }

    /**
     * Serve one reader. readBacklog() → stored events after `after`; isEnded() → whether the task has ended (read after
     * the backlog, so an end that happened meanwhile closes the stream).
     */
    async function serve(req, res, { taskId, after = 0, readBacklog, isEnded }) {
        res.status(200).set({ 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
        res.flushHeaders();
        res.write(': stream open\n\n');
        const sub = { res, last: after };
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
        for (const e of await readBacklog()) write(sub, e);
        if (await isEnded()) { leave(); res.end(); }
    }

    const status = () => ({ streams: [...subs.values()].reduce((n, s) => n + s.size, 0) });

    return { publish, end, serve, status };
}

module.exports = { createTaskStream };

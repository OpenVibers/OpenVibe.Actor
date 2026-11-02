'use strict';

/**
 * The small background-job loop Actor uses (the shape the network's services share): every() runs a function on a
 * timeout chain, never overlapping a slow run, and contains a throw so a database hiccup cannot take the process
 * down. Nothing starts unless start() is called; a drill flag keeps every loop off in a drill.
 *
 *   const stop = every('actor-wait-deadlines', 30_000, run, { initialDelayMs: 60_000 });
 */
const timers = new Set();

function every(name, intervalMs, fn, { initialDelayMs = intervalMs, jitterMs = 0, log = console } = {}) {
    let active = true;
    let handle = null;
    let busy = false;
    const jitter = () => (jitterMs > 0 ? Math.floor(Math.random() * jitterMs) : 0);
    const schedule = (delay) => {
        if (!active) return;
        handle = setTimeout(async () => {
            timers.delete(handle);
            handle = null;
            if (!active) return;
            if (!busy) {
                busy = true;
                try { await fn(); } catch (err) { log.warn && log.warn(`[Actor] job ${name} failed: ${(err && err.message) || err}`); } finally { busy = false; }
            }
            schedule(intervalMs + jitter());
        }, delay);
        if (handle.unref) handle.unref();
        timers.add(handle);
    };
    schedule(initialDelayMs + jitter());
    return () => {
        active = false;
        if (handle) { clearTimeout(handle); timers.delete(handle); handle = null; }
    };
}

function stopAll() {
    for (const t of timers) clearTimeout(t);
    timers.clear();
}

module.exports = { every, stopAll };

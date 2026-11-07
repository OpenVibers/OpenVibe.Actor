'use strict';
/**
 * The person's own token for the minutes a chat turn runs. It is kept in memory, for one task id,
 * never written to the database, never logged and never put in an event; the tool reads it to create
 * or change a Watch subscription as the person. An hour is enough for a turn that was queued behind
 * another (the token itself carries its own expiry, and Watch checks it).
 */
const TTL_MS = 60 * 60_000;
const MAP = new Map();

function put(taskId, { token = null, timezone = null } = {}) {
    if (!taskId || !token) return;
    MAP.set(taskId, { token, timezone: timezone || null, at: Date.now() });
}
function get(taskId) {
    const found = taskId ? MAP.get(taskId) : null;
    if (!found) return null;
    if (Date.now() - found.at > TTL_MS) { MAP.delete(taskId); return null; }
    return found;
}
function drop(taskId) { if (taskId) MAP.delete(taskId); }
function size() { return MAP.size; }

module.exports = { put, get, drop, size, TTL_MS };

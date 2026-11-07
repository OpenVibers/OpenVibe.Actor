'use strict';

/**
 * Who is driving a task's Computer right now (plan 2026-11-07: Take over / Give it back).
 *
 * The person's take-over is an API call (POST /api/v1/tasks/:id/takeover), not a desk command, so the task's tools
 * cannot see it in Bot: this is the one place that says the person is driving. While a task is here, the agent's
 * input actions are refused with a reason; giveback clears it. In memory only, like looks.js: a restart loses the
 * marker, and Bot's own person-first turn still holds the desk off the agent either way.
 */
const KEEP_MS = 60 * 60 * 1000;   // the longest a take-over holds without a giveback
const MAX = 2000;

const driving = new Map();   // task id → { at }

function take(taskId, now = Date.now()) {
    if (!taskId) return false;
    driving.delete(taskId);
    driving.set(taskId, { at: now });
    while (driving.size > MAX) driving.delete(driving.keys().next().value);
    return true;
}

function give(taskId) {
    return driving.delete(taskId);
}

function is(taskId, now = Date.now()) {
    const d = taskId ? driving.get(taskId) : null;
    if (!d) return false;
    if (now - d.at > KEEP_MS) { driving.delete(taskId); return false; }
    return true;
}

module.exports = { take, give, is, KEEP_MS };

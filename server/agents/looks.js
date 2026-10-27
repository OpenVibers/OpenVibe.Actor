'use strict';
/**
 * The last picture an agent looked at, per task (Desks plan: glance at any desk). When the agent reads a screen
 * (computer_screen), the picture it sent to the vision model is kept here, so the person's own task page can show what
 * the agent last saw. In memory only: at most MAX tasks, each for KEEP_MS, gone when the server restarts. Never stored,
 * never sent anywhere else.
 */
const MAX = 200;
const KEEP_MS = 60 * 60 * 1000;
const MAX_BYTES = 2 * 1024 * 1024;

const looks = new Map();   // task id -> { format, data, width, height, at }

function put(taskId, shot, now = Date.now()) {
    if (!taskId || !shot || typeof shot.content_b64 !== 'string' || !shot.content_b64) return false;
    const data = Buffer.from(shot.content_b64, 'base64');
    if (!data.length || data.length > MAX_BYTES) return false;
    looks.delete(taskId);
    looks.set(taskId, { format: shot.format === 'png' ? 'png' : 'jpeg', data, width: Number(shot.width) || null, height: Number(shot.height) || null, at: now });
    while (looks.size > MAX) looks.delete(looks.keys().next().value);
    return true;
}

function get(taskId, now = Date.now()) {
    const l = looks.get(taskId);
    if (!l) return null;
    if (now - l.at > KEEP_MS) { looks.delete(taskId); return null; }
    return l;
}

module.exports = { put, get, MAX, KEEP_MS };

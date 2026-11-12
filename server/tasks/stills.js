'use strict';

/**
 * The pictures a task's steps saw (See it work, W1): one still per computer step, kept with its event seq so a finished
 * run's replay can scrub through them. The desk's own curtain blanks a secret screen before this ever sees it; typed
 * text is never part of a still.
 *
 * In Actor's own database, gone with the task (store.prune deletes the orphans; tasks are kept 30 days). At most
 * MAX_PER_TASK per task, 640 px wide, WebP where sharp is available, otherwise the JPEG/PNG the machine sent.
 */
const MAX_PER_TASK = 120;
const MAX_BYTES = 400 * 1024;
const MAX_KEEP = 640;

const sharp = (() => { try { return require('sharp'); } catch { return null; } })();

/** Shrink to a replay picture and encode it. → { mime, bytes, width, height } */
async function shrink(shot) {
    const bytes = Buffer.isBuffer(shot.data) ? shot.data : Buffer.from(String(shot.data || ''), 'base64');
    if (!bytes.length) return null;
    const format = shot.format === 'png' ? 'png' : 'jpeg';
    if (sharp) {
        try {
            const out = await sharp(bytes).rotate().resize({ width: MAX_KEEP, withoutEnlargement: true }).webp({ quality: 72 }).toBuffer({ resolveWithObject: true });
            if (out.data.length && out.data.length <= MAX_BYTES) {
                return { mime: 'image/webp', bytes: out.data, width: out.info.width || null, height: out.info.height || null };
            }
        } catch { /* fall through to the original */ }
    }
    if (bytes.length > MAX_BYTES) return null;
    return { mime: `image/${format}`, bytes, width: Number(shot.width) || null, height: Number(shot.height) || null };
}

/** Remember the still a computer step saw at its result event's seq. Best effort: a picture never fails the run. */
async function save(s, taskId, seq, shot) {
    if (!s || !taskId || !Number.isInteger(seq) || seq < 1 || !shot) return false;
    const made = await shrink(shot);
    if (!made) return false;
    const count = await s.db.value('SELECT count(*)::int FROM actor_task_stills WHERE task_id = $1', [taskId]).catch(() => 0);
    if (Number(count) >= MAX_PER_TASK) return false;
    await s.db.query(
        `INSERT INTO actor_task_stills (task_id, seq, tool, mime, width, height, bytes, at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (task_id, seq) DO NOTHING`,
        [taskId, seq, shot.tool || null, made.mime, made.width, made.height, made.bytes, s.iso()],
    );
    return true;
}

async function list(s, taskId) {
    return s.db.many('SELECT seq, tool, mime, width, height, at FROM actor_task_stills WHERE task_id = $1 ORDER BY seq', [taskId]);
}

async function get(s, taskId, seq) {
    return s.db.maybe('SELECT seq, tool, mime, width, height, bytes, at FROM actor_task_stills WHERE task_id = $1 AND seq = $2', [taskId, seq]);
}

/** Drop the pictures of tasks that are gone (called by store.prune). */
async function prune(s) {
    await s.db.query('DELETE FROM actor_task_stills WHERE task_id NOT IN (SELECT id FROM tasks)');
}

module.exports = { save, list, get, prune, MAX_PER_TASK };

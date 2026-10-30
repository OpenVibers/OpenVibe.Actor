'use strict';

/**
 * Task artifacts (Actor v2, stage V2-4): the files and charts a tool makes, kept in Actor's own PostgreSQL.
 *
 * Why they are not on OpenVibe.Media yet: Actor hosts people's agents, and OpenVibe.Network lets a hosted agent hold
 * what its host holds, so a Media grant on Actor would open Actor's whole tenant to every agent (Network #432 pins
 * "no Media grant for the agent host"). Until Network keeps `media.*` out of what a hosted agent inherits, the bytes
 * stay in Actor's own database (migrations/0015_actor_artifacts.sql), private to the task's owner. They move to
 * Media when Network does.
 *
 *   actor_artifacts (id, task_id, owner, name, mime, size, bytes, created_at)
 *
 * An artifact is exactly `{ kind, name, mime, url, size }` (actor.task-event@2): `url` is Actor's own stable link,
 * `/tasks/<task>/files/<artifact>`, which the task's owner opens and nobody else may (another person gets the same
 * 404 as a task that does not exist). The bytes are the person's own file: nothing here is a secret.
 *
 * Caps: 256 KB a file, 2 MB a task (config.artifacts). Both are counted here, not in the tool, so every way in
 * keeps to them.
 *
 * createArtifactStore({ store, config, taskId, requester, log, now }) → { available, save, artifacts, find, maxFileBytes }
 * findArtifact(db, taskId, id) → the row the file route serves, or null
 * sendArtifact(res, row) → the bytes, with the headers a file of this kind needs
 */

const MAX_ARTIFACTS = 20;             // the registry's normalize() keeps at most this many per result
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const ID = /^art_[0-9A-HJKMNP-TV-Z]{26}$/;
const KINDS = ['file', 'chart'];

// The images a browser may show in place; everything else (an SVG, an HTML page, a CSV) is a download.
const INLINE_IMAGE = /^image\/(png|jpe?g|gif|webp|avif|bmp|x-icon|vnd\.microsoft\.icon)$/i;
// A file name a header may carry: no quotes, no control characters, nothing that could end the header.
const fileName = (name) => String(name || 'file').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 100) || 'file';

/** The person behind a requester (`user:usr_…`), or null when the task was for an app or an agent. */
const personOf = (requester) => (typeof requester === 'string' && requester.startsWith('user:') ? requester.slice(5) : null);

function asBytes(value) {
    if (Buffer.isBuffer(value)) return value;
    if (value instanceof Uint8Array) return Buffer.from(value);
    if (typeof value === 'string') return Buffer.from(value, 'utf8');
    throw new Error('content must be a string, a Buffer or a Uint8Array');
}

/** Actor's own stable link for one artifact: the task's owner opens it, nobody else. */
function artifactUrl(config, taskId, id) {
    const base = String((config && config.baseUrl) || '').replace(/\/+$/, '');
    return `${base}/tasks/${encodeURIComponent(taskId)}/files/${encodeURIComponent(id)}`;
}

/**
 * One task's artifacts. `save()` keeps to the size limits from config and writes the bytes to Actor's own
 * database; the artifact it answers is what the tool result, the event and the task result carry.
 */
function createArtifactStore({ store = null, config = {}, taskId = null, requester = null, log = console, now = () => Date.now() } = {}) {
    const person = personOf(requester);
    const owner = person ? `user:${person}` : null;
    const maxFileBytes = Math.max(1024, Number(config.artifacts && config.artifacts.maxFileBytes) || 256 * 1024);
    const maxTaskBytes = Math.max(maxFileBytes, Number(config.artifacts && config.artifacts.maxTaskBytes) || 2 * 1024 * 1024);
    const db = store && store.db;
    const available = Boolean(db && taskId && owner);

    /** The bytes a task already holds, and how many files it made. */
    async function used(task = taskId) {
        const row = await db.maybe(
            'SELECT COALESCE(SUM(size), 0)::int AS bytes, COUNT(*)::int AS files FROM actor_artifacts WHERE task_id = $1',
            [task],
        );
        return { bytes: Number((row && row.bytes) || 0), files: Number((row && row.files) || 0) };
    }

    /**
     * Store one file or chart → the artifact the result and the event carry. The size limits are checked here, so
     * every tool keeps to them: 256 KB a file, 2 MB a task.
     */
    async function save({ kind = 'file', name, mime, bytes } = {}) {
        if (!available) throw new Error('files are not available for this task');
        const artifactKind = KINDS.includes(kind) ? kind : 'file';
        const body = asBytes(bytes);
        if (!body.length) throw new Error('an artifact cannot be empty');
        if (body.length > maxFileBytes) throw new Error(`the file is ${body.length} bytes; this server's limit is ${maxFileBytes} bytes a file`);
        const safeName = String(name || '').trim();
        if (!NAME.test(safeName)) throw new Error('the file name must be 1–128 letters, digits, dots, dashes or underscores');
        const mimeType = String(mime || 'application/octet-stream').slice(0, 128);
        const room = await used();
        if (room.files >= MAX_ARTIFACTS) throw new Error(`a task may make at most ${MAX_ARTIFACTS} files`);
        if (room.bytes + body.length > maxTaskBytes) {
            throw new Error(`this task already holds ${room.bytes} bytes; the limit is ${maxTaskBytes} bytes a task`);
        }
        const id = store.newId('art');
        await db.query(
            'INSERT INTO actor_artifacts (id, task_id, owner, name, mime, size, bytes, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7::bytea, $8)',
            [id, taskId, owner, safeName, mimeType, body.length, body, store.iso()],
        );
        return { kind: artifactKind, name: safeName, mime: mimeType, url: artifactUrl(config, taskId, id), size: body.length };
    }

    /** Every artifact of this task, oldest first (what the task result carries). */
    async function artifacts() {
        if (!available) return [];
        const rows = await db.many(
            'SELECT id, name, mime, size FROM actor_artifacts WHERE task_id = $1 ORDER BY created_at, id',
            [taskId],
        );
        return (rows || []).map((r) => ({
            kind: String(r.name || '').toLowerCase().endsWith('.svg') ? 'chart' : 'file',
            name: r.name, mime: r.mime, url: artifactUrl(config, taskId, r.id), size: Number(r.size) || 0,
        }));
    }

    /** One artifact of this task, or null. */
    async function find(id) {
        if (!available || !ID.test(String(id || ''))) return null;
        const row = await db.maybe('SELECT * FROM actor_artifacts WHERE task_id = $1 AND id = $2', [taskId, id]);
        return row || null;
    }

    return { available, save, artifacts, find, used, maxFileBytes, maxTaskBytes, maxBytes: maxFileBytes };
}

/**
 * The row the file route serves: the artifact of a task, or null. The caller has already checked that the person is
 * the task's own, so the task id is what keeps one person's file out of another's hands.
 */
async function findArtifact(db, taskId, id) {
    if (!db || typeof db.maybe !== 'function') return null;
    if (!ID.test(String(id || ''))) return null;
    const row = await db.maybe('SELECT * FROM actor_artifacts WHERE task_id = $1 AND id = $2', [taskId, id]);
    return row || null;
}

/**
 * The bytes of one artifact, as the answer to a request for it: the file's own type, never sniffed, in a sandbox with
 * nothing allowed to load, and a download unless it is a raster image (which a browser may show in place).
 */
function sendArtifact(res, row) {
    const mime = String((row && row.mime) || 'application/octet-stream');
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Disposition', `${INLINE_IMAGE.test(mime) ? 'inline' : 'attachment'}; filename="${fileName(row && row.name)}"`);
    const bytes = Buffer.isBuffer(row && row.bytes) ? row.bytes : Buffer.from((row && row.bytes) || []);
    return res.status(200).send(bytes);
}

module.exports = {
    createArtifactStore, findArtifact, artifactUrl, sendArtifact,
    MAX_ARTIFACTS, NAME, ID, KINDS, personOf,
};

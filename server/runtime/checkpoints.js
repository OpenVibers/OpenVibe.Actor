'use strict';

/**
 * Sealed checkpoints (Actor v2, stage V2-9): one after every step, so a run can pick up after a restart, and any
 * step can be forked with one change.
 *
 * Encryption is the same pattern as OpenVibe.AI's person credentials (server/credentials.js): AES-256-GCM with a
 * random 12-byte IV and the tag stored beside the body, under ACTOR_CHECKPOINT_KEY (64 hex characters). The additional
 * authenticated data binds a row to its task and step (`checkpoint|<task_id>|<step>`), so a ciphertext moved to
 * another task or step does not open. Without a valid key, checkpoints are off: save() writes nothing, at() and
 * last() answer null, and the task behaves as it did before this stage.
 *
 * Nothing in a checkpoint is a secret or a tool credential: stripSecrets() removes any value under a credential-shaped
 * key, any common token shape, and any tool result a tool marked `secret: true`. It runs before sealing, so even a
 * database reader with the key cannot recover what a tool marked secret.
 *
 *   createCheckpoints({ store, config, log, now }) → {
 *     enabled, seal(plain, aad), open(sealed, aad), aad(taskId, step),
 *     save({ taskId, step, state }), at(taskId, step), last(taskId), list(taskId), prune(taskId), count(taskId)
 *   }
 *
 * The last `config.checkpoints.keep` rows per task are kept (50 by default); a row goes with its task (ON DELETE
 * CASCADE) and is exported and erased with the person.
 */

const crypto = require('crypto');
const { snapshot, restore, VERSION } = require('./checkpoint-state');

const KEY_RE = /^[0-9a-f]{64}$/i;
const DEFAULT_KEEP = 50;
const MAX_DEPTH = 12;
const MAX_STRING = 500_000;
// Credential-shaped object keys. A task about a "token" (a coin) loses that input on a resume; that is the safe side.
const SECRET_KEY = /(?:^|[_-])(?:secret|password|passwd|passphrase|token|api[_-]?key|apikey|credential|authorization|auth|cookie|private[_-]?key|session|signature)(?:[_-]|$)/i;
// Common credentials that can appear inside a string (a tool result, a model message). A match is replaced, not the
// whole string, so a checkpoint's meaning survives.
const TOKEN_PATTERNS = [
    /\b(?:sk|rk)-[A-Za-z0-9_-]{16,}\b/g,
    /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g,
    /\bwhsec_[A-Za-z0-9+/=_-]{16,}\b/g,
    /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
    /\bAKIA[0-9A-Z]{16}\b/g,
    /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
    /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];
const REDACTED = '[redacted: a credential is never stored in a checkpoint]';

function redactText(value) {
    let text = String(value);
    if (text.length > MAX_STRING) text = text.slice(0, MAX_STRING);
    for (const re of TOKEN_PATTERNS) text = text.replace(re, REDACTED);
    return text;
}

/**
 * A JSON-safe copy with secrets removed. A tool result marked `secret: true` keeps only its id, tool and the mark (so
 * an answer that cited it still resolves); every other field goes.
 */
function stripSecrets(value, depth = 0) {
    if (value === null || value === undefined) return value;
    if (typeof value === 'string') {
        const text = redactText(value);
        // A tool or model message content is often JSON; strip credential-shaped fields inside it too.
        const trimmed = text.trim();
        if ((trimmed.startsWith('{') || trimmed.startsWith('[')) && text.length <= MAX_STRING) {
            try { return JSON.stringify(stripSecrets(JSON.parse(text), depth + 1)); } catch { return text; }
        }
        return text;
    }
    if (typeof value !== 'object') return value;
    if (depth >= MAX_DEPTH) return '[not stored: nested too deeply]';
    if (Array.isArray(value)) return value.map((v) => stripSecrets(v, depth + 1));
    if (value.secret === true || value.sensitive === true) {
        const keep = { redacted: true, note: '[not stored: the tool marked this result secret]' };
        if (value.id != null) keep.id = redactText(value.id);
        if (value.tool != null) keep.tool = redactText(value.tool);
        keep.secret = true;
        return keep;
    }
    const out = {};
    for (const [k, v] of Object.entries(value)) {
        if (SECRET_KEY.test(k)) out[k] = REDACTED;
        else out[k] = stripSecrets(v, depth + 1);
    }
    return out;
}

function createCheckpoints({ store, config = {}, log = console, now = () => Date.now() } = {}) {
    const cfg = config.checkpoints || {};
    const enabled = KEY_RE.test(String(cfg.key || ''));
    const keep = Math.max(1, Number(cfg.keep) || DEFAULT_KEEP);

    function key() {
        const hex = String(cfg.key || '');
        if (!KEY_RE.test(hex)) throw Object.assign(new Error('checkpoints are not configured (ACTOR_CHECKPOINT_KEY)'), { code: 'actor.checkpoint.off' });
        return Buffer.from(hex, 'hex');
    }

    const aad = (taskId, step) => `checkpoint|${taskId}|${step}`;

    /** AES-256-GCM, the OpenVibe.AI credentials format: v1:iv:tag:body (base64 each). */
    function seal(plain, additionalData) {
        const iv = crypto.randomBytes(12);
        const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
        c.setAAD(Buffer.from(String(additionalData)));
        const body = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
        return `v1:${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${body.toString('base64')}`;
    }

    function open(sealed, additionalData) {
        const [v, iv, tag, body] = String(sealed).split(':');
        if (v !== 'v1') throw new Error('unknown checkpoint format');
        const d = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'));
        d.setAAD(Buffer.from(String(additionalData)));
        d.setAuthTag(Buffer.from(tag, 'base64'));
        return Buffer.concat([d.update(Buffer.from(body, 'base64')), d.final()]).toString('utf8');
    }

    const rowOf = (row) => (row ? { task_id: row.task_id, step: Number(row.step), created_at: row.created_at, state: JSON.parse(open(row.state_enc, aad(row.task_id, Number(row.step)))) } : null);

    /** Write (or replace) the checkpoint for one step, then keep only the newest `keep`. A failure never fails the task. */
    async function save({ taskId, step, state } = {}) {
        if (!enabled || !store || !taskId) return null;
        const n = Number(step);
        if (!Number.isInteger(n) || n < 0) return null;
        const plain = stripSecrets(state == null ? {} : state);
        const sealed = seal(JSON.stringify(plain), aad(taskId, n));
        try {
            await store.db.query(
                `INSERT INTO actor_checkpoints (task_id, step, created_at, state_enc) VALUES ($1, $2, $3, $4)
                 ON CONFLICT (task_id, step) DO UPDATE SET created_at = EXCLUDED.created_at, state_enc = EXCLUDED.state_enc`,
                [taskId, n, new Date(now()).toISOString(), sealed],
            );
            await prune(taskId);
            return n;
        } catch (err) {
            if (log && log.warn) log.warn('[Actor] checkpoint not stored (the task goes on):', (err && err.message) || err);
            return null;
        }
    }

    /** One task's checkpoint at one step, or null. A row that does not open (another key) throws: the caller decides. */
    async function at(taskId, step) {
        if (!enabled || !store || !taskId) return null;
        const row = await store.db.maybe('SELECT task_id, step, created_at, state_enc FROM actor_checkpoints WHERE task_id = $1 AND step = $2', [taskId, Number(step)]);
        return rowOf(row);
    }

    /** The newest checkpoint of a task, or null. */
    async function last(taskId) {
        if (!enabled || !store || !taskId) return null;
        const row = await store.db.maybe('SELECT task_id, step, created_at, state_enc FROM actor_checkpoints WHERE task_id = $1 ORDER BY step DESC LIMIT 1', [taskId]);
        return rowOf(row);
    }

    /** Metadata only, oldest step first: the page's list can fork from any of them without opening a ciphertext. */
    async function list(taskId) {
        if (!enabled || !store || !taskId) return [];
        const rows = await store.db.many('SELECT step, created_at FROM actor_checkpoints WHERE task_id = $1 ORDER BY step', [taskId]);
        return rows.map((r) => ({ step: Number(r.step), created_at: r.created_at }));
    }

    async function count(taskId) {
        if (!enabled || !store || !taskId) return 0;
        return Number(await store.db.value('SELECT count(*) FROM actor_checkpoints WHERE task_id = $1', [taskId])) || 0;
    }

    /** Keep the newest `keep` rows for a task; older steps go. */
    async function prune(taskId) {
        if (!enabled || !store || !taskId) return 0;
        const gone = await store.db.exec(
            `DELETE FROM actor_checkpoints
              WHERE task_id = $1 AND step NOT IN (
                    SELECT step FROM actor_checkpoints WHERE task_id = $1 ORDER BY step DESC LIMIT $2)`,
            [taskId, keep],
        );
        return Number(gone) || 0;
    }

    return { enabled, keep, seal, open, aad, save, at, last, list, count, prune, snapshot, restore, VERSION, stripSecrets };
}

module.exports = { createCheckpoints, stripSecrets, redactText, SECRET_KEY, TOKEN_PATTERNS, KEY_RE, DEFAULT_KEEP };

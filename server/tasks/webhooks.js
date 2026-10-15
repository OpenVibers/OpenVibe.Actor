'use strict';
/**
 * Task webhooks (plan T17, actor.task-webhook@1): a task registers up to 8 https endpoints and the state changes each
 * wants. When the task reaches one, a delivery row is queued with the body as it is then; this worker POSTs it,
 * signed with the task's own secret exactly like an Events delivery (X-OpenVibe-Timestamp, X-OpenVibe-Signature-V2:
 * HMAC-SHA256 of "<t>.<raw body>"), so a receiver checks it with openvibe-sdk/events verifyDeliveryV2.
 *
 *   2xx                      delivered
 *   410, or a refused URL    failed at once (the receiver is gone, or the URL is not a public address any more)
 *   anything else            retried: 10 s, 1 min, 5 min, 30 min, 2 h, 6 h, 12 h, then failed (about a day)
 *
 * A webhook that names a project secret (secret_ref, ADR-056) is signed by OpenVibe.Network instead, in the same headers:
 * Actor sends Network "<t>.<raw body>" and puts the signature it answers in X-OpenVibe-Signature-V2, so the receiver's
 * check is the same and Actor never holds the value. A secret that does not exist or is not granted to actor fails that
 * delivery at once; Network being unreachable is retried like any other failure.
 *
 * A delivery never delays or changes the task. Once a task has ended and none of its deliveries is pending, its secret
 * is erased. The delivery id is stable across attempts (dedupe on it). One Actor process sends: rows are claimed with
 * FOR UPDATE SKIP LOCKED all the same, and a row a crash left 'sending' is pending again at the next start.
 */
const crypto = require('crypto');
const { signDeliveryHeaders } = require('openvibe-sdk/events');
const store = require('./store');
const { WebhookRefused } = require('../net/webhook-post');
const { SecretRefused } = require('../net/secret-signer');

const BACKOFF_MS = [10_000, 60_000, 300_000, 1_800_000, 7_200_000, 21_600_000, 43_200_000];
const BATCH = 20;

/** A fresh per-task secret: whsec_ + 32 random bytes, base64url (43 characters). */
const mintSecret = () => `whsec_${crypto.randomBytes(32).toString('base64url')}`;

function createWebhooks({ s, config, post, signer = null, now = () => Date.now(), log = console }) {
    let timer = null;
    let running = null;

    /** Queue the deliveries a task's state change asks for (none when it registered no webhook for that state). */
    async function enqueue(taskId, state) {
        const row = await store.getTask(s, taskId);
        const hooks = store.parseJson(row && row.webhooks) || [];
        const wanted = hooks.filter((h) => Array.isArray(h.events) && h.events.includes(state));
        if (!wanted.length) return 0;
        const task = store.toWire(row, { baseUrl: config.baseUrl });
        for (const h of wanted) {
            const id = s.newId('whd');
            const body = { type: 'actor.task.state', delivery_id: id, state, task };
            await s.db.query(`INSERT INTO webhook_deliveries (id, task_id, url, state, body, status, attempts, next_at, created_at, secret_ref, secret_env)
                VALUES ($1, $2, $3, $4, $5::jsonb, 'pending', 0, $6, $7, $8, $9)`, [id, taskId, h.url, state, JSON.stringify(body), now(), s.iso(), h.secret_ref || null, h.secret_ref ? h.environment : null]);
        }
        return wanted.length;
    }

    async function claim() {
        return await s.tx(async () => await s.db.many(`UPDATE webhook_deliveries SET status = 'sending'
            WHERE id IN (SELECT id FROM webhook_deliveries WHERE status = 'pending' AND next_at <= $1 ORDER BY next_at, id LIMIT $2 FOR UPDATE SKIP LOCKED)
            RETURNING *`, [now(), BATCH]));
    }

    async function finish(d, status, { lastStatus = null, error = null, attempts }) {
        await s.db.query(`UPDATE webhook_deliveries SET status = $2, attempts = $3, last_status = $4, last_error = $5, finished_at = $6 WHERE id = $1`,
            [d.id, status, attempts, lastStatus, error, s.iso()]);
        await forgetSecretIfDone(d.task_id);
    }

    /** The task has ended and nothing is left to send: its secret goes. */
    async function forgetSecretIfDone(taskId) {
        await s.db.query(`UPDATE tasks SET webhook_secret = NULL WHERE id = $1 AND webhook_secret IS NOT NULL AND state NOT IN ('queued', 'running', 'verifying')
            AND NOT EXISTS (SELECT 1 FROM webhook_deliveries WHERE task_id = $1 AND status IN ('pending', 'sending'))`, [taskId]);
    }

    /** The signature headers: the task's own secret, or Network's signature with the project secret the webhook names. */
    async function signatureHeaders(d, body) {
        if (!d.secret_ref) {
            const secret = await s.db.value('SELECT webhook_secret FROM tasks WHERE id = $1', [d.task_id]);
            return secret ? signDeliveryHeaders(body, secret, { now: now() }) : null;
        }
        const project = await s.db.value('SELECT project_id FROM tasks WHERE id = $1', [d.task_id]);
        if (!project || !signer) throw new SecretRefused('the task has no project to look the secret up in');
        const t = Math.floor(now() / 1000);
        const { signature } = await signer.sign({ project_id: project, environment: d.secret_env, name: d.secret_ref, message: `${t}.${body}` });
        return { 'X-OpenVibe-Timestamp': String(t), 'X-OpenVibe-Signature-V2': `t=${t},v2=${signature}` };
    }

    /** Try again on the backoff, or give up once it is spent. */
    async function retryLater(d, attempts, lastStatus, why) {
        if (attempts > BACKOFF_MS.length) return finish(d, 'failed', { lastStatus, error: why, attempts });
        await s.db.query(`UPDATE webhook_deliveries SET status = 'pending', attempts = $2, next_at = $3, last_status = $4, last_error = $5 WHERE id = $1`,
            [d.id, attempts, now() + BACKOFF_MS[attempts - 1], lastStatus, why]);
        return undefined;
    }

    async function sendOne(d) {
        const attempts = Number(d.attempts) + 1;
        const body = JSON.stringify(store.parseJson(d.body));
        let signed;
        try { signed = await signatureHeaders(d, body); } catch (err) {
            if (err instanceof SecretRefused) return finish(d, 'failed', { error: err.message.slice(0, 300), attempts });
            // Network could not sign just now: the same backoff as a receiver that did not answer.
            return retryLater(d, attempts, null, `signing with the project secret: ${String(err.message || err).slice(0, 250)}`);
        }
        if (!signed) return finish(d, 'failed', { error: 'the task has no signing secret any more', attempts });
        const headers = {
            ...signed,
            'X-OpenVibe-Delivery-Id': d.id,
            'X-OpenVibe-Task-Id': d.task_id,
            'X-OpenVibe-Task-State': d.state,
            'X-OpenVibe-Delivery-Attempt': String(attempts),
        };
        let res = null;
        let error = null;
        try { res = await post(d.url, { headers, body }); } catch (err) { error = err; }
        if (res && res.status >= 200 && res.status < 300) return finish(d, 'delivered', { lastStatus: res.status, attempts });
        if ((res && res.status === 410) || error instanceof WebhookRefused) {
            return finish(d, 'failed', { lastStatus: res ? res.status : null, error: error ? error.message : 'the receiver answered 410 Gone', attempts });
        }
        const why = error ? String(error.message || error).slice(0, 300) : `HTTP ${res.status}`;
        return retryLater(d, attempts, res ? res.status : null, why);
    }

    /** One pass over what is due. One pass at a time. */
    function tick() {
        if (running) return running;
        running = (async () => {
            let sent = 0;
            for (const d of await claim()) {
                try { await sendOne(d); sent++; } catch (err) {
                    log.warn('[Actor] webhook delivery crashed:', d.id, err && err.message);
                    await s.db.query(`UPDATE webhook_deliveries SET status = 'pending', next_at = $2 WHERE id = $1 AND status = 'sending'`, [d.id, now() + BACKOFF_MS[0]]).catch(() => {});
                }
            }
            return sent;
        })().finally(() => { running = null; });
        return running;
    }

    /** At start: a row a stopped process left 'sending' is pending again (the receiver dedupes on the delivery id). */
    async function recover() {
        return await s.db.exec(`UPDATE webhook_deliveries SET status = 'pending' WHERE status = 'sending'`);
    }

    function start(intervalMs = config.webhooks.intervalMs) {
        if (timer) return;
        timer = setInterval(() => { tick().catch((err) => log.warn('[Actor] webhook pass failed:', err && err.message)); }, intervalMs);
        timer.unref();
    }
    async function stop() {
        if (timer) clearInterval(timer);
        timer = null;
        if (running) await running.catch(() => {});
    }

    /** A task's deliveries, newest first (the task page shows them; the receiver URL is the requester's own). */
    const forTask = (taskId) => s.db.many('SELECT id, url, state, status, attempts, last_status, last_error, created_at, finished_at FROM webhook_deliveries WHERE task_id = $1 ORDER BY created_at DESC, id DESC', [taskId]);

    return { enqueue, tick, recover, start, stop, forTask, forgetSecretIfDone, BACKOFF_MS };
}

module.exports = { createWebhooks, mintSecret, BACKOFF_MS };

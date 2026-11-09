'use strict';
/**
 * OpenVibe.Network notifications for the person a task is for (Desks plan D4, "hand it to me"; Actor v2, stage V2-6,
 * "tell me when it's done"). The task's owner (a usr_ subject) becomes Network's user id (GET
 * /internal/identity/resolve, capability identity.subject.resolve), then one notification is pushed as app actor
 * (POST /internal/notifications/push, contracts network.notification-push-request@1, capability
 * network.notifications.push). Each with a token of its own, audience openvibe.network.
 *
 *   needsYou({ subject, what, kind, title, url })   a step only the person can do (the desk hand-off, an approval,
 *                                                   a question): the message is the step alone; rich_content carries
 *                                                   step, kind (approve | answer | choose) and the task's title
 *   taskEnded({ subject, state, taskId, title, url, detail })   done or not finished: the message is the task's title
 *                                                   (and why it did not finish); rich_content carries task_title
 *
 * The words are for a person: no "Done:"/"approve:" prefixes, no task text in brackets after a step (Shared 4.172
 * reads rich_content; older clients show the message, which already reads right).
 *
 * Best effort: off without a client secret, never retried (Network keeps no idempotency record for a push, and a person
 * told twice is worse than one told once), and a failure never stops a task. → { sent, reason? }
 * "At most one per task per state" is the caller's claim (server/notify/task-notices.js), not this client's.
 */
const { serviceAuth } = require('openvibe-contracts');

const SUBJECT = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;
const TASK_ID = /^tsk_[0-9A-HJKMNP-TV-Z]{26}$/;
const ASK_KINDS = new Set(['approve', 'answer', 'choose']);
const clip = (s, n) => (String(s == null ? '' : s).length > n ? `${String(s).slice(0, n - 1)}…` : String(s == null ? '' : s));

function createNotifier({ config, fetchImpl = globalThis.fetch, tokens: tokensOverride = null, log = console }) {
    const base = config.networkInternalUrl;
    const enabled = !!(base && (tokensOverride || (config.oauth && config.oauth.clientSecret)));
    const tokenFor = (scope) => tokensOverride || serviceAuth.createTokenClient({
        tokenUrl: `${base}/oauth/token`, clientId: config.oauth.clientId, clientSecret: config.oauth.clientSecret,
        audience: 'openvibe.network', scope, fetchImpl,
    });
    const resolveTokens = enabled ? tokenFor('identity.subject.resolve') : null;
    const pushTokens = enabled ? tokenFor('network.notifications.push') : null;

    async function networkUserId(subject) {
        const res = await fetchImpl(`${base}/internal/identity/resolve?subject_id=${encodeURIComponent(subject)}`, {
            headers: { Accept: 'application/json', ...(await resolveTokens.authHeaders()) }, signal: AbortSignal.timeout(10_000),
        });
        if (res.status === 404) return null;
        if (!res.ok) throw new Error(`Network answered ${res.status} to resolve`);
        const who = await res.json();
        return who && !who.deleted && who.network_user_id != null ? who.network_user_id : null;
    }

    /** One body of network.notification-push-request@1, addressed by subject. Never throws to the caller. */
    async function send(subject, body) {
        if (!enabled) return { sent: false, reason: 'off' };
        if (!SUBJECT.test(String(subject || '')) || !/^https:\/\//.test(String(body && body.url || ''))) return { sent: false, reason: 'bad_input' };
        try {
            const userId = await networkUserId(subject);
            if (userId == null) return { sent: false, reason: 'unknown_subject' };
            const res = await fetchImpl(`${base}/internal/notifications/push`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(await pushTokens.authHeaders()) },
                body: JSON.stringify({ ...body, user_id: userId }),
                signal: AbortSignal.timeout(10_000),
            });
            if (!res.ok) return { sent: false, reason: `network_${res.status}` };
            const out = await res.json().catch(() => null);
            return { sent: true, ...(out && out.skipped ? { skipped: true } : {}) };
        } catch (err) {
            log.warn && log.warn(`[notify] could not tell the person: ${(err && err.message) || err}`);
            return { sent: false, reason: 'error' };
        }
    }

    /** The agent needs its person for one step: `what` (the step), its `kind`, the task's `title` and where to do it. */
    async function needsYou({ subject, what, kind = null, title = null, url }) {
        const message = clip(String(what || '').trim() || 'One step only you can do.', 300);
        return send(subject, {
            type: 'AGENT_NEEDS_YOU', category: 'service', priority: 'high', icon: '🙋',
            title: 'Your agent needs you', message, url, service: 'actor',
            rich_content: { step: message, ...(ASK_KINDS.has(kind) ? { kind } : {}), ...(title ? { task_title: clip(title, 160) } : {}) },
        });
    }

    /**
     * A task or a routine ended. The notification names what it was and how it ended, and links to the task page.
     * state: 'succeeded' or 'failed'; taskId is the task's id (it is what makes the "one per task per state" claim).
     */
    async function taskEnded({ subject, state, taskId, title, url, detail = null }) {
        if (!TASK_ID.test(String(taskId || ''))) return { sent: false, reason: 'bad_input' };
        const done = state === 'succeeded';
        const what = clip(title || 'Your task', 160);
        const message = done ? what : `${what}${detail ? ` — ${clip(detail, 140)}` : ''}`;
        return send(subject, {
            type: done ? 'AGENT_TASK_DONE' : 'AGENT_TASK_FAILED',
            category: 'service', priority: done ? 'normal' : 'high', icon: done ? '✅' : '⚠️',
            title: done ? 'Your task is done' : 'Your task did not finish',
            message, url, service: 'actor', rich_content: { task_id: taskId, state, task_title: what, ...(!done && detail ? { detail: clip(detail, 140) } : {}) },
        });
    }

    return { enabled, needsYou, taskEnded };
}

module.exports = { createNotifier };

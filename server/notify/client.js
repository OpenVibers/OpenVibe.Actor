'use strict';
/**
 * OpenVibe.Network notifications for the person a task is for (Desks plan D4, "hand it to me"): when the agent needs
 * them for a step on its desk, they hear it wherever they are (the bell on every OpenVibe site, and a push when they
 * allowed it), with the link to take the desk over. The task's owner (a usr_ subject) becomes Network's user id
 * (GET /internal/identity/resolve, capability identity.subject.resolve), then one notification is pushed as app actor
 * (POST /internal/notifications/push, capability network.notifications.push). Each with a token of its own, audience
 * openvibe.network.
 *
 * Best effort: off without a client secret, never retried (Network keeps no idempotency record for a push, and a person
 * told twice is worse than one told once), and a failure never stops a task. → { sent, reason? }
 */
const { serviceAuth } = require('openvibe-contracts');

const SUBJECT = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;

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

    /** The agent needs its person for one step on its desk: `what`, the task's `title` and the desk's `url`. */
    async function needsYou({ subject, what, title = null, url }) {
        if (!enabled) return { sent: false, reason: 'off' };
        if (!SUBJECT.test(String(subject || '')) || !/^https:\/\//.test(String(url || ''))) return { sent: false, reason: 'bad_input' };
        try {
            const userId = await networkUserId(subject);
            if (userId == null) return { sent: false, reason: 'unknown_subject' };
            const message = `${String(what || 'One step only you can do.').slice(0, 300)}${title ? ` (${String(title).slice(0, 120)})` : ''}`;
            const res = await fetchImpl(`${base}/internal/notifications/push`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(await pushTokens.authHeaders()) },
                body: JSON.stringify({
                    user_id: userId, type: 'AGENT_NEEDS_YOU', category: 'service', priority: 'high', icon: '🙋',
                    title: 'Your agent needs you', message, url, service: 'actor',
                }),
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

    return { enabled, needsYou };
}

module.exports = { createNotifier };

'use strict';

/**
 * OpenVibe.Events → Actor. Actor has no consumer of its own: the two topics it takes are account export and deletion
 * (ADR-033), and POST /internal/events is answered by openvibe-sdk/account-data's own consumer, mounted in
 * server/app.js over server/identity/account-data.js (the table map). What is left here is the boot-time half:
 * startSubscriptions() creates the two subscriptions at Events if they are missing, idempotently, retried with
 * backoff, and off when the URL or the secret is unset (QUEST_EVENTS_SUBSCRIBE=0 style: ACTOR_EVENTS_SUBSCRIBE=0).
 *
 * The endpoint is this service's loopback /internal/events (Events posts to http://127.0.0.1:<port> directly; nginx
 * answers 404 there), and the token is this service's own for audience openvibe.events with
 * scope events.subscription.manage.
 */
const { serviceAuth } = require('openvibe-contracts');
const { TOPICS } = require('./identity/account-data');

/** Create any missing subscription for TOPICS at Events (idempotent; retried in the background at boot). */
function startSubscriptions({ config, port, secret, eventsUrl = config.events.url, fetchImpl = globalThis.fetch, log = console }) {
    if (!eventsUrl || !secret || !config.oauth.clientSecret || process.env.ACTOR_EVENTS_SUBSCRIBE === '0') return null;
    const base = String(eventsUrl).replace(/\/+$/, '');
    const endpoint = config.events.endpoint || `http://127.0.0.1:${port}/internal/events`;
    const tokens = serviceAuth.createTokenClient({ tokenUrl: `${config.networkInternalUrl}/oauth/token`, clientId: config.oauth.clientId, clientSecret: config.oauth.clientSecret, audience: 'openvibe.events', scope: 'events.subscription.manage', fetchImpl });
    const call = async (method, path, body) => {
        const res = await fetchImpl(`${base}${path}`, { method, headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}), ...(await tokens.authHeaders()) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000) });
        const json = await res.json().catch(() => ({}));
        return { status: res.status, ok: res.ok, body: json };
    };
    const attempt = async () => {
        const listed = await call('GET', '/api/v1/subscriptions');
        if (!listed.ok) throw new Error(`listing subscriptions: ${listed.status}`);
        const mine = (listed.body.subscriptions || []).filter((s) => s.endpoint === endpoint);
        for (const topic of TOPICS) {
            if (mine.some((s) => s.topic_pattern === topic)) continue;
            const r = await call('POST', '/api/v1/subscriptions', { topic_pattern: topic, endpoint, secret });
            if (!r.ok && r.status !== 409) throw new Error(`subscribing to ${topic}: ${r.status} ${r.body.code || ''}`);
            if (r.ok) log.log(`[Events consumer] subscription created: ${r.body.id} (${topic} → ${endpoint})`);
        }
    };
    const delays = [0, 10_000, 60_000, 5 * 60_000, 15 * 60_000];
    let i = 0;
    let timer = null;
    let stopped = false;
    const run = () => { timer = null; if (stopped) return; attempt().catch((err) => {
        if (stopped) return;
        if (++i < delays.length) { timer = setTimeout(run, delays[i]); if (timer.unref) timer.unref(); } else log.warn('[Events consumer] subscriptions not created:', err.message);
    }); };
    timer = setTimeout(run, delays[0]); if (timer.unref) timer.unref();
    // Graceful stop: no further attempts (they run again at the next start).
    return { topics: TOPICS, endpoint, stop() { stopped = true; if (timer) clearTimeout(timer); timer = null; } };
}

module.exports = { startSubscriptions, TOPICS };

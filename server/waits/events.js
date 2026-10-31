'use strict';

/**
 * The Events side of a wait (plan A2): one subscription per topic pattern (never one per wait) and one cursor per
 * topic, the two halves OpenVibe.Events offers a consumer.
 *
 * The push path is the normal one: Events posts each matching event to this service's loopback /internal/events,
 * where the SDK's account-data consumer verifies the signature and hands the event to server/waits/index.js.
 *
 * The sweep is the recovery path: a service that was down, a delivery that failed, or a wait created while a
 * delivery was in flight would otherwise be missed. The sweep reads the topics that have open waits with the
 * stored cursor and hands the events to the same matcher. A position is only ever an opaque cursor
 * (OpenVibe.Events server/cursor.js): it is handed back and never parsed.
 */
const { serviceAuth } = require('openvibe-contracts');

function createEventClient({ config, port, secret, fetchImpl = globalThis.fetch, log = console }) {
    const base = String(config.events.url || '').replace(/\/+$/, '');
    const endpoint = config.events.endpoint || `http://127.0.0.1:${port}/internal/events`;
    const enabled = Boolean(base && secret && config.oauth.clientSecret) && process.env.ACTOR_EVENTS_SUBSCRIBE !== '0';
    let tokens = null;
    const auth = async () => {
        if (!tokens) {
            tokens = serviceAuth.createTokenClient({
                tokenUrl: `${config.networkInternalUrl}/oauth/token`,
                clientId: config.oauth.clientId,
                clientSecret: config.oauth.clientSecret,
                audience: 'openvibe.events',
                scope: 'events.subscription.manage events.event.read',
                fetchImpl,
            });
        }
        return tokens.authHeaders();
    };
    const call = async (method, path, body) => {
        const res = await fetchImpl(`${base}${path}`, {
            method,
            headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}), ...(await auth()) },
            body: body ? JSON.stringify(body) : undefined,
            signal: AbortSignal.timeout(15000),
        });
        const json = await res.json().catch(() => ({}));
        return { status: res.status, ok: res.ok, body: json };
    };
    return {
        enabled,
        endpoint,
        /** The subscriptions this service already has at Events (for the ones it owns). */
        async list() {
            const r = await call('GET', '/api/v1/subscriptions');
            if (!r.ok) throw new Error(`listing subscriptions: ${r.status}`);
            return (r.body.subscriptions || []).filter((s) => s.endpoint === endpoint);
        },
        /** One subscription per topic pattern; a duplicate (409) is the same subscription. */
        async subscribe(topic) {
            const mine = await this.list();
            if (mine.some((s) => s.topic_pattern === topic)) return { ok: true, existed: true };
            const r = await call('POST', '/api/v1/subscriptions', { topic_pattern: topic, endpoint, secret });
            if (!r.ok && r.status !== 409) throw new Error(`subscribing to ${topic}: ${r.status} ${r.body.code || ''}`);
            if (r.ok) log.log(`[Actor waits] subscription created: ${r.body.id} (${topic})`);
            return { ok: true, existed: false };
        },
        /** A page of events for one topic, from the cursor. */
        async read(topic, cursor, limit = 100) {
            const q = new URLSearchParams({ topic, limit: String(limit) });
            if (cursor) q.set('after', cursor);
            const r = await call('GET', `/api/v1/events?${q.toString()}`);
            if (!r.ok) throw new Error(`reading ${topic}: ${r.status} ${r.body.code || ''}`);
            return r.body || {};
        },
    };
}

module.exports = { createEventClient };

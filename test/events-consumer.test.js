'use strict';
/**
 * The agent's steps (design 2026-11-07): Actor subscribes to agent.step.* at OpenVibe.Events, beside the ADR-033
 * account topics, as one plain string pattern. (The first version nested the list, so Events was asked for
 * topic_pattern ["agent.step.*"] and refused it; no timeline row could ever arrive.)
 *
 *   node test/events-consumer.test.js
 */
const assert = require('assert');
const { startSubscriptions } = require('../server/events-consumer');
const { TOPICS } = require('../server/identity/account-data');

const ENDPOINT = 'http://127.0.0.1:4950/internal/events';
const CONFIG = {
    events: { url: 'http://events.test', endpoint: ENDPOINT },
    oauth: { clientId: 'actor', clientSecret: 'test-secret' },
    networkInternalUrl: 'http://network.test',
};

const posted = [];
const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    const reply = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
    if (u.endsWith('/oauth/token')) return reply({ access_token: 'tok', expires_in: 300 });
    const method = init.method || 'GET';
    if (u.endsWith('/api/v1/subscriptions') && method === 'GET') return reply({ subscriptions: [] });
    if (u.endsWith('/api/v1/subscriptions') && method === 'POST') {
        const body = JSON.parse(init.body);
        posted.push(body.topic_pattern);
        return reply({ id: `sub_${posted.length}` }, 201);
    }
    return reply({}, 404);
};

(async () => {
    const s = startSubscriptions({ config: CONFIG, port: 4950, secret: 'events-secret', fetchImpl, log: { log() {}, warn() {} } });
    assert.ok(s, 'it starts when the events URL and the OAuth secret are set');
    await new Promise((r) => setTimeout(r, 50));
    s.stop();

    assert.deepStrictEqual(posted, [...TOPICS, 'agent.step.*'], 'the account topics first, then the agent namespace');
    assert.ok(posted.includes('agent.step.*'), 'agent.step.* is one topic string');
    assert.ok(posted.every((t) => typeof t === 'string' && t.length > 0), 'every topic is a string, never a list');
    assert.deepStrictEqual(s.topics, [...TOPICS, 'agent.step.*'], 'the started consumer reports what it subscribes to');
    console.log('events consumer: Actor subscribes to agent.step.* beside the account topics');
    console.log('all passed');
})().catch((e) => { console.error(e); process.exit(1); });

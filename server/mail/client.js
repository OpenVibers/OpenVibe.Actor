'use strict';

/**
 * OpenVibe.Mail, from Actor: the two calls an agent's answer needs (track HO6).
 *
 *   ensureInbox({ person, agentId })            → mail.agent-inbox@1, made if it is not there yet
 *   getAnswering({ person, agentId })           → mail.inbox-answering@1 (the switch, off by default)
 *   setAnswering({ person, agentId, enabled })  → mail.inbox-answering@1 after the person's decision
 *   getMessage({ person, agentId, messageId })  → mail.agent-inbox-message@1 | null
 *   reply({ person, agentId, messageId, body }) → mail.agent-reply-result@1 (+ a code on the closed case)
 *   canSendOutside()                            → whether Mail may send outside OpenVibe at all
 *
 * All are loopback calls under Actor's own service token (audience openvibe.mail, the capabilities
 * mail.agent.read, mail.agent.reply and mail.agent.answering), with the person in X-OV-Subject — the house pattern Watch, Chat and Space
 * already use for "this service acts for that person". Mail checks that the inbox is one of that person's and that
 * the letter was delivered to that address; anything else is a 404 there.
 *
 * `canSendOutside` matters to the wording of the approval: Mail cannot send outside OpenVibe yet (plan M2), so the
 * card must say the reply waits rather than promise a send that cannot happen.
 */
const { serviceAuth } = require('openvibe-contracts');

const TIMEOUT_MS = 15_000;
const CACHE = new WeakMap();

function createMailClient({ config, fetchImpl = globalThis.fetch, tokens: tokensOverride = null } = {}) {
    const base = String((config.services && config.services.mailUrl) || '').replace(/\/+$/, '');
    const clientSecret = config.oauth && config.oauth.clientSecret;
    const enabled = Boolean(base && (tokensOverride || clientSecret));
    const tokens = !enabled ? null : tokensOverride || serviceAuth.createTokenClient({
        tokenUrl: `${config.networkInternalUrl}/oauth/token`, clientId: config.oauth.clientId, clientSecret,
        audience: 'openvibe.mail', scope: 'mail.agent.read mail.agent.reply mail.agent.answering', fetchImpl,
    });

    async function call(method, path, { person = null, body = undefined } = {}) {
        if (!enabled) return { ok: false, status: 503, code: 'mail.off', error: 'OpenVibe.Mail is not connected to this server' };
        const headers = { Accept: 'application/json', ...(await tokens.authHeaders()) };
        if (person) headers['X-OV-Subject'] = person;
        if (body !== undefined) headers['Content-Type'] = 'application/json';
        let res;
        try {
            res = await fetchImpl(`${base}${path}`, {
                method, headers,
                body: body === undefined ? undefined : JSON.stringify(body),
                signal: AbortSignal.timeout(TIMEOUT_MS),
            });
        } catch (err) {
            return { ok: false, status: 502, code: 'mail.unreachable', error: `OpenVibe.Mail did not answer: ${(err && err.message) || err}` };
        }
        const text = await res.text().catch(() => '');
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch { data = null; }
        if (!res.ok) {
            return {
                ok: false, status: res.status,
                code: (data && data.code) || 'mail.refused',
                error: String((data && (data.detail || data.reason || data.title)) || text || `Mail answered ${res.status}`).slice(0, 300),
                data,
            };
        }
        return { ok: true, status: res.status, data };
    }

    return {
        enabled,
        getMessage: (args) => call('GET', `/internal/mail/agents/${encodeURIComponent(args.agentId)}/messages/${encodeURIComponent(args.messageId)}`, { person: args.person }),
        /** Mail knows the owner's mailbox, masks, burners and agent addresses; Actor never guesses from a domain. */
        ownsSender: (args) => call('GET', `/internal/mail/agents/${encodeURIComponent(args.agentId)}/own-sender?address=${encodeURIComponent(args.address)}`, { person: args.person }),
        reply: (args) => call('POST', `/internal/mail/agents/${encodeURIComponent(args.agentId)}/reply`, {
            person: args.person,
            body: { message_id: args.messageId, body: args.body, ...(args.to ? { to: args.to } : {}) },
        }),
        /** Make the agent's inbox (idempotent) and answer { agent_inbox } — the address the page shows. */
        ensureInbox: (args) => call('POST', `/internal/mail/agents/${encodeURIComponent(args.agentId)}/inbox`, { person: args.person }),
        /** The switch for one agent's inbox: { enabled, address, changed_at } or null. */
        getAnswering: (args) => call('GET', `/internal/mail/agents/${encodeURIComponent(args.agentId)}/answering`, { person: args.person }),
        setAnswering: (args) => call('PUT', `/internal/mail/agents/${encodeURIComponent(args.agentId)}/answering`, { person: args.person, body: { enabled: Boolean(args.enabled) } }),
        async canSendOutside() {
            const out = await call('GET', '/internal/mail/outbound');
            // Unknown is treated as "cannot": the card then says the reply waits, which is true either way.
            return { enabled: Boolean(out.ok && out.data && out.data.enabled), reason: (out.ok && out.data && out.data.reason) || null };
        },
    };
}

/** One client per config, so every run shares the cached token. */
function mailFor(ctx) {
    const config = ctx.config;
    const fetchImpl = ctx.mailFetch || ctx.fetch || globalThis.fetch;
    let byFetch = CACHE.get(config);
    if (!byFetch) { byFetch = new WeakMap(); CACHE.set(config, byFetch); }
    if (!byFetch.has(fetchImpl)) byFetch.set(fetchImpl, createMailClient({ config, fetchImpl, tokens: ctx.mailTokens || null }));
    return byFetch.get(fetchImpl);
}

module.exports = { createMailClient, mailFor };

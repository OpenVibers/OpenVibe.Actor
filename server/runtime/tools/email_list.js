'use strict';

/**
 * The newest messages of the person's own mailbox (OpenVibe.Mail), read with the person's own token.
 * A list is a read: it changes nothing, so a resume may run it again.
 */

const { mailFor, personOf } = require('./_mail');

/** The most a list brings back. */
const MAX_LIST = 25;

module.exports = {
    name: 'email_list',
    description: 'List the newest messages in your OpenVibe.Mail inbox. Answers each message\'s sender, subject, date, id and whether it is unread. At most 25 messages; leave limit out for 10.',
    input: {
        type: 'object',
        properties: {
            limit: { type: 'integer', description: 'how many messages to answer, at most 25 (default 10)' },
            unread: { type: 'boolean', description: 'only the messages you have not read yet' },
        },
    },
    scope: 'person',
    needs: { files: 'read', network: false },   // plan 11c: OpenVibe's own service, not the open web
    connector: 'email',
    costUsd: 0,
    timeoutMs: 30_000,
    available: (ctx) => Boolean(ctx.config && ctx.config.services && ctx.config.services.mailUrl && personOf(ctx.requester)),
    async run(input, ctx) {
        const person = personOf(ctx.requester);
        const mail = mailFor(ctx, person);
        if (!mail.enabled) return { text: JSON.stringify({ error: mail.reason }), isError: true };
        const asked = Number(input && input.limit);
        const limit = Math.min(MAX_LIST, Math.max(1, Number.isFinite(asked) && asked > 0 ? Math.floor(asked) : 10));
        const unreadOnly = input && input.unread === true;
        const out = await mail.call('GET', '/api/v1/me/mail/messages');
        if (!out.ok) return { text: JSON.stringify({ error: out.error }), isError: true };
        const all = (out.data && Array.isArray(out.data.messages) ? out.data.messages : [])
            .filter((m) => m && typeof m.id === 'string')
            .map((m) => ({
                id: m.id, from: Array.isArray(m.from) ? m.from : (m.from ? [m.from] : []),
                subject: m.subject || null, received_at: m.received_at || null, unread: m.unread !== false,
            }));
        const messages = (unreadOnly ? all.filter((m) => m.unread) : all).slice(0, limit);
        return {
            text: JSON.stringify({ messages, unread_only: unreadOnly, limit }),
            data: { messages },
        };
    },
};

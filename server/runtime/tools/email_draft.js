'use strict';

/**
 * A draft reply for the person's own mailbox (OpenVibe.Mail), written by the agent and sent by the person.
 *
 * Nothing leaves: the tool never calls a send route, never queues a message and never touches an outbox. It
 * only makes the draft and shows it as a card, so the person reads it, copies it and sends it in Mail
 * themselves. That is why the tool does not act.
 *
 * Mail's composer is a dialog inside its inbox page: there is no route that takes a draft as a query and opens
 * the composer with it filled. The card therefore carries the three fields to copy and the link to the inbox (and
 * to the message it answers, when there is one), and the run says in one line that the person sends it.
 */

const { mailFor, mailPublicUrl, personOf } = require('./_mail');

module.exports = {
    name: 'email_draft',
    description: 'Write a draft for the person to send in OpenVibe.Mail: give the recipient, the subject and the text (and the message id it answers, if it is a reply). Nothing is sent: the draft comes back as a card with the fields to copy and a link to your inbox, and the person sends it themselves.',
    input: {
        type: 'object',
        properties: {
            to: { type: 'string', description: 'the recipient address (or several, separated by commas)' },
            subject: { type: 'string', description: 'the subject of the draft' },
            body: { type: 'string', description: 'the text of the draft, in plain words' },
            reply_to_id: { type: 'string', description: 'the message id this draft answers (from email_list); the recipient and subject are filled from it' },
        },
        required: ['body'],
    },
    scope: 'person',
    needs: { files: 'read', network: false },   // plan 11c: OpenVibe's own service, not the open web
    connector: 'email',
    acts: false,   // nothing leaves: the person sends the draft in Mail
    costUsd: 0,
    timeoutMs: 30_000,
    available: (ctx) => Boolean(ctx.config && ctx.config.services && ctx.config.services.mailUrl && personOf(ctx.requester)),
    async run(input, ctx) {
        const person = personOf(ctx.requester);
        const mail = mailFor(ctx, person);
        if (!mail.enabled) return { text: JSON.stringify({ error: mail.reason }), isError: true };
        const body = String((input && input.body) || '');
        if (!body.trim()) return { text: JSON.stringify({ error: 'a draft needs a body' }), isError: true };
        let to = String((input && input.to) || '').trim();
        let subject = String((input && input.subject) || '').trim();
        const replyTo = String((input && input.reply_to_id) || '').trim();

        // A reply takes the recipient and the subject from the letter it answers (a read, never a send).
        if (replyTo) {
            const out = await mail.call('GET', '/api/v1/me/mail/messages/' + encodeURIComponent(replyTo));
            if (!out.ok) return { text: JSON.stringify({ error: out.error }), isError: true };
            const m = (out.data && out.data.message) || null;
            if (!m) return { text: JSON.stringify({ error: 'there is no message ' + replyTo + ' in your inbox' }), isError: true };
            if (!to) {
                const from = Array.isArray(m.from) ? m.from : [];
                const first = String(from[0] || '');
                const angle = /<([^<>\s]+)>/.exec(first);
                to = (angle ? angle[1] : first).trim();
            }
            if (!subject && m.subject) subject = /^re:/i.test(m.subject) ? m.subject : 'Re: ' + m.subject;
        }
        if (!to) return { text: JSON.stringify({ error: 'name the recipient of the draft' }), isError: true };

        const inbox = mailPublicUrl(ctx) + '/inbox';
        const link = replyTo ? inbox + '/' + encodeURIComponent(replyTo) : inbox;
        const draft = {
            to, subject, body,
            reply_to_id: replyTo || null,
            mail_url: link,
            // Mail has no route that opens its composer with a draft filled in, so the card carries the fields
            // to copy and the link to the inbox (and to the letter, for a reply).
            prefilled: false,
            note: 'The person sends this themselves: copy the three fields into their inbox, or open the message it answers and press reply.',
        };
        const line = 'A draft is ready for you to send in OpenVibe.Mail (nothing was sent): to ' + to
            + (subject ? ', subject "' + subject + '"' : '') + '. Open ' + link + ' and paste the text, or press reply on the message it answers.';
        if (ctx.emit) await ctx.emit({ step: 'text', text: line });
        return { text: line, data: { draft } };
    },
};

'use strict';

/**
 * An agent answers the mail sent to its own address (track HO6, channels, step 2 — Actor's half).
 *
 * Mail publishes mail.agent_inbox.received for an inbox whose answering switch the person turned on. This module
 * takes that event and, for one letter:
 *
 *   1. decides whether to start anything at all: the person's switch (off by default), the two hourly windows the
 *      brief names (20 letters per inbox, 5 per sender), and that the agent still exists and is theirs;
 *   2. runs THAT agent for its owner, with the letter as INPUT DATA under the data note (server/mail/prompt.js): the
 *      agent's own instructions and level apply, and nothing the letter says can change either;
 *   3. turns the answer into a reply. A reply to one of the owner's own openvibe.email addresses is sent directly
 *      (Mail delivers it locally). A reply to anyone else is an HO1 approval of kind "send", with the draft shown:
 *      it stays pending, and until Mail may send outside OpenVibe the card says plainly that the reply waits there.
 *
 * One thread per mail conversation: the thread key is the Message-ID chain's root, and each new run continues from
 * the thread's previous task, so a back-and-forth keeps its memory. The message id is the primary key of the run
 * row, so a redelivery never makes a second run.
 */
const { mailFor } = require('./client');
const { mailInput, MAIL_NOTE } = require('./prompt');
const store = require('./store');
const approvals = require('../agents/approvals');
const contacts = require('../agents/contacts');
const personal = require('../agents/personal');

const PER_INBOX_PER_HOUR = 20;
const PER_SENDER_PER_HOUR = 5;
const MAX_EXCERPT = 4000;
const MAX_REPLY = 10000;

/** "user:usr_…" ↔ "usr_…". */
const subjectOf = (owner) => String(owner || '').replace(/^user:/, '');
const requesterOf = (subject) => (String(subject || '').startsWith('user:') ? String(subject) : `user:${subject}`);
const USA = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;
const AGENT = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
const ADDRESS = /^[^\s@<>,;:"]+@[^\s@<>,;:"]+$/;

/** The agent's name as an address label: lowercased, letters, digits and hyphens, exactly as Mail cleans it. */
const slugOf = (name) => String(name || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 32);

/** The answer as plain text a mail can carry: no markdown fences, no headings, no evidence markers. */
function plainAnswer(text) {
    return String(text || '')
        .replace(/\s*\[E\d{1,3}(?:\s*,\s*E\d{1,3})*\]/g, '')
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/^#{1,6}\s*/gm, '')
        .replace(/\*\*([^*]+)\*\*/g, '$1')
        .replace(/^\s*Sources?\s*:?\s*$[\s\S]*$/im, '')
        .replace(/\s+([.,!?;:])/g, '$1')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
        .slice(0, MAX_REPLY);
}

/** The letter as Mail's event gave it, or null when the event is not one Actor takes. */
function parseEvent(ev) {
    if (!ev || ev.event_type !== 'mail.agent_inbox.received') return null;
    const p = ev.payload || {};
    if (!USA.test(String(p.owner || ''))) return null;
    // Mail's own ids: the inbox is the row Mail made, the agent is the name in the address. Actor never trusts a
    // sender-written address here, only the inbox the mail server stamped at delivery.
    if (!store.AGI.test(String(p.inbox_id || ''))) return null;
    if (typeof p.agent_id !== 'string' || !AGENT.test(p.agent_id)) return null;
    if (typeof p.message_id !== 'string' || !p.message_id) return null;
    const from = String(p.from || '').trim().toLowerCase();
    if (!ADDRESS.test(from)) return null;
    return {
        owner: requesterOf(p.owner),
        inboxId: p.inbox_id,
        inbox: String(p.inbox || ''),
        agentName: p.agent_id,
        messageId: p.message_id,
        from,
        subject: typeof p.subject === 'string' ? p.subject.slice(0, 2000) : null,
        excerpt: String(p.excerpt || '').slice(0, MAX_EXCERPT),
        receivedAt: p.received_at || null,
    };
}

/**
 * Is this address one of the owner's own openvibe.email addresses? Then a reply to it never leaves the host, so it
 * is sent directly instead of asking. The domains come from the same configuration Mail hands out.
 */
function isOwnAddress(address, config) {
    const at = String(address || '').lastIndexOf('@');
    if (at < 0) return false;
    const domain = String(address).slice(at + 1).toLowerCase();
    const addresses = config.mail && config.mail.addresses;
    if (!addresses) return false;
    return [addresses.base, addresses.mask, ...(addresses.burners || [])].filter(Boolean).some((d) => String(d).toLowerCase() === domain);
}

function createAgentMail(ctx) {
    const { s, config, engine, webhooks, notifier, log = console } = ctx;
    const mail = mailFor(ctx);
    const now = () => (typeof s.now === 'function' ? s.now() : Date.now());

    /** The agent the inbox belongs to, as Actor knows it: by the agent's name in the address, for its owner. */
    async function agentOf(owner, agentName) {
        const rows = await s.db.many('SELECT * FROM actor_agents WHERE owner = $1', [owner]);
        const wanted = String(agentName || '').toLowerCase();
        // The event carries the agent's NAME IN THE ADDRESS (Mail cleaned it from the agent's name), not agt_…:
        // compare the same way Mail made the address, so "Helper Bot" finds helper-bot.
        const found = rows.find((row) => slugOf(row.name) === wanted);
        return found || null;
    }

    /** The letter in full, or null. Mail resolves whose it is; a 404 there is a letter Actor may not read. */
    async function readLetter({ person, agentName, messageId }) {
        const out = await mail.getMessage({ person, agentId: agentName, messageId });
        return out.ok ? out.data : null;
    }

    /**
     * The consumer's hook. Answers a short outcome for Events (`task`, `ignored:…`, `refused:…`), never a body.
     * `onEvent` is called by the SDK consumer in server/app.js for mail.agent_inbox.received.
     */
    async function onEvent(ev) {
        if (!config.mail || config.mail.answers === false) return 'ignored:mail_answers_off';
        const letter = parseEvent(ev);
        if (!letter) return 'ignored:not_mail';
        const owner = letter.owner;

        // The switch: Actor answers only for an inbox the person turned on. Mail already decides this; Actor checks
        // its own copy, because the event can arrive after the person turned it off.
        const row = await store.getInbox({ s, owner, inboxId: letter.inboxId });
        if (row && row.enabled === false) return 'ignored:switched_off';

        const agent = await agentOf(owner, letter.agentName);
        if (!agent) return 'ignored:no_agent';
        const agentId = agent.id;

        // One row per letter: the insert is the test, so a redelivery makes no second run.
        const threadKey = await store.threadKeyFor({ s, owner, inboxId: letter.inboxId, chain: [], messageId: letter.messageId });
        const claimed = await store.claimRun({
            s, owner, inboxId: letter.inboxId, agentId, messageId: letter.messageId,
            threadKey, peer: letter.from, subject: letter.subject,
        });
        if (!claimed) return 'duplicate';

        // The brief's two windows, per inbox and per sender, per hour.
        const inHour = await store.countLastHour({ s, owner, inboxId: letter.inboxId, now: now() });
        if (inHour > PER_INBOX_PER_HOUR) {
            await store.settle({ s, messageId: letter.messageId, state: 'refused', reason: `this inbox took ${PER_INBOX_PER_HOUR} letters this hour` });
            return 'refused:inbox_hourly';
        }
        const fromSender = await store.countLastHour({ s, owner, inboxId: letter.inboxId, peer: letter.from, now: now() });
        if (fromSender > PER_SENDER_PER_HOUR) {
            await store.settle({ s, messageId: letter.messageId, state: 'refused', reason: `this sender sent ${PER_SENDER_PER_HOUR} letters this hour` });
            return 'refused:sender_hourly';
        }

        // The whole letter, for the run. The excerpt is a header; the text is what the agent answers.
        const person = subjectOf(owner);
        const full = await readLetter({ person, agentName: letter.agentName, messageId: letter.messageId });
        if (!full) {
            await store.settle({ s, messageId: letter.messageId, state: 'failed', reason: 'Mail would not give the letter' });
            return 'ignored:unreadable';
        }
        if (full.spam) {
            await store.settle({ s, messageId: letter.messageId, state: 'refused', reason: 'the mail server marked it as spam' });
            return 'refused:spam';
        }

        const thread = await store.threadKeyFor({
            s, owner, inboxId: letter.inboxId,
            chain: Array.isArray(full.references) ? full.references : [],
            messageId: full.message_id, inReplyTo: full.in_reply_to || null,
        }).catch(() => threadKey);
        await s.db.query('UPDATE actor_mail_runs SET thread_key = $2, message_rfc_id = $3 WHERE message_id = $1', [letter.messageId, thread, full.message_id || null]);
        await store.ensureThread({ s, owner, threadKey: thread, inboxId: letter.inboxId, agentId, peer: letter.from });

        // Continue the thread: the previous run's answer is the context, and the task is its child, so the memory
        // and the level chain stay the thread's own.
        const prior = await store.threadTask(s, owner, thread).catch(() => null);
        const parentId = prior && prior.task_id && prior.task_id !== null ? prior.task_id : null;

        // The letter is the run's INPUT DATA, under the data note. The agent's own instructions and level are what
        // they always were; nothing in the letter can raise either.
        const input = mailInput({ from: full.from && full.from[0] ? full.from[0] : letter.from, subject: full.subject, text: full.text, excerpt: letter.excerpt });
        // 'routine' is the origin that CAPS a run at the level it was made with: a stranger's letter may never lend
        // the agent more autonomy than the person gave it. (A 'person' origin would pass the thread's level down.)
        const out = await personal.run(ctx, agent, input, {
            origin: 'routine',
            level: agent.level || 'ask',
            parentId,
            mailNote: MAIL_NOTE,
        });
        if (!out || !out.task) {
            await store.settle({ s, messageId: letter.messageId, state: 'failed', reason: (out && out.detail) || 'the run did not start' });
            return 'refused:run';
        }
        await store.settle({ s, messageId: letter.messageId, state: 'queued', taskId: out.task.id });
        await store.linkThread({ s, owner, threadKey: thread, taskId: out.task.id });
        // Mail is the authority for the owner's exact mailbox, mask, burner and agent addresses.
        // A shared domain alone would let somebody else's letter wake a standing intent.
        const ownSender = ctx.triggers && ctx.triggers.onMessage
            ? await mail.ownsSender({ person, agentId: letter.agentName, address: letter.from }) : null;
        if (ownSender && ownSender.ok && ownSender.data && ownSender.data.owned === true) {
            await ctx.triggers.onMessage({ owner: subjectOf(owner), agentId, text: String(full.text || ''),
                conversation: `mail:${thread}`, turnTaskId: out.task.id, place: `email to ${agent.name}` });
        }
        return 'task';
    }

    /**
     * A run that started for a letter ended: turn its answer into a reply, or into the person's approval.
     * The engine calls this from setState (server/tasks/engine.js), for a task whose mail run row says queued.
     */
    async function answered(task) {
        if (!task || !task.id) return null;
        const run = await s.db.maybe("SELECT * FROM actor_mail_runs WHERE task_id = $1 AND reply_state = 'queued'", [task.id]);
        if (!run) return null;
        if (task.state === 'failed' || task.state === 'cancelled') {
            return store.settle({ s, messageId: run.message_id, state: 'failed', reason: String(task.error_detail || task.state).slice(0, 300) });
        }
        if (task.state !== 'succeeded') return null;

        const result = typeof task.result === 'string' ? JSON.parse(task.result || '{}') : (task.result || {});
        const text = plainAnswer(result.answer);
        if (!text) return store.settle({ s, messageId: run.message_id, state: 'failed', reason: 'the answer was empty' });

        const owner = run.owner;
        const person = subjectOf(owner);
        const agentRow = await contacts.get(s, owner, run.agent_id);
        const agentName = agentRow ? slugOf(agentRow.name) : null;
        if (!agentName) return store.settle({ s, messageId: run.message_id, state: 'failed', reason: 'the agent has no mail address' });

        // To one of the owner's own addresses: send it, no approval needed (it never leaves the host).
        if (isOwnAddress(run.peer, config)) {
            const sent = await mail.reply({ person, agentId: agentName, messageId: run.message_id, body: text });
            if (sent.ok && sent.data && sent.data.sent) {
                return store.settle({ s, messageId: run.message_id, state: 'sent', replyTo: run.peer });
            }
            return store.settle({ s, messageId: run.message_id, state: 'failed', reason: String((sent.error || (sent.data && sent.data.reason) || 'Mail refused the reply')).slice(0, 300) });
        }

        // To anyone else: the person's approval. It stays pending; approving it sends nothing more until Mail may
        // send outside OpenVibe, and the card says so.
        const canSend = await mail.canSendOutside().catch(() => ({ enabled: false, reason: null }));
        const summary = canSend.enabled
            ? `Reply to ${run.peer} as ${capital(agentName)}`
            : `Reply to ${run.peer} as ${capital(agentName)} (OpenVibe Mail cannot send outside OpenVibe yet: the reply waits here)`;
        const ask = await approvals.request(s, {
            owner,
            agentId: run.agent_id,
            taskId: task.id,
            kind: 'send',
            summary,
            target: null,
            payload: {
                to: run.peer,
                subject: run.subject ? `Re: ${run.subject}` : null,
                draft: text,
                agent: agentName,
                inbox: run.inbox_id,
                message_id: run.message_id,
                outbound: canSend.enabled ? 'open' : 'closed',
                note: canSend.enabled ? null : 'OpenVibe Mail cannot send outside OpenVibe yet: the reply waits here.',
            },
        });
        return store.settle({ s, messageId: run.message_id, state: 'awaiting_person', approvalId: ask.id, replyTo: run.peer });
    }

    /** Is this a mail reply whose sending Mail still refuses because outbound is off? Then nothing is sent, and the
     * person's yes must leave the request pending rather than pretend it went out. */
    async function replyWaits(row) {
        const p = typeof row.payload === 'string' ? JSON.parse(row.payload || '{}') : (row.payload || {});
        if (!p.inbox || !p.message_id || !p.draft || !p.agent) return false;
        const canSend = await mail.canSendOutside().catch(() => ({ enabled: false }));
        return !canSend.enabled;
    }

    /**
     * The person approved a send of a mail reply: send it now. Called from agents/approvals.js decide(), for a row
     * whose payload names an inbox and a message (a mail reply, not a chat send). Answers what happened.
     */
    async function sendApproved(owner, row) {
        const p = typeof row.payload === 'string' ? JSON.parse(row.payload || '{}') : (row.payload || {});
        if (!p.inbox || !p.message_id || !p.draft) return null;
        const run = await s.db.maybe('SELECT * FROM actor_mail_runs WHERE message_id = $1 AND owner = $2', [p.message_id, owner]);
        if (!run) return null;
        const agentName = p.agent || null;
        if (!agentName) return { sent: false, reason: 'the approval does not say which agent the reply is from' };
        const sent = await mail.reply({ person: subjectOf(owner), agentId: agentName, messageId: run.message_id, body: String(p.draft).slice(0, MAX_REPLY) });
        if (sent.ok && sent.data && sent.data.sent) {
            await store.settle({ s, messageId: run.message_id, state: 'sent', approvalId: row.id, replyTo: run.peer });
            return { sent: true };
        }
        const reason = String((sent.error || (sent.data && sent.data.reason) || 'Mail refused the reply')).slice(0, 300);
        // Mail still cannot send outside: the approval keeps its draft and says so; nothing is lost.
        const why = sent.data && sent.data.code === 'mail.outbound_closed' ? 'waiting' : 'refused';
        await store.settle({ s, messageId: run.message_id, state: why === 'waiting' ? 'awaiting_person' : 'refused', approvalId: row.id, reason });
        return { sent: false, waiting: why === 'waiting', reason };
    }

    const capital = (word) => (word ? word[0].toUpperCase() + word.slice(1) : word);

    /**
     * What the agent's page shows: the address and the switch. Mail is the authority on both, so this reads Mail and
     * mirrors the answer in Actor's own row (which the consumer checks, so a letter that was already in flight when
     * the person turned the switch off still starts nothing).
     */
    async function statusFor(owner, agentRow) {
        const person = subjectOf(owner);
        const slug = slugOf(agentRow.name);
        // Mail makes the address if it is not there yet, so the page always shows the one address Mail will read for
        // this agent. Making it is idempotent and does not turn answering on: the switch stays the person's.
        const made = await mail.ensureInbox({ person, agentId: slug });
        const inbox = made.ok && made.data ? (made.data.agent_inbox || made.data) : null;
        if (!inbox || !inbox.id) return { address: null, enabled: false, changed_at: null, inboxId: null, available: false };
        const out = await mail.getAnswering({ person, agentId: slug });
        const data = out.ok && out.data ? out.data : null;
        await store.setEnabled({ s, owner, inboxId: inbox.id, agentId: agentRow.id, address: inbox.address || (data && data.address) || '', enabled: Boolean(data && data.enabled) }).catch(() => null);
        return {
            address: (data && data.address) || inbox.address || null,
            enabled: Boolean(data && data.enabled),
            changed_at: (data && data.changed_at) || null,
            inboxId: inbox.id,
            available: Boolean(data),
        };
    }

    /** Turn the agent's answering on or off, in Mail first (the authority), then in Actor's copy. */
    async function setAnswering(owner, agentRow, enabled) {
        const person = subjectOf(owner);
        const slug = slugOf(agentRow.name);
        const made = await mail.ensureInbox({ person, agentId: slug });
        const inbox = made.ok && made.data ? (made.data.agent_inbox || made.data) : null;
        if (!inbox || !inbox.id) return { error: String(made.error || 'Mail did not answer') };
        const out = await mail.setAnswering({ person, agentId: slug, enabled });
        if (!out.ok || !out.data) return { error: String(out.error || 'Mail did not answer') };
        await store.setEnabled({ s, owner, inboxId: inbox.id, agentId: agentRow.id, address: out.data.address || '', enabled: Boolean(out.data.enabled) }).catch(() => null);
        return { enabled: Boolean(out.data.enabled), address: out.data.address || null };
    }

    return {
        onEvent, answered, sendApproved, replyWaits, statusFor, setAnswering, slugOf,
        parseEvent, plainAnswer, isOwnAddress, agentOf, readLetter,
        LIMITS: { PER_INBOX_PER_HOUR, PER_SENDER_PER_HOUR },
    };
}

module.exports = { createAgentMail, parseEvent, plainAnswer, isOwnAddress, slugOf, PER_INBOX_PER_HOUR, PER_SENDER_PER_HOUR, MAIL_NOTE };

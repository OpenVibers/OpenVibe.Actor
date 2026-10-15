'use strict';
/**
 * Ask Actor from chat (plan T17 "Reach"). A signed-in person writes "@actor <task>" in OpenVibe's global chat or in
 * their own channel's chat; OpenVibe.Chat publishes chat.message.created, Events delivers it to POST /internal/events,
 * and Actor runs the task as theirs (their free tier, their daily budget) and answers in the same room.
 *
 *   - Who: a person signed in (a usr_… subject and a Live user id), never a guest, a relayed external chatter
 *     (source_platform) or Actor itself. Where: the global chat, or the asker's own channel (no one else's).
 *   - What: the answer is posted where everyone reads it, so the task runs with public tools only: the engine refuses a
 *     robot, computer or coding task from chat (actor.task.not_public) and never offers the runtime the person's own
 *     robots or computers (tasks/engine.js, via 'chat').
 *   - How often: at most `perHour` asks per person and `allPerHour` across everyone; past either, one reply says so
 *     and further asks that hour are dropped quietly. The free tier's own limits apply on top.
 *   - The reply: the first lines of the answer (at most REPLY_MAX characters) and the task's page, addressed to the
 *     asker, answering their message. Replies are retried with backoff and given up after an hour.
 *
 * onEvent(event) is the consumer's hook for chat.message.created (other topics are not handed here); tick() posts
 * the replies that are due (started by server/index.js).
 */
const MENTION = /^\s*@actor\b[\s,:;-]*([\s\S]*)$/i;
const TASK_MIN = 3;
const TASK_MAX = 1000;
const REPLY_MAX = 420;
const OPEN = ['queued', 'running', 'verifying'];
const GIVE_UP_MS = 60 * 60_000;
const MAX_ATTEMPTS = 8;

/** The ask in a chat.message.created event, or null when it is not one Actor takes. */
function parseAsk(ev) {
    if (!ev || ev.event_type !== 'chat.message.created') return null;
    const p = ev.payload || {};
    if ((p.message_type || 'chat') !== 'chat' || p.source_platform || p.anon_id) return null;
    if (typeof p.user_subject !== 'string' || !/^usr_[0-9A-HJKMNP-TV-Z]{26}$/.test(p.user_subject)) return null;
    if (!Number.isSafeInteger(p.user_id) || p.user_id <= 0 || !Number.isSafeInteger(p.message_id) || p.message_id <= 0) return null;
    const room = p.room || {};
    let where;
    if (room.type === 'global') where = { type: 'global' };
    else if (room.type === 'channel' && room.channel_user_id === p.user_id) {
        where = { type: 'channel', channel_user_id: p.user_id, ...(Number.isSafeInteger(room.stream_id) ? { stream_id: room.stream_id } : {}) };
    } else return null;
    const m = MENTION.exec(String(p.text || ''));
    if (!m) return null;
    const task = m[1].trim();
    return { messageId: p.message_id, subject: p.user_subject, username: String(p.username || 'there').slice(0, 60), room: where, task };
}

/** Markdown to one plain line: no headings, emphasis, code fences or link syntax (the link text stays). */
function plain(md) {
    return String(md || '')
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
        .replace(/^#{1,6}\s*/gm, '')
        .replace(/^\s*(sources?|references?):?\s*$[\s\S]*/im, '')
        .replace(/[*_`>]+/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

/** At most `max` characters, cut at a sentence or word end, with an ellipsis when cut. */
function clip(text, max) {
    if (text.length <= max) return text;
    const cut = text.slice(0, max);
    const sentence = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
    if (sentence > max * 0.5) return cut.slice(0, sentence + 1);
    const space = cut.lastIndexOf(' ');
    return `${cut.slice(0, space > max * 0.5 ? space : max).trimEnd()}…`;
}

function createChatAsks({ s, config, createTask, chat, now = () => Date.now(), log = console }) {
    const iso = (ms = now()) => new Date(ms).toISOString();
    const taskUrl = (id) => `${config.baseUrl}/tasks/${id}`;
    let timer = null;
    let busy = false;

    async function countSince(requester, sinceMs) {
        const where = requester ? 'requester = $2 AND ' : '';
        const row = await s.db.maybe(`SELECT count(*)::int AS n FROM actor_chat_asks WHERE ${where}created_at >= $1`, requester ? [iso(sinceMs), requester] : [iso(sinceMs)]);
        return row ? Number(row.n) : 0;
    }
    async function refusedSince(requester, sinceMs, reason) {
        const row = await s.db.maybe('SELECT 1 AS x FROM actor_chat_asks WHERE requester = $1 AND created_at >= $2 AND refused = $3 LIMIT 1', [requester, iso(sinceMs), reason]);
        return !!row;
    }

    /** The consumer's hook: take an ask, once per chat message → the outcome Events is answered with. */
    async function onEvent(ev) {
        if (!config.chat.asks) return 'ignored:chat_asks_off';
        const ask = parseAsk(ev);
        if (!ask) return 'ignored:not_an_ask';
        const requester = `user:${ask.subject}`;
        const at = now();
        const inserted = await s.db.maybe(
            `INSERT INTO actor_chat_asks (message_id, requester, username, room, created_at) VALUES ($1, $2, $3, $4::jsonb, $5)
             ON CONFLICT (message_id) DO NOTHING RETURNING message_id`,
            [ask.messageId, requester, ask.username, JSON.stringify(ask.room), iso(at)]);
        if (!inserted) return 'duplicate';
        const refuse = async (reason, quietIfRepeated) => {
            const quiet = quietIfRepeated && await refusedSince(requester, at - 3600_000, reason);
            await s.db.query('UPDATE actor_chat_asks SET refused = $2, replied_at = $3 WHERE message_id = $1', [ask.messageId, reason, quiet ? iso(at) : null]);
            return quiet ? `refused:${reason}:quiet` : `refused:${reason}`;
        };
        if (ask.task.length < TASK_MIN) return refuse('empty', true);
        if (ask.task.length > TASK_MAX) return refuse('too_long', false);
        // The row just written counts, so "more than" the limit.
        if (await countSince(requester, at - 3600_000) > config.chat.perHour) return refuse('person_hourly', true);
        if (await countSince(null, at - 3600_000) > config.chat.allPerHour) return refuse('everyone_hourly', true);
        const principal = { kind: 'user', requester, via: 'chat', project: null, claims: {} };
        const out = await createTask({ principal, body: { task: ask.task, idempotency_key: `chat:${ask.messageId}` } });
        if (out.status === 201 || out.status === 200) {
            await s.db.query('UPDATE actor_chat_asks SET task_id = $2 WHERE message_id = $1', [ask.messageId, out.task.id]);
            return 'task';
        }
        await s.db.query('UPDATE actor_chat_asks SET refused = $2 WHERE message_id = $1', [ask.messageId, `tier:${String(out.detail || out.code || 'refused').slice(0, 300)}`]);
        return `refused:${out.code || 'tier'}`;
    }

    const REFUSALS = {
        empty: 'ask me something after @actor, for example "@actor what is WHIP?"',
        too_long: `that is longer than ${TASK_MAX} characters; ask on ${config.baseUrl} instead`,
        person_hourly: `that is ${config.chat.perHour} questions this hour; ask again later, or on ${config.baseUrl}`,
        everyone_hourly: `I have answered a lot in chat this hour; try again later, or ask on ${config.baseUrl}`,
    };

    /** The reply for one ask whose task ended (or that was refused). */
    function replyText(row) {
        const to = `@${row.username}`;
        if (row.refused) {
            const why = row.refused.startsWith('tier:') ? row.refused.slice(5) : REFUSALS[row.refused] || 'I cannot take that right now';
            return `${to} ${why}`;
        }
        if (row.state === 'succeeded') {
            const result = typeof row.result === 'string' ? JSON.parse(row.result) : row.result || {};
            const answer = clip(plain(result.answer) || 'Done.', REPLY_MAX);
            return `${to} ${answer} (full answer: ${taskUrl(row.task_id)})`;
        }
        if (row.error_code === 'actor.task.not_public') {
            return `${to} from a public chat I only use public tools. To use your own computer, robots or code, ask me on ${config.baseUrl}`;
        }
        const why = clip(plain(row.error_detail || 'it did not finish'), 200);
        return `${to} I could not finish that: ${why} (${taskUrl(row.task_id)})`;
    }

    /** Post the replies that are due: refused asks at once, task asks once the task has ended. */
    async function tick() {
        if (busy || !chat.enabled) return 0;
        busy = true;
        let sent = 0;
        try {
            const due = await s.db.many(
                `SELECT a.*, t.state, t.result, t.error_code, t.error_detail FROM actor_chat_asks a LEFT JOIN tasks t ON t.id = a.task_id
                 WHERE a.replied_at IS NULL AND (a.next_attempt_at IS NULL OR a.next_attempt_at <= $1)
                   AND (a.refused IS NOT NULL OR (a.task_id IS NOT NULL AND t.state IS NOT NULL AND t.state <> ALL($2::text[])))
                 ORDER BY a.created_at LIMIT 10`, [iso(), OPEN]);
            for (const row of due) {
                const r = await chat.post({ key: `actor:ask:${row.message_id}`, room: typeof row.room === 'string' ? JSON.parse(row.room) : row.room, text: replyText(row), replyTo: Number(row.message_id) });
                if (r.ok) {
                    await s.db.query('UPDATE actor_chat_asks SET replied_at = $2, reply_error = NULL WHERE message_id = $1', [row.message_id, iso()]);
                    sent++;
                    continue;
                }
                const attempts = Number(row.reply_attempts) + 1;
                const late = now() - Date.parse(row.created_at) > GIVE_UP_MS;
                // A refusal Chat will never take back (4xx but 408/429) is given up at once; the rest back off.
                const final = late || attempts >= MAX_ATTEMPTS || (r.status >= 400 && r.status < 500 && r.status !== 408 && r.status !== 429);
                await s.db.query('UPDATE actor_chat_asks SET reply_attempts = $2, next_attempt_at = $3, reply_error = $4, replied_at = $5 WHERE message_id = $1',
                    [row.message_id, attempts, iso(now() + Math.min(600_000, 5000 * 2 ** attempts)), String(r.error || '').slice(0, 300), final ? iso() : null]);
                if (final) log.warn(`[Actor] chat reply to message ${row.message_id} given up: ${r.error}`);
            }
        } finally { busy = false; }
        return sent;
    }

    return {
        onEvent, tick, replyText,
        start() { if (!timer && config.chat.asks && chat.enabled) { timer = setInterval(() => { tick().catch((err) => log.warn(`[Actor] chat replies: ${err && err.message}`)); }, config.chat.replyIntervalMs); timer.unref(); } },
        stop() { if (timer) clearInterval(timer); timer = null; },
    };
}

module.exports = { createChatAsks, parseAsk, plain, clip, REPLY_MAX };

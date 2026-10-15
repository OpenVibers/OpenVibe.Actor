'use strict';
/**
 * Ask Actor from chat (plan T17 "Reach", server/chat/asks.js): "@actor …" in the global chat or the asker's own
 * channel becomes the asker's task, delivered as chat.message.created to POST /internal/events, and the answer is
 * posted back in the same room through Chat's service API, answering the message. Guests, relayed external chatters,
 * other people's channels and ordinary messages are ignored; a redelivery makes no second task; a robot, computer or
 * coding task from chat is refused (public tools only); the hourly limits answer once and then drop quietly; a reply
 * Chat refuses for now is retried.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const { signDeliveryHeaders } = require('openvibe-sdk/events');
const { parseAsk, plain, clip } = require('../server/chat/asks');

const SECRET = `whsec_${'fixture'.repeat(6)}`;
let n = 0;
const message = (user, text, { room = { type: 'global' }, ...extra } = {}) => {
    n += 1;
    return {
        event_id: `evt_01JZ00000000000000000C${String(n).padStart(4, '0')}`, event_type: 'chat.message.created', source: 'chat',
        payload: { message_id: 9000 + n, room, message_type: 'chat', user_id: user.id, user_subject: user.subject, anon_id: null, username: user.username, text, source_platform: null, reply_to_id: null, ...extra },
    };
};

(async () => {
    await check('which chat messages are asks', () => {
        const kim = { id: 7, subject: 'usr_01JZ0000000000000000000K1M', username: 'kim' };
        const ev = (text, extra) => message(kim, text, extra);
        assert.deepStrictEqual(parseAsk(ev('@actor what is WHIP?')), { messageId: 9000 + n, subject: kim.subject, username: 'kim', room: { type: 'global' }, task: 'what is WHIP?' });
        assert.strictEqual(parseAsk(ev('@Actor, summarise this week\'s news')).task, 'summarise this week\'s news');
        assert.deepStrictEqual(parseAsk(ev('@actor hi', { room: { type: 'channel', channel_user_id: 7, stream_id: 31 } })).room, { type: 'channel', channel_user_id: 7, stream_id: 31 }, 'their own channel');
        assert.strictEqual(parseAsk(ev('@actor hi', { room: { type: 'channel', channel_user_id: 8, stream_id: 2 } })), null, 'someone else\'s channel');
        assert.strictEqual(parseAsk(ev('hello @actor')), null, 'only at the start');
        assert.strictEqual(parseAsk(ev('@actors are great')), null);
        assert.strictEqual(parseAsk(ev('@actor hi', { source_platform: 'twitch' })), null, 'a relayed external chatter');
        assert.strictEqual(parseAsk(ev('@actor hi', { user_subject: null, user_id: null, anon_id: 'anon_1' })), null, 'a guest');
        assert.strictEqual(parseAsk(ev('@actor hi', { message_type: 'system' })), null);
        assert.strictEqual(parseAsk({ ...ev('@actor hi'), event_type: 'chat.message.deleted' }), null);
        assert.strictEqual(plain('## Title\n**WHIP** is [an ingest](https://x) protocol.\n\nSources:\n- https://x'), 'Title WHIP is an ingest protocol.');
        assert.strictEqual(clip('One. Two three four five six seven.', 20), 'One. Two three four…');
        assert.strictEqual(clip('The answer is yes. Then more words follow here.', 30), 'The answer is yes.');
        assert.strictEqual(clip('a'.repeat(30), 10), `${'a'.repeat(10)}…`);
    });

    const posted = [];
    let chatDown = false;
    const chatClient = { enabled: true, async post(m) { if (chatDown) return { ok: false, status: 503, error: 'down' }; posted.push(m); return { ok: true, status: 200, id: 1 }; } };
    const t = await boot({ env: { ACTOR_EVENTS_SECRET: SECRET, ACTOR_CHAT_ASKS_PER_HOUR: '3' }, chatClient });
    const kim = t.network.addUser('kim');
    const lee = t.network.addUser('lee');
    const ann = t.network.addUser('ann');
    const joe = t.network.addUser('joe');
    const deliver = async (ev) => {
        const body = JSON.stringify({ event: ev, seq: 1 });
        const r = await t.get('/internal/events', { method: 'POST', body, headers: { 'Content-Type': 'application/json', ...signDeliveryHeaders(body, SECRET) } });
        assert.strictEqual(r.status, 200, r.text);
        return r.json().outcome;
    };
    const askRow = (ev) => t.ctx.s.db.maybe('SELECT * FROM actor_chat_asks WHERE message_id = $1', [ev.payload.message_id]);

    let first;
    await check('an @actor message in the global chat becomes the asker\'s task, answered in the room', async () => {
        t.providers.reset();
        t.providers.state.cls = 'answer';
        first = message(kim, '@actor explain WHIP in one line');
        assert.strictEqual(await deliver(first), 'task');
        const row = await askRow(first);
        assert.match(row.task_id, /^tsk_/);
        const task = await t.waitFor(row.task_id);
        assert.deepStrictEqual([task.requester, task.via, task.task, task.state], [`user:${kim.subject}`, 'chat', 'explain WHIP in one line', 'succeeded']);
        assert.strictEqual(await t.ctx.chatAsks.tick(), 1);
        const reply = posted.at(-1);
        assert.deepStrictEqual([reply.key, reply.room, reply.replyTo], [`actor:ask:${first.payload.message_id}`, { type: 'global' }, first.payload.message_id]);
        assert.match(reply.text, new RegExp(`^@kim .+ \\(full answer: https://openvibe\\.actor/tasks/${row.task_id}\\)$`));
        assert.ok(reply.text.length < 600);
        assert.ok((await askRow(first)).replied_at, 'replied once');
        assert.strictEqual(await t.ctx.chatAsks.tick(), 0, 'and not again');
    });

    await check('the runtime is never handed the asker for its tools: no robots or computers of theirs are offered', async () => {
        const run = t.ctx.adapters.run;
        const real = run['openvibe-runtime'];
        const seen = [];
        run['openvibe-runtime'] = (args) => { seen.push(args.requester); return real(args); };
        try {
            t.providers.reset();
            t.providers.state.cls = 'lookup';
            const ev = message(joe, '@actor who handles mail for openvibe.network?');
            assert.strictEqual(await deliver(ev), 'task');
            const task = await t.waitFor((await askRow(ev)).task_id);
            assert.strictEqual(task.state, 'succeeded', task.error_detail);
            assert.deepStrictEqual(seen, [null], 'from chat: no requester for the tools');
            t.providers.state.cls = 'lookup';
            const api = await t.get('/api/v1/tasks', { as: joe, json: { task: 'Who handles mail for openvibe.network?' }, headers: { 'sec-fetch-site': 'same-origin' } });
            await t.waitFor(api.json().id);
            assert.deepStrictEqual(seen, [null, `user:${joe.subject}`], 'the same task asked on Actor itself: the person\'s own tools');
        } finally { run['openvibe-runtime'] = real; }
    });

    await check('a redelivery makes no second task; ordinary messages and other people\'s channels are ignored', async () => {
        const before = (await t.ctx.s.db.maybe('SELECT count(*)::int AS n FROM tasks')).n;
        assert.strictEqual(await deliver(first), 'duplicate');
        assert.strictEqual(await deliver(message(kim, 'hello everyone')), 'ignored:not_an_ask');
        assert.strictEqual(await deliver(message(lee, '@actor hi there', { room: { type: 'channel', channel_user_id: kim.id, stream_id: 5 } })), 'ignored:not_an_ask');
        assert.strictEqual(await deliver(message(lee, '@actor hi there', { source_platform: 'youtube' })), 'ignored:not_an_ask');
        assert.strictEqual((await t.ctx.s.db.maybe('SELECT count(*)::int AS n FROM tasks')).n, before);
    });

    await check('in their own channel the reply goes to that channel and its live stream', async () => {
        t.providers.state.cls = 'answer';
        const ev = message(lee, '@actor what time zone is Lisbon in?', { room: { type: 'channel', channel_user_id: lee.id, stream_id: 44 } });
        assert.strictEqual(await deliver(ev), 'task');
        await t.waitFor((await askRow(ev)).task_id);
        await t.ctx.chatAsks.tick();
        assert.deepStrictEqual(posted.at(-1).room, { type: 'channel', channel_user_id: lee.id, stream_id: 44 });
    });

    await check('a computer, robot or coding task from chat is refused: public tools only', async () => {
        for (const cls of ['computer', 'robot', 'code']) {
            t.providers.state.cls = cls;
            const ev = message(ann, `@actor do the ${cls} thing`);
            assert.strictEqual(await deliver(ev), 'task');
            const task = await t.waitFor((await askRow(ev)).task_id);
            assert.deepStrictEqual([task.state, task.error_code], ['failed', 'actor.task.not_public'], cls);
            await t.ctx.chatAsks.tick();
            assert.match(posted.at(-1).text, /^@ann from a public chat I only use public tools\. To use your own computer, robots or code, ask me on https:\/\/openvibe\.actor$/);
        }
    });

    await check('past the hourly limit one reply says so, then further asks are dropped quietly', async () => {
        t.providers.state.cls = 'answer';
        // kim has asked once; the limit is 3 an hour.
        for (const q of ['two', 'three']) {
            const ev = message(kim, `@actor question ${q}`);
            assert.strictEqual(await deliver(ev), 'task');
            await t.waitFor((await askRow(ev)).task_id);
        }
        const over = message(kim, '@actor question four');
        assert.strictEqual(await deliver(over), 'refused:person_hourly');
        const quiet = message(kim, '@actor question five');
        assert.strictEqual(await deliver(quiet), 'refused:person_hourly:quiet');
        const before = posted.length;
        await t.ctx.chatAsks.tick();
        const texts = posted.slice(before).map((p) => p.text);
        assert.ok(texts.includes('@kim that is 3 questions this hour; ask again later, or on https://openvibe.actor'), JSON.stringify(texts));
        assert.ok(!posted.some((p) => p.replyTo === quiet.payload.message_id), 'the quiet one gets no reply');
        assert.ok((await askRow(quiet)).replied_at);
    });

    await check('a reply Chat cannot take now is retried later', async () => {
        t.providers.state.cls = 'answer';
        const ev = message(joe, '@actor name a prime number');
        await deliver(ev);
        await t.waitFor((await askRow(ev)).task_id);
        chatDown = true;
        assert.strictEqual(await t.ctx.chatAsks.tick(), 0);
        const waiting = await askRow(ev);
        assert.deepStrictEqual([waiting.replied_at, waiting.reply_attempts, waiting.reply_error], [null, 1, 'down']);
        chatDown = false;
        await t.ctx.s.db.query('UPDATE actor_chat_asks SET next_attempt_at = NULL WHERE message_id = $1', [ev.payload.message_id]);
        assert.strictEqual(await t.ctx.chatAsks.tick(), 1);
        assert.strictEqual(posted.at(-1).replyTo, ev.payload.message_id);
    });

    await t.close();
    done();
})();

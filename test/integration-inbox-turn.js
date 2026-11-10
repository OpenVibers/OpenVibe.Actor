'use strict';
/**
 * The two halves of the one-engine slice, together: Chat's inbox client asks a real OpenVibe.Actor for a turn, and
 * the turn reaches the loop with the visitor's subject, the conversation key and the tool list the product named.
 *
 * This is a local check across the two repositories (Actor's own test boot + Chat's client), run from the Actor
 * worktree with Chat's client on the path. It proves the shapes fit before either side ships.
 *
 * Run: node test/integration-inbox-turn.js   (from the OpenVibe.Actor worktree; CHAT_DIR points at the Chat one)
 */
const path = require('path');
const { boot } = require('./helpers/boot');

const CHAT_DIR = process.env.CHAT_DIR || path.join(__dirname, '..', '..', 'wt-one-engine-chat');

(async () => {
    const t = await boot();
    const kim = t.network.addUser('kim');
    const subject = kim.subject || null;

    // Chat's own client for Actor (server/inbox/actor.js), pointed at this Actor.
    const { createActor } = require(path.join(CHAT_DIR, 'server', 'inbox', 'actor'));
    const config = require(path.join(CHAT_DIR, 'server', 'config'));
    config.actor.internalUrl = t.base;
    config.oauth.clientSecret = 'actor-secret';
    config.oauth.clientId = 'chat';
    // Chat's service token for Actor: a first-party service token (sub svc:…, actor_type service), which is the
    // only kind Actor lets name a person in X-OV-Subject.
    const { serviceAuth } = require('openvibe-contracts');
    const crypto = require('crypto');
    const actorModule = require(path.join(CHAT_DIR, 'server', 'inbox', 'actor'));
    const now = Math.floor(Date.now() / 1000);
    const serviceToken = (subject) => serviceAuth.signServiceToken({
        iss: t.network.url, sub: 'svc:chat', actor_type: 'service', aud: ['openvibe.actor'],
        cap: ['actor.task.create', 'actor.task.read'], ns: [], iat: now, exp: now + 300,
        jti: crypto.randomUUID(), ...(subject ? { on_behalf_of: subject } : {}),
    }, t.network.privatePem);
    actorModule._setTokens({ getToken: async () => serviceToken(subject) });

    const saved = t.config.loop.selfReflections;
    t.config.loop.selfReflections = 0;
    t.providers.reset();
    t.providers.state.script = [{ content: 'We ship in 3-5 days. https://example.com/faq' }];

    const actor = createActor({ fetchImpl: globalThis.fetch });
    let out = null;
    try {
        out = await actor.turn({
            subject: null,   // an anonymous visitor: the turn is Chat's own
            task: 'You are Vibe, the assistant answering for "Acme".\n\nThe conversation so far:\nThe visitor: When do you ship?\n\nThe visitor now says: When do you ship?',
            tools: ['read_page', 'time_in'],
            budgetUsd: 0.05,
            conversation: { product: 'chat', id: 'inbox:cnv_test/turn:1' },
            idempotencyKey: 'chat-inbox-cnv_test-1',
        });
    } finally {
        t.config.loop.selfReflections = saved;
    }

    const ok = out && !out.pending && out.answer && /ship in 3-5 days/.test(out.answer);
    const anonTaskId = out && out.taskId;
    // The task row carries the conversation key and the tool list the product named.
    const row = await t.dbDump();
    const taskRow = row.split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } })
        .filter((r) => Array.isArray(r)).flat().find((r) => r && r.id === anonTaskId);

    // A signed-in visitor: the turn is theirs. Their subject id rides in X-OV-Subject, which Actor checks against
    // the service token's grant. This is the identity path the slice had to open.
    const person = t.network.addUser('visitor');
    const personSubject = person.subject || null;
    const signed = serviceToken(personSubject);
    actorModule._setTokens({ getToken: async () => signed });
    t.providers.reset();
    t.providers.state.script = [{ content: 'Order 42 ships Tuesday.' }, { content: 'Order 42 ships Tuesday.' }, { content: 'Order 42 ships Tuesday.' }];
    let personOut = null;
    try {
        personOut = await actor.turn({
            subject: personSubject,
            task: 'You are Vibe, the assistant answering for "Acme".\n\nThe conversation so far:\nThe visitor: Where is my order?',
            tools: ['read_page'],
            budgetUsd: 0.05,
            conversation: { product: 'chat', id: 'inbox:cnv_person/turn:1' },
            idempotencyKey: 'chat-inbox-cnv_person-1',
        });
    } catch (err) {
        process.stderr.write(JSON.stringify({ ok: false, personError: String(err && err.message) }, null, 2) + '\n');
        await t.close();
        process.exit(1);
    }
    // Whose task is it, and whose allowance paid for it?
    const personTask = await t.dbDump();
    const personRows = personTask.split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } })
        .filter((r) => Array.isArray(r)).flat();
    const personRow = personRows.find((r) => r && r.id === personOut.taskId);
    const personSpend = personRows.filter((r) => r && r.requester === `user:${personSubject}` && typeof r.usd === 'number');
    const serviceSpend = personRows.filter((r) => r && r.requester && String(r.requester).startsWith('service:') && typeof r.usd === 'number');

    // The content tier of a turn (one-engine slice): a turn that names nobody may not ask for the adult tier.
    // Chat's own client never asks for it (a support inbox's visitor is not a person who confirmed 18+), so this
    // goes to Actor's API the way a product that may ask for it would.
    let adultRefused = null;
    try {
        const r = await fetch(`${t.base}/api/v1/tasks`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${serviceToken(null)}` },
            body: JSON.stringify({
                task: 'An anonymous visitor asks for the adult tier.', tier: 'uncensored',
                conversation: { product: 'chat', id: 'inbox:cnv_anon/turn:adult' }, tools: [],
            }),
        });
        const body = await r.json().catch(() => null);
        adultRefused = `${r.status} ${(body && body.code) || ''} ${(body && body.detail) || ''}`;
    } catch (err) {
        adultRefused = `error ${String((err && err.message) || err)}`;
    }

    process.stderr.write(JSON.stringify({
        ok: Boolean(ok),
        answer: out && out.answer,
        costUsd: out && out.costUsd,
        taskId: anonTaskId,
        storedConversation: taskRow && taskRow.conversation,
        storedTools: taskRow && taskRow.tools,
        anonymousAdultTier: adultRefused,
        signedIn: {
            ok: Boolean(personOut && !personOut.pending && personOut.answer),
            answer: personOut && personOut.answer,
            requester: personRow && personRow.requester,
            via: personRow && personRow.via,
            personSpendUsd: personSpend.reduce((s, r) => s + Number(r.usd), 0),
            serviceSpendUsd: serviceSpend.reduce((s, r) => s + Number(r.usd), 0),
        },
    }, null, 2) + '\n');

    await t.close();
    const adultOk = /actor\.tier\.no_person/.test(String(adultRefused || ''));    process.exit(ok && personOut && !personOut.pending && personOut.answer && adultOk ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });

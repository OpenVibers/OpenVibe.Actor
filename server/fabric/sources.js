'use strict';
const { createHash } = require('node:crypto');
const { assert, text } = require('./policy');
const key = (...parts) => createHash('sha256').update(JSON.stringify(parts)).digest('hex');
const TOPICS = ['chat.message.created', 'chat.dm.created', 'mail.agent_inbox.received'];
// Plugins consume verified Events envelopes only. Source instance bindings are owner configuration, never
// inferred from arbitrary event text. The cursor and resulting Trigger commit in the same transaction.
const plugins = {
    chat(event, source) {
        const p = event.payload || {}, dm = event.event_type === 'chat.dm.created';
        if (!['chat.message.created', 'chat.dm.created'].includes(event.event_type) || p.source_platform || !p.message_id) return null;
        const scope = dm ? `dm:${p.conversation_id}` : p.room?.type === 'global' ? 'global' : `channel:${p.room?.channel_user_id}`;
        if (!source.scopes.includes(scope)) return null;
        const actor = dm ? p.sender_subject : p.user_subject;
        if (!text(actor)) return null;
        // An explicitly bound DM is a Source; it must include the agent's Chat identity as a participant.
        if (dm && (!(p.participants || []).some(x => x.subject === source.self) || !(p.participants || []).some(x => x.subject === source.owner_subject))) return null;
        const mentioned = typeof p.text === 'string' && (source.mentions || []).some(name => p.text.split(/\s+/).some(word => word.replace(/[,:!?]+$/, '') === `@${name}`));
        if (!dm && !mentioned && !(source.receive_all || []).includes(scope)) return null;
        return { event_id: `${event.event_type}:${p.message_id}`, scope, thread: dm ? scope : source.message_threads?.[`message_${p.reply_to_id}`] || `message_${p.reply_to_id || p.message_id}`, actor, kind: p.message_type === 'bot' || p.message_type === 'ai' ? 'bot' : 'person', address: dm ? 'direct' : mentioned ? 'mention' : 'none',
            // DM events intentionally carry identifiers, not private message bodies. Preserve those source facts;
            // an executor reads the message through Chat with its own authorized connection.
            text: dm ? JSON.stringify(p) : p.text, pointer: `https://openvibe.chat/${dm ? `dm/${p.conversation_id}` : `messages/${p.message_id}`}` };
    },
    mail(event, source, letter) {
        if (event.event_type !== 'mail.agent_inbox.received') return null;
        const p = event.payload || {}, scope = `inbox:${p.inbox_id}`;
        if (!source.scopes.includes(scope) || p.owner !== source.owner_subject || p.agent_id !== source.mail_agent || !text(p.message_id) || !text(p.from)) return null;
        if (!letter || !Array.isArray(letter.from) || letter.from.length !== 1 || letter.from[0].trim().toLowerCase() !== p.from.trim().toLowerCase() || letter.spam || letter.owner !== source.owner_subject || letter.agent_id !== source.mail_agent || letter.inbox !== p.inbox) return null;
        return { event_id: p.message_id, scope, thread: letter.references?.[0] || letter.in_reply_to || letter.message_id, actor: p.from.trim().toLowerCase(), kind: 'person', address: 'direct', text: letter.text || JSON.stringify({ message_id: p.message_id, subject: letter.subject || '' }), pointer: `https://openvibe.email/inbox/${encodeURIComponent(p.inbox_id)}/message/${encodeURIComponent(p.message_id)}` };
    },
    time(event, source) {
        if (event.event_type !== 'actor.fabric.time' || !source.scopes.includes(event.payload.scope)) return null;
        const p = event.payload;
        return { event_id: `${p.schedule_id}:${p.due}`, scope: p.scope, actor: 'clock', kind: 'system', address: 'none', text: p.text };
    },
};
function translate(event, id, source, now, letter) {
    const raw = plugins[source.kind]?.(event, source, letter);
    if (!raw || !text(raw.text) || raw.actor === source.self || !source.enabled) return null;
    return { id: `trigger_${key(id, raw.event_id)}`, source: id, actor: { source: id, id: raw.actor, kind: raw.kind }, source_scope: raw.scope,
        threads: [`thread_${key(id, raw.scope, raw.thread || raw.scope)}`], occurred_at: new Date(event.occurred_at || event.created_at || now).toISOString(), text: raw.text, addresses_agent: raw.address, ...(raw.pointer ? { read_pointer: raw.pointer } : {}) };
}
function receiveEvent(engine, event, letter) {
    const results = [];
    for (const [id, source] of Object.entries(engine.s.sources)) {
        if (source.kind === 'time') continue; // only the local time Source may produce clock events
        const t = translate(event, id, source, engine.now, letter);
        if (t) {
            results.push(engine.receive(t));
            source.cursor = event.event_id || event.id || t.id;
            if (source.kind === 'chat' && event.event_type === 'chat.message.created') {
                source.message_threads ||= {};
                const p = event.payload;
                source.message_threads[`message_${p.message_id}`] = source.message_threads[`message_${p.reply_to_id}`] || `message_${p.reply_to_id || p.message_id}`;
            }
        }
    }
    return results;
}
function schedule(engine, spec) {
    const source = engine.s.sources[spec.source];
    assert(source?.kind === 'time' && source.scopes.includes(spec.scope), 'Unknown time Source scope');
    assert(text(spec.id) && !['__proto__', 'constructor', 'prototype'].includes(spec.id) && text(spec.text) && Number.isFinite(spec.due) && spec.due >= engine.now && (spec.interval_ms == null || Number.isSafeInteger(spec.interval_ms) && spec.interval_ms >= 1000), 'Invalid schedule');
    assert(!Object.hasOwn(engine.s.schedules, spec.id), 'Schedules are immutable; cancel and create a new id');
    if (spec.quiet_thread) assert(engine.s.threads[spec.quiet_thread]?.last_trigger_id === spec.since_trigger, 'Quiet condition needs the latest Trigger on its Thread');
    engine.s.schedules[spec.id] = structuredClone(spec); return spec;
}
function tick(engine) {
    for (const s of Object.values(engine.s.schedules)) {
        const source = engine.s.sources[s.source];
        if (s.cancelled || s.finished || s.due > engine.now || !source?.enabled) continue;
        if (s.quiet_thread && engine.s.threads[s.quiet_thread]?.last_trigger_id !== s.since_trigger) { s.cancelled = true; s.reason = 'conversation_changed'; continue; }
        const event = { event_type: 'actor.fabric.time', occurred_at: new Date(s.due).toISOString(), payload: { schedule_id: s.id, due: s.due, scope: s.scope, text: s.text } };
        const trigger = translate(event, s.source, source, engine.now);
        if (trigger) engine.receive(trigger);
        source.cursor = trigger?.id;
        // One occurrence per pass. Catch-up is ordered and bounded; no waiting inside Eval.
        if (s.interval_ms) s.due += s.interval_ms; else s.finished = true;
    }
    engine.expire();
    for (const thread of Object.keys(engine.s.threads)) engine.start({ thread });
}
module.exports = { plugins, translate, receiveEvent, schedule, tick, TOPICS };

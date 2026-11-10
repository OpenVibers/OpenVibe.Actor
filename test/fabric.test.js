'use strict';
const assert = require('node:assert/strict');
const { Engine, initial } = require('../server/fabric/engine');
const { gate, policy } = require('../server/fabric/policy');
const { translate, receiveEvent, schedule, tick } = require('../server/fabric/sources');
const cfg = () => ({ sources: { chat: { kind: 'chat', self: 'agent', enabled: true, scopes: ['room'], receive_all: ['room'] } }, policy: { mode: 'auto', rules: [{ id: 'fix', enabled: true, instruction: 'Fix requested defects', mode: 'auto' }], sources: { chat: { allowed: ['alice'], bots: ['ci'], admission: { room: { unlisted_addressed: 'inferred', unlisted_unaddressed: 'inferred' } } } }, budget: { usd: 1, tokens: 1000, wall_minutes: 10 } } });
const trigger = (id, extra = {}) => ({ id, source: 'chat', actor: { source: 'chat', id: 'alice', kind: 'person' }, source_scope: 'room', threads: ['room'], occurred_at: '2026-11-09T12:00:00.000Z', text: 'Fix the broken test', addresses_agent: 'mention', ...extra });
const good = () => ({ decision: 'accept', scope: 'Fix the broken test', direction: { implementation_requested: true, target_basis: 'specified', requires_design_decision: false, evidence: [{ trigger_id: 'a', quote: 'broken test' }] }, rule_assessments: [{ rule_id: 'fix', matched: true, reason: 'Requested defect fix' }] });
const engine = () => { const e = new Engine(initial(), { now: 1000 }); e.configure(cfg()); return e; };
const accept = (e, t = trigger('a')) => { e.receive(t); const ev = e.start({ thread: t.threads[0] }); return e.decide({ evaluation: ev.id, decision: 'accept', scope: t.text }).ticket; };
let count = 0;
function test(name, fn) { fn(); count++; console.log(`ok ${name}`); }
test('001 Trigger: immutable idempotent intake and one acceptance for the whole batch', () => {
    const e = engine(); e.receive(trigger('a')); e.receive(trigger('b')); e.receive(trigger('a', { text: 'changed' }));
    assert.equal(e.s.triggers.a.text, 'Fix the broken test');
    const ev = e.start({ thread: 'room' }); assert.equal(e.start({ thread: 'room' }).id, ev.id);
    e.decide({ evaluation: ev.id, decision: 'accept', scope: 'Fix test' });
    e.queue(trigger('b')); assert.equal(e.start({ thread: 'room' }), null); assert.equal(Object.keys(e.s.tickets).length, 1);
});
test('001 Thread: new arrivals wait for the next evaluation and see ended Tickets', () => {
    const e = engine(); e.receive(trigger('a')); const first = e.start({ thread: 'room' }); e.receive(trigger('b'));
    assert.deepEqual(e.s.threads.room.pending, ['b']);
    e.decide({ evaluation: first.id, decision: 'ignore' }); assert.deepEqual(e.start({ thread: 'room' }).ids, ['b']);
});
test('001 Source: own messages and unlistened scopes are filtered before domain intake', () => {
    const e = engine(); assert.equal(e.receive(trigger('a', { actor: { source: 'chat', id: 'agent', kind: 'bot' } })).status, 'filtered');
    assert.equal(e.receive(trigger('b', { source_scope: 'elsewhere' })).status, 'filtered'); assert.deepEqual(e.s.triggers, {});
});
test('002 Gate: allowed addressed people explicit in every mode; no assessment work', () => {
    for (const mode of ['off', 'observe', 'auto']) {
        const e = engine(), c = cfg(); c.policy.mode = mode; e.configure(c);
        const k = accept(e); assert.equal(k.mandate.strength, 'explicit'); assert(!e.s.work.some(w => w.kind === 'assess'));
    }
});
test('002 Admission: every cell, follow-up precedence, receive-all and bots', () => {
    const e = engine(), p = e.s.policy, s = e.s.sources.chat;
    assert.equal(gate(trigger('a', { addresses_agent: 'none' }), p, s).strength, 'inferred');
    const other = trigger('a', { actor: { source: 'chat', id: 'bob', kind: 'person' } });
    assert.equal(gate(other, p, s, true).strength, 'inferred');
    p.sources.chat.admission.room.unlisted_addressed = 'explicit'; p.mode = 'off';
    assert.equal(gate(other, p, s, true).strength, 'explicit');
    assert.equal(gate({ ...other, addresses_agent: 'none' }, p, s, true), null);
    p.mode = 'auto';
    assert.equal(gate(trigger('x', { actor: { source: 'chat', id: 'ci', kind: 'bot' } }), p, s).strength, 'inferred');
    assert.equal(gate(trigger('x', { actor: { source: 'chat', id: 'unknown', kind: 'bot' } }), p, s), null);
    assert.equal(gate({ ...other, addresses_agent: 'none' }, p, { ...s, receive_all: [] }), null);
});
test('002 Assessment: inferred acceptance requires every enabled rule exactly once and quoted direction', () => {
    for (const mutation of [a => a.rule_assessments.pop(), a => a.rule_assessments.push(a.rule_assessments[0]), a => a.direction.evidence[0].quote = 'invented']) {
        const e = engine(); e.receive(trigger('a', { addresses_agent: 'none' })); const ev = e.start({ thread: 'room' }), a = good(); mutation(a);
        assert.throws(() => e.decide({ evaluation: ev.id, decision: 'accept', assessment: a })); assert.equal(Object.keys(e.s.tickets).length, 0);
    }
    const e = engine(); e.receive(trigger('a', { addresses_agent: 'none' })); const ev = e.start({ thread: 'room' });
    assert.throws(() => e.decide({ evaluation: ev.id, decision: 'accept', scope: 'bypass' }));
    const k = e.decide({ evaluation: ev.id, decision: 'accept', assessment: good() }).ticket;
    assert.deepEqual(k.mandate.matched_rules, ['fix']); assert.deepEqual(k.mandate.budget, cfg().policy.budget);
});
test('002 Assessment: unsettled direction, design decisions and unmatched rules never accept', () => {
    for (const mutate of [a => a.direction.requires_design_decision = true, a => a.direction.target_basis = 'undetermined', a => a.direction.implementation_requested = false, a => a.rule_assessments[0].matched = false]) {
        const e = engine(); e.receive(trigger('a', { addresses_agent: 'none' })); const ev = e.start({ thread: 'room' }), a = good(); mutate(a);
        assert.equal(e.decide({ evaluation: ev.id, decision: 'accept', assessment: a }).decision.decision, 'ignore');
    }
});
test('002 Observe default: would-accept is audit only, with no worker or reply', () => {
    assert.equal(initial().policy.mode, 'observe');
    const e = engine(), c = cfg(); c.policy.mode = 'observe'; e.configure(c);
    e.receive(trigger('a', { addresses_agent: 'none' })); const ev = e.start({ thread: 'room' });
    const d = e.decide({ evaluation: ev.id, decision: 'accept', assessment: good() }).decision;
    assert.equal(d.decision, 'ignore'); assert.equal(d.would_accept, true); assert(!e.s.work.some(w => ['launch', 'reply'].includes(w.kind)));
});
test('002 Routing: ignored-from-card skips assessment and cannot accept', () => {
    const e = engine(); e.receive(trigger('a', { addresses_agent: 'none' })); const ev = e.start({ thread: 'room' });
    assert.throws(() => e.decide({ evaluation: ev.id, decision: 'accept', ignored_from_card: true, reason: 'unrelated' }));
    assert.equal(e.decide({ evaluation: ev.id, decision: 'ignore', ignored_from_card: true, reason: 'unrelated' }).decision.ignored_from_card, true);
});
test('001 Policy / 002 Policy version: discard stale Eval and notify affected live Tickets without revoking', () => {
    const e = engine(), k = accept(e), mandate = structuredClone(k.mandate);
    e.receive(trigger('b', { actor: { source: 'chat', id: 'ci', kind: 'bot' } })); const ev = e.start({ thread: 'room' });
    const c = cfg(); c.policy.sources.chat.allowed = []; e.configure(c);
    assert.equal(k.state, 'open'); assert.deepEqual(k.mandate, mandate); assert(e.s.work.some(w => w.key.startsWith('policy:')));
    assert.equal(e.s.decisions.at(-1).decision, 'unavailable'); assert.deepEqual(e.s.threads.room.pending, ['b']);
    assert.throws(() => e.decide({ evaluation: ev.id, decision: 'accept', assessment: good() }));
});
test('001 Subscription / 002 Ownership: every sender fans out, human follow-ups bypass Eval', () => {
    const e = engine(), k = accept(e);
    e.receive(trigger('b', { actor: { source: 'chat', id: 'stranger', kind: 'person' } }));
    assert.deepEqual(e.owners('b'), [k.id]); assert.equal(e.start({ thread: 'room' }), null);
    e.unsubscribe({ ticket_id: k.id, thread: 'room', person: true }); assert.deepEqual(e.owners('b'), [k.id]);
    e.subscribe({ ticket_id: k.id, thread: 'room', kind: 'source' });
    e.receive(trigger('c', { actor: { source: 'chat', id: 'unknown', kind: 'bot' } }));
    assert(e.s.work.some(w => w.payload.trigger?.id === 'c')); assert.deepEqual(e.owners('c'), []);
});
test('001 Correlation / 002 Context-only: related Threads never route or grant resume authority', () => {
    const e = engine(), k = accept(e);
    e.subscribe({ ticket_id: k.id, thread: 'context' }); e.end({ ticket_id: k.id });
    e.receive(trigger('b', { threads: ['context'] })); assert.equal(k.state, 'ended'); assert.deepEqual(e.owners('b'), []);
    e.s.threads.context.correlated = ['room']; e.receive(trigger('c', { threads: ['context'] })); assert.equal(k.state, 'ended');
});
test('002 Hand-back: once with a reason; wait until every owner releases; keep subscriptions', () => {
    const e = engine(), one = accept(e);
    e.receive(trigger('bot', { actor: { source: 'chat', id: 'ci', kind: 'bot' } }));
    const ev = e.start({ thread: 'room' }), a = good(); a.direction.evidence[0].trigger_id = 'bot';
    const two = e.decide({ evaluation: ev.id, decision: 'accept', assessment: a }).ticket;
    e.receive(trigger('follow'));
    assert.throws(() => e.handBack({ ticket_id: one.id, trigger_id: 'follow', reason: '' }));
    assert(e.handBack({ ticket_id: one.id, trigger_id: 'follow', reason: 'Another scope' })); assert.equal(e.s.threads.room.pending.length, 0);
    assert.equal(e.handBack({ ticket_id: one.id, trigger_id: 'follow', reason: 'again' }), false);
    e.handBack({ ticket_id: two.id, trigger_id: 'follow', reason: 'Another scope' }); assert.deepEqual(e.s.threads.room.pending, ['follow']);
    assert(e.s.threads.room.subscriptions[one.id]);
});
test('002 Resume: person resumes same immutable Mandate, bots cannot; revoked policy fails closed', () => {
    const e = engine(), k = accept(e), mandate = structuredClone(k.mandate);
    e.end({ ticket_id: k.id });
    e.receive(trigger('bot', { actor: { source: 'chat', id: 'ci', kind: 'bot' } })); assert.equal(k.state, 'ended');
    e.receive(trigger('person')); assert.equal(k.state, 'open'); assert.deepEqual(k.mandate, mandate);
    e.read({ ticket_id: k.id, trigger_ids: ['person'] }); e.end({ ticket_id: k.id });
    const c = cfg(); c.policy.sources.chat.allowed = []; c.policy.sources.chat.admission.room.unlisted_addressed = 'ignore'; e.configure(c);
    e.receive(trigger('again')); assert.equal(k.state, 'ended'); assert.deepEqual(e.owners('again'), []); assert(e.s.threads.room.pending.includes('again'));
});
test('002 Stop: only explicit human stop withdraws; stopped Ticket receives nothing', () => {
    const e = engine(), k = accept(e);
    e.receive(trigger('bot', { actor: { source: 'chat', id: 'ci', kind: 'bot' } })); assert.throws(() => e.stop({ ticket_id: k.id, trigger_id: 'bot' }));
    e.receive(trigger('stop')); e.stop({ ticket_id: k.id, trigger_id: 'stop', reason: 'Person asked' });
    e.receive(trigger('later')); assert.equal(k.state, 'ended'); assert(!e.s.work.some(w => w.payload.trigger?.id === 'later'));
});
test('002 Release unread: read input stays accounted for; unread returns to routing on end', () => {
    const e = engine(), k = accept(e); e.receive(trigger('read')); e.receive(trigger('unread'));
    e.read({ ticket_id: k.id, trigger_ids: ['read'] }); e.end({ ticket_id: k.id }); assert.deepEqual(e.s.threads.room.pending, ['unread']);
});
test('002 A successful report atomically claims only inputs assigned to its run', () => {
    const e = engine(), k = accept(e); e.receive(trigger('read')); e.receive(trigger('unread'));
    e.report({ ticket_id: k.id, task_id: 'tsk_1', read_trigger_ids: ['read'], end: true,
        report: { ticket_id: k.id, assignment_id: 'asg_1', state: 'ready', summary: 'Done', pr: null, tests_run: [], risks: [] } });
    assert(e.s.meta[k.id].read.includes('read'));
    assert.deepEqual(e.s.threads.room.pending, ['unread']);
});
test('002 Eval timeout: undelivered never expires; third delivered expiry is unavailable', () => {
    const e = engine(); e.receive(trigger('a')); let ev = e.start({ thread: 'room' }); e.now = 9999999; e.expire(); assert(e.s.threads.room.evaluation);
    for (let i = 0; i < 3; i++) { e.delivered({ evaluation: ev.id }); e.now += 300001; e.expire(); if (i < 2) ev = e.start({ thread: 'room' }); }
    assert.equal(e.s.threads.room.evaluation, null); assert.equal(e.s.threads.room.pending.length, 0); assert.equal(e.s.decisions.at(-1).decision, 'unavailable');
});
test('003 Stored work: order, exponential retries, leases and restart use the same idempotency key', () => {
    const e = engine(), k = accept(e); e.reply({ ticket_id: k.id, conversation: 'room', source: 'chat', key: 'ack', text: 'Acknowledged' }); e.reply({ ticket_id: k.id, conversation: 'room', source: 'chat', key: 'answer', text: 'Result' });
    let w = e.claim({ kinds: ['reply'] }); e.settle({ id: w.id, claim: w.claim, ok: false });
    assert.equal(e.s.work.find(x => x.id === w.id).due, 6000); assert.equal(e.claim({ kinds: ['reply'] }), null);
    e.now = 6000; w = e.claim({ kinds: ['reply'] });
    const restarted = new Engine(structuredClone(e.s), { now: 37000 }); const retry = restarted.claim({ kinds: ['reply'] }); assert.equal(retry.key, w.key); assert.notEqual(retry.claim, w.claim);
    assert.throws(() => restarted.settle({ id: w.id, claim: w.claim, ok: true })); restarted.settle({ id: retry.id, claim: retry.claim, ok: true });
    assert.equal(restarted.claim({ kinds: ['reply'] }).payload.text, 'Result');
});
test('003 Channel: Source off waits; permanent drop records when and why and never requeues', () => {
    const e = engine(), k = accept(e), args = { ticket_id: k.id, conversation: 'room', source: 'chat', key: 'ack', text: 'Ack' };
    e.reply(args); e.s.sources.chat.enabled = false; assert.equal(e.claim({ kinds: ['reply'] }), null); e.s.sources.chat.enabled = true;
    const w = e.claim({ kinds: ['reply'] }); e.settle({ id: w.id, claim: w.claim, permanent_reason: 'destination_cannot_receive' });
    assert.equal(e.reply(args).state, 'dropped'); assert.equal(e.reply(args).finished_at, e.now);
});
test('001 Source plugins: Chat mention/DM and Mail bind scope and owner; cursor shares intake', () => {
    const e = engine(); e.s.sources.chat.scopes = ['global', 'dm:2']; e.s.sources.chat.mentions = ['actor']; e.s.sources.chat.owner_subject = 'alice';
    const event = { id: 'ev1', event_type: 'chat.message.created', payload: { message_id: 1, room: { type: 'global' }, user_subject: 'alice', text: '@actor fix test' } };
    assert.equal(receiveEvent(e, event)[0].status, 'stored'); assert.equal(e.s.sources.chat.cursor, 'ev1'); assert.equal(receiveEvent(e, event)[0].status, 'duplicate');
    const dm = { event_type: 'chat.dm.created', payload: { message_id: 2, conversation_id: 2, sender_subject: 'alice', participants: [{ subject: 'alice' }, { subject: 'agent' }] } };
    assert.equal(translate(dm, 'chat', e.s.sources.chat, e.now).addresses_agent, 'direct'); dm.payload.participants = [{ subject: 'agent' }]; assert.equal(translate(dm, 'chat', e.s.sources.chat, e.now), null);
    const mail = { kind: 'mail', enabled: true, self: 'agent@example.org', owner_subject: 'alice', mail_agent: 'agent', scopes: ['inbox:1'] };
    const letter = { event_type: 'mail.agent_inbox.received', payload: { inbox_id: 1, owner: 'alice', agent_id: 'agent', from: 'PERSON@example.org', message_id: 'm1', inbox: 'agent@example.org', excerpt: 'hello' } };
    const full = { from: ['person@example.org'], owner: 'alice', agent_id: 'agent', inbox: 'agent@example.org', text: 'hello', message_id: 'm1', references: [] };
    const first = translate(letter, 'mail', mail, e.now, full); assert.equal(first.actor.id, 'person@example.org');
    const next = translate({ ...letter, payload: { ...letter.payload, message_id: 'm2' } }, 'mail', mail, e.now, { ...full, message_id: 'm2', references: ['m1'] });
    assert.deepEqual(first.threads, next.threads);
    const unrelated = translate({ ...letter, payload: { ...letter.payload, message_id: 'm3' } }, 'mail', mail, e.now, { ...full, message_id: 'm3' });
    assert.notDeepEqual(first.threads, unrelated.threads);
    letter.payload.owner = 'bob'; assert.equal(translate(letter, 'mail', mail, e.now, full), null);
});
test('001 / 002 Waiting conditions: time Source produces idempotent events; evaluator never waits', () => {
    const e = engine(); e.s.sources.clock = { kind: 'time', enabled: true, self: 'agent', scopes: ['morning'], receive_all: ['morning'] };
    schedule(e, { id: 'daily', source: 'clock', scope: 'morning', due: 2000, text: 'Morning check' }); tick(e); assert.equal(Object.keys(e.s.triggers).length, 0);
    e.now = 2000; tick(e); tick(e); assert.equal(Object.keys(e.s.triggers).length, 1); assert.equal(e.s.triggers[Object.keys(e.s.triggers)[0]].actor.kind, 'system');
});
test('002 Revalidation: table weakening, rule disablement, bot removal and Source removal revoke on resume', () => {
    for (const change of [c => c.policy.mode = 'observe', c => c.policy.rules[0].enabled = false, c => c.policy.sources.chat.bots = [], c => c.sources.chat.enabled = false]) {
        const e = engine(); e.receive(trigger('a', { actor: { source: 'chat', id: 'ci', kind: 'bot' } }));
        const ev = e.start({ thread: 'room' }), k = e.decide({ evaluation: ev.id, decision: 'accept', assessment: good() }).ticket;
        e.end({ ticket_id: k.id }); const c = cfg(); change(c); e.configure(c); e.receive(trigger('later')); assert.equal(k.state, 'ended');
    }
    const e = engine(), c = cfg(); c.policy.sources.chat.admission.room.unlisted_addressed = 'explicit'; e.configure(c);
    const k = accept(e, trigger('a', { actor: { source: 'chat', id: 'bob', kind: 'person' } })); e.end({ ticket_id: k.id });
    c.policy.sources.chat.admission.room.unlisted_addressed = 'inferred'; e.configure(c); e.receive(trigger('later')); assert.equal(k.state, 'ended');
});
test('002 Attach: explicit pointer only, context upgraded, handed-back work cannot return', () => {
    const e = engine(), k = accept(e); e.subscribe({ ticket_id: k.id, thread: 'other' });
    e.receive(trigger('other1', { threads: ['other'], text: 'Different work' }));
    assert.throws(() => e.attach({ ticket_id: k.id, trigger_id: 'other1' }));
    e.receive(trigger('other2', { threads: ['other'], text: `Please continue ${k.id}` }));
    e.attach({ ticket_id: k.id, trigger_id: 'other2' }); assert.deepEqual(e.owners('other2'), [k.id]);
    e.handBack({ ticket_id: k.id, trigger_id: 'other2', reason: 'Beyond scope' }); assert.throws(() => e.attach({ ticket_id: k.id, trigger_id: 'other2' }));
    assert.throws(() => e.unsubscribe({ ticket_id: k.id, thread: 'room' }));
});
test('001 Subscription: many Threads deliver one input, multiple Tickets remain independent', () => {
    const e = engine(), k = accept(e); e.subscribe({ ticket_id: k.id, thread: 'other', kind: 'source' });
    e.receive(trigger('follow', { threads: ['room', 'other'] })); assert.equal(e.s.work.filter(w => w.payload.trigger?.id === 'follow').length, 1);
});
test('001 Policy: unchanged settings preserve version and unrelated changes do not notify', () => {
    const e = engine(), k = accept(e), old = e.s.policy.version; e.configure(cfg()); assert.equal(e.s.policy.version, old);
    const c = cfg(); c.policy.rules.push({ id: 'unrelated', enabled: true, instruction: 'Other work' }); e.configure(c);
    assert.notEqual(e.s.policy.version, old); assert(!e.s.work.some(w => w.key.startsWith('policy:'))); assert.equal(k.state, 'open');
});
test('001 Time Source: a later message cancels a quiet condition before it can produce work', () => {
    const e = engine(); e.s.sources.clock = { kind: 'time', enabled: true, self: 'agent', scopes: ['quiet'], receive_all: ['quiet'] };
    e.receive(trigger('a'));
    schedule(e, { id: 'quiet', source: 'clock', scope: 'quiet', due: 2000, text: 'No reply', quiet_thread: 'room', since_trigger: 'a' });
    e.receive(trigger('b')); e.now = 2000; tick(e);
    assert.equal(e.s.schedules.quiet.reason, 'conversation_changed'); assert.equal(Object.values(e.s.triggers).filter(t => t.source === 'clock').length, 0);
});
test('003 Channel: removing a destination drops a stored reply with a durable reason', () => {
    const e = engine(), k = accept(e);
    const reply = e.reply({ ticket_id: k.id, conversation: 'room', source: 'chat', key: 'ack', text: 'Acknowledged' });
    e.s.sources.chat.scopes = []; assert.equal(e.claim({ kinds: ['reply'] }), null);
    assert.equal(reply.state, 'dropped'); assert.equal(reply.reason, 'source_no_longer_listens');
});
test('003 Stored work: failed input delivery is visible and successful retry clears it', () => {
    const e = engine(), k = accept(e); let w = e.claim({ kinds: ['launch'] }); e.settle({ id: w.id, claim: w.claim, ok: true });
    e.receive(trigger('follow')); w = e.claim({ kinds: ['input'] }); e.settle({ id: w.id, claim: w.claim, ok: false });
    assert.equal(k.stage, 'person/delivery'); assert.equal(e.s.work.find(x => x.id === w.id).due, 3000);
    e.now = 3000; w = e.claim({ kinds: ['input'] }); e.settle({ id: w.id, claim: w.claim, ok: true }); assert.equal(k.stage, 'working');
});
test('001 Thread: out-of-order Source replay is presented in event-time order', () => {
    const e = engine(); e.receive(trigger('new', { occurred_at: '2026-11-09T13:00:00.000Z' })); e.receive(trigger('old'));
    assert.deepEqual(e.s.threads.room.triggers, ['old', 'new']); assert.deepEqual(e.start({ thread: 'room' }).ids, ['old', 'new']);
});
test('002 Revalidation: an explicit follow-up mandate survives allowed-list changes', () => {
    const e = engine(), first = accept(e); e.receive(trigger('follow', { addresses_agent: 'none' }));
    e.handBack({ ticket_id: first.id, trigger_id: 'follow', reason: 'Independent scope' });
    const ev = e.start({ thread: 'room' }), second = e.decide({ evaluation: ev.id, decision: 'accept', scope: 'Follow-up' }).ticket;
    assert.equal(e.s.meta[second.id].basis, 'followup'); e.end({ ticket_id: second.id });
    const c = cfg(); c.policy.sources.chat.allowed = []; e.configure(c); e.receive(trigger('resume')); assert.equal(second.state, 'open');
});
test('Command boundary: inherited object names cannot identify Tickets or Threads', () => {
    const e = engine();
    for (const id of ['__proto__', 'constructor', 'prototype']) {
        assert.throws(() => e.end({ ticket_id: id })); assert.throws(() => e.start({ thread: id }));
    }
    assert.equal(Object.prototype.state, undefined);
});
console.log(`${count} fabric rule tests passed`);

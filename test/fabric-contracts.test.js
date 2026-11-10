'use strict';
const assert = require('node:assert/strict');
const contracts = require('openvibe-contracts');
const { Engine, initial } = require('../server/fabric/engine');
// This is intentionally a hard dependency: the fabric must not enable against a Contracts pin
// without the released agent.* schemas. Never replace this with local schemas or a branch pin.
for (const name of ['trigger', 'ticket', 'decision']) assert(contracts.schema(`agent.${name}@1`));
const e = new Engine(initial(), { now: 1, validate: (name, value) => contracts.assertValid(`${name}@1`, value) });
e.configure({ sources: { chat: { kind: 'chat', enabled: true, scopes: ['room'], self: 'agent' } }, policy: { sources: { chat: { allowed: ['person'], bots: [], admission: {} } } } });
e.receive({ id: 'original', source: 'chat', actor: { source: 'chat', id: 'person', kind: 'person' }, source_scope: 'room', threads: ['room'], occurred_at: '2026-11-09T00:00:00.000Z', text: 'Fix test', addresses_agent: 'mention' });
const ev = e.start({ thread: 'room' });
const out = e.decide({ evaluation: ev.id, decision: 'accept', scope: 'Fix test' });
assert.equal(out.ticket.mandate.policy_version, e.s.policy.version);
assert.equal(out.ticket.stage, 'working/queued');
console.log('001 Trigger, Ticket/Mandate and 002 Decision conform to released agent.*@1 schemas');

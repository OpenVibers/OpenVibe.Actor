'use strict';
/**
 * S5 observe → auto (plan W4): lanes start in observe, record what they would have done with the gate's verdict and an
 * estimated cost while doing nothing; the owner promotes one lane to auto; a failed gate or a spent budget puts it
 * back in observe with the reason said in words. The six report states are data.
 */
const assert = require('node:assert/strict');
const { Engine, initial } = require('../server/fabric/engine');
const { REPORT_STATES, REPORT_STATE_VALUES, REPORT_STAGES, reportStates, emptyReportCounts } = require('../server/fabric/reports');

const cfg = () => ({
    sources: { chat: { kind: 'chat', self: 'agent', enabled: true, scopes: ['room'], receive_all: ['room'] } },
    policy: {
        mode: 'auto', rules: [{ id: 'fix', enabled: true, instruction: 'Fix requested defects' }],
        sources: { chat: { allowed: ['alice'], bots: [], admission: { room: { unlisted_addressed: 'inferred', unlisted_unaddressed: 'inferred' } } } },
        budget: { usd: 1, tokens: 1000, wall_minutes: 10 },
    },
});
const trigger = (id = 'a', extra = {}) => ({ id, source: 'chat', actor: { source: 'chat', id: 'bob', kind: 'person' }, source_scope: 'room', threads: ['room'], occurred_at: '2026-11-09T12:00:00.000Z', text: 'Fix the broken test', addresses_agent: 'none', ...extra });
const good = () => ({ decision: 'accept', scope: 'Fix the broken test', direction: { implementation_requested: true, target_basis: 'specified', requires_design_decision: false, evidence: [{ trigger_id: 'a', quote: 'broken test' }] }, rule_assessments: [{ rule_id: 'fix', matched: true, reason: 'Requested a defect fix' }] });
const engine = (options = {}) => {
    const e = new Engine(initial(), { now: 1000, estimate: () => ({ low_usd: 0.02, high_usd: 0.06, basis: 'the last 3 finished runs of this agent' }), ...options });
    e.configure(cfg());
    return e;
};
const assessOnce = (e) => { e.receive(trigger()); const ev = e.start({ thread: 'room' }); return { ev, decision: e.decide({ evaluation: ev.id, decision: 'accept', assessment: good() }) }; };
const report = (ticket, state = 'progress', extra = {}) => ({ ticket_id: ticket.id, assignment_id: 'asg_1', state, summary: state === 'ready' ? 'Done' : 'Working', pr: null, tests_run: [], risks: [], ...extra });

let count = 0;
function test(name, fn) { fn(); count++; console.log(`ok ${name}`); }

test('lane default: a rule without a mode starts in observe, records would-accept and launches nothing', () => {
    const e = engine(), { decision } = assessOnce(e);
    assert.equal(decision.decision.decision, 'ignore'); assert.equal(decision.decision.would_accept, true);
    assert(!e.s.work.some(w => ['launch', 'reply'].includes(w.kind)));
    assert.equal(e.s.observe.length, 1);
    const [o] = e.s.observe;
    assert.deepEqual(o.rule_ids, ['fix']); assert.equal(o.mode, 'observe');
    assert.deepEqual(o.gate, { admitted: true, strength: 'inferred', basis: 'table', decision: 'accept' });
    assert.equal(o.would_accept, true); assert.deepEqual(o.estimate, { low_usd: 0.02, high_usd: 0.06, basis: 'the last 3 finished runs of this agent' });
    assert.match(o.would_do.summary, /Would have started work/); assert.match(o.reason, /Observe/);
});

test('promote and demote: one lane moves to auto by the owner and back with the reason said in words', () => {
    const e = engine();
    const promoted = e.promote({ lane: 'fix' });
    assert.equal(promoted.mode, 'auto'); assert.equal(e.s.policy.mode, 'auto'); assert.equal(e.s.policy.rules[0].mode, 'auto');
    assert.equal(e.s.lane_changes[0].from_mode, 'observe'); assert.equal(e.s.lane_changes[0].actor, 'owner');
    const { decision } = assessOnce(e);
    assert.equal(decision.decision.decision, 'accept'); assert(e.s.work.some(w => w.kind === 'launch'));
    const demoted = e.demote({ lane: 'fix', reason: 'The owner wants to read a few more runs first.' });
    assert.equal(demoted.mode, 'observe'); assert.equal(e.s.policy.rules[0].mode, 'observe');
    assert.equal(e.s.policy.rules[0].demote_reason, 'The owner wants to read a few more runs first.');
    assert.equal(e.s.lane_changes.at(-1).to_mode, 'observe'); assert.equal(e.s.lane_changes.at(-1).actor, 'owner');
});

test('failed gate: an unavailable assessment in auto drops every auto lane back to observe with the reason', () => {
    const e = engine(); e.promote({ lane: 'fix' });
    e.receive(trigger()); const ev = e.start({ thread: 'room' });
    const out = e.decide({ evaluation: ev.id, decision: 'unavailable', reason: 'The assessment model could not return a usable answer.' });
    assert.equal(out.decision.decision, 'unavailable');
    assert.equal(e.s.policy.rules[0].mode, 'observe');
    assert.match(e.s.policy.rules[0].demote_reason, /The gate could not decide: The assessment model could not return a usable answer/);
    assert.deepEqual(e.s.observe[0].demoted_rules, ['fix']);
    assert.equal(e.s.lane_changes.at(-1).actor, 'system');
});

test('spent budget: a report that uses the mandate budget puts the lane back in observe, in words', () => {
    const e = engine(); e.promote({ lane: 'fix' });
    const { decision } = assessOnce(e); const k = decision.ticket;
    e.report({ ticket_id: k.id, report: report(k, 'progress'), spent_usd: 0.4, task_id: 'tsk_1' });
    assert.equal(e.s.meta[k.id].spent_usd, 0.4); assert.equal(e.s.policy.rules[0].mode, 'auto');
    e.report({ ticket_id: k.id, report: report(k, 'progress'), spent_usd: 0.6, task_id: 'tsk_2' });
    assert.equal(e.s.meta[k.id].spent_usd, 1); assert.equal(e.s.policy.rules[0].mode, 'observe');
    assert.match(e.s.policy.rules[0].demote_reason, /used its whole budget of \$1\.00/);
    assert.match(e.s.meta[k.id].budget_stopped.reason, /\$1\.00/);
    // A retried task end does not count its spend twice.
    e.report({ ticket_id: k.id, report: report(k, 'progress'), spent_usd: 0.6, task_id: 'tsk_2' });
    assert.equal(e.s.meta[k.id].spent_usd, 1);
});

test('gate record: a message no gate admits is still a readable verdict with nothing to run', () => {
    const e = new Engine(initial(), { now: 1000 });
    const c = cfg(); c.policy.sources.chat.allowed = ['alice']; c.policy.sources.chat.admission.room = { unlisted_unaddressed: 'ignore' };
    e.configure(c); e.receive(trigger('a', { actor: { source: 'chat', id: 'stranger', kind: 'person' } }));
    const ev = e.start({ thread: 'room' }); assert.equal(ev, null);
    const o = e.s.observe.at(-1);
    assert.deepEqual(o.gate, { admitted: false, strength: 'inferred' }); assert.equal(o.would_accept, false);
    assert.match(o.would_do.summary, /nothing would run/); assert.deepEqual(o.estimate, { low_usd: 0, high_usd: 0, basis: 'nothing would run' });
});

test('report states: the six values and their stages are data, and every count starts at zero', () => {
    assert.deepEqual(REPORT_STATE_VALUES, ['progress', 'waiting', 'ready', 'blocked', 'failed', 'dropped']);
    assert.equal(REPORT_STATES.length, 6);
    for (const s of REPORT_STATES) { assert(s.label); assert(s.meaning); assert(REPORT_STAGES[s.state]); }
    assert.deepEqual(reportStates().map(s => s.state), REPORT_STATE_VALUES);
    assert.deepEqual(emptyReportCounts(), { progress: 0, waiting: 0, ready: 0, blocked: 0, failed: 0, dropped: 0 });
});

console.log(`${count} fabric observe tests passed`);

'use strict';
// What a person's session shows of Actor's work (2026-11-16; the owner, a Vibe session whose four "Thought" blocks were
// Actor's bookkeeping: "the way it's laid out is like kind of ugly with the thinking … better and easier to view"):
// - a plan step is the plan, without the task and progress ledgers (the model's and Actor's own task page's);
// - a plan event that was only ledger is no step;
// - Actor's bookkeeping lines (the task's class, how the agent starts, the run settings) are no step; the events
//   themselves are unchanged (agents.task-event@1 has no field for it).
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { stepOf } = require('../server/http/runs-api');

const plan = stepOf('tsk_1', 4, {
    kind: 'output', step: 'plan', at: '2026-11-16T10:00:00Z',
    text: 'Now 1. Start a 25-minute focus timer\nTask ledger: given Start a timer · find none · derive none\nProgress: not done; not looping; moving; stuck no; next Start a timer',
});
assert.strictEqual(plan.kind, 'think');
assert.strictEqual(plan.text, 'Now 1. Start a 25-minute focus timer', 'the plan without its ledgers');
assert.strictEqual(stepOf('tsk_1', 5, { kind: 'output', step: 'plan', text: 'Task ledger: given x · find y · derive z\nProgress: done' }), null, 'only ledger: no step');
assert.strictEqual(stepOf('tsk_1', 6, { kind: 'output', step: 'text', text: 'Progress: is a word a person may say' }).text, 'Progress: is a word a person may say', 'only plans are trimmed');

// Actor's three bookkeeping lines are never a session's step; the events themselves are unchanged (no new field).
assert.strictEqual(stepOf('tsk_1', 7, { kind: 'output', step: 'plan', text: 'This is a "answer" task.' }), null);
assert.strictEqual(stepOf('tsk_1', 8, { kind: 'output', step: 'plan', text: 'The agent starts with a plan, then works through it.' }), null);
assert.strictEqual(stepOf('tsk_1', 9, { kind: 'output', step: 'plan', text: 'Settings: reads and changes your files · network on · asks before it acts.' }), null);
assert.strictEqual(stepOf('tsk_1', 10, { kind: 'output', step: 'text', text: 'Settings: are where you change your voice.' }).text, 'Settings: are where you change your voice.', 'an answer that starts so is still said');
const engine = fs.readFileSync(path.join(__dirname, '..', 'server', 'tasks', 'engine.js'), 'utf8');
assert.ok(!/internal: true/.test(engine), 'the task events carry no field the contract does not have');
console.log('session-steps: a session shows the plan, not Actor\'s bookkeeping');

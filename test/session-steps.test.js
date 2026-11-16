'use strict';
// What a person's session shows of Actor's work (2026-11-16; the owner, a Vibe session whose four "Thought" blocks were
// Actor's bookkeeping: "the way it's laid out is like kind of ugly with the thinking … better and easier to view"):
// - a plan step is the plan, without the task and progress ledgers (the model's and Actor's own task page's);
// - a plan event that was only ledger is no step;
// - the step queries leave out events Actor marks internal (the task's class, the run settings).
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

const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'http', 'runs-api.js'), 'utf8');
assert.strictEqual((src.match(/COALESCE\(e\.body->>'internal', ''\) <> 'true'/g) || []).length, 2, 'both step queries leave internal events out');
const engine = fs.readFileSync(path.join(__dirname, '..', 'server', 'tasks', 'engine.js'), 'utf8');
for (const said of ['This is a "${cls}" task.', 'The agent starts with a plan, then works through it.', 'Settings: ${runPolicy.describe']) {
    const line = engine.split('\n').find((l) => l.includes(said));
    assert.ok(line && /internal: true/.test(line), `Actor's bookkeeping is internal: ${said}`);
}
console.log('session-steps: a session shows the plan, not Actor\'s bookkeeping');

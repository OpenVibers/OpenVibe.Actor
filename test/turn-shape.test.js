'use strict';
/**
 * The shape of a turn (runtime/turn-shape.js; the owner's phone, 11-21: "Test" and "Search Google" took two to three
 * minutes, showed one reply three times and carried a plan card and a "Checked by …" Thought): a quick ask gets no
 * planner and its short answer no review or claim check; a reply that asks the person something is never checked.
 */
const assert = require('assert');
const { quick, asksPerson, worthChecking } = require('../server/runtime/turn-shape');

const SEARCH = 'What should I search for? There is no query in your message, so give me the words.\n\nFor example: *"best headphones 2026"* or *"Berlin to Lisbon train times"*.';
const HELLO = 'I am here and working. Your machine ov-node-01 is online [E1].\n\nWhat would you like me to do? I can search the web or set up a recurring task.';

assert.strictEqual(asksPerson(SEARCH), true, 'it opens with the question it needs answered');
assert.strictEqual(asksPerson(HELLO.replace(' [E1]', '')), true, 'a paragraph opens with a question');
assert.strictEqual(asksPerson(HELLO), false, 'but an answer citing evidence states facts');
assert.strictEqual(asksPerson('Lisbon is 21 °C and sunny [E1]. Want the week ahead?'), false, 'facts with an offer at the end are checked');
assert.strictEqual(asksPerson('Done. Do you want me to open a PR?'), true, 'it ends on a question');
assert.strictEqual(asksPerson('Answer to: Tell me a live fact from memory'), false, 'quoting "tell me" is not asking');
assert.strictEqual(asksPerson('The sky is blue [E1].'), false);
assert.strictEqual(asksPerson(`${'A long report paragraph. '.repeat(60)}\n\nWhat next?`), false, 'a long report is checked even if it ends asking');

const said = { kind: 'answer', risk: 'low', known: true, facts: { given: [], lookup: [], derive: [] } };
assert.strictEqual(quick(said, 'Test', []), true, '"Test" is a quick ask');
assert.strictEqual(quick(said, 'Search Google', []), true);
assert.strictEqual(quick({ ...said, known: false }, 'Test', []), false, 'a guessed understanding is never quick');
assert.strictEqual(quick({ ...said, facts: { lookup: ['price', 'stock'] } }, 'Compare two GPUs', []), false, 'two things to look up is work');
assert.strictEqual(quick({ ...said, risk: 'high' }, 'Pay the bill', []), false);
assert.strictEqual(quick(said, 'Test', [{ name: 'a.pdf' }]), false, 'files are work');
assert.strictEqual(quick(said, 'x'.repeat(300), []), false, 'a long message is work');

assert.strictEqual(worthChecking({ understanding: said, task: 'Test', text: 'Working, and ov-node-01 is online [E1].' }), false, 'a quick ask\'s short answer');
assert.strictEqual(worthChecking({ understanding: { ...said, facts: { lookup: ['a', 'b'] } }, task: 'Find the facts', text: 'The facts are … [E1].' }), true, 'work is checked');
assert.strictEqual(worthChecking({ understanding: null, task: 'Find the facts', text: SEARCH }), false, 'a question back is not checked');
assert.strictEqual(worthChecking({ understanding: null, task: 'What colour is the sky?', text: 'Answer to: What colour is the sky?', evidence: [{ id: 'E1' }] }), true, 'a run that looked something up is checked');
console.log('turn-shape: quick asks, questions back and what gets checked');

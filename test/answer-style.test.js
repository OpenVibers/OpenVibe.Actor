'use strict';
/**
 * How an agent's answer reads (server/agents/adapters.js ANSWER_STYLE; the owner, 2026-10-28, on a task page: "worded
 * better and have more info and be more insightful and knowledgeable"): every agent system is told to lead with the
 * outcome, give steps when it is blocked, write real Markdown lists, never show tool names, and list sources as links
 * only. The "no computer open" note the agent passes on is a set of steps, not a sentence.
 *
 *   node test/answer-style.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'agents', 'adapters.js'), 'utf8');
const style = src.slice(src.indexOf('const ANSWER_STYLE = `'), src.indexOf('`;', src.indexOf('const ANSWER_STYLE = `')));
assert.ok(style.length > 200, 'the answer style is written down');
for (const rule of ['outcome', '**bold**', 'numbered steps', 'Never show tool names', 'real Markdown lists', '"Sources:"']) {
    assert.ok(style.includes(rule), `the style says: ${rule}`);
}
assert.ok(!src.includes('OpenVibe.Tools <tool id>'), 'sources are links, never tool ids');
const uses = src.match(/\$\{ANSWER_STYLE\}/g) || [];
assert.strictEqual(uses.length, 2, 'both the runtime and the hosted agents are told');

const computers = fs.readFileSync(path.join(__dirname, '..', 'server', 'agents', 'computers.js'), 'utf8');
const note = (/note: `None of the person's computers is open[^`]+`/.exec(computers) || [''])[0];
assert.ok(/1\) .+2\) .+3\) .+4\) /.test(note), 'the note is steps the agent can pass on');
assert.ok(/observe .+ask .+trusted /.test(note), 'and says what each level lets the agent do');
assert.ok(note.includes('--desk-host'), 'a spare machine can host desks instead');

console.log('answer style: all checks passed');

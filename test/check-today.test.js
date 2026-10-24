'use strict';
// The answer checker (server/agents/check.js) is told today's date: a checker model whose training ends earlier refused
// a correct web answer for a release "dated Oct 21, 2026, which is in the future and plainly impossible" (2026-10-24, a
// web search from Vibe on openvibe.chat). The date is UTC, from the clock the engine passes.
const assert = require('assert');
const { check: checkAnswer } = require('../server/agents/check');

(async () => {
    const seen = [];
    const deepseek = async (o) => { seen.push(o.messages[0].content); return { text: '{"ok": true, "reason": "addresses the task"}', cost_usd: 0.0001, model: 'deepseek-flash' }; };
    const verdict = await checkAnswer({
        task: 'What is the latest Node.js release?', answer: 'Node.js v24.22.1, released Oct 21, 2026 (https://nodejs.org).',
        sources: ['https://nodejs.org'], agentId: 'openai-agent', mode: 'balanced', checkers: { deepseek },
        now: () => Date.UTC(2026, 9, 24, 22, 30),
    });
    assert.strictEqual(verdict.ok, true);
    assert.strictEqual(verdict.by, 'deepseek');
    assert.ok(seen[0].includes('Today is 2026-10-24 (UTC). A date on or before today is in the past or present, never in the future'), seen[0].slice(-300));
    assert.ok(seen[0].startsWith('You check an AI agent\'s answer'), 'the rules come first, the date after them');
    console.log('check today: all checks passed');
})().catch((e) => { console.error(e); process.exit(1); });

'use strict';
// decide: Decisions where they help (plan §AD.27; the owner, 11-18: "use decisions and like other smart shit"): the loop
// settles a judgement with calibrated odds over the facts it found; a pick and a rating need their options; a failure
// says so in words.
const assert = require('assert');
const decide = require('../server/runtime/tools/decide');
const { check, done } = require('./helpers/boot');

(async () => {
    const asked = [];
    const models = { async decide(body) { asked.push(body); const s = body.questions.q;
        if (s.type === 'noul') return { answers: { q: { type: 'noul', noul: 0.82 } }, calibrated: true, receipt: { cost_usd: 0.0004 } };
        if (s.type === 'choice') return { answers: { q: { type: 'choice', choice: 'netcup RS 4000', probabilities: { 'netcup RS 4000': 0.71, 'Contabo VPS 40': 0.29 } } }, calibrated: true, receipt: {} };
        return { answers: { q: { type: 'score', score: 2.2, probabilities: { 0: 0.1, 1: 0.2, 2: 0.7 } } }, calibrated: false, receipt: {} }; } };
    await check('a yes-or-no, a pick and a rating answer with their odds, over the facts', async () => {
        const yes = await decide.run({ question: 'Is the RS 4000 a good core server for us?', kind: 'yes_no', facts: '12 dedicated cores, 32 GB, 1 TB NVMe' }, { models });
        assert.match(yes.text, /^Yes, 82% sure: Is the RS 4000/);
        assert.ok(/Facts:\n12 dedicated cores/.test(asked[0].input), 'the facts go with the question');
        const pick = await decide.run({ question: 'Which should be the core?', kind: 'pick', options: ['netcup RS 4000', 'Contabo VPS 40'] }, { models });
        assert.match(pick.text, /^netcup RS 4000 \(71%\)/);
        assert.match(pick.text, /- Contabo VPS 40: 29%/);
        const rate = await decide.run({ question: 'How good is its disk?', kind: 'rate', options: ['poor', 'fine', 'great'] }, { models });
        assert.match(rate.text, /^great \(2\.20 on 0 to 2\)/);
        assert.match(rate.text, /estimated odds/);
    });
    await check('a pick needs 2 to 12 options; a failure says so', async () => {
        assert.match((await decide.run({ question: 'Which?', kind: 'pick', options: ['only one'] }, { models })).error, /2 to 12 options/);
        assert.match((await decide.run({ question: '', kind: 'yes_no' }, { models })).error, /one question/);
        const down = await decide.run({ question: 'Is it?', kind: 'yes_no' }, { models: { async decide() { throw new Error('HTTP 503'); } } });
        assert.match(down.error, /did not answer: HTTP 503/);
        assert.strictEqual(decide.available({ models: {} }), false);
        assert.strictEqual(decide.available({ models }), true);
    });
    await check('the step says it weighed it up', () => {
        assert.strictEqual(require('../server/agent-ui/mapper').titleFor('decide', { question: 'Which core?' }).title, 'Weighed up: Which core?');
    });
    done();
})();

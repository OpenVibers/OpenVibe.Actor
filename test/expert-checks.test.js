'use strict';
/**
 * OpenVibe's own Experts checked on their own examples (plan §AD.28 item 9; server/agents/expert-checks.js): each
 * example answered from the Expert's instructions (one model call, its compiled prompt, no tools) and graded against
 * its "good" on five levels by the Decisions API; a version is checked once; a version with a failed example is not
 * shown half-checked; nothing runs where the Decisions API is not configured; the Expert's page shows the mean and each
 * graded answer.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const checks = require('../server/agents/expert-checks');

(async () => {
    const t = await boot();
    try {
        const s = t.ctx.s;
        const calls = { chat: [], decide: [] };
        let failAsk = null;
        const models = {
            decideReady: () => true,
            async chat({ messages }) {
                calls.chat.push(messages);
                const ask = messages[messages.length - 1].content;
                if (failAsk && ask.includes(failAsk)) throw new Error('provider down');
                return { text: `A careful answer to: ${ask.slice(0, 40)}`, cost_usd: 0.001, model: 'test-model' };
            },
            async decide(body) {
                calls.decide.push(body);
                return { answers: { grade: { type: 'score', score: 3, legend: { 3: 'Good' } } }, calibrated: true, receipt: { cost_usd: 0.0004 } };
            },
        };

        await check('nothing runs where the Decisions API is not configured', async () => {
            const out = await checks.run(s, { models: { ...models, decideReady: () => false }, log: { info() {}, warn() {} } });
            assert.deepStrictEqual(out.checked, []);
            assert.strictEqual(calls.chat.length, 0);
        });

        await check('a version is checked once: answered from its own prompt, graded on five levels', async () => {
            failAsk = 'I owe $5,000';   // the Debt planner's example fails this round
            const out = await checks.run(s, { models, limit: 20, log: { info() {}, warn() {} } });
            assert.ok(out.checked.includes('bp_budget_coach@1'), JSON.stringify(out));
            assert.ok(!out.checked.some((x) => x.startsWith('bp_debt_planner@')), 'a failed example leaves the version unchecked');
            const first = calls.chat[0];
            assert.strictEqual(first[0].role, 'system');
            assert.match(first[0].content, /you have no tools here/);
            assert.strictEqual(calls.decide[0].questions.grade.type, 'score');
            assert.deepStrictEqual(calls.decide[0].questions.grade.criteria, checks.LEVELS);
            assert.match(calls.decide[0].input, /What a good answer does:/);
            const score = await checks.scoreOf(s, 'bp_budget_coach', 1);
            assert.deepStrictEqual([score.mean, score.count, score.rows[0].level], [4, 1, 'Good'], 'Decisions\' 3 of 0..4 is 4 of 5');
            const before = calls.chat.length;
            failAsk = null;
            const again = await checks.run(s, { models, limit: 20, log: { info() {}, warn() {} } });
            assert.deepStrictEqual(again.checked, ['bp_debt_planner@1'], 'only the one still unchecked');
            assert.ok(calls.chat.length - before <= 3);
        });

        await check('the Expert\'s page shows the mean and each graded answer', async () => {
            const page = await t.get('/experts/bp_budget_coach');
            assert.strictEqual(page.status, 200);
            assert.match(page.text, /Checked on these: 4\.0 of 5/);
            assert.match(page.text, /<details class="ex-graded"><summary>Good, 4\.0 of 5: read its answer<\/summary><p>A careful answer to:/);
            const unchecked = await t.get('/experts/bp_openvibe_builder');
            assert.ok(unchecked.status === 200 || unchecked.status === 404);
        });
    } finally {
        await done(t);
    }
})().catch((err) => { console.error(err); process.exit(1); });

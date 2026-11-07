'use strict';
/**
 * A-1 (plan §12): the approval levels and the always-ask floor. At every level, money, a password, a deletion and a
 * message to a new recipient ask the person first; full access skips everything else. Approve-for-me uses a reviewer
 * on the check tier of another family, and fails closed (asks the person) when no reviewer can answer.
 */
const assert = require('assert');
const { check, done } = require('./helpers/boot');
const levels = require('../server/agents/levels');

const ALWAYS = [
    ['money', { summary: 'Pay the invoice for the domain renewal.' }],
    ['password', { summary: 'Enter the password for the router admin page.' }],
    ['delete', { summary: 'Delete the old repository from their machine.' }],
    ['new_recipient', { summary: 'Send an email to bob@example.com about the meeting.' }],
];

(async () => {
    await check('the four categories are detected from the step text and from an explicit category', () => {
        for (const [category, step] of ALWAYS) assert.ok(levels.classify(step).includes(category), `${category}: ${JSON.stringify(step)}`);
        assert.deepStrictEqual(levels.classify({ summary: 'Open the file', category: 'delete' }), ['delete'], 'a caller naming a floor category cannot escape it');
        assert.deepStrictEqual(levels.classify({ summary: 'Check the build log' }), []);
        assert.deepStrictEqual(levels.classify({ summary: 'Message someone new', recipientKnown: false }), ['new_recipient']);
        assert.deepStrictEqual(levels.classify({ summary: 'Reply to this thread' }), [], 'a reply in the same thread is not a new recipient');
    });

    for (const level of levels.LEVELS) {
        await check(`${level}: every always-ask category still asks`, async () => {
            for (const [category, step] of ALWAYS) {
                const categories = levels.classify(step);
                const out = await levels.decide({ level, categories, act: 'act' });
                assert.strictEqual(out.ask, true, `${level} did not ask for ${category}`);
                assert.strictEqual(out.floor, category);
            }
        });
    }

    await check('full access runs ordinary acts; ask, auto-edits and approve-for-me differ where they should', async () => {
        const ordinary = { summary: 'Open the project page and read the README' };
        assert.strictEqual((await levels.decide({ level: 'full', categories: levels.classify(ordinary), act: 'act' })).ask, false);
        assert.strictEqual((await levels.decide({ level: 'ask', categories: levels.classify(ordinary), act: 'act' })).ask, true);
        assert.strictEqual((await levels.decide({ level: 'auto-edits', categories: levels.classify(ordinary), act: 'edit' })).ask, false);
        assert.strictEqual((await levels.decide({ level: 'auto-edits', categories: levels.classify(ordinary), act: 'act' })).ask, true);
    });

    await check('approve-for-me asks the check tier of another family, and its yes lets an ordinary act through', async () => {
        const calls = [];
        const models = {
            resolve: (tier) => { assert.strictEqual(tier, 'smart'); return { family: 'openai', provider: 'openai', model: 'gpt-5.1' }; },
            chat: async (req) => {
                calls.push(req);
                return { text: '{"decision":"approve","reason":"It only reads a page."}', provider: 'deepseek', model: 'deepseek-reasoner', family: 'deepseek' };
            },
        };
        const out = await levels.decide({ level: 'approve-for-me', categories: [], act: 'act', models, summary: 'Read the project page', payload: { path: 'README.md' } });
        assert.strictEqual(out.ask, false);
        assert.deepStrictEqual(out.reviewer.reviewer, { tier: 'check', provider: 'deepseek', model: 'deepseek-reasoner', family: 'deepseek' });
        assert.strictEqual(calls.length, 1);
        assert.deepStrictEqual([calls[0].tier, calls[0].avoidFamily, calls[0].json], ['check', 'openai', true]);
        // A deny asks the person, and the reviewer's words stay with the decision.
        const denied = await levels.decide({ level: 'approve-for-me', categories: [], act: 'act', models: { ...models, chat: async () => ({ text: '{"decision":"deny","reason":"Not what was asked."}', provider: 'deepseek', model: 'deepseek-reasoner', family: 'deepseek' }) }, summary: 'Read x' });
        assert.deepStrictEqual([denied.ask, denied.reason], [true, 'Not what was asked.']);
    });

    await check('approve-for-me still asks for every floor category, even if the reviewer says yes', async () => {
        let reviewed = 0;
        const models = { resolve: () => ({ family: 'openai' }), chat: async () => { reviewed++; return { text: '{"decision":"approve","reason":"ok"}', family: 'deepseek' }; } };
        for (const [category, step] of ALWAYS) {
            const out = await levels.decide({ level: 'approve-for-me', categories: levels.classify(step), act: 'act', models, summary: step.summary });
            assert.deepStrictEqual([out.ask, out.floor], [true, category]);
        }
        assert.strictEqual(reviewed, 0, 'the floor is decided without a model');
    });

    await check('no reviewer or a failing one asks the person (fail closed)', async () => {
        assert.strictEqual((await levels.decide({ level: 'approve-for-me', categories: [], act: 'act', models: null })).ask, true);
        const broken = { resolve: () => ({ family: 'openai' }), chat: async () => { throw new Error('provider down'); } };
        const out = await levels.decide({ level: 'approve-for-me', categories: [], act: 'act', models: broken, summary: 'Read x' });
        assert.strictEqual(out.ask, true);
        assert.match(out.reason, /could not decide/);
    });

    await check('maxLevel is the plan ordering and ignores an unknown level', () => {
        assert.strictEqual(levels.maxLevel('ask', 'auto-edits'), 'auto-edits');
        assert.strictEqual(levels.maxLevel('full', 'ask'), 'full');
        assert.strictEqual(levels.maxLevel('approve-for-me', 'full'), 'full');
        assert.strictEqual(levels.maxLevel('ask', 'nonsense'), 'ask');
    });

    done();
})().catch((e) => { console.error(e); process.exit(1); });

'use strict';
/**
 * The router asks the Decisions API first (plan §AD.27 item 6, "Decisions where they help"): one closed question over
 * the seven classes, with each class's meaning; its pick stands when it is at least 45% sure. Unsure or down, the cheap
 * model decides; with neither, the heuristic. An answer is kept a day per task text, so the same ask costs nothing to
 * sort again; what each step cost is the task's.
 */
const assert = require('assert');
const { classify, forget, CLASSES, MEANINGS } = require('../server/agents/classify');

const answer = (choice, sure, cost = 0.0004) => ({ answers: { class: { type: 'choice', choice, probabilities: { [choice]: sure } } }, calibrated: true, receipt: { cost_usd: cost } });

(async () => {
    assert.deepStrictEqual(Object.keys(MEANINGS).sort(), [...CLASSES].sort(), 'every class has a meaning for the Decisions API');

    forget();
    const asked = [];
    let r = await classify('Write me a haiku about rain', { decide: async (body) => { asked.push(body); return answer('answer', 0.91); }, chat: async () => { throw new Error('the model is not needed'); } });
    assert.deepStrictEqual(r, { class: 'answer', cost_usd: 0.0004, by: 'decisions', sure: 0.91 });
    assert.strictEqual(asked[0].questions.class.type, 'choice');
    assert.deepStrictEqual(Object.keys(asked[0].questions.class.criteria).sort(), [...CLASSES].sort(), 'one closed question over the seven');
    assert.strictEqual(asked[0].input, 'Write me a haiku about rain');

    r = await classify('  write me a HAIKU about rain ', { decide: async () => { throw new Error('not asked twice'); } });
    assert.deepStrictEqual(r, { class: 'answer', cost_usd: 0, by: 'cache' }, 'the same words are kept: no second question');

    // Unsure: the cheap model decides, and both costs are the task's.
    forget();
    r = await classify('check the mx records of example.com', {
        decide: async () => answer('web', 0.3, 0.0005),
        chat: async () => ({ text: '{"class":"lookup"}', cost_usd: 0.0002 }),
    });
    assert.deepStrictEqual([r.class, r.by, Number(r.cost_usd.toFixed(4))], ['lookup', 'model', 0.0007]);

    // Down: the model decides; with no model either, the heuristic.
    forget();
    r = await classify('fix the bug in my python script', { decide: async () => { throw new Error('503'); }, chat: async () => ({ text: '{"class":"code"}', cost_usd: 0.0001 }) });
    assert.deepStrictEqual([r.class, r.by], ['code', 'model']);
    forget();
    r = await classify('fix the bug in my python script', { decide: async () => { throw new Error('503'); } });
    assert.deepStrictEqual([r.class, r.by, r.cost_usd], ['code', 'heuristic', 0]);

    // A pick outside the seven is not taken.
    forget();
    r = await classify('what is the weather in Lisbon today', { decide: async () => answer('weather', 0.99), chat: null });
    assert.deepStrictEqual([r.class, r.by], ['web', 'heuristic']);

    // Without Decisions, the model path is as before.
    forget();
    r = await classify('summarise https://example.com/post', { chat: async () => ({ text: '{"class":"research"}', cost_usd: 0.0001 }) });
    assert.deepStrictEqual([r.class, r.by], ['research', 'model']);

    console.log('classify: Decisions first (45% sure), then the model, then the heuristic; kept a day per task text');
})().catch((err) => { console.error(err); process.exit(1); });

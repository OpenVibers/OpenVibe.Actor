'use strict';

const assert = require('node:assert/strict');
const { check, done } = require('./helpers/boot');
const personal = require('../server/agents/personal');

(async () => {
    await check('prompt layers are source-named and task changes leave the stored prefix unchanged', () => {
        const agent = { id: 'agt_test', instructions: 'Use metric units.', updated_at: '2026-11-09T00:00:00Z' };
        const notes = [{ status: 'active', source: 'person', kind: 'preference', text: 'Use Celsius.' }];
        const before = personal.promptLayers(agent, notes, 'Plan a trip');
        const after = personal.promptLayers(agent, notes, 'Plan a meal');
        assert.ok(before.every(layer => layer.source && layer.version));
        assert.deepEqual(before.slice(0, -1), after.slice(0, -1));
        assert.match(before[0].text, /Use metric units/);
        assert.match(before.at(-1).text, /Plan a trip/);
        assert.match(after.at(-1).text, /Plan a meal/);
    });
    done();
})().catch(err => { console.error(err); process.exit(1); });

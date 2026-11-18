'use strict';
// A step says what it did (the owner's phone, 11-18: rows that read "Performed an action"): Actor's own tools in words,
// and a tool nobody named still names itself.
const assert = require('assert');
const { titleFor, toolWords } = require('../server/agent-ui/mapper');
const { check, done } = require('./helpers/boot');

(async () => {
    await check('Actor\'s own tools say what they did', () => {
        assert.strictEqual(titleFor('read_page', { url: 'https://example.com/a' }).title, 'Read example.com');
        assert.strictEqual(titleFor('read_pages', { urls: ['https://a.example/1', 'https://b.example/2'] }).title, 'Read 2 pages: a.example, b.example');
        assert.strictEqual(titleFor('fetch_data', { url: 'https://api.us.ovhcloud.com/1.0/x' }).title, 'Checked the data at api.us.ovhcloud.com');
        assert.strictEqual(titleFor('weather_now', { place: 'Berlin' }).title, 'Checked the weather in Berlin');
        assert.strictEqual(titleFor('market_quote', { symbol: 'solana' }).title, 'Looked up the price of solana');
        assert.strictEqual(titleFor('codes_task', { repo: 'OpenVibers/demo', instruction: 'x' }).title, 'Started a coding task in OpenVibers/demo');
        assert.strictEqual(titleFor('wikipedia', { query: 'Ada Lovelace' }).title, 'Read Wikipedia on Ada Lovelace');
    });
    await check('a tool nobody named still names itself, never "Performed an action"', () => {
        assert.strictEqual(toolWords('sports_scores', {}), 'Used sports scores');
        assert.strictEqual(toolWords('space_files_write', { path: 'index.html' }), 'Used space files write: index.html');
        assert.strictEqual(toolWords('', null), 'Used a tool');
        const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'server', 'agent-ui', 'mapper.js'), 'utf8');
        assert.ok(!/'Performed an action'/.test(src), 'the old words are gone');
    });
    done();
})();

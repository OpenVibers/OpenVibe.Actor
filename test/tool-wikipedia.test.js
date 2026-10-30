'use strict';
// wikipedia: the summary, the key facts and the page as the source.
const assert = require('assert');
const wikipedia = require('../server/runtime/tools/wikipedia');
const { fixtureFetch, ctxOf } = require('./helpers/tool-fixtures');
const { check, done } = require('./helpers/boot');

const routes = {
    'en.wikipedia.org/api/rest_v1/page/summary/Marie_Curie': 'wikipedia-summary-marie-curie.json',
    'en.wikipedia.org/w/api.php': 'wikipedia-query-marie-curie.json',
};

(async () => {
    await check('wikipedia gives the summary and the key facts', async () => {
        const f = fixtureFetch(routes);
        const out = await wikipedia.run({ topic: 'Marie Curie' }, ctxOf(f.fetchImpl));
        assert.ok(!out.error, out.error);
        assert.ok(out.data.extract.includes('Curie'), out.data.extract);
        assert.strictEqual(out.data.title, 'Marie Curie');
        assert.strictEqual(out.data.wikibase_item, 'Q7186');
        assert.ok(out.data.page_id > 0);
        assert.ok(out.data.last_revision, 'the last edit');
        assert.ok(out.data.categories.length > 0, 'the categories');
        assert.ok(out.text.includes('Key facts'), out.text);
    });

    await check('wikipedia carries the page as its source', async () => {
        const f = fixtureFetch(routes);
        const out = await wikipedia.run({ topic: 'Marie Curie' }, ctxOf(f.fetchImpl));
        assert.ok(!out.error, out.error);
        assert.strictEqual(out.sources[0].url, 'https://en.wikipedia.org/wiki/Marie_Curie');
        assert.ok(out.sources[0].title.includes('Marie Curie'));
    });

    await check('a topic Wikipedia does not have is an error the model can act on', async () => {
        const f = fixtureFetch({
            'en.wikipedia.org/api/rest_v1/page/summary/Marie_Curie': () => null,
            'en.wikipedia.org/w/api.php': 'wikipedia-query-marie-curie.json',
        });
        const out = await wikipedia.run({ topic: 'Nobody At All' }, ctxOf(f.fetchImpl));
        assert.ok(out.error && out.error.includes('Nobody At All'), out.error);
    });

    await check('a language that is not a Wikipedia language is refused', async () => {
        const out = await wikipedia.run({ topic: 'Marie Curie', language: 'nonsense!' }, ctxOf(fixtureFetch(routes).fetchImpl));
        assert.ok(out.error && out.error.includes('language'), out.error);
    });

    done();
})();

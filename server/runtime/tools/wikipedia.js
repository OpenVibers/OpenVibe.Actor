'use strict';
/**
 * wikipedia: what a topic is, in a summary and in the facts that go with it.
 *
 * Source: Wikipedia's own REST API (the page summary) and its action API (the lead section, the
 * page id, the Wikidata item, the last edit and the categories). Both are free, keyless and ask
 * for a descriptive User-Agent, which Actor sends. The English edition is the default; any other
 * language Wikipedia has can be asked for by its code.
 */
const { Cache, ToolError, memo, requestJson, source, fail } = require('./lib/util');

const TTL_MS = 30 * 60 * 1000;
const CACHE = new Cache();

const isLanguage = (code) => typeof code === 'string' && /^[a-z]{2,3}(-[a-z]{2,8})?$/.test(code);

/** Wikipedia's own summary of a page. */
async function summary(ctx, language, title, signal) {
    const url = 'https://' + language + '.wikipedia.org/api/rest_v1/page/summary/' + encodeURIComponent(title.replace(/ /g, '_'));
    const { data } = await requestJson(ctx, url, { signal, label: 'Wikipedia' });
    return data || null;
}

/** The lead section and the facts behind the page. */
async function facts(ctx, language, title, signal) {
    const url = 'https://' + language + '.wikipedia.org/w/api.php'
        + '?action=query&format=json&formatversion=2&redirects=1'
        + '&prop=extracts|pageprops|revisions|categories'
        + '&exintro=1&explaintext=1&rvprop=timestamp&cllimit=30'
        + '&titles=' + encodeURIComponent(title);
    const { data } = await requestJson(ctx, url, { signal, label: 'Wikipedia' });
    const pages = data && data.query && Array.isArray(data.query.pages) ? data.query.pages : [];
    return pages[0] || null;
}

module.exports = {
    name: 'wikipedia',
    description: 'A summary of a topic from Wikipedia, with its key facts: the lead section, the Wikidata item, the '
        + 'last edit and the categories it sits in. English by default; any Wikipedia language can be asked for. '
        + 'Use it for people, places, works, events and ideas - not for numbers that change (prices, weather, scores).',
    input: {
        type: 'object',
        properties: {
            topic: { type: 'string', description: 'The topic to look up, for example "Marie Curie", "Ada Lovelace" or "Photosynthesis".' },
            language: { type: 'string', description: 'The Wikipedia language edition, for example "en", "de", "fr". Defaults to en.' },
        },
        required: ['topic'],
    },
    scope: 'public',
    costUsd: 0,
    timeoutMs: 15000,
    sources: [source('https://en.wikipedia.org/', 'Wikipedia')], 

    async run(input = {}, ctx = {}) {
        const topic = String(input.topic || '').trim();
        if (!topic) return fail('wikipedia needs a topic, for example "Marie Curie".');
        const language = String(input.language || 'en').trim().toLowerCase();
        if (!isLanguage(language)) {
            return fail('the language "' + language + '" is not a Wikipedia language code (for example "en" or "pt-br").');
        }
        const key = 'wikipedia:' + language + ':' + topic.toLowerCase();

        try {
            const result = await memo(CACHE, key, TTL_MS, async () => {
                let sum = null;
                try {
                    sum = await summary(ctx, language, topic, ctx.signal);
                } catch (err) {
                    if (err && /answered 404/.test(err.message)) throw new ToolError('Wikipedia has no article about "' + topic + '"', 'tool.not_found');
                    throw err;
                }
                if (!sum || sum.type === 'https://mediawiki.org/wiki/HyperSwitch/errors/not_found') {
                    throw new ToolError('Wikipedia has no article about "' + topic + '"', 'tool.not_found');
                }
                let page = null;
                try {
                    page = await facts(ctx, language, topic, ctx.signal);
                } catch {
                    page = null;
                }
                return build(sum, page, language, topic);
            });
            return result;
        } catch (err) {
            return fail((err && err.message) || 'the article could not be fetched');
        }
    },
};

function build(sum, page, language, topic) {
    const title = (page && page.title) || sum.title || topic;
    const pageUrl = 'https://' + language + '.wikipedia.org/wiki/' + encodeURIComponent(String(title).replace(/ /g, '_'));
    const extract = (page && page.extract && page.extract.trim()) || (sum.extract || '');
    const categories = ((page && page.categories) || []).map((c) => c.title).filter(Boolean);
    const revision = page && page.revisions && page.revisions[0] ? page.revisions[0].timestamp : null;
    const wikibase = (page && page.pageprops && page.pageprops.wikibase_item) || sum.wikibase_item || null;

    const lines = [];
    if (sum.description) lines.push(title + ' — ' + sum.description + '.');
    if (extract) lines.push(extract);
    const keyFacts = [];
    if (page && page.pageid) keyFacts.push('Wikipedia page ' + page.pageid);
    if (wikibase) keyFacts.push('Wikidata ' + wikibase);
    if (revision) keyFacts.push('last edited ' + revision);
    if (categories.length) keyFacts.push('categories: ' + categories.slice(0, 12).join(', '));
    if (keyFacts.length) lines.push('Key facts — ' + keyFacts.join('; ') + '.');

    return {
        text: lines.join('\n'),
        data: {
            title,
            description: sum.description || null,
            extract,
            page_id: page && page.pageid ? page.pageid : (sum.pageid || null),
            wikibase_item: wikibase,
            last_revision: revision,
            categories,
            page_url: pageUrl,
            thumbnail: sum.thumbnail ? sum.thumbnail.source : null,
            language,
            fetched_at: new Date().toISOString(),
        },
        sources: [source(pageUrl, 'Wikipedia: ' + title)],
        artifacts: [],
    };
}

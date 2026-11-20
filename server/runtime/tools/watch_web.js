'use strict';

/**
 * watch_web: "tell me when …" about the web (plan AD.34 item 6). Saves a web watch for the person on OpenVibe.Search
 * (a saved search with scope web): once a day Search searches the web for these words as the person and notifies them
 * when results appear that it has not shown before. Cheaper and quieter than a routine that runs the whole agent every
 * day: one search a day, no model, and only new results are announced. It keeps running after this turn, so it is an
 * act of kind `routine` and the person approves it.
 */

const { serviceFor, personOf } = require('./_openvibe');

module.exports = {
    name: 'watch_web',
    description: 'Watch the web for something new, for your person: once a day OpenVibe.Search searches the web for these words and notifies them when results appear that it has not shown before (the first day only records what is there). Use it for "tell me when …" about news, a release, a price or a page. At most 10 watches per person; they see and remove them on OpenVibe.Search. Not for OpenVibe content (search_openvibe) or for work to do on a schedule (schedule_trigger).',
    input: {
        type: 'object',
        properties: {
            query: { type: 'string', maxLength: 300, description: 'The words to search for, as you would type them in a search box' },
            name: { type: 'string', maxLength: 100, description: 'A short name the notification uses (default: the words)' },
        },
        required: ['query'],
    },
    scope: 'person', acts: true, costUsd: 0, timeoutMs: 20_000,
    needs: { files: 'none', network: true },
    connector: 'openvibe',
    available: (ctx) => Boolean(ctx.config && ctx.config.services && ctx.config.services.searchUrl && ctx.config.oauth && ctx.config.oauth.clientSecret && personOf(ctx.requester)),
    async run(input, ctx) {
        const person = personOf(ctx.requester);
        if (!person) return { text: 'A web watch is for a signed-in person.', isError: true };
        const out = await serviceFor(ctx).watchWeb(input.query, input.name, person, { signal: ctx.signal });
        if (out.error) return { text: out.error, isError: true, data: out };
        return {
            text: out.created
                ? `Watching the web for “${out.q}”: once a day, your person is told of results not shown before.`
                : `Already watching the web for “${out.q}”.`,
            data: out,
        };
    },
};

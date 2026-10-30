'use strict';

const { serviceFor, json, personOf } = require('./_openvibe');

module.exports = {
    name: 'search_openvibe',
    description: 'Search everything published on the OpenVibe network (streams, clips, pastes, community posts, wiki pages, blog posts, threads). Returns titles, summaries and links.',
    input: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    scope: 'public',
    costUsd: 0,
    timeoutMs: 20_000,
    available: (ctx) => Boolean(ctx.config && ctx.config.services && ctx.config.services.searchUrl),
    async run(input, ctx) {
        const core = serviceFor(ctx);
        const out = await core.searchOpenVibe(input.query, { signal: ctx.signal });
        const data = out && out.error ? out : { results: out };
        return { text: json(data), data, sources: Array.isArray(out) ? out.filter((x) => x.url).map((x) => ({ url: x.url, title: x.title })) : [] };
    },
    personOf,
};

'use strict';

const { serviceFor, json, personOf } = require('./_openvibe');

module.exports = {
    name: 'search_web',
    description: 'Search the web for anything outside OpenVibe (news, facts, documentation, products). Returns up to 6 results, each with its title, summary, URL, site and date: cite the URLs you use. Prefer search_openvibe for OpenVibe content.',
    input: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    scope: 'public',
    costUsd: 0,
    timeoutMs: 35_000,
    available: (ctx) => Boolean(ctx.config && ctx.config.services && ctx.config.services.searchUrl && ctx.config.oauth && ctx.config.oauth.clientSecret),
    async run(input, ctx) {
        const core = serviceFor(ctx);
        const out = await core.searchWeb(input.query, personOf(ctx.requester), { signal: ctx.signal });
        const data = out && out.error ? out : out;
        return { text: json(data), data, sources: out && Array.isArray(out.results) ? out.results.map((x) => ({ url: x.url, title: x.title || x.site })) : [] };
    },
};

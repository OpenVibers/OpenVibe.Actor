'use strict';

const { serviceFor, json, sourcesOf } = require('./_openvibe');

module.exports = {
    name: 'read_page',
    description: 'Read a public web page as text (title, description, main text, links). Use it for URLs the task gives or that a result links to.',
    input: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
    scope: 'public',
    costUsd: 0,
    timeoutMs: 40_000,
    available: (ctx) => Boolean(ctx.config && ctx.config.services && ctx.config.services.toolsUrl),
    async run(input, ctx) {
        const data = await serviceFor(ctx).runTool('read', { url: String(input.url || ''), max_chars: 12000 }, { signal: ctx.signal });
        return { text: json(data), data, sources: sourcesOf(data) };
    },
};

'use strict';

const { serviceFor, json } = require('./_openvibe');

module.exports = {
    name: 'find_tools',
    description: 'Find OpenVibe.Tools tools for a need (for example "mx records", "ssl certificate", "whois", "http headers", "base64", "hash"). Returns each tool id with its input schema and an example.',
    input: { type: 'object', properties: { need: { type: 'string' } }, required: ['need'] },
    scope: 'public',
    costUsd: 0,
    timeoutMs: 20_000,
    available: (ctx) => Boolean(ctx.config && ctx.config.services && ctx.config.services.toolsUrl),
    async run(input, ctx) {
        const out = await serviceFor(ctx).findTools(input.need, { signal: ctx.signal });
        return { text: json(out), data: out };
    },
};

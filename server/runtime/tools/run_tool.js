'use strict';

const { serviceFor, json, sourcesOf } = require('./_openvibe');

module.exports = {
    name: 'run_tool',
    description: 'Run one OpenVibe.Tools tool by id with its input object (use find_tools first to see the input).',
    input: { type: 'object', properties: { tool: { type: 'string' }, input: { type: 'object' } }, required: ['tool', 'input'] },
    scope: 'public',
    acts: true,
    costUsd: 0,
    timeoutMs: 40_000,
    available: (ctx) => Boolean(ctx.config && ctx.config.services && ctx.config.services.toolsUrl),
    async run(input, ctx) {
        const data = await serviceFor(ctx).runTool(String(input.tool || ''), input.input, { signal: ctx.signal });
        return { text: json(data), data, sources: sourcesOf(data) };
    },
};

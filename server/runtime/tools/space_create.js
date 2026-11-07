'use strict';

/**
 * Make one of the person's own spaces on OpenVibe.Space (plan 2026-10-22 §Z stage Z1).
 *
 * The space is made from Space's blank template; the agent then writes its files with space_files_write.
 * Only the person's own spaces are in reach: Space reads the person in X-OV-Subject and refuses any space
 * that is not theirs.
 *
 * This makes a space, so it is an acting call: the loop checkpoints the intent before it runs.
 */

const { spaceFor, personOf } = require('./_space');

module.exports = {
    name: 'space_create',
    description: 'Make a new space of your own on OpenVibe.Space. The space starts from Space\'s blank template; write its files with space_files_write and show it with space_preview. Answers the space (its id, slug and name).',
    input: { type: 'object', properties: { name: { type: 'string', description: 'the space\'s name, in a few words' }, description: { type: 'string', description: 'what the space does, in one line' } } },
    scope: 'person',
    costUsd: 0,
    timeoutMs: 20_000,
    acts: true,
    available: (ctx) => Boolean(ctx.config && ctx.config.services && ctx.config.services.spaceUrl && ctx.config.oauth && ctx.config.oauth.clientSecret && personOf(ctx.requester)),
    async run(input, ctx) {
        const space = spaceFor(ctx);
        if (!space.enabled) return { text: JSON.stringify({ error: 'OpenVibe.Space is not connected to this server' }), isError: true };
        const person = personOf(ctx.requester);
        const node = typeof ctx.assign === 'function' ? await ctx.assign({ mode: 'work', reply: 'resume', agentId: ctx.agentId || null, state: 'running' }) : null;
        if (node && node.error) return { text: JSON.stringify({ error: `not started: ${node.error}` }), isError: true, data: node };
        const body = {};
        if (input && input.name) body.name = String(input.name).slice(0, 40);
        if (input && input.description) body.description = String(input.description).slice(0, 400);
        const out = await space.call('POST', '/api/v1/builder/spaces', person, body);
        if (!out.ok) {
            if (node && typeof ctx.closeAssignment === 'function') await ctx.closeAssignment(node.id, 'failed');
            return { text: JSON.stringify({ error: out.error }), isError: true };
        }
        if (node && typeof ctx.closeAssignment === 'function') await ctx.closeAssignment(node.id, 'succeeded');
        const s = out.data && out.data.space;
        return { text: JSON.stringify({ space: s || null }), data: { space: s || null } };
    },
};

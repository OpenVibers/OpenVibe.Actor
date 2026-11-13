'use strict';

/**
 * Ask to publish one of the person's own spaces on OpenVibe.Space (plan 2026-10-22 §Z stage Z1).
 *
 * Publishing puts the space on the open web at its own address, so the agent never does it on its own: it
 * asks, and the person answers in the Dock (the "Needs you" card) or on the space's page. Until they answer,
 * nothing goes live and the answer says so.
 *
 * This changes the world, so it is an acting call: the loop checkpoints the intent before it runs.
 */

const { spaceFor, personOf, spaceIdOf } = require('./_space');

module.exports = {
    name: 'space_publish',
    description: 'Ask to publish one of your spaces on OpenVibe.Space. The person answers before anything goes live, so this answers "waiting for your approval" until they do. Tell them what the space is and where they can see it.',
    input: { type: 'object', properties: { space_id: { type: 'string', description: 'the space id (spc_…)' } }, required: ['space_id'] },
    scope: 'person',
    connector: 'space',
    costUsd: 0,
    timeoutMs: 20_000,
    acts: true,
    available: (ctx) => Boolean(ctx.config && ctx.config.services && ctx.config.services.spaceUrl && ctx.config.oauth && ctx.config.oauth.clientSecret && personOf(ctx.requester)),
    async run(input, ctx) {
        const space = spaceFor(ctx);
        if (!space.enabled) return { text: JSON.stringify({ error: 'OpenVibe.Space is not connected to this server' }), isError: true };
        const person = personOf(ctx.requester);
        const id = spaceIdOf(input);
        if (!id) return { text: JSON.stringify({ error: 'that is not a space id (spc_…)' }), isError: true };
        const node = typeof ctx.assign === 'function' ? await ctx.assign({ mode: 'work', reply: 'resume', agentId: ctx.agentId || null, state: 'running' }) : null;
        if (node && node.error) return { text: JSON.stringify({ error: `not started: ${node.error}` }), isError: true, data: node };
        const out = await space.call('POST', `/api/v1/builder/spaces/${id}/publish`, person, {});
        if (!out.ok) {
            if (node && typeof ctx.closeAssignment === 'function') await ctx.closeAssignment(node.id, 'failed');
            return { text: JSON.stringify({ error: out.error }), isError: true };
        }
        if (node && typeof ctx.closeAssignment === 'function') await ctx.closeAssignment(node.id, 'succeeded');
        const data = out.data || {};
        if (data.state === 'published') return { text: JSON.stringify({ space_id: id, state: 'published', url: data.url || null }), data };
        return {
            text: JSON.stringify({
                space_id: id,
                state: data.state || 'pending',
                approval_id: data.approval_id || null,
                message: 'Not published yet: the person has to approve it first. Say what the space is and where they can see it, and stop here.',
            }),
            data,
        };
    },
};

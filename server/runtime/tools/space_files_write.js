'use strict';

/**
 * Write the files of one of the person's own spaces on OpenVibe.Space (plan 2026-10-22 §Z stage Z1).
 *
 * The files in the call replace the space's files as a whole, so the agent sends every file it wants the
 * space to have. Space checks the same rules as its own editor (an index.html, safe paths, the file and byte
 * limits) and writes the space's files as the person who owns it.
 *
 * This changes the space, so it is an acting call: the loop checkpoints the intent before it runs.
 */

const { spaceFor, personOf, spaceIdOf } = require('./_space');

module.exports = {
    name: 'space_files_write',
    description: 'Write the files of one of your spaces on OpenVibe.Space. The files you send replace the space\'s files as a whole, so send every file the space should have (index.html first). Answers the files as they were written.',
    input: {
        type: 'object',
        properties: {
            space_id: { type: 'string', description: 'the space id (spc_…)' },
            files: {
                type: 'array',
                description: 'the files the space is made of',
                items: {
                    type: 'object',
                    properties: { path: { type: 'string', description: 'the file\'s path inside the space (for example index.html)' }, content: { type: 'string', description: 'the file\'s whole content' } },
                    required: ['path', 'content'],
                },
            },
        },
        required: ['space_id', 'files'],
    },
    scope: 'person',
    needs: { files: 'write', network: false },   // plan 11c: the run's files and network settings gate it
    connector: 'space',
    costUsd: 0,
    timeoutMs: 30_000,
    acts: true,
    available: (ctx) => Boolean(ctx.config && ctx.config.services && ctx.config.services.spaceUrl && ctx.config.oauth && ctx.config.oauth.clientSecret && personOf(ctx.requester)),
    async run(input, ctx) {
        const space = spaceFor(ctx);
        if (!space.enabled) return { text: JSON.stringify({ error: 'OpenVibe.Space is not connected to this server' }), isError: true };
        const person = personOf(ctx.requester);
        const id = spaceIdOf(input);
        if (!id) return { text: JSON.stringify({ error: 'that is not a space id (spc_…)' }), isError: true };
        const list = Array.isArray(input && input.files) ? input.files : [];
        if (!list.length) return { text: JSON.stringify({ error: 'send the files the space is made of' }), isError: true };
        const files = list.slice(0, 20).map((f) => ({ path: String((f && f.path) || '').slice(0, 80), content: String((f && f.content) || '').slice(0, 200000) }));
        const node = typeof ctx.assign === 'function' ? await ctx.assign({ mode: 'work', reply: 'resume', agentId: ctx.agentId || null, state: 'running' }) : null;
        if (node && node.error) return { text: JSON.stringify({ error: `not started: ${node.error}` }), isError: true, data: node };
        const out = await space.call('PUT', `/api/v1/builder/spaces/${id}/files`, person, { files });
        if (!out.ok) {
            if (node && typeof ctx.closeAssignment === 'function') await ctx.closeAssignment(node.id, 'failed');
            return { text: JSON.stringify({ error: out.error }), isError: true };
        }
        if (node && typeof ctx.closeAssignment === 'function') await ctx.closeAssignment(node.id, 'succeeded');
        const written = (out.data && out.data.files) || [];
        return { text: JSON.stringify({ space_id: id, files: written.map((f) => ({ path: f.path, bytes: String(f.content || '').length })) }), data: { files: written } };
    },
};

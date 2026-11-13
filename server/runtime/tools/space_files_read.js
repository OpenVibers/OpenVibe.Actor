'use strict';

/**
 * Read one file of one of the person's own spaces on OpenVibe.Space (plan 2026-10-22 §Z stage Z1).
 *
 * The file comes back whole. Only the person's own spaces are in reach: Space reads the person in
 * X-OV-Subject and refuses any space that is not theirs.
 */

const { spaceFor, personOf, spaceIdOf } = require('./_space');

module.exports = {
    name: 'space_files_read',
    description: 'Read one file of one of your spaces on OpenVibe.Space (its whole content). Name the space (spc_…) and the file path (for example index.html).',
    input: { type: 'object', properties: { space_id: { type: 'string', description: 'the space id (spc_…)' }, path: { type: 'string', description: 'the file\'s path inside the space' } }, required: ['space_id', 'path'] },
    scope: 'person',
    connector: 'space',
    costUsd: 0,
    timeoutMs: 20_000,
    available: (ctx) => Boolean(ctx.config && ctx.config.services && ctx.config.services.spaceUrl && ctx.config.oauth && ctx.config.oauth.clientSecret && personOf(ctx.requester)),
    async run(input, ctx) {
        const space = spaceFor(ctx);
        if (!space.enabled) return { text: JSON.stringify({ error: 'OpenVibe.Space is not connected to this server' }), isError: true };
        const person = personOf(ctx.requester);
        const id = spaceIdOf(input);
        if (!id) return { text: JSON.stringify({ error: 'that is not a space id (spc_…)' }), isError: true };
        const path = String((input && input.path) || '').trim().replace(/^\.?\//, '');
        if (!path) return { text: JSON.stringify({ error: 'name the file to read' }), isError: true };
        const out = await space.call('GET', `/api/v1/builder/spaces/${id}/files/${encodeURIComponent(path)}`, person);
        if (!out.ok) return { text: JSON.stringify({ error: out.error }), isError: true };
        const files = (out.data && out.data.files) || [];
        return { text: JSON.stringify({ space_id: id, files }), data: { files } };
    },
};

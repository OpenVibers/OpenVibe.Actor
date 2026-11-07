'use strict';

/**
 * The person's own spaces on OpenVibe.Space, and the files each one is made of (plan 2026-10-22 §Z stage Z1).
 *
 * With a space id, it lists that space's files; without one, it lists the person's spaces. Only their own
 * spaces are in reach: Space reads the person in X-OV-Subject and refuses any space that is not theirs.
 */

const { spaceFor, personOf, spaceIdOf } = require('./_space');

module.exports = {
    name: 'space_files_list',
    description: 'List the files of one of your spaces on OpenVibe.Space, or (with no space id) the spaces you own. Answers the file paths, and for a list of spaces each space\'s id, name and where it lives.',
    input: { type: 'object', properties: { space_id: { type: 'string', description: 'the space id (spc_…); leave it out to list your spaces' } } },
    scope: 'person',
    costUsd: 0,
    timeoutMs: 20_000,
    available: (ctx) => Boolean(ctx.config && ctx.config.services && ctx.config.services.spaceUrl && ctx.config.oauth && ctx.config.oauth.clientSecret && personOf(ctx.requester)),
    async run(input, ctx) {
        const space = spaceFor(ctx);
        if (!space.enabled) return { text: JSON.stringify({ error: 'OpenVibe.Space is not connected to this server' }), isError: true };
        const person = personOf(ctx.requester);
        const id = spaceIdOf(input);
        if (!id) {
            const out = await space.call('GET', '/api/v1/builder/spaces', person);
            if (!out.ok) return { text: JSON.stringify({ error: out.error }), isError: true };
            const spaces = (out.data && out.data.spaces) || [];
            return { text: JSON.stringify({ spaces }), data: { spaces } };
        }
        const out = await space.call('GET', `/api/v1/builder/spaces/${id}/preview`, person);
        if (!out.ok) return { text: JSON.stringify({ error: out.error }), isError: true };
        const files = (out.data && out.data.files) || [];
        return { text: JSON.stringify({ space_id: id, files, url: (out.data && out.data.url) || null }), data: { files } };
    },
};

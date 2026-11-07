'use strict';

/**
 * Where one of the person's own spaces can be seen right now (plan 2026-10-22 §Z stage Z1).
 *
 * While the space is a draft, its preview is the editor on openvibe.space, which shows the space as it is
 * being built; once it is published, its own address. Only the person's own spaces are in reach.
 */

const { spaceFor, personOf, spaceIdOf } = require('./_space');

module.exports = {
    name: 'space_preview',
    description: 'Show one of your spaces on OpenVibe.Space: where it can be seen now (the editor with its live preview while it is a draft, its own address once it is published), the files it is made of, and whether it is live.',
    input: { type: 'object', properties: { space_id: { type: 'string', description: 'the space id (spc_…)' } }, required: ['space_id'] },
    scope: 'person',
    costUsd: 0,
    timeoutMs: 20_000,
    available: (ctx) => Boolean(ctx.config && ctx.config.services && ctx.config.services.spaceUrl && ctx.config.oauth && ctx.config.oauth.clientSecret && personOf(ctx.requester)),
    async run(input, ctx) {
        const space = spaceFor(ctx);
        if (!space.enabled) return { text: JSON.stringify({ error: 'OpenVibe.Space is not connected to this server' }), isError: true };
        const person = personOf(ctx.requester);
        const id = spaceIdOf(input);
        if (!id) return { text: JSON.stringify({ error: 'that is not a space id (spc_…)' }), isError: true };
        const out = await space.call('GET', `/api/v1/builder/spaces/${id}/preview`, person);
        if (!out.ok) return { text: JSON.stringify({ error: out.error }), isError: true };
        const data = out.data || {};
        return { text: JSON.stringify({ space_id: id, url: data.url || null, files: data.files || [], published: Boolean(data.published) }), data };
    },
};

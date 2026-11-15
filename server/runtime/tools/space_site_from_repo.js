'use strict';

/**
 * Put one of the person's OpenVibe.Git repositories on the web as a website (plan §AD.10; the owner, 11-15: "the agent
 * can literally put any code on … use openvibe.space to host whatever it wants").
 *
 * OpenVibe.Space makes a site in the person's Spaces project, named after the repository, and from then on every push
 * to the branch sends that folder there (OpenVibe.Git does the sending; Space never fetches the code). Each push lands
 * as the site's preview: the person makes it live on the site's page, so nothing reaches the open web without them.
 *
 * This changes the world, so it is an acting call: the loop checkpoints the intent before it runs.
 */

const { spaceFor, personOf } = require('./_space');

const REPO_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

module.exports = {
    name: 'space_site_from_repo',
    description: 'Put one of your OpenVibe.Git repositories on the web as a website on OpenVibe.Space: from then on every push to the branch updates it. Give the repository (owner/name), and the folder the site\'s files are in when it is not the whole repository (for example dist or public). No build runs: the folder is served as it is. Each push arrives as a preview the person makes live on the site\'s page; tell them the address and that step.',
    input: {
        type: 'object',
        properties: {
            repo: { type: 'string', description: 'the repository on OpenVibe.Git, owner/name' },
            branch: { type: 'string', description: 'the branch to publish (default main)' },
            folder: { type: 'string', description: 'the folder of the site\'s files, like dist or public (default: the whole repository)' },
            name: { type: 'string', description: 'the site\'s name, its address <name>.openvibe.website (default: the repository\'s name)' },
        },
        required: ['repo'],
    },
    scope: 'person',
    needs: { files: 'write', network: false },
    connector: 'space',
    costUsd: 0,
    timeoutMs: 30_000,
    acts: true,
    available: (ctx) => Boolean(ctx.config && ctx.config.services && ctx.config.services.spaceUrl && ctx.config.oauth && ctx.config.oauth.clientSecret && personOf(ctx.requester)),
    async run(input, ctx) {
        const space = spaceFor(ctx);
        if (!space.enabled) return { text: JSON.stringify({ error: 'OpenVibe.Space is not connected to this server' }), isError: true };
        const person = personOf(ctx.requester);
        const repo = String((input && input.repo) || '').trim().replace(/^https?:\/\/git\.openvibe\.codes\//, '').replace(/\.git$/, '');
        if (!REPO_RE.test(repo)) return { text: JSON.stringify({ error: 'name the repository as owner/name' }), isError: true };
        const body = { repo, ...(input.branch ? { branch: String(input.branch).slice(0, 200) } : {}), ...(input.folder ? { folder: String(input.folder).slice(0, 200) } : {}), ...(input.name ? { name: String(input.name).slice(0, 60) } : {}) };
        const out = await space.call('POST', '/api/v1/builder/sites/from-repo', person, body);
        if (!out.ok) return { text: JSON.stringify({ error: out.error }), isError: true };
        const data = out.data || {};
        const site = data.site || {};
        return {
            text: JSON.stringify({
                site: site.name || null, url: site.url || null, page: site.dashboard || null,
                branch: data.publish && data.publish.branch, folder: (data.publish && data.publish.folder) || '',
                message: 'Each push to the branch now arrives at this site as a preview. The person makes it live on the site\'s page: say the address and that step, and stop here.',
            }),
            data,
        };
    },
};

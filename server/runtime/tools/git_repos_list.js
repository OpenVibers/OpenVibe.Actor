'use strict';

/** The person's own repositories on OpenVibe.Git (git.openvibe.codes), newest first (plan §AD.10 step 1). */

const { gitFor, available, repoLine } = require('./_git');
const { personOf } = require('./_openvibe');

module.exports = {
    name: 'git_repos_list',
    description: 'List your own repositories on OpenVibe.Git (git.openvibe.codes), with their addresses. Use it before making one, to reuse a repository that already exists.',
    input: { type: 'object', properties: { q: { type: 'string', description: 'words to find a repository by name (optional)' } } },
    scope: 'person',
    needs: { files: 'read', network: false },
    connector: 'git',
    costUsd: 0,
    timeoutMs: 30_000,
    available: (ctx) => available(ctx) && Boolean(personOf(ctx.requester)),
    async run(input, ctx) {
        const person = personOf(ctx.requester);
        const q = String((input && input.q) || '').slice(0, 100);
        const out = await gitFor(ctx).call('GET', `/repos?mine=1&sort=updated&limit=50${q ? `&q=${encodeURIComponent(q)}` : ''}`, person);
        if (!out.ok) return { text: JSON.stringify({ error: out.error }), isError: true };
        const items = (out.data && (out.data.repos || out.data.items || out.data.repositories)) || [];
        return { text: JSON.stringify({ repos: items.slice(0, 50).map(repoLine) }) };
    },
};

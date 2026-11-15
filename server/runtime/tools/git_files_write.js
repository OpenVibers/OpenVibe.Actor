'use strict';

/**
 * Write files to one of the person's repositories on OpenVibe.Git as one commit (plan §AD.10 step 1). Files not named
 * stay as they are; a branch that does not exist yet starts from `base` (or the default branch), so the agent can work
 * on its own branch and open a change. This changes the repository, so it is an acting call.
 */

const { gitFor, available, repoOf } = require('./_git');
const { personOf } = require('./_openvibe');

const PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[^\0]{1,300}$/;

module.exports = {
    name: 'git_files_write',
    description: 'Commit files to one of your repositories on OpenVibe.Git. Name the repository as owner/name, a branch (a new one starts from the default branch) and a message; each file is its path and its whole new content. Files you do not name stay as they are.',
    input: {
        type: 'object',
        properties: {
            repo: { type: 'string', description: 'the repository as owner/name' },
            branch: { type: 'string', description: 'the branch to commit to (default: the repository\'s default branch)' },
            base: { type: 'string', description: 'where a new branch starts (default: the default branch)' },
            message: { type: 'string', description: 'the commit message, one line saying what changed' },
            files: {
                type: 'array',
                description: 'the files to write',
                items: { type: 'object', properties: { path: { type: 'string', description: 'the file\'s path in the repository' }, content: { type: 'string', description: 'the file\'s whole new content' } }, required: ['path', 'content'] },
            },
        },
        required: ['repo', 'message', 'files'],
    },
    scope: 'person',
    needs: { files: 'write', network: false },
    connector: 'git',
    costUsd: 0,
    timeoutMs: 60_000,
    acts: true,
    available: (ctx) => available(ctx) && Boolean(personOf(ctx.requester)),
    async run(input, ctx) {
        const person = personOf(ctx.requester);
        const repo = repoOf(input);
        if (!repo) return { text: JSON.stringify({ error: 'name the repository as owner/name' }), isError: true };
        const files = Array.isArray(input.files) ? input.files.filter((f) => f && typeof f.path === 'string' && PATH.test(f.path) && typeof f.content === 'string').slice(0, 200) : [];
        if (!files.length) return { text: JSON.stringify({ error: 'send at least one file with its path and content' }), isError: true };
        const message = String(input.message || '').trim().slice(0, 500) || `Update ${files.length} file${files.length === 1 ? '' : 's'}`;
        const out = await gitFor(ctx).call('POST', `/repos/${repo}/commits`, person, {
            message, files: files.map((f) => ({ path: f.path, content: f.content })),
            ...(input.branch ? { branch: String(input.branch).slice(0, 200) } : {}), ...(input.base ? { base: String(input.base).slice(0, 200) } : {}),
        });
        if (!out.ok) return { text: JSON.stringify({ error: out.error }), isError: true };
        const d = out.data || {};
        return { text: JSON.stringify({ committed: { repo, branch: d.branch || input.branch || null, sha: d.sha || null, files: files.length, url: d.sha ? `https://git.openvibe.codes/${repo}/commit/${d.sha}` : `https://git.openvibe.codes/${repo}` } }) };
    },
};

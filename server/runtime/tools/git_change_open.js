'use strict';

/**
 * Open a change (a pull request) on one of the person's repositories on OpenVibe.Git: from a branch into another, with a
 * title and what it does (plan §AD.10 step 1). Merging stays the person's (a press on the change's page).
 */

const { gitFor, available, repoOf } = require('./_git');
const { personOf } = require('./_openvibe');

const REF = /^[A-Za-z0-9._/-]{1,200}$/;

module.exports = {
    name: 'git_change_open',
    description: 'Open a change (a pull request) on one of your repositories on OpenVibe.Git, from your working branch into the base branch, with a title and what it does. The person merges it.',
    input: {
        type: 'object',
        properties: {
            repo: { type: 'string', description: 'the repository as owner/name' },
            head: { type: 'string', description: 'the branch with the work' },
            base: { type: 'string', description: 'the branch to change (usually main)' },
            title: { type: 'string', description: 'what the change does, in one line' },
            body: { type: 'string', description: 'what changed and why, and how it was checked' },
        },
        required: ['repo', 'head', 'base', 'title'],
    },
    scope: 'person',
    needs: { files: 'write', network: false },
    connector: 'git',
    costUsd: 0,
    timeoutMs: 30_000,
    acts: true,
    available: (ctx) => available(ctx) && Boolean(personOf(ctx.requester)),
    async run(input, ctx) {
        const person = personOf(ctx.requester);
        const repo = repoOf(input);
        if (!repo) return { text: JSON.stringify({ error: 'name the repository as owner/name' }), isError: true };
        if (!REF.test(String(input.head || '')) || !REF.test(String(input.base || ''))) return { text: JSON.stringify({ error: 'name the branches (head with the work, base to change)' }), isError: true };
        const out = await gitFor(ctx).call('POST', `/repos/${repo}/changes`, person, {
            title: String(input.title || '').slice(0, 200), body: String(input.body || '').slice(0, 10000), base_ref: String(input.base), head_ref: String(input.head),
        });
        if (!out.ok) return { text: JSON.stringify({ error: out.error }), isError: true };
        const n = out.data && out.data.number;
        return { text: JSON.stringify({ opened: { repo, number: n || null, url: n ? `https://git.openvibe.codes/${repo}/changes/${n}` : `https://git.openvibe.codes/${repo}/changes` } }) };
    },
};

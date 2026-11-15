'use strict';

/**
 * Make a repository in the person's own namespace on OpenVibe.Git (plan §AD.10 step 1). Public unless asked for a private
 * one; it starts with a README, a web page or a small app. This makes something in the person's name, so it is an acting call.
 */

const { gitFor, available, repoLine } = require('./_git');
const { personOf } = require('./_openvibe');

module.exports = {
    name: 'git_repo_create',
    description: 'Make a new repository of yours on OpenVibe.Git (git.openvibe.codes). Name it in lower case with dashes. Answers its address; then write its files with git_files_write.',
    input: {
        type: 'object',
        properties: {
            name: { type: 'string', description: 'the repository name, for example my-portfolio' },
            description: { type: 'string', description: 'one line about it' },
            private: { type: 'boolean', description: 'true to keep it private (default: public)' },
            starter: { type: 'string', enum: ['empty', 'static', 'app'], description: 'what it starts with: empty (a README), static (a web page) or app (a small Node app that signs in with OpenVibe); default empty' },
        },
        required: ['name'],
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
        const git = gitFor(ctx);
        const name = String((input && input.name) || '').trim().toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 100);
        if (!name) return { text: JSON.stringify({ error: 'name the repository (letters, numbers and dashes)' }), isError: true };
        const username = await git.username(person);
        if (!username) return { text: JSON.stringify({ error: 'your OpenVibe username could not be read, so the repository has no namespace yet; try again in a moment' }), isError: true };
        const out = await git.call('POST', '/repos', person, {
            name, owner_username: username, description: String((input && input.description) || '').slice(0, 300),
            visibility: input && input.private ? 'private' : 'public', starter: ['empty', 'static', 'app'].includes(input && input.starter) ? input.starter : 'empty',
        });
        if (!out.ok) return { text: JSON.stringify({ error: out.error }), isError: true };
        return { text: JSON.stringify({ created: repoLine(out.data) }) };
    },
};

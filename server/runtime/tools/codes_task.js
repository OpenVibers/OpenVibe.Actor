'use strict';

/**
 * Coding work on the person's own machine, through OpenVibe.Codes: the old `codes` agent as a tool of the one loop.
 * The adapter is the same (agents/codes.js): it starts the task, reports each state change, waits for the end and
 * answers the summary, changed files and patch. The model use is on the person's machine and keys, so nothing is
 * metered here.
 *
 * A personal agent's run that would start coding work on its owner's machine asks first (the approval gate,
 * agents/levels.js and agents/actions.js): the registry calls requestApproval with this tool's act and category
 * before run(), so nothing reaches Codes until the person approves. Starting Codes is also one node on the
 * assignment tree.
 */

const { createCodes, repoIn } = require('../../agents/codes');
const { personOf } = require('./_openvibe');

const CACHE = new WeakMap();
function codesFor(ctx) {
    if (!CACHE.has(ctx.config)) CACHE.set(ctx.config, createCodes({ config: ctx.config, fetchImpl: ctx.fetch || globalThis.fetch }));
    return CACHE.get(ctx.config);
}

module.exports = {
    name: 'codes_task',
    description: 'Hand a coding task to OpenVibe.Codes, which runs it on the person\'s own machine (it needs them signed in and a machine connected). Name the repository as its https address and say what to change. Answers the summary, the changed files and the patch, or a link to follow the task while the machine is still working.',
    input: { type: 'object', properties: { instruction: { type: 'string', description: 'what to change, in plain words' }, repo: { type: 'string', description: 'the repository as its https address, if the instruction does not already name it' }, agent: { type: 'string', description: 'which coding agent runs it (omit it and Codes picks; "muse" runs it through Muse Code on the person\'s own Muse sign-in, with contributor mode off)' } }, required: ['instruction'] },
    scope: 'person',
    connector: 'codes',
    acts: true,
    costUsd: 0,
    timeoutMs: 600_000,
    available: (ctx) => Boolean(ctx.config && ctx.config.services && ctx.config.services.codesUrl && ctx.config.oauth && ctx.config.oauth.clientSecret && personOf(ctx.requester)),
    async run(input, ctx) {
        const codes = codesFor(ctx);
        if (!codes.enabled) return { text: JSON.stringify({ error: 'OpenVibe.Codes is not connected to this server' }), isError: true };
        const person = personOf(ctx.requester);
        if (!person) return { text: JSON.stringify({ error: 'coding tasks run on your own machine through OpenVibe.Codes, so they need you signed in' }), isError: true };
        const task = [String(input.instruction || '').slice(0, 8000), input.repo ? String(input.repo).slice(0, 500) : ''].filter(Boolean).join('\n\n');
        const repo = repoIn(task);
        // One hand-off to Codes on the tree: work, its result polled by the parent run.
        const node = typeof ctx.assign === 'function' ? await ctx.assign({ mode: 'work', reply: 'poll', agentId: ctx.agentId || null, state: 'running' }) : null;
        if (node && node.error) return { text: JSON.stringify({ error: `not started: ${node.error}` }), isError: true, data: node };
        try {
            const out = await codes.adapter({ task, requester: ctx.requester, signal: ctx.signal, emit: ctx.emit, taskId: ctx.taskId || null, ...(typeof input.agent === 'string' && input.agent ? { agent: input.agent } : {}) });
            if (node && typeof ctx.closeAssignment === 'function') await ctx.closeAssignment(node.id, 'succeeded');
            return { text: out.text, data: { sources: out.sources, model: out.model }, sources: (out.sources || []).map((url) => ({ url })) };
        } catch (err) {
            if (node && typeof ctx.closeAssignment === 'function') await ctx.closeAssignment(node.id, 'failed');
            throw err;
        }
    },
};

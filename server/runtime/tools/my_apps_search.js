'use strict';

/**
 * my_apps_search: the tools in the person's own OpenVibe apps that this agent may use for them (server/runtime/tools/
 * _connect.js; Connect's /mcp/all search). OpenVibe Finance (their accounts, a month by category with budgets,
 * transactions, recurring bills, goals and debt, net worth, what if), Design, Vision, Tools and the apps they connected
 * (GitHub, mail …), each as a typed signature for my_apps_run. Only what the person allowed Actor on their Apps page
 * runs; the rest says how to allow it.
 */

const { connectFor } = require('./_connect');
const personOf = (requester) => (typeof requester === 'string' && requester.startsWith('user:') ? requester.slice(5) : null);

module.exports = {
    name: 'my_apps_search',
    description: 'Find tools in the person\'s own OpenVibe apps that you may use for them: OpenVibe Finance (their accounts and balances, a month by category with budgets, transactions, recurring bills and subscriptions, goals and debt payoff, net worth, what-if: "can I afford this?"), Design, Vision, Tools, and apps they connected (GitHub, mail). Answers each tool as a typed signature to call from my_apps_run. Only the apps the person allowed Actor to use on their Apps page will run.',
    input: {
        type: 'object',
        properties: {
            query: { type: 'string', description: 'what you want to do, in a few words ("my spending this month", "subscriptions", "can I afford")', maxLength: 300 },
            limit: { type: 'integer', description: 'how many tools at most (12 when left out)', minimum: 1, maximum: 30 },
        },
        required: ['query'],
    },
    scope: 'person',
    connector: 'openvibe',
    costUsd: 0,
    timeoutMs: 30_000,
    async run(input, ctx) {
        const person = personOf(ctx.requester);
        if (!person) return { text: JSON.stringify({ error: 'your own apps need a signed-in person' }), isError: true };
        const query = String((input && input.query) || '').trim().slice(0, 300);
        if (!query) return { text: JSON.stringify({ error: 'say what you want to do' }), isError: true };
        const limit = Number.isInteger(input && input.limit) ? Math.min(30, Math.max(1, input.limit)) : 12;
        const out = await connectFor(ctx).call(person, 'search', { query, limit }, { signal: ctx.signal });
        if (!out.ok) return { text: JSON.stringify({ error: out.error }), isError: true };
        return { text: out.text, data: out.data };
    },
};

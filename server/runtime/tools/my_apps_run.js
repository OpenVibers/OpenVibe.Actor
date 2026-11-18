'use strict';

/**
 * my_apps_run: a short JavaScript script over the tools my_apps_search found in the person's own OpenVibe apps
 * (server/runtime/tools/_connect.js; Connect's /mcp/all execute). It runs in Connect's sandbox (no files, network or
 * processes; 30 s, 30 calls) as the person, through the grants they gave Actor: a read grant reaches only read-only
 * tools, and a send, a delete or a pay asks the person first. Only what the script returns comes back (8 KB).
 *
 * It acts: with a write grant a script may change something in an app, so the loop checkpoints before it runs.
 */

const { connectFor } = require('./_connect');
const personOf = (requester) => (typeof requester === 'string' && requester.startsWith('user:') ? requester.slice(5) : null);

module.exports = {
    name: 'my_apps_run',
    description: 'Run a short JavaScript script that calls tools my_apps_search found in the person\'s own OpenVibe apps, as them: `const m = await tools.finance_month({ month: "2026-11" }); return m.by_category;` (names as my_apps_search shows them) (several calls in one script, in a loop or in parallel). It runs in a sandbox (no files, network or processes; 30 s and 30 calls) through what the person allowed Actor on their Apps page. Return only what you need (8 KB at most); console.log lines come back too. A send, a delete or a pay asks the person first.',
    input: {
        type: 'object',
        properties: { code: { type: 'string', description: 'the body of an async function: use await on tools.<name>(input) and return what you need', maxLength: 20000 } },
        required: ['code'],
    },
    scope: 'person',
    acts: true,
    connector: 'openvibe',
    costUsd: 0,
    timeoutMs: 130_000,
    async run(input, ctx) {
        const person = personOf(ctx.requester);
        if (!person) return { text: JSON.stringify({ error: 'your own apps need a signed-in person' }), isError: true };
        const code = String((input && input.code) || '');
        if (!code.trim()) return { text: JSON.stringify({ error: 'give the script to run' }), isError: true };
        if (code.length > 20000) return { text: JSON.stringify({ error: 'the script is longer than 20,000 characters' }), isError: true };
        const out = await connectFor(ctx).call(person, 'execute', { code }, { signal: ctx.signal });
        if (!out.ok) return { text: JSON.stringify({ error: out.error }), isError: true };
        return { text: out.text, data: out.data };
    },
};

'use strict';

/**
 * Code mode (plan §AD.26; the owner, 2026-11-17, sending Cloudflare's Code Mode and Claude Code's: "Analyze and use to
 * improve openvibe"). A run with many tools offers the model two instead of all of them:
 *
 *   tools_search { query, limit? }   the run's own tools that match, each as a typed signature with its description
 *   tools_code   { code }            JavaScript that calls them: `const r = await tools.name({ … })`; only what the script
 *                                    returns (8 KB at most) and its console lines come back to the model
 *
 * so a run's tool list costs a few hundred tokens instead of every schema every turn, several calls chain in one step,
 * and a long answer is filtered in the script before any of it reaches the model's context.
 *
 * The script runs in openvibe-sdk/code-mode's sandbox (SDK 0.183.0, the same one Tools' run_code uses): its own process
 * under Node's permission model (it may read only its own file), code generation from strings off in every realm, no
 * environment, a 64 MB heap, 30 s and 30 tool calls.
 * Its only way out is `tools.<name>()`, and the loop decides each call exactly as if the model had made it (the same
 * approvals, budget, metering and evidence): runCode takes that one function, `call(name, input)`.
 *
 *   signatureOf(definition)              → "name(input: { url: string; models?: string[] }): Promise<any>"
 *   searchTools(definitions, query, n)   → [{ name, signature, description }]
 *   runCode(code, { names, call, limits }) → { ok, value, logs, calls, ms, error? }
 *   SEARCH_DEF, CODE_DEF                 the two tools as the model sees them
 */
const sdk = require('openvibe-sdk/code-mode');

const SEARCH_DEF = { type: 'function', function: {
    name: 'tools_search',
    description: 'Find the tools this run can use, by words ("audit a page", "dns", "my computers"). Answers each matching tool as a typed signature, the way tools_code calls it, with its description. Search before you write code.',
    parameters: { type: 'object', properties: { query: { type: 'string', description: 'what you want to do, in a few words' }, limit: { type: 'integer', description: 'how many tools at most (12 when left out)' } }, required: ['query'] },
} };
const CODE_DEF = { type: 'function', function: {
    name: 'tools_code',
    description: 'Run JavaScript that calls this run\'s tools and return only what you need. Each tool is an async function on `tools`, called with one object, the way tools_search shows it: `const page = await tools.openvibe_design_audit_page({ url }); return page.findings.filter((f) => f.severity === "high");`. Chain several calls, loop, filter and join in one step; console.log lines come back too. Only the returned value (8 KB at most) reaches you, so return what the answer needs, not whole pages. No network, files or require: only `tools`. 30 seconds and 30 tool calls a script. A tool that changes something asks the person first, as when you call it yourself.',
    parameters: { type: 'object', properties: { code: { type: 'string', description: 'the body of an async function: use await, and return the value you need' } }, required: ['code'] },
} };


/** A script over the run's own tools: `tools.<name>(input)` for each name, every call decided by `call(name, input)`. */
function runCode(code, { names = [], call, limits = {} } = {}) {
    return sdk.runCode(code, { tools: names, call: (kind, name, input) => call(name, input), limits });
}

module.exports = { runCode, signatureOf: sdk.signatureOf, searchTools: sdk.searchTools, typeOf: sdk.typeOf, SEARCH_DEF, CODE_DEF, LIMITS: sdk.LIMITS };

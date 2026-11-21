'use strict';
/**
 * spare_usage (plan §AD.37; the owner, 2026-11-21: "if the weekly reset's coming up and there's still usage available …
 * a task list … every ounce of your usage across all your code harnesses … configurable through … actor"): what each of
 * the person's coding agents has left before its plan resets, and the list OpenVibe.Codes works through with it.
 *
 *   show      each agent's windows (used %, when it resets) and whether the list would use it now, and the list
 *   add       put a task on the list: what to do and the repository (owner/name or https), optionally which agent,
 *             a priority 1-5 and whether it comes back after each run
 *   turn_on / turn_off   whether the list runs at all
 *
 * The list is Codes' own (/api/v1/me/spare), reached with Actor's service token for the person (codes.task.read to
 * read, codes.task.start to change: what the list holds starts tasks on their machines). Changing it is an act: a
 * personal agent asks first at its level, like codes_task.
 */
const { createCodes } = require('../../agents/codes');
const { personOf } = require('./_openvibe');

const CACHE = new WeakMap();
function codesFor(ctx) {
    if (!CACHE.has(ctx.config)) CACHE.set(ctx.config, createCodes({ config: ctx.config, fetchImpl: ctx.fetch || globalThis.fetch }));
    return CACHE.get(ctx.config);
}
const json = (o) => JSON.stringify(o);
const ACTIONS = ['show', 'add', 'turn_on', 'turn_off'];

/** The agents and the list, short enough for a model to read. */
function summary(v) {
    return {
        on: !!(v.settings && v.settings.enabled),
        when: v.settings ? `an agent whose plan resets within ${v.settings.reset_within_hours} h with at least ${v.settings.min_left_pct}% left, and is idle, takes the next task` : null,
        agents: (v.agents || []).map((a) => ({
            agent: a.agent, name: a.name,
            windows: (a.windows || []).map((w) => ({ name: w.name, left_pct: w.used_pct == null ? null : 100 - w.used_pct, resets_at: w.resets_at })),
            takes_next: !!a.take, why: a.why || null,
        })),
        list: (v.tasks || []).map((t) => ({ id: t.id, title: t.title, state: t.state, agent: t.agent, priority: t.priority, repeat: t.repeat, runs: t.runs })),
        page: 'https://openvibe.codes/settings/spare',
    };
}

module.exports = {
    name: 'spare_usage',
    description: 'What the person\'s coding agents (Claude Code, Codex, Command Code …) have left before their plans reset, and their spare-usage list on OpenVibe Codes: a list of coding tasks their agents work through when a plan is about to reset with usage left and the agent is idle, so nothing they paid for is lost. action "show" reads it; "add" puts a task on the list (prompt and repo required; agent, priority 1-5 and repeat optional); "turn_on"/"turn_off" switch the list.',
    input: {
        type: 'object',
        properties: {
            action: { type: 'string', enum: ACTIONS, description: 'show (default), add, turn_on or turn_off' },
            prompt: { type: 'string', description: 'for add: what to do, in plain words' },
            repo: { type: 'string', description: 'for add: the repository, owner/name or its https address' },
            title: { type: 'string', description: 'for add: a short name (optional)' },
            agent: { type: 'string', description: 'for add: which coding agent (optional; any with time left by default)' },
            priority: { type: 'integer', minimum: 1, maximum: 5, description: 'for add: 1 runs first, 5 last (default 3)' },
            repeat: { type: 'boolean', description: 'for add: back on the list after each run (chores worth repeating)' },
        },
    },
    scope: 'person',
    needs: { files: 'none', network: false },
    connector: 'codes',
    acts: true,
    costUsd: 0,
    timeoutMs: 30_000,
    available: (ctx) => Boolean(ctx.config && ctx.config.services && ctx.config.services.codesUrl && ctx.config.oauth && ctx.config.oauth.clientSecret && personOf(ctx.requester)),
    async run(input, ctx) {
        const codes = codesFor(ctx);
        if (!codes.enabled || typeof codes.call !== 'function') return { text: json({ error: 'OpenVibe.Codes is not connected to this server' }), isError: true };
        const person = personOf(ctx.requester);
        if (!person) return { text: json({ error: 'spare usage is your own coding agents\' plans: it needs you signed in' }), isError: true };
        const action = ACTIONS.includes(input && input.action) ? input.action : 'show';
        const fail = (r) => ({ text: json({ error: (r.data && (r.data.detail || r.data.title)) || `OpenVibe.Codes answered ${r.status}` }), isError: true });
        if (action === 'turn_on' || action === 'turn_off') {
            const r = await codes.call('PUT', '/me/spare', person, { body: { enabled: action === 'turn_on' }, signal: ctx.signal });
            if (!r.ok) return fail(r);
        } else if (action === 'add') {
            const prompt = String((input && input.prompt) || '').trim();
            const repo = String((input && input.repo) || '').trim();
            if (!prompt || !repo) return { text: json({ error: 'add needs prompt (what to do) and repo (owner/name or https)' }), isError: true };
            const body = { prompt: prompt.slice(0, 8000), repo: repo.slice(0, 300) };
            for (const k of ['title', 'agent']) if (typeof input[k] === 'string' && input[k].trim()) body[k] = input[k].trim().slice(0, k === 'title' ? 120 : 40);
            if (Number.isInteger(input.priority)) body.priority = input.priority;
            if (typeof input.repeat === 'boolean') body.repeat = input.repeat;
            const r = await codes.call('POST', '/me/spare/tasks', person, { body, signal: ctx.signal });
            if (!r.ok) return fail(r);
        }
        const v = await codes.call('GET', '/me/spare', person, { signal: ctx.signal });
        if (!v.ok) return fail(v);
        const out = summary(v.data || {});
        return { text: json({ done: action, ...out }), data: out, sources: [{ url: out.page }] };
    },
};

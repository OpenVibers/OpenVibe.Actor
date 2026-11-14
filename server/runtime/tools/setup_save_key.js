'use strict';

const { serviceFor, json, personOf } = require('./_openvibe');
const { prepareDesk } = require('./_person');
const grants = require('../../setup/grants');

const machine = { type: 'string', description: 'the machine id (dev_…) whose browser shows the provider page, as in computer_browser' };

/**
 * Setup done by your agent (plan §AB.44): save the new key the provider's page shows into the one Setup row the person
 * granted this task. The tool reads the page itself, finds the key by the provider's key shape and saves it through
 * Network with the task's grant; the model never sees, copies or types it, and the answer is "saved" with the key's last
 * four characters. Only a task started with a live grant (POST /api/v1/setup/tasks) has it.
 */
module.exports = {
    name: 'setup_save_key',
    description: 'Your person asked you to set up a provider key for OpenVibe. As soon as the provider\'s page shows the new key, call this: it reads the page itself and saves the key where your person asked. Never read the page, take a screenshot, copy or type the key yourself. Answers only saved (with the key\'s last four characters) or why not.',
    input: { type: 'object', additionalProperties: false, required: ['machine'], properties: {
        machine, desk: { type: 'string', enum: ['private'], description: 'the desk the browser is on, as in computer_browser' },
    } },
    scope: 'person',
    needs: { files: 'write', network: true },
    connector: 'computers',
    acts: true,
    costUsd: 0,
    timeoutMs: 60_000,
    available: (ctx) => Boolean(ctx && ctx.taskId && grants.grantFor(ctx.taskId) && personOf(ctx.requester)),
    async run(input, ctx) {
        const g = grants.grantFor(ctx.taskId);
        if (!g) return { text: json({ ok: false, reason: 'no live setup grant for this task' }), isError: true };
        const person = personOf(ctx.requester);
        const core = serviceFor(ctx);
        if (!person || !core.pcs.enabled) return { text: json({ ok: false, reason: 'computers are only for a signed-in person\'s task' }), isError: true };
        const a = await prepareDesk('computer_browser', { action: 'read', machine: input && input.machine, ...(input && input.desk ? { desk: input.desk } : {}) }, person, core, ctx);
        if (a.error) return { text: json({ ok: false, reason: a.error }), isError: true };
        // The page's text stays here: it is matched, never returned.
        const page = await core.pcs.browser(person, a.machine, a, { signal: ctx.signal });
        const text = page && typeof page === 'object' ? [page.text, page.content, page.value].filter((x) => typeof x === 'string').join('\n') : '';
        const found = grants.findKey(text, g.provider);
        if (!found.key) {
            const why = { no_key_on_page: 'the page does not show a new key yet: create it first, then call this again',
                several_keys_on_page: 'the page shows more than one key: open the one you just made, then call this again',
                unknown_provider: 'this provider\'s keys cannot be read from its page: hand the desk to your person to paste it in Setup' }[found.reason] || found.reason;
            return { text: json({ ok: false, reason: why }), data: { ok: false, reason: found.reason } };
        }
        const saver = (ctx.setupSaver) || grants.createSaver({ config: ctx.config });
        const out = await saver.save(g.grantId, { [g.keys[0]]: found.key }, ctx.taskId);
        if (!out.ok) return { text: json({ ok: false, reason: `the save did not go through (${out.reason})` }), data: { ok: false, reason: out.reason }, isError: true };
        grants.forget(ctx.taskId);
        const hint = (out.keys[0] && out.keys[0].hint) || grants.hintOf(found.key);
        return { text: json({ ok: true, saved: `${g.label} key`, ends_in: hint }), data: { ok: true, ends_in: hint } };
    },
};

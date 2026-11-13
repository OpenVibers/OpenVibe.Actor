'use strict';

const { serviceFor, json, personOf } = require('./_openvibe');

module.exports = {
    name: 'locker_fill_login',
    description: 'Ask the person to approve one saved sign-in for the current private Run browser session. The person chooses the login and what to type in Companion. You receive only ok or a short reason, never credentials or codes.',
    input: { type: 'object', properties: { origin: { type: 'string', description: 'the exact HTTPS origin shown in the browser address bar, including port; no path' } }, required: ['origin'] },
    scope: 'person',
    needs: { files: 'write', network: false },   // plan 11c: the run's files and network settings gate it
    connector: 'logins',
    // Creating a request does not fill anything; Run pauses control and the person approves in Companion.
    acts: false,
    costUsd: 0,
    timeoutMs: 130_000,
    available: (ctx) => Boolean(ctx.config && ctx.config.services && ctx.config.services.runUrl && ctx.config.oauth && ctx.config.oauth.clientSecret && personOf(ctx.requester)),
    async run(input, ctx) {
        const person = personOf(ctx.requester);
        const machine = ctx.state && ctx.state.desks && ctx.state.desks.placed;
        const core = serviceFor(ctx);
        if (!person || !core.pcs.enabled || !core.pcs.fillLogin) return { text: json({ ok: false, reason: 'sessions_unavailable' }), isError: true };
        const result = await core.pcs.fillLogin(person, machine, input.origin, { signal: ctx.signal });
        return { text: json({ ok: result.ok === true, reason: result.reason || null }), data: { ok: result.ok === true, reason: result.reason || null } };
    },
};

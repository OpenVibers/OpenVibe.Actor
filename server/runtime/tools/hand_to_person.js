'use strict';

const { serviceFor, json, personOf } = require('./_openvibe');
const { handToPerson } = require('./_person');

const machine = { type: 'string', description: 'the machine id (dev_…) from list_my_computers' };

module.exports = {
    name: 'hand_to_person',
    description: 'Ask the person to do one step themselves on your own desk: a sign-in, a CAPTCHA, a code sent to their phone, a payment, or anything you must not or cannot do yourself. Get the page to that step first (your desk started with computer_desk). They get a link to watch the desk and take it over; this waits until they have used it and stopped (a few minutes at most), then tells you to look again before you go on. Never ask for a password, code or card number in your answer instead.',
    input: { type: 'object', properties: { machine, what: { type: 'string', description: 'the step, in one plain sentence, for example "Sign in to your Google account in the browser."' } }, required: ['machine', 'what'] },
    scope: 'person',
    costUsd: 0,
    timeoutMs: 700_000,
    available: (ctx) => Boolean(ctx.config && ctx.config.services && ctx.config.services.botUrl && personOf(ctx.requester)),
    async run(input, ctx) {
        const core = serviceFor(ctx);
        const person = personOf(ctx.requester);
        if (!core.pcs.enabled || !person) return { text: json({ error: 'computers are only for a signed-in person\'s task' }), isError: true };
        // A desk on a desk host (an OpenVibe.Run session) is not the person's to take over yet.
        const desks = ctx.state && ctx.state.desks;
        const target = input.machine === 'any' && desks ? desks.placed : input.machine;
        if (core.pcs.isSession && core.pcs.isSession(target)) return { text: json({ done: false, note: 'Your desk is on a desk host, which the person cannot take over from here: tell them in your answer what is left for them to do, and where.' }), data: null };
        const data = await handToPerson(person, input, ctx, core);
        return { text: json(data), data };
    },
};

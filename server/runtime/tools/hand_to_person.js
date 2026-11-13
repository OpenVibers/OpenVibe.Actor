'use strict';

const { serviceFor, json, personOf } = require('./_openvibe');
const { handToPerson, PERSON_WAIT_MS, PERSON_POLL_MS } = require('./_person');
const driving = require('../../agents/driving');

const machine = { type: 'string', description: 'the machine id (dev_…) from list_my_computers' };

module.exports = {
    name: 'hand_to_person',
    description: 'Ask the person to do one step themselves on your own desk: a sign-in, a CAPTCHA, a code sent to their phone, a payment, or anything you must not or cannot do yourself. Get the page to that step first (your desk started with computer_desk). They get a link to watch the desk and take it over; this waits until they have used it and stopped (a few minutes at most), then tells you to look again before you go on. Never ask for a password, code or card number in your answer instead.',
    input: { type: 'object', properties: { machine, what: { type: 'string', description: 'the step, in one plain sentence, for example "Sign in to your Google account in the browser."' } }, required: ['machine', 'what'] },
    scope: 'person',
    needs: { files: 'none', network: false },   // plan 11c: the run's files and network settings gate it
    acts: true,
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
        if (ctx.day && core.pcs.isSession && core.pcs.isSession(target)) {
            return ctx.day.ask(ctx.taskId, { kind: 'sign_in', text: input.what, options: ['Sign in on its screen', 'Done'], session_id: target.slice(4) });
        }
        if (core.pcs.isSession && core.pcs.isSession(target)) {
            // A Run desk's Ask: the viewer takes the session's lease and says so in Actor's driving marker. Wait for the
            // person to take over and hand back, then let the agent look again. No note is passed in a tool result.
            const what = String(input.what || '').replace(/\s+/g, ' ').trim().slice(0, 300);
            if (ctx.emit) await ctx.emit({ step: 'text', text: `Needs you: ${what}` });
            const end = Date.now() + PERSON_WAIT_MS;
            let took = false;
            const pause = (ms) => new Promise((resolve) => { const timer = setTimeout(resolve, ms); if (ctx.signal) ctx.signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true }); });
            while (Date.now() < end && !(ctx.signal && ctx.signal.aborted)) {
                if (driving.is(ctx.taskId)) took = true;
                else if (took) return { text: json({ done: true, note: 'The person used the desk and handed it back. Look at it again before you go on.', session_id: target.slice(4) }), data: { done: true } };
                await pause(PERSON_POLL_MS);
            }
            return { text: json({ done: false, note: took ? 'The person was still using the desk when the wait ended: tell them what is left.' : 'The person did not take the desk in time: tell them in your answer what is left for them to do.' }), data: { done: false } };
        }
        const data = await handToPerson(person, input, ctx, core);
        return { text: json(data), data };
    },
};

'use strict';

const { serviceFor, json, personOf } = require('./_openvibe');
const { prepareDesk, lookAtScreen } = require('./_person');

const machine = { type: 'string', description: 'the machine id (dev_…) from list_my_computers' };

module.exports = {
    name: 'computer_screen',
    description: 'Look at the screen of one of the person\'s computers right now and get an answer to a question about it (what is open, the exact text of an error or dialog, whether something finished). A vision model reads the screenshot; you get its answer, not the picture. It costs a few cents a look: ask a precise question, and look again only after something changed.',
    input: { type: 'object', properties: { machine, question: { type: 'string', description: 'what to find out from the screen' }, desk: { type: 'string', enum: ['main', 'private'], description: 'private: the machine\'s private desk, where you work without touching the person\'s screen (start it with computer_desk first); main (the default): the person\'s own screen' } }, required: ['machine', 'question'] },
    scope: 'person',
    costUsd: 0.01,
    timeoutMs: 90_000,
    available: (ctx) => Boolean(ctx.config && ctx.config.services && ctx.config.services.botUrl && personOf(ctx.requester) && ctx.models),
    async run(input, ctx) {
        const core = serviceFor(ctx);
        const person = personOf(ctx.requester);
        if (!core.pcs.enabled || !person) return { text: json({ error: 'computers are only for a signed-in person\'s task' }), isError: true };
        const a = await prepareDesk('computer_screen', input, person, core, ctx);
        if (a.error) return { text: json(a), isError: true };
        const data = await lookAtScreen(person, a, ctx, core);
        return { text: json(data), data };
    },
};

'use strict';

const { serviceFor, json, personOf } = require('./_openvibe');
const { prepareDesk, lookAtScreen } = require('./_person');

const machine = { type: 'string', description: 'the machine id (dev_…) from list_my_computers' };

module.exports = {
    name: 'computer_screen',
    description: 'Look at the screen of one of the person\'s computers right now and get an answer to a question about it (what is open, the exact text of an error or dialog, whether something finished). A vision model reads the screenshot; you get its answer, not the picture. It costs a few cents a look: ask a precise question, and look again only after something changed.',
    input: { type: 'object', properties: { machine, question: { type: 'string', description: 'what to find out from the screen' }, desk: { type: 'string', enum: ['main', 'private'], description: 'private: the machine\'s private desk, where you work without touching the person\'s screen (start it with computer_desk first); main (the default): the person\'s own screen' } }, required: ['machine', 'question'] },
    scope: 'person',
    needs: { files: 'read', network: false },   // plan 11c: the run's files and network settings gate it
    connector: 'computers',
    costUsd: 0.01,
    timeoutMs: 90_000,
    available: (ctx) => Boolean(ctx.config && ctx.config.services && ctx.config.services.botUrl && personOf(ctx.requester) && ctx.models),
    async run(input, ctx) {
        const core = serviceFor(ctx);
        const person = personOf(ctx.requester);
        if (!core.pcs.enabled || !person) return { text: json({ error: 'computers are only for a signed-in person\'s task' }), isError: true };
        const a = await prepareDesk('computer_screen', input, person, core, ctx);
        if (a.error) return { text: json(a), isError: true };
        // A task setting up a provider key (plan §AB.44): no look at the screen while it shows the new key (the picture
        // would go to a vision model, and its answer could repeat the key); setup_save_key reads and saves it.
        const setup = require('../../setup/grants');
        const g = setup.grantFor(ctx.taskId);
        if (g) {
            let page = null;
            try { page = await core.pcs.browser(person, a.machine, { action: 'read', ...(a.desk ? { desk: a.desk } : {}) }, { signal: ctx.signal }); } catch { page = null; }
            const text = page && typeof page === 'object' ? [page.text, page.content, page.value].filter((x) => typeof x === 'string').join('\n') : '';
            const seen = setup.findKey(text, g.provider);
            if (seen.key || seen.reason === 'several_keys_on_page') {
                return { text: json({ error: 'The new key is on the screen: call setup_save_key now. No screenshot while it shows.' }), isError: true };
            }
        }
        const data = await lookAtScreen(person, a, ctx, core);
        return { text: json(data), data };
    },
};

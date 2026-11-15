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
        // A task setting up a provider key (plan §AB.44): no picture of the screen that could show a key (it would go to a
        // vision model, and its answer could repeat the key). Enforced, and failing closed, for the task's whole life (the
        // guard outlives the grant): the page must be read first and show nothing shaped like any provider's key, and a
        // provider whose keys we cannot recognise gets no screenshots at all. setup_save_key reads and saves the key.
        const setup = require('../../setup/grants');
        const guard = setup.guardFor(ctx.taskId);
        if (guard) {
            const no = (why) => ({ text: json({ error: why }), isError: true });
            if (!setup.KEY_SHAPES[guard.provider]) return no('This task sets up a key whose shape cannot be recognised, so no screenshots: read the page with computer_browser instead.');
            // The person's own screen can show a key in any window, not only the page checked below (the 11-15 review):
            // a key setup looks only at the agent's private desk.
            if (!input || input.desk !== 'private') return no('While this task sets up a key, screenshots are of your private desk only (desk: "private"): the person\'s own screen can show keys in other windows. Read the page with computer_browser instead.');
            let page = null;
            try { page = await core.pcs.browser(person, a.machine, { action: 'read', ...(a.desk ? { desk: a.desk } : {}) }, { signal: ctx.signal }); } catch { page = null; }
            // An empty or error-shaped read proves nothing, so it lets no screenshot by (the 11-15 review).
            if (!setup.readablePage(page)) return no('The page could not be read to check it for a key, so no screenshot: read it with computer_browser instead.');
            if (setup.showsKey(setup.stringsOf(page).join('\n'))) {
                return no(setup.grantFor(ctx.taskId) ? 'The new key is on the screen: call setup_save_key now. No screenshot while it shows.'
                    : 'A key is on the screen. No screenshot while it shows: close or leave that page first.');
            }
        }
        const data = await lookAtScreen(person, a, ctx, core);
        return { text: json(data), data };
    },
};

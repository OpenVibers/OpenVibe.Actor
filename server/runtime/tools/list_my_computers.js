'use strict';

const { serviceFor, json, personOf } = require('./_openvibe');

module.exports = {
    name: 'list_my_computers',
    description: 'List the person\'s own computers open to their agent on OpenVibe.Bot: online or not, the level the person set on the machine (observe: read only; ask: each run or write waits for their approval on the machine; trusted; full), what it offers (terminal, files, screen) and its folders.',
    input: { type: 'object', properties: {} },
    scope: 'person',
    costUsd: 0,
    timeoutMs: 20_000,
    available: (ctx) => Boolean(ctx.config && ctx.config.services && ctx.config.services.botUrl && personOf(ctx.requester)),
    async run(_input, ctx) {
        const core = serviceFor(ctx);
        const person = personOf(ctx.requester);
        if (!core.pcs.enabled || !person) return { text: json({ error: 'computers are only for a signed-in person\'s task' }), isError: true };
        const data = await core.pcs.mine(person, { signal: ctx.signal });
        return { text: json(data), data };
    },
};

'use strict';

const { serviceFor, json, personOf } = require('./_openvibe');

const machine = { type: 'string', description: 'the machine id (dev_…) from list_my_computers' };

module.exports = {
    name: 'computer_list',
    description: 'List a folder on one of the person\'s computers (an absolute path inside its folders).',
    input: { type: 'object', properties: { machine, path: { type: 'string' } }, required: ['machine', 'path'] },
    scope: 'person',
    costUsd: 0,
    timeoutMs: 20_000,
    available: (ctx) => Boolean(ctx.config && ctx.config.services && ctx.config.services.botUrl && personOf(ctx.requester)),
    async run(input, ctx) {
        const core = serviceFor(ctx);
        const person = personOf(ctx.requester);
        if (!core.pcs.enabled || !person) return { text: json({ error: 'computers are only for a signed-in person\'s task' }), isError: true };
        const data = await core.pcs.list(person, input.machine, input.path, { signal: ctx.signal });
        return { text: json(data), data };
    },
};

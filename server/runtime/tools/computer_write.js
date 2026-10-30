'use strict';

const { serviceFor, json, personOf } = require('./_openvibe');

const machine = { type: 'string', description: 'the machine id (dev_…) from list_my_computers' };

module.exports = {
    name: 'computer_write',
    description: 'Write a text file on one of the person\'s computers (mode create, overwrite or append). At level "ask" it waits for the person to approve it on the machine.',
    input: { type: 'object', properties: { machine, path: { type: 'string' }, text: { type: 'string' }, mode: { type: 'string', enum: ['create', 'overwrite', 'append'] } }, required: ['machine', 'path', 'text'] },
    scope: 'person',
    acts: true,
    costUsd: 0,
    timeoutMs: 30_000,
    available: (ctx) => Boolean(ctx.config && ctx.config.services && ctx.config.services.botUrl && personOf(ctx.requester)),
    async run(input, ctx) {
        const core = serviceFor(ctx);
        const person = personOf(ctx.requester);
        if (!core.pcs.enabled || !person) return { text: json({ error: 'computers are only for a signed-in person\'s task' }), isError: true };
        const data = await core.pcs.write(person, input.machine, input.path, input.text, { mode: input.mode || 'create', signal: ctx.signal });
        return { text: json(data), data };
    },
};

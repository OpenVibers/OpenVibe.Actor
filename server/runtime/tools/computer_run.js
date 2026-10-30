'use strict';

const { serviceFor, json, personOf } = require('./_openvibe');
const { prepareDesk } = require('./_person');

const machine = { type: 'string', description: 'the machine id (dev_…) from list_my_computers' };

module.exports = {
    name: 'computer_run',
    description: 'Run a program on one of the person\'s computers: argv is the program and its arguments, for example ["git", "status"] (never a shell line). Answers its exit code and output. With desk "private" (where list_my_computers shows apps_on_desk) it runs on your own desk, so a program\'s windows open there; add detach true to open an app that keeps running there (an office suite, a terminal, an editor: it answers at once and runs until your desk stops), then look with computer_screen and use it with computer_input. Your desk must be a whole desk for windows (computer_desk start with kind "desktop"). At level "ask" it waits for the person to approve it on the machine.',
    input: { type: 'object', properties: { machine, argv: { type: 'array', items: { type: 'string' } }, cwd: { type: 'string' }, timeout_s: { type: 'integer' }, desk: { type: 'string', enum: ['main', 'private'], description: 'private: your own desk (start it with computer_desk first); main (the default): the person\'s own session' }, detach: { type: 'boolean', description: 'on your own desk only: start an app that keeps running there and answer at once' } }, required: ['machine', 'argv'] },
    scope: 'person',
    acts: true,
    costUsd: 0,
    timeoutMs: 90_000,
    available: (ctx) => Boolean(ctx.config && ctx.config.services && ctx.config.services.botUrl && personOf(ctx.requester)),
    async run(input, ctx) {
        const core = serviceFor(ctx);
        const person = personOf(ctx.requester);
        if (!core.pcs.enabled || !person) return { text: json({ error: 'computers are only for a signed-in person\'s task' }), isError: true };
        const a = await prepareDesk('computer_run', input, person, core, ctx);
        if (a.error) return { text: json(a), isError: true };
        const data = await core.pcs.run(person, a.machine, a.argv, { cwd: a.cwd, timeoutS: a.timeout_s, desk: a.desk, detach: a.detach === true, signal: ctx.signal });
        return { text: json(data), data };
    },
};

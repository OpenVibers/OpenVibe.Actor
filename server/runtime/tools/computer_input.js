'use strict';

const { serviceFor, json, personOf } = require('./_openvibe');
const { prepareDesk } = require('./_person');

const machine = { type: 'string', description: 'the machine id (dev_…) from list_my_computers' };

module.exports = {
    name: 'computer_input',
    description: 'Use the mouse or keyboard on one of the person\'s computers: click, double_click, right_click or move at x, y (pixels in the last computer_screen picture: pass its width and height), scroll by dy clicks (negative is up), type text into what has focus, or press one key or chord (keys: Return, Escape, Tab, ctrl+s, alt+Tab). At level "ask" each one waits for the person to approve it on the machine. Prefer programs and files when they can do it; look with computer_screen first, act in small steps, and look again to check.',
    input: { type: 'object', properties: { machine, action: { type: 'string', enum: ['click', 'double_click', 'right_click', 'move', 'scroll', 'type', 'key'] }, x: { type: 'integer' }, y: { type: 'integer' }, width: { type: 'integer', description: 'the screen picture\'s width' }, height: { type: 'integer', description: 'the screen picture\'s height' }, dy: { type: 'integer' }, text: { type: 'string' }, keys: { type: 'string' }, desk: { type: 'string', enum: ['main', 'private'], description: 'private: the machine\'s private desk, where you work without touching the person\'s screen (start it with computer_desk first); main (the default): the person\'s own screen' } }, required: ['machine', 'action'] },
    scope: 'person',
    costUsd: 0,
    timeoutMs: 40_000,
    available: (ctx) => Boolean(ctx.config && ctx.config.services && ctx.config.services.botUrl && personOf(ctx.requester)),
    async run(input, ctx) {
        const core = serviceFor(ctx);
        const person = personOf(ctx.requester);
        if (!core.pcs.enabled || !person) return { text: json({ error: 'computers are only for a signed-in person\'s task' }), isError: true };
        const a = await prepareDesk('computer_input', input, person, core, ctx);
        if (a.error) return { text: json(a), isError: true };
        const data = await core.pcs.input(person, a.machine, a, { signal: ctx.signal });
        return { text: json(data), data };
    },
};

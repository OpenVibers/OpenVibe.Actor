'use strict';

const { serviceFor, json, personOf } = require('./_openvibe');

module.exports = {
    name: 'robot_steps',
    description: 'Make one of the person\'s robots act, by step lines it accepts (from list_my_robots), for example ["forward 1", "left 0.5", "say Hello", "headlights #00ff00", "wait 1", "stop"]. At most 20 steps and 30 seconds per call. Answers "done" or "stopped: <why>" once they end.',
    input: { type: 'object', properties: { robot: { type: 'string', description: 'the robot id (rob_…)' }, steps: { type: 'array', items: { type: 'string' } } }, required: ['robot', 'steps'] },
    scope: 'person',
    costUsd: 0,
    timeoutMs: 40_000,
    available: (ctx) => Boolean(ctx.config && ctx.config.services && ctx.config.services.botUrl && personOf(ctx.requester)),
    async run(input, ctx) {
        const core = serviceFor(ctx);
        const person = personOf(ctx.requester);
        if (!core.bot.enabled || !person) return { text: json({ error: 'robots are only for a signed-in person\'s task' }), isError: true };
        const data = await core.bot.steps(person, input.robot, input.steps, { signal: ctx.signal });
        return { text: json(data), data };
    },
};

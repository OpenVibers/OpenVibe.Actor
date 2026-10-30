'use strict';

const { serviceFor, json, personOf } = require('./_openvibe');

module.exports = {
    name: 'list_my_robots',
    description: 'List the robots the person owns on OpenVibe.Bot. For each robot they opened to their agent: whether it is online, the e-stop, battery, sensor readings and the step lines it accepts. A robot not opened to the agent says how the person can open it.',
    input: { type: 'object', properties: {} },
    scope: 'person',
    costUsd: 0,
    timeoutMs: 20_000,
    available: (ctx) => Boolean(ctx.config && ctx.config.services && ctx.config.services.botUrl && personOf(ctx.requester)),
    async run(_input, ctx) {
        const core = serviceFor(ctx);
        const person = personOf(ctx.requester);
        if (!core.bot.enabled || !person) return { text: json({ error: 'robots are only for a signed-in person\'s task' }), isError: true };
        const data = await core.bot.mine(person, { signal: ctx.signal });
        return { text: json(data), data };
    },
};

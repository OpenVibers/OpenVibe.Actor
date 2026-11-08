'use strict';

const { clean } = require('./_device');

module.exports = {
    name: 'notify_phone',
    description: 'Tell your person something on their phone. Give a short title and text. It appears in their Action Center; Link raises a local notification while Stay connected is on. This is a device.notify action, scoped to this agent.',
    input: { type: 'object', properties: { title: { type: 'string', maxLength: 120 }, text: { type: 'string', maxLength: 400 } }, required: ['title', 'text'] },
    scope: 'person', acts: true, costUsd: 0, timeoutMs: 15_000,
    available: (ctx) => Boolean(ctx && ctx.store && ctx.agentId && ctx.requester && !ctx.chatPolicy),
    async run(input, ctx) {
        const title = clean(input.title, 120);
        const body = clean(input.text, 400);
        if (!title || !body) return { text: 'A notification needs a title and text.', isError: true };
        const id = ctx.store.newId('ntf');
        await ctx.store.db.query(`INSERT INTO actor_device_notices (id, owner, agent_id, task_id, title, body, created_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7)`, [id, ctx.requester, ctx.agentId, ctx.taskId, title, body, ctx.store.iso()]);
        return { text: `Added one notification to your person's Action Center: ${title}`, data: { notice_id: id } };
    },
};

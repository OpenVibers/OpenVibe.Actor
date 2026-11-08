'use strict';

const approvals = require('../../agents/approvals');

const ready = (ctx) => Boolean(ctx && ctx.store && ctx.waits && ctx.agentId &&
    typeof ctx.requester === 'string' && ctx.requester.startsWith('user:') && !ctx.chatPolicy);
const clean = (value, n) => String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, n);

/** A device request always asks, even at full access. The run parks until the person answers or time runs out. */
async function ask(ctx, kind, input) {
    if (!ready(ctx)) return { text: 'A device request needs your own agent and a signed-in person.', isError: true };
    const why = clean(input.why, 300);
    if (!why) return { text: 'Say why you need this, in one sentence.', isError: true };
    if (input.device != null) {
        const device = String(input.device);
        if (!/^dev_[0-9A-HJKMNP-TV-Z]{26}$/.test(device)) return { text: 'Choose a paired phone id (dev_…).', isError: true };
        const fresh = new Date(Date.now() - 60_000).toISOString();
        const online = await ctx.store.db.maybe('SELECT device_id FROM actor_device_presence WHERE owner = $1 AND device_id = $2 AND seen_at >= $3',
            [ctx.requester, device, fresh]);
        if (!online) return { text: 'That phone is offline. No camera or location request was sent to it.', isError: true };
    }
    const summary = kind === 'device.camera' ? 'Take one photo for your agent' : 'Share your location once with your agent';
    const row = await approvals.request(ctx.store, { owner: ctx.requester, agentId: ctx.agentId,
        taskId: ctx.taskId, kind, summary, payload: { why, ...(input.device ? { device: input.device } : {}),
            ...(kind === 'device.location' ? { precise: input.precise === true } : {}) } });
    let wait;
    try {
        wait = await ctx.waits.create({ taskId: ctx.taskId, requester: ctx.requester, source: 'time', seconds: 6 * 3600,
            onTimeout: 'fail', line: `waiting for your ${kind === 'device.camera' ? 'one photo' : 'one location'}: ${why}`,
            traceId: ctx.trace && ctx.trace.newId ? ctx.trace.newId() : null, step: ctx.step == null ? null : ctx.step });
        await ctx.store.db.query('UPDATE actor_approvals SET device_wait_id = $2, expires_at = $3 WHERE id = $1',
            [row.id, wait.id, wait.deadline_at]);
    } catch (err) {
        await ctx.store.db.query("UPDATE actor_approvals SET state = 'expired', decided_at = $2 WHERE id = $1 AND state = 'pending'", [row.id, ctx.store.iso()]);
        return { text: `The request could not wait for an answer: ${String((err && err.message) || err).slice(0, 180)}`, isError: true };
    }
    const url = `${ctx.config.baseUrl}/me/approvals/${row.id}`;
    if (ctx.emit) await ctx.emit({ step: 'text', text: `Needs you: ${summary}. ${why} Answer it here: ${url}` });
    if (ctx.notifyTask) ctx.notifyTask('needs_you', { what: `${summary}. ${why}`, url }).catch(() => {});
    return { text: JSON.stringify({ waiting: true, approval_id: row.id, url }),
        data: { approval_id: row.id, url }, park: { wait_id: wait.id } };
}

module.exports = { ask, ready, clean };

'use strict';

/**
 * Creating a task — the one path the API (POST /api/v1/tasks) and the site's form both take. Money limits come before
 * any work: the person's tier (a budget above it is refused, never lowered), their tasks and spend today, and the
 * operator's daily ceiling over everyone. Returns { status, task } (201 created, 200 an idempotent repeat) or
 * { status, code, detail, retryAfter? } for a problem.
 */
const crypto = require('crypto');
const contracts = require('openvibe-contracts');
const store = require('./store');
const catalog = require('../agents/catalog');
const { checkWebhookUrl } = require('../net/webhook-post');
const { mintSecret } = require('./webhooks');
const learn = require('../runtime/brain/learn');

/**
 * The sharing system (design 2026-11-06), injected once by server/app.js. A run is its owner's until the Share sheet
 * says otherwise; a run no person owns is never registered, and a sharing system that is unavailable leaves the run
 * unreadable to others (every read asks canView, and a missing row answers no).
 */
let sharing = null;
function setSharing(store) { sharing = store || null; }

const usd = (n) => (n === 0 ? '$0' : n < 0.01 ? `$${Number(n).toFixed(4)}` : `$${Number(n).toFixed(2)}`);

function untilMidnight(nowMs) {
    const n = new Date(nowMs);
    return Math.ceil((Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate() + 1) - n.getTime()) / 1000);
}

async function createTask({ s, config, engine, principal, body, webhooks: webhookQueue = null, beforeInsert = null, chatContext = null, afterInsert = null, parentId = null, forkOfStep = null, forkChange = null }) {
    const v = contracts.validate('actor.task-create-request@1', body);
    if (!v.valid) return { status: 422, code: 'actor.task.invalid', detail: (v.errors || []).map((e) => `${e.path || e.instancePath || ''} ${e.message}`.trim()).join('; ').slice(0, 500) || 'invalid request' };
    const tier = config.allowance;
    // A budget the request named is the first word; without one, the task gets up to a tier task's worth and, below
    // that, what the day has left (so a cheap run leaves room for the next one).
    const requestedTaskUsd = body.budget && body.budget.per_task_usd != null ? body.budget.per_task_usd : null;
    const perTask = requestedTaskUsd == null ? tier.perTaskUsd : requestedTaskUsd;
    const perDay = body.budget && body.budget.per_day_usd != null ? body.budget.per_day_usd : tier.perDayUsd;
    if (perTask > tier.perTaskUsd || perDay > tier.perDayUsd) {
        return { status: 422, code: 'actor.budget.over_tier', detail: `The free tier allows up to $${tier.perTaskUsd} per task and $${tier.perDayUsd} a day; paid tiers come with OpenVibe.Billing.` };
    }
    if (body.agent && !catalog.byId(body.agent)) return { status: 422, code: 'actor.agent.unknown', detail: `no agent "${body.agent}"; GET /api/v1/agents lists them` };
    // Webhooks (plan T17): each URL must be one Actor may deliver to (https, port 443/8443, a public address); the
    // send-time check repeats it against what the name resolves to then.
    // A webhook may name a project secret (ADR-056, secret_ref): Network signs its deliveries with it. The secret lives in
    // the task's project and environment, so the task must come from a project's app or agent token.
    const env = principal.claims && ['sandbox', 'production'].includes(principal.claims.env) ? principal.claims.env : null;
    const webhooks = (body.webhooks || []).map((h) => ({ url: h.url, events: h.events, ...(h.secret_ref ? { secret_ref: h.secret_ref, environment: env } : {}) }));
    for (const h of webhooks) {
        try { checkWebhookUrl(h.url); } catch (err) { return { status: 422, code: 'actor.webhook.refused', detail: `${h.url.slice(0, 200)}: ${err.message}` }; }
        if (h.secret_ref && (!principal.project || !env)) {
            return { status: 422, code: 'actor.webhook.secret_unavailable', detail: `secret_ref names a project secret: make the task with a project's app or agent token (it carries project_id and env); this one has ${principal.project ? 'no env' : 'no project'}.` };
        }
    }
    const ownSecret = webhooks.some((h) => !h.secret_ref);

    const hash = crypto.createHash('sha256').update(JSON.stringify({ task: body.task, mode: body.mode || 'balanced', budget: [perTask, perDay], agent: body.agent || null, ...(webhooks.length ? { webhooks } : {}) })).digest('hex');
    if (body.idempotency_key) {
        const prior = await store.byIdempotency(s, principal.requester, body.idempotency_key);
        if (prior) {
            if (prior.idem_hash !== hash) return { status: 409, code: 'actor.idempotency.conflict', detail: 'This idempotency_key was used for a different task.' };
            return { status: 200, task: prior };
        }
    }
    const retryAfter = untilMidnight(s.now());
    // A follow-up that says the answer was wrong teaches the router a failure and leaves the person a suggested
    // memory (stage V2-8); it never changes what they asked for.
    const parent = parentId ? await store.getTask(s, parentId) : null;
    // Check and insert in one transaction under the day's spend-row locks, counting what open tasks may still spend:
    // concurrent creations cannot all pass on the same reading and overrun the person's or the operator's cap.
    const out = await s.tx(async () => {
        const { mine, all } = await store.lockSpendToday(s, principal.requester);
        if (mine.tasks >= tier.tasksPerDay) return { status: 429, code: 'actor.allowance.exhausted', detail: `The free tier runs ${tier.tasksPerDay} tasks a day; it resets at midnight UTC.`, retryAfter };
        const remaining = perDay - mine.usd - mine.reserved;
        if (remaining <= 1e-9 || (requestedTaskUsd != null && requestedTaskUsd > remaining + 1e-9)) {
            return { status: 429, code: 'actor.budget.day_spent', detail: `You have used today's free allowance (${usd(perDay)}). It comes back at midnight UTC. To keep going now, add your own model key at ${config.baseUrl}/chat/model: Actor runs on it, and it does not count against the free allowance.`, retryAfter };
        }
        const budgetTask = requestedTaskUsd == null ? Math.round(Math.min(perTask, remaining) * 1e6) / 1e6 : requestedTaskUsd;
        if (all.usd >= config.spendCapUsdPerDay || all.usd + all.reserved + perTask > config.spendCapUsdPerDay + 1e-9) {
            return { status: 503, code: 'actor.capacity.spent', detail: 'Actor has used today\'s free capacity across everyone. It resets at midnight UTC.', retryAfter };
        }
        if (beforeInsert) {
            const refused = await beforeInsert();
            if (refused) return refused;
        }
        const row = await store.insertTask(s, {
            id: s.newId('tsk'), requester: principal.requester, via: principal.via || null, project_id: principal.project || null, task: body.task, mode: body.mode || 'balanced', agent: body.agent || null,
            budget_task: budgetTask, budget_day: perDay, idem_key: body.idempotency_key || null, idem_hash: body.idempotency_key ? hash : null, created_at: s.iso(),
            webhooks, webhook_secret: ownSecret ? mintSecret() : null, parent_id: parentId,
            // A fork (stage V2-9) starts from its parent's checkpoint at this step, with the one change the person
            // picked; it is a new task with its own budget and its own clock.
            fork_of_step: forkOfStep == null ? null : Number(forkOfStep),
            fork_change: forkChange || null,
            // A task's own clock (Actor v2): 10 minutes by default; mode best may run up to an hour.
            timeout_ms: (body.mode || 'balanced') === 'best' ? config.bestTimeoutMs : config.taskTimeoutMs,
        });
        // What belongs with the task from its first moment (the chat's attached files), in the same transaction: the
        // engine starts it only after this commits, so the run never begins without them.
        if (afterInsert) await afterInsert(row);
        if (chatContext) await s.db.query('INSERT INTO actor_chat_tasks (task_id, agent_id, policy, conversation) VALUES ($1, $2, $3, $4)', [row.id, chatContext.agentId, chatContext.policy, chatContext.conversation]);
        return { status: 201, task: row };
    });
    // The engine starts the task only once its row has committed; a webhook that asked for `queued` hears it now.
    if (out.status === 201) {
        if (sharing) {
            try {
                const audience = await sharing.defaultOf(out.task.requester).catch(() => 'private');
                await sharing.register(out.task.requester, out.task.id, audience);
            } catch (e) {
                console.warn(`[Actor] task ${out.task.id}: not registered with the sharing system: ${String((e && e.message) || e).slice(0, 200)}`);
            }
        }
        // A follow-up that says the answer was wrong teaches the router; a fork is a different run, not a correction.
        if (parent && forkOfStep == null) await learn.correction({ store: s, parent, text: body.task, now: () => s.now() }).catch(() => {});
        if (webhooks.length && webhookQueue) await webhookQueue.enqueue(out.task.id, 'queued');
        engine.submit(out.task.id);
    }
    return out;
}

module.exports = { createTask, untilMidnight, setSharing };

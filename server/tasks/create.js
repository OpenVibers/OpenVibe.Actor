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

function untilMidnight(nowMs) {
    const n = new Date(nowMs);
    return Math.ceil((Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate() + 1) - n.getTime()) / 1000);
}

async function createTask({ s, config, engine, principal, body }) {
    const v = contracts.validate('actor.task-create-request@1', body);
    if (!v.valid) return { status: 422, code: 'actor.task.invalid', detail: (v.errors || []).map((e) => `${e.path || e.instancePath || ''} ${e.message}`.trim()).join('; ').slice(0, 500) || 'invalid request' };
    const tier = config.allowance;
    const perTask = body.budget && body.budget.per_task_usd != null ? body.budget.per_task_usd : tier.perTaskUsd;
    const perDay = body.budget && body.budget.per_day_usd != null ? body.budget.per_day_usd : tier.perDayUsd;
    if (perTask > tier.perTaskUsd || perDay > tier.perDayUsd) {
        return { status: 422, code: 'actor.budget.over_tier', detail: `The free tier allows up to $${tier.perTaskUsd} per task and $${tier.perDayUsd} a day; paid tiers come with OpenVibe.Billing.` };
    }
    if (body.agent && !catalog.byId(body.agent)) return { status: 422, code: 'actor.agent.unknown', detail: `no agent "${body.agent}"; GET /api/v1/agents lists them` };

    const hash = crypto.createHash('sha256').update(JSON.stringify({ task: body.task, mode: body.mode || 'balanced', budget: [perTask, perDay], agent: body.agent || null })).digest('hex');
    if (body.idempotency_key) {
        const prior = await store.byIdempotency(s, principal.requester, body.idempotency_key);
        if (prior) {
            if (prior.idem_hash !== hash) return { status: 409, code: 'actor.idempotency.conflict', detail: 'This idempotency_key was used for a different task.' };
            return { status: 200, task: prior };
        }
    }
    const retryAfter = untilMidnight(s.now());
    // Check and insert in one transaction under the day's spend-row locks, counting what open tasks may still spend:
    // concurrent creations cannot all pass on the same reading and overrun the person's or the operator's cap.
    const out = await s.tx(async () => {
        const { mine, all } = await store.lockSpendToday(s, principal.requester);
        if (mine.tasks >= tier.tasksPerDay) return { status: 429, code: 'actor.allowance.exhausted', detail: `The free tier runs ${tier.tasksPerDay} tasks a day; it resets at midnight UTC.`, retryAfter };
        if (mine.usd >= perDay || mine.usd + mine.reserved + perTask > perDay + 1e-9) {
            return { status: 429, code: 'actor.budget.day_spent', detail: `Today's tasks cost $${mine.usd.toFixed(3)} and running ones may use $${mine.reserved.toFixed(3)} of the $${perDay} daily budget; it resets at midnight UTC.`, retryAfter };
        }
        if (all.usd >= config.spendCapUsdPerDay || all.usd + all.reserved + perTask > config.spendCapUsdPerDay + 1e-9) {
            return { status: 503, code: 'actor.capacity.spent', detail: 'Actor has used today\'s free capacity across everyone. It resets at midnight UTC.', retryAfter };
        }
        const row = await store.insertTask(s, {
            id: s.newId('tsk'), requester: principal.requester, project_id: principal.project || null, task: body.task, mode: body.mode || 'balanced', agent: body.agent || null,
            budget_task: perTask, budget_day: perDay, idem_key: body.idempotency_key || null, idem_hash: body.idempotency_key ? hash : null, created_at: s.iso(),
        });
        return { status: 201, task: row };
    });
    // The engine starts the task only once its row has committed.
    if (out.status === 201) engine.submit(out.task.id);
    return out;
}

module.exports = { createTask, untilMidnight };

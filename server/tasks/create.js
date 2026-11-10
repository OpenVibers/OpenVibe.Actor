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
const contacts = require('../agents/contacts');
const assignments = require('../agents/assignments');
const triggerStore = require('../triggers/store');
const runTokens = require('../triggers/tokens');

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

const TURN_TOOL = /^[a-z][a-z0-9_]{1,63}$/;
// The content tiers a turn may answer under. The uncensored one is only for a task that names the person it is
// for, and OpenVibe.AI checks that person's 18+ confirmation on the account before it answers on that tier.
const TIERS = ['standard', 'uncensored'];

/**
 * A product conversation turn (one-engine slice): which product conversation this task answers, the
 * registry tool names the run may call (an empty list answers with no tool calls) and the content tier it
 * answers under. The installed contracts package still forbids these fields, so they are lifted out before the
 * contracts check and validated here; the open OpenVibe.Contracts change owns the schema, and this shim dissolves
 * when the dependency passes it.
 * Shape only: a name the registry does not offer is reported in the run's plan, never silently dropped.
 */
function turnFields(turnTools, turnConversation, turnModel, turnTier) {
    let tools = null;
    if (turnTools != null) {
        if (!Array.isArray(turnTools) || turnTools.length > 64 || turnTools.some((n) => typeof n !== 'string' || !TURN_TOOL.test(n))) {
            return { error: { status: 422, code: 'actor.task.invalid', detail: 'tools: an array of at most 64 registry tool names (snake_case); an empty array answers with no tool calls' } };
        }
        tools = [...new Set(turnTools)];
    }
    let conversation = null;
    if (turnConversation != null) {
        const c = turnConversation;
        if (!c || typeof c !== 'object' || Array.isArray(c) || typeof c.product !== 'string' || !c.product.trim() || c.product.length > 64 ||
            typeof c.id !== 'string' || !c.id.trim() || c.id.length > 256 || Object.keys(c).some((k) => k !== 'product' && k !== 'id')) {
            return { error: { status: 422, code: 'actor.task.invalid', detail: 'conversation: { product, id }, the product conversation this task answers' } };
        }
        conversation = { product: c.product.trim().slice(0, 64), id: c.id.trim().slice(0, 256) };
    }
    let model = null;
    if (turnModel != null) {
        if (typeof turnModel !== 'string' || !turnModel.trim() || turnModel.length > 256) {
            return { error: { status: 422, code: 'actor.task.invalid', detail: 'model: an exact model id, at most 256 characters' } };
        }
        model = turnModel.trim().slice(0, 256);
    }
    let tier = null;
    if (turnTier != null) {
        const t = String(turnTier).trim().toLowerCase();
        if (!TIERS.includes(t)) {
            return { error: { status: 422, code: 'actor.task.invalid', detail: `tier: one of ${TIERS.join(', ')}` } };
        }
        tier = t;
    }
    return { tools, conversation, model, tier };
}

async function createTask({ s, config, engine, principal, body, webhooks: webhookQueue = null, beforeInsert = null, chatContext = null, afterInsert = null, parentId = null, forkOfStep = null, forkChange = null, assignmentOrigin = null, assignmentLevel = null, triggerId = null, personToken = null, timezone = null }) {
    const { tools: turnTools, conversation: turnConversation, model: turnModel, tier: turnTier, ...contractBody } = body || {};
    const v = contracts.validate('actor.task-create-request@1', contractBody);
    if (!v.valid) return { status: 422, code: 'actor.task.invalid', detail: (v.errors || []).map((e) => `${e.path || e.instancePath || ''} ${e.message}`.trim()).join('; ').slice(0, 500) || 'invalid request' };
    const turn = turnFields(turnTools, turnConversation, turnModel, turnTier);
    if (turn.error) return turn.error;
    const tier = config.allowance;
    // A trigger's run is linked to its card. The trigger must belong to the same person the task is for; the
    // caller (Watch's delivery or the Run now route) already checked, and this check makes it true for every path.
    let trigger = null;
    if (triggerId != null) {
        trigger = await triggerStore.get(s, String(principal.requester).replace(/^user:/, ''), triggerId);
        if (!trigger) return { status: 404, code: 'actor.trigger.not_found', detail: 'No such trigger.' };
    }
    // The contact this thread runs as (A-1). A person's task defaults to their Vibe, created on first read; a personal
    // agent's own run keeps that agent. The thread's level may raise the agent's, never lower it.
    let agentId = typeof body.agent_id === 'string' ? body.agent_id : null;
    if (!agentId && /^agent:agt_/.test(String(principal.via || ''))) agentId = String(principal.via).slice(6);
    if (!agentId && /^chat-app:agt_/.test(String(principal.via || ''))) agentId = String(principal.via).slice(9);
    if (!agentId && String(principal.requester || '').startsWith('user:')) {
        const vibe = await contacts.ensureVibe(s, config, principal.requester);
        if (vibe) agentId = vibe.id;
    }
    if (agentId && !(await contacts.get(s, principal.requester, agentId))) {
        return { status: 422, code: 'actor.agent.not_found', detail: 'agent_id names one of your own agents (GET /api/v1/agents).' };
    }
    const level = body.level || 'ask';
    // The content tier (one-engine slice): the uncensored tier is only for a task that names the person it is for.
    // A task with no person (a watch, a webhook, a service acting for an anonymous visitor) answers on the standard
    // tier. OpenVibe.AI checks that person's 18+ confirmation on the account before it answers on the adult tier,
    // so a person who has not confirmed is refused there, in words, and never silently served the adult tier.
    const person = String(principal.requester || '').startsWith('user:') ? principal.requester.slice(5) : null;
    const tier_ = turn.tier || 'standard';
    if (tier_ === 'uncensored' && !person) {
        return { status: 422, code: 'actor.tier.no_person', detail: 'the uncensored tier is for a person: this task names nobody, so it answers on the standard tier' };
    }
    // A budget the request named is the first word; without one, the task gets up to a tier task's worth and, below
    // that, what the day has left (so a cheap run leaves room for the next one).
    const requestedTaskUsd = body.budget && body.budget.per_task_usd != null ? body.budget.per_task_usd : null;
    const perTask = requestedTaskUsd == null ? tier.perTaskUsd : requestedTaskUsd;
    const perDay = body.budget && body.budget.per_day_usd != null ? body.budget.per_day_usd : tier.perDayUsd;
    if (perTask > tier.perTaskUsd || perDay > tier.perDayUsd) {
        return { status: 422, code: 'actor.budget.over_tier', detail: `The free tier allows up to $${tier.perTaskUsd} per task and $${tier.perDayUsd} a day; paid tiers come with OpenVibe.Billing.` };
    }
    if (body.agent && !catalog.byId(body.agent)) return { status: 422, code: 'actor.agent.unknown', detail: `no agent "${body.agent}"; GET /api/v1/agent-systems lists them` };
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

    const hash = crypto.createHash('sha256').update(JSON.stringify({ task: body.task, mode: body.mode || 'balanced', budget: [perTask, perDay], agent: body.agent || null, ...(body.agent_id ? { agent_id: body.agent_id } : {}), ...(body.level ? { level: body.level } : {}), ...(turn.tools != null ? { tools: turn.tools } : {}), ...(turn.conversation ? { conversation: turn.conversation } : {}), ...(turn.model ? { model: turn.model } : {}), ...(turn.tier ? { tier: turn.tier } : {}), ...(webhooks.length ? { webhooks } : {}) })).digest('hex');
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
        const id = s.newId('tsk');
        const row = await store.insertTask(s, {
            id, requester: principal.requester, via: principal.via || null, project_id: principal.project || null, task: body.task, mode: body.mode || 'balanced', agent: body.agent || null,
            budget_task: budgetTask, budget_day: perDay, idem_key: body.idempotency_key || null, idem_hash: body.idempotency_key ? hash : null, created_at: s.iso(),
            webhooks, webhook_secret: ownSecret ? mintSecret() : null, parent_id: parentId,
            // A fork (stage V2-9) starts from its parent's checkpoint at this step, with the one change the person
            // picked; it is a new task with its own budget and its own clock.
            fork_of_step: forkOfStep == null ? null : Number(forkOfStep),
            fork_change: forkChange || null,
            // A task's own clock (Actor v2): 10 minutes by default; mode best may run up to an hour.
            timeout_ms: (body.mode || 'balanced') === 'best' ? config.bestTimeoutMs : config.taskTimeoutMs,
            agent_id: agentId, level,
            // A product conversation turn (one-engine slice): which conversation it answers, the tools it may
            // call, the model it asked for, and the content tier it answers under.
            conversation: turn.conversation, tools: turn.tools, model: turn.model, tier: turn.tier,
        });
        // What belongs with the task from its first moment (the chat's attached files), in the same transaction: the
        // engine starts it only after this commits, so the run never begins without them.
        // Every hand-off is one node (plan §12 A-2). The root is made with the task, so the tree exists from
        // its first step; an older task without one gets it lazily (assignments.ensureForTask).
        const node = await assignments.ensureForTask(s, config, row, { origin: assignmentOrigin, level: assignmentLevel });
        const task = node ? { ...row, assignment_id: node.id } : row;
        if (trigger) await triggerStore.addRun(s, trigger.id, task.id, 'queued', s.now());
        if (afterInsert) await afterInsert(task);
        if (chatContext) await s.db.query('INSERT INTO actor_chat_tasks (task_id, agent_id, policy, conversation) VALUES ($1, $2, $3, $4)', [task.id, chatContext.agentId, chatContext.policy, chatContext.conversation]);
        return { status: 201, task };
    });
    // The engine starts the task only once its row has committed; a webhook that asked for `queued` hears it now.
    if (out.status === 201) {
        if (personToken) runTokens.put(out.task.id, { token: personToken, timezone });
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

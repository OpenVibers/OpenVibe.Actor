'use strict';

/**
 * The fabric's executor and model adapters (S4, plan W2/W3).
 *
 * The fabric stores work and never calls a model or a network port itself. This module performs that work through the
 * ports Actor already has:
 *
 *   route    deterministic: an explicit human ask becomes one Ticket (no model call)
 *   assess   one cheap model call on Actor's model layer, shaped into agent.decision@1; no answer is invented
 *   launch   the Ticket's mandate is assigned to the owner's agent and run on Actor's one runtime (personal.run)
 *   input    a follow-up becomes one more run of the same agent, as a child of the Ticket's task
 *   reply    the worker's answer goes back to the Source thread (Chat; Mail when the original letter is known)
 *   end      the Ticket ended; there is nothing left to deliver
 *
 * The task engine calls onTaskState when a run ends, and that turns the run's outcome into an agent.report@1 report on
 * the Ticket (ready, failed or dropped). This is behind ACTOR_WORK_FABRIC, which is off by default; no adapter starts
 * unless the owner switch is on.
 */
const contracts = require('openvibe-contracts');
const contacts = require('../agents/contacts');
const personal = require('../agents/personal');

const ROUTER_HANDLERS = ['route', 'assess', 'launch', 'input', 'end', 'reply'];
const ASSESS_SYSTEM = `You assess one incoming message for an agent's work rules. Return one JSON object and nothing else.

You are the gate's assessment step, not the worker. Do not answer the message and do not invent work. Decide only
whether this message asks the agent to implement work under one of its enabled rules.
- "accept" only when the message asks for implementation, the target is specified by the message or an existing
  standard the message names, no design decision is required, and at least one enabled rule matches.
- "ignore" otherwise.
- "unavailable" only when the message cannot be read.

Every enabled rule must appear exactly once in rule_assessments. Quote evidence verbatim from the trigger text; a
quote that is not in the text invalidates the assessment. Return:
{"decision":"accept|ignore|unavailable","scope":"one short sentence naming the work","direction":{"implementation_requested":true|false,"target_basis":"specified|existing-standard|undetermined","requires_design_decision":true|false,"evidence":[{"trigger_id":"...","quote":"..."}]},"rule_assessments":[{"rule_id":"...","matched":true|false,"reason":"one short sentence"}]}`;

const clip = (value, n) => String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, n);
const stripFences = (text) => String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');

/** The trigger text a run starts from, with the pointer rather than a pasted page (plan W6.7). */
function inputFor(trigger, ticket) {
    const who = trigger.actor && trigger.actor.kind === 'person' ? 'A person' : trigger.actor && trigger.actor.kind === 'bot' ? 'A bot' : 'A system';
    const scope = clip(ticket && ticket.mandate && ticket.mandate.scope, 400);
    const budget = ticket && ticket.mandate && ticket.mandate.budget ? ticket.mandate.budget : {};
    return [
        `${who} asked through ${trigger.source} (${trigger.source_scope}):`,
        clip(trigger.text, 4000),
        trigger.read_pointer ? `Original: ${trigger.read_pointer}` : '',
        scope ? `The mandate covers: ${scope}` : '',
        `Budget for this work: ${Number(budget.usd) || 0} USD, ${Number(budget.tokens) || 0} tokens, ${Number(budget.wall_minutes) || 0} wall minutes. Stay inside it.`,
    ].filter(Boolean).join('\n');
}

/** One report for the Ticket, from the run's own row. The six states are agent.report@1's. */
function reportFor(row, ticket) {
    const ready = row.state === 'succeeded';
    const dropped = row.state === 'cancelled';
    let summary = '';
    if (ready) {
        let result = row.result;
        if (typeof result === 'string') { try { result = JSON.parse(result); } catch { /* plain text */ } }
        summary = clip(result && typeof result === 'object' ? (result.answer || result.text || JSON.stringify(result)) : result, 600);
        if (!summary) summary = 'The job finished.';
    } else if (dropped) summary = 'The job was stopped before it finished.';
    else summary = clip(row.error_detail || row.error_code || 'The job failed.', 600);
    const report = {
        ticket_id: ticket.id,
        assignment_id: row.assignment_id || row.id,
        state: ready ? 'ready' : dropped ? 'dropped' : 'failed',
        summary,
        pr: null,
        tests_run: [],
        risks: ready ? [] : [summary],
    };
    contracts.assertValid('agent.report@1', report);
    return report;
}

function createFabricAdapters({ s, config, fabric, models, ctx: taskCtx = null, log = console, agentFor = null, runAgent = null, chat = null, mail = null }) {
    const getAgent = agentFor || ((owner, id) => contacts.get(s, owner, id));
    const ctx = taskCtx || { s, config, engine: null, webhooks: null };
    const run = runAgent || ((runCtx, agent, input, options) => personal.run(runCtx, agent, input, options));

    /** The owner's agent, or null when the row vanished. A Ticket for a missing agent fails visibly, never retries. */
    async function agentOf(owner, id) {
        const agent = await getAgent(owner, id);
        if (!agent) { const err = new Error('The agent this Ticket belongs to is gone'); err.permanent = true; throw err; }
        return agent;
    }

    async function snapshot(owner, agent) { return (await fabric.snapshot(owner, agent)).state; }

    function sourceOf(state, id) { return state.sources[id] || null; }

    /** The executor port: one run of the owner's agent for the Ticket, its task id bound to the Ticket. */
    async function assign(owner, agentId, ticket, trigger, parentId = null) {
        const agent = await agentOf(owner, agentId);
        const budgetUsd = ticket.mandate && ticket.mandate.budget ? Number(ticket.mandate.budget.usd) : null;
        if (budgetUsd != null && budgetUsd <= 0) {
            throw Object.assign(new Error('The mandate has a zero budget, so nothing was run.'), { permanent: true });
        }
        const out = await run(ctx, agent, inputFor(trigger, ticket), {
            budgetUsd,
            origin: trigger.actor && trigger.actor.kind === 'person' ? 'person' : 'routine',
            assignmentLevel: 'ask',
            parentId,
            // The binding commits with the task's own insert, so a run can never end without a report target.
            afterInsert: async (task) => {
                await s.db.query(`INSERT INTO actor_fabric_tasks (task_id, agent_id, owner, ticket_id, created_at)
                    VALUES ($1, $2, $3, $4, $5) ON CONFLICT (task_id) DO NOTHING`, [task.id, agentId, owner, ticket.id, s.iso()]);
            },
        });
        if (!out || out.status !== 201 || !out.task) {
            const why = out && (out.detail || out.code) ? `${out.code || 'actor.fabric.assign'}: ${out.detail}` : 'The agent could not start';
            throw Object.assign(new Error(why), { permanent: true });
        }
        // The binding already committed with the task; this also records the current task for follow-ups.
        await fabric.command(owner, agentId, 'bind', { ticket_id: ticket.id, task_id: out.task.id })
            .catch((err) => log.warn && log.warn('[Actor] fabric bind:', ticket.id, (err && err.message) || err));
        return out.task;
    }

    /** A permanent assignment failure is a failed report, not an endless retry. */
    async function reportFailure(owner, agentId, payload, reason) {
        const ticket = payload.ticket || (payload.ticket_id && (await snapshot(owner, agentId)).tickets[payload.ticket_id]);
        if (!ticket) return;
        const report = {
            ticket_id: ticket.id, assignment_id: ticket.id, state: 'failed',
            summary: clip(reason || 'The agent could not start.', 600), pr: null, tests_run: [],
            risks: [clip(reason || 'The agent could not start.', 300)],
        };
        contracts.assertValid('agent.report@1', report);
        await fabric.command(owner, agentId, 'report', { ticket_id: ticket.id, report, end: true });
    }

    const handlers = (owner, agentId) => ({
        async route(payload) {
            const evaluation = payload.evaluation;
            const trigger = (payload.triggers || []).find((t) => t.id === evaluation.primary);
            if (!trigger) throw new Error('The evaluation has no primary trigger');
            await fabric.command(owner, agentId, 'decide', { evaluation: evaluation.id, decision: 'accept', scope: clip(trigger.text, 400) });
        },

        async assess(payload) {
            const evaluation = payload.evaluation;
            const triggers = payload.triggers || [];
            const rules = ((payload.policy && payload.policy.rules) || []).filter((r) => r.enabled);
            if (!rules.length) {
                await fabric.command(owner, agentId, 'decide', { evaluation: evaluation.id, decision: 'ignore', reason: 'No enabled rule to assess against.' });
                return;
            }
            if (!models || typeof models.chat !== 'function') {
                await fabric.command(owner, agentId, 'decide', { evaluation: evaluation.id, decision: 'unavailable', reason: 'Actor has no model configured to assess this work.' });
                return;
            }
            const prompt = [
                'Enabled rules:',
                ...rules.map((r) => `- ${r.id}: ${clip(r.instruction, 1000)}`),
                '',
                'Messages:',
                ...triggers.map((t) => `- trigger_id ${t.id} (${t.addresses_agent || 'none'}, ${t.actor && t.actor.kind}): ${clip(t.text, 4000)}`),
            ].join('\n');
            let assessment;
            try {
                const r = await models.chat({ tier: 'check', json: true, maxTokens: 1200, messages: [{ role: 'system', content: ASSESS_SYSTEM }, { role: 'user', content: prompt }] });
                assessment = JSON.parse(stripFences(r && r.text));
            } catch (err) {
                log.warn && log.warn('[Actor] fabric assessment unavailable:', (err && err.message) || err);
                await fabric.command(owner, agentId, 'decide', { evaluation: evaluation.id, decision: 'unavailable', reason: 'The assessment model could not return a usable answer, so nothing ran.' });
                return;
            }
            try {
                await fabric.command(owner, agentId, 'decide', { evaluation: evaluation.id, decision: assessment.decision, scope: assessment.scope, assessment });
            } catch (err) {
                // The engine validates evidence quotes and one assessment per enabled rule. A malformed answer is the
                // assessor's failure, not the worker's: record it as unavailable rather than retrying forever.
                log.warn && log.warn('[Actor] fabric assessment refused:', (err && err.message) || err);
                await fabric.command(owner, agentId, 'decide', { evaluation: evaluation.id, decision: 'unavailable', reason: 'The assessment did not pass the gate, so nothing ran.' });
            }
        },

        async launch(payload) {
            const ticket = payload.ticket;
            const state = await snapshot(owner, agentId);
            const trigger = state.triggers[ticket.trigger_id];
            if (!trigger) throw new Error('The Ticket has no originating Trigger');
            try { await assign(owner, agentId, ticket, trigger); }
            catch (err) { await reportFailure(owner, agentId, { ticket }, (err && err.message) || String(err)); }
        },

        async input(payload) {
            if (payload.context_only) return;
            const state = await snapshot(owner, agentId);
            const ticket = state.tickets[payload.ticket_id];
            const trigger = payload.trigger;
            if (!ticket || !trigger) return;
            const meta = state.meta[ticket.id] || {};
            const parentId = meta.task_id || null;
            try { await assign(owner, agentId, ticket, trigger, parentId); }
            catch (err) { await reportFailure(owner, agentId, { ticket }, (err && err.message) || String(err)); }
        },

        async end() { /* the Ticket ended; its task needs no further message */ },

        async reply(payload) {
            const state = await snapshot(owner, agentId);
            const source = sourceOf(state, payload.source);
            if (!source) return;
            if (source.kind === 'chat' && chat) {
                const room = payload.source_scope === 'global' ? { type: 'global' }
                    : /^channel:/.test(payload.source_scope) ? { type: 'channel', channel_user_id: payload.source_scope.slice(8) }
                        : null;
                if (!room) return;
                const out = await chat.post({ key: payload.key, room, text: payload.text });
                if (!out || !out.ok) throw new Error((out && out.error) || 'Chat did not accept the reply');
                return;
            }
            if (source.kind === 'mail' && mail) {
                const ticket = (await snapshot(owner, agentId)).tickets[payload.ticket_id];
                const trigger = ticket && (await snapshot(owner, agentId)).triggers[ticket.trigger_id];
                const pointer = trigger && trigger.read_pointer;
                const messageId = pointer ? decodeURIComponent(String(pointer).split('/').pop()) : null;
                if (!messageId || messageId === 'undefined') return;
                const out = await mail.reply({ person: String(owner).replace(/^user:/, ''), agentId, messageId, body: payload.text });
                if (!out || !out.ok) throw new Error((out && (out.error || out.code)) || 'Mail did not accept the reply');
            }
        },
    });

    /** One pump: claim and perform work for one agent until its queue is empty or the budget is used. */
    async function pump(owner, agentId, limit = 10) {
        const h = handlers(owner, agentId);
        for (let i = 0; i < limit; i++) {
            const did = await fabric.drain(owner, agentId, h).catch((err) => { log.warn && log.warn('[Actor] fabric work failed:', agentId, (err && err.message) || err); return true; });
            if (!did) return i;
        }
        return limit;
    }

    /** Drain every fabric that has work. The index job calls this every couple of seconds while the switch is on. */
    async function drainAll(limit = 20) {
        if (!fabric.enabled) return 0;
        const rows = await s.db.many('SELECT agent_id, owner FROM actor_work_fabric ORDER BY updated_at, agent_id');
        let done = 0;
        for (const row of rows) {
            if (done >= limit) break;
            done += await pump(row.owner, row.agent_id, limit - done);
        }
        return done;
    }

    /**
     * A task run ended: put its outcome on the Ticket as an agent.report@1 report and end the Ticket. The row's own
     * via/requester name the fabric and owner; a task from anywhere else is ignored.
     */
    async function onTaskState(row) {
        if (!fabric.enabled || !row || !['succeeded', 'failed', 'cancelled'].includes(row.state)) return;
        const via = String(row.via || '');
        if (!/^agent:agt_/.test(via)) return;
        let agentId = via.slice(6), owner = row.requester, ticketId = null;
        const link = await s.db.maybe('SELECT agent_id, owner, ticket_id FROM actor_fabric_tasks WHERE task_id = $1', [row.id]);
        if (link) { agentId = link.agent_id; owner = link.owner; ticketId = link.ticket_id; }
        const found = await s.db.maybe('SELECT state FROM actor_work_fabric WHERE agent_id = $1 AND owner = $2', [agentId, owner]);
        if (!found) return;
        const state = found.state;
        // Older runs (before the binding table) are found by the Ticket's own task list.
        ticketId ||= Object.keys(state.tickets).find((id) => {
            const meta = state.meta[id] || {};
            return meta.task_id === row.id || (Array.isArray(meta.tasks) && meta.tasks.includes(row.id));
        });
        if (!ticketId) return;
        const ticket = state.tickets[ticketId];
        if (ticket.state !== 'open') return;
        const report = reportFor(row, ticket);
        await fabric.command(owner, agentId, 'report', { ticket_id: ticketId, report, end: true });
        // One confirmation to the person on the Source thread, not a stream of progress.
        const source = state.sources[ticket.mandate.actor.source];
        if (source) {
            const text = report.state === 'ready'
                ? `${clip(report.summary, 500)}`
                : `I stopped: ${clip(report.summary, 500)}`;
            await fabric.command(owner, agentId, 'reply', {
                ticket_id: ticketId, conversation: ticket.mandate.source_scope,
                source: ticket.mandate.actor.source, key: `report:${row.id}`, text,
            }).catch((err) => log.warn && log.warn('[Actor] fabric report reply not queued:', (err && err.message) || err));
        }
    }

    return { handlers, assign, drainAll, pump, onTaskState, ROUTER_HANDLERS };
}

module.exports = { createFabricAdapters, inputFor, reportFor, ASSESS_SYSTEM, ROUTER_HANDLERS };

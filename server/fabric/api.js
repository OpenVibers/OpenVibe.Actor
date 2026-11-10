'use strict';
const express = require('express');
const { asyncRouter } = require('../http/router');
const contracts = require('openvibe-contracts');
const { reportStates, emptyReportCounts } = require('./reports');
const { laneMode } = require('./policy');
function createRoutes(ctx) {
    const r = asyncRouter();
    r.use(express.json({ limit: '64kb' }));
    r.use(ctx.principal.middleware);
    r.use(ctx.principal.requireCapability('actor.agent.manage'));
    r.use((req, res, next) => {
        if (!ctx.fabric.enabled) return res.sendStatus(404);
        if (req.principal?.kind !== 'user') return res.sendStatus(403);
        res.set('Cache-Control', 'no-store'); next();
    });
    const run = fn => async (req, res, next) => {
        try { res.json(await fn(req)); }
        catch (err) { if (err.status) return contracts.http.sendProblem(res, err.status, 'actor.fabric.refused', { detail: err.message, ctx: req.ov }); next(err); }
    };
    r.get('/:agent', run(req => ctx.fabric.snapshot(req.principal.requester, req.params.agent)));

    /** What the panel needs for a trigger's mode: each lane, its observe count and its reports by state. */
    r.get('/:agent/lanes', run(async (req) => {
        const owner = req.principal.requester, agent = req.params.agent;
        const snap = await ctx.fabric.snapshot(owner, agent);
        const state = snap.state;
        const stats = await ctx.fabric.laneStats(owner, agent);
        const seen = new Map(stats.observe.map((x) => [x.rule_id, x]));
        const changed = new Map(stats.changes.map((x) => [x.rule_id, x]));
        const reports = new Map();
        for (const [ticketId, ticket] of Object.entries(state.tickets || {})) {
            const meta = (state.meta || {})[ticketId] || {};
            for (const report of meta.reports || []) {
                for (const lane of (ticket.mandate && ticket.mandate.matched_rules) || []) {
                    if (!reports.has(lane)) reports.set(lane, emptyReportCounts());
                    if (Object.hasOwn(reports.get(lane), report.state)) reports.get(lane)[report.state] += 1;
                }
            }
        }
        const lanes = (state.policy && state.policy.rules ? state.policy.rules : []).map((rule) => {
            const last = changed.get(rule.id);
            return {
                rule_id: rule.id,
                instruction: rule.instruction,
                enabled: rule.enabled !== false,
                mode: state.policy.mode === 'auto' ? laneMode(rule) : 'observe',
                configured_mode: laneMode(rule),
                promoted_at: rule.promoted_at || null,
                demoted_at: rule.demoted_at || null,
                demote_reason: rule.demote_reason || null,
                observe: { count: Number((seen.get(rule.id) || {}).count) || 0, last_at: (seen.get(rule.id) || {}).last_at || null },
                last_change: last ? { from_mode: last.from_mode, to_mode: last.to_mode, reason: last.reason, actor: last.actor, at: last.created_at } : null,
                report_counts: reports.get(rule.id) || emptyReportCounts(),
            };
        });
        return {
            agent, mode: state.policy ? state.policy.mode : 'observe', policy_version: state.policy ? state.policy.version : null,
            budget: state.policy ? state.policy.budget : null, lanes, report_states: reportStates(),
        };
    }));

    /** What the panel needs for observe records: newest first, one lane or all of them. */
    r.get('/:agent/observe', run(async (req) => {
        const lane = req.query.lane == null || req.query.lane === '' ? null : String(req.query.lane).slice(0, 80);
        const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 50));
        const records = await ctx.fabric.observe(req.principal.requester, req.params.agent, { lane, limit });
        return { agent: req.params.agent, lane, records, report_states: reportStates() };
    }));

    /** The six report states alone, for a panel that shows the legend before it loads a ticket. */
    r.get('/:agent/report-states', run(req => ({ agent: req.params.agent, report_states: reportStates() })));

    /** The reports behind the six states, ticket by ticket. */
    r.get('/:agent/reports', run(async (req) => {
        const snap = await ctx.fabric.snapshot(req.principal.requester, req.params.agent);
        const state = snap.state;
        if (req.query.detail === 'work') {
            const owner = req.principal.requester, agent = req.params.agent;
            const links = await ctx.s.db.many(`SELECT ft.ticket_id, t.id AS task_id, t.state AS task_state,
                t.result, t.error_code, t.cost_usd, t.created_at, t.finished_at
                FROM actor_fabric_tasks ft JOIN tasks t ON t.id = ft.task_id
                WHERE ft.owner = $1 AND ft.agent_id = $2 ORDER BY t.created_at DESC LIMIT 200`, [owner, agent]);
            const taskIds = links.map(x => x.task_id);
            const files = taskIds.length ? await ctx.s.db.many(`SELECT task_id, id, name, mime, size, created_at
                FROM actor_artifacts WHERE owner = $1 AND task_id = ANY($2::text[]) ORDER BY created_at`, [owner, taskIds]) : [];
            const byTicket = new Map();
            for (const row of links) {
                const list = byTicket.get(row.ticket_id) || [];
                list.push({ task_id: row.task_id, state: row.task_state, result: row.result,
                    error_code: row.error_code, cost_usd: Number(row.cost_usd) || 0,
                    created_at: row.created_at, finished_at: row.finished_at });
                byTicket.set(row.ticket_id, list);
            }
            const tickets = Object.entries(state.tickets || {}).map(([id, ticket]) => {
                const meta = (state.meta || {})[id] || {}, runs = byTicket.get(id) || [];
                return { ticket_id: id, state: ticket.state, stage: ticket.stage, mandate: ticket.mandate,
                    evaluation: (state.decisions || []).filter(x => x.trigger_ids && x.trigger_ids.includes(ticket.trigger_id)),
                    reports: meta.reports || [], runs,
                    artifacts: files.filter(x => runs.some(run => run.task_id === x.task_id)).map(x => ({
                        task_id: x.task_id, id: x.id, name: x.name, mime: x.mime, size: Number(x.size),
                        url: `/api/v1/tasks/${encodeURIComponent(x.task_id)}/artifacts/${encodeURIComponent(x.id)}`, created_at: x.created_at,
                    })) };
            });
            return { agent: req.params.agent, tickets };
        }
        const tickets = Object.entries(state.tickets || {}).map(([id, ticket]) => ({
            ticket_id: id,
            state: ticket.state,
            stage: ticket.stage,
            lanes: (ticket.mandate && ticket.mandate.matched_rules) || [],
            threads: ticket.threads || [],
            reports: ((state.meta || {})[id] || {}).reports || [],
        }));
        return { agent: req.params.agent, tickets, report_states: reportStates() };
    }));

    /** Durable work detail: ticket decision, final reports, spend and artifact references. Bytes stay behind the task artifact route. */
    r.post('/:agent/commands/:command', run(req => req.params.command === 'deleteTicket'
        ? ctx.fabric.deleteTicket(req.principal.requester, req.params.agent, req.body && req.body.ticket_id)
        : ctx.fabric.command(req.principal.requester, req.params.agent, req.params.command, req.body)));
    return r;
}
module.exports = { createRoutes };

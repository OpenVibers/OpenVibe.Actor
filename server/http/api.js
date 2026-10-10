'use strict';

/**
 * /api/v1 — Actor's API (capabilities in openvibe-contracts manifests/capabilities/actor.*):
 *
 *   GET  /agents                 actor.agent.read (public)   the agent systems, their rate cards and availability
 *   POST /route                  actor.agent.read (public)   which agent a task would go to, and why (nothing runs)
 *   POST /tasks                  actor.task.create           give Actor a task (actor.task-create-request@1 → platform.task@1)
 *   GET  /tasks                  actor.task.list             your tasks, newest first
 *   GET  /tasks/:id              actor.task.read             one task
 *   GET  /tasks/:id/events       actor.task.read             its live stream (actor.task-event@1, Last-Event-ID)
 *   POST /tasks/:id/cancel       actor.task.create           stop it
 *
 * A task is visible to its requester only (or to tokens of the project it belongs to); anyone else gets 404, the same
 * as a task that does not exist. Creating one goes through tasks/create.js (money limits before any work).
 */
const express = require('express');
const contracts = require('openvibe-contracts');
const { asyncRouter } = require('./router');
const store = require('../tasks/store');
const catalog = require('../agents/catalog');
const { heuristic } = require('../agents/classify');
const { route, MODES } = require('../agents/router');
const { createTask } = require('../tasks/create');

const TASK_ID = /^tsk_[0-9A-HJKMNP-TV-Z]{26}$/;

function createApi(ctx) {
    const { config, s, engine, stream, principal, limits } = ctx;
    const r = asyncRouter();
    const problem = (req, res, status, code, detail, extra) => contracts.http.sendProblem(res, status, code, { detail, ctx: req.ov, extra });

    r.use(express.json({ limit: '64kb' }));
    r.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
    r.use(principal.middleware);

    // ── The catalog and the dry run (public) ─────────────────
    r.get('/agents', limits.reads('actor.agent.read'), (req, res) => res.json({ agents: catalog.list(config) }));

    r.post('/route', limits.budget('actor.route'), (req, res) => {
        const b = req.body || {};
        if (typeof b.task !== 'string' || !b.task.trim() || b.task.length > 20000) return problem(req, res, 422, 'actor.task.invalid', 'task: the instruction in plain words (1 to 20000 characters)');
        const mode = b.mode == null ? 'balanced' : b.mode;
        if (!MODES.includes(mode)) return problem(req, res, 422, 'actor.mode.invalid', `mode: one of ${MODES.join(', ')}`);
        if (b.agent != null && !catalog.byId(b.agent)) return problem(req, res, 422, 'actor.agent.unknown', `no agent "${String(b.agent).slice(0, 64)}"; GET /api/v1/agents lists them`);
        // The dry run classifies by the free heuristic: it never spends anything.
        const cls = heuristic(b.task);
        res.json({ class: cls, ...route({ cls, mode, agent: b.agent || null, budgetUsd: config.allowance.perTaskUsd, config }) });
    });

    // ── Tasks ────────────────────────────────────────────────
    // A delegated caller (a service acting for the person) owns only the person's tasks it started itself.
    const owns = (p, row) => row && ((row.requester === p.requester && (!p.via || row.via === p.via)) || (p.project && row.project_id === p.project));
    async function load(req, res) {
        if (!TASK_ID.test(req.params.id)) { problem(req, res, 404, 'actor.task.not_found', 'No such task.'); return null; }
        const row = await store.getTask(s, req.params.id);
        if (!owns(req.principal, row)) { problem(req, res, 404, 'actor.task.not_found', 'No such task.'); return null; }
        return row;
    }
    const wire = (row) => store.toWire(row, { baseUrl: config.baseUrl });

    r.post('/tasks', principal.requireCapability('actor.task.create'), limits.budget('actor.task.create'), async (req, res) => {
        const out = await createTask({ s, config, engine, principal: req.principal, body: req.body || {} });
        if (out.code) {
            if (out.retryAfter) res.set('Retry-After', String(out.retryAfter));
            return problem(req, res, out.status, out.code, out.detail);
        }
        if (out.status === 201) res.set('Location', `/api/v1/tasks/${out.task.id}`);
        return res.status(out.status).json(wire(out.task));
    });

    r.get('/tasks', principal.requireCapability('actor.task.list'), limits.reads('actor.task.list'), async (req, res) => {
        const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
        const before = typeof req.query.before === 'string' && TASK_ID.test(req.query.before) ? req.query.before : null;
        const page = await store.listTasks(s, req.principal.requester, { limit, before, via: req.principal.via || null });
        res.json({ tasks: page.rows.map(wire), next: page.next });
    });

    r.get('/tasks/:id', principal.requireCapability('actor.task.read'), limits.reads('actor.task.read'), async (req, res) => {
        const row = await load(req, res);
        if (row) res.json(wire(row));
    });

    r.get('/tasks/:id/events', principal.requireCapability('actor.task.read'), limits.budget('actor.task.stream'), async (req, res) => {
        const row = await load(req, res);
        if (!row) return;
        const after = Math.max(0, parseInt(req.get('last-event-id') || req.query.after, 10) || 0);
        await stream.serve(req, res, {
            taskId: row.id, after,
            readBacklog: () => store.eventsAfter(s, row.id, after),
            isEnded: async () => { const cur = await store.getTask(s, row.id); return !cur || !store.OPEN.includes(cur.state); },
        });
    });

    r.post('/tasks/:id/cancel', principal.requireCapability('actor.task.create'), async (req, res) => {
        const row = await load(req, res);
        if (!row) return;
        const after = await engine.cancel(row.id, req.principal.requester);
        res.status(store.OPEN.includes(after.state) ? 202 : 200).json(wire(after));
    });

    return r;
}

module.exports = { createApi };

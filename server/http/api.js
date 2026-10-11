'use strict';

/**
 * /api/v1 — Actor's API (capabilities in openvibe-contracts manifests/capabilities/actor.*):
 *
 *   GET  /agents                 actor.agent.read (public)   the agent systems, their rate cards and availability
 *   POST /route                  actor.agent.read (public)   which agent a task would go to, and why (nothing runs)
 *   POST /tasks                  actor.task.create           give Actor a task (actor.task-create-request@1 → platform.task@1;
 *                                                           with webhooks, the answer carries webhook_secret once)
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
const personal = require('../agents/personal');

const TASK_ID = /^tsk_[0-9A-HJKMNP-TV-Z]{26}$/;

function createApi(ctx) {
    const { config, s, engine, stream, principal, limits, webhooks } = ctx;
    const r = asyncRouter();
    const problem = (req, res, status, code, detail, extra) => contracts.http.sendProblem(res, status, code, { detail, ctx: req.ov, extra });

    r.use(express.json({ limit: '64kb' }));
    r.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
    r.use(principal.middleware);

    // ── The catalog and the dry run (public) ─────────────────
    r.get('/agents', limits.reads('actor.agent.read'), (req, res) => res.json({ agents: catalog.list(config) }));

    // A person's own agents live under /me: /agents stays the public catalog of agent systems (actor.agent.read).
    r.get('/me/agents', principal.requireCapability('actor.agent.manage'), (req, res, next) => owner(req, res, next), limits.reads('actor.agent.manage'), async (req, res) => {
        res.json({ agents: await personal.list(s, req.principal.requester) });
    });

    const owner = (req, res, next) => {
        if (!req.principal.requester || !req.principal.requester.startsWith('user:')) return problem(req, res, 404, 'actor.agent.not_found', 'No such agent.');
        return next();
    };
    const loadAgent = async (req, res) => {
        const row = await personal.get(s, req.principal.requester, req.params.id);
        if (!row) problem(req, res, 404, 'actor.agent.not_found', 'No such agent.');
        return row;
    };
    const failed = (req, res, out) => problem(req, res, out.limit ? 429 : 422, out.limit ? 'actor.agent.limit' : 'actor.agent.invalid', out.error || 'Agent limit reached.');

    r.post('/me/agents', principal.requireCapability('actor.agent.manage'), owner, limits.budget('actor.agent.manage'), async (req, res) => {
        const out = await personal.create(s, config, req.principal.requester, req.body);
        if (!out.row) return failed(req, res, out);
        res.set('Location', `/api/v1/me/agents/${out.row.id}`);
        res.status(201).json(out.row);
    });
    r.get('/me/agents/:id', principal.requireCapability('actor.agent.manage'), owner, limits.reads('actor.agent.manage'), async (req, res) => {
        const row = await loadAgent(req, res); if (row) res.json(row);
    });
    r.patch('/me/agents/:id', principal.requireCapability('actor.agent.manage'), owner, limits.budget('actor.agent.manage'), async (req, res) => {
        const out = await personal.update(s, config, req.principal.requester, req.params.id, req.body);
        if (!out) return problem(req, res, 404, 'actor.agent.not_found', 'No such agent.');
        if (!out.row) return failed(req, res, out);
        res.json(out.row);
    });
    r.delete('/me/agents/:id', principal.requireCapability('actor.agent.manage'), owner, limits.budget('actor.agent.manage'), async (req, res) => {
        const row = await loadAgent(req, res); if (!row) return;
        await s.db.query('DELETE FROM actor_agents WHERE id = $1 AND owner = $2', [row.id, row.owner]);
        res.status(204).end();
    });
    r.post('/me/agents/:id/run', principal.requireCapability('actor.agent.run'), owner, limits.budget('actor.agent.run'), async (req, res) => {
        const row = await loadAgent(req, res); if (!row) return;
        const out = await personal.run(ctx, row, (req.body || {}).input || '');
        if (out.code) return problem(req, res, out.status, out.code, out.detail);
        res.set('Location', `/api/v1/tasks/${out.task.id}`);
        res.status(201).json(store.toWire(out.task, { baseUrl: config.baseUrl }));
    });
    r.get('/me/agents/:id/runs', principal.requireCapability('actor.agent.run'), owner, limits.reads('actor.agent.run'), async (req, res) => {
        const row = await loadAgent(req, res); if (!row) return;
        const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
        const before = TASK_ID.test(req.query.before || '') ? req.query.before : null;
        const page = await store.listTasks(s, row.owner, { limit, before, via: `agent:${row.id}` });
        res.json({ tasks: page.rows.map((t) => store.toWire(t, { baseUrl: config.baseUrl })), next: page.next });
    });
    r.get('/me/agents/:id/memory', principal.requireCapability('actor.agent.manage'), owner, limits.reads('actor.agent.manage'), async (req, res) => {
        const row = await loadAgent(req, res); if (row) res.json({ memory: await personal.memory(s, row.owner, row.id) });
    });
    r.post('/me/agents/:id/memory', principal.requireCapability('actor.agent.manage'), owner, limits.budget('actor.agent.manage'), async (req, res) => {
        const row = await loadAgent(req, res); if (!row) return;
        const out = await personal.addMemory(s, row.owner, row.id, (req.body || {}).text);
        if (!out.row) return failed(req, res, out);
        res.status(201).json(out.row);
    });
    r.patch('/me/agents/:id/memory/:mem', principal.requireCapability('actor.agent.manage'), owner, limits.budget('actor.agent.manage'), async (req, res) => {
        const row = await loadAgent(req, res); if (!row) return;
        const value = (req.body || {}).text;
        if (!personal.MEM_ID.test(req.params.mem)) return problem(req, res, 404, 'actor.agent.not_found', 'No such note.');
        if (typeof value !== 'string' || !value.trim() || value.length > 1000) return problem(req, res, 422, 'actor.agent.invalid', 'memory text must be 1–1000 characters.');
        const note = await s.db.maybe('UPDATE actor_agent_memory SET text = $1, updated_at = $2 WHERE id = $3 AND agent_id = $4 AND owner = $5 RETURNING *', [value.trim(), s.iso(), req.params.mem, row.id, row.owner]);
        if (!note) return problem(req, res, 404, 'actor.agent.not_found', 'No such note.');
        res.json(note);
    });
    r.delete('/me/agents/:id/memory/:mem', principal.requireCapability('actor.agent.manage'), owner, limits.budget('actor.agent.manage'), async (req, res) => {
        const row = await loadAgent(req, res); if (!row) return;
        const note = personal.MEM_ID.test(req.params.mem) ? await s.db.maybe('DELETE FROM actor_agent_memory WHERE id = $1 AND agent_id = $2 AND owner = $3 RETURNING id', [req.params.mem, row.id, row.owner]) : null;
        if (!note) return problem(req, res, 404, 'actor.agent.not_found', 'No such note.');
        res.status(204).end();
    });
    r.delete('/me/agents/:id/memory', principal.requireCapability('actor.agent.manage'), owner, limits.budget('actor.agent.manage'), async (req, res) => {
        const row = await loadAgent(req, res); if (!row) return;
        await s.db.query('DELETE FROM actor_agent_memory WHERE agent_id = $1 AND owner = $2', [row.id, row.owner]);
        res.status(204).end();
    });

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
        const out = await createTask({ s, config, engine, webhooks, principal: req.principal, body: req.body || {} });
        if (out.code) {
            if (out.retryAfter) res.set('Retry-After', String(out.retryAfter));
            return problem(req, res, out.status, out.code, out.detail);
        }
        if (out.status === 201) res.set('Location', `/api/v1/tasks/${out.task.id}`);
        // The signing secret, to its creator only, in this answer (and an idempotent repeat of it) and never again.
        return res.status(out.status).json({ ...wire(out.task), ...(out.task.webhook_secret ? { webhook_secret: out.task.webhook_secret } : {}) });
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

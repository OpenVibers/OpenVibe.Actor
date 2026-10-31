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
 *   GET  /tasks/:id/events       actor.task.read             its live stream (actor.task-event@2, Last-Event-ID)
 *   GET  /tasks/:id/artifacts/:mediaId actor.task.read       one file or chart the task made, from Actor's own database
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
const { findArtifact, sendArtifact } = require('../runtime/artifacts');
const trace = require('../runtime/trace');
const personal = require('../agents/personal');
const memoryStore = require('../memory');
const approvals = require('../agents/approvals');
const items = require('../actions/items');

const TASK_ID = /^tsk_[0-9A-HJKMNP-TV-Z]{26}$/;
const USER_ID = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;

function createApi(ctx) {
    const { config, s, engine, stream, principal, limits, webhooks } = ctx;
    const r = asyncRouter();
    const problem = (req, res, status, code, detail, extra) => contracts.http.sendProblem(res, status, code, { detail, ctx: req.ov, extra });

    r.use(express.json({ limit: '64kb' }));
    r.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
    r.use(principal.middleware);

    // An Action Center read is a first-party service acting for one person, named in the query. A person's own token
    // never reaches another person's items through it.
    const isService = (p) => Boolean(p && p.kind === 'app' && p.claims && String(p.claims.sub || '').startsWith('svc:') && p.claims.actor_type === 'service');

    // ── The Action Center (plan 2026-10-28 §3.10) ────────────
    r.get('/actions', principal.requireCapability('actor.actions.read'), limits.reads('actor.actions.read'), async (req, res) => {
        if (!isService(req.principal)) return problem(req, res, 403, 'capability.denied', 'actor.actions.read is for first-party services');
        const subject = String(req.query.subject || '').trim();
        if (!USER_ID.test(subject)) return problem(req, res, 400, 'subject.invalid', 'subject must be a usr_… subject id');
        const requester = `user:${subject}`;
        const cutoff = new Date(s.now() - 30 * 86_400_000).toISOString();
        const rows = await s.db.many(`SELECT t.*, le.at AS last_at, le.body AS last_event,
                (SELECT count(*) FROM task_events e WHERE e.task_id = t.id AND e.body->>'step' = 'tool_call') AS tool_steps
            FROM tasks t
            LEFT JOIN LATERAL (SELECT body, body->>'at' AS at FROM task_events e WHERE e.task_id = t.id ORDER BY e.seq DESC LIMIT 1) le ON true
            WHERE t.requester = $1 AND (t.state = ANY($2) OR COALESCE(t.finished_at, t.created_at) >= $3)
            ORDER BY COALESCE(t.finished_at, le.at, t.created_at) DESC
            LIMIT 50`, [requester, store.OPEN, cutoff]);
        // The waits (plan A2): a task that waits shows the quiet line the person reads.
        const openWaits = ctx.waits ? await ctx.waits.listOpen() : [];
        const waitFor = new Map(openWaits.map((w) => [w.task_id, w]));
        const tasks = rows.map((row) => items.taskItem(row, {
            lastEvent: store.parseJson(row.last_event), steps: Number(row.tool_steps),
            wait: waitFor.get(row.id) || null, now: s.now,
        }));
        const asks = (await approvals.list(s, requester))
            .filter((a) => a.state === 'pending')
            .map(items.approvalItem);
        const scheduled = (await personal.list(s, requester))
            .filter((a) => a.status === 'active' && a.schedule !== 'off' && a.next_run_at)
            .map(items.scheduledItem);
        const all = [...tasks, ...asks, ...scheduled].sort((a, b) => (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : a.id < b.id ? 1 : -1));
        res.json({ items: all.slice(0, 50) });
    });

    // The same decision the person makes on /me/approvals, for the service acting from the Action Center. Deciding an
    // already-decided request answers its current state (idempotent), never a conflict.
    r.post('/approvals/:id/decide', principal.requireCapability('actor.approval.decide'), limits.budget('actor.approval.decide'), async (req, res) => {
        if (!isService(req.principal)) return problem(req, res, 403, 'capability.denied', 'actor.approval.decide is for first-party services');
        const subject = String(req.get('x-ov-subject') || '').trim();
        if (!USER_ID.test(subject)) return problem(req, res, 400, 'subject.invalid', 'X-OV-Subject must be the approval owner\'s usr_… subject id');
        const decision = String((req.body || {}).decision || '');
        if (!['approve', 'decline'].includes(decision)) return problem(req, res, 422, 'actor.approval.invalid', 'decision must be approve or decline');
        const out = await approvals.decide(ctx, `user:${subject}`, req.params.id, decision, { idempotent: true });
        if (out.error) return problem(req, res, out.status, out.status === 404 ? 'actor.approval.not_found' : 'actor.approval.invalid', out.error);
        res.json(items.approvalItem(out.row));
    });

    // ── The catalog and the dry run (public) ─────────────────
    r.get('/agents', limits.reads('actor.agent.read'), (req, res) => res.json(catalog.listResult(config, ctx.models)));

    // Live per-tool and per-model numbers (stage V2-10), public: names and numbers only, and only rows with n >= 20 so
    // no one person's use shows. The brain (V2-8) reads ctx.stats directly and is not held to that floor.
    r.get('/stats/tools', limits.reads('actor.stats.read'), async (_req, res) => res.json({ tools: await ctx.stats.publicTools() }));
    r.get('/stats/models', limits.reads('actor.stats.read'), async (_req, res) => res.json({ models: await ctx.stats.publicModels() }));

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
    // Suggestions the agent made for its instructions (agents/personal.js): list, then apply, dismiss or undo one.
    r.get('/me/agents/:id/suggestions', principal.requireCapability('actor.agent.manage'), owner, limits.reads('actor.agent.manage'), async (req, res) => {
        const row = await personal.get(s, req.principal.requester, req.params.id);
        if (!row) return problem(req, res, 404, 'actor.agent.not_found', 'No such agent.');
        res.json({ suggestions: await personal.proposals(s, row.owner, row.id) });
    });
    r.post('/me/agents/:id/suggestions/:pid/:action', principal.requireCapability('actor.agent.manage'), owner, limits.budget('actor.agent.manage'), async (req, res) => {
        const out = await personal.decide(s, req.principal.requester, req.params.id, req.params.pid, req.params.action);
        if (out.error) return problem(req, res, out.status, out.status === 404 ? 'actor.agent.not_found' : 'actor.agent.invalid', out.error);
        res.json({ suggestion: out.row, agent: out.agent });
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
        if (!memoryStore.MEM_ID.test(String(req.params.mem || ''))) return problem(req, res, 404, 'actor.agent.not_found', 'No such note.');
        const found = await s.db.maybe('SELECT id FROM actor_agent_memory WHERE id = $1 AND agent_id = $2 AND owner = $3', [req.params.mem, row.id, row.owner]);
        if (!found) return problem(req, res, 404, 'actor.agent.not_found', 'No such note.');
        const out = await memoryStore.edit(s, row.owner, found.id, { text: (req.body || {}).text });
        if (!out) return problem(req, res, 404, 'actor.agent.not_found', 'No such note.');
        if (out.error) return problem(req, res, 422, 'actor.agent.invalid', out.error);
        res.json(out.row);
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
    async function load(req, res, { delegated = false } = {}) {
        if (!TASK_ID.test(req.params.id)) { problem(req, res, 404, 'actor.task.not_found', 'No such task.'); return null; }
        const row = await store.getTask(s, req.params.id);
        // A service acting for the person (the Action Center's Cancel, plan A2) may reach that person's task:
        // the token carries the capability and the request names the person in X-OV-Subject.
        const mine = delegated
            ? row && req.principal && row.requester === req.principal.requester
            : owns(req.principal, row);
        if (!mine) { problem(req, res, 404, 'actor.task.not_found', 'No such task.'); return null; }
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
        if (!row) return;
        const out = wire(row);
        // Waiting for its person on its desk (Desks plan D4): what, and the link to the desk.
        const needs = await store.needsYou(s, row);
        if (needs) out.needs_you = needs;
        // The desk it works on now, to watch live and take over (Desks plan).
        const desk = await store.taskDesk(s, row);
        if (desk) out.desk = desk;
        res.json(out);
    });

    // The task's trace (stage V2-10): the numbers and names of its model, tool, check and delegate calls, to its own
    // people. Another person gets the same 404 as a task that does not exist.
    r.get('/tasks/:id/trace', principal.requireCapability('actor.task.read'), limits.reads('actor.task.read'), async (req, res) => {
        const row = await load(req, res);
        if (!row) return;
        const spans = await trace.spansFor(s, row.id);
        res.json({ task_id: row.id, spans, totals: trace.totals(spans) });
    });

    // A file or chart the task made (Actor v2, stage V2-4): the bytes are in Actor's own database, private to the
    // task's own people. The manifest of actor.task.read (Contracts 0.249.0) names this route, so it stays; the
    // person's own page opens the same bytes at /tasks/:id/files/:artifact, which is the link the task result and the
    // events carry. The parameter is called mediaId because the manifest says so; the id is an artifact id.
    r.get('/tasks/:id/artifacts/:mediaId', principal.requireCapability('actor.task.read'), limits.reads('actor.task.read'), async (req, res) => {
        const row = await load(req, res);
        if (!row) return;
        const found = await findArtifact(s.db, row.id, req.params.mediaId);
        if (!found) return problem(req, res, 404, 'actor.artifact.not_found', 'No such file on this task.');
        return sendArtifact(res, found);
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
        // The Action Center's Cancel comes from OpenVibe.Network acting for the person: the delegated case. Only
        // Network: any other first-party service acting for a person still cancels only the tasks it started itself
        // (owns(): the via check), so one service can never stop what another one asked for.
        const p = req.principal;
        const delegated = Boolean(p && p.kind === 'app' && p.via === 'service:network' && p.claims && String(p.requester || '').startsWith('user:'));
        const row = await load(req, res, { delegated });
        if (!row) return;
        const after = await engine.cancel(row.id, req.principal.requester);
        res.status(store.OPEN.includes(after.state) ? 202 : 200).json(wire(after));
    });

    return r;
}

module.exports = { createApi };

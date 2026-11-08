'use strict';

/**
 * /api/v1 — Actor's API (capabilities in openvibe-contracts manifests/capabilities/actor.*):
 *
 *   GET  /agents                 actor.agent.read (public)   no person: the agent systems, their rate cards and availability;
 *                                                           a signed-in person: their own contacts (actor.agent-list@1)
 *   GET  /agent-systems          actor.agent.read (public)   the agent systems even for a signed-in caller
 *   GET  /agents/presets         actor.agent.read (public)   the four presets a contact can copy
 *   POST /agents                 actor.agent.manage           create one of your contacts (optionally from a preset)
 *   GET  /agents/:id             actor.agent.manage           one contact (another person's is 404)
 *   PATCH/DELETE /agents/:id     actor.agent.manage           change it, or delete it (Vibe is 409 actor.agent.vibe)
 *   PUT  /agents/:id/level       actor.agent.manage           actor.level-change@1: set the approval level
 *   POST /route                  actor.agent.read (public)   which agent a task would go to, and why (nothing runs)
 *   POST /tasks                  actor.task.create           give Actor a task (actor.task-create-request@1 → platform.task@1;
 *                                                           with webhooks, the answer carries webhook_secret once)
 *   GET  /tasks                  actor.task.list             your tasks, newest first
 *   GET  /tasks/:id              actor.task.read             one task
 *   GET  /tasks/:id/events       actor.task.read             its live stream (actor.task-event@2, Last-Event-ID)
 *   GET  /tasks/:id/artifacts/:mediaId actor.task.read       one file or chart the task made, from Actor's own database
 *   POST /tasks/:id/cancel       actor.task.create           stop it
 *   GET  /assignments/:id        actor.assignment.read       one node of the delegated-work tree and its children
 *   POST /assignments/:id/cancel actor.assignment.cancel     cancel that node and every node below it
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
const contacts = require('../agents/contacts');
const voice = require('../agents/voice');
const memoryStore = require('../memory');
const approvals = require('../agents/approvals');
const items = require('../actions/items');
const timeline = require('../agents/timeline');
const assignments = require('../agents/assignments');
const modelPrefs = require('../runtime/model-prefs');
const driving = require('../agents/driving');
const canvases = require('../canvases');
const skills = require('../skills');

const TASK_ID = /^tsk_[0-9A-HJKMNP-TV-Z]{26}$/;
const USER_ID = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;

function createApi(ctx) {
    const { config, s, engine, stream, principal, limits, webhooks, triggers } = ctx;
    const r = asyncRouter();
    const problem = (req, res, status, code, detail, extra) => contracts.http.sendProblem(res, status, code, { detail, ctx: req.ov, extra });
    // A trigger belongs to the person in the request, and its Watch calls use that person's own token: the
    // Bearer the API was called with, or this site's session token. A service acting for a person is not it.
    const watchToken = (req) => {
        // Only a person's own credential: an app or a service acting for them (kind 'app') holds its own token,
        // and Watch must never see that token as the person's.
        if (!req.principal || req.principal.kind !== 'user') return null;
        const h = String(req.headers.authorization || '');
        if (h.startsWith('Bearer ')) return h.slice(7).trim();
        return req.token || (req.viewer && req.viewer.token) || null;
    };
    const triggerFail = (req, res, out) => problem(req, res, (out.error && out.error.status) || 502, (out.error && out.error.code) || 'actor.trigger.failed', (out.error && out.error.detail) || 'The trigger could not be saved.');
    const triggerOwner = (req) => String(req.principal.requester || '').replace(/^user:/, '');

    r.use(express.json({ limit: '64kb' }));
    r.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
    r.use(principal.middleware);
    r.use('/chat-apps', require('../chat-apps/routes').router(ctx));

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
        // A waiting approval reaches the Action Center as an item a person can read: the kind in plain words, the
        // agent's own name (never its id) and the thread it came from (plan HO1).
        const pending = (await approvals.list(s, requester)).filter((a) => a.state === 'pending');
        const agents = await s.db.many('SELECT id, name FROM actor_agents WHERE owner = $1', [requester]);
        const agentName = new Map(agents.map((a) => [a.id, a.name]));
        const threadIds = pending.map((a) => a.task_id).filter(Boolean);
        const threads = threadIds.length
            ? await s.db.many('SELECT id, task FROM tasks WHERE id = ANY($1)', [threadIds])
            : [];
        const threadTitle = new Map(threads.map((t) => [t.id, items.plain(t.task, 160)]));
        const asks = pending.map((a) => items.approvalItem(a, {
            agentName: a.agent_id ? agentName.get(a.agent_id) || null : null,
            thread: a.task_id ? threadTitle.get(a.task_id) || null : null,
        }));
        // A payment that was made (plan HO7): the person sees it in their Action Center, with what it paid and who
        // received it. Only a recorded payment becomes a done item; a refused one stays on its pending approval card.
        const paidRows = await s.db.many("SELECT approval_id FROM actor_spends WHERE owner = $1 AND state = 'paid' AND approval_id IS NOT NULL", [requester]);
        const paidIds = new Set(paidRows.map((r) => r.approval_id));
        const paidAsks = (await approvals.list(s, requester))
            .filter((a) => a.state === 'approved' && a.kind === 'money' && paidIds.has(a.id))
            .map((a) => items.approvalItem(a, {
                agentName: a.agent_id ? agentName.get(a.agent_id) || null : null,
                thread: a.task_id ? threadTitle.get(a.task_id) || null : null,
            }));
        const scheduled = (await personal.list(s, requester))
            .filter((a) => a.status === 'active' && a.schedule !== 'off' && a.next_run_at)
            .map(items.scheduledItem);
        const all = [...tasks, ...asks, ...paidAsks, ...scheduled].sort((a, b) => (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : a.id < b.id ? 1 : -1));
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
        const named = out.row && out.row.agent_id ? await s.db.maybe('SELECT name FROM actor_agents WHERE id = $1', [out.row.agent_id]) : null;
        res.json(items.approvalItem(out.row, { agentName: named ? named.name : null }));
    });

    // ── The catalog, the contacts and the dry run ────────────
    // GET /api/v1/agents is the public agent-system catalog for no one in particular. A signed-in person's GET is
    // their own contacts instead (actor.agent-list@1, Vibe first); the explicit /agent-systems path gives them the
    // public catalog too, so the old contract stays reachable for every caller.
    r.get('/agents', limits.reads('actor.agent.read'), async (req, res) => {
        if (req.principal && req.principal.kind === 'user' && req.principal.requester) {
            const rows = await contacts.list(s, config, req.principal.requester);
            return res.json({ agents: rows.map(contacts.wire) });
        }
        return res.json(catalog.listResult(config, ctx.models));
    });
    r.get('/agent-systems', limits.reads('actor.agent.read'), (req, res) => res.json(catalog.listResult(config, ctx.models)));
    // The four presets the UI can show; data only, no person's row.
    r.get('/agents/presets', limits.reads('actor.agent.read'), (_req, res) => res.json(contacts.presets()));

    // Live per-tool and per-model numbers (stage V2-10), public: names and numbers only, and only rows with n >= 20 so
    // no one person's use shows. The brain (V2-8) reads ctx.stats directly and is not held to that floor.
    r.get('/stats/tools', limits.reads('actor.stats.read'), async (_req, res) => res.json({ tools: await ctx.stats.publicTools() }));
    r.get('/stats/models', limits.reads('actor.stats.read'), async (_req, res) => res.json({ models: await ctx.stats.publicModels() }));

    // A person's own agents live under /me: /agents stays the public catalog of agent systems (actor.agent.read).
    r.get('/me/agents', principal.requireCapability('actor.agent.manage'), (req, res, next) => owner(req, res, next), limits.reads('actor.agent.manage'), async (req, res) => {
        res.json({ agents: await personal.list(s, req.principal.requester) });
    });

    // ── The skills registry (plan HO2, ADR-058) ───────────────────────────────────────────────────────────
    // The catalogue is public: a skill is a document anybody may read, and the listing says who published it, what
    // the scan found and whether the curator still offers it (actor.skill-listing@1).
    r.get('/skills', async (req, res) => {
        res.json({ listings: await skills.catalogue(s) });
    });
    r.get('/skills/:id', async (req, res) => {
        const listing = await skills.get(s, req.params.id);
        if (!listing) return problem(req, res, 404, 'actor.skill.not_found', 'No such skill.');
        res.json(listing);
    });

    const owner = (req, res, next) => {
        if (!req.principal.requester || !req.principal.requester.startsWith('user:')) return problem(req, res, 404, 'actor.agent.not_found', 'No such agent.');
        return next();
    };
    // Contacts are the person's own: a service or app acting for them is not the person choosing a face or a level.
    const personOnly = (req, res, next) => {
        const p = req.principal;
        if (!p || p.kind !== 'user' || !p.requester || !p.requester.startsWith('user:')) {
            return problem(req, res, 404, 'actor.agent.not_found', 'No such agent.');
        }
        return next();
    };

    // ── Agents as contacts (A-1) ─────────────────────────────
    // The person's own agents: list (Vibe first, created on this first read), read, create (optionally from a preset),
    // change, delete (Vibe refuses 409 actor.agent.vibe) and set the level (actor.level-change@1).
    r.post('/agents', principal.requireCapability('actor.agent.manage'), personOnly, limits.budget('actor.agent.manage'), async (req, res) => {
        const out = await contacts.create(s, config, req.principal.requester, req.body || {});
        if (!out.row) return problem(req, res, out.limit ? 429 : 422, out.limit ? 'actor.agent.limit' : 'actor.agent.invalid', out.error || 'Agent limit reached.');
        res.set('Location', `/api/v1/agents/${out.row.id}`);
        res.status(201).json(contacts.wire(out.row));
    });
    r.get('/agents/:id', principal.requireCapability('actor.agent.manage'), personOnly, limits.reads('actor.agent.manage'), async (req, res) => {
        const row = await contacts.get(s, req.principal.requester, req.params.id);
        if (!row) return problem(req, res, 404, 'actor.agent.not_found', 'No such agent.');
        res.json(contacts.wire(row));
    });
    r.patch('/agents/:id', principal.requireCapability('actor.agent.manage'), personOnly, limits.budget('actor.agent.manage'), async (req, res) => {
        const out = await contacts.update(s, config, req.principal.requester, req.params.id, req.body || {});
        if (!out) return problem(req, res, 404, 'actor.agent.not_found', 'No such agent.');
        if (!out.row) return problem(req, res, 422, 'actor.agent.invalid', out.error || 'Agent invalid.');
        res.json(contacts.wire(out.row));
    });
    r.delete('/agents/:id', principal.requireCapability('actor.agent.manage'), personOnly, limits.budget('actor.agent.manage'), async (req, res) => {
        const out = await contacts.remove(s, req.principal.requester, req.params.id);
        if (!out) return problem(req, res, 404, 'actor.agent.not_found', 'No such agent.');
        if (out.error) return problem(req, res, out.status || 409, out.code || 'actor.agent.vibe', out.error);
        res.status(204).end();
    });
    r.put('/agents/:id/level', principal.requireCapability('actor.agent.manage'), personOnly, limits.budget('actor.agent.manage'), async (req, res) => {
        const body = req.body || {};
        const v = contracts.validate('actor.level-change@1', body);
        if (!v.valid) return problem(req, res, 422, 'actor.agent.invalid', (v.errors || []).map((e) => `${e.path || e.instancePath || ''} ${e.message}`.trim()).join('; ').slice(0, 500));
        const out = await contacts.setLevel(s, config, req.principal.requester, req.params.id, body.level);
        if (!out) return problem(req, res, 404, 'actor.agent.not_found', 'No such agent.');
        if (!out.row) return problem(req, res, 422, 'actor.agent.invalid', out.error || 'Level invalid.');
        res.json(contacts.wire(out.row));
    });

    // ── The one timeline behind the Dock (design 2026-11-07) ──
    // The person's own steps, newest first, with the cursor and the mode and needs-you filters the Dock's chips use.
    // Another person's entry is the same 404 as one that does not exist: the list is scoped to the caller.
    r.get('/agent/timeline', principal.requireCapability('actor.timeline.read'), owner, limits.reads('actor.timeline.read'), async (req, res) => {
        const out = await timeline.list(s, req.principal.requester, {
            cursor: req.query.cursor ? String(req.query.cursor) : null,
            mode: req.query.mode ? String(req.query.mode) : null,
            needs_you: req.query.needs_you === '1' || req.query.needs_you === 'true',
            scope: req.query.scope === 'shared' ? 'shared' : 'mine',
        });
        res.json(out);
    });

    // One step of theirs: another person's step is the same 404 as one that does not exist.
    r.get('/agent/timeline/:id', principal.requireCapability('actor.timeline.read'), owner, limits.reads('actor.timeline.read'), async (req, res) => {
        const entry = await timeline.get(s, req.principal.requester, req.params.id);
        if (!entry) return problem(req, res, 404, 'agent.timeline.not_found', 'No such step.');
        res.json(entry);
    });

    // The live update stream: every new entry of the person's own timeline as it happens.
    r.get('/agent/timeline/stream', principal.requireCapability('actor.timeline.read'), owner, async (req, res) => {
        res.set('Content-Type', 'text/event-stream');
        res.set('Cache-Control', 'no-store');
        res.set('Connection', 'keep-alive');
        if (typeof res.flushHeaders === 'function') res.flushHeaders();
        const stop = timeline.subscribe(req.principal.requester, res);
        const beat = setInterval(() => { try { res.write(': beat\n\n'); } catch (err) { /* the reader is gone */ } }, 15000);
        if (beat.unref) beat.unref();
        req.on('close', () => { clearInterval(beat); stop(); });
        res.write('event: ready\ndata: {}\n\n');
    });

    // The approvals proxy: the person answers in the Dock, and the answer lands in the product that owns it
    // (Actor's own approvals here; another mode's own route there). The product is the one that decides.
    r.post('/agent/approvals/:product/:id/decide', principal.requireCapability('actor.approval.decide'), owner, limits.budget('actor.approval.decide'), async (req, res) => {
        const decision = String((req.body || {}).decision || '');
        if (!['approve', 'decline'].includes(decision)) return problem(req, res, 422, 'actor.approval.invalid', 'decision must be approve or decline');
        const product = String(req.params.product || '');
        const id = String(req.params.id || '');
        if (product === 'actor') {
            const decided = await approvals.decide(ctx, req.principal.requester, id, decision, { idempotent: true });
            if (decided.error) return problem(req, res, decided.status, decided.status === 404 ? 'actor.approval.not_found' : 'actor.approval.invalid', decided.error);
            return res.json({ product, id, state: decided.row.state });
        }
        const proxied = await timeline.proxyApproval(ctx, req, { product, id, decision });
        if (proxied.error) return problem(req, res, proxied.status || 502, proxied.code || 'actor.approval.proxy_failed', proxied.error);
        res.json({ product, id, state: proxied.state || decision });
    });

    // The kill switch: stop what the agent is doing and pause it until the person resumes it.
    r.post('/agent/kill-switch', principal.requireCapability('actor.resource.control'), owner, limits.budget('actor.resource.control'), async (req, res) => {
        const action = String((req.body || {}).action || 'stop');
        if (!['stop', 'resume'].includes(action)) return problem(req, res, 422, 'actor.agent.invalid', 'action must be stop or resume');
        const out = await timeline.killSwitch(ctx, req, action);
        res.json(out);
    });

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
    // The agent's voice as a file (actor.voice@1). Another person's agent is the same 404 as one that does not exist.
    r.get('/me/agents/:id/voice', principal.requireCapability('actor.agent.manage'), owner, limits.reads('actor.agent.manage'), async (req, res) => {
        const row = await loadAgent(req, res); if (!row) return;
        const subject = (req.principal && req.principal.subject) || String((req.principal && req.principal.requester) || '').replace(/^user:/, '');
        const doc = voice.build(row, { subject });
        res.set('Content-Disposition', 'attachment; filename="voice.json"');
        res.json(doc);
    });
    // Import a voice: an actor.voice@1 document becomes a new agent, at level ask whatever the file says.
    r.post('/me/agents/import', principal.requireCapability('actor.agent.manage'), owner, limits.budget('actor.agent.manage'), async (req, res) => {
        const body = req.body || {};
        const read = voice.read(body.voice || body.document || null);
        if (read.error) return problem(req, res, 422, 'actor.voice.invalid', read.error);
        const fields = voice.toContact(read.doc, { source: 'file' });
        const out = await contacts.create(s, config, req.principal.requester, {
            name: fields.name, face: fields.face, model: fields.model, apps: fields.apps, memory: null,
            level: fields.level, instructions: fields.instructions,
        }, { bio: fields.bio, rules: fields.rules, suggested_apps: fields.suggested_apps, voice_author: fields.voice_author, voice_author_name: fields.voice_author_name,
            voice_author_checked: fields.voice_author_checked, voice_source: fields.voice_source });
        if (!out.row) return failed(req, res, out);
        res.set('Location', `/api/v1/me/agents/${out.row.id}`);
        res.status(201).json(out.row);
    });
    r.patch('/me/agents/:id', principal.requireCapability('actor.agent.manage'), owner, limits.budget('actor.agent.manage'), async (req, res) => {
        const out = await personal.update(s, config, req.principal.requester, req.params.id, req.body);
        if (!out) return problem(req, res, 404, 'actor.agent.not_found', 'No such agent.');
        if (!out.row) return failed(req, res, out);
        res.json(out.row);
    });
    r.delete('/me/agents/:id', principal.requireCapability('actor.agent.manage'), owner, limits.budget('actor.agent.manage'), async (req, res) => {
        const row = await loadAgent(req, res); if (!row) return;
        if (row.is_vibe) return problem(req, res, 409, 'actor.agent.vibe', 'Vibe is your first agent and cannot be deleted.');
        await s.db.query('DELETE FROM actor_agents WHERE id = $1 AND owner = $2', [row.id, row.owner]);
        res.status(204).end();
    });
    // The skills of one agent (plan HO2): install a skill on it, or take it back. Installing grants nothing — the
    // agent's level and its approvals still decide every step. A flagged skill needs the person to say they read
    // the findings; a failed one never installs.
    r.post('/me/agents/:id/skills', principal.requireCapability('actor.agent.manage'), owner, limits.budget('actor.agent.manage'), async (req, res) => {
        const row = await loadAgent(req, res); if (!row) return;
        const body = req.body || {};
        const listing = await skills.rowOf(s, String(body.listing_id || body.slug || ''));
        if (!listing) return problem(req, res, 404, 'actor.skill.not_found', 'No such skill.');
        const read = body.read_findings === true || body.read_findings === '1' || body.read_findings === 'true';
        const out = await skills.install(s, { owner: req.principal.requester, agentId: row.id, listing, readFindings: read });
        if (out.error) return problem(req, res, out.status || 422, out.code === 'failed' ? 'actor.skill.failed' : 'actor.skill.invalid', out.error);
        res.set('Location', `/api/v1/me/agents/${row.id}/skills/${out.listing.id}`);
        res.status(201).json({ install: out.row, listing: out.listing });
    });
    r.delete('/me/agents/:id/skills/:listingId', principal.requireCapability('actor.agent.manage'), owner, limits.budget('actor.agent.manage'), async (req, res) => {
        const row = await loadAgent(req, res); if (!row) return;
        const out = await skills.remove(s, { owner: req.principal.requester, agentId: row.id, listingId: req.params.listingId });
        if (out.error) return problem(req, res, out.status || 404, 'actor.skill.not_found', out.error);
        res.status(204).end();
    });
    r.post('/me/agents/:id/run', principal.requireCapability('actor.agent.run'), owner, limits.budget('actor.agent.run'), async (req, res) => {
        const row = await loadAgent(req, res); if (!row) return;
        const body = req.body || {};
        // Watch wakes an agent when a trigger fires. That run is origin routine and inherits the trigger's own level,
        // never more: the trigger was made in a person's thread at that thread's level. A person pressing Run now on
        // the agent page is still origin person.
        const viaWatch = Boolean(req.principal && req.principal.kind === 'app' && req.principal.via === 'service:watch');
        const trigger = viaWatch && triggers
            ? await triggers.forDelivery(row.owner, { triggerId: body.trigger_id, watchId: body.watch_id })
            : null;
        if (trigger && trigger.state === 'paused') return problem(req, res, 409, 'actor.trigger.paused', 'This trigger is paused, so nothing ran. Resume it on its card.');
        if (trigger && trigger.state === 'done') return problem(req, res, 409, 'actor.trigger.done', 'This goal is done, so nothing ran.');
        const out = await personal.run(ctx, row, body.input || '', {
            origin: viaWatch ? 'routine' : 'person',
            level: trigger ? trigger.level : null,
            triggerId: trigger ? trigger.id : null,
            goal: trigger ? trigger.goal : null,
        });
        if (out.code) return problem(req, res, out.status, out.code, out.detail);
        res.set('Location', `/api/v1/tasks/${out.task.id}`);
        res.status(201).json(await wireTask(out.task));
    });
    r.get('/me/agents/:id/runs', principal.requireCapability('actor.agent.run'), owner, limits.reads('actor.agent.run'), async (req, res) => {
        const row = await loadAgent(req, res); if (!row) return;
        const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
        const before = TASK_ID.test(req.query.before || '') ? req.query.before : null;
        const page = await store.listTasks(s, row.owner, { limit, before, via: `agent:${row.id}` });
        res.json({ tasks: await Promise.all(page.rows.map(wireTask)), next: page.next });
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

    // The model choice is the person's own too, with its own 404 code.
    const modelOnly = (req, res, next) => {
        const p = req.principal;
        if (!p || p.kind !== 'user' || !p.requester || !p.requester.startsWith('user:')) {
            return problem(req, res, 404, 'actor.model.not_found', 'No such setting.');
        }
        return next();
    };

    // ── The person's model choice (plan L55 C3) ─────────────────────────────────
    // Which model their tasks run on: 'auto' (Actor decides, as today), 'openvibe' (OpenVibe's own keys, through
    // OpenVibe.AI) or 'own:<provider>' (their OWN key for that provider, sealed in OpenVibe.AI's vault — a key never
    // reaches Actor, and Actor never stores one).
    //
    // The person's own session or token, never a service: what a person spends their own key on is theirs to choose.
    // (A service token may read it — it must know which provider to ask for — but not change it.)
    r.get('/me/model', principal.requireCapability('actor.model.manage'), modelOnly, limits.reads('actor.model.manage'), async (req, res) => {
        const row = await modelPrefs.get(s, req.principal.requester);
        // The providers the person allowed THIS service to use their own key for, and that they hold a key for:
        // names only, never key material. Null when OpenVibe.AI does not say (the person allowed us nothing yet).
        const subject = String(req.principal.requester || '').replace(/^user:/, '');
        const keys = ctx.models && typeof ctx.models.allowedKeys === 'function' ? await ctx.models.allowedKeys(subject) : null;
        res.json({ ...modelPrefs.wire(row), keys });
    });

    r.put('/me/model', principal.requireCapability('actor.model.manage'), modelOnly, limits.budget('actor.model.manage'), async (req, res) => {
        const body = req.body || {};
        // Where it runs (plan L55 C3) may come alone or with the model choice.
        if (body.runs_on !== undefined) {
            const r = await modelPrefs.setRunsOn(s, req.principal.requester, body.runs_on);
            if (r.error) return problem(req, res, 422, 'actor.model.invalid', r.error);
            if (body.choice === undefined && body.model === undefined) return res.json({ ...modelPrefs.wire(await modelPrefs.get(s, req.principal.requester)), keys: null });
        }
        const out = await modelPrefs.put(s, req.principal.requester, body, { exactIds: Boolean(config.ai && config.ai.catalog) });
        if (out.error) return problem(req, res, 422, 'actor.model.invalid', out.error);
        res.json({ ...modelPrefs.wire(out.row), keys: null });
    });
    r.post('/route', limits.budget('actor.route'), (req, res) => {
        const b = req.body || {};
        if (typeof b.task !== 'string' || !b.task.trim() || b.task.length > 20000) return problem(req, res, 422, 'actor.task.invalid', 'task: the instruction in plain words (1 to 20000 characters)');
        const mode = b.mode == null ? 'balanced' : b.mode;
        if (!MODES.includes(mode)) return problem(req, res, 422, 'actor.mode.invalid', `mode: one of ${MODES.join(', ')}`);
        if (b.agent != null && !catalog.byId(b.agent)) return problem(req, res, 422, 'actor.agent.unknown', `no agent "${String(b.agent).slice(0, 64)}"; GET /api/v1/agent-systems lists them`);
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
    // A task is a thread (A-1): add the contact it runs as, that contact's level and the effective level (the higher
    // of the agent's and the person's own parent chain). Without a contact (a service or project task) they are absent.
    const wireTask = async (row) => {
        const out = wire(row);
        let agent = null;
        try { agent = await contacts.agentForTask(s, config, row); } catch (err) { agent = null; }
        if (agent) {
            out.agent_id = agent.id;
            out.agent_level = agent.level || 'ask';
        } else if (row.agent_id) {
            out.agent_id = row.agent_id;
        }
        out.level = row.level || 'ask';
        try { out.effective_level = await contacts.effectiveLevelFor(s, row, agent); } catch (err) { out.effective_level = out.level; }
        // An existing task gets its assignment root the first time it is read (plan §12 A-2), never by a backfill.
        try { await assignments.ensureForTask(s, config, row); } catch (err) { /* the task still reads */ }
        return out;
    };

    r.post('/tasks', principal.requireCapability('actor.task.create'), limits.budget('actor.task.create'), async (req, res) => {
        const out = await createTask({ s, config, engine, webhooks, principal: req.principal, body: req.body || {}, personToken: watchToken(req), timezone: req.cookies && req.cookies.ov_tz ? String(req.cookies.ov_tz).slice(0, 64) : null });
        if (out.code) {
            if (out.retryAfter) res.set('Retry-After', String(out.retryAfter));
            return problem(req, res, out.status, out.code, out.detail);
        }
        if (out.status === 201) res.set('Location', `/api/v1/tasks/${out.task.id}`);
        // The signing secret, to its creator only, in this answer (and an idempotent repeat of it) and never again.
        return res.status(out.status).json({ ...(await wireTask(out.task)), ...(out.task.webhook_secret ? { webhook_secret: out.task.webhook_secret } : {}) });
    });

    r.get('/tasks', principal.requireCapability('actor.task.list'), limits.reads('actor.task.list'), async (req, res) => {
        const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
        const before = typeof req.query.before === 'string' && TASK_ID.test(req.query.before) ? req.query.before : null;
        const page = await store.listTasks(s, req.principal.requester, { limit, before, via: req.principal.via || null });
        res.json({ tasks: await Promise.all(page.rows.map(wireTask)), next: page.next });
    });

    r.get('/tasks/:id', principal.requireCapability('actor.task.read'), limits.reads('actor.task.read'), async (req, res) => {
        const row = await load(req, res);
        if (!row) return;
        const out = await wireTask(row);
        // Waiting for its person on its desk (Desks plan D4): what, and the link to the desk.
        const needs = await store.needsYou(s, row);
        if (needs) out.needs_you = needs;
        // The desk it works on now, to watch live and take over (Desks plan).
        const desk = await store.taskDesk(s, row);
        if (desk) out.desk = desk;
        // The Computer it opened (plan 2026-11-07: one id across Surf, the Dock and Actor), read from its own steps.
        const computer = await store.taskComputer(s, row);
        if (computer) out.computer = { ...computer, driving: driving.is(row.id, s.now()) };
        res.json(out);
    });

    // Take over / Give it back (plan 2026-11-07), built on the hand_to_person machinery: the person drives the desk
    // they were handed, the agent's input is refused while they do, and the task's timeline gets one hand-off step.
    // Only the task's own people (load()), and only while it runs on a Computer.
    async function handoff(req, res, { take }) {
        const row = await load(req, res);
        if (!row) return;
        if (!store.OPEN.includes(row.state)) return problem(req, res, 409, 'actor.task.ended', 'This task has ended: its Computer is gone.');
        const computer = await store.taskComputer(s, row);
        const desk = await store.taskDesk(s, row);
        if (!computer && !desk) return problem(req, res, 409, 'actor.task.no_computer', 'This task has no Computer to hand over.');
        if (!String(row.requester).startsWith('user:')) return problem(req, res, 409, 'actor.task.no_person', 'A Computer is a person\'s: sign in as the task\'s own person to take it.');
        const at = s.iso();
        const now = take ? (driving.take(row.id, s.now()), true) : (driving.give(row.id), false);
        // The step in the task's own timeline (the same events /events streams), carrying the Computer.
        const event = await store.appendEvent(s, row.id, {
            at, kind: 'output', step: 'handoff',
            text: now ? 'You took over the desk. The agent waits until you give it back.' : 'You gave the desk back. The agent goes on.',
            ...(computer ? { computer } : {}),
        });
        stream.publish(row.id, event);
        // And one step in the one timeline behind the Dock (agent.timeline-entry@1), the same Computer.
        try {
            await timeline.upsert(s, row.requester, {
                step_id: `${row.id}:takeover`, mode: 'browse', product: 'actor', ref: row.id,
                title: now ? 'You took over the desk' : 'You gave the desk back',
                status: now ? 'running' : 'done', started_at: now ? at : undefined, ended_at: now ? null : at,
                placement: computer ? { where: computer.machine, why: now ? 'you are driving the desk' : 'the agent goes on' } : null,
                link: `${config.baseUrl}/tasks/${row.id}`, ...(computer ? { computer } : {}),
            });
        } catch (err) { /* the task's own timeline above is the source of truth */ }
        const out = await wireTask(row);
        if (computer) out.computer = { ...computer, driving: Boolean(now) };
        if (desk) out.desk = desk;
        res.json(out);
    }
    r.post('/tasks/:id/takeover', principal.requireCapability('actor.task.create'), async (req, res) => handoff(req, res, { take: true }));
    r.post('/tasks/:id/giveback', principal.requireCapability('actor.task.create'), async (req, res) => handoff(req, res, { take: false }));

    // The Computer's newest frame, fetched from the session's own service (Run) as Actor, acting for the task's
    // person: the person's own token would have to cross an origin, and the picture is theirs. Owner/project only
    // (load()); a task with no Run session has no picture, and neither has anyone asking for another person's task.
    // A still is its task's person's, and nobody else's: a signed-out visitor and an app token get the same 404 as a
    // task that does not exist (never a 401 that would confirm one).
    const stillPerson = (req, res, next) => ((req.principal && req.principal.kind === 'user') ? next() : problem(req, res, 404, 'actor.task.not_found', 'No such task.'));
    r.get('/tasks/:id/still', stillPerson, principal.requireCapability('actor.task.read'), limits.reads('actor.task.read'), async (req, res) => {
        const row = await load(req, res);
        if (!row) return;
        const computer = await store.taskComputer(s, row);
        if (!computer || !computer.session_id) return problem(req, res, 404, 'actor.task.no_still', 'This task has no Computer picture.');
        if (!String(row.requester).startsWith('user:')) return problem(req, res, 404, 'actor.task.no_still', 'This task has no Computer picture.');
        const shot = await ctx.computers.still(row.requester.slice(5), computer.session_id);
        if (!shot || shot.error) return problem(req, res, shot && shot.status === 404 ? 404 : 502, (shot && shot.code) || 'actor.task.no_still', (shot && shot.error) || 'No picture.');
        // Only a picture: a broken or hostile upstream can never serve HTML from openvibe.actor.
        if (!['image/jpeg', 'image/png', 'image/webp'].includes(shot.type)) return problem(req, res, 502, 'still.bad_type', 'The session sent something that is not an image.');
        res.set('Cache-Control', 'private, no-store');
        res.set('X-Content-Type-Options', 'nosniff');
        res.set('Content-Type', shot.type);
        res.set('Content-Length', String(shot.bytes.length));
        return res.status(200).end(shot.bytes);
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
            // The answer as it is written (plan L55 C2), for a reader that asks: transient delta events.
            deltas: req.query.deltas === '1',
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
        res.status(store.OPEN.includes(after.state) ? 202 : 200).json(await wireTask(after));
    });


    // ── The assignment tree (plan §12 A-2) ───────────────────
    // One record for all delegated work. Both routes are owner-only: another person's node is the same 404 as one
    // that does not exist. A cancel cascades down the tree and stops the tasks still running under it.
    r.get('/assignments/:id', principal.requireCapability('actor.assignment.read'), limits.reads('actor.assignment.read'), async (req, res) => {
        const p = req.principal;
        if (!p.requester || !p.requester.startsWith('user:')) return problem(req, res, 404, 'actor.assignment.not_found', 'No such assignment.');
        const out = await assignments.tree(s, p.requester, req.params.id);
        if (!out) return problem(req, res, 404, 'actor.assignment.not_found', 'No such assignment.');
        res.json(out);
    });
    r.post('/assignments/:id/cancel', principal.requireCapability('actor.assignment.cancel'), limits.budget('actor.assignment.cancel'), async (req, res) => {
        const p = req.principal;
        if (!p.requester || !p.requester.startsWith('user:')) return problem(req, res, 404, 'actor.assignment.not_found', 'No such assignment.');
        const out = await assignments.cancelTree(s, p.requester, req.params.id);
        if (!out) return problem(req, res, 404, 'actor.assignment.not_found', 'No such assignment.');
        const { task_ids: taskIds, ...result } = out;
        for (const taskId of taskIds) await engine.cancel(taskId, p.requester);
        res.json(result);
    });

    // ── An agent's live panel (plan HO9, actor.canvas@1) ─────
    // The person's own canvas for one conversation. Reading is actor.task.read; drawing or ticking is the person's
    // action in their thread, so it takes actor.task.create. Another person's canvas is the same 404 as one that does
    // not exist. A page may post a plain form (same-origin); JSON callers get JSON.
    const canvasWantsJson = (req) => String(req.get('accept') || '').includes('application/json') || String(req.get('content-type') || '').includes('application/json');
    r.get('/me/canvases', principal.requireCapability('actor.task.read'), limits.reads('actor.task.read'), personOnly, async (req, res) => {
        const requester = req.principal.requester;
        if (req.query.thread != null) {
            const thread = String(req.query.thread);
            if (!TASK_ID.test(thread)) return problem(req, res, 400, 'actor.canvas.invalid', 'thread must be a tsk_… conversation id.');
            const row = await canvases.forThread(s, thread);
            return res.json({ canvases: row && row.owner === requester ? [canvases.docOf(row)] : [] });
        }
        const rows = await canvases.list(s, requester);
        res.json({ canvases: rows.map(canvases.docOf) });
    });
    r.get('/me/canvases/:id', principal.requireCapability('actor.task.read'), limits.reads('actor.task.read'), personOnly, async (req, res) => {
        const row = await canvases.get(s, req.principal.requester, req.params.id);
        if (!row) return problem(req, res, 404, 'actor.canvas.not_found', 'No such canvas.');
        res.json(canvases.docOf(row));
    });
    // A canvas never acts. "ask" is the button's label, posted as the person's own message: a normal turn from the
    // newest turn of the conversation, with the agent's level and approvals exactly as typing it would. "check" is
    // the person's own tick: the document's item flips, its version grows, and the next turn is told which item.
    r.post('/me/canvases/:id/events', principal.requireCapability('actor.task.create'), limits.budget('actor.task.create'), personOnly,
        express.urlencoded({ extended: false, limit: '4kb' }), async (req, res) => {
            const wantsJson = canvasWantsJson(req);
            const row = await canvases.get(s, req.principal.requester, req.params.id);
            if (!row) return wantsJson ? problem(req, res, 404, 'actor.canvas.not_found', 'No such canvas.') : res.status(404).type('text/plain').send('No such canvas.');
            const body = req.body || {};
            const kind = String(body.kind || '');
            if (kind === 'ask') {
                const label = String(body.label == null ? '' : body.label).trim().slice(0, 2000);
                if (!label) return wantsJson ? problem(req, res, 422, 'actor.canvas.invalid', 'A button needs a label to send.') : res.status(422).type('text/plain').send('A button needs a label to send.');
                const latest = await canvases.latestForThread(s, row.thread);
                if (!latest) return wantsJson ? problem(req, res, 409, 'actor.canvas.invalid', 'That conversation is not here any more.') : res.status(409).type('text/plain').send('That conversation is not here any more.');
                if (store.OPEN.includes(latest.state) || latest.state === 'needs_you') {
                    return wantsJson ? problem(req, res, 409, 'actor.canvas.invalid', 'Actor is still working on the last message. Wait for it, or stop it.') : res.status(409).type('text/plain').send('Actor is still working on the last message.');
                }
                const out = await createTask({
                    s, config, engine, principal: { requester: req.principal.requester, project: null },
                    body: { task: label, mode: latest.mode }, parentId: latest.id,
                    personToken: watchToken(req), timezone: req.cookies && req.cookies.ov_tz ? String(req.cookies.ov_tz).slice(0, 64) : null,
                });
                if (out.code) {
                    if (!wantsJson) return res.status(out.status === 503 || out.status === 429 ? out.status : 422).type('text/plain').send(out.detail || 'That could not start.');
                    return problem(req, res, out.status === 503 || out.status === 429 ? out.status : 422, out.code, out.detail || 'That could not start.');
                }
                const made = await store.getTask(s, out.task.id);
                if (!wantsJson) return res.redirect(303, `/chat/${made.id}#t-${made.id}`);
                return res.status(201).json({ ok: true, task: { id: made.id, url: `/chat/${made.id}` } });
            }
            if (kind === 'check') {
                const done = body.done === true || body.done === 'true' || body.done === '1' || body.done === 'on';
                const out = await canvases.check(s, req.principal.requester, row.id, { blockId: body.block_id, itemId: body.item_id, done });
                if (out.error) {
                    return wantsJson ? problem(req, res, out.error.status || 422, 'actor.canvas.invalid', out.error.detail) : res.status(out.error.status || 422).type('text/plain').send(out.error.detail);
                }
                if (!wantsJson) return res.redirect(303, `/chat/${row.thread}`);
                return res.json({ ok: true, canvas: out.doc });
            }
            return wantsJson
                ? problem(req, res, 422, 'actor.canvas.invalid', 'kind must be "ask" (a button label) or "check" (block_id, item_id, done).')
                : res.status(422).type('text/plain').send('kind must be "ask" or "check".');
        });

    // ── Triggers made in a conversation (plan §12 A-4) ───────
    // The Watch subscription is the runner; these routes are the card's own moves. Everything is the person's:
    // another person's trigger is the same 404 as one that does not exist, and Watch receives their own token.
    r.get('/triggers', principal.requireCapability('actor.task.read'), limits.reads('actor.task.read'), personOnly, async (req, res) => {
        res.json({ triggers: await triggers.list(triggerOwner(req)) });
    });
    r.get('/triggers/:id', principal.requireCapability('actor.task.read'), limits.reads('actor.task.read'), personOnly, async (req, res) => {
        const card = await triggers.get(triggerOwner(req), req.params.id, { token: watchToken(req), live: true });
        if (!card) return problem(req, res, 404, 'actor.trigger.not_found', 'No such trigger.');
        res.json({ trigger: card });
    });
    r.post('/triggers', principal.requireCapability('actor.task.create'), limits.budget('actor.task.create'), personOnly, async (req, res) => {
        const b = req.body || {};
        const out = await triggers.create({
            owner: triggerOwner(req), agentId: b.agent_id, task: b.task, kind: b.kind,
            cron: b.cron, timezone: b.timezone, event: b.event, goal: b.goal,
            level: 'ask', turnTaskId: TASK_ID.test(String(b.turn_task_id || '')) ? b.turn_task_id : null,
            personToken: watchToken(req),
            answerInChat: b.answer_in_chat !== false, notify: b.notify === true,
        });
        if (out.error) return triggerFail(req, res, out);
        res.status(201).json({ trigger: out.trigger });
    });
    r.patch('/triggers/:id', principal.requireCapability('actor.task.create'), limits.budget('actor.task.create'), personOnly, async (req, res) => {
        const out = await triggers.edit(triggerOwner(req), req.params.id, req.body || {}, { token: watchToken(req) });
        if (out.error) return triggerFail(req, res, out);
        res.json({ trigger: out.trigger });
    });
    r.post('/triggers/:id/pause', principal.requireCapability('actor.task.create'), limits.budget('actor.task.create'), personOnly, async (req, res) => {
        const out = await triggers.pause(triggerOwner(req), req.params.id, { token: watchToken(req) });
        if (out.error) return triggerFail(req, res, out);
        res.json({ trigger: out.trigger });
    });
    r.post('/triggers/:id/resume', principal.requireCapability('actor.task.create'), limits.budget('actor.task.create'), personOnly, async (req, res) => {
        const out = await triggers.resume(triggerOwner(req), req.params.id, { token: watchToken(req) });
        if (out.error) return triggerFail(req, res, out);
        res.json({ trigger: out.trigger });
    });
    r.post('/triggers/:id/run', principal.requireCapability('actor.task.create'), limits.budget('actor.task.create'), personOnly, async (req, res) => {
        const out = await triggers.runNow(triggerOwner(req), req.params.id);
        if (out.error) return triggerFail(req, res, out);
        res.status(201).json({ task: out.task, trigger: out.trigger });
    });
    r.delete('/triggers/:id', principal.requireCapability('actor.task.create'), limits.budget('actor.task.create'), personOnly, async (req, res) => {
        const undo = String(req.query.undo || '') === '1' || (req.body && req.body.undo === true);
        const confirm = String(req.query.confirm || '') === 'delete' || (req.body && req.body.confirm === 'delete');
        const out = undo
            ? await triggers.undo(triggerOwner(req), req.params.id, { token: watchToken(req) })
            : await triggers.remove(triggerOwner(req), req.params.id, { token: watchToken(req), confirm });
        if (out.error) return triggerFail(req, res, out);
        res.status(200).json(out);
    });

    return r;
}

module.exports = { createApi };

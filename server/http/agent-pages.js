'use strict';

const express = require('express');
const { asyncRouter } = require('./router');
const { sameOrigin } = require('./principal');
const { html, raw, time } = require('../render/html');
const { send } = require('../render/layout');
const personal = require('../agents/personal');
const approvals = require('../agents/approvals');

function createAgentPages(ctx) {
    const { config, s } = ctx;
    const r = asyncRouter();
    r.use(express.urlencoded({ extended: false, limit: '64kb' }));
    const signed = (req) => req.viewer && req.viewer.kind === 'user' && req.viewer.subject;
    const owner = (req) => `user:${req.viewer.subject}`;
    const page = (req, res, title, body, status = 200) => send(res, status, { viewer: req.viewer, config, path: req.originalUrl, title, body, css: ['css/agents.css'] });
    const login = (req, res) => res.redirect(303, `/auth/login?next=${encodeURIComponent(req.originalUrl)}`);
    const write = (req, res) => {
        if (!signed(req)) { login(req, res); return false; }
        if (!sameOrigin(req, config.baseUrl)) { res.status(403).type('text/plain').send('A change must come from openvibe.actor itself.'); return false; }
        return true;
    };
    const find = async (req, res) => {
        const a = await personal.get(s, owner(req), req.params.id);
        if (!a) page(req, res, 'Agent not found', html`<h1>Agent not found</h1>`, 404);
        return a;
    };
    const MODE_LABELS = { balanced: 'Balanced (default)', cheapest: 'Cheapest', best: 'Best', fastest: 'Fastest', private: 'Private' };
    const SCHEDULE_LABELS = { off: 'Only when I run it', hourly: 'Every hour', daily: 'Every day', weekly: 'Every week' };
    const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    function form(a = {}) {
        return html`<div class="pa-form">
<label class="pa-wide">Name <input name="name" maxlength="60" required value="${a.name || ''}" placeholder="Morning briefing"></label>
<label class="pa-wide">Instructions <span class="pa-hint">What it should do every run, in plain words. Up to 4000 characters.</span>
<textarea name="instructions" maxlength="4000" required rows="6" placeholder="Read the OpenVibe changelog and summarise what shipped yesterday in five bullets.">${a.instructions || ''}</textarea></label>
<label>Mode <select name="mode">${['balanced', 'cheapest', 'best', 'fastest', 'private'].map((x) => html`<option value="${x}"${a.mode === x ? raw(' selected') : ''}>${MODE_LABELS[x]}</option>`)}</select></label>
<label>Budget per run (USD) <input name="budget_per_run_usd" type="number" min="0.001" max="${config.allowance.perTaskUsd}" step="0.001" value="${a.budget_per_run_usd || config.allowance.perTaskUsd}"><span class="pa-hint">At most $${config.allowance.perTaskUsd} on the free tier.</span></label>
<label>Runs a day, at most <input name="daily_runs_max" type="number" min="1" max="24" value="${a.daily_runs_max || 1}"></label>
<label>Schedule <select name="schedule">${personal.SCHEDULES.map((x) => html`<option value="${x}"${(a.schedule || 'off') === x ? raw(' selected') : ''}>${SCHEDULE_LABELS[x]}</option>`)}</select></label>
<label>At (UTC) <input name="schedule_at" type="time" value="${a.schedule_at || ''}"><span class="pa-hint">For daily and weekly.</span></label>
<label>On <select name="schedule_dow"><option value=""${a.schedule_dow == null ? raw(' selected') : ''}>Any day</option>${DAYS.map((d, i) => html`<option value="${String(i)}"${a.schedule_dow === i ? raw(' selected') : ''}>${d}</option>`)}</select><span class="pa-hint">For weekly.</span></label>
<label>Status <select name="status"><option value="active"${a.status !== 'paused' ? raw(' selected') : ''}>Active</option><option value="paused"${a.status === 'paused' ? raw(' selected') : ''}>Paused</option></select></label>
</div>`;
    }
    const when = (a) => a.schedule === 'off' ? 'Runs when you run it' : a.schedule === 'hourly' ? 'Every hour'
        : a.schedule === 'daily' ? `Every day at ${a.schedule_at} UTC` : `Every ${DAYS[a.schedule_dow]} at ${a.schedule_at} UTC`;
    function fields(body) {
        return { name: body.name, instructions: body.instructions, mode: body.mode,
            budget_per_run_usd: Number(body.budget_per_run_usd), daily_runs_max: Number(body.daily_runs_max), schedule: body.schedule,
            schedule_at: body.schedule_at || null, schedule_dow: body.schedule_dow === '' ? null : Number(body.schedule_dow), status: body.status };
    }

    r.get('/me/agents', async (req, res) => {
        if (!signed(req)) return login(req, res);
        const agents = await personal.list(s, owner(req));
        const waiting = await approvals.pendingCount(s, owner(req));
        page(req, res, 'Your agents', html`<header class="pa-head"><p class="pa-eyebrow">OpenVibe.Actor · personal agents · alpha</p><h1>Your agents</h1>
<p class="pa-lede">An agent is a task you set up once: standing instructions, a memory you can read and edit, and a schedule. Every run is an ordinary Actor task, with the same routing, checks, costs and limits.</p>
<p><a href="/me/approvals">Approvals${waiting ? html` <span class="pill pill-running">${String(waiting)} waiting</span>` : ''}</a> · what your agents asked to do while you were away.</p></header>
${agents.length ? html`<ul class="pa-cards">${agents.map((a) => html`<li class="pa-card"><a href="/me/agents/${a.id}"><strong>${a.name}</strong></a>
<span class="pill ${a.status === 'paused' ? 'pill-failed' : 'pill-succeeded'}">${a.status === 'paused' ? 'Paused' : 'Active'}</span>
<span class="pa-when">${when(a)}</span>${a.last_run_at ? html`<span class="pa-when">Last run ${time(a.last_run_at)}</span>` : ''}</li>`)}</ul>`
        : html`<p class="pa-empty">No agent yet. Create your first one below.</p>`}
<section class="pa-panel"><h2>Create an agent</h2><form method="post" action="/me/agents">${form()}<button type="submit" class="pa-btn pa-primary">Create agent</button></form></section>`);
    });
    r.post('/me/agents', async (req, res) => {
        if (!write(req, res)) return;
        const out = await personal.create(s, config, owner(req), fields(req.body));
        if (!out.row) return page(req, res, 'Create agent', html`<h1>Create agent</h1><p>${out.error || 'Agent limit reached.'}</p><form method="post" action="/me/agents">${form(req.body)}<button type="submit">Create</button></form>`, out.limit ? 429 : 422);
        res.redirect(303, `/me/agents/${out.row.id}`);
    });
    // The approval inbox (agents/approvals.js): what an agent asked to do while its owner was away.
    const APPROVAL_STATE = { pending: ['Waiting for you', 'pill-running'], approved: ['Approved', 'pill-succeeded'], declined: ['Declined', 'pill-failed'], expired: ['Expired', 'pill-failed'] };
    const approvalPill = (a) => html`<span class="pill ${APPROVAL_STATE[a.state][1]}">${APPROVAL_STATE[a.state][0]}</span>`;
    r.get('/me/approvals', async (req, res) => {
        if (!signed(req)) return login(req, res);
        const rows = await approvals.list(s, owner(req));
        page(req, res, 'Approvals', html`<header class="pa-head"><p class="pa-eyebrow">OpenVibe.Actor · approvals</p><h1>Approvals</h1>
<p class="pa-lede">When one of your agents runs while you are away and its work would act for you outside Actor (a coding task on your own machine), it asks here first. Nothing runs until you approve. A request you leave expires after ${String(approvals.EXPIRES_DAYS)} days.</p></header>
${rows.length ? html`<ul class="pa-cards">${rows.map((a) => html`<li class="pa-card"><a href="/me/approvals/${a.id}"><strong>${a.summary}</strong></a> ${approvalPill(a)}<span class="pa-when">Asked ${time(a.created_at)}</span></li>`)}</ul>`
        : html`<p class="pa-empty">Nothing to approve. Your agents have not asked for anything yet.</p>`}
<p><a href="/me/agents">Your agents</a></p>`);
    });
    r.get('/me/approvals/:id', async (req, res) => {
        if (!signed(req)) return login(req, res);
        const a = await approvals.get(s, owner(req), req.params.id);
        if (!a) return page(req, res, 'Request not found', html`<h1>Request not found</h1><p><a href="/me/approvals">Approvals</a></p>`, 404);
        const p = typeof a.payload === 'string' ? JSON.parse(a.payload) : a.payload;
        page(req, res, 'Approval', html`<p class="pa-eyebrow"><a href="/me/approvals">Approvals</a></p><h1>${a.summary}</h1>
<p>${approvalPill(a)} <span class="pa-when">Asked ${time(a.created_at)}${a.agent_id ? html` by <a href="/me/agents/${a.agent_id}">your agent</a>` : ''}${a.task_id ? html` in <a href="/tasks/${a.task_id}">this run</a>` : ''}</span></p>
<section class="pa-panel"><h2>What it would do</h2><p>Start a coding task on your own machine through <a href="https://openvibe.codes/run">OpenVibe.Codes</a> with this request. You get the summary, the changed files and the patch; it pushes nowhere unless the request asks for a branch and your machine holds a GitHub token.</p>
<pre class="pa-pre">${String(p.task || '').slice(0, 8000)}</pre></section>
${a.state === 'pending' ? html`<form method="post" action="/me/approvals/${a.id}" class="pa-actions"><button type="submit" name="decision" value="approve" class="pa-btn pa-primary">Approve and start it</button> <button type="submit" name="decision" value="decline" class="pa-btn">Decline</button></form>`
        : a.result_task_id ? html`<p>Started as <a href="/tasks/${a.result_task_id}">this task</a>.</p>` : ''}`);
    });
    r.post('/me/approvals/:id', async (req, res) => {
        if (!write(req, res)) return;
        const out = await approvals.decide(ctx, owner(req), req.params.id, String((req.body || {}).decision || ''));
        if (out.error) return page(req, res, 'Not done', html`<h1>Not done</h1><p>${out.error}</p><p><a href="/me/approvals">Approvals</a></p>`, out.status);
        res.redirect(303, out.task ? `/tasks/${out.task.id}` : `/me/approvals/${req.params.id}`);
    });

    r.get('/me/agents/:id', async (req, res) => {
        if (!signed(req)) return login(req, res);
        const a = await find(req, res); if (!a) return;
        const notes = await personal.memory(s, a.owner, a.id);
        const runs = await s.db.many('SELECT id, state, created_at FROM tasks WHERE requester = $1 AND via = $2 ORDER BY id DESC LIMIT 20', [a.owner, `agent:${a.id}`]);
        const pill = (state) => state === 'succeeded' ? 'pill-succeeded' : state === 'failed' || state === 'cancelled' ? 'pill-failed' : 'pill-running';
        page(req, res, a.name, html`<p class="crumbs"><a href="/me/agents">Your agents</a></p>
<header class="pa-head"><h1>${a.name}</h1><p class="pa-lede"><span class="pill ${a.status === 'paused' ? 'pill-failed' : 'pill-succeeded'}">${a.status === 'paused' ? 'Paused' : 'Active'}</span> ${when(a)}${a.next_run_at && a.status !== 'paused' && a.schedule !== 'off' ? html` · next ${time(a.next_run_at)}` : ''}</p></header>
${a.last_skip_reason ? html`<p class="notice" role="status">The last scheduled run was skipped: ${a.last_skip_reason}</p>` : ''}
<div class="pa-grid">
<section class="pa-panel"><h2>Run now</h2><form method="post" action="/me/agents/${a.id}/run"><label>Input (optional) <span class="pa-hint">Anything this run should also consider.</span><textarea name="input" maxlength="8000" rows="3"></textarea></label><button type="submit" class="pa-btn pa-primary">Run now</button></form></section>
<section class="pa-panel"><h2>Recent runs</h2>${runs.length ? html`<ul class="pa-runs">${runs.map((t) => html`<li><a href="/tasks/${t.id}">${time(t.created_at)}</a> <span class="pill ${pill(t.state)}">${t.state}</span></li>`)}</ul>` : html`<p class="muted">No run yet.</p>`}</section>
</div>
<section class="pa-panel"><h2>Memory</h2><p class="pa-hint">What this agent remembers, newest first. Notes you write are never dropped; when memory is full (50 notes) the oldest note the agent wrote goes first. An agent adds at most one note per run, and only when its answer passed the check.</p>
${notes.length ? html`<ul class="pa-notes">${notes.map((n) => html`<li><p class="pa-note-text">${n.text}</p><p class="pa-note-meta">${n.origin === 'agent' ? 'Written by the agent' : 'Written by you'} · ${time(n.created_at)}</p>
<details><summary>Edit or delete</summary><form method="post" action="/me/agents/${a.id}/memory/${n.id}/edit"><label>Note <input name="text" maxlength="1000" value="${n.text}"></label><button type="submit" class="pa-btn">Save</button></form>
<form method="post" action="/me/agents/${a.id}/memory/${n.id}/delete"><button type="submit" class="pa-danger-link">Delete note</button></form></details></li>`)}</ul>` : html`<p class="muted">Nothing remembered yet.</p>`}
<form method="post" action="/me/agents/${a.id}/memory"><label>Add a note <textarea name="text" maxlength="1000" required rows="2" placeholder="I prefer answers in bullet points."></textarea></label><button type="submit" class="pa-btn">Add note</button></form>
${notes.length ? html`<p><a href="/me/agents/${a.id}/forget" class="pa-danger-link">Forget everything</a></p>` : html`<p class="pa-hint"><a href="/me/agents/${a.id}/forget">Forget everything</a></p>`}</section>
<section class="pa-panel"><h2>Settings</h2><form method="post" action="/me/agents/${a.id}/edit">${form(a)}<button type="submit" class="pa-btn pa-primary">Save settings</button></form>
<form method="post" action="/me/agents/${a.id}/delete" class="pa-delete"><button type="submit" class="pa-danger-link">Delete this agent</button> <span class="pa-hint">Its memory goes with it; its past runs stay on your task list.</span></form></section>`);
    });
    r.post('/me/agents/:id/edit', async (req, res) => { if (!write(req, res)) return; const out = await personal.update(s, config, owner(req), req.params.id, fields(req.body)); if (!out) return page(req, res, 'Agent not found', html`<h1>Agent not found</h1>`, 404); if (!out.row) return page(req, res, 'Invalid agent', html`<h1>Invalid agent</h1><p>${out.error}</p>`, 422); res.redirect(303, `/me/agents/${req.params.id}`); });
    r.post('/me/agents/:id/delete', async (req, res) => { if (!write(req, res)) return; const a = await find(req, res); if (!a) return; await s.db.query('DELETE FROM actor_agents WHERE id = $1 AND owner = $2', [a.id, a.owner]); res.redirect(303, '/me/agents'); });
    r.post('/me/agents/:id/run', async (req, res) => { if (!write(req, res)) return; const a = await find(req, res); if (!a) return; const out = await personal.run(ctx, a, req.body.input || ''); if (out.code) return page(req, res, 'Run refused', html`<h1>Run refused</h1><p>${out.detail}</p><p><a href="/me/agents/${a.id}">Back to agent</a></p>`, out.status); res.redirect(303, `/tasks/${out.task.id}`); });
    r.post('/me/agents/:id/memory', async (req, res) => { if (!write(req, res)) return; const a = await find(req, res); if (!a) return; const out = await personal.addMemory(s, a.owner, a.id, req.body.text); if (!out.row) return page(req, res, 'Memory refused', html`<h1>Memory refused</h1><p>${out.error || 'Memory is full.'}</p>`, out.limit ? 429 : 422); res.redirect(303, `/me/agents/${a.id}`); });
    r.post('/me/agents/:id/memory/:mem/edit', async (req, res) => { if (!write(req, res)) return; const a = await find(req, res); if (!a) return; const value = req.body.text; if (typeof value !== 'string' || !value.trim() || value.length > 1000) return page(req, res, 'Invalid memory', html`<h1>Invalid memory</h1>`, 422); const n = await s.db.maybe('UPDATE actor_agent_memory SET text = $1, updated_at = $2 WHERE id = $3 AND agent_id = $4 AND owner = $5 RETURNING id', [value.trim(), s.iso(), req.params.mem, a.id, a.owner]); if (!n) return page(req, res, 'Note not found', html`<h1>Note not found</h1>`, 404); res.redirect(303, `/me/agents/${a.id}`); });
    r.post('/me/agents/:id/memory/:mem/delete', async (req, res) => { if (!write(req, res)) return; const a = await find(req, res); if (!a) return; await s.db.query('DELETE FROM actor_agent_memory WHERE id = $1 AND agent_id = $2 AND owner = $3', [req.params.mem, a.id, a.owner]); res.redirect(303, `/me/agents/${a.id}`); });
    r.get('/me/agents/:id/forget', async (req, res) => { if (!signed(req)) return login(req, res); const a = await find(req, res); if (!a) return; page(req, res, 'Forget memory', html`<h1>Forget all memory for ${a.name}?</h1><form method="post" action="/me/agents/${a.id}/forget"><button type="submit">Forget everything</button></form><p><a href="/me/agents/${a.id}">Cancel</a></p>`); });
    r.post('/me/agents/:id/forget', async (req, res) => { if (!write(req, res)) return; const a = await find(req, res); if (!a) return; await s.db.query('DELETE FROM actor_agent_memory WHERE agent_id = $1 AND owner = $2', [a.id, a.owner]); res.redirect(303, `/me/agents/${a.id}`); });
    return r;
}

module.exports = { createAgentPages };

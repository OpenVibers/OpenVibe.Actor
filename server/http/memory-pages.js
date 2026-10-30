'use strict';

/**
 * /memory (Actor v2, stage V2-6): the person's memory, visible and editable.
 *
 * Everything here is a plain form, so the page works without JavaScript: add, edit, archive, restore, delete, and
 * accept or decline a suggestion. Only the owner's rows are read or changed (every query is owner-scoped), a page is
 * never cached, and a suggested memory is inert until the person accepts it.
 *
 * A memory shows where it came from: the task that wrote it (a link the task page itself guards) and whether the person
 * wrote it or their agent suggested it, plus when it was last used. Nothing here is a second store: the page reads
 * actor_agent_memory, the same table the recall and remember tools use (server/memory/index.js).
 */
const express = require('express');
const { asyncRouter } = require('./router');
const { sameOrigin } = require('./principal');
const { html, raw, time, notice } = require('../render/html');
const { send } = require('../render/layout');
const memory = require('../memory');

const TASK_ID = /^tsk_[0-9A-HJKMNP-TV-Z]{26}$/;
const KIND_LABEL = { fact: 'Fact', preference: 'Preference', instruction: 'Instruction' };
const STATUS_LABEL = { active: 'Active', suggested: 'Suggested', archived: 'Archived' };
const STATUS_BADGE = { active: 'ok', suggested: 'warn', archived: '' };

function createMemoryPages(ctx) {
    const { config, s } = ctx;
    const r = asyncRouter();
    r.use(express.urlencoded({ extended: false, limit: '64kb' }));
    const signed = (req) => req.viewer && req.viewer.kind === 'user' && req.viewer.subject;
    const owner = (req) => `user:${req.viewer.subject}`;
    const page = (req, res, body, { status = 200, title = 'Memory' } = {}) => send(res, status, {
        viewer: req.viewer, config, path: req.originalUrl, title, body, css: ['css/memory.css'],
    });
    const login = (req, res) => res.redirect(303, `/auth/login?next=${encodeURIComponent(req.originalUrl)}`);
    const write = (req, res) => {
        if (!signed(req)) { login(req, res); return false; }
        if (!sameOrigin(req, config.baseUrl)) { res.status(403).type('text/plain').send('A change must come from openvibe.actor itself.'); return false; }
        return true;
    };

    /**
     * One row: what it says, the kind and status, where it came from, when it was last used, and the forms for what may
     * be done with it now. Every id is the person's own (the list is owner-scoped).
     */
    function row(m, agents) {
        const fromTask = m.source_task && TASK_ID.test(m.source_task);
        const fromAgent = m.agent_id && agents.get(m.agent_id);
        const source = m.source === 'agent' ? 'Your agent suggested it' : 'You wrote it';
        const forms = [];
        if (m.status === 'suggested') {
            forms.push(html`<form method="post" action="/memory/${m.id}/accept" class="mem-actions"><button type="submit" class="mem-btn mem-primary">Accept</button></form>`);
            forms.push(html`<form method="post" action="/memory/${m.id}/decline" class="mem-actions"><button type="submit" class="mem-btn">Decline</button></form>`);
        }
        if (m.status === 'active') {
            forms.push(html`<form method="post" action="/memory/${m.id}/archive" class="mem-actions"><button type="submit" class="mem-btn">Archive</button></form>`);
        }
        if (m.status === 'archived') {
            forms.push(html`<form method="post" action="/memory/${m.id}/restore" class="mem-actions"><button type="submit" class="mem-btn">Restore</button></form>`);
        }
        forms.push(html`<form method="post" action="/memory/${m.id}/delete" class="mem-actions"><button type="submit" class="mem-btn mem-danger">Delete</button></form>`);
        return html`<li class="mem mem-${m.status}" id="${m.id}">
<p class="mem-head"><span class="mem-kind mem-kind-${m.kind}">${KIND_LABEL[m.kind] || 'Fact'}</span><span class="badge ${STATUS_BADGE[m.status] || ''}">${STATUS_LABEL[m.status] || m.status}</span>${m.status === 'suggested' ? html`<span class="mem-wait">needs your decision</span>` : ''}</p>
<p class="mem-text">${m.text}</p>
<p class="mem-meta">${source}${fromAgent ? html` · for <a href="/me/agents/${fromAgent.id}">${fromAgent.name}</a>` : ''}${fromTask ? html` · from <a href="/tasks/${m.source_task}">this task</a>` : ''}
 · added ${time(m.created_at)}${m.updated_at && m.updated_at !== m.created_at ? html` · updated ${time(m.updated_at)}` : ''}
 · ${m.last_used_at ? html`last used ${time(m.last_used_at)}${m.uses ? html` (${m.uses} time${m.uses === 1 ? '' : 's'})` : ''}` : 'not used yet'}</p>
<div class="mem-forms">${forms}
<details class="mem-edit"><summary>Edit</summary><form method="post" action="/memory/${m.id}/edit">
<label>Memory <textarea name="text" rows="2" maxlength="${memory.MAX_TEXT}" required>${m.text}</textarea></label>
<label>Kind <select name="kind">${memory.KINDS.map((k) => html`<option value="${k}"${m.kind === k ? raw(' selected') : ''}>${KIND_LABEL[k]}</option>`)}</select></label>
<button type="submit" class="mem-btn mem-primary">Save</button></form></details></div>
</li>`;
    }

    function section(title, id, rows, empty, note = '') {
        return html`<section class="mem-sec" id="${id}" aria-labelledby="h-${id}">
<h2 id="h-${id}">${title} <span class="mem-count">${rows.length}</span></h2>
${note ? html`<p class="mem-note">${note}</p>` : ''}
${rows.length ? html`<ul class="mem-list">${rows}</ul>` : html`<p class="mem-empty">${empty}</p>`}
</section>`;
    }

    r.get('/memory', async (req, res) => {
        if (!signed(req)) return login(req, res);
        const rows = await memory.list(s, owner(req));
        const agents = new Map((await s.db.many('SELECT id, name FROM actor_agents WHERE owner = $1', [owner(req)])).map((a) => [a.id, a]));
        const problem = typeof req.query.problem === 'string' ? req.query.problem.slice(0, 300) : null;
        const active = rows.filter((m) => m.status === 'active');
        const suggested = rows.filter((m) => m.status === 'suggested');
        const archived = rows.filter((m) => m.status === 'archived');
        page(req, res, html`<header class="mem-head-page">
<p class="mem-eyebrow">OpenVibe.Actor · memory</p>
<h1>Memory</h1>
<p class="mem-lede">What Actor remembers about you, and what it does not. Only your own words make an active memory; anything an agent works out from a page, a file or a tool result waits here as a suggestion until you accept it. Memory is never shown to anyone else and never leaves Actor except in your export.</p>
</header>
${problem ? notice(problem, 'warn') : ''}
<section class="mem-panel" aria-labelledby="h-add"><h2 id="h-add">Add a memory</h2>
<form method="post" action="/memory" class="mem-add">
<label>Memory <span class="mem-hint">At most ${memory.MAX_TEXT} characters. Never a password, a key, a card number or anything about how someone looks.</span>
<textarea name="text" rows="2" maxlength="${memory.MAX_TEXT}" required placeholder="I prefer metric units."></textarea></label>
<label>Kind <select name="kind">${memory.KINDS.map((k) => html`<option value="${k}">${KIND_LABEL[k]}</option>`)}</select>
<span class="mem-hint">An instruction can narrow what the agent does ("ask before spending"); it never gives it a new permission or a bigger budget.</span></label>
<button type="submit" class="mem-btn mem-primary">Save to memory</button>
</form></section>
${section('Suggested', 'suggested', suggested.map((m) => row(m, agents)), 'Nothing waits for you. An agent\'s suggestion appears here, not in its answers.', 'A suggestion does nothing until you accept it. Accepting makes it active; declining keeps it, archived.')}
${section('Active', 'active', active.map((m) => row(m, agents)), 'Nothing active yet. Add one above, or ask Actor to remember something in a task.')}
${section('Archived', 'archived', archived.map((m) => row(m, agents)), 'Nothing archived.')}
<p class="mem-foot"><a href="/me/agents">Your agents</a> · <a href="/tasks">Your tasks</a> · <a href="/console">Console</a></p>`);
    });

    r.post('/memory', async (req, res) => {
        if (!write(req, res)) return;
        const out = await memory.add(s, { owner: owner(req), text: (req.body || {}).text, kind: (req.body || {}).kind, source: 'person' });
        if (out.error) return res.redirect(303, `/memory?problem=${encodeURIComponent(out.error)}#add`);
        res.redirect(303, `/memory#${out.row.id}`);
    });

    r.post('/memory/:id/edit', async (req, res) => {
        if (!write(req, res)) return;
        const out = await memory.edit(s, owner(req), req.params.id, { text: (req.body || {}).text, kind: (req.body || {}).kind });
        if (!out) return page(req, res, html`<h1>Memory not found</h1><p><a href="/memory">Memory</a></p>`, { status: 404, title: 'Memory not found' });
        if (out.error) return res.redirect(303, `/memory?problem=${encodeURIComponent(out.error)}#${req.params.id}`);
        res.redirect(303, `/memory#${req.params.id}`);
    });

    r.post('/memory/:id/:action', async (req, res) => {
        if (!write(req, res)) return;
        const action = req.params.action;
        if (action === 'delete') {
            const removed = await memory.remove(s, owner(req), req.params.id);
            if (!removed) return page(req, res, html`<h1>Memory not found</h1><p><a href="/memory">Memory</a></p>`, { status: 404, title: 'Memory not found' });
            return res.redirect(303, '/memory');
        }
        if (!['accept', 'decline', 'archive', 'restore'].includes(action)) return page(req, res, html`<h1>Not found</h1><p><a href="/memory">Memory</a></p>`, { status: 404, title: 'Not found' });
        const out = await memory.decide(s, owner(req), req.params.id, action);
        if (out.error) {
            const status = out.status || 400;
            return page(req, res, html`<h1>Not done</h1><p>${out.error}</p><p><a href="/memory">Back to memory</a></p>`, { status, title: 'Not done' });
        }
        res.redirect(303, `/memory#${out.row.id}`);
    });

    return r;
}

module.exports = { createMemoryPages, KIND_LABEL, STATUS_LABEL };

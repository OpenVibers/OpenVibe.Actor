'use strict';

/**
 * /memory (Actor v2, stage V2-6): the person's memory, visible and editable.
 *
 * Short by design: one sentence, a closed "How memory works", one compact add row, then three server-rendered tabs
 * (?tab=active|suggested|archived) and only the open tab's list. It is complete without JavaScript: add, edit, archive,
 * restore, delete, accept and decline are plain forms. Only the owner's rows are read or changed (every query is
 * owner-scoped), a page is never cached, and a suggested memory is inert until the person accepts it.
 *
 * A memory is one row: its text, one muted line (kind, who wrote it, its task, how often it was used) and the date.
 * The kit's tabs and list classes give the same pill tabs and rows as the rest of OpenVibe; the actions are compact
 * buttons on a suggestion and a small ⋯ details menu on an active or archived row.
 */
const express = require('express');
const kit = require('openvibe-shared/kit');
const { asyncRouter } = require('./router');
const { sameOrigin } = require('./principal');
const { html, raw, notice } = require('../render/html');
const { send } = require('../render/layout');
const memory = require('../memory');

const TASK_ID = /^tsk_[0-9A-HJKMNP-TV-Z]{26}$/;
const TABS = ['active', 'suggested', 'archived'];
const KIND_LABEL = { fact: 'Fact', preference: 'Preference', instruction: 'Instruction' };
const STATUS_LABEL = { active: 'Active', suggested: 'Suggested', archived: 'Archived' };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAY = 86_400_000;
const tabOf = (value, fallback = 'active') => (TABS.includes(String(value || '')) ? String(value) : fallback);
const tabTitle = (tab) => (tab === 'suggested' ? 'Nothing waits for you.' : tab === 'archived' ? 'Nothing archived.' : 'Nothing active yet. Add one above, or ask Actor to remember something in a task.');
const line = (parts) => raw(parts.filter(Boolean).map((p) => String(p)).join(' · '));

/** A date people read at a glance, never a time: today, yesterday, Oct 30, or 2025-10-20 for another year (UTC). */
function shortDate(iso, now = Date.now()) {
    const d = new Date(iso);
    if (!Number.isFinite(d.getTime())) return { iso: '', text: '' };
    const n = new Date(now);
    const today = Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate());
    const day = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    let text;
    if (day === today) text = 'today';
    else if (day === today - DAY) text = 'yesterday';
    else if (d.getUTCFullYear() === n.getUTCFullYear()) text = `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
    else text = d.toISOString().slice(0, 10);
    return { iso: d.toISOString(), text };
}

function createMemoryPages(ctx) {
    const { config, s } = ctx;
    const r = asyncRouter();
    r.use(express.urlencoded({ extended: false, limit: '64kb' }));
    const signed = (req) => req.viewer && req.viewer.kind === 'user' && req.viewer.subject;
    const owner = (req) => `user:${req.viewer.subject}`;
    const page = (req, res, body, { status = 200, title = 'Memory' } = {}) => send(res, status, {
        viewer: req.viewer, config, path: req.originalUrl, title, body, styles: ['kit.css'], css: ['css/memory.css'],
    });
    const login = (req, res) => res.redirect(303, `/auth/login?next=${encodeURIComponent(req.originalUrl)}`);
    const write = (req, res) => {
        if (!signed(req)) { login(req, res); return false; }
        if (!sameOrigin(req, config.baseUrl)) { res.status(403).type('text/plain').send('A change must come from openvibe.actor itself.'); return false; }
        return true;
    };
    const back = (tab, id = null) => `/memory?tab=${encodeURIComponent(tabOf(tab))}${id ? `#${id}` : ''}`;
    const problem = (tab, text, id = null) => `/memory?tab=${encodeURIComponent(tabOf(tab))}&problem=${encodeURIComponent(String(text).slice(0, 300))}${id ? `#${id}` : ''}`;

    /** The edit form, in the row's menu. It shows the whole text, even a row that is longer than today's 500 limit. */
    function editForm(m, tab, hidden) {
        return html`<details class="mem-edit"><summary>Edit</summary><form method="post" action="/memory/${m.id}/edit">${hidden}
<label>Memory <textarea name="text" rows="2" required>${m.text}</textarea></label>
<label>Kind <select name="kind">${memory.KINDS.map((k) => html`<option value="${k}"${m.kind === k ? raw(' selected') : ''}>${KIND_LABEL[k]}</option>`)}</select></label>
<button type="submit" class="mem-btn mem-primary">Save</button></form></details>`;
    }

    /**
     * One row: the text, one muted line and the date; the actions at the end. A suggestion has Accept and Decline
     * visible; an active or archived row has Archive/Restore, Edit and Delete in a small ⋯ menu.
     */
    function row(m, agents, tab) {
        const fromTask = m.source_task && TASK_ID.test(m.source_task);
        const fromAgent = m.agent_id && agents.get(m.agent_id);
        const who = m.source === 'agent'
            ? (fromAgent ? html`suggested by <a href="/me/agents/${fromAgent.id}">${fromAgent.name}</a>` : 'suggested by your agent')
            : 'you wrote it';
        const bits = [KIND_LABEL[m.kind] || 'Fact', who];
        if (fromTask) bits.push(html`from <a href="/tasks/${m.source_task}">this task</a>`);
        if (m.uses > 0) bits.push(m.uses === 1 ? 'used once' : `used ${m.uses} times`);
        const date = shortDate(m.created_at);
        if (date.text) bits.push(html`<time datetime="${date.iso}">${date.text}</time>`);
        const hidden = html`<input type="hidden" name="tab" value="${tab}">`;
        let trail;
        if (m.status === 'suggested') {
            trail = html`<div class="mem-trail">
<form method="post" action="/memory/${m.id}/accept">${hidden}<button type="submit" class="mem-btn mem-primary">Accept</button></form>
<form method="post" action="/memory/${m.id}/decline">${hidden}<button type="submit" class="mem-btn">Decline</button></form>
</div>`;
        } else {
            trail = html`<div class="mem-trail"><details class="mem-menu"><summary class="mem-more" aria-label="More actions for this memory">⋯</summary><div class="mem-menu-body">
<form method="post" action="/memory/${m.id}/${m.status === 'archived' ? 'restore' : 'archive'}">${hidden}<button type="submit" class="mem-btn">${m.status === 'archived' ? 'Restore' : 'Archive'}</button></form>
${editForm(m, tab, hidden)}
<form method="post" action="/memory/${m.id}/delete">${hidden}<button type="submit" class="mem-btn mem-danger">Delete</button></form>
</div></details></div>`;
        }
        return html`<li class="ovk-row ovk-row--static mem-row mem-${m.status}" id="${m.id}">
<span class="ovk-row-main"><span class="ovk-row-top"><span class="mem-text">${m.text}</span></span>
<span class="ovk-row-sub"><span class="mem-meta">${line(bits)}</span></span></span>
${trail}
</li>`;
    }

    r.get('/memory', async (req, res) => {
        if (!signed(req)) return login(req, res);
        const rows = await memory.list(s, owner(req));
        const agents = new Map((await s.db.many('SELECT id, name FROM actor_agents WHERE owner = $1', [owner(req)])).map((a) => [a.id, a]));
        const suggested = rows.filter((m) => m.status === 'suggested');
        const active = rows.filter((m) => m.status === 'active');
        const archived = rows.filter((m) => m.status === 'archived');
        // Suggested first when there is anything to decide; the query may pick any tab afterwards.
        const fallback = suggested.length ? 'suggested' : 'active';
        const tab = TABS.includes(String(req.query.tab || '')) ? String(req.query.tab) : fallback;
        const open = tab === 'suggested' ? suggested : tab === 'archived' ? archived : active;
        const problemText = typeof req.query.problem === 'string' ? req.query.problem.slice(0, 300) : null;
        const tabs = kit.tabs({
            base: '/memory', active: tab,
            items: [
                { key: 'active', label: 'Active', count: active.length },
                { key: 'suggested', label: 'Suggested', count: suggested.length },
                { key: 'archived', label: 'Archived', count: archived.length },
            ],
        });
        page(req, res, html`<header class="mem-head-page">
<h1>Memory</h1>
<p class="mem-lede">What Actor remembers about you. Only your own words become active; anything else waits here for you.</p>
<details class="mem-how"><summary>How memory works</summary>
<p>Only your own words make an active memory. Anything an agent works out from a page, a file or a tool result waits here as a suggestion until you accept it. Memory is never shown to anyone else and never leaves Actor except in your export.</p>
<p>An instruction can narrow what the agent does ("ask before spending"); it never gives it a new permission or a bigger budget.</p>
</details>
</header>
${problemText ? notice(problemText, 'warn') : ''}
<section class="mem-add-wrap" id="add" aria-labelledby="h-add"><h2 id="h-add">Add a memory</h2>
<form method="post" action="/memory" class="mem-add">
<label class="sr-only" for="mem-new">New memory</label>
<input id="mem-new" name="text" maxlength="${memory.MAX_TEXT}" required autocomplete="off" placeholder="I prefer metric units.">
<label class="sr-only" for="mem-kind">Kind</label>
<select id="mem-kind" name="kind">${memory.KINDS.map((k) => html`<option value="${k}">${KIND_LABEL[k]}</option>`)}</select>
<button type="submit" class="mem-btn mem-primary">Save</button>
</form>
<p class="mem-hint">Up to ${memory.MAX_TEXT} characters. Never a password, key or card number.</p>
</section>
${raw(tabs)}
${raw(kit.list(open.map((m) => row(m, agents, tab)), { empty: tabTitle(tab) }))}
<p class="mem-foot"><a href="/me/agents">Your agents</a> · <a href="/tasks">Your tasks</a> · <a href="/console">Console</a></p>`);
    });

    r.post('/memory', async (req, res) => {
        if (!write(req, res)) return;
        const out = await memory.add(s, { owner: owner(req), text: (req.body || {}).text, kind: (req.body || {}).kind, source: 'person' });
        if (out.error) return res.redirect(303, problem('active', out.error, 'add'));
        res.redirect(303, back('active', out.row.id));
    });

    r.post('/memory/:id/edit', async (req, res) => {
        if (!write(req, res)) return;
        const tab = tabOf((req.body || {}).tab, 'active');
        const out = await memory.edit(s, owner(req), req.params.id, { text: (req.body || {}).text, kind: (req.body || {}).kind });
        if (!out) return page(req, res, html`<h1>Memory not found</h1><p><a href="/memory">Memory</a></p>`, { status: 404, title: 'Memory not found' });
        if (out.error) return res.redirect(303, problem(tab, out.error, req.params.id));
        res.redirect(303, back(tab, req.params.id));
    });

    r.post('/memory/:id/:action', async (req, res) => {
        if (!write(req, res)) return;
        const action = req.params.action;
        const fallback = action === 'decline' || action === 'archive' ? 'archived' : 'active';
        const tab = tabOf((req.body || {}).tab, fallback);
        if (action === 'delete') {
            const removed = await memory.remove(s, owner(req), req.params.id);
            if (!removed) return page(req, res, html`<h1>Memory not found</h1><p><a href="/memory">Memory</a></p>`, { status: 404, title: 'Memory not found' });
            return res.redirect(303, back(tab));
        }
        if (!['accept', 'decline', 'archive', 'restore'].includes(action)) return page(req, res, html`<h1>Not found</h1><p><a href="/memory">Memory</a></p>`, { status: 404, title: 'Not found' });
        const out = await memory.decide(s, owner(req), req.params.id, action);
        if (out.error) {
            const status = out.status || 400;
            return page(req, res, html`<h1>Not done</h1><p>${out.error}</p><p><a href="${back(tab)}">Back to memory</a></p>`, { status, title: 'Not done' });
        }
        res.redirect(303, back(tab, out.row.id));
    });

    return r;
}

module.exports = { createMemoryPages, KIND_LABEL, STATUS_LABEL, shortDate, tabOf };

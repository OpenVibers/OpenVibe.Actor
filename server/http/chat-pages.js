'use strict';

/**
 * The chat (plan L55 C1; the owner, 2026-11-01: "it needs a whole conversation system… like Gemini or ChatGPT… your
 * conversations on the left… way cleaner, so many words"). Actor's app for a signed-in person.
 *
 * - A conversation is a chain of tasks: each follow-up's parent_id is the turn before it (a fork starts a chain of its
 *   own). The sidebar is the person's chains, newest activity first, grouped Today / Yesterday / This week / Earlier.
 * - A turn is the question as a bubble and Actor's reply under it: the work folded ("Worked for 12 s · 3 tools", the
 *   plan, its notes and each tool call with what it returned), the answer, its files and sources, and one quiet line
 *   (mode · model · cost · time · checked) with Copy and Details.
 * - Everything else a task has (saved steps and forks, compare, the Bench offer, the evidence list with Challenge, the
 *   trace, webhooks, the API line) is that turn's Details: /tasks/:id?view=details, the full task page.
 *
 * Server-rendered and complete without JavaScript: the composer is a plain form (POST /chat) and a turn still working
 * refreshes the page (<noscript>). public/js/chat.js adds the live work line from the task's event stream, swaps the
 * finished turn in (GET /chat/turn/:id), sends without a reload and keeps the thread at the bottom.
 */
const express = require('express');
const cache = require('openvibe-shared/cache-policy');
const { asyncRouter } = require('./router');
const { html, raw } = require('../render/html');
const { send } = require('../render/layout');
const { markdown } = require('../render/markdown');
const store = require('../tasks/store');
const { createTask } = require('../tasks/create');
const { MODES } = require('../agents/router');
const catalog = require('../agents/catalog');
const taskEvents = require('../../public/js/task-events');
const { sameOrigin } = require('./principal');
const looks = require('../agents/looks');
const inputs = require('../tasks/inputs');
const modelPrefs = require('../runtime/model-prefs');

// The model a person's tasks run on (plan L55 C3; the owner, 11-01: "use your own API keys, or OpenVibe's"). Auto is
// OpenVibe's own; "own:<provider>" is the person's key, sealed in OpenVibe.AI, which Actor never sees.
const PROVIDER_NAMES = { openai: 'OpenAI', anthropic: 'Anthropic', deepseek: 'DeepSeek', google: 'Google Gemini', openrouter: 'OpenRouter', mistral: 'Mistral' };
const AI_SITE = 'https://ai.openvibe.services';
const allowUrl = (provider) => `${AI_SITE}/you?allow=actor&provider=${encodeURIComponent(provider)}`;
const modelLabel = (m) => (m && m.provider ? `Your ${PROVIDER_NAMES[m.provider] || m.provider} key` : 'Auto');
const glyphs = require('openvibe-shared/glyphs');

const TASK_ID = /^tsk_[0-9A-HJKMNP-TV-Z]{26}$/;
const OPEN = ['queued', 'running', 'verifying'];
const MODE_LABEL = { cheapest: 'Cheapest', balanced: 'Balanced', best: 'Best', fastest: 'Fastest', private: 'Private' };
const MODE_HINT = { cheapest: 'the lowest price that can do it', balanced: 'good and cheap', best: 'the strongest agent', fastest: 'the quickest answer', private: 'open model, nothing leaves OpenVibe' };
const LIVE_TEXT = { queued: 'Starting', running: 'Working', verifying: 'Checking the answer' };
const SIDEBAR_ROWS = 400;     // the person's newest tasks the sidebar groups into chats
const CHAIN_MAX = 60;         // turns one conversation shows
const EVENTS_MAX = 600;       // events per turn the work fold reads

const clip = (s, n) => { const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const isFollow = (row) => row && row.parent_id && row.fork_of_step == null;

/** The chats in a person's newest tasks: [{ id (the first turn), title, last (ISO), turns, open }], newest first. */
function chatsOf(rows) {
    const byId = new Map(rows.map((r) => [r.id, r]));
    const rootOf = (row) => {
        let cur = row;
        for (let i = 0; i < CHAIN_MAX && isFollow(cur) && byId.has(cur.parent_id); i++) cur = byId.get(cur.parent_id);
        return cur;
    };
    const chats = new Map();
    for (const row of rows) {
        const root = rootOf(row);
        const c = chats.get(root.id) || { id: root.id, title: clip(root.task, 80), last: root.created_at, turns: 0, open: false };
        c.turns += 1;
        if (String(row.created_at) > String(c.last)) c.last = row.created_at;
        if (OPEN.includes(row.state) || row.state === 'needs_you') c.open = true;
        chats.set(root.id, c);
    }
    return [...chats.values()].sort((a, b) => (String(b.last) > String(a.last) ? 1 : String(b.last) < String(a.last) ? -1 : 0));
}

/** Today / Yesterday / This week / Earlier, by UTC day, for the sidebar. */
function groupOf(iso, now) {
    const day = (ms) => Math.floor(ms / 86_400_000);
    const d = day(now) - day(Date.parse(iso) || now);
    return d <= 0 ? 'Today' : d === 1 ? 'Yesterday' : d < 7 ? 'This week' : 'Earlier';
}

/** "Worked for 35 s", from the task's own times. */
function tookOf(row) {
    const ms = row.finished_at && row.created_at ? Date.parse(row.finished_at) - Date.parse(row.created_at) : NaN;
    if (!Number.isFinite(ms) || ms < 1000) return '';
    const s = Math.round(ms / 1000);
    return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min${s % 60 ? ` ${s % 60} s` : ''}`;
}

function createChatPages(ctx, { computers = null } = {}) {
    const { config, s, engine } = ctx;
    const r = asyncRouter();
    // Bot's computers, for the live desk in a turn (plan L55 C1b): made when first asked for.
    let pcsMade = computers;
    const pcs = () => (pcsMade = pcsMade || require('../agents/computers').createComputers({ config }));
    // Watch links are credentials (whoever holds one watches, and may take over): kept in memory for the task's own
    // requester, never written to the task's events or the database, and reused until a few minutes before they end.
    const links = new Map();
    // Helpers from the task page, read when first used (pages.js is the bigger module; no load-order coupling).
    const pageKit = () => require('./pages');
    const signedIn = (req) => req.viewer && req.viewer.kind === 'user' && req.viewer.subject;
    const requesterOf = (req) => `user:${req.viewer.subject}`;
    const now = () => (typeof s.now === 'function' ? s.now() : Date.now());

    async function chatsFor(requester) {
        const rows = await s.db.many(
            'SELECT id, parent_id, fork_of_step, task, state, created_at FROM tasks WHERE requester = $1 ORDER BY id DESC LIMIT $2',
            [requester, SIDEBAR_ROWS],
        );
        return chatsOf(rows);
    }

    /** The turns of the chat through `row`: its follow-up chain up to the first turn, then on through the newest
     *  follow-up of each turn. */
    async function chainOf(row) {
        const up = [];
        let cur = row;
        for (let i = 0; i < CHAIN_MAX && isFollow(cur); i++) {
            const p = await store.getTask(s, cur.parent_id);
            if (!p || p.requester !== row.requester) break;
            up.unshift(p);
            cur = p;
        }
        const down = [];
        cur = row;
        for (let i = 0; i < CHAIN_MAX - up.length - 1; i++) {
            const next = await s.db.maybe(
                'SELECT * FROM tasks WHERE parent_id = $1 AND requester = $2 AND fork_of_step IS NULL ORDER BY id DESC LIMIT 1',
                [cur.id, row.requester],
            );
            if (!next) break;
            down.push(next);
            cur = next;
        }
        return [...up, row, ...down];
    }

    // ── One turn ───────────────────────────────────────────────────────────────────────────────────────────────────
    const ICON = {
        tool: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14.7 6.3a4 4 0 0 0-5.4 5.1L4 16.7V20h3.3l5.3-5.3a4 4 0 0 0 5.1-5.4l-2.6 2.6-2.4-.6-.6-2.4Z"/></svg>',
        note: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3a6 6 0 0 0-3.5 10.9V16h7v-2.1A6 6 0 0 0 12 3ZM9.5 19.5h5"/></svg>',
        step: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
        ok: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
        bad: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7l10 10M17 7 7 17"/></svg>',
        copy: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2.5"/><path d="M16 8V6.5A2.5 2.5 0 0 0 13.5 4h-7A2.5 2.5 0 0 0 4 6.5v7A2.5 2.5 0 0 0 6.5 16H8"/></svg>',
        more: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h10"/></svg>',
        file: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3h7l5 5v13H7Z"/><path d="M14 3v5h5"/></svg>',
        you: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5.5h14v10H10l-5 4Z"/></svg>',
        open: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 5h5v5M19 5l-8 8M10 6H6a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1v-4"/></svg>',
    };

    /**
     * The screen (the owner, 2026-11-01: "it has a display… you should be able to watch it and just chill while you do
     * stuff, and steer it"): while a turn works on a desk or reads a screen, what the agent sees now, refreshed by
     * js/chat.js, and Bot's own page to watch it live and take it over. A finished turn keeps the last picture (for an
     * hour, in memory: agents/looks.js).
     */
    function screenBlock(row, events, open) {
        const desk = open ? store.deskFrom(events) : null;
        const look = looks.get(row.id);
        if (!desk && !look) return open ? html`<figure class="ct-screen" data-screen hidden></figure>` : '';
        const place = desk && store.deskPlace(desk.url);
        const framable = !!(place && place.desk !== 'main');
        return html`<figure class="ct-screen${open ? ' is-live' : ''}" data-screen${desk ? html` data-desk="${desk.url}"` : ''}${framable ? html` data-watch="/chat/${row.id}/watch"` : ''}>
<div class="ct-screen-frame">${look ? html`<img data-look src="/tasks/${row.id}/look?at=${look.at}" alt="What Actor ${open ? 'sees now' : 'last saw'}"${look.width && look.height ? html` width="${look.width}" height="${look.height}"` : ''}>` : html`<span class="ct-screen-wait">The screen shows here as soon as Actor looks at it.</span>`}${open ? html`<span class="ct-live">Live</span>` : ''}</div>
<figcaption><span>${open ? `What Actor sees${desk && desk.kind === 'browser' ? ' in its browser' : ''}` : 'What Actor last saw'}</span>${desk ? html`<a class="ct-watch" href="${desk.url}" target="_blank" rel="noopener">${raw(ICON.open)}Watch live and take over</a>` : ''}</figcaption>
</figure>`;
    }

    /** The work fold's rows, in order: a plan step, a note the agent wrote, or a tool call with what it returned. */
    function workRows(lines) {
        const { toolLabel, msText } = pageKit();
        const results = new Map(lines.filter((l) => l.t === 'tool_result').map((l) => [l.id, l]));
        const rows = [];
        for (const l of lines) {
            if (l.t === 'step') rows.push(html`<li class="cw-step">${raw(ICON.step)}<span>${l.text}</span></li>`);
            else if (l.t === 'text' && /^You: /.test(l.text)) rows.push(html`<li class="cw-you">${raw(ICON.you)}<p>${clip(l.text.slice(5), 300)}</p></li>`);
            else if (l.t === 'text') rows.push(html`<li class="cw-note">${raw(ICON.note)}<p>${clip(l.text, 700)}</p></li>`);
            else if (l.t === 'note') rows.push(html`<li class="cw-note is-${l.level || 'info'}">${raw(ICON.note)}<p>${clip(l.text, 400)}</p></li>`);
            else if (l.t === 'handoff') rows.push(html`<li class="cw-step">${raw(ICON.step)}<span>Handed to ${l.to || 'another agent'}${l.reason ? `: ${clip(l.reason, 160)}` : ''}</span></li>`);
            else if (l.t === 'tool') {
                const res = results.get(l.id);
                const state = !res ? 'is-run' : res.ok ? 'is-ok' : 'is-bad';
                rows.push(html`<li class="cw-tool ${state}"><details><summary>${raw(ICON.tool)}<b>${toolLabel(l.name)}</b>${l.what ? html`<span class="cw-in">${clip(l.what, 90)}</span>` : ''}<span class="cw-st">${res ? raw(res.ok ? ICON.ok : ICON.bad) : ''}${res && res.duration_ms ? msText(res.duration_ms) : ''}</span></summary>
${res ? html`<pre class="cw-out">${clip(res.output, 1500)}</pre>` : html`<p class="cw-out muted">Running…</p>`}</details></li>`);
            }
        }
        return rows;
    }

    function workBlock(row, events, open) {
        const lines = taskEvents.lines(events.slice(-EVENTS_MAX), { final: !open, state: row.state });
        const rows = workRows(lines);
        const tools = lines.filter((l) => l.t === 'tool').length;
        const took = tookOf(row);
        const head = open
            ? html`<span class="cw-live" data-live-line>${LIVE_TEXT[row.state] || 'Working'}…</span>`
            : html`<span>${took ? `Worked for ${took}` : 'Worked'}${tools ? ` · ${tools} tool${tools === 1 ? '' : 's'}` : ''}</span>`;
        if (!open && !rows.length) return '';
        return html`<details class="cw"${open ? raw(' data-open') : ''}><summary>${head}<svg class="cw-chev" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 10l4 4 4-4"/></svg></summary>
<ol class="cw-list" data-work>${rows}</ol></details>`;
    }

    function answerBlock(row, t) {
        const { chipify, modelName, usd } = pageKit();
        const result = t.result || {};
        const evidence = Array.isArray(result.evidence) ? result.evidence.filter((e) => e && /^E\d{1,3}$/.test(String(e.id))) : [];
        // Citations open the evidence on the Details page (the chat keeps one line per answer, not the evidence list).
        const body = chipify(markdown(result.answer || '', { headingOffset: 2 }), evidence).replace(/href="#ev-/g, `href="/tasks/${row.id}?view=details#ev-`);
        const artifacts = Array.isArray(result.artifacts) ? result.artifacts : [];
        const sources = Array.isArray(result.sources) ? result.sources.slice(0, 8) : [];
        const checked = result.checked || {};
        const claims = Number(checked.claims) || 0;
        const agent = catalog.byId(result.agent);
        const took = tookOf(row);
        const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return String(u).slice(0, 40); } };
        return html`<div class="ct-answer prose" data-answer>${raw(body)}</div>
${artifacts.length ? html`<ul class="ct-files">${artifacts.map((a) => html`<li><a href="${a.url}" rel="nofollow noopener">${/^image\/(svg\+xml|png|jpe?g|gif|webp)$/.test(a.mime) ? html`<img src="${a.url}" alt="${a.name}" loading="lazy">` : raw(ICON.file)}<span>${a.name}</span></a></li>`)}</ul>` : ''}
${sources.length ? html`<p class="ct-sources">${sources.map((u) => html`<a href="${u}" rel="nofollow ugc noopener" target="_blank">${host(u)}</a>`)}</p>` : ''}
<div class="ct-meta"><span title="${agent ? agent.name : result.agent || ''}">${MODE_LABEL[row.mode] || row.mode}${result.model ? ` · ${modelName(result.model)}` : ''}</span>${t.cost ? html`<span>${usd(t.cost.usd)}</span>` : ''}${took ? html`<span>${took}</span>` : ''}${claims ? html`<span class="ct-checked" title="${claims} claim${claims === 1 ? '' : 's'} checked by a second model">${raw(ICON.ok)}Checked</span>` : ''}
<span class="ct-acts"><button type="button" class="ct-act" data-copy hidden>${raw(ICON.copy)}<span>Copy</span></button><a class="ct-act" href="/tasks/${row.id}?view=details">${raw(ICON.more)}<span>Details</span></a></span></div>`;
    }

    function questionBlock(row, events) {
        const q = [...events].reverse().find((e) => e.kind === 'output' && e.step === 'question');
        if (!q) return html`<div class="ct-card is-wait"><p><b>Actor is waiting for you.</b></p><p><a href="/tasks/${row.id}?view=details#question">Open the question</a></p></div>`;
        const options = Array.isArray(q.options) ? q.options : [];
        const acting = q.question_kind === 'acting';
        return html`<div class="ct-card is-wait"><p><b>${acting ? 'Actor was stopped mid-action' : 'One question first'}</b></p><p>${String(q.text || '')}</p>
<form method="post" action="/tasks/${row.id}/answer" class="ct-opts">${options.map((o) => html`<button class="ct-opt" type="submit" name="answer" value="${o}">${o}</button>`)}</form>
${acting ? '' : html`<form method="post" action="/tasks/${row.id}/answer" class="ct-own"><input name="answer" type="text" maxlength="2000" required placeholder="Or answer in your own words" aria-label="Your answer"><button class="ct-opt" type="submit">Answer</button></form>`}</div>`;
    }

    function failedBlock(row, t) {
        const err = t.error || {};
        const why = {
            'actor.agents.exhausted': 'No answer passed its check, so nothing unchecked was shown.',
            'actor.check.unavailable': 'The answer could not be checked, so it was not shown.',
            'actor.task.timeout': 'It ran too long and was stopped.',
            'actor.task.interrupted': 'Actor restarted while this was running. Nothing more was charged.',
        }[err.code] || err.detail || 'It stopped without saying why.';
        return html`<div class="ct-card is-bad"><p><b>Actor couldn't finish this.</b> ${why}</p>
<form method="post" action="/chat" class="ct-retry"><input type="hidden" name="task" value="${row.task}"><input type="hidden" name="mode" value="best">${isFollow(row) ? html`<input type="hidden" name="parent" value="${row.parent_id}">` : ''}<button class="ct-opt" type="submit">Try again in Best mode</button><a class="ct-act" href="/tasks/${row.id}?view=details">Details</a></form></div>`;
    }

    const bytesText = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);
    function filesBlock(row, files) {
        if (!files || !files.length) return '';
        return html`<ul class="ct-attached">${files.map((f) => html`<li>${inputs.IMAGE.test(f.mime)
            ? html`<a href="/chat/file/${row.id}/${f.id}" target="_blank" rel="noopener"><img src="/chat/file/${row.id}/${f.id}" alt="${f.name}" loading="lazy"></a>`
            : html`<a class="ct-file" href="/chat/file/${row.id}/${f.id}" target="_blank" rel="noopener">${raw(ICON.file)}<span><b>${f.name}</b><small>${bytesText(f.size)}</small></span></a>`}</li>`)}</ul>`;
    }

    async function turnHtml(row, { events = null, files = null } = {}) {
        const attached = files || (await inputs.list(s, [row.id])).get(row.id) || [];
        const t = store.toWire(row, { baseUrl: config.baseUrl });
        const evs = events || await store.eventsAfter(s, row.id, 0);
        const open = OPEN.includes(row.state);
        let reply;
        if (row.state === 'succeeded') reply = html`${workBlock(row, evs, false)}${screenBlock(row, evs, false)}${answerBlock(row, t)}`;
        else if (row.state === 'needs_you') reply = html`${workBlock(row, evs, false)}${questionBlock(row, evs)}`;
        else if (row.state === 'failed') reply = html`${workBlock(row, evs, false)}${failedBlock(row, t)}`;
        else if (row.state === 'cancelled') reply = html`${workBlock(row, evs, false)}<p class="ct-stopped">Stopped. What it spent before stopping stays spent.</p>`;
        else reply = html`${workBlock(row, evs, true)}${screenBlock(row, evs, true)}`;
        return html`<li class="ct-turn state-${row.state}" id="t-${row.id}" data-task="${row.id}" data-state="${row.state}" data-last="${row.last_seq}"${open ? raw(' data-open') : ''}>
<div class="ct-you">${filesBlock(row, attached)}<p class="ct-bubble">${row.task}</p></div>
<div class="ct-bot"><span class="ct-avatar" aria-hidden="true"></span><div class="ct-reply">${reply}</div></div>
</li>`;
    }

    // ── The page ───────────────────────────────────────────────────────────────────────────────────────────────────
    function sidebar(chats, currentId) {
        const groups = [];
        let last = null;
        const t = now();
        for (const c of chats) {
            const g = groupOf(c.last, t);
            if (g !== last) { groups.push({ name: g, items: [] }); last = g; }
            groups[groups.length - 1].items.push(c);
        }
        return html`<aside class="cs" id="chats" aria-label="Your chats">
<div class="cs-head"><a class="cs-new" href="/chat">${raw('<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>')}New chat</a>
<button type="button" class="cs-close" data-cs-close aria-label="Close the chats" hidden>${raw(ICON.bad)}</button></div>
<label class="cs-find"><span class="sr-only">Find a chat</span><input type="search" placeholder="Find a chat" data-cs-find autocomplete="off"></label>
<nav class="cs-list">${groups.length ? groups.map((g) => html`<p class="cs-group">${g.name}</p><ul>${g.items.map((c) => html`<li><a href="/chat/${c.id}"${c.id === currentId ? raw(' aria-current="page"') : ''} data-title="${c.title.toLowerCase()}">${c.open ? html`<i class="cs-dot" title="Working"></i>` : ''}<span>${c.title}</span></a></li>`)}</ul>`)
        : html`<p class="cs-empty">Your chats show here.</p>`}</nav>
<p class="cs-foot"><a href="/console">Console</a><a href="/me/agents">Your agents</a><a href="/memory">Memory</a></p>
</aside>`;
    }

    /**
     * The model chip: what this person's tasks run on, and a menu to change it. The buttons save with one request
     * (js/chat.js, PUT /api/v1/me/model); without the script the menu's link opens /chat/model, a plain form.
     */
    function modelChip(model) {
        const current = model && model.provider ? `own:${model.provider}` : 'auto';
        const item = (choice, title, sub) => html`<button type="button" class="ccm-item${choice === current ? ' is-on' : ''}" data-ccm-choice="${choice}" aria-pressed="${choice === current ? 'true' : 'false'}"><b>${title}</b><small>${sub}</small></button>`;
        return html`<details class="cc-model" data-cc-model>
<summary class="cc-model-chip" title="The model your tasks run on">${raw(glyphs.svg('chip', { size: 16 }))}<span data-ccm-label>${modelLabel(model)}</span></summary>
<div class="ccm-panel" role="group" aria-label="The model your tasks run on">
<ul class="ccm-list"><li>${item('auto', 'Auto, OpenVibe\'s', 'Actor picks a model for each step, on OpenVibe\'s keys.')}</li></ul>
<p class="ccm-head">Your own key</p>
<ul class="ccm-list">${modelPrefs.OWN_PROVIDERS.map((p) => html`<li class="ccm-own" data-ccm-provider="${p}">${item(`own:${p}`, PROVIDER_NAMES[p] || p, 'Your key, kept in OpenVibe.AI')}<a class="ccm-setup" href="${allowUrl(p)}" target="_blank" rel="noopener" data-ccm-setup>Set up</a></li>`)}</ul>
<p class="ccm-fine" data-ccm-fine>A key you add stays sealed in OpenVibe.AI: Actor never sees it, and only uses it once you allow Actor there. <a href="/chat/model">All settings</a></p>
</div></details>`;
    }

    function composer({ parent = null, mode = 'balanced', busy = false, working = null, problem = null, text = '', model = null } = {}) {
        return html`<form class="cc" method="post" action="${working ? `/chat/${working}/steer` : '/chat'}" data-composer${busy ? raw(' data-busy') : ''}>
${problem ? html`<p class="cc-problem" role="alert">${problem}</p>` : ''}
${parent ? html`<input type="hidden" name="parent" value="${parent}">` : ''}
<div class="cc-box">
<ul class="cc-files" data-cc-chips hidden></ul>
<label class="sr-only" for="cc-text">Message Actor</label>
<textarea id="cc-text" name="task" rows="1" maxlength="20000" required placeholder="${working ? 'Tell Actor something while it works' : parent ? 'Reply to Actor' : 'Ask Actor to do something'}" data-cc-text>${text}</textarea>
<div class="cc-row">
<button type="button" class="cc-attach" data-cc-attach aria-label="Attach files" title="Attach text, code, CSV, JSON or images" hidden>${raw('<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11.5 12.4 19a5 5 0 0 1-7.1-7.1l8-8a3.4 3.4 0 0 1 4.8 4.8l-7.9 7.9a1.7 1.7 0 0 1-2.4-2.4L15 7"/></svg>')}</button><input type="file" multiple hidden data-cc-files accept=".txt,.md,.csv,.tsv,.json,.jsonl,.yaml,.yml,.toml,.xml,.html,.css,.js,.ts,.py,.rb,.go,.rs,.java,.c,.cpp,.cs,.php,.sh,.sql,.log,.srt,.vtt,text/*,image/png,image/jpeg,image/webp,image/gif">
${modelChip(model)}
<label class="cc-mode" title="How Actor picks the agent"><span class="sr-only">Mode</span><select name="mode" data-cc-mode>${MODES.map((m) => html`<option value="${m}" title="${MODE_HINT[m] || ''}"${m === mode ? raw(' selected') : ''}>${MODE_LABEL[m] || m}</option>`)}</select></label>
<span class="cc-note" data-cc-note></span>
${working ? html`<button class="cc-stop" type="submit" formaction="/tasks/${working}/cancel" formnovalidate aria-label="Stop" data-cc-stop>${raw('<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="2"/></svg>')}</button>` : html`<button class="cc-stop" type="button" aria-label="Stop" data-cc-stop hidden>${raw('<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="2"/></svg>')}</button>`}
<button class="cc-send" type="submit" aria-label="Send" data-cc-send>${raw('<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5M6 11l6-6 6 6"/></svg>')}</button>
</div></div>
<p class="cc-fine">Actor checks each answer with a second model. ${config.allowance ? `Free: ${config.allowance.tasksPerDay} tasks a day.` : ''}</p>
</form>`;
    }

    // What people really hand agents like this (the owner, 2026-11-01: "I hate the current examples… search what
    // people use Grok-style agents for"; research the same day: OpenAI's agent launch, Manus reviews and Perplexity's
    // Comet usage study put travel, shopping and deals, fact-checks and research, watching for something, and lists
    // first). Each one only fills the box: nothing runs until the person sends it.
    const STARTERS = [
        ['airplane', 'Find a flight', 'Find the cheapest round trip from New York to Tokyo in March. Show me the best three and stop before paying.'],
        ['check-circle', 'Is this true?', 'Fact-check this with real sources, and tell me what is true, what is false and what is unclear: '],
        ['cart', 'Best deal', 'Compare the five best standing desks under $500: price, reviews, and where each is cheapest today.'],
        ['eye', 'Watch for it', 'Watch eBay for a used RTX 4090 under $900 and tell me the moment one is listed.'],
        ['map', 'Plan a trip', 'Plan a weekend in Lisbon for two: a hotel under $150 a night, where to eat, and a plan for each day.'],
        ['table', 'Make a list', 'Make a table of 20 small gaming streamers (under 10k followers) with their channel links and when they stream.'],
        ['news', 'What\'s the buzz', 'What are people saying about the newest iPhone today on Reddit, X and the news? Give me the short version.'],
        ['globe', 'Use a website', 'Open openvibe.live, find a channel that is live right now, and tell me what is happening on it.'],
    ];

    async function render(req, res, { row = null, problem = null, text = '', status = 200 } = {}) {
        const requester = requesterOf(req);
        const [chats, turns] = await Promise.all([chatsFor(requester), row ? chainOf(row) : []]);
        const first = turns[0] || null;
        const lastTurn = turns[turns.length - 1] || null;
        const busy = Boolean(lastTurn && (OPEN.includes(lastTurn.state) || lastTurn.state === 'needs_you'));
        const fileMap = await inputs.list(s, turns.map((t) => t.id));
        const model = modelPrefs.wire(await modelPrefs.get(s, requester).catch(() => null));
        const turnHtmls = await Promise.all(turns.map((t) => turnHtml(t, { files: fileMap.get(t.id) || [] })));
        const title = first ? clip(first.task, 60) : 'New chat';
        return send(res, status, {
            viewer: req.viewer, config, path: req.originalUrl, title, app: true, noReferrer: true,
            css: ['css/chat.css'], scripts: ['js/chat.js'],
            body: html`${busy ? raw('<noscript><meta http-equiv="refresh" content="5"></noscript>') : ''}
<div class="chat" data-chat="${first ? first.id : ''}">
${sidebar(chats, first ? first.id : null)}
<div class="cs-scrim" data-cs-close hidden></div>
<section class="ct" aria-label="${first ? 'Conversation' : 'New chat'}">
<header class="ct-head"><button type="button" class="ct-menu" data-cs-open aria-controls="chats" aria-expanded="false">${raw('<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"/></svg>')}<span class="sr-only">Your chats</span></button>
<h1 class="ct-title">${title}</h1>${first ? html`<a class="ct-new" href="/chat" aria-label="New chat">${raw('<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>')}</a>` : ''}</header>
<div class="ct-scroll" data-scroll>
${turns.length ? html`<ol class="ct-thread" data-thread>${turnHtmls}</ol>` : html`<div class="ct-hello"><span class="ct-hello-mark" aria-hidden="true"></span><h2>What should Actor do?</h2><p>It browses, clicks and types for you. Watch it work, steer it, or go do something else.</p>
<ul class="ct-starters">${STARTERS.map(([icon, k, v]) => html`<li><button type="button" data-starter="${v}">${raw(glyphs.svg(icon, { size: 20 }))}<b>${k}</b><span>${v}</span></button></li>`)}</ul></div>`}
</div>
${composer({ parent: lastTurn ? lastTurn.id : null, mode: lastTurn ? lastTurn.mode : 'balanced', busy, working: lastTurn && OPEN.includes(lastTurn.state) ? lastTurn.id : null, problem, text, model })}
</section>
</div>`,
        });
    }

    const loginTo = (req) => `/auth/login?next=${encodeURIComponent(req.originalUrl)}`;

    r.get('/chat/model', async (req, res) => {
        res.set('Cache-Control', cache.htmlHeaders({ private: true }));
        if (!signedIn(req)) return res.redirect(303, loginTo(req));
        const model = modelPrefs.wire(await modelPrefs.get(s, requesterOf(req)).catch(() => null));
        const current = model.provider ? `own:${model.provider}` : 'auto';
        const saved = req.query.saved === '1';
        const error = typeof req.query.error === 'string' ? req.query.error.slice(0, 200) : '';
        const radio = (choice, title, sub, extra = '') => html`<label class="cm-opt"><input type="radio" name="choice" value="${choice}"${choice === current ? raw(' checked') : ''}><span><b>${title}</b><small>${sub}</small></span>${raw(extra)}</label>`;
        return send(res, 200, {
            viewer: req.viewer, config, path: req.originalUrl, title: 'Your model', app: true, noReferrer: true,
            css: ['css/chat.css'], scripts: [],
            body: html`<main class="cm"><a class="cm-back" href="/chat">${raw(glyphs.svg('back', { size: 18 }))} Chat</a>
<h1>The model your tasks run on</h1>
<p class="cm-lede">Actor can run on OpenVibe's keys, or on your own key for a provider you use. Your key stays sealed in OpenVibe.AI: Actor never sees it, and only uses it after you allow Actor there.</p>
${saved ? html`<p class="cm-ok" role="status">Saved. Your next task runs on ${modelLabel(model)}.</p>` : ''}${error ? html`<p class="cm-err" role="alert">${error}</p>` : ''}
<form class="cm-form" method="post" action="/chat/model">
${radio('auto', 'Auto, OpenVibe\'s', 'Actor picks a model for each step, on OpenVibe\'s keys. Free within the daily allowance.')}
<p class="cm-head">Your own key</p>
${modelPrefs.OWN_PROVIDERS.map((p) => radio(`own:${p}`, PROVIDER_NAMES[p] || p, 'Billed by the provider to you, not counted against Actor\'s allowance.', `<a class="cm-setup" href="${allowUrl(p).replace(/&/g, '&amp;')}" target="_blank" rel="noopener">Add or allow the key</a>`))}
<label class="cm-modelid"><span>A model id, if you want one <small>(leave empty and OpenVibe.AI picks the provider's best fit)</small></span><input name="model" value="${model.model || ''}" maxlength="120" pattern="[A-Za-z0-9][A-Za-z0-9._:/\-]{0,119}" placeholder="for example gpt-5.1, claude-sonnet-4-5, deepseek-chat" spellcheck="false" autocomplete="off"></label>
<button class="cm-save" type="submit">Save</button>
</form></main>`,
        });
    });

    r.post('/chat/model', express.urlencoded({ extended: false, limit: '4kb' }), async (req, res) => {
        res.set('Cache-Control', cache.htmlHeaders({ private: true }));
        if (!signedIn(req)) return res.redirect(303, loginTo(req));
        if (!sameOrigin(req, config.baseUrl)) return res.status(403).type('text/plain').send('Change this on openvibe.actor itself.');
        const body = req.body || {};
        const out = await modelPrefs.put(s, requesterOf(req), { choice: body.choice, model: body.model ? String(body.model) : null });
        if (out.error) return res.redirect(303, `/chat/model?error=${encodeURIComponent('That did not save: ' + out.error)}`);
        return res.redirect(303, '/chat/model?saved=1');
    });

    r.get('/chat', async (req, res) => {
        res.set('Cache-Control', cache.htmlHeaders({ private: true }));
        if (!signedIn(req)) return res.redirect(303, loginTo(req));
        const text = typeof req.query.ask === 'string' ? req.query.ask.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').slice(0, 2000) : '';
        return render(req, res, { text });
    });

    r.get('/chat/turn/:id', async (req, res) => {
        res.set('Cache-Control', cache.htmlHeaders({ private: true }));
        if (!signedIn(req) || !TASK_ID.test(req.params.id)) return res.status(404).end();
        const row = await store.getTask(s, req.params.id);
        if (!row || row.requester !== requesterOf(req)) return res.status(404).end();
        res.type('html').send(require('../render/html').render(await turnHtml(row)));
    });

    // An attached file, to its own person only: an image shown in place; anything else downloaded as plain text, in a
    // sandbox, never sniffed.
    r.get('/chat/file/:taskId/:id', async (req, res) => {
        res.set('Cache-Control', cache.htmlHeaders({ private: true }));
        if (!signedIn(req) || !TASK_ID.test(req.params.taskId) || !/^inp_[A-Za-z0-9_-]{6,20}$/.test(req.params.id)) return res.status(404).end();
        const row = await store.getTask(s, req.params.taskId);
        if (!row || row.requester !== requesterOf(req)) return res.status(404).end();
        const f = await inputs.get(s, row.id, req.params.id);
        if (!f) return res.status(404).end();
        const bytes = Buffer.isBuffer(f.bytes) ? f.bytes : Buffer.from(f.bytes || []);
        res.set('X-Content-Type-Options', 'nosniff');
        res.set('Content-Security-Policy', "default-src 'none'; sandbox");
        if (inputs.IMAGE.test(f.mime) && f.mime !== 'image/svg+xml') return res.type(f.mime).send(bytes);
        res.set('Content-Disposition', `attachment; filename="${String(f.name).replace(/[^A-Za-z0-9._-]/g, '_')}"`);
        return res.type('text/plain; charset=utf-8').send(bytes);
    });

    r.get('/chat/:id', async (req, res) => {
        res.set('Cache-Control', cache.htmlHeaders({ private: true }));
        if (!signedIn(req)) return res.redirect(303, loginTo(req));
        const row = TASK_ID.test(req.params.id) ? await store.getTask(s, req.params.id) : null;
        if (!row || row.requester !== requesterOf(req)) return render(req, res, { status: 404, problem: 'That chat is not here: it may have expired (tasks are kept 30 days) or belong to someone else.' });
        return render(req, res, { row });
    });

    // Words for the turn that is working (the composer while Actor works): the run hears them at its next step.
    r.post('/chat/:id/steer', express.urlencoded({ extended: false, limit: '16kb' }), async (req, res) => {
        res.set('Cache-Control', cache.htmlHeaders({ private: true }));
        const wantsJson = String(req.get('accept') || '').includes('application/json');
        if (!signedIn(req) || !TASK_ID.test(req.params.id)) return wantsJson ? res.status(401).json({ error: 'Sign in first.' }) : res.redirect(303, '/auth/login?next=%2Fchat');
        if (!sameOrigin(req, config.baseUrl)) return res.status(403).type('text/plain').send('A message must be sent from openvibe.actor itself.');
        const row = await store.getTask(s, req.params.id);
        if (!row || row.requester !== requesterOf(req)) return wantsJson ? res.status(404).json({ error: 'That chat is not here.' }) : res.redirect(303, '/chat');
        const text = String((req.body && req.body.task) || '').trim().slice(0, 1000);
        const out = text && OPEN.includes(row.state) ? await engine.steer(row.id, text) : { ok: false, reason: text ? 'it has finished' : 'nothing was said' };
        if (wantsJson) return res.status(out.ok ? 202 : 409).json(out.ok ? { ok: true } : { error: out.reason === 'it has finished' ? 'Actor already finished that one. Send it as a new message.' : 'Actor could not take that just now.' });
        return res.redirect(303, `/chat/${row.id}#t-${row.id}`);
    });

    // The live desk in a working turn (plan L55 C1b; the owner, 11-01: "show you the display… watch it… and steer it").
    // The page asks once the turn is on a desk; the answer is a short-lived Bot page it frames, where the person can
    // take the mouse. Only the task's requester, only same-origin, only while the turn works.
    r.post('/chat/:id/watch', async (req, res) => {
        res.set('Cache-Control', 'private, no-store');
        if (!signedIn(req) || !TASK_ID.test(req.params.id)) return res.status(401).json({ error: 'Sign in first.' });
        if (!sameOrigin(req, config.baseUrl)) return res.status(403).json({ error: 'Ask from openvibe.actor itself.' });
        const row = await store.getTask(s, req.params.id);
        if (!row || row.requester !== requesterOf(req)) return res.status(404).json({ error: 'That chat is not here.' });
        if (!OPEN.includes(row.state)) return res.status(409).json({ error: 'Actor has finished that one.' });
        const on = await store.taskDesk(s, row);
        const desk = on && store.deskPlace(on.url);
        if (!desk) return res.status(409).json({ error: 'Actor is not on a desk just now.' });
        const key = `${row.id}|${desk.machine}|${desk.desk}`;
        const kept = links.get(key);
        if (kept && kept.until > now()) return res.json({ url: kept.url, expires_at: kept.expires_at, control: kept.control });
        const out = await pcs().watchLink(req.viewer.subject, desk.machine, desk.desk, { control: true, minutes: 60 });
        if (out.error) return res.status(502).json({ error: 'The live desk is not available here; the picture still updates.', reason: out.code || null });
        const ends = Date.parse(out.expires_at || '') || now() + 60 * 60000;
        links.set(key, { url: out.url, expires_at: out.expires_at, control: out.control, until: ends - 3 * 60000 });
        if (links.size > 500) links.delete(links.keys().next().value);
        return res.json({ url: out.url, expires_at: out.expires_at, control: out.control });
    });

    const PROBLEM = {
        'actor.allowance.exhausted': 'You have used today\'s free tasks. They come back at midnight UTC.',
        'actor.budget.day_spent': 'Today\'s budget is spent. It resets at midnight UTC.',
        'actor.capacity.spent': 'Actor has used today\'s free capacity across everyone. It resets at midnight UTC.',
    };
    r.post('/chat', express.urlencoded({ extended: false, limit: '64kb' }), express.json({ limit: '18mb' }), async (req, res) => {
        res.set('Cache-Control', cache.htmlHeaders({ private: true }));
        const wantsJson = String(req.get('accept') || '').includes('application/json');
        const fail = (status, detail, row = null, text = '') => (wantsJson ? res.status(status).json({ error: detail }) : render(req, res, { row, problem: detail, text, status }));
        if (!signedIn(req)) return wantsJson ? res.status(401).json({ error: 'Sign in first.' }) : res.redirect(303, '/auth/login?next=%2Fchat');
        if (!sameOrigin(req, config.baseUrl)) return res.status(403).type('text/plain').send('A message must be sent from openvibe.actor itself.');
        const text = String((req.body && req.body.task) || '').trim().slice(0, 20000);
        const mode = MODES.includes(req.body && req.body.mode) ? req.body.mode : 'balanced';
        const parentId = req.body && TASK_ID.test(String(req.body.parent || '')) ? String(req.body.parent) : null;
        const parent = parentId ? await store.getTask(s, parentId) : null;
        if (parentId && (!parent || parent.requester !== requesterOf(req))) return fail(404, 'That chat is not here any more. Start a new one.');
        if (!text) return fail(422, 'Write a message first.', parent);
        if (parent && (OPEN.includes(parent.state) || parent.state === 'needs_you')) return fail(409, 'Actor is still working on the last message. Wait for it, or stop it.', parent, text);
        const checked = inputs.check(req.body && req.body.files);
        if (checked.problem) return fail(422, checked.problem, parent, text);
        const out = await createTask({ s, config, engine, principal: { requester: requesterOf(req), project: null }, body: { task: text, mode }, parentId: parent ? parent.id : null,
            afterInsert: checked.files.length ? (made) => inputs.save(s, made.id, requesterOf(req), checked.files) : null });
        if (out.code) return fail(out.status === 503 || out.status === 429 ? out.status : 422, PROBLEM[out.code] || out.detail || 'That could not start. Try again in a moment.', parent, text);
        const row = await store.getTask(s, out.task.id);
        if (wantsJson) return res.status(201).json({ id: row.id, chat: parent ? undefined : row.id, url: `/chat/${row.id}`, turn: require('../render/html').render(await turnHtml(row, { events: [] })) });
        return res.redirect(303, `/chat/${row.id}#t-${row.id}`);
    });

    return r;
}

module.exports = { createChatPages, chatsOf, groupOf };

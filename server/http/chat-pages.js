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
const { html, raw, esc } = require('../render/html');
const { send } = require('../render/layout');
const { markdown } = require('../render/markdown');
const store = require('../tasks/store');
const { leftLine } = require('../tasks/allowance');
const { createTask } = require('../tasks/create');
const { MODES } = require('../agents/router');
const catalog = require('../agents/catalog');
const taskEvents = require('../../public/js/task-events');
const { sameOrigin } = require('./principal');
const looks = require('../agents/looks');
const inputs = require('../tasks/inputs');
const modelPrefs = require('../runtime/model-prefs');
const aiCatalog = require('../runtime/ai-catalog');
const canvases = require('../canvases');
const replay = require('../tasks/replay');
// The connectors of a person (plan §Z.6): what their agent may reach, and what they may switch off.
const connectors = require('../runtime/connectors');
// Run settings and permission rules (plan 11c): the presets, the files and network defaults, the rule list.
const runPolicy = require('../runtime/run-policy');
const siteOwner = require('../auth/site-owner');

// The model a person's tasks run on (plan L55 C3; the owner, 11-01: "use your own API keys, or OpenVibe's"). Auto is
// OpenVibe's own; "own:<provider>" is the person's key, sealed in OpenVibe.AI, which Actor never sees.
const PROVIDER_NAMES = { openai: 'OpenAI', anthropic: 'Anthropic', deepseek: 'DeepSeek', google: 'Google Gemini', openrouter: 'OpenRouter', mistral: 'Mistral', link: 'computer' };
const AI_SITE = 'https://ai.openvibe.services';
const allowUrl = (provider) => `${AI_SITE}/you?allow=actor&provider=${encodeURIComponent(provider)}`;
const modelLabel = (m) => (m && m.provider === 'link' ? 'Your computer' : m && m.provider ? `Your ${PROVIDER_NAMES[m.provider] || m.provider} key` : 'Auto');
const glyphs = require('openvibe-shared/glyphs');
// One conversation UI for the network (plan L55 C4): the sidebar, the turns, the work, the answer and the composer.
const thread = require('openvibe-shared/thread');

const TASK_ID = /^tsk_[0-9A-HJKMNP-TV-Z]{26}$/;
const TRIGGER_ID = /^trg_[0-9A-HJKMNP-TV-Z]{26}$/;
const LAST_RUN = { ok: 'went fine', failed: 'failed', needs_you: 'needs you', running: 'is running' };
const OPEN = ['queued', 'running', 'verifying'];
const MODE_LABEL = { cheapest: 'Cheapest', balanced: 'Balanced', best: 'Best', fastest: 'Fastest', private: 'Private' };
const LIVE_TEXT = { queued: 'Starting', running: 'Working', verifying: 'Checking the answer' };
// The Now strip is what is running (a queued task is not yet; it has no steps).
const NOW_STATES = ['running', 'verifying'];
// Composer v2's mode chip: the same modes as the router, in the owner's words (11-12: "Fast/Balanced/Best").
const MODE_CHOICES = [['fastest', 'Fast'], ['balanced', 'Balanced'], ['best', 'Best'], ['cheapest', 'Cheapest'], ['private', 'Private']];
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
    const { config, s, engine, sharing } = ctx;
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
    /** The one Share sheet's button: its owner gets the audience part too; a reader gets Send it only. */
    const shareButton = (row, owner) => {
        const title = String(row.task || 'An agent run').split('\n')[0].slice(0, 90);
        return owner
            ? html`<button type="button" class="ovt-btn" data-ov-share-sheet data-kind="run" data-id="${row.id}" data-title="${title}">Share</button>`
            : html`<button type="button" class="ovt-btn" data-ov-share-sheet data-title="${title}">Share</button>`;
    };
    /** Specific people, and this reader is not on the list: the audience, never the question or an answer. */
    const sharedGate = (req, res, id) => {
        const signedInAs = signedIn(req) ? (req.viewer.username || '') : '';
        const signInUrl = `/auth/login?next=${encodeURIComponent(req.originalUrl)}`;
        return send(res, 404, {
            viewer: req.viewer, config, path: req.originalUrl, title: 'Shared with specific people', app: true, noReferrer: true,
            styles: ['kit.css', 'ov-share.css'], sharedScripts: ['kit-web.js', 'ov-share.js'],
            // The gate draws itself from this markup (openvibe-shared 4.123.0's [data-ov-share-gate]): no inline
            // script, so a strict CSP needs nothing, and every value is escaped like any other attribute.
            body: html`<div class="ct-wrap"><div id="share-gate" class="ct-gate" data-ov-share-gate data-kind="run" data-id="${String(id)}" data-signed-in-as="${signedInAs}" data-sign-in-url="${signInUrl}"><h1>This run is shared with specific people</h1>
<p>Sign in with the OpenVibe account it was shared with, or ask its owner for access.</p></div></div>`,
        });
    };

    const AUDIENCE_TEXT = { private: 'Only me', people: 'Specific people', link: 'Anyone with the link', public: 'Everyone' };
    /**
     * "New runs: Only me", with "Apply to all my existing runs" (design rule 1 and 2). The Share button on a run
     * changes just that one; this is only what the next one starts as.
     */
    async function defaultsHtml(requester, { from = '' } = {}) {
        if (!sharing) return '';
        const current = await sharing.defaultOf(requester).catch(() => 'private');
        const options = ['private', 'people', 'link', 'public']
            .map((a) => html`<option value="${a}"${a === current ? raw(' selected') : ''}>${AUDIENCE_TEXT[a]}</option>`);
        return html`<form class="ct-share-defaults" method="post" action="/chat/defaults">
${from ? html`<input type="hidden" name="from" value="${from}">` : ''}<label for="ct-share-default">New runs</label><select id="ct-share-default" name="audience">${options}</select>
<label class="ct-check"><input type="checkbox" name="apply_all" value="1"> Apply to all my existing runs</label>
<button class="sc-btn" type="submit">Save</button>
<span class="muted small">Only me unless you choose otherwise. Each run's Share button changes just that run.</span>
</form>`;
    }

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

    /** The work fold's rows (thread.work), in order: a plan step, a note the agent wrote, what the person said while it
     *  worked, or a tool call with what it returned. */
    function workRows(lines) {
        const { toolLabel } = pageKit();
        const results = new Map(lines.filter((l) => l.t === 'tool_result').map((l) => [l.id, l]));
        const rows = [];
        for (const l of lines) {
            if (l.t === 'step') rows.push({ kind: 'step', text: l.text });
            else if (l.t === 'text' && /^You: /.test(l.text)) rows.push({ kind: 'you', text: l.text.slice(5) });
            else if (l.t === 'text') rows.push({ kind: 'note', text: l.text });
            else if (l.t === 'note') rows.push({ kind: 'note', text: l.text, level: l.level || 'info' });
            else if (l.t === 'handoff') rows.push({ kind: 'step', text: `Handed to ${l.to || 'another agent'}${l.reason ? `: ${clip(l.reason, 160)}` : ''}` });
            else if (l.t === 'tool') {
                const res = results.get(l.id);
                rows.push({ kind: 'tool', name: toolLabel(l.name), input: l.what || null, output: res ? res.output : null, ok: res ? Boolean(res.ok) : null, running: !res });
            }
        }
        return rows;
    }

    function workBlock(row, events, open) {
        const lines = taskEvents.lines(events.slice(-EVENTS_MAX), { final: !open, state: row.state });
        return raw(thread.work({ open, live: LIVE_TEXT[row.state] || 'Working', took: tookOf(row) || null, rows: workRows(lines) }));
    }

    /**
     * Where a running task's desk is (See it work, W1): Link's desk on the person's machine or a Run session on a desk
     * host, read from the task's own tool results. → { where, id, machine, desk, kind, label, still } or null.
     */
    function deskContext(events) {
        const desk = store.deskFrom(events);
        const computer = store.computerFrom(events);
        if (computer && computer.session_id) {
            return { where: 'run', id: `run:${computer.session_id}`, session_id: computer.session_id, machine: null, desk: null,
                kind: 'browser', label: computer.where === 'yours' ? `${computer.machine || 'Your computer'} · a desk host` : 'OpenVibe computer',
                still: `/api/v1/tasks/__TASK__/still` };
        }
        const place = desk && store.deskPlace(desk.url);
        // The person's own screen is never framed: an agent's desk is private or desk-<name>.
        if (!place || place.desk === 'main') return null;
        return { where: 'link', id: `link:${place.machine}:${place.desk}`, machine: place.machine, desk: place.desk,
            kind: desk.kind || 'desktop', label: `${(computer && computer.machine) || 'Your PC'} · ${place.desk === 'main' ? 'your screen' : 'its own desk'}`,
            still: `/api/v1/tasks/__TASK__/desk-still?desk=${encodeURIComponent(place.desk)}` };
    }

    /** The latest browser address the desk's browser reported (a page address, never model text). */
    function browserUrlOf(events) {
        for (let i = events.length - 1; i >= 0; i--) {
            const e = events[i];
            if (!e || e.kind !== 'output' || e.step !== 'tool_result' || e.tool !== 'computer_browser' || e.is_error) continue;
            try { const d = JSON.parse(e.text || '{}'); if (d && typeof d.url === 'string' && /^https?:\/\//.test(d.url)) return d.url.slice(0, 500); } catch { /* not JSON */ }
        }
        return null;
    }

    /** The last click or move, for the ring: x,y in the screen picture's pixels, and that picture's size. */
    function lastClick(events) {
        for (let i = events.length - 1; i >= 0; i--) {
            const e = events[i];
            if (!e || e.kind !== 'output' || e.step !== 'tool_call' || e.tool !== 'computer_input') continue;
            const a = e.args && typeof e.args === 'object' ? e.args : {};
            if (!['click', 'double_click', 'right_click', 'move'].includes(String(a.action))) continue;
            if (!Number.isFinite(a.x) || !Number.isFinite(a.y)) continue;
            return { x: Number(a.x), y: Number(a.y), width: Number(a.width) || 1280, height: Number(a.height) || 800 };
        }
        return null;
    }

    /** The latest computer step in plain words, for the tile's one caption. Never the typed text. */
    function deskCaption(events) {
        for (let i = events.length - 1; i >= 0; i--) {
            const e = events[i];
            if (!e || e.kind !== 'output' || e.step !== 'tool_call') continue;
            const a = e.args && typeof e.args === 'object' ? e.args : {};
            if (e.tool === 'computer_input') {
                if (a.action === 'type') return 'Typing';
                if (a.action === 'click' || a.action === 'double_click' || a.action === 'right_click') return `Clicking at ${Math.round(Number(a.x) || 0)}, ${Math.round(Number(a.y) || 0)}`;
                if (a.action === 'scroll') return 'Scrolling';
                if (a.action === 'key') return 'Pressing a key';
                if (a.action === 'move') return 'Moving the mouse';
                return 'Using the computer';
            }
            if (e.tool === 'computer_browser') {
                if (a.action === 'open') return 'Opening a page';
                if (a.action === 'read') return 'Reading the page';
                if (a.action === 'click') return 'Clicking on the page';
                if (a.action === 'fill') return 'Typing in a field';
                if (a.action === 'press') return 'Pressing a key';
                if (a.action === 'back') return 'Going back';
                return 'Using the browser';
            }
            if (e.tool === 'computer_screen') return 'Looking at the screen';
            if (e.tool === 'computer_desk') return a.action === 'start' ? 'Starting its desk' : a.action === 'stop' ? 'Stopping its desk' : 'Checking its desk';
        }
        return 'Getting ready';
    }

    /** A step waiting for the person (hand_to_person) becomes an Ask whose button opens the viewer in control. */
    function pendingAsk(events) {
        // The public body keeps the tool but not call_id; a hand_to_person stays open until its result arrives.
        let open = null;
        for (const e of events) {
            if (!e || e.kind !== 'output') continue;
            if (e.step === 'tool_call' && e.tool === 'hand_to_person') open = String((e.args && e.args.what) || 'Actor needs you on its desk').slice(0, 300);
            if (e.step === 'tool_result' && e.tool === 'hand_to_person') open = null;
        }
        return open;
    }

    function deskTile(row, events, readOnly = false) {
        const d = deskContext(events);
        if (!d || readOnly) return '';
        const still = d.still.replace('__TASK__', row.id);
        const click = lastClick(events);
        const ring = click ? (() => {
            const left = Math.max(0, Math.min(100, (click.x / Math.max(1, click.width)) * 100));
            const top = Math.max(0, Math.min(100, (click.y / Math.max(1, click.height)) * 100));
            return `<span class="ct-desk-ring" data-ct-desk-ring aria-hidden="true" style="left:${left.toFixed(2)}%;top:${top.toFixed(2)}%"></span>`;
        })() : '';
        const page = browserUrlOf(events);
        const ask = pendingAsk(events);
        return html`<figure class="ct-desk-tile" data-ct-desk data-task="${row.id}" data-desk="${d.id}" data-where="${d.where}" data-kind="${d.kind}" data-label="${d.label}" data-still="${still}">
<div class="ct-desk-frame" data-ct-desk-frame>
<img data-ct-desk-still src="${still}" alt="Actor's desk" loading="lazy" decoding="async">
<span class="ct-desk-live" data-ct-desk-live hidden>Live</span>
<button type="button" class="ct-desk-open" data-ct-desk-open aria-label="Open the desk viewer" title="Open the desk viewer"><span>Watch</span></button>
${raw(ring)}
</div>
<figcaption><span data-ct-desk-caption>${deskCaption(events)}</span><span class="ct-desk-place">${d.label}</span>${page ? html`<a data-ct-desk-url href="${page}" target="_blank" rel="noopener nofollow" hidden>${String(page).replace(/^https?:\/\//, '').slice(0, 80)}</a>` : ''}</figcaption>
${ask ? html`<div class="ct-desk-ask" data-ct-desk-ask><p><b>Actor needs you:</b> ${ask}</p><button type="button" class="ct-desk-take" data-ct-takeover>Take over</button></div>` : ''}
</figure>`;
    }

    /** A finished task's replay: the steps with stills, and the first picture until the person scrubs. */
    async function replayBlock(row) {
        const steps = await replay.steps(s, row);
        if (!steps.length) return '';
        const first = steps.find((x) => x.still) || null;
        const json = raw(JSON.stringify(steps).replace(/</g, '\\u003c').replace(/&/g, '\\u0026'));
        return html`<details class="ct-replay" data-ct-replay data-task="${row.id}">
<summary>Replay · ${String(steps.length)} step${steps.length === 1 ? '' : 's'}</summary>
<div class="ct-replay-body">
<input type="range" min="0" max="${String(Math.max(0, steps.length - 1))}" value="0" step="1" data-ct-replay-range aria-label="Scrub the replay">
<figure class="ct-replay-shot">${first ? html`<img data-ct-replay-img src="${first.still.url}" alt="What the step saw" loading="lazy">` : html`<span class="ct-replay-none">No pictures were kept for this run.</span>`}
<figcaption><span data-ct-replay-caption>${replay.caption(steps[0])}</span>${first ? html`<a data-ct-replay-link href="${first.still.url}" target="_blank" rel="noopener">Open the picture</a>` : ''}</figcaption></figure>
<ol class="ct-replay-steps">${steps.map((st, i) => html`<li><button type="button" data-ct-replay-step="${String(i)}"><span>${String(i + 1)}</span>${replay.caption(st)}${st.still ? '' : ' · no picture'}</button></li>`)}</ol>
<script type="application/json" data-ct-replay-data>${json}</script>
</div></details>`;
    }

    /**
     * A turn that is running is a card in the conversation (one-agent system, stage 1: the owner, 11-12, "a more
     * modular system… reused in a shared modular way"), not a separate console panel: its title, its state, the last
     * steps it took and Stop. js/chat.js refreshes the card in place from GET /chat/turn/:id; the finished turn becomes
     * the ordinary work fold and answer.
     */
    function runCard(row, events, readOnly = false) {
        const rows = workRows(taskEvents.lines(events.slice(-EVENTS_MAX), { final: false, state: row.state })).slice(-5);
        const last = [...rows].reverse().find((r) => r.kind === 'tool' || r.kind === 'step' || r.kind === 'note');
        const live = !last ? `${LIVE_TEXT[row.state] || 'Working'}…`
            : last.kind === 'tool' ? `Using ${last.name}${last.input ? `: ${clip(last.input, 90)}` : ''}…`
                : clip(last.text, 120);
        const item = (r) => {
            if (r.kind === 'tool') {
                const st = r.running ? 'is-run' : r.ok === false ? 'is-bad' : 'is-ok';
                return `<li class="ovt-w-tool ${st}"><div class="ovt-w-row"><b>${esc(r.name)}</b>${r.input ? `<span class="ovt-w-in">${esc(clip(r.input, 90))}</span>` : ''}<span class="ovt-w-st">${r.running ? '<span class="ovt-dot" aria-hidden="true"></span>' : ''}</span></div></li>`;
            }
            if (r.kind === 'you') return `<li class="ovt-w-you"><p>${esc(clip(r.text, 300))}</p></li>`;
            if (r.kind === 'note') return `<li class="ovt-w-note"><p>${esc(clip(r.text, 300))}</p></li>`;
            return `<li class="ovt-w-step"><span>${esc(clip(r.text, 200))}</span></li>`;
        };
        return html`<article class="ovt-card ct-run" data-ct-run="${row.id}">
${deskTile(row, events, readOnly)}
<p class="ovt-card-h"><span class="ct-run-title">${clip(row.task, 160)}</span><span class="ct-run-state" data-ct-run-state>${LIVE_TEXT[row.state] || 'Working'}…</span></p>
<p class="ct-run-live" data-ovt-live>${live}</p>
<ol class="ct-run-steps" data-ovt-work>${raw(rows.map(item).join(''))}</ol>
${readOnly ? '' : html`<form class="ct-run-stop" method="post" action="/chat/${row.id}/cancel"><button class="ovt-card-btn is-quiet" type="submit">Stop</button></form>`}
</article>`;
    }

    /**
     * The "Now" strip at the top of the chat (the Console's "Now" card, folded in): one row for each task running for
     * this person, with the last thing it did and Stop. Hidden when nothing runs; js/chat.js refreshes it from
     * GET /chat/now while a turn is open.
     */
    function nowStrip(live) {
        if (!live.length) return html`<section class="ct-now" data-ct-now hidden></section>`;
        const stepOf = (row, event) => {
            if (!event) return '';
            const rows = workRows(taskEvents.lines([event], { final: false, state: row.state }));
            const r = [...rows].reverse().find((x) => x.kind === 'tool' || x.kind === 'step' || x.kind === 'note');
            if (!r) return '';
            return r.kind === 'tool' ? `Using ${r.name}${r.input ? `: ${clip(r.input, 80)}` : ''}` : clip(r.text, 100);
        };
        return html`<section class="ct-now" data-ct-now aria-label="Now">
<ul class="ct-now-list">${live.map(({ row, event }) => html`<li class="ct-now-item">
<span class="ct-now-dot" aria-hidden="true"></span>
<a class="ct-now-task" href="/chat/${row.id}"><b>${clip(row.task, 120)}</b></a>
<span class="ct-now-step">${stepOf(row, event)}</span>
<span class="ct-now-state">${LIVE_TEXT[row.state] || 'Working'}…</span>
<form class="ct-now-stop" method="post" action="/chat/${row.id}/cancel"><button type="submit">Stop</button></form>
</li>`)}</ul></section>`;
    }

    function answerBlock(row, t) {
        const { chipify, modelName, usd } = pageKit();
        const result = t.result || {};
        const evidence = Array.isArray(result.evidence) ? result.evidence.filter((e) => e && /^E\d{1,3}$/.test(String(e.id))) : [];
        // Citations open the evidence on the Details page (the chat keeps one line per answer, not the evidence list).
        // A citation chip comes in whole when the answer types in, and its number is never copied with the answer.
        const body = chipify(markdown(result.answer || '', { headingOffset: 2 }), evidence)
            .replace(/href="#ev-/g, `href="/tasks/${row.id}?view=details#ev-`)
            .replace(/<(\w+) class="evs/g, '<$1 data-ovt-whole data-ovt-nocopy class="evs');
        const artifacts = Array.isArray(result.artifacts) ? result.artifacts : [];
        const sources = Array.isArray(result.sources) ? result.sources.slice(0, 8) : [];
        const claims = Number((result.checked || {}).claims) || 0;
        const took = tookOf(row);
        return raw(thread.answer({
            html: `<div class="prose">${body}</div>`,
            files: artifacts.map((a) => ({ href: a.url, name: a.name, image: /^image\/(svg\+xml|png|jpe?g|gif|webp)$/.test(a.mime) })),
            sources,
            meta: [
                `${MODE_LABEL[row.mode] || row.mode}${result.model ? ` · ${modelName(result.model)}` : ''}`,
                t.cost ? usd(t.cost.usd) : null,
                took || null,
                // Said in words, not a tooltip a phone cannot open.
                claims ? `${claims} claim${claims === 1 ? '' : 's'} checked` : null,
            ],
            actions: [{ label: 'Details', href: `/tasks/${row.id}?view=details`, icon: 'more' }],
        }));
    }

    function questionBlock(row, events, readOnly = false) {
        const q = [...events].reverse().find((e) => e.kind === 'output' && e.step === 'question');
        if (!q) return html`<div class="ovt-card is-wait"><p><b>Actor is waiting for you.</b></p><p><a href="/tasks/${row.id}?view=details#question">Open the question</a></p></div>`;
        const options = Array.isArray(q.options) ? q.options : [];
        const acting = q.question_kind === 'acting';
        if (readOnly) {
            return html`<div class="ovt-card is-wait"><p><b>${acting ? 'Actor was stopped mid-action' : 'One question first'}</b></p><p>${String(q.text || '')}</p>
${options.length ? html`<p class="ct-opts">${options.map((o) => html`<span class="ct-opt">${o}</span>`)}</p>` : ''}</div>`;
        }
        return html`<div class="ovt-card is-wait"><p><b>${acting ? 'Actor was stopped mid-action' : 'One question first'}</b></p><p>${String(q.text || '')}</p>
<form method="post" action="/tasks/${row.id}/answer" class="ct-opts">${options.map((o) => html`<button class="ct-opt" type="submit" name="answer" value="${o}">${o}</button>`)}</form>
${acting ? '' : html`<form method="post" action="/tasks/${row.id}/answer" class="ct-own"><input name="answer" type="text" maxlength="2000" required placeholder="Or answer in your own words" aria-label="Your answer"><button class="ct-opt" type="submit">Answer</button></form>`}</div>`;
    }

    function failedBlock(row, t, readOnly = false) {
        const err = t.error || {};
        const why = {
            'actor.agents.exhausted': 'No answer passed its check, so nothing unchecked was shown.',
            'actor.check.unavailable': 'The answer could not be checked, so it was not shown.',
            'actor.task.timeout': 'It ran too long and was stopped.',
            'actor.task.interrupted': 'Actor restarted while this was running. Nothing more was charged.',
        }[err.code] || err.detail || 'It stopped without saying why.';
        const retry = readOnly ? '' : html`<form method="post" action="/chat" class="ct-retry"><input type="hidden" name="task" value="${row.task}"><input type="hidden" name="mode" value="best">${isFollow(row) ? html`<input type="hidden" name="parent" value="${row.parent_id}">` : ''}<button class="ct-opt" type="submit">Try again in Best mode</button><a class="ct-act" href="/tasks/${row.id}?view=details">Details</a></form>`;
        return html`<div class="ovt-card is-bad"><p><b>Actor couldn't finish this.</b> ${why}</p>${retry}${readOnly ? html`<a class="ct-act" href="/tasks/${row.id}?view=details">Details</a>` : ''}</div>`;
    }

    /**
     * A parked turn (plan A2, Watch mode): what it waits for, until when, and the person's two moves. Wake now resumes
     * it with no event (the run checks for itself); Stop waiting ends the wait and the run carries on without it. The
     * deadline is written as a <time> the page shows in the reader's own zone (js/chat.js), "in about 2 h" without it.
     */
    function waitBlock(row, wait, readOnly = false) {
        if (!wait) return '';
        const left = Math.max(0, Date.parse(wait.deadline_at) - now());
        const mins = Math.round(left / 60000);
        const about = mins < 1 ? 'any moment now' : mins < 90 ? `in about ${mins} min` : `in about ${Math.round(mins / 60)} h`;
        return html`<form class="ovt-card is-info ct-wait" method="post" action="/chat/${row.id}/wait" data-ct-wait>
<p class="ovt-card-h">${raw(glyphs.svg('clock', { size: 18 }))}<span><b>Waiting</b> ${String(wait.line || 'for something to happen').replace(/^waiting\s+/i, '').replace(/[.\s]+$/, '')}. Nothing is spent while it waits.</span></p>
<p class="ct-wait-until">It gives up <time datetime="${new Date(wait.deadline_at).toISOString()}" data-ct-local>${about}</time>, then ${wait.on_timeout === 'fail' ? 'stops' : wait.on_timeout === 'retry' ? 'tries that step once more' : 'asks you what next'}.</p>
${readOnly ? '' : html`<div class="ovt-card-acts"><button type="submit" class="ovt-card-btn" name="do" value="wake">Wake now</button><button type="submit" class="ovt-card-btn is-quiet" name="do" value="cancel">Stop waiting</button></div>`}</form>`;
    }

    /**
     * The routines this turn made (plan §12 A-4): one card each, its latest state, and under it the runs'
     * answers (plan HO4) — each run posts its answer, its sources and a link to the run into this chat.
     * What runs and when in words, the next run in the reader's own zone, how the last run went, and the
     * person's moves as plain forms (they work with no script): Pause or Resume, Run now, and Undo for ten
     * minutes, then Delete with a confirmation. A shared, read-only turn shows the card as it was made, with
     * no moves and nothing read beyond the turn itself.
     */
    async function triggerBlocks(row, events, readOnly = false) {
        const latest = new Map();
        const runs = new Map();
        for (const e of events || []) {
            if (e && e.kind === 'output' && e.step === 'trigger' && e.trigger && TRIGGER_ID.test(String(e.trigger.id || ''))) latest.set(e.trigger.id, e.trigger);
            if (e && e.kind === 'output' && e.step === 'trigger-run' && TRIGGER_ID.test(String(e.trigger_id || ''))) {
                if (!runs.has(e.trigger_id)) runs.set(e.trigger_id, []);
                runs.get(e.trigger_id).push(e);
            }
        }
        const owner = String(row.requester || '').replace(/^user:/, '');
        if (!readOnly && ctx.triggers && typeof ctx.triggers.get === 'function') {
            for (const id of runs.keys()) if (!latest.has(id)) {
                const live = await ctx.triggers.get(owner, id).catch(() => null);
                if (live && live.kind === 'mention') latest.set(id, live);
            }
        }
        if (!latest.size) return '';
        const cards = [];
        for (const [id, made] of latest) {
            let card = made;
            let gone = false;
            if (!readOnly && ctx.triggers && typeof ctx.triggers.get === 'function') {
                const live = await ctx.triggers.get(owner, id).catch(() => null);
                if (live) card = live; else gone = true;
            }
            const firedIn = !readOnly && card.kind === 'mention' && !gone
                ? await s.db.maybe('SELECT last_fired_in FROM actor_triggers WHERE id = $1 AND owner = $2', [id, owner]) : null;
            cards.push(triggerCard(row, card, { gone, readOnly, runs: runs.get(id) || [], firedIn: firedIn && firedIn.last_fired_in }));
        }
        return html`${cards}`;
    }

    /**
     * One run of a routine, as it was posted into this chat (plan HO4): when it ran, its answer, the addresses
     * it read and a link to the run. A run that did not finish is one line that says why. A goal's run also
     * shows the run's own verdict on the done-test when there is one.
     */
    function runPost(run) {
        const at = run.at ? new Date(run.at) : null;
        const when = at && !Number.isNaN(at.getTime())
            ? html`<time datetime="${at.toISOString()}" data-ct-local>${at.toISOString().slice(0, 16).replace('T', ' ')} UTC</time>`
            : 'A run';
        const taskId = run.run && run.run.task_id;
        const failed = run.run && run.run.state !== 'ok';
        const sources = Array.isArray(run.sources) ? run.sources.slice(0, 8) : [];
        const body = failed || !run.text
            ? html`<p class="ct-trig-run-line">${String(run.text || 'That run did not finish.')}</p>`
            : html`<div class="prose">${raw(markdown(String(run.text).slice(0, 8000), { headingOffset: 3 }))}</div>`;
        return html`<div class="ct-trig-run${failed ? ' is-bad' : ''}">
<p class="ct-trig-run-h">${when}${taskId ? html` · <a href="/tasks/${taskId}">open the run</a>` : ''}</p>
${body}
${sources.length ? html`<p class="ct-trig-sources">${sources.map((u, i) => html`${i ? ' · ' : ''}<a href="${u}" target="_blank" rel="noopener nofollow">${clip(String(u).replace(/^https?:\/\//, ''), 60)}</a>`)}</p>` : ''}
</div>`;
    }

    function triggerCard(row, card, { gone = false, readOnly = false, runs = [], firedIn = null } = {}) {
        const when = card.when || {};
        const goal = card.goal || null;
        const paused = !gone && card.state === 'paused';
        const done = !gone && card.state === 'done';
        const state = gone ? 'Deleted' : done && card.kind === 'mention' ? 'Expired' : done ? 'Done' : paused ? 'Paused' : 'On';
        const last = card.last_run && LAST_RUN[card.last_run.state] ? card.last_run : null;
        const undoable = !gone && card.undo_until && Date.parse(card.undo_until) > now();
        const why = done
            ? (card.kind === 'mention' ? 'This standing intent expired.' : card.paused_reason === 'done' && goal ? `The goal is reached: ${goal.done_test}.` : 'This goal is finished.')
            : paused ? (card.paused_reason === 'failed' ? `Paused after ${Number(card.failures) || 5} failed runs in a row. Resume it once the cause is fixed.`
                : card.paused_reason === 'budget' ? 'Stopped: its runs or its money ran out.'
                    : card.paused_reason === 'deadline' ? 'Stopped: its deadline passed.'
                        : 'Paused by you.') : '';
        const icon = card.kind === 'event' || card.kind === 'mention' ? 'zap' : card.kind === 'goal' ? 'target' : 'calendar';
        const words = String(when.words || (card.kind === 'event' ? 'When it happens' : card.kind === 'mention' ? 'When you mention it' : 'On a schedule'));
        const zone = card.kind !== 'event' && card.kind !== 'mention' && when.timezone && !words.includes(when.timezone) ? ` (${when.timezone})` : '';
        const meta = [];
        if (card.kind === 'mention') {
            const phrases = when.mention && Array.isArray(when.mention.phrases) ? when.mention.phrases : [];
            meta.push(html`Waiting for: ${phrases.join(when.mention && when.mention.match === 'all' ? ' and ' : ' or ')}`);
            if (card.expires_at) meta.push(html`until <time datetime="${card.expires_at}" data-ct-local>${String(card.expires_at).slice(0, 10)}</time>`);
            if (firedIn) meta.push(/^\/chat\/tsk_[0-9A-HJKMNP-TV-Z]{26}$/.test(firedIn)
                ? html`Fired in <a href="${firedIn}">this conversation</a>`
                : html`Fired in ${String(firedIn)}`);
        }
        // A goal's progress in one line (plan HO3): "Run 4 of at most 12 · not yet: €134".
        if (goal) {
            const used = Number(goal.runs_used) || 0;
            const cap = goal.runs_max == null ? null : Number(goal.runs_max);
            const spend = goal.budget_usd == null ? '' : ` · $${Number(goal.spent_usd || 0).toFixed(2)} of $${Number(goal.budget_usd).toFixed(2)}`;
            const nobody = done || paused || gone ? '' : (goal.not_yet ? ` · not yet: ${clip(goal.not_yet, 120)}` : '');
            meta.push(html`<span class="ct-trig-goal">Run ${used}${cap == null ? '' : ` of at most ${cap}`}${spend}${nobody}</span>`);
            if (goal.deadline_at && !done && !gone) meta.push(html`until <time datetime="${new Date(goal.deadline_at).toISOString()}" data-ct-local>${new Date(goal.deadline_at).toISOString().slice(0, 10)}</time>`);
        }
        if (!gone && !paused && !done && card.next_run_at) meta.push(html`Next run <time datetime="${new Date(card.next_run_at).toISOString()}" data-ct-local>${new Date(card.next_run_at).toISOString().slice(0, 16).replace('T', ' ')} UTC</time>`);
        if (last) meta.push(html`<a href="/tasks/${last.task_id}">Last run ${LAST_RUN[last.state]}</a>`);
        if (card.agent_name) meta.push(html`Runs as ${card.agent_name}`);
        const moves = gone || readOnly ? '' : html`<div class="ovt-card-acts">
${paused ? html`<button type="submit" class="ovt-card-btn" name="do" value="resume">Resume</button>` : ''}
${!paused && !done ? html`<button type="submit" class="ovt-card-btn is-quiet" name="do" value="pause">Pause</button>` : ''}
${done || card.kind === 'mention' ? '' : html`<button type="submit" class="ovt-card-btn is-quiet" name="do" value="run">Run now</button>`}
${undoable ? html`<button type="submit" class="ovt-card-btn is-quiet" name="do" value="undo">Undo</button>`
        : html`<details class="ct-trig-del"><summary class="ovt-card-btn is-quiet">Delete</summary><p>Delete it for good? No future run happens.</p><button type="submit" class="ovt-card-btn is-danger" name="do" value="delete">Delete it</button></details>`}
</div>`;
        // The two switches (plan HO4): answer in this chat, and also tell me through notifications.
        const switches = gone || readOnly ? '' : html`<div class="ovt-card-acts ct-trig-switches">
<button type="submit" class="ovt-card-btn is-quiet${card.answer_in_chat === false ? '' : ' is-on'}" name="do" value="${card.answer_in_chat === false ? 'answer-on' : 'answer-off'}" aria-pressed="${card.answer_in_chat === false ? 'false' : 'true'}">Answer in this chat: ${card.answer_in_chat === false ? 'off' : 'on'}</button>
<button type="submit" class="ovt-card-btn is-quiet${card.notify ? ' is-on' : ''}" name="do" value="${card.notify ? 'notify-off' : 'notify-on'}" aria-pressed="${card.notify ? 'true' : 'false'}">Tell me too: ${card.notify ? 'on' : 'off'}</button>
</div>`;
        const shown = runs.slice(-8).map(runPost);
        return html`<form class="ovt-card ct-trig${paused ? ' is-paused' : ''}${gone ? ' is-gone' : ''}${done ? ' is-done' : ''}" method="post" action="/chat/${row.id}/trigger/${card.id}" data-ct-trigger="${card.id}">
<p class="ovt-card-h">${raw(glyphs.svg(icon, { size: 18 }))}<span class="ct-trig-when"><b>${words}</b>${zone}</span><span class="ct-trig-state">${state}</span></p>
<p class="ct-trig-task">${String(card.task || '')}</p>
${goal && goal.text ? html`<p class="ct-trig-goal-text">${clip(goal.text, 400)}</p>` : ''}
${meta.length ? html`<p class="ct-trig-meta">${meta.map((m, i) => html`${i ? ' · ' : ''}${m}`)}</p>` : ''}
${why ? html`<p class="ct-trig-why">${why}</p>` : ''}
${moves}${switches}</form>
${shown.length ? html`<div class="ct-trig-runs">${shown}</div>` : ''}`;
    }

    /** The files beside the question (thread.files draws them). */
    function filesOf(row, files) {
        return (files || []).map((f) => ({ href: `/chat/file/${row.id}/${f.id}`, name: f.name, size: f.size, image: inputs.IMAGE.test(f.mime) }));
    }

    /**
     * The canvas (plan HO9): the data document actor.canvas@1, drawn by openvibe-shared's ov-canvas.js. The wide
     * layout puts it in the thread's third column; a phone gets the same document as a fold directly above the
     * composer. The document rides in a template (inert, never executed), so the page has it before the script runs,
     * and the fallback says what it is before that. For somebody a run was shared with there is no canvas: it
     * belongs to the conversation's owner, not to one shared turn.
     */
    const canvasItems = (n) => `${n} item${n === 1 ? '' : 's'}`;
    const canvasJson = (doc) => raw(JSON.stringify(doc).replace(/</g, '\\u003c').replace(/&/g, '\\u0026'));
    function canvasFallback(doc) {
        return html`<p class="cc-canvas-fallback"><b>${doc.title}</b><span>${canvasItems(canvases.countOf(doc))}. This panel is drawn on the page.</span></p>`;
    }
    function canvasWide(doc) {
        const n = canvases.countOf(doc);
        return html`<aside class="ovt-panel cc-canvas cc-canvas-wide" aria-label="Canvas" data-cc-canvas data-thread="${doc.thread}">
<div class="ovt-panel-head"><h2>Canvas</h2><span class="cc-canvas-count" data-cc-canvas-count>${canvasItems(n)}</span></div>
<div class="cc-canvas-body"><div class="cc-canvas-host" data-cc-canvas-host>${canvasFallback(doc)}</div>
<template data-cc-canvas-doc>${canvasJson(doc)}</template></div></aside>`;
    }
    function canvasPhone(doc) {
        const n = canvases.countOf(doc);
        return html`<details class="cc-canvas cc-canvas-phone" data-cc-canvas data-thread="${doc.thread}">
<summary><span class="cc-canvas-label">Canvas</span><span class="cc-canvas-sep" aria-hidden="true">·</span><span class="cc-canvas-count" data-cc-canvas-count>${canvasItems(n)}</span><span class="cc-canvas-updated" data-cc-canvas-updated aria-live="polite" hidden>updated</span><span class="cc-canvas-chev" aria-hidden="true">▾</span></summary>
<div class="cc-canvas-body"><div class="cc-canvas-host" data-cc-canvas-host>${canvasFallback(doc)}</div>
<template data-cc-canvas-doc>${canvasJson(doc)}</template></div></details>`;
    }

    async function turnHtml(row, { events = null, files = null, readOnly = false } = {}) {
        const attached = files || (await inputs.list(s, [row.id])).get(row.id) || [];
        const t = store.toWire(row, { baseUrl: config.baseUrl });
        const evs = events || await store.eventsDetailed(s, row.id, 0);
        const open = OPEN.includes(row.state);
        let reply;
        if (row.state === 'succeeded') reply = html`${workBlock(row, evs, false)}${screenBlock(row, evs, false)}${answerBlock(row, t)}`;
        else if (row.state === 'needs_you') reply = html`${workBlock(row, evs, false)}${questionBlock(row, evs, readOnly)}`;
        else if (row.state === 'failed') reply = html`${workBlock(row, evs, false)}${failedBlock(row, t, readOnly)}`;
        else if (row.state === 'cancelled') reply = html`${workBlock(row, evs, false)}<p class="ct-stopped">Stopped. What it spent before stopping stays spent.</p>`;
        else {
            // A running turn is a card in the conversation (one-agent system, stage 1). A turn parked on a wait still
            // says what it waits for (plan A2).
            const parked = ctx.waits && typeof ctx.waits.listForTask === 'function' ? (await ctx.waits.listForTask(row.id).catch(() => [])).find((w) => w.status === 'waiting') : null;
            // The desk's own tile is the live picture (See it work, W1): the old separate screen panel stays only for a
            // run that has no desk to stream (a single look), so there is never a second, empty Live box under the card.
            reply = html`${runCard(row, evs, readOnly)}${deskContext(evs) ? '' : screenBlock(row, evs, true)}${waitBlock(row, parked, readOnly)}`;
        }
        // See it work (W1): a finished run keeps a replay of the pictures its steps saw.
        if (!readOnly && ['succeeded', 'failed', 'cancelled'].includes(row.state)) {
            const shown = await replayBlock(row).catch(() => '');
            if (shown) reply = html`${reply}${shown}`;
        }
        // A routine the turn made is its card, after whatever the turn said (plan §12 A-4).
        const routines = await triggerBlocks(row, evs, readOnly);
        if (routines) reply = html`${reply}${routines}`;
        if (!readOnly && row.state === 'succeeded' && /^agent:agt_/.test(String(row.via || ''))) {
            const draft = await s.db.maybe("SELECT * FROM actor_agent_proposals WHERE owner = $1 AND agent_id = $2 AND from_task = $3 AND kind = 'skill' AND state = 'pending'", [row.requester, row.via.slice(6), row.id]);
            if (draft) reply = html`${reply}${require('./skill-draft-card').card(row.via.slice(6), draft)}`;
        }
        // data-task and data-last are Actor's (js/chat.js follows the task's event stream from data-last).
        return raw(thread.turn({ id: row.id, state: row.state, open, you: { text: row.task, files: filesOf(row, attached) }, reply: String(reply), attrs: { 'data-task': row.id, 'data-last': row.last_seq } }));
    }

    // ── The page ───────────────────────────────────────────────────────────────────────────────────────────────────
    function sidebar(chats, currentId, { settings = false } = {}) {
        return raw(thread.sidebar({
            newHref: '/chat',
            groups: thread.group(chats, (c) => c.last, now()).map((g) => ({
                name: g.name,
                items: g.items.map((c) => ({ href: `/chat/${c.id}`, title: c.title, current: c.id === currentId, live: c.open })),
            })),
            findAction: '/chat',
            // Actor's places as the network sidebar's rows, as Codes' are (kit.sidebar, plan L35). The Console is
            // folded into this chat (one-agent system, stage 1), so Settings takes its row.
            nav: [{ href: '/chat/settings', label: 'Settings', icon: 'sliders', here: settings }, { href: '/me/agents', label: 'Your agents', icon: 'robot' }, { href: '/memory', label: 'Memory', icon: 'book' }],
        }));
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
<ul class="ccm-list">${modelPrefs.KEY_PROVIDERS.map((p) => html`<li class="ccm-own" data-ccm-provider="${p}">${item(`own:${p}`, PROVIDER_NAMES[p] || p, 'Your key, kept in OpenVibe.AI')}<a class="ccm-setup" href="${allowUrl(p)}" target="_blank" rel="noopener" data-ccm-setup>Set up</a></li>`)}</ul>
<p class="ccm-head">Your computer</p>
<ul class="ccm-list"><li class="ccm-own" data-ccm-provider="node">${item('own:link', 'Your computer', 'A model you run at home, through OpenVibe Link. Nothing billed.')}<a class="ccm-setup" href="${allowUrl('link')}" target="_blank" rel="noopener" data-ccm-setup>Set up</a></li></ul>
<p class="ccm-fine" data-ccm-fine>A key you add stays sealed in OpenVibe.AI: Actor never sees it, and only uses it once you allow Actor there. <a href="/chat/model">All settings</a></p>
</div></details>`;
    }

    /**
     * The model field of /chat/model (PLAN G-P9; ACTOR_AI_CATALOG, off by default). With OpenVibe.AI's catalog read,
     * the dynamic aliases come first (marked Dynamic) and then the exact ids, each with its retail output price and
     * availability in the option's data-desc/data-state for Shared's select; the chosen id is posted unchanged. With
     * no catalog (the flag off, a failed read, or AI's legacy single model) it is the plain input it always was.
     */
    function modelField(models, current) {
        if (!Array.isArray(models) || !models.length) {
            return html`<label class="cm-modelid"><span>A model id, if you want one <small>(leave empty and OpenVibe.AI picks the provider's best fit)</small></span><input name="model" value="${current || ''}" maxlength="120" pattern="[A-Za-z0-9][A-Za-z0-9._:/\-]{0,119}" placeholder="for example gpt-5.1, claude-sonnet-4-5, deepseek-chat" spellcheck="false" autocomplete="off"></label>`;
        }
        const option = (e) => {
            const desc = e.output_nano_usd_per_m ? aiCatalog.priceDescription(e.output_nano_usd_per_m)
                : (e.dynamic ? 'Dynamic: the router picks the model per request; the price follows it' : 'Output price not listed');
            const label = e.dynamic ? `${e.id} · ${e.name}` : e.id;
            return html`<option value="${e.id}"${e.id === current ? raw(' selected') : ''}${e.dynamic ? raw(' data-badge="Dynamic"') : ''} data-desc="${desc}" data-state="${e.state}"${e.available ? '' : raw(' disabled')}>${label}</option>`;
        };
        const aliases = models.filter((e) => e.dynamic);
        const exact = models.filter((e) => !e.dynamic);
        const saved = current && !models.some((e) => e.id === current);
        return html`<label class="cm-modelid"><span>A model id, if you want one <small>(an alias lets OpenVibe.AI pick per request; an exact id pins one build)</small></span>
<select name="model" data-ov-title="A model for OpenVibe.AI">
<option value="">OpenVibe.AI picks the provider's best fit</option>${saved ? html`<option value="${current}" selected>${current}</option>` : ''}${aliases.length ? html`<optgroup label="Dynamic aliases">${aliases.map(option)}</optgroup>` : ''}${exact.length ? html`<optgroup label="Exact ids">${exact.map(option)}</optgroup>` : ''}
</select></label>`;
    }

    const ATTACH_ACCEPT = '.txt,.md,.csv,.tsv,.json,.jsonl,.yaml,.yml,.toml,.xml,.html,.css,.js,.ts,.py,.rb,.go,.rs,.java,.c,.cpp,.cs,.php,.sh,.sql,.log,.srt,.vtt,text/*,.pdf,application/pdf,image/png,image/jpeg,image/webp,image/gif';

    /**
     * The composer, on openvibe-shared's composer v2 (4.215.0) with the agent preset: Attach and Speak on the left, the
     * mode chip and the round send on the right, the files above the box with their progress. js/chat.js mounts it; this
     * server-rendered form is what a browser without script gets, and the host it is replaced in.
     *
     * The mode chip is the router's modes (11-12: "the current Fast/Balanced/Best modes"); the model is no longer a
     * second control here, it is in Settings (/chat/model). The allowance is one quiet line under the box.
     */
    function composer({ parent = null, mode = 'balanced', busy = false, working = null, problem = null, text = '', allowance = null } = {}) {
        const placeholder = working ? 'Tell Actor something while it works' : parent ? 'Reply to Actor' : 'Ask Actor to do something';
        const fallback = html`<form class="ct-composer-fallback" method="post" action="${working ? `/chat/${working}/steer` : '/chat'}">
${parent ? html`<input type="hidden" name="parent" value="${parent}">` : ''}<textarea name="task" rows="2" maxlength="20000" required placeholder="${placeholder}" aria-label="Message Actor">${text}</textarea>
<div class="ct-composer-fallback-row"><label class="ct-composer-mode">Mode <select name="mode">${MODE_CHOICES.map(([v, label]) => html`<option value="${v}"${v === mode ? raw(' selected') : ''}>${label}</option>`)}</select></label><button type="submit">Send</button></div>
</form>`;
        return raw(`<div class="ct-composer-wrap">${problem ? String(html`<p class="cc-problem" role="alert">${problem}</p>`) : ''}<div class="cc-composer" id="cc-composer" data-cc-composer data-action="${working ? `/chat/${working}/steer` : '/chat'}" data-parent="${parent || ''}" data-mode="${mode}" data-working="${working || ''}" data-max-files="4" data-max-mb="6" data-accept="${ATTACH_ACCEPT}"${text ? ` data-text="${esc(text)}"` : ''}${busy ? ' data-busy="1"' : ''}>${String(fallback)}</div>
<p class="cc-allowance">Actor checks each answer with a second model.${allowance ? ` ${allowance}` : ''}</p></div>`);
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

    /** The tasks running for this person, with their newest event (the "Now" strip's last step). */
    async function liveFor(requester) {
        const rows = await s.db.many('SELECT * FROM tasks WHERE requester = $1 AND state = ANY($2) ORDER BY id DESC LIMIT 20', [requester, NOW_STATES]);
        const events = await Promise.all(rows.map((row) => store.lastEvent(s, row.id).catch(() => null)));
        return rows.map((row, i) => ({ row, event: events[i] }));
    }

    /**
     * A run's page, or the same conversation read-only for somebody it was shared with: no sidebar, no composer and
     * no turn that asks or retries. The Share button is its owner's; a reader gets Send it only.
     */
    async function render(req, res, { row = null, problem = null, text = '', status = 200, shared = false } = {}) {
        const requester = requesterOf(req);
        const [chats, turns, today, live] = await Promise.all([
            shared ? Promise.resolve([]) : chatsFor(requester),
            row ? chainOf(row) : [],
            shared ? Promise.resolve({ usd: 0 }) : store.spendToday(s, requester),
            shared ? Promise.resolve([]) : liveFor(requester),
        ]);
        const first = turns[0] || null;
        const lastTurn = turns[turns.length - 1] || null;
        const busy = Boolean(lastTurn && (OPEN.includes(lastTurn.state) || lastTurn.state === 'needs_you'));
        const fileMap = await inputs.list(s, turns.map((t) => t.id));
        const canvasRow = row && !shared && first ? await canvases.forThread(s, first.id) : null;
        const canvasDoc = canvasRow ? canvases.docOf(canvasRow) : null;
        const turnHtmls = await Promise.all(turns.map((t) => turnHtml(t, { files: fileMap.get(t.id) || [], readOnly: shared })));
        const title = first ? clip(first.task, 60) : 'New chat';
        // The run settings are in Settings now (one-agent system, stage 1); the chat only carries the model in its head.
        const actions = `${row ? String(shareButton(row, !shared)) : ''}${shared ? '' : `<a class="ovt-btn" href="/chat/settings" title="Settings" aria-label="Settings">${glyphs.svg('gear', { size: 18 })}</a>`}`;
        return send(res, status, {
            viewer: req.viewer, config, path: req.originalUrl, title, app: true, noReferrer: true,
            // The network's sidebar (kit.css, kit-web.js) and its conversation UI (thread.css, ov-thread.js); composer
            // v2 draws the box (ov-composer.js, 4.215.0).
            css: ['css/chat.css', 'css/skill-draft.css'], scripts: ['js/desks.js', 'js/chat.js'], styles: ['kit.css', 'thread.css', 'ov-share.css', 'ov-upload.css'],
            sharedScripts: ['kit-web.js', 'ov-thread.js', 'ov-composer.js', 'ov-share.js', 'ov-canvas.js', 'ov-upload.js'],
            body: html`${busy && !shared ? raw('<noscript><meta http-equiv="refresh" content="5"></noscript>') : ''}
<div class="chat" data-chat="${first ? first.id : ''}">${raw(thread.page({
                sidebar: shared ? '' : String(sidebar(chats, first ? first.id : null)),
                head: String(thread.head({ title, newHref: shared ? null : (first ? '/chat' : null), actions })) + (shared ? '' : String(nowStrip(live))),
                turns: turnHtmls.map(String),
                empty: first ? '' : String(html`<div class="ct-hello"><span class="ct-hello-mark" aria-hidden="true"></span><h2>What should Actor do?</h2><p>It browses, clicks and types for you. Watch it work, steer it, or go do something else.</p>
<ul class="ct-suggest">${STARTERS.slice(0, 4).map(([icon, k, v]) => html`<li><button type="button" class="ct-suggest-chip" data-ovt-starter="${v}">${raw(glyphs.svg(icon, { size: 16 }))}<span>${k}</span></button></li>`)}</ul></div>`),
                composer: shared ? '' : String(html`${canvasDoc ? canvasPhone(canvasDoc) : ''}${composer({ parent: lastTurn ? lastTurn.id : null, mode: lastTurn ? lastTurn.mode : 'balanced', busy, working: lastTurn && OPEN.includes(lastTurn.state) ? lastTurn.id : null, problem, text, allowance: leftLine(config.allowance, today) })}`),
                panel: canvasDoc ? String(canvasWide(canvasDoc)) : '',
                label: first ? 'Conversation' : 'New chat',
            }))}${shared ? html`<p class="ct-shared-note">This run was shared with you. Only its owner can carry it on.</p>` : ''}</div>`,
        });
    }

    const loginTo = (req) => `/auth/login?next=${encodeURIComponent(req.originalUrl)}`;

    r.post('/chat/defaults', express.urlencoded({ extended: false, limit: '1kb' }), async (req, res) => {
        res.set('Cache-Control', cache.htmlHeaders({ private: true }));
        if (!signedIn(req)) return res.redirect(303, loginTo(req));
        if (!sameOrigin(req, config.baseUrl)) return res.status(403).type('text/plain').send('Change this on openvibe.actor itself.');
        if (!sharing) return res.redirect(303, '/chat');
        const body = req.body || {};
        const audience = ['private', 'people', 'link', 'public'].includes(body.audience) ? body.audience : 'private';
        await sharing.setDefault(requesterOf(req), audience, { applyAll: String(body.apply_all || '') === '1' })
            .catch((e) => ctx.log.warn('[Actor] the run default was not saved:', e.message));
        return res.redirect(303, body.from === 'settings' ? '/chat/settings?saved=1' : '/chat');
    });

    /**
     * Actor's Settings (one-agent system, stage 1): the run defaults moved off the chat ("New runs: Only me … Apply to
     * all my existing runs"), the model and where it runs, and what has been spent. The same route (/chat/defaults)
     * and the same behaviour; it is simply a page of its own now, reached from the chat's head and its sidebar.
     */
    /**
     * The connectors of a person (plan §Z.6): one row per connector the owner left on, with its switch, what it does
     * and its risk in words. A connector the owner turned off is shown as "Off for everyone" and has no switch:
     * the owner's switch wins over anybody's own.
     */
    const connectorRows = async (requester) => {
        const state = await connectors.load(s, { requester });
        return connectors.manifest().map((c) => state.connectors[c.id]);
    };

    const connectorRowHtml = (row) => row.offForEveryone
        ? html`<div class="cn-conn-row cn-conn-off"><div class="cn-conn-text"><b>${row.name}</b><span>${row.what}</span>
<span class="cn-conn-meta">Off for everyone — the owner of this Actor turned it off</span></div></div>`
        : html`<div class="cn-conn-row"><div class="cn-conn-text"><b>${row.name}</b><span>${row.what}</span>
<span class="cn-conn-meta">${connectors.RISK_WORDS[row.risk] || row.risk}${row.cap != null ? ` · ${row.calls} of ${row.cap} calls used today` : ''}</span></div>
<div class="cn-conn-switch"><input type="hidden" name="c_${row.id}" value="0">
<input class="ovk-switch" type="checkbox" role="switch" name="c_${row.id}" value="1"${row.enabled ? raw(' checked') : ''} aria-label="${row.name}">
<span class="cn-conn-state">${row.enabled ? 'On' : 'Off'}</span></div></div>`;

    /** How your agent asks (plan 11c): the three starter buttons, the files and network defaults, and the rules. */
    const PRESET_TEXT = {
        careful: ['Careful', 'Asks before it changes, sends, spends or signs in to anything.'],
        balanced: ['Balanced', 'Changes go by your approval level; sending, spending and logins ask.'],
        'hands-off': ['Hands-off', 'Changes go ahead; sending and spending still ask.'],
    };
    const ruleRowHtml = (rule, i, removable) => {
        const w = runPolicy.ruleWords(rule);
        return html`<div class="cn-conn-row rp-rule"><div class="cn-conn-text"><b>${w.decision}</b><span>${w.what}</span>
${w.why ? html`<span class="cn-conn-meta">${w.why}</span>` : ''}</div>
${removable ? html`<div class="cn-conn-switch"><button class="sc-btn rp-remove" type="submit" name="remove" value="${String(i)}" aria-label="Remove the rule: ${w.decision} ${w.what}">Remove</button></div>` : ''}</div>`;
    };
    const runPolicyHtml = async (requester, saved) => {
        const mine = await runPolicy.read(s, requester);
        const site = await runPolicy.read(s, runPolicy.SITE);
        const current = runPolicy.presetOf(mine.rules);
        const files = mine.files || runPolicy.DEFAULTS.files;
        const network = mine.network || runPolicy.DEFAULTS.network;
        const opt = (value, label, on) => html`<option value="${value}"${on ? raw(' selected') : ''}>${label}</option>`;
        return html`<section class="ct-settings-card" aria-labelledby="ct-set-asks"><h2 id="ct-set-asks">How your agent asks</h2>
<p>Pick a starting point, then change what your runs may touch. Money, passwords, deleting and a new recipient always ask, whatever you pick.</p>
${saved ? html`<p class="cm-ok" role="status">Saved. Your next run uses these settings.</p>` : ''}
<form method="post" action="/chat/run-policy" class="rp-form">
<div class="rp-presets" role="group" aria-label="Starting points">
${Object.keys(runPolicy.PRESETS).map((id) => html`<button class="rp-preset${current === id ? ' is-current' : ''}" type="submit" name="preset" value="${id}"${current === id ? raw(' aria-pressed="true"') : raw(' aria-pressed="false"')}><b>${PRESET_TEXT[id][0]}</b><span>${PRESET_TEXT[id][1]}</span></button>`)}
</div>
<div class="rp-settings">
<label>Your files and computers <select name="files">${opt('write', 'Read and change', files === 'write')}${opt('read', 'Read only', files === 'read')}${opt('none', 'Not at all', files === 'none')}</select></label>
<label>The open web <select name="network">${opt('on', 'On', network === 'on')}${opt('off', 'Off', network === 'off')}</select></label>
<button class="sc-btn" type="submit" name="save" value="1">Save</button>
</div>
${mine.rules.length ? html`<h3 class="rp-head">Your rules <span>the last one that matches decides</span></h3>
<div class="cn-conn">${mine.rules.map((rule, i) => raw(ruleRowHtml(rule, i, true)))}</div>` : html`<p class="cn-conn-meta">No rules of your own: your approval level decides.</p>`}
</form>
${site.rules.length ? html`<h3 class="rp-head">Rules for everyone <span>set by the owner of this Actor; they come first</span></h3>
<div class="cn-conn">${site.rules.map((rule, i) => raw(ruleRowHtml(rule, i, false)))}</div>` : ''}
<p class="ct-settings-foot">Every rule can also be written through the API: <code>PUT /api/v1/me/run-policy</code>.</p></section>`;
    };

    r.get('/chat/settings', async (req, res) => {
        res.set('Cache-Control', cache.htmlHeaders({ private: true }));
        if (!signedIn(req)) return res.redirect(303, loginTo(req));
        const requester = requesterOf(req);
        const chats = await chatsFor(requester);
        const current = sharing ? await sharing.defaultOf(requester).catch(() => 'private') : 'private';
        const saved = req.query.saved === '1';
        const connectorsSaved = req.query.saved === 'connectors';
        const connectorList = await connectorRows(requester);
        // The owner of this Actor may change the switches of everyone; they find their own page from here.
        const ownerLink = siteOwner.isOwner({ viewer: req.viewer, config })
            ? html`<a href="/owner/connectors">Connectors for everyone</a> — you are the owner of this Actor.`
            : null;
        const body = html`<div class="ct-settings">
<h1>Settings</h1>
<p class="ct-settings-lede">How your runs start and what they run on. Every run's own Share button still changes just that run.</p>
${saved ? html`<p class="cm-ok" role="status">Saved. Your next run starts as ${AUDIENCE_TEXT[current] || 'Only me'}.</p>` : ''}
<section class="ct-settings-card" aria-labelledby="ct-set-runs"><h2 id="ct-set-runs">Your runs</h2>
<p>Who can see the runs you start from now on. "Apply to all my existing runs" moves the ones you already have.</p>
${raw(await defaultsHtml(requester, { from: 'settings' }))}
<p class="ct-settings-foot"><a href="/me/spend">What you have spent</a> · <a href="/tasks">Your tasks</a></p></section>
<section class="ct-settings-card" aria-labelledby="ct-set-model"><h2 id="ct-set-model">The model your tasks run on</h2>
<p>OpenVibe's own keys, your own key for a provider, or a model you run on your own computer. The model and where it runs are one page.</p>
<p><a class="sc-btn" href="/chat/model">Open the model settings</a></p></section>
<section class="ct-settings-card" aria-labelledby="ct-set-connectors"><h2 id="ct-set-connectors">Connectors</h2>
<p>What your agent may reach. Turn one off and your agent will not use it. The owner of this Actor may turn one off for everyone.</p>
${connectorsSaved ? html`<p class="cm-ok" role="status">Saved. Your next run uses these connectors.</p>` : ''}
<form method="post" action="/chat/connectors">
${connectorList.map((row) => raw(connectorRowHtml(row)))}
<p><button class="sc-btn" type="submit">Save</button></p>
</form>
${ownerLink ? html`<p class="ct-settings-foot">${ownerLink}</p>` : ''}
</section>
${raw(await runPolicyHtml(requester, req.query.saved === 'run-policy'))}
</div>`;
        return send(res, 200, {
            viewer: req.viewer, config, path: req.originalUrl, title: 'Settings', app: true, noReferrer: true,
            css: ['css/chat.css', 'css/connectors.css'], scripts: [], styles: ['kit.css', 'thread.css'],
            body: raw(thread.page({
                sidebar: String(sidebar(chats, null, { settings: true })),
                head: thread.head({ title: 'Settings', newHref: '/chat' }),
                main: String(body),
                label: 'Settings',
            })),
        });
    });

    // The person's own connectors (plan §Z.6): the form on the Settings page, one switch per connector. A
    // connector the owner turned off is off for everyone: the person may not turn it on, and their row for it is
    // left alone.
    r.post('/chat/connectors', express.urlencoded({ extended: false, limit: '4kb' }), async (req, res) => {
        res.set('Cache-Control', cache.htmlHeaders({ private: true }));
        if (!signedIn(req)) return res.redirect(303, loginTo(req));
        if (!sameOrigin(req, config.baseUrl)) return res.status(403).type('text/plain').send('Change this on openvibe.actor itself.');
        const body = req.body || {};
        const requester = requesterOf(req);
        const state = await connectors.load(s, { requester });
        for (const c of connectors.manifest()) {
            if (!state.connectors[c.id].ownerEnabled) continue;
            const given = body[`c_${c.id}`];
            const last = Array.isArray(given) ? given[given.length - 1] : given;
            const enabled = last === '1' || last === 'true';
            await connectors.setPersonSwitch(s, requester, c.id, enabled);
        }
        return res.redirect(303, '/chat/settings?saved=connectors');
    });

    // How your agent asks (plan 11c): a starter button writes the rule list, Save writes files and network, Remove
    // takes one rule out. The same validation as the API.
    r.post('/chat/run-policy', express.urlencoded({ extended: false, limit: '4kb' }), async (req, res) => {
        res.set('Cache-Control', cache.htmlHeaders({ private: true }));
        if (!signedIn(req)) return res.redirect(303, loginTo(req));
        if (!sameOrigin(req, config.baseUrl)) return res.status(403).type('text/plain').send('Change this on openvibe.actor itself.');
        const body = req.body || {};
        const requester = requesterOf(req);
        const patch = {};
        if (typeof body.preset === 'string' && Object.prototype.hasOwnProperty.call(runPolicy.PRESETS, body.preset)) {
            patch.rules = runPolicy.validateRules(runPolicy.PRESETS[body.preset]).value;
        } else if (body.remove != null && /^\d{1,3}$/.test(String(body.remove))) {
            const mine = await runPolicy.read(s, requester);
            patch.rules = mine.rules.filter((_, i) => i !== Number(body.remove));
        } else {
            const settings = runPolicy.validateSettings({ files: body.files, network: body.network });
            if (settings.error) return res.status(422).type('text/plain').send(settings.error);
            Object.assign(patch, settings.value);
        }
        await runPolicy.save(s, requester, patch, requester);
        return res.redirect(303, '/chat/settings?saved=run-policy#ct-set-asks');
    });

    // The "Now" strip, refreshed in place by js/chat.js while a turn is open. Its owner only; empty when nothing runs.
    r.get('/chat/now', async (req, res) => {
        res.set('Cache-Control', 'private, no-store');
        if (!signedIn(req)) return res.status(401).type('text/html').send('');
        return res.type('text/html').send(String(nowStrip(await liveFor(requesterOf(req)))));
    });

    r.get('/chat/model', async (req, res) => {
        res.set('Cache-Control', cache.htmlHeaders({ private: true }));
        if (!signedIn(req)) return res.redirect(303, loginTo(req));
        const model = modelPrefs.wire(await modelPrefs.get(s, requesterOf(req)).catch(() => null));
        const current = model.provider ? `own:${model.provider}` : 'auto';
        // OpenVibe.AI's aliases and exact ids (PLAN G-P9; ACTOR_AI_CATALOG, off by default). No catalog (the flag
        // off, a failed read, or AI's legacy `openvibe`) leaves the plain model input below exactly as it was.
        const aiModels = ctx.models && typeof ctx.models.aiCatalog === 'function' ? await ctx.models.aiCatalog().catch(() => null) : null;
        const saved = req.query.saved === '1';
        const runsSaved = req.query.saved === 'runs';
        const error = typeof req.query.error === 'string' ? req.query.error.slice(0, 200) : '';
        const radio = (choice, title, sub, extra = '') => html`<label class="cm-opt"><input type="radio" name="choice" value="${choice}"${choice === current ? raw(' checked') : ''}><span><b>${title}</b><small>${sub}</small></span>${raw(extra)}</label>`;
        return send(res, 200, {
            viewer: req.viewer, config, path: req.originalUrl, title: 'Your model', app: true, noReferrer: true,
            css: ['css/chat.css'], scripts: [],
            body: html`<main class="cm"><a class="cm-back" href="/chat">${raw(glyphs.svg('back', { size: 18 }))} Chat</a>
<h1>The model your tasks run on</h1>
<p class="cm-lede">Actor can run on OpenVibe's keys, on your own key for a provider you use, or on a model you run on your own computer. Your key stays sealed in OpenVibe.AI: Actor never sees it, and only uses it (or your computer) after you allow Actor there.</p>
${saved ? html`<p class="cm-ok" role="status">Saved. Your next task runs on ${modelLabel(model)}.</p>` : ''}${error ? html`<p class="cm-err" role="alert">${error}</p>` : ''}
<form class="cm-form" method="post" action="/chat/model">
${radio('auto', 'Auto, OpenVibe\'s', 'Actor picks a model for each step, on OpenVibe\'s keys. Free within the daily allowance.')}
<p class="cm-head">Your own key</p>
${modelPrefs.KEY_PROVIDERS.map((p) => radio(`own:${p}`, PROVIDER_NAMES[p] || p, 'Billed by the provider to you, not counted against Actor\'s allowance.', `<a class="cm-setup" href="${allowUrl(p).replace(/&/g, '&amp;')}" target="_blank" rel="noopener">Add or allow the key</a>`))}
<p class="cm-head">Your computer</p>
${radio('own:link', 'Your computer', 'A model you run at home (Ollama, LM Studio or llama.cpp) through OpenVibe Link v0.36.0 or newer: nothing is billed, and it answers only while that computer is on. Usually slower than a cloud model.', `<a class="cm-setup" href="${allowUrl('link').replace(/&/g, '&amp;')}" target="_blank" rel="noopener">Add your computer's model and allow Actor</a>`)}
${modelField(aiModels, model.model || '')}
<button class="cm-save" type="submit">Save</button>
</form>
<h2 class="cm-h2" id="runs-on">Where it runs</h2>
<p class="cm-lede">On your computer, the model you run at home does all of Actor's thinking, whatever you picked above, and a coding task runs entirely on your machine through OpenVibe.Codes. Searching and reading the web still happen on OpenVibe. Private mode always stays on OpenVibe's own open model.</p>
${runsSaved ? html`<p class="cm-ok" role="status">Saved. Your next task runs on ${model.runs_on === 'computer' ? 'your computer' : 'OpenVibe'}.</p>` : ''}
<form class="cm-form" method="post" action="/chat/runs-on">
<label class="cm-opt"><input type="radio" name="runs_on" value="openvibe"${model.runs_on !== 'computer' ? raw(' checked') : ''}><span><b>OpenVibe</b><small>Quick, from anywhere, on the model you chose above.</small></span></label>
<label class="cm-opt"><input type="radio" name="runs_on" value="computer"${model.runs_on === 'computer' ? raw(' checked') : ''}><span><b>My computer</b><small>Nothing is billed for the model, and it answers only while your computer is on. Needs OpenVibe Link v0.36.0 or newer with a local model (Ollama, LM Studio or llama.cpp). Usually slower.</small></span><span class="cm-setups"><a class="cm-setup" href="${allowUrl('link')}" target="_blank" rel="noopener">Add your computer's model</a><a class="cm-setup" href="https://openvibe.link/machines" target="_blank" rel="noopener">Add your machine for coding</a></span></label>
<button class="cm-save" type="submit">Save</button>
</form></main>`,
        });
    });

    r.post('/chat/model', express.urlencoded({ extended: false, limit: '4kb' }), async (req, res) => {
        res.set('Cache-Control', cache.htmlHeaders({ private: true }));
        if (!signedIn(req)) return res.redirect(303, loginTo(req));
        if (!sameOrigin(req, config.baseUrl)) return res.status(403).type('text/plain').send('Change this on openvibe.actor itself.');
        const body = req.body || {};
        const out = await modelPrefs.put(s, requesterOf(req), { choice: body.choice, model: body.model ? String(body.model) : null },
            { exactIds: Boolean(config.ai && config.ai.catalog) });
        if (out.error) return res.redirect(303, `/chat/model?error=${encodeURIComponent('That did not save: ' + out.error)}`);
        return res.redirect(303, '/chat/model?saved=1');
    });

    r.post('/chat/runs-on', express.urlencoded({ extended: false, limit: '1kb' }), async (req, res) => {
        res.set('Cache-Control', cache.htmlHeaders({ private: true }));
        if (!signedIn(req)) return res.redirect(303, loginTo(req));
        if (!sameOrigin(req, config.baseUrl)) return res.status(403).type('text/plain').send('Change this on openvibe.actor itself.');
        const out = await modelPrefs.setRunsOn(s, requesterOf(req), (req.body || {}).runs_on);
        if (out.error) return res.redirect(303, `/chat/model?error=${encodeURIComponent('That did not save: ' + out.error)}#runs-on`);
        return res.redirect(303, '/chat/model?saved=runs#runs-on');
    });

    r.get('/chat', async (req, res) => {
        res.set('Cache-Control', cache.htmlHeaders({ private: true }));
        if (!signedIn(req)) return res.redirect(303, loginTo(req));
        const text = typeof req.query.ask === 'string' ? req.query.ask.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').slice(0, 2000) : '';
        return render(req, res, { text });
    });

    r.get('/chat/turn/:id', async (req, res) => {
        res.set('Cache-Control', cache.htmlHeaders({ private: true }));
        if (!TASK_ID.test(req.params.id)) return res.status(404).end();
        const row = await store.getTask(s, req.params.id);
        if (!row) return res.status(404).end();
        const mine = signedIn(req) && row.requester === requesterOf(req);
        if (!mine) {
            const allowed = sharing ? await sharing.canView(req.viewer, row.id).catch(() => false) : false;
            if (!allowed) return res.status(404).end();
        }
        res.type('html').send(require('../render/html').render(await turnHtml(row, { readOnly: !mine })));
    });

    // An attached file, to its own person only: an image shown in place; a PDF downloaded as itself; anything else
    // downloaded as plain text. In a sandbox, never sniffed.
    r.get('/chat/file/:taskId/:id', async (req, res) => {
        res.set('Cache-Control', cache.htmlHeaders({ private: true }));
        if (!TASK_ID.test(req.params.taskId) || !/^inp_[A-Za-z0-9_-]{6,20}$/.test(req.params.id)) return res.status(404).end();
        const row = await store.getTask(s, req.params.taskId);
        if (!row) return res.status(404).end();
        const mine = signedIn(req) && row.requester === requesterOf(req);
        if (!mine) {
            const allowed = sharing ? await sharing.canView(req.viewer, row.id).catch(() => false) : false;
            if (!allowed) return res.status(404).end();
        }
        const f = await inputs.get(s, row.id, req.params.id);
        if (!f) return res.status(404).end();
        const bytes = Buffer.isBuffer(f.bytes) ? f.bytes : Buffer.from(f.bytes || []);
        res.set('X-Content-Type-Options', 'nosniff');
        res.set('Content-Security-Policy', "default-src 'none'; sandbox");
        if (inputs.IMAGE.test(f.mime) && f.mime !== 'image/svg+xml') return res.type(f.mime).send(bytes);
        res.set('Content-Disposition', `attachment; filename="${String(f.name).replace(/[^A-Za-z0-9._-]/g, '_')}"`);
        if (f.mime === inputs.PDF) return res.type(inputs.PDF).send(bytes);
        return res.type('text/plain; charset=utf-8').send(bytes);
    });

    /**
     * A run's page is its owner's. Someone it was shared with reads the same conversation without the composer or a
     * turn's moves; anybody else gets the gate for Specific people, or "not found" when it is Only me.
     */
    r.get('/chat/:id', async (req, res) => {
        res.set('Cache-Control', cache.htmlHeaders({ private: true }));
        const row = TASK_ID.test(req.params.id) ? await store.getTask(s, req.params.id) : null;
        const mine = Boolean(row && signedIn(req) && row.requester === requesterOf(req));
        if (row && !mine) {
            const allowed = sharing ? await sharing.canView(req.viewer, row.id).catch(() => false) : false;
            if (allowed) return render(req, res, { row, shared: true });
            const audience = sharing ? await sharing.audienceOf(row.id).catch(() => null) : null;
            if (audience === 'people') return sharedGate(req, res, row.id);
            return render(req, res, { status: 404, problem: 'That chat is not here: it may have expired (tasks are kept 30 days) or belong to someone else.' });
        }
        if (!mine) {
            if (!signedIn(req)) return res.redirect(303, loginTo(req));
            return render(req, res, { status: 404, problem: 'That chat is not here: it may have expired (tasks are kept 30 days) or belong to someone else.' });
        }
        return render(req, res, { row });
    });

    // Stop a running turn from its card in the conversation (or the Now strip), and come back to the chat. The task
    // page keeps its own /tasks/:id/cancel; this is the same cancel with the chat as where you were.
    r.post('/chat/:id/cancel', async (req, res) => {
        res.set('Cache-Control', cache.htmlHeaders({ private: true }));
        const wantsJson = String(req.get('accept') || '').includes('application/json');
        if (!signedIn(req) || !TASK_ID.test(req.params.id)) return wantsJson ? res.status(401).json({ error: 'Sign in first.' }) : res.redirect(303, '/auth/login?next=%2Fchat');
        if (!sameOrigin(req, config.baseUrl)) return res.status(403).type('text/plain').send('A cancel must come from openvibe.actor itself.');
        const row = await store.getTask(s, req.params.id);
        if (!row || row.requester !== requesterOf(req)) return wantsJson ? res.status(404).json({ error: 'That chat is not here.' }) : res.redirect(303, '/chat');
        if (OPEN.includes(row.state)) await engine.cancel(row.id, requesterOf(req));
        if (wantsJson) return res.json({ ok: true });
        return res.redirect(303, `/chat/${row.id}`);
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

    // A parked turn's two moves (plan A2): Wake now, or Stop waiting. The task's own person, from openvibe.actor only.
    r.post('/chat/:id/wait', express.urlencoded({ extended: false, limit: '1kb' }), async (req, res) => {
        res.set('Cache-Control', cache.htmlHeaders({ private: true }));
        const wantsJson = String(req.get('accept') || '').includes('application/json');
        if (!signedIn(req) || !TASK_ID.test(req.params.id)) return wantsJson ? res.status(401).json({ error: 'Sign in first.' }) : res.redirect(303, '/auth/login?next=%2Fchat');
        if (!sameOrigin(req, config.baseUrl)) return res.status(403).type('text/plain').send('Wake or stop a wait from openvibe.actor itself.');
        const row = await store.getTask(s, req.params.id);
        if (!row || row.requester !== requesterOf(req)) return wantsJson ? res.status(404).json({ error: 'That chat is not here.' }) : res.redirect(303, '/chat');
        const move = String((req.body && req.body.do) || '');
        const waits = ctx.waits;
        const open = waits ? (await waits.listForTask(row.id)).find((w) => w.status === 'waiting') : null;
        let done = null;
        if (open && move === 'wake') done = await waits.wakeByPerson(open.id, requesterOf(req));
        else if (open && move === 'cancel') done = await waits.cancel(open.id, requesterOf(req));
        if (wantsJson) return res.status(done ? 202 : 409).json(done ? { ok: true } : { error: open ? 'Say wake or cancel.' : 'It is not waiting any more.' });
        return res.redirect(303, `/chat/${row.id}#t-${row.id}`);
    });

    // A routine's card moves (plan §12 A-4): only the turn's requester, only same-origin, only a trigger this turn made.
    // Watch is called with the person's own session token, never Actor's service token.
    r.post('/chat/:id/trigger/:tid', express.urlencoded({ extended: false, limit: '1kb' }), async (req, res) => {
        res.set('Cache-Control', cache.htmlHeaders({ private: true }));
        const wantsJson = String(req.get('accept') || '').includes('application/json');
        if (!signedIn(req) || !TASK_ID.test(req.params.id) || !TRIGGER_ID.test(req.params.tid)) return wantsJson ? res.status(401).json({ error: 'Sign in first.' }) : res.redirect(303, '/auth/login?next=%2Fchat');
        if (!sameOrigin(req, config.baseUrl)) return res.status(403).type('text/plain').send('Change a routine from openvibe.actor itself.');
        const row = await store.getTask(s, req.params.id);
        if (!row || row.requester !== requesterOf(req)) return wantsJson ? res.status(404).json({ error: 'That chat is not here.' }) : res.redirect(303, '/chat');
        const events = await store.eventsAfter(s, row.id, 0);
        const made = events.some((e) => e && e.step === 'trigger' && e.trigger && e.trigger.id === req.params.tid);
        if (!made || !ctx.triggers) return wantsJson ? res.status(404).json({ error: 'No such routine in this chat.' }) : res.redirect(303, `/chat/${row.id}#t-${row.id}`);
        const owner = req.viewer.subject;
        const token = req.token || (req.viewer && req.viewer.token) || null;
        const move = String((req.body && req.body.do) || '');
        const t = ctx.triggers;
        const out = move === 'pause' ? await t.pause(owner, req.params.tid, { token })
            : move === 'resume' ? await t.resume(owner, req.params.tid, { token })
                : move === 'run' ? await t.runNow(owner, req.params.tid)
                    : move === 'undo' ? await t.undo(owner, req.params.tid, { token })
                        : move === 'delete' ? await t.remove(owner, req.params.tid, { token, confirm: true })
                            // The routine's two switches (HO4): answer in this chat, and also tell me.
                            : move === 'answer-on' || move === 'answer-off' ? await t.setSwitch(owner, req.params.tid, { answerInChat: move === 'answer-on' })
                                : move === 'notify-on' || move === 'notify-off' ? await t.setSwitch(owner, req.params.tid, { notify: move === 'notify-on' })
                                    : { error: { status: 400, detail: 'Say pause, resume, run, undo, delete, answer-on or notify-on.' } };
        if (out && out.error) {
            const status = out.error.status || 409;
            if (wantsJson) return res.status(status).json({ error: out.error.detail || 'That did not change.', code: out.error.code || null });
            return render(req, res, { row, problem: out.error.detail || 'That did not change.', status });
        }
        if (wantsJson) return res.json(out);
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
        'actor.budget.day_spent': 'You have used today\'s free allowance. It comes back at midnight UTC. Add your own model key at /chat/model, and Actor runs on it without charging the allowance.',
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
            // The person's own token and clock for a trigger made in this turn: their Watch, their timezone.
            personToken: req.token || (req.viewer && req.viewer.token) || null,
            timezone: req.cookies && req.cookies.ov_tz ? String(req.cookies.ov_tz).slice(0, 64) : null,
            afterInsert: checked.files.length ? (made) => inputs.save(s, made.id, requesterOf(req), checked.files) : null });
        if (out.code) return fail(out.status === 503 || out.status === 429 ? out.status : 422, PROBLEM[out.code] || out.detail || 'That could not start. Try again in a moment.', parent, text);
        const row = await store.getTask(s, out.task.id);
        if (ctx.triggers && ctx.triggers.onMessage && row.agent_id) {
            let root = parent || row;
            for (let i = 0; i < CHAIN_MAX && isFollow(root); i++) {
                const previous = await store.getTask(s, root.parent_id);
                if (!previous || previous.requester !== row.requester) break;
                root = previous;
            }
            await ctx.triggers.onMessage({ owner: req.viewer.subject, agentId: row.agent_id, text,
                conversation: `chat:${root.id}`, turnTaskId: row.id, place: `/chat/${row.id}` });
        }
        if (wantsJson) return res.status(201).json({ id: row.id, chat: parent ? undefined : row.id, url: `/chat/${row.id}`, turn: require('../render/html').render(await turnHtml(row, { events: [] })) });
        return res.redirect(303, `/chat/${row.id}#t-${row.id}`);
    });

    return r;
}

module.exports = { createChatPages, chatsOf, groupOf };

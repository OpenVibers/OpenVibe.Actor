'use strict';

/**
 * The Console (plan T17 layer 3): one page where a signed-in person sees what their agents, tasks, computers and robots
 * are doing, and tells them what to do next. It is the command interface, not an authority: tasks, agents and approvals
 * are Actor's own; computers and robots are read from OpenVibe.Bot as the person (agents/computers.js, agents/robots.js),
 * and everything else links to the service that owns it (OpenVibe.Services for resources, Watch, Codes).
 *
 * It works without JavaScript: the command box is the ordinary task form (POST /tasks), and while a task is running the
 * page refreshes itself every 10 seconds (a <noscript> refresh; public/js/console.js does it with JavaScript, never
 * while the person is typing a task).
 */
const cache = require('openvibe-shared/cache-policy');
const { asyncRouter } = require('./router');
const { html, raw, time } = require('../render/html');
const { send } = require('../render/layout');
const store = require('../tasks/store');
const personal = require('../agents/personal');
const approvals = require('../agents/approvals');
const catalog = require('../agents/catalog');
const { MODES } = require('../agents/router');
const { createRobots } = require('../agents/robots');
const { createComputers } = require('../agents/computers');
const feed = require('../agents/feed');

const LIVE = new Set(['queued', 'running', 'verifying']);
const STATE_TEXT = { queued: 'Waiting', running: 'Working', verifying: 'Checking', succeeded: 'Done', failed: 'Didn\'t finish', cancelled: 'Cancelled' };
const LEVEL_TEXT = { observe: 'Observe', ask: 'Ask first', trusted: 'Trusted', full: 'Full control' };
const MODE_LABEL = { cheapest: 'Cheapest', balanced: 'Balanced', best: 'Best', fastest: 'Fastest', private: 'Private' };
const BOT_TIMEOUT_MS = 4000;

const usd = (n) => (n == null ? '—' : n === 0 ? '$0' : n < 0.01 ? `$${Number(n).toFixed(4)}` : `$${Number(n).toFixed(2)}`);
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const pct = (a, b) => (b > 0 ? Math.max(0, Math.min(100, Math.round((a / b) * 100))) : 0);

function createConsolePages(ctx, { robots = null, computers = null } = {}) {
    const { config, s } = ctx;
    const r = asyncRouter();
    const bot = { robots: robots || createRobots({ config }), computers: computers || createComputers({ config }) };
    const tier = config.allowance;
    const page = (req, res, o, status = 200) => send(res, status, { viewer: req.viewer, config, path: req.originalUrl, css: ['css/console.css'], ...o });
    const signedIn = (req) => req.viewer && req.viewer.kind === 'user' && req.viewer.subject;
    const pages = config.services.botPublicUrl || 'https://openvibe.bot';

    /** One Bot read, bounded so a slow Bot never holds the page; { ok, value } or { ok: false, why }. */
    async function fromBot(fn) {
        try {
            const value = await fn({ signal: AbortSignal.timeout(BOT_TIMEOUT_MS) });
            if (value && !Array.isArray(value) && value.error) return { ok: false, why: value.error };
            return { ok: true, value };
        } catch { return { ok: false, why: 'OpenVibe.Bot did not answer in time.' }; }
    }

    function commandBox() {
        return html`<form class="cn-command" method="post" action="/tasks" aria-labelledby="cn-command-h">
<h2 id="cn-command-h" class="cn-sr">Give Actor a task</h2>
<label class="cn-sr" for="cn-task">What should Actor do?</label>
<textarea id="cn-task" name="task" rows="2" maxlength="20000" required placeholder="Tell Actor what to do: “check my site's certificate”, “what changed in my repo today?”, “drive my rover to the door”"></textarea>
<div class="cn-command-row"><label class="cn-mode">Mode <select name="mode">${MODES.map((m) => html`<option value="${m}"${m === 'balanced' ? raw(' selected') : ''}>${MODE_LABEL[m]}</option>`)}</select></label>
<button class="cn-run" type="submit">Run it</button></div>
</form>`;
    }

    const taskRow = (t) => {
        const result = t.result ? (typeof t.result === 'string' ? JSON.parse(t.result) : t.result) : null;
        const agent = result ? ((catalog.byId(result.agent) || {}).name || result.agent) : null;
        return html`<li class="cn-task"><span class="pill pill-${t.state}">${STATE_TEXT[t.state] || t.state}</span>
<a href="/tasks/${t.id}">${clip(t.task, 110)}</a>
<span class="cn-meta">${agent ? html`${agent} · ` : ''}${t.cost_usd == null ? '' : html`${usd(Number(t.cost_usd))} · `}${time(t.created_at)}</span></li>`;
    };

    /**
     * Days of spend as bars (a table for screen readers), tallest day = full height. A week labels each day; a month
     * labels every fifth day by its date.
     */
    function spendChart(days, { caption, month = false } = {}) {
        const top = Math.max(...days.map((d) => d.usd), 0);
        const total = days.reduce((n, d) => n + d.usd, 0);
        const date = (d) => new Date(`${d.day}T00:00:00Z`);
        const label = (d, i) => (month
            ? (i % 5 === (days.length - 1) % 5 ? String(date(d).getUTCDate()) : '')
            : date(d).toLocaleDateString('en', { weekday: 'short', timeZone: 'UTC' }).slice(0, 2));
        const name = (d) => date(d).toLocaleDateString('en', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
        return html`<figure class="cn-week${month ? ' cn-month' : ''}"><figcaption>${caption}: <b>${usd(total)}</b>, ${String(days.reduce((n, d) => n + d.tasks, 0))} tasks</figcaption>
<div class="cn-bars" aria-hidden="true"${month ? raw(` style="grid-template-columns:repeat(${days.length},1fr)"`) : ''}>${days.map((d, i) => html`<span class="cn-bar" title="${name(d)}: ${usd(d.usd)}, ${String(d.tasks)} tasks"><i style="height:${String(top > 0 ? Math.max(4, Math.round((d.usd / top) * 100)) : 4)}%"></i><small>${label(d, i)}</small></span>`)}</div>
<table class="cn-sr"><caption>Spend by day</caption><tbody>${days.map((d) => html`<tr><th scope="row">${d.day}</th><td>${usd(d.usd)}</td><td>${String(d.tasks)} tasks</td></tr>`)}</tbody></table></figure>`;
    }

    /** One line of the events feed. */
    const eventRow = (e) => html`<li class="cn-event cn-event-${e.kind}"><span class="cn-ev-dot cn-ev-${e.state}" aria-hidden="true"></span>
<a href="${e.href}">${clip(e.text, 120)}</a>
<span class="cn-meta">${e.by ? html`${e.by} · ` : ''}${e.cost != null ? html`${usd(e.cost)} · ` : ''}${time(e.at)}</span></li>`;

    function computersCard(result) {
        const body = !bot.computers.enabled ? html`<p class="cn-empty">Not connected to OpenVibe.Bot on this server.</p>`
            : !result.ok ? html`<p class="cn-empty">${result.why}</p>`
                : !result.value.computers.length ? html`<p class="cn-empty">No computer is open to your agent. Add one on <a href="${pages}/machines">openvibe.bot/machines</a> with <code>--computer ask</code>, then turn on “Let my agent use this computer”.</p>`
                    : html`<ul class="cn-list">${result.value.computers.map((c) => html`<li><span class="cn-dot${c.online ? ' on' : ''}" aria-hidden="true"></span><b>${c.name || c.id}</b>
<span class="cn-meta">${c.online ? 'Online' : 'Offline'} · ${LEVEL_TEXT[c.level] || 'On'}${c.can.length ? html` · ${c.can.join(', ')}` : ''}</span>
${c.waiting_for_approval ? html`<span class="pill pill-running">${String(c.waiting_for_approval)} waiting on the machine</span>` : ''}
${c.online && c.can.includes('screen') ? html`<a class="cn-link" href="${pages}/machines/${encodeURIComponent(c.id)}/screen">Watch the screen</a>` : ''}</li>`)}</ul>`;
        return html`<section class="cn-card" aria-labelledby="cn-computers"><h2 id="cn-computers">Your computers</h2>${body}
<p class="cn-more"><a href="${pages}/machines">Machines on OpenVibe.Bot</a></p></section>`;
    }

    function robotsCard(result) {
        const body = !bot.robots.enabled ? html`<p class="cn-empty">Not connected to OpenVibe.Bot on this server.</p>`
            : !result.ok ? html`<p class="cn-empty">${result.why}</p>`
                : !result.value.length ? html`<p class="cn-empty">No robot yet. <a href="${pages}/try">Try one in your browser</a> or add yours on <a href="${pages}">openvibe.bot</a>.</p>`
                    : html`<ul class="cn-list">${result.value.map((x) => html`<li><span class="cn-dot${x.online ? ' on' : ''}" aria-hidden="true"></span><a href="${x.panel}"><b>${x.name}</b></a>
<span class="cn-meta">${x.agent_control ? (x.online ? 'Online' : 'Offline') : 'Not open to your agent'}${x.estop && x.estop.latched ? ' · e-stop on' : ''}${typeof x.battery === 'number' ? ` · battery ${Math.round(x.battery * 100)}%` : ''}</span></li>`)}</ul>`;
        return html`<section class="cn-card" aria-labelledby="cn-robots"><h2 id="cn-robots">Your robots</h2>${body}
<p class="cn-more"><a href="${pages}/robots">Robots on OpenVibe.Bot</a></p></section>`;
    }

    r.get('/console', async (req, res) => {
        res.set('Cache-Control', cache.htmlHeaders({ private: true }));
        if (!signedIn(req)) {
            return page(req, res, {
                title: 'Console', crumbs: [{ label: 'Console' }],
                body: html`<header class="cn-head"><p class="cn-eyebrow">OpenVibe.Actor · console</p><h1>Console</h1>
<p class="cn-lede">One place for everything your agents do: the tasks running now, what waits for your approval, your agents, your own computers and robots, and what it all cost today.</p></header>
<p><a class="cn-run" href="/auth/login?next=%2Fconsole">Sign in to open your console</a></p>`,
            });
        }
        const requester = `user:${req.viewer.subject}`;
        const subject = req.viewer.subject;
        const [tasks, today, week, asked, agents, pcs, rovers] = await Promise.all([
            store.listTasks(s, requester, { limit: 30 }),
            store.spendToday(s, requester),
            store.spendDays(s, requester, 7),
            approvals.list(s, requester),
            personal.list(s, requester),
            bot.computers.enabled ? fromBot((o) => bot.computers.mine(subject, o)) : { ok: false },
            bot.robots.enabled ? fromBot((o) => bot.robots.mine(subject, o)) : { ok: false },
        ]);
        const live = tasks.rows.filter((t) => LIVE.has(t.state));
        const events = await feed.lately(s, requester, { approvals: asked, agents, limit: 8 });
        const waiting = asked.filter((a) => a.state === 'pending');
        const onMachines = pcs.ok ? pcs.value.computers.reduce((n, c) => n + (c.waiting_for_approval || 0), 0) : 0;
        const nWaiting = waiting.length + onMachines;
        page(req, res, {
            title: 'Console', crumbs: [{ label: 'Console' }],
            scripts: live.length ? ['js/console.js'] : [],
            body: html`${live.length ? raw('<noscript><meta http-equiv="refresh" content="10"></noscript>') : ''}<header class="cn-head"${live.length ? raw(' data-live="10"') : ''}><p class="cn-eyebrow">OpenVibe.Actor · console · alpha</p><h1>Console</h1>
<p class="cn-lede">What your agents, computers and robots are doing, and one box to tell them what to do next.</p></header>
${commandBox()}
<div class="cn-grid">
<section class="cn-card cn-wide" aria-labelledby="cn-now"><h2 id="cn-now">Now${live.length ? html` <span class="cn-count">${String(live.length)}</span>` : ''}</h2>
${live.length ? html`<ul class="cn-tasks">${live.map(taskRow)}</ul><p class="cn-note">This page refreshes every 10 seconds while something runs.</p>` : html`<p class="cn-empty">Nothing is running.</p>`}</section>
<section class="cn-card${nWaiting ? ' cn-attn' : ''}" aria-labelledby="cn-waiting"><h2 id="cn-waiting">Waiting for you${nWaiting ? html` <span class="cn-count">${String(nWaiting)}</span>` : ''}</h2>
${waiting.length ? html`<ul class="cn-list">${waiting.slice(0, 4).map((a) => html`<li><a href="/me/approvals/${a.id}"><b>${clip(a.summary, 80)}</b></a><span class="cn-meta">Asked ${time(a.created_at)}</span></li>`)}</ul>` : ''}
${onMachines ? html`<p class="cn-note">${String(onMachines)} on your computers: answer them there, in the Node's tray, with a notification's Approve button, or with <code>openvibe-node approvals</code>.</p>` : ''}
${nWaiting ? '' : html`<p class="cn-empty">Nothing waits for you.</p>`}
<p class="cn-more"><a href="/me/approvals">All approvals</a></p></section>
<section class="cn-card" aria-labelledby="cn-today"><h2 id="cn-today">Today</h2>
<p class="cn-stat"><b>${String(today.tasks)}</b> of ${String(tier.tasksPerDay)} free tasks</p>
<div class="cn-meter" role="progressbar" aria-label="Free tasks used today" aria-valuemin="0" aria-valuemax="${String(tier.tasksPerDay)}" aria-valuenow="${String(today.tasks)}"><span style="width:${String(pct(today.tasks, tier.tasksPerDay))}%"></span></div>
<p class="cn-stat"><b>${usd(today.usd)}</b> of ${usd(tier.perDayUsd)}</p>
<div class="cn-meter" role="progressbar" aria-label="Spent today" aria-valuemin="0" aria-valuemax="${String(tier.perDayUsd)}" aria-valuenow="${String(today.usd)}"><span style="width:${String(pct(today.usd, tier.perDayUsd))}%"></span></div>
${spendChart(week, { caption: 'Last 7 days' })}
<p class="cn-more"><a href="/me/spend">Last 30 days</a> · <a href="/tasks">Your tasks</a></p></section>
<section class="cn-card cn-wide" aria-labelledby="cn-lately"><h2 id="cn-lately">Lately</h2>
${events.length ? html`<ul class="cn-events">${events.map(eventRow)}</ul>` : html`<p class="cn-empty">Nothing has happened yet. Give Actor a task above.</p>`}
<p class="cn-more"><a href="/tasks">All your tasks</a> · <a href="/me/approvals">All approvals</a></p></section>
<section class="cn-card" aria-labelledby="cn-agents"><h2 id="cn-agents">Your agents</h2>
${agents.length ? html`<ul class="cn-list">${agents.slice(0, 5).map((a) => html`<li><span class="cn-dot${a.status === 'paused' ? '' : ' on'}" aria-hidden="true"></span><a href="/me/agents/${a.id}"><b>${a.name}</b></a>
<span class="cn-meta">${a.status === 'paused' ? 'Paused' : a.schedule === 'off' ? 'Runs when you run it' : `Every ${a.schedule === 'hourly' ? 'hour' : a.schedule === 'daily' ? 'day' : 'week'}`}${a.last_run_at ? html` · last ran ${time(a.last_run_at)}` : ''}</span></li>`)}</ul>`
        : html`<p class="cn-empty">No agent yet. An agent is a task you set up once, with a memory and a schedule.</p>`}
<p class="cn-more"><a href="/me/agents">${agents.length ? 'All your agents' : 'Create an agent'}</a></p></section>
${computersCard(pcs)}
${robotsCard(rovers)}
<section class="cn-card cn-full" aria-labelledby="cn-elsewhere"><h2 id="cn-elsewhere">Across OpenVibe</h2>
<ul class="cn-links">
<li><a href="https://openvibe.services/projects">Your projects and resources</a><span class="cn-meta">OpenVibe.Services: stop, delete, suspend or resume what your projects hold</span></li>
<li><a href="https://openvibe.services/projects/mine">What you own yourself</a><span class="cn-meta">OpenVibe.Services: stop or resume a robot, archive a chat room, suspend a stream, delete a paste</span></li>
<li><a href="https://openvibe.watch">Your watches</a><span class="cn-meta">OpenVibe.Watch: wake an agent when something changes</span></li>
<li><a href="https://openvibe.codes/run">Coding on your machine</a><span class="cn-meta">OpenVibe.Codes: tasks on your own computer</span></li>
</ul></section>
</div>`,
        });
    });

    // ── Costs over time: the last 30 days (what Actor keeps) ──
    r.get('/me/spend', async (req, res) => {
        res.set('Cache-Control', cache.htmlHeaders({ private: true }));
        if (!signedIn(req)) return res.redirect(302, '/auth/login?next=%2Fme%2Fspend');
        const requester = `user:${req.viewer.subject}`;
        const days = await store.spendDays(s, requester, store.RETENTION_DAYS);
        const used = days.filter((d) => d.tasks > 0 || d.usd > 0);
        const total = days.reduce((n, d) => n + d.usd, 0);
        const busiest = used.reduce((b, d) => (!b || d.usd > b.usd ? d : b), null);
        page(req, res, {
            title: 'Spend', crumbs: [{ label: 'Console', href: '/console' }, { label: 'Spend' }],
            body: html`<header class="cn-head"><p class="cn-eyebrow">OpenVibe.Actor · console</p><h1>Spend</h1>
<p class="cn-lede">What your tasks and agents cost, day by day, over the last ${String(store.RETENTION_DAYS)} days (Actor keeps no more).</p></header>
<section class="cn-card" aria-labelledby="cn-spend-h"><h2 id="cn-spend-h">Last ${String(store.RETENTION_DAYS)} days</h2>
${spendChart(days, { caption: `Last ${store.RETENTION_DAYS} days`, month: true })}
<p class="cn-stat">${used.length ? html`<b>${usd(total / used.length)}</b> on an average day with tasks · busiest ${busiest.day}, <b>${usd(busiest.usd)}</b>` : 'Nothing has run in this time.'}</p>
<p class="cn-note">Today's limit is ${usd(tier.perDayUsd)} and ${String(tier.tasksPerDay)} tasks on the free tier.</p>
<p class="cn-more"><a href="/console">Back to the console</a> · <a href="/tasks">Your tasks</a></p></section>`,
        });
    });

    return r;
}

module.exports = { createConsolePages };

'use strict';

/**
 * Public pages: the home page (give Actor a task), your tasks and one task (live progress, the answer, its cost and why
 * that agent), the agents (Actor as "OpenRouter for agents": every agent system with its rate card), the API reference
 * and the update log. Crawl artifacts (robots.txt, sitemap.xml, llms.txt, llms-full.txt, JSON-LD) are http/discovery.js.
 *
 * Every page works without JavaScript: the task form is a plain POST, a running task's page refreshes itself, and
 * public/js/task.js only adds the live stream on top. What is shown is read, never restated: the agents and their
 * prices are server/agents/catalog.js, the free tier is the running config.
 */
const ovServe = require('openvibe-shared/serve');
const frame = require('openvibe-shared/frame');
const showcase = require('openvibe-shared/showcase');
const cache = require('openvibe-shared/cache-policy');
const { asyncRouter } = require('./router');
const { createDiscoveryRoutes, homeJsonLd } = require('./discovery');
const { sameOrigin } = require('./principal');
const { html, raw, table, notice, time, badge } = require('../render/html');
const { send } = require('../render/layout');
const { markdown } = require('../render/markdown');
const store = require('../tasks/store');
const { createTask } = require('../tasks/create');
const catalog = require('../agents/catalog');
const { MODES } = require('../agents/router');

const TASK_ID = /^tsk_[0-9A-HJKMNP-TV-Z]{26}$/;

const MODE_TEXT = {
    cheapest: 'The lowest cost that can do the task.',
    balanced: 'Cost and speed weighed together. The default.',
    best: 'The highest-quality agents first, then the best of the rest.',
    fastest: 'The quickest typical finish.',
    private: 'Only OpenVibe\'s own hardware: nothing leaves OpenVibe.',
};
const MODE_LABEL = { cheapest: 'Cheapest', balanced: 'Balanced', best: 'Best', fastest: 'Fastest', private: 'Private' };
const STATE_KIND = { queued: '', running: 'info', verifying: 'info', succeeded: 'ok', failed: 'bad', cancelled: '' };
const EXAMPLES = [
    'Who handles the mail for openvibe.network, and are its SPF and DMARC records set up properly?',
    'What changed in the latest Node.js LTS release? Give me the three changes that matter most, with sources.',
    'Explain the difference between a mutex and a semaphore with a short example.',
    'Is the TLS certificate of example.com valid, and when does it expire?',
];

const usd = (n) => (n == null ? '—' : n === 0 ? '$0' : n < 0.01 ? `$${Number(n).toFixed(4)}` : `$${Number(n).toFixed(2)}`);
const perM = (n) => (n === 0 ? 'free' : `$${Number(n).toFixed(2)}`);
const priceText = (rc) => (rc.input_usd_per_mtok === 0 && rc.output_usd_per_mtok === 0 ? 'Free (OpenVibe hardware)' : `${perM(rc.input_usd_per_mtok)} in · ${perM(rc.output_usd_per_mtok)} out per 1M tokens${rc.per_call_usd ? ` · ${usd(rc.per_call_usd)} a search` : ''}`);

function createPageRoutes(ctx) {
    const { config, s, engine } = ctx;
    const r = asyncRouter();
    const PUBLIC_CACHE = cache.htmlHeaders({ maxAge: 300 });
    const page = (req, res, o, status = 200) => send(res, status, { viewer: req.viewer, config, path: req.originalUrl, ...o });
    const signedIn = (req) => req.viewer && req.viewer.kind === 'user' && req.viewer.subject;
    const requesterOf = (req) => `user:${req.viewer.subject}`;
    const tier = config.allowance;

    // ── The task box ─────────────────────────────────────────
    function taskForm(req, { text = '', mode = 'balanced', problem = null } = {}) {
        if (!signedIn(req)) {
            return html`<div class="task-box task-box-guest">
<p class="task-box-lead">Sign in with your OpenVibe account and ask anything like:</p>
<ul class="examples">${EXAMPLES.map((e) => html`<li>“${e}”</li>`)}</ul>
<div class="task-actions"><a class="sc-btn sc-primary" href="/auth/login?next=%2F%23task">Sign in to start</a><span class="muted small">Free: ${tier.tasksPerDay} tasks a day, no card.</span></div></div>`;
        }
        return html`<form class="task-box" method="post" action="/tasks">
${problem ? notice(problem, 'warn') : ''}
<label class="task-label" for="task">What should Actor do?</label>
<textarea id="task" name="task" rows="4" maxlength="20000" required placeholder="${EXAMPLES[0]}">${text}</textarea>
<fieldset class="modes"><legend>Mode</legend>
${MODES.map((m) => html`<label class="mode"><input type="radio" name="mode" value="${m}"${m === mode ? raw(' checked') : ''}><span><b>${MODE_LABEL[m]}</b><small>${MODE_TEXT[m]}</small></span></label>`)}
</fieldset>
<div class="task-actions"><button class="sc-btn sc-primary" type="submit">Run it</button><span class="muted small">Up to ${usd(tier.perTaskUsd)} a task on the free tier; you see the real cost to a fraction of a cent.</span></div>
</form>`;
    }

    // ── Home ─────────────────────────────────────────────────
    function home(req, res, { status = 200, form = {} } = {}) {
        const agents = catalog.list(config);
        const hero = showcase.hero({
            eyebrow: 'OpenVibe.Actor · your agent for everything · alpha',
            title: 'Ask once.', accent: 'The right agent does it.',
            lede: 'Give Actor a task in plain words. It picks the agent that fits: OpenVibe\'s own, acting through every OpenVibe service, or another platform\'s, like OpenAI\'s web agent. It runs the task, has a second model check the answer, and shows you what it cost and why that agent. Like OpenRouter, for agents.',
            actions: signedIn(req) ? [{ label: 'Give it a task', href: '#task', primary: true }, { label: 'Your tasks', href: '/tasks' }] : [{ label: 'Sign in to start', href: '/auth/login?next=%2F', primary: true }, { label: 'See the agents', href: '/agents' }],
            note: `Open source (AGPL-3.0). Free tier: ${tier.tasksPerDay} tasks a day, up to ${usd(tier.perTaskUsd)} each. The list below says exactly what works today.`,
            aside: { html: String(routerCard(agents)) },
        });
        page(req, res, {
            index: true, cache: signedIn(req) ? null : PUBLIC_CACHE,
            jsonLd: homeJsonLd(config),
            styles: [showcase.STYLESHEET],
            body: html`${raw(hero)}
<section class="sc-sec" id="task" aria-labelledby="h-task"><h2 id="h-task">Give Actor a task</h2>
${taskForm(req, form)}</section>
${raw(showcase.features({
                title: 'What it can do today',
                lede: 'Each of these is a real agent working through a real API, not a demo.',
                items: [
                    { icon: 'ov:search', title: 'Search the live web, with sources', text: 'News, prices, releases, anything recent: OpenAI\'s agent searches and cites its sources.' },
                    { icon: 'ov:dns', title: 'Look up any domain or site', text: 'DNS, mail records, SPF and DMARC, certificates, headers, WHOIS: the runtime runs OpenVibe.Tools for real answers.' },
                    { icon: 'ov:network', title: 'Search the OpenVibe network', text: 'Streams, clips, pastes, posts and wiki pages across every OpenVibe site.' },
                    { icon: 'ov:text', title: 'Write and explain', text: 'Drafts, summaries, explanations, plans: the cheapest agent that does it well.' },
                    { icon: 'ov:host', title: 'Private mode', text: 'An open model on OpenVibe\'s own server answers, and nothing leaves OpenVibe.' },
                    { icon: 'ov:check', title: 'Checked before you see it', text: 'A model of another family reads every answer first; a failed check goes to the next agent.' },
                ],
            }))}
${raw(showcase.steps({
                title: 'How a task finds its agent',
                items: [
                    { title: 'Sort the task', text: 'An answer, a lookup, research, a live web search or code: that decides what an agent must be able to do.' },
                    { title: 'Hard limits first', text: 'An agent that cannot do it, that private mode does not trust, that is down or that would cost more than your budget is out, and the task says why.' },
                    { title: 'Then your mode', text: 'Cheapest, Balanced, Best, Fastest or Private picks among the rest, through the same placement engine every OpenVibe service uses.' },
                    { title: 'Run, check, deliver', text: 'The agent works while you watch its steps; another model checks the answer; you get the answer, its sources, the cost and the explanation.' },
                    { title: 'Or hand it on', text: 'An agent that fails, or an answer that fails its check, goes to the next agent that can do it, within your budget.' },
                ],
            }))}
<section class="sc-sec" aria-labelledby="h-agents"><h2 id="h-agents">The agents</h2>
<p class="sc-lede">Every agent Actor can route to, with the price it charges and whether it is working right now. <a href="/agents">Prices, modes and details</a>.</p>
<div class="agent-cards">${agents.map((a) => agentCard(a))}</div></section>
${raw(showcase.compare({
                title: 'Why a router, not one agent',
                lede: 'One company\'s agent is as good as that company\'s models and tools. Actor picks per task, and can use theirs too.',
                columns: ['OpenVibe.Actor', 'A single-vendor agent'],
                rows: [
                    { label: 'Picks the best agent for each task', values: [true, false] },
                    { label: 'Can hand a task to another platform\'s agent', values: [true, false] },
                    { label: 'Shows the cost and why, per task', values: [true, false] },
                    { label: 'A second model family checks the answer', values: [true, false] },
                    { label: 'A private mode on its own hardware', values: [true, false] },
                    { label: 'Open source, self-hostable', values: [true, false] },
                    { label: 'Free tier', values: [true, null] },
                ],
            }))}
<section class="sc-sec" aria-labelledby="h-status"><h2 id="h-status">What works today</h2>
${table(['Piece', 'State'], [
                ['The task router: modes, budgets, the explanation, live progress, cancel', 'Live.'],
                ['OpenVibe runtime acting through OpenVibe.Search and OpenVibe.Tools', 'Live.'],
                ['OpenAI\'s web agent as one of the routed agents', 'Live.'],
                ['Private mode on an open model on OpenVibe\'s server', 'Live: short answers, no tools yet.'],
                ['A second-family check on every answer, and hand-off on failure', 'Live.'],
                [html`The API (<a href="/docs">docs</a>): tasks, the live stream, the agents and a dry-run router`, 'Live, for people and for apps with actor.task.* grants from OpenVibe.Services.'],
                ['Coding tasks through OpenVibe.Codes', html`Next: hosted coding runs need OpenVibe.Run sandboxes. Today, <a href="https://openvibe.codes/start">run openvibe-codes</a> on your machine.`],
                ['Browser and desktop agents on OpenVibe\'s own cheap servers, that you can watch and take over', 'Next, on OpenVibe.Run workers.'],
                ['More agent platforms, bring-your-own keys, paid tiers through OpenVibe.Billing', 'Planned.'],
                ['Personal agents: memory you control, schedules, approvals, reachable from chat', 'Planned.'],
            ])}</section>
${raw(showcase.cta({ title: 'Build on it', text: 'Every task, its live stream and the router are an API. Apps get actor.task.* grants on OpenVibe.Services.', actions: [{ label: 'Read the API', href: '/docs', primary: true }, { label: 'See the agents', href: '/agents' }] }))}`,
        }, status);
    }

    function routerCard(agents) {
        const shown = agents.filter((a) => a.id !== 'codes');
        return html`<figure class="router-card" aria-label="How Actor picked an agent for a sample task">
<figcaption><span class="muted small">Sample task · Balanced</span><b>“Who handles the mail for openvibe.network, and is DMARC set up?”</b></figcaption>
<ol>${shown.map((a, i) => html`<li class="${i === 0 ? 'pick' : ''}"><span class="rc-name">${a.name}</span><span class="rc-cost">~${usd(catalog.typicalCost(a.id))}</span><span class="rc-why">${i === 0 ? 'can run the DNS tools; cheapest that can' : a.can.includes('task:lookup') ? 'can do it, costs more' : 'cannot run lookups'}</span></li>`)}</ol>
<p class="rc-foot">Checked by a second model before you see it.</p></figure>`;
    }

    function agentCard(a) {
        return html`<article class="agent-card${a.available ? '' : ' off'}" id="card-${a.id}">
<header><b>${a.name}</b>${a.available ? badge('working', 'ok') : badge('not here yet')}</header>
<p>${(catalog.byId(a.id) || {}).blurb || ''}</p>
<p class="muted small">${priceText(a.rate_card)}${a.model ? html` · <code>${a.model}</code>` : ''}</p>
${a.available ? '' : html`<p class="muted small">${a.reason}</p>`}
</article>`;
    }

    r.get('/', (req, res) => home(req, res));

    // ── Create from the form (POST /tasks) ───────────────────
    r.post('/tasks', require('express').urlencoded({ extended: false, limit: '64kb' }), async (req, res) => {
        res.set('Cache-Control', cache.htmlHeaders({ private: true }));
        if (!signedIn(req)) return res.redirect(303, '/auth/login?next=%2F');
        if (!sameOrigin(req, config.baseUrl)) return res.status(403).type('text/plain').send('A task must be sent from openvibe.actor itself.');
        const text = String((req.body && req.body.task) || '').slice(0, 20000);
        const mode = MODES.includes(req.body && req.body.mode) ? req.body.mode : 'balanced';
        const out = await createTask({ s, config, engine, principal: { requester: requesterOf(req), project: null }, body: { task: text, mode } });
        if (out.code) return home(req, res, { status: out.status === 503 || out.status === 429 ? out.status : 422, form: { text, mode, problem: out.detail } });
        return res.redirect(303, `/tasks/${out.task.id}`);
    });

    // ── Your tasks ───────────────────────────────────────────
    r.get('/tasks', async (req, res) => {
        if (!signedIn(req)) {
            return page(req, res, { title: 'Your tasks', crumbs: [{ label: 'Your tasks' }], body: html`<h1>Your tasks</h1><p>Sign in to see the tasks you gave Actor.</p><p><a class="sc-btn sc-primary" href="/auth/login?next=%2Ftasks">Sign in</a></p>` });
        }
        const before = typeof req.query.before === 'string' && TASK_ID.test(req.query.before) ? req.query.before : null;
        const pageRows = await store.listTasks(s, requesterOf(req), { limit: 30, before });
        const today = await store.spendToday(s, requesterOf(req));
        page(req, res, {
            title: 'Your tasks', crumbs: [{ label: 'Your tasks' }], styles: [showcase.STYLESHEET],
            body: html`<h1>Your tasks</h1>
<p class="muted">Today: ${today.tasks} of ${tier.tasksPerDay} free tasks, ${usd(today.usd)} of ${usd(tier.perDayUsd)}. Tasks are kept ${store.RETENTION_DAYS} days.</p>
${taskForm(req)}
${table(['Task', 'State', 'Agent', 'Cost', 'Started'], pageRows.rows.map((t) => {
                const result = t.result ? (typeof t.result === 'string' ? JSON.parse(t.result) : t.result) : null;
                return [html`<a href="/tasks/${t.id}">${t.task.length > 90 ? `${t.task.slice(0, 89)}…` : t.task}</a>`, badge(t.state, STATE_KIND[t.state]), result ? (catalog.byId(result.agent) || {}).name || result.agent : '—', usd(t.cost_usd == null ? null : Number(t.cost_usd)), time(t.created_at)];
            }), { empty: 'No tasks yet.' })}
${pageRows.next ? html`<p><a href="/tasks?before=${pageRows.next}">Older tasks</a></p>` : ''}`,
        });
    });

    // ── One task ─────────────────────────────────────────────
    // Read top to bottom: what was asked and where it stands, the outcome (the answer, why it did not finish, or the
    // live progress), then how it went — one block per agent that tried, its steps, its check, and a refused answer
    // folded away — and why that agent, folded.
    const STATE_TEXT = { queued: 'Waiting to start', running: 'Working', verifying: 'Checking the answer', succeeded: 'Done', failed: 'Didn\'t finish', cancelled: 'Cancelled' };
    const CLASS_TEXT = { answer: 'Answer', lookup: 'Lookup', research: 'Research', web: 'Web search', code: 'Code' };

    r.get('/tasks/:id', async (req, res) => {
        const row = TASK_ID.test(req.params.id) && signedIn(req) ? await store.getTask(s, req.params.id) : null;
        if (!row || row.requester !== requesterOf(req)) {
            return page(req, res, { title: 'Task not found', body: html`<h1>Task not found</h1><p>${signedIn(req) ? 'There is no task here that belongs to you.' : html`<a href="/auth/login?next=${encodeURIComponent(req.originalUrl)}">Sign in</a> to see your task.`}</p>` }, 404);
        }
        const t = store.toWire(row, { baseUrl: config.baseUrl });
        const events = await store.eventsAfter(s, row.id, 0);
        const deliveries = row.webhooks ? await ctx.webhooks.forTask(row.id) : [];
        const open = store.OPEN.includes(row.state);
        const cls = (events.find((e) => e.step === 'plan' && !e.agent && /"(\w+)" task/.test(e.text || '')) || { text: '' }).text.match(/"(\w+)"/);
        const kind = cls ? CLASS_TEXT[cls[1]] || cls[1] : null;
        page(req, res, {
            title: row.task.length > 60 ? `${row.task.slice(0, 59)}…` : row.task,
            crumbs: [{ label: 'Your tasks', href: '/tasks' }, { label: 'Task' }],
            scripts: open ? ['js/task.js'] : [],
            styles: [showcase.STYLESHEET],
            noReferrer: true,
            body: html`${open ? raw('<noscript><meta http-equiv="refresh" content="4"></noscript>') : ''}
<article class="task state-${t.state}" data-task="${row.id}" data-last="${row.last_seq}" data-open="${open ? '1' : ''}">
<header class="task-head">
<p class="task-status"><span class="pill pill-${t.state}">${STATE_TEXT[t.state]}</span>${kind ? html`<span class="chip">${kind}</span>` : ''}<span class="chip">${MODE_LABEL[t.mode]}</span><span class="chip" id="task-cost">${t.cost ? usd(t.cost.usd) : '$0'} of ${usd(t.budget.per_task_usd)}</span>${time(t.created_at)}</p>
<h1 class="task-text">${row.task}</h1>
</header>
${outcome(t, row)}
<section class="how" aria-labelledby="h-how"><h2 id="h-how">How it went</h2>
<div class="attempts" id="attempts">${attemptsOf(events).map(attemptBlock)}</div>
${open ? html`<p class="muted small live-note" id="live-note"><span class="dot-pulse" aria-hidden="true"></span> Updating as the agent works.</p>` : ''}
</section>
${t.explanation ? explanationBlock(t.explanation) : ''}
${deliveries.length ? deliveriesBlock(deliveries) : ''}
<p class="muted small api-hint">In code: <code>GET /api/v1/tasks/${row.id}</code> · <a href="/docs">API</a></p>
</article>`,
        });
    });

    /** The task's webhook deliveries: where, which state, and how it went (the receiver's answer code only). */
    const DELIVERY_TEXT = { pending: 'Waiting to retry', sending: 'Sending', delivered: 'Delivered', failed: 'Not delivered' };
    function deliveriesBlock(rows) {
        return html`<details class="deliveries"><summary>Webhooks (${rows.length})</summary>
${table(['State', 'Endpoint', 'Delivery', 'Attempts'], rows.map((d) => [
            html`<code>${d.state}</code>`, html`<code class="small">${d.url}</code>`,
            html`${DELIVERY_TEXT[d.status] || d.status}${d.last_status ? html` <span class="muted small">(${d.last_status})</span>` : ''}`, String(d.attempts),
        ]))}</details>`;
    }

    /** The outcome card: the first thing under the task. */
    function outcome(t, row) {
        if (t.state === 'succeeded') return resultBlock(t.result, t);
        const again = html`<form method="post" action="/tasks" class="inline"><input type="hidden" name="task" value="${row.task}"><input type="hidden" name="mode" value="best"><button class="sc-btn sc-primary" type="submit">Try again in Best mode</button></form> <a class="sc-btn" href="/#task">New task</a>`;
        if (t.state === 'failed') {
            return html`<section class="outcome outcome-bad" role="status"><h2>Actor couldn't finish this</h2><p>${friendlyError(t.error)}</p><div class="outcome-actions">${again}</div>${t.error ? html`<p class="muted small">Code <code>${t.error.code}</code></p>` : ''}</section>`;
        }
        if (t.state === 'cancelled') return html`<section class="outcome" role="status"><h2>Cancelled</h2><p>What was spent before the cancel stays spent.</p><div class="outcome-actions">${again}</div></section>`;
        return html`<section class="outcome outcome-live" role="status" aria-live="polite"><h2><span class="dot-pulse" aria-hidden="true"></span> <span id="live-state">${STATE_TEXT[t.state]}…</span></h2><p class="muted">This page fills in as the agent works. You can leave and come back: the task keeps running.</p><form method="post" action="/tasks/${row.id}/cancel" class="inline"><button class="sc-btn" type="submit">Cancel</button></form></section>`;
    }

    /** What went wrong, for a person; the code stays visible underneath for anyone who needs it. */
    function friendlyError(err) {
        if (!err) return 'It stopped without saying why.';
        const plain = {
            'actor.agents.exhausted': 'No agent gave an answer that passed its check, so nothing unchecked was shown to you. Trying again in Best mode starts with the strongest agent.',
            'actor.check.unavailable': 'The answer could not be checked, so it was not delivered. Try again in a minute.',
            'actor.task.timeout': 'It ran too long and was stopped.',
            'actor.task.interrupted': 'Actor restarted while this was running. Nothing more was charged; ask again.',
        };
        return plain[err.code] || err.detail;
    }

    function resultBlock(result, t) {
        const agent = catalog.byId(result.agent);
        const checked = result.checked || {};
        return html`<section class="outcome outcome-ok answer" aria-labelledby="h-answer"><h2 id="h-answer" class="sr-only">Answer</h2>
<div class="prose">${raw(markdown(result.answer, { headingOffset: 2 }))}</div>
${result.sources && result.sources.length ? html`<div class="sources"><h3>Sources</h3><ul>${result.sources.map((u) => html`<li><a href="${u}" rel="nofollow ugc noopener" target="_blank">${u.replace(/^https?:\/\//, '').slice(0, 90)}</a></li>`)}</ul></div>` : ''}
<p class="answer-foot"><span>${agent ? agent.name : result.agent}${result.model ? html` · <code>${result.model}</code>` : ''}</span><span>✓ checked by ${checked.by}${checked.cross_family ? ' (another model family)' : ' (same family)'}</span><span>${t.cost ? usd(t.cost.usd) : '$0'}</span></p>
</section>`;
    }

    /**
     * The events grouped by agent: an attempt starts with the plan or hand-off event that names its agent. A text event
     * marked as an error right after a failed check is the answer that check refused; any other error text is the agent
     * stopping.
     */
    function attemptsOf(events) {
        const out = [];
        let cur = null;
        let lastCheckFailed = false;
        for (const e of events) {
            if (e.kind !== 'output') continue;
            if ((e.step === 'plan' || e.step === 'handoff') && e.agent) {
                cur = { agent: e.agent, why: e.text, steps: [], refused: null, check: null, stopped: null };
                out.push(cur);
                lastCheckFailed = false;
                continue;
            }
            if (!cur) continue;
            if (e.step === 'check') { cur.check = e; lastCheckFailed = !!e.is_error; continue; }
            if (e.step === 'text' && e.is_error && lastCheckFailed) { cur.refused = e.text; continue; }
            if (e.step === 'text' && e.is_error) { cur.stopped = e.text; continue; }
            cur.steps.push(e);
        }
        return out;
    }

    function attemptBlock(a, i) {
        const agent = catalog.byId(a.agent);
        const outcomeBadge = a.check ? (a.check.is_error ? badge('answer refused', 'bad') : badge('passed', 'ok')) : a.stopped ? badge('stopped', 'warn') : '';
        return html`<section class="attempt" data-agent="${a.agent}">
<header class="attempt-head"><span class="attempt-n">${i + 1}</span><b>${agent ? agent.name : a.agent}</b>${outcomeBadge}</header>
<ol class="tl">${a.steps.map(stepItem)}
${a.stopped ? html`<li class="tl-item tl-err"><span class="tl-k">Stopped</span><span class="tl-v">${a.stopped}</span></li>` : ''}
${a.check ? html`<li class="tl-item ${a.check.is_error ? 'tl-err' : 'tl-ok'}"><span class="tl-k">Check</span><span class="tl-v">${String(a.check.text || '').replace(/^(Checked|Check failed)( by \w+( \(same family\))?)?: ?/, '')}</span></li>` : ''}
</ol>
${a.refused ? html`<details class="refused"><summary>See the answer that didn't pass</summary><div class="prose">${raw(markdown(a.refused, { headingOffset: 3 }))}</div></details>` : ''}
</section>`;
    }

    function stepItem(e) {
        if (e.step === 'tool_call') return html`<li class="tl-item tl-tool"><span class="tl-k">Used</span><span class="tl-v"><code>${e.tool}</code> ${e.input || ''}</span></li>`;
        if (e.step === 'tool_result') return html`<li class="tl-item tl-result${e.is_error ? ' tl-err' : ''}"><span class="tl-k">Got</span><span class="tl-v"><span class="muted">${(e.text || '').slice(0, 220)}</span></span></li>`;
        return html`<li class="tl-item tl-say"><span class="tl-k">Note</span><span class="tl-v">${e.text || ''}</span></li>`;
    }

    function explanationBlock(explanation) {
        return html`<details class="why"><summary>Why this agent</summary>
${explanation.map((p, i) => html`<h3>${i ? `Hand-off ${i}` : 'First choice'}: ${p.selected ? (catalog.byId(p.selected) || {}).name || p.selected : 'no agent'} <span class="muted small">(${p.objective})</span></h3>
${table(['Agent', 'Could take it', 'Estimated cost', 'Why not'], (p.candidates || []).map((c) => [(catalog.byId(c.id) || {}).name || c.id, c.eligible ? 'yes' : 'no', c.estimated_cost_usd != null ? `~${usd(c.estimated_cost_usd)}` : '—', c.excluded_because || (c.id === p.selected ? 'picked' : '')]))}`)}
</details>`;
    }

    r.post('/tasks/:id/cancel', async (req, res) => {
        res.set('Cache-Control', cache.htmlHeaders({ private: true }));
        if (!signedIn(req) || !TASK_ID.test(req.params.id)) return res.redirect(303, '/tasks');
        if (!sameOrigin(req, config.baseUrl)) return res.status(403).type('text/plain').send('A cancel must come from openvibe.actor itself.');
        const row = await store.getTask(s, req.params.id);
        if (row && row.requester === requesterOf(req)) await engine.cancel(row.id, requesterOf(req));
        return res.redirect(303, `/tasks/${req.params.id}`);
    });

    // ── The agents ───────────────────────────────────────────
    r.get('/agents', (req, res) => {
        const agents = catalog.list(config);
        page(req, res, {
            index: true, cache: PUBLIC_CACHE,
            title: 'The agents',
            description: 'Every agent system OpenVibe.Actor routes a task to — OpenVibe\'s own runtime, OpenAI\'s web agent, an open model on OpenVibe hardware, OpenVibe.Codes — with what each can do, its trust class and its price per million tokens.',
            crumbs: [{ label: 'Agents' }],
            body: html`<h1>The agents</h1>
<p>Actor is a router for agents, the way OpenRouter is one for models: each task goes to the agent system that can do it, then by your mode. Prices are typed in from each provider's own price page by a person, with the day it was checked; Actor charges the real usage of each call at these prices. Machine-readable: <a href="/api/v1/agents"><code>GET /api/v1/agents</code></a>.</p>
${table(['Agent', 'Kind', 'Can do', 'Trust', 'Price', 'Typical time', 'Now'], agents.map((a) => [
                html`<strong id="${a.id}">${a.name}</strong><br><code>${a.id}</code>${a.model ? html`<br><span class="muted small">${a.model}</span>` : ''}`,
                a.kind,
                a.can.filter((c) => c.startsWith('task:')).map((c) => c.slice(5)).join(', '),
                a.trust,
                html`${priceText(a.rate_card)}<br><a class="muted small" href="${a.rate_card.source}" rel="noopener">source</a> <span class="muted small">checked ${a.rate_card.verified_at}</span>`,
                `~${Math.round(a.typical_latency_ms / 1000)} s`,
                a.available ? badge('working', 'ok') : html`${badge('not here')}<br><span class="muted small">${a.reason}</span>`,
            ]))}
<h2 id="modes">Modes</h2>
${table(['Mode', 'What it picks'], MODES.map((m) => [html`<strong>${MODE_LABEL[m]}</strong> <code>${m}</code>`, MODE_TEXT[m]]))}
<h2 id="classes">What a task needs</h2>
<p>Actor sorts each task first, and only agents that can do that kind of task are considered:</p>
<ul><li><strong>answer</strong>: writing, explaining, planning, anything a capable model knows.</li>
<li><strong>lookup</strong>: facts about a domain, address or site (DNS, mail records, certificates, headers, WHOIS), from OpenVibe.Tools.</li>
<li><strong>research</strong>: reading the pages a task names, or OpenVibe's own content.</li>
<li><strong>web</strong>: a live web search, for anything recent.</li>
<li><strong>code</strong>: writing or changing code, through OpenVibe.Codes.</li></ul>
<h2 id="check">The check</h2>
<p>Before you see an answer, a model of another family reads it: DeepSeek's answers are checked by OpenAI's smallest model and OpenAI's by DeepSeek. In private mode only OpenVibe's own model may read the task, so it checks its own answer and the task says so. A failed check sends the task to the next agent that can do it.</p>
<h2 id="trust">Trust</h2>
<p><strong>first-party</strong> runs on OpenVibe's own hardware; <strong>external</strong> means the task's text goes to that provider (the OpenVibe runtime is OpenVibe's code, but its model runs at DeepSeek). Private mode takes only first-party agents.</p>`,
        });
    });

    // ── The API reference ────────────────────────────────────
    r.get('/docs', (req, res) => {
        const b = config.baseUrl;
        const create = `curl -s ${b}/api/v1/tasks \\
  -H "authorization: Bearer $TOKEN" \\
  -H 'content-type: application/json' \\
  -d '{"task":"Is the TLS certificate of example.com valid, and when does it expire?","mode":"cheapest"}'

# → 201 { "id": "tsk_…", "state": "queued", "progress": { "stream_url": "…/events" }, … }`;
        const watch = `curl -N ${b}/api/v1/tasks/tsk_…/events -H "authorization: Bearer $TOKEN"

id: 3
event: output
data: {"task_id":"tsk_…","seq":3,"kind":"output","agent":"openvibe-runtime","step":"tool_call","tool":"run_tool","input":"ssl {\\"target\\":\\"example.com\\"}"}`;
        page(req, res, {
            index: true, cache: PUBLIC_CACHE,
            title: 'API',
            description: 'The OpenVibe.Actor API: create a task, watch it live over server-sent events, read the result with its cost and explanation, cancel it; list the agents and dry-run the router.',
            crumbs: [{ label: 'API' }],
            body: html`<h1>The API</h1>
<p>Everything the site does is this API. Tasks are <a href="https://openvibe.services/docs/contracts/platform.task@1"><code>platform.task@1</code></a>; the contracts and capabilities are in <a href="https://github.com/OpenVibers/OpenVibe.Contracts">OpenVibe.Contracts</a>.</p>
<h2 id="auth">Who can call it</h2>
<ul><li><strong>A person</strong>: their OpenVibe Network token as <code>Authorization: Bearer</code> (or this site's sign-in). Tasks are theirs and use their free tier.</li>
<li><strong>An app or agent</strong>: a Network token for audience <code>openvibe.actor</code> with the <code>actor.task.*</code> capability the route needs, granted on <a href="https://openvibe.services">OpenVibe.Services</a>. Tasks belong to the app's project.</li>
<li><strong>Anyone</strong>: <code>GET /api/v1/agents</code> and <code>POST /api/v1/route</code> need no token.</li></ul>
${table(['Route', 'Capability', 'What it does'], [
                [html`<code>POST /api/v1/tasks</code>`, html`<code>actor.task.create</code>`, html`Create a task: <code>{ task, mode?, budget?: { per_task_usd, per_day_usd }, agent?, idempotency_key?, webhooks?: [{ url, events }] }</code>. Answers 201 with the task (queued); with webhooks, also its <code>webhook_secret</code>, this once (<a href="#webhooks">webhooks</a>).`],
                [html`<code>GET /api/v1/tasks/:id</code>`, html`<code>actor.task.read</code>`, 'The task: state, result, cost, explanation, error.'],
                [html`<code>GET /api/v1/tasks/:id/events</code>`, html`<code>actor.task.read</code>`, html`Server-sent events (<code>actor.task-event@1</code>): <code>state</code>, <code>output</code> (each step), <code>end</code>. Resumes with <code>Last-Event-ID</code>.`],
                [html`<code>POST /api/v1/tasks/:id/cancel</code>`, html`<code>actor.task.create</code>`, 'Stop it. What was spent stays spent.'],
                [html`<code>GET /api/v1/tasks</code>`, html`<code>actor.task.list</code>`, html`Your tasks, newest first; <code>?limit=</code>, <code>?before=</code> (the <code>next</code> cursor).`],
                [html`<code>GET /api/v1/agents</code>`, 'public', 'The agent systems, what each can do, its price and whether it works now.'],
                [html`<code>POST /api/v1/route</code>`, 'public', html`<code>{ task, mode? }</code> → which agent would take it and why, for every candidate. Nothing runs and nothing is charged.`],
            ])}
${raw(showcase.code({ title: 'Create a task, then watch it', samples: [{ label: 'Create', lang: 'bash', code: create }, { label: 'Watch', lang: 'bash', code: watch }] }))}
<h2 id="webhooks">Webhooks</h2>
<p>Give a task up to 8 HTTPS endpoints and the state changes each wants (<code>queued</code>, <code>running</code>, <code>verifying</code>, <code>succeeded</code>, <code>failed</code>, <code>cancelled</code>). Actor POSTs <a href="https://openvibe.services/docs/contracts/actor.task-webhook@1"><code>actor.task-webhook@1</code></a> to each: <code>{ type: "actor.task.state", delivery_id, state, task }</code>, with the task as it was at that moment.</p>
<ul><li><strong>Signed per task.</strong> The answer that creates the task carries <code>webhook_secret</code>, and nothing else ever shows it. Each delivery has <code>X-OpenVibe-Timestamp</code> and <code>X-OpenVibe-Signature-V2</code>, exactly like an OpenVibe.Events delivery, so <code>verifyDeliveryV2(rawBody, headers, secret)</code> from <code>openvibe-sdk/events</code> checks it (and the five-minute window).</li>
<li><strong>Retried.</strong> A 2xx answer is delivered. 410 Gone ends it. Anything else is retried after 10 s, 1 min, 5 min, 30 min, 2 h, 6 h and 12 h. <code>delivery_id</code> (also <code>X-OpenVibe-Delivery-Id</code>) is the same on every attempt: dedupe on it.</li>
<li><strong>Public endpoints only.</strong> HTTPS on port 443 or 8443, no credentials in the URL, and only public addresses, checked when the task is created and again when each delivery is sent. Redirects are not followed.</li></ul>
<h2 id="limits">Limits and money</h2>
<p>The free tier: ${tier.tasksPerDay} tasks a day, up to ${usd(tier.perTaskUsd)} a task and ${usd(tier.perDayUsd)} a day (<a href="/limits.json">limits.json</a>). A budget above the tier is refused (<code>actor.budget.over_tier</code>), never lowered. A task whose cheapest capable agent would cost more than its budget fails before running (<code>actor.budget.exceeded</code>). <code>cost.usd</code> is what each model call and web search really cost at the <a href="/agents">published prices</a>.</p>
<h2 id="errors">Errors</h2>
<p>Every refusal is RFC 9457 <code>application/problem+json</code> with a stable <code>code</code>. A task that fails says why in <code>error</code>:</p>
${table(['Code', 'Meaning'], [
                [html`<code>actor.task.invalid</code>`, 'The request does not match actor.task-create-request@1.'],
                [html`<code>actor.webhook.refused</code>`, 'A webhook URL Actor will not deliver to: not HTTPS on 443/8443, credentials in it, or not a public address.'],
                [html`<code>actor.budget.over_tier</code>`, 'The budget is above what the free tier allows.'],
                [html`<code>actor.allowance.exhausted</code> / <code>actor.budget.day_spent</code>`, 'Today\'s free tasks or budget are used; Retry-After says when it resets.'],
                [html`<code>actor.capacity.spent</code>`, 'Actor\'s free capacity for everyone is used up for today.'],
                [html`<code>actor.budget.exceeded</code>`, 'The task could not be done within its budget.'],
                [html`<code>actor.no_agent</code>`, 'No agent that can do this kind of task is available (the detail says which and why).'],
                [html`<code>actor.agents.exhausted</code>`, 'Every agent that could do it failed or gave an answer that failed its check.'],
                [html`<code>actor.check.unavailable</code>`, 'The answer could not be checked, so it was not delivered.'],
                [html`<code>actor.task.timeout</code> / <code>actor.task.interrupted</code>`, 'It ran too long, or Actor restarted while it ran.'],
            ])}`,
        });
    });

    // ── Limits and the update log ────────────────────────────
    r.get('/limits.json', (req, res) => {
        res.set('Cache-Control', cache.htmlHeaders({ maxAge: 300 }));
        res.json({ service: 'actor', free_tier: { tasks_per_day: tier.tasksPerDay, per_task_usd: tier.perTaskUsd, per_day_usd: tier.perDayUsd }, task_timeout_seconds: Math.round(config.taskTimeoutMs / 1000), retention_days: store.RETENTION_DAYS });
    });
    r.get('/updates', (req, res) => page(req, res, { index: true, cache: PUBLIC_CACHE, title: 'What shipped on OpenVibe.Actor', body: raw(frame.updatesBody({ service: 'actor', siteName: 'OpenVibe.Actor' }) + `<script src="${ovServe.url('shipped.js')}" defer></script>`) }));

    // ── Discovery: robots.txt, sitemap.xml, llms.txt, llms-full.txt ──
    r.use(createDiscoveryRoutes(ctx));
    return r;
}

module.exports = { createPageRoutes, MODE_TEXT };

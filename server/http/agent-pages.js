'use strict';

const express = require('express');
const { asyncRouter } = require('./router');
const { sameOrigin } = require('./principal');
const { html, raw, time } = require('../render/html');
const { send } = require('../render/layout');
const personal = require('../agents/personal');
const contacts = require('../agents/contacts');
const ui = require('./agent-contacts-ui');
const approvals = require('../agents/approvals');
const voice = require('../agents/voice');
const shares = require('../agents/voice-shares');
const levels = require('../agents/levels');
const allows = require('../agents/allows');
const kinds = require('../agents/kinds');
const spend = require('../agents/spend');

/** "22 minutes ago", "in 6 days": a person reads this, the exact UTC instant stays in the <time> element's title. */
function ago(iso, now = Date.now()) {
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return '';
    const d = Math.round((t - now) / 1000);
    const a = Math.abs(d);
    // A time to come rounds down (6.75 days left is "in 6 days": never promise more time than there is); a time past
    // rounds to the nearest.
    const r = d > 0 ? Math.floor : Math.round;
    const [n, unit] = a < 60 ? [a, 'second'] : a < 3600 ? [r(a / 60), 'minute'] : a < 86400 ? [r(a / 3600), 'hour'] : [r(a / 86400), 'day'];
    if (a < 45) return 'just now';
    const words = `${n} ${unit}${n === 1 ? '' : 's'}`;
    return d < 0 ? `${words} ago` : `in ${words}`;
}
const whenAt = (iso, now = Date.now()) => (iso ? html`<time datetime="${iso}" title="${String(iso).replace('T', ' ').replace(/\.\d+Z$/, ' UTC').replace(/Z$/, ' UTC')}">${ago(iso, now)}</time>` : '');

/** What an always-ask step does, in one plain line, so the person sees it before the details. */
const CAUTION = {
    delete: 'This deletes something. It cannot be undone.',
    money: 'This spends money.',
    password: 'This types a password or a secret.',
    new_recipient: 'This sends to someone your agent has not written to before.',
};

/** The command a computer step runs, as one line, when the request is one; otherwise null. */
function commandLine(p) {
    const argv = p && Array.isArray(p.argv) ? p.argv.map(String) : null;
    if (!argv || !argv.length) return null;
    const quote = (a) => (/^[A-Za-z0-9_./:=@%+,-]+$/.test(a) ? a : `'${a.replace(/'/g, "'\\''")}'`);
    return argv.map(quote).join(' ').slice(0, 2000);
}
const memoryStore = require('../memory');
const tidy = require('../memory/tidy');
const CHANGE_LABEL = { merge: 'Merged notes', retire: 'Retired a note', promote: 'Pinned a note' };

function createAgentPages(ctx) {
    const { config, s, limits } = ctx;
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
    // Templates (consumer plan step 4, "personal agents grow up"): a first agent in one click, its instructions written
    // for what Actor's runtime can do (OpenVibe's services as tools, the web in the fuller modes, Codes on your machine).
    // The parts in <angle brackets> are the person's to fill in; an agent is not created while one is left.
    const TEMPLATES = [
        { id: 'job-search', name: 'Job search', schedule: 'daily', schedule_at: '08:00', mode: 'balanced', line: 'New jobs that fit you, every morning',
          instructions: 'Find job listings posted in the last day for <the role you want, your main skills, and where: a city or "remote">. Look on OpenVibe Jobs (openvibe.work) first, then the wider web. List up to 10, each with its title, company, place, the pay when it is given, and the link to apply. Leave out any listing your memory says you were already shown, and note the new ones in your memory.' },
        { id: 'research-brief', name: 'Research brief', schedule: 'weekly', schedule_at: '09:00', schedule_dow: 1, mode: 'best', line: 'A one-page brief on a subject, every week',
          instructions: 'Research <a subject you follow> and write a one-page brief: what is new this week, the main points of view, and what to watch next. Give the link of every source you rely on, and say plainly when something could not be confirmed.' },
        { id: 'price-watch', name: 'Price watch', schedule: 'daily', schedule_at: '12:00', mode: 'cheapest', line: 'Tell me when a price drops',
          instructions: 'Check today\'s price of <the product, and the link to its page in a shop>. Say the price, whether it is lower than the last price in your memory, and the cheapest place you found with its link. Then keep today\'s price in your memory. (For a page that changes often, OpenVibe Alerts can watch it every few minutes and wake this agent.)' },
        { id: 'morning-briefing', name: 'Morning briefing', schedule: 'daily', schedule_at: '07:00', mode: 'balanced', line: 'Five bullets on what happened overnight',
          instructions: 'Summarise what happened in <the subjects you care about> in the last 24 hours in five bullets, each with its link. Then add one line on anything new on OpenVibe from its changelog (openvibe.blog/changelog).' },
        { id: 'make-something', name: 'Make something', schedule: 'off', mode: 'best', line: 'Build it on your computer, as a pull request',
          instructions: 'Build <what you want: a small web page, a script, a tool> in <the repository, for example your-name/your-project> with OpenVibe Code on my own computer, run its tests, and open a pull request for me to review. Never push to the main branch.' },
    ];
    const UNFILLED = /<[^<>]{3,80}>/;
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
<label>Quiet from (UTC) <input name="quiet_from" type="time" value="${a.quiet_from || ''}"><span class="pa-hint">No scheduled run starts in quiet hours; Run now still works.</span></label>
<label>Quiet until (UTC) <input name="quiet_to" type="time" value="${a.quiet_to || ''}"><span class="pa-hint">It may cross midnight, like 22:00 to 07:00.</span></label>
<label>Status <select name="status"><option value="active"${a.status !== 'paused' ? raw(' selected') : ''}>Active</option><option value="paused"${a.status === 'paused' ? raw(' selected') : ''}>Paused</option></select></label>
<label class="pa-wide pa-check"><input type="hidden" name="send_to_vibe" value="0"><input type="checkbox" name="send_to_vibe" value="1"${a.send_to_vibe === false ? '' : raw(' checked')}> Send each run to Vibe <span class="pa-hint">Each result also lands in a chat named after this agent on openvibe.chat/vibe, where you can ask Vibe about it.</span></label>
</div>`;
    }
    const when = (a) => a.schedule === 'off' ? 'Runs when you run it' : (a.schedule === 'hourly' ? 'Every hour'
        : a.schedule === 'daily' ? `Every day at ${a.schedule_at} UTC` : `Every ${DAYS[a.schedule_dow]} at ${a.schedule_at} UTC`)
        + (a.quiet_from ? `, quiet ${a.quiet_from}–${a.quiet_to} UTC` : '');
    function fields(body) {
        return { name: body.name, instructions: body.instructions, mode: body.mode,
            budget_per_run_usd: Number(body.budget_per_run_usd), daily_runs_max: Number(body.daily_runs_max), schedule: body.schedule,
            schedule_at: body.schedule_at || null, schedule_dow: body.schedule_dow === '' ? null : Number(body.schedule_dow),
            quiet_from: body.quiet_from || null, quiet_to: body.quiet_to || null, status: body.status,
            // The hidden 0 always comes; a ticked box adds a 1.
            ...(body.send_to_vibe !== undefined ? { send_to_vibe: [].concat(body.send_to_vibe).includes('1') } : {}) };
    }

    r.get('/me/agents', async (req, res) => {
        if (!signed(req)) return login(req, res);
        // Vibe is made on the first visit (contacts.ensureVibe), so the roster is never empty.
        const rows = await contacts.list(s, config, owner(req));
        const waiting = await approvals.pendingCount(s, owner(req));
        const chosen = TEMPLATES.find((x) => x.id === req.query.template) || null;
        page(req, res, 'Your agents', html`<header class="pa-head"><p class="pa-eyebrow">OpenVibe.Actor · your agents · alpha</p><h1>Your agents</h1>
<p class="pa-lede">Each agent is a contact: a face, a model, a computer to work on, the apps it may use, its memory, and how much it may do without asking. Every run is an ordinary Actor task, with the same checks, costs and limits.</p>
<p class="ac-links"><a href="/me/approvals">Approvals${waiting ? html` <span class="pill pill-running">${String(waiting)} waiting</span>` : ''}</a> <a href="/memory">Memory</a></p></header>
${ui.roster(rows.map((row) => ({ row, agent: contacts.wire(row) })), { when })}
<section class="pa-panel" aria-labelledby="ac-add-h"><h2 id="ac-add-h">Add an agent</h2><p class="pa-hint">Each comes ready with its instructions; change anything after.</p>${ui.presetCards(contacts.presets().presets)}</section>
<section class="pa-panel" aria-labelledby="pa-templates-h"><h2 id="pa-templates-h">Or set up a standing job</h2><p class="pa-hint">An agent with a schedule: it runs on its own and keeps notes between runs.</p>
<ul class="pa-templates">${TEMPLATES.map((x) => html`<li><a class="pa-template${chosen && chosen.id === x.id ? ' is-chosen' : ''}" href="/me/agents?template=${x.id}#create"><strong>${x.name}</strong><span>${x.line}</span><small>${when({ schedule: x.schedule, schedule_at: x.schedule_at, schedule_dow: x.schedule_dow })}</small></a></li>`)}</ul></section>
${importPanel()}<section class="pa-panel" id="create"><h2>${chosen ? `Create: ${chosen.name}` : 'Create an agent'}</h2>${chosen ? html`<p class="pa-hint">Fill in the parts in &lt;angle brackets&gt;, then create it. You can change anything later.</p>` : ''}<form method="post" action="/me/agents">${form(chosen ? { ...chosen, id: undefined } : {})}<button type="submit" class="pa-btn pa-primary">Create agent</button></form></section>`);
    });
    r.post('/me/agents', async (req, res) => {
        if (!write(req, res)) return;
        if (UNFILLED.test(String(req.body.instructions || ''))) {
            return page(req, res, 'Create agent', html`<h1>Create agent</h1><p>Fill in the parts in &lt;angle brackets&gt; first: the agent needs to know what you mean.</p><form method="post" action="/me/agents">${form(req.body)}<button type="submit" class="pa-btn pa-primary">Create agent</button></form>`, 422);
        }
        const out = await personal.create(s, config, owner(req), fields(req.body));
        if (!out.row) return page(req, res, 'Create agent', html`<h1>Create agent</h1><p>${out.error || 'Agent limit reached.'}</p><form method="post" action="/me/agents">${form(req.body)}<button type="submit">Create</button></form>`, out.limit ? 429 : 422);
        res.redirect(303, `/me/agents/${out.row.id}`);
    });
    r.post('/me/agents/preset', async (req, res) => {
        if (!write(req, res)) return;
        const out = await contacts.create(s, config, owner(req), { preset: String((req.body || {}).preset || '') });
        if (!out.row) return page(req, res, 'Add an agent', html`<h1>Add an agent</h1><p>${out.error || 'Agent limit reached.'}</p><p><a href="/me/agents">Your agents</a></p>`, out.limit ? 429 : 422);
        res.redirect(303, `/me/agents/${out.row.id}`);
    });
    r.post('/me/agents/:id/level', async (req, res) => {
        if (!write(req, res)) return;
        const out = await contacts.setLevel(s, config, owner(req), req.params.id, String((req.body || {}).level || ''));
        if (!out) return page(req, res, 'Agent not found', html`<h1>Agent not found</h1>`, 404);
        if (out.error) return page(req, res, 'Not saved', html`<h1>Not saved</h1><p>${out.error}</p><p><a href="/me/agents/${req.params.id}">Back</a></p>`, 422);
        res.redirect(303, `/me/agents/${req.params.id}#level`);
    });
    // The approval inbox (agents/approvals.js): what an agent asked to do while its owner was away.
    const APPROVAL_STATE = { pending: ['Waiting for you', 'pill-running'], approved: ['Approved', 'pill-succeeded'], declined: ['Declined', 'pill-failed'], expired: ['Expired', 'pill-failed'] };
    const approvalPill = (a) => html`<span class="pill ${APPROVAL_STATE[a.state][1]}">${APPROVAL_STATE[a.state][0]}</span>`;
    r.get('/me/approvals', async (req, res) => {
        if (!signed(req)) return login(req, res);
        const rows = await approvals.list(s, owner(req));
        page(req, res, 'Approvals', html`<header class="pa-head"><p class="pa-eyebrow">OpenVibe.Actor · approvals</p><h1>Approvals</h1>
<p class="pa-lede">When one of your agents runs while you are away and its work would act for you outside Actor (a coding task on your own machine, a send, a purchase, a deletion, a password field, a Space publish), it asks here first. Nothing runs until you approve. An action's run had already stopped when it asked, so approving it is consent for you to run the task again. A tip your agent asks to send is different: approving it pays it at once, from your own Vibes, with your own session. You may also say "always allow this for this agent": that covers this one kind of step, on this one target, until you revoke it. Spending money, a password, a deletion and a new recipient always ask. A request you leave expires after ${String(approvals.EXPIRES_DAYS)} days.</p></header>
${rows.length ? html`<ul class="pa-cards">${rows.map((a) => html`<li class="pa-card"><a href="/me/approvals/${a.id}"><strong>${a.summary}</strong></a> ${approvalPill(a)}<span class="pa-when">${kinds.label(a.kind)} · Asked ${time(a.created_at)}</span></li>`)}</ul>`
        : html`<p class="pa-empty">Nothing to approve. Your agents have not asked for anything yet.</p>`}
<p><a href="/me/agents">Your agents</a></p>`);
    });
    /**
     * The approval card. A payment (plan HO7) says more than the other kinds: how much, who receives it, why, and
     * what is left of the agent's weekly allowance — the four things a person needs before they pay with their own
     * Vibes.
     */
    const approvalCard = async (req, res, a, { notice = null, status = 200 } = {}) => {
        const p = typeof a.payload === 'string' ? JSON.parse(a.payload) : a.payload;
        // The agent by its name (a person's own agent: another person's is never looked up here).
        const agent = a.agent_id ? await contacts.get(s, owner(req), a.agent_id).catch(() => null) : null;
        const agentName = agent && agent.name ? agent.name : 'your agent';
        // The always-ask floor, said in plain words before anything technical: what the request stored, what its words
        // say, and a raw command that deletes by its argv (rm, shred …), the same checks approvals.decide uses.
        const floor = approvals.floorOf(a).filter((c) => CAUTION[c]);
        const coding = a.kind === 'codes.task';
        // A tip (plan HO7) is the only money step with a card of its own: what it pays, who receives it and why.
        const money = a.kind === 'money' && p && p.spend === 'tip' ? p : null;
        const cmd = coding ? null : commandLine(p);
        const nowMs = Date.parse(s.iso()) || Date.now();   // the service's own clock (a test's clock in a test)
        const where = p && typeof p.machine === 'string' && p.machine ? p.machine : null;
        // "Always allow" (plan HO1): this one kind of step on this one exact target, for this agent. Never a floor step.
        const canAllow = a.state === 'pending' && !floor.length && Boolean(a.agent_id) && Boolean(a.target);
        const allowButton = canAllow
            ? html`<button type="submit" name="decision" value="approve_always" class="pa-btn">Always allow this for ${agentName}</button>`
            : '';
        const allowHint = a.state !== 'pending' ? ''
            : floor.length ? html`<p class="pa-hint">This always asks, so it can never be always allowed.</p>`
                : canAllow ? html`<p class="pa-hint">Always allowing covers exactly this, and nothing else: ${kinds.phrase(a.kind, a.target)}. Anything different still asks. You can take it back on <a href="/me/agents/${a.agent_id}#always">${agentName}'s page</a>.</p>`
                    : '';
        // What is left of this agent's allowance this week, and what the tip would take of it.
        const left = money && a.agent_id ? await spend.allowance(s, owner(req), a.agent_id) : null;
        const paid = money ? await spend.paidFor(s, owner(req), a.id) : null;
        const decided = a.state === 'approved'
            ? (paid ? `You approved this once and paid ${paid.amount} Vibes to ${paid.to_label || paid.to_subject}.`
                : (a.decision_scope === 'always' ? `You approved this and allowed it from now on for ${agentName}.` : 'You approved this once.'))
            : (a.state === 'declined' ? 'You declined this.' : 'Nobody answered this one in time.');
        const buttons = a.state === 'pending'
            ? html`<form method="post" action="/me/approvals/${a.id}" class="pa-actions"><button type="submit" name="decision" value="approve" class="pa-btn pa-primary">${coding ? 'Approve and start it' : (money ? 'Approve and pay' : 'Approve for a retry')}</button> ${allowButton} <button type="submit" name="decision" value="decline" class="pa-btn">Decline</button></form>${allowHint}`
            : html`<p class="pa-hint">${decided}${a.decided_at ? html` Decided ${whenAt(a.decided_at, nowMs)}.` : ''}</p>${a.result_task_id ? html`<p>Started as <a href="/tasks/${a.result_task_id}">this task</a>.</p>` : ''}`;
        const moneyCard = money ? html`<section class="pa-panel"><h2>What it would do</h2>
<p>It would send <strong>${Number(money.amount) || 0} Vibes</strong> to ${money.to_label || money.to}${money.to_label && money.to && money.to_label !== money.to ? html` <span class="pa-when">(${money.to})</span>` : ''}.</p>
${money.reason ? html`<p>Why: ${money.reason}</p>` : ''}
${left ? html`<p>Left this week for ${agentName}: <strong>${left.left} of ${left.weekly} Vibes</strong> (${left.start} to ${left.end} UTC).</p>` : ''}
<p class="pa-hint">The money moves when you approve, from your own Vibes and with your own session. It is never paid later and never by the agent itself.</p></section>` : '';
        page(req, res, 'Approval', html`<p class="pa-eyebrow"><a href="/me/approvals">Approvals</a></p><h1>${a.summary}</h1>
<p>${approvalPill(a)} <span class="pa-when">${kinds.label(a.kind)} · Asked ${whenAt(a.created_at, nowMs)}${a.agent_id ? html` by <a href="/me/agents/${a.agent_id}">${agentName}</a>` : ''}${a.task_id ? html` in <a href="/tasks/${a.task_id}">this run</a>` : ''}${a.state === 'pending' && a.expires_at ? html` · expires ${whenAt(a.expires_at, nowMs)}` : ''}</span></p>
${notice ? html`<p class="pa-caution" role="alert">${notice}</p>` : ''}
${floor.length ? html`<p class="pa-caution" role="note">${floor.map((c) => CAUTION[c]).join(' ')}</p>` : ''}
${money ? moneyCard : (coding
            ? html`<section class="pa-panel"><h2>What it would do</h2><p>Start a coding task on your own machine through <a href="https://openvibe.codes/run">OpenVibe.Codes</a> with this request. You get the summary, the changed files and the patch; it pushes nowhere unless the request asks for a branch and your machine holds a GitHub token.</p>
<pre class="pa-pre">${String(p.task || '').slice(0, 8000)}</pre></section>`
            : html`<section class="pa-panel"><h2>What it would do</h2><p>${a.summary}</p>
${cmd ? html`<p class="pa-cmd-where">${where ? html`On <b>${where}</b>, it runs:` : 'It runs:'}</p><pre class="pa-pre pa-cmd">${cmd}</pre>${p && p.cwd ? html`<p class="pa-hint">In ${String(p.cwd).slice(0, 300)}</p>` : ''}` : ''}
<h3 class="pa-sub">The exact request</h3><pre class="pa-pre">${JSON.stringify(p, null, 2).slice(0, 8000)}</pre></section>`)}
${buttons}`, status);
    };
    r.get('/me/approvals/:id', async (req, res) => {
        if (!signed(req)) return login(req, res);
        const a = await approvals.get(s, owner(req), req.params.id);
        if (!a) return page(req, res, 'Request not found', html`<h1>Request not found</h1><p><a href="/me/approvals">Approvals</a></p>`, 404);
        return approvalCard(req, res, a);
    });
    r.post('/me/approvals/:id', async (req, res) => {
        if (!write(req, res)) return;
        // A payment is paid with the person's own token: the session they are sitting in (plan HO7). A service
        // deciding for them never pays, and the request stays pending until they do it themselves.
        const personToken = req.viewer && req.viewer.token ? req.viewer.token : null;
        const out = await approvals.decide(ctx, owner(req), req.params.id, String((req.body || {}).decision || ''), { personToken });
        if (out.error) {
            // A refusal that leaves the request pending: the reason is shown on the card and the person may try again.
            const row = await approvals.get(s, owner(req), req.params.id);
            if (out.pending && row) return approvalCard(req, res, row, { notice: out.error });
            return page(req, res, 'Not done', html`<h1>Not done</h1><p>${out.error}</p><p><a href="/me/approvals">Approvals</a></p>`, out.status);
        }
        res.redirect(303, out.task ? `/tasks/${out.task.id}` : `/me/approvals/${req.params.id}`);
    });

    // ── An agent's voice as a file (actor.voice@1) ──────────────────────────────────────────────────────
    // The panel on the agent's page: download its voice, share it as a public link, or import somebody else's.
    // Nothing here is a signature: the document's integrity block says the file was not edited, never who wrote it.
    const voicePanel = (a, doc, shared) => html`<section class="pa-panel" id="voice" aria-labelledby="ac-voice-h"><h2 id="ac-voice-h">Its voice</h2>
<p class="pa-hint">An agent's voice is a small file: its name, a short bio, the house voice it speaks in, its rules, its level, and the model and apps it prefers (ids, never a key). Nothing else — never its memory, never a connector's token, never a file. Whoever you send it to can make an agent that speaks in this voice; it starts at level ask, and they raise it themselves.</p>
${a.bio ? html`<p>${a.bio}</p>` : ''}
${a.rules && a.rules.length ? html`<h3>Its rules</h3><ul>${a.rules.map((r) => html`<li>${r}</li>`)}</ul>` : ''}
<p class="pa-actions"><a class="pa-btn" href="/me/agents/${a.id}/voice" download="voice.json">Download its voice (JSON)</a>
${shared
        ? html`<a class="pa-btn" href="/voices/${shared.id}">Its public link</a><form method="post" action="/me/agents/${a.id}/share/stop" class="pa-actions"><button type="submit" class="pa-btn">Stop sharing</button></form>`
        : html`<form method="post" action="/me/agents/${a.id}/share" class="pa-actions"><button type="submit" class="pa-btn">Share this voice</button></form>`}
<a class="pa-btn" href="/me/agents#import">Import a voice</a></p>
${provenance(a)}${suggestedApps(a)}</section>`;

    // Where this agent's voice came from, and what may be said about the author.
    //   a shared voice   Actor shared it, so Actor knows who wrote it: the author is a link.
    //   a file           the file may name anyone and nothing checks it: the author is a claim, said plainly.
    const provenance = (a) => {
        if (a.voice_source && String(a.voice_source).startsWith('shared:')) {
            return html`<p class="pa-hint">Borrowed from a shared voice${a.voice_author_name ? html` by <a href="https://openvibe.network/@${a.voice_author_name}">${a.voice_author_name}</a>` : ''}.</p>`;
        }
        if (a.voice_source === 'file') {
            return html`<p class="pa-hint">Imported from a file.${a.voice_author_name ? html` It says it was made by ${a.voice_author_name}; that is not checked.` : ''}</p>`;
        }
        return '';
    };
    // The apps the voice it came from used: never connected for it, listed so the person can add the ones they want.
    const suggestedApps = (a) => {
        let list = a.voice_suggested_apps;
        if (typeof list === 'string') { try { list = JSON.parse(list); } catch { list = []; } }
        return Array.isArray(list) && list.length && a.voice_source
            ? html`<p class="pa-hint">The voice it came from used ${list.join(', ')}. None is connected for it: add the ones you want under its apps.</p>`
            : '';
    };

    const importPanel = () => html`<section class="pa-panel" id="import" aria-labelledby="ac-import-h"><h2 id="ac-import-h">Import an agent's voice</h2>
<p class="pa-hint">A voice file is a small JSON document: an agent's name, a short bio, the house voice it speaks in, its rules, its level, and the model and apps it prefers. It never carries memory, a connector's token or a file. Paste one and it becomes one of your agents, at level ask — you raise it yourself.</p>
<p class="pa-hint">A file may name an author. Nothing checks that, so the agent will say so rather than claim it is that person's.</p>
<form method="post" action="/me/agents/import"><label class="pa-wide">Voice file (JSON) <textarea name="voice" rows="6" required placeholder='{"voice":"actor.voice@1","name":"A house voice"}'></textarea></label><button type="submit" class="pa-btn pa-primary">Import this voice</button></form></section>`;

    // The agent's voice as a file: the owner downloads it, and another person's agent is the same 404 as one that does
    // not exist.
    r.get('/me/agents/:id/voice', async (req, res) => {
        if (!signed(req)) return login(req, res);
        const a = await find(req, res); if (!a) return;
        const doc = voice.build(a, { subject: req.viewer.subject, name: req.viewer.username || null });
        res.set('Content-Type', 'application/json; charset=utf-8');
        res.set('Content-Disposition', 'attachment; filename="voice.json"');
        res.send(JSON.stringify(doc, null, 2));
    });

    // Import a voice from a file: a pasted actor.voice@1 document becomes a new agent, at level ask whatever the file
    // says. The file may name an author; nothing checks that, and the page says so.
    r.post('/me/agents/import', async (req, res) => {
        if (!write(req, res)) return;
        const text = String((req.body || {}).voice || '');
        let input;
        try { input = JSON.parse(text); } catch { return voicePage(req, res, 'That file is not JSON.', 422); }
        const out = await importVoice(req, input, { source: 'file' });
        if (out.error) return voicePage(req, res, out.error, out.limit ? 429 : 422);
        res.redirect(303, `/me/agents/${out.row.id}`);
    });

    // Share this voice: a public link (/voices/<id>) that anybody may borrow from. Actor's own record of who shared
    // it — the only place a voice's author is vouched for.
    r.post('/me/agents/:id/share', async (req, res) => {
        if (!write(req, res)) return;
        const a = await find(req, res); if (!a) return;
        const doc = voice.build(a, { subject: req.viewer.subject, name: req.viewer.username || null });
        const shared = await shares.share(s, owner(req), a, doc, req.viewer.username || null);
        res.redirect(303, `/voices/${shared.id}`);
    });
    // Stop sharing: the link answers 410 from then on.
    r.post('/me/agents/:id/share/stop', async (req, res) => {
        if (!write(req, res)) return;
        const a = await find(req, res); if (!a) return;
        await shares.revoke(s, owner(req), a.id);
        res.redirect(303, `/me/agents/${a.id}#voice`);
    });

    // The shared voice: anybody may look at it and borrow it. The author is Actor's own record, so it is a link.
    r.get('/voices/:id.json', async (req, res) => {
        const row = await shares.get(s, req.params.id);
        if (!row) return res.status(404).json({ error: 'No such voice.' });
        if (row.revoked_at) return res.status(410).json({ error: 'This voice is no longer shared.' });
        res.set('Content-Type', 'application/json; charset=utf-8');
        res.json(row.voice);
    });
    r.get('/voices/:id', async (req, res) => {
        const id = String(req.params.id || '').replace(/\.json$/, '');
        const row = await shares.get(s, id);
        if (!row) return page(req, res, 'Voice not found', html`<h1>Voice not found</h1><p>That link is not a voice.</p>`, 404);
        if (row.revoked_at) return page(req, res, 'Voice not shared', html`<h1>This voice is no longer shared</h1><p>Its owner stopped sharing it. Ask them for a new link.</p>`, 410);
        const doc = voice.read(row.voice).doc || row.voice;
        page(req, res, doc.name, html`<p class="crumbs"><a href="/">OpenVibe.Actor</a></p>
<header class="pa-head"><p class="pa-eyebrow">OpenVibe.Actor · a shared voice</p><h1>${doc.name}</h1>
${doc.bio ? html`<p class="pa-lede">${doc.bio}</p>` : ''}</header>
<section class="pa-panel"><h2>Its instructions</h2><p class="pa-hint">What it is told to do on every run. Borrowing it gives your agent exactly these words; read them first.</p><pre class="pa-pre">${doc.instructions}</pre></section>
<section class="pa-panel"><h2>Its rules</h2>${doc.rules && doc.rules.length ? html`<ul>${doc.rules.map((r) => html`<li>${r}</li>`)}</ul>` : html`<p>No rules: it speaks in one voice.</p>`}</section>
${doc.apps && doc.apps.length ? html`<section class="pa-panel"><h2>The apps it uses</h2><p>${doc.apps.join(', ')}</p><p class="pa-hint">A borrowed agent gets none of them: you connect each one yourself, with your own account, on its page.</p></section>` : ''}
<section class="pa-panel"><h2>Borrow this agent</h2>
<p class="pa-hint">It asks for level ${doc.level}. Borrowing it makes an agent of your own — at level ask, whatever the file asks for — and you raise it yourself. It keeps no memory and no token of the person who shared it, runs on OpenVibe's own models (never your own keys or your machine until you choose them), and gets none of your apps until you add them.</p>
${row.owner_name ? html`<p class="pa-hint">Shared by <a href="https://openvibe.network/@${row.owner_name}">${row.owner_name}</a>.</p>` : ''}
${signed(req) ? html`<form method="post" action="/voices/${row.id}/borrow"><button type="submit" class="pa-btn pa-primary">Borrow this agent</button></form>`
    : html`<p><a class="pa-btn pa-primary" href="/auth/login?next=${encodeURIComponent(req.originalUrl)}">Sign in to borrow it</a></p>`}</section>`);
    });
    // Borrowing a shared voice: the author comes from Actor's record, not from the document.
    r.post('/voices/:id/borrow', limits.budget('actor.voice.borrow'), async (req, res) => {
        if (!signed(req)) return login(req, res);
        if (!write(req, res)) return;
        const row = await shares.get(s, req.params.id);
        if (!row) return page(req, res, 'Voice not found', html`<h1>Voice not found</h1>`, 404);
        if (row.revoked_at) return page(req, res, 'Voice not shared', html`<h1>This voice is no longer shared</h1>`, 410);
        const read = voice.read(row.voice);
        if (read.error) return voicePage(req, res, read.error, 422);
        const out = await importVoice(req, read.doc, {
            source: `shared:${row.id}`, authorChecked: true,
            author: { subject: String(row.owner || '').replace(/^user:/, ''), name: row.owner_name || null },
        });
        if (out.error) return voicePage(req, res, out.error, out.limit ? 429 : 422);
        res.redirect(303, `/me/agents/${out.row.id}`);
    });

    // The page a refused or broken voice ends on: what went wrong, in plain words.
    function voicePage(req, res, message, status = 422) {
        return page(req, res, 'Voice not taken', html`<h1>Voice not taken</h1><p>${message}</p><p><a href="/me/agents">Your agents</a></p>`, status);
    }

    // A voice document becomes an agent: the new agent keeps the voice, starts at level ask and keeps no memory.
    async function importVoice(req, input, { source = 'file', author = null, authorChecked = false } = {}) {
        const read = voice.read(input);
        if (read.error) return { error: read.error };
        const fields = voice.toContact(read.doc, { source, authorChecked });
        if (author) {
            fields.voice_author = author.subject;
            fields.voice_author_name = author.name || null;
        }
        const out = await contacts.create(s, config, owner(req), {
            name: fields.name, face: fields.face, model: fields.model, apps: fields.apps, memory: null,
            level: fields.level, instructions: fields.instructions,
        }, { bio: fields.bio, rules: fields.rules, suggested_apps: fields.suggested_apps, voice_author: fields.voice_author, voice_author_name: fields.voice_author_name,
            voice_author_checked: fields.voice_author_checked, voice_source: fields.voice_source });
        if (!out.row) return { error: out.error || 'Agent limit reached.', limit: out.limit };
        return { row: out.row };
    }

    r.get('/me/agents/:id', async (req, res) => {
        if (!signed(req)) return login(req, res);
        const a = await find(req, res); if (!a) return;
        const notes = await personal.memory(s, a.owner, a.id);
        const suggestions = await personal.proposals(s, a.owner, a.id);
        const pendingSuggestions = suggestions.filter((p) => p.state === 'pending');
        const applied = suggestions.filter((p) => p.state === 'applied').slice(0, 5);
        const runs = await s.db.many('SELECT id, state, created_at, result, cost_usd, error_detail FROM tasks WHERE requester = $1 AND via = $2 ORDER BY id DESC LIMIT 20', [a.owner, `agent:${a.id}`]);
        // The night's tidy (HO5): this agent's own diary and the changes it made, with the undo.
        const diaries = await tidy.diary(s, a.owner, { agentId: a.id, limit: 3 });
        const tidyChanges = await tidy.changes(s, a.owner, { agentId: a.id, limit: 10 });
        // What this agent may always do (plan HO1), and every decision the person made about its asks.
        const allowRules = await allows.list(s, a.owner, a.id);
        // What it may spend this week (plan HO7), and what it has spent.
        const allowance = await spend.allowance(s, a.owner, a.id);
        const payments = await spend.listFor(s, a.owner, { agentId: a.id, limit: 20 });
        const decisions = await s.db.many(`SELECT id, kind, summary, state, decision_scope, decided_by, decided_at, created_at
            FROM actor_approvals WHERE owner = $1 AND agent_id = $2 ORDER BY created_at DESC LIMIT 20`, [a.owner, a.id]);
        // Its Vibe chat (agents/vibe-deliver.js), once a run has gone there.
        const vibeChat = a.send_to_vibe ? await s.db.maybe("SELECT chat_url FROM actor_vibe_deliveries WHERE agent_id = $1 AND owner = $2 AND state = 'sent' AND chat_url IS NOT NULL ORDER BY sent_at DESC LIMIT 1", [a.id, a.owner]) : null;
        // The run journal: each run's first line (its answer, or why it did not finish) and what it cost.
        const gist = (t) => {
            let r = t.result;
            if (typeof r === 'string') { try { r = JSON.parse(r); } catch { r = null; } }
            const text = r && typeof r.answer === 'string' ? r.answer : (t.error_detail || '');
            const line = text.replace(/[#*_`>]+/g, '').replace(/\s+/g, ' ').trim();
            return line.length > 140 ? `${line.slice(0, 140).replace(/\s+\S*$/, '')}…` : line;
        };
        const usd = (v) => (v == null || !Number.isFinite(Number(v)) ? '' : ` · $${Number(v) < 0.01 ? Number(v).toFixed(4) : Number(v).toFixed(2)}`);
        const pill = (state) => state === 'succeeded' ? 'pill-succeeded' : state === 'failed' || state === 'cancelled' ? 'pill-failed' : 'pill-running';
        const contact = contacts.wire(a);
        // The agent's voice as a file (actor.voice@1): what it is, in a form somebody else can speak in.
        const doc = voice.build(a, { subject: req.viewer.subject, name: req.viewer.username || null });
        // The voice's public link, when the person shares it.
        const shared = await shares.current(s, a.owner, a.id);
        page(req, res, a.name, html`<p class="crumbs"><a href="/me/agents">Your agents</a></p>
<header class="pa-head ac-sheet-head">${ui.face(contact, 64)}<div><h1>${a.name}</h1><p class="ac-sheet-uses">${ui.usesLine(contact)}</p>
<p class="pa-lede">${ui.levelChip(contact.level)} <span class="pill ${a.status === 'paused' ? 'pill-failed' : 'pill-succeeded'}">${a.status === 'paused' ? 'Paused' : 'Active'}</span> ${when(a)}${a.next_run_at && a.status !== 'paused' && a.schedule !== 'off' ? html` · next ${time(a.next_run_at)}` : ''}</p></div></header>
${a.last_skip_reason ? html`<p class="notice" role="status">The last scheduled run was skipped: ${a.last_skip_reason}</p>` : ''}
<div class="pa-grid">
<section class="pa-panel"><h2>Run now</h2><form method="post" action="/me/agents/${a.id}/run"><label>Input (optional) <span class="pa-hint">Anything this run should also consider.</span><textarea name="input" maxlength="8000" rows="3"></textarea></label><button type="submit" class="pa-btn pa-primary">Run now</button></form></section>
<section class="pa-panel" id="level" aria-labelledby="ac-level-h"><h2 id="ac-level-h">How much it may do on its own</h2>${ui.levelPicker(contact)}</section>
<section class="pa-panel"><h2>Wake it when something happens</h2><p>Besides its schedule, this agent can run the moment something happens: a channel goes live, a new blog post, a page changes, a price drops, a webhook arrives. <a href="https://openvibe.watch">OpenVibe.Watch</a> watches for it and runs this agent with what it saw.</p>
<p class="pa-actions"><a class="pa-btn" href="https://openvibe.watch/watches/new?template=event&amp;agent_id=${a.id}">When something happens on OpenVibe</a> <a class="pa-btn" href="https://openvibe.watch/watches/new?template=page&amp;agent_id=${a.id}">When a page changes</a></p></section>
<section class="pa-panel"><h2>Recent runs</h2>${vibeChat && /^https:\/\/openvibe\.chat\/vibe\/v-[0-9a-f]{12}$/.test(vibeChat.chat_url) ? html`<p class="pa-hint">Each run also lands in <a href="${vibeChat.chat_url}">its Vibe chat</a>, where you can ask Vibe about it.</p>` : ''}${runs.length ? html`<ul class="pa-runs">${runs.map((t) => html`<li><a href="/tasks/${t.id}">${time(t.created_at)}</a> <span class="pill ${pill(t.state)}">${t.state}</span>${usd(t.cost_usd)}${gist(t) ? html`<span class="pa-run-gist">${gist(t)}</span>` : ''}</li>`)}</ul>` : html`<p class="muted">No run yet.</p>`}</section>
</div>
<section class="pa-panel" id="always" aria-labelledby="pa-always-h"><h2 id="pa-always-h">What it may always do</h2>
<p class="pa-hint">When you said "always allow this for this agent", the permission is here: one kind of step, on one target. Take any of them back and the next one asks again. Spending money, a password, a deletion and a new recipient always ask, whatever is allowed here.</p>
${allowRules.length ? html`<ul class="pa-notes">${allowRules.map((r) => html`<li><p class="pa-note-text">${kinds.phrase(r.kind, r.target)}</p><p class="pa-note-meta">Allowed ${time(r.created_at)}</p>
<form method="post" action="/me/agents/${a.id}/allows/${r.id}/revoke" class="pa-actions"><button type="submit" class="pa-danger-link">Revoke</button></form></li>`)}</ul>` : html`<p class="muted">Nothing is always allowed for this agent.</p>`}</section>
<section class="pa-panel" id="spend" aria-labelledby="ac-spend-h"><h2 id="ac-spend-h">What it may spend</h2>
<p class="pa-hint">An agent may tip a creator on OpenVibe with your Vibes, but only after you approve each tip, and only up to what is left of its weekly allowance. Zero means it may not spend at all: the spending tool is then not offered to it at all.</p>
<form method="post" action="/me/agents/${a.id}/spend"><label>Weekly allowance (Vibes) <input name="weekly_vibes" type="number" min="0" max="${spend.MAX_ALLOWANCE}" step="1" value="${allowance.weekly}"></label> <button type="submit" class="pa-btn">Save allowance</button></form>
<p>Left this week: <strong>${allowance.left} of ${allowance.weekly} Vibes</strong> (${allowance.start} to ${allowance.end} UTC). The week starts on Monday.</p>
<h3 class="pa-sub">What it spent</h3>
${payments.length ? html`<ul class="pa-notes">${payments.map((p2) => html`<li><p class="pa-note-text">${p2.state === 'paid' ? html`${p2.amount} Vibes to ${p2.to_label || p2.to_subject}` : html`${p2.amount} Vibes to ${p2.to_label || p2.to_subject} — not paid`}</p>
<p class="pa-note-meta">${p2.reason ? html`${p2.reason} · ` : ''}${p2.state === 'paid' ? 'Paid' : html`Refused: ${p2.error || 'Billing did not pay it'}`} · ${time(p2.created_at)}</p></li>`)}</ul>` : html`<p class="muted">It has not spent anything yet.</p>`}
</section>
<section class="pa-panel" id="decisions" aria-labelledby="pa-dec-h"><h2 id="pa-dec-h">What you decided</h2>
<p class="pa-hint">Every approval this agent asked for, and what you answered: once, always, or no.</p>
${decisions.length ? html`<ul class="pa-notes">${decisions.map((d) => html`<li><p class="pa-note-text"><a href="/me/approvals/${d.id}">${d.summary}</a></p><p class="pa-note-meta">${kinds.label(d.kind)} · ${d.state === 'approved' ? (d.decision_scope === 'always' ? 'You approved it and allowed it always' : 'You approved it once') : d.state === 'declined' ? 'You declined it' : d.state === 'expired' ? 'It expired, nobody answered' : 'Waiting for you'} · ${time(d.decided_at || d.created_at)}</p></li>`)}</ul>` : html`<p class="muted">This agent has not asked for anything yet.</p>`}</section>
${pendingSuggestions.length || applied.length ? html`<section class="pa-panel" aria-labelledby="pa-sugg-h"><h2 id="pa-sugg-h">Suggestions from your agent</h2>
<p class="pa-hint">After a run that passed its check, the agent may suggest a line for its instructions. Nothing changes until you add it, and you can undo it.</p>
${pendingSuggestions.length ? html`<ul class="pa-notes">${pendingSuggestions.map((p) => html`<li><p class="pa-note-text">${p.text}</p><p class="pa-note-meta">Suggested ${time(p.created_at)}${p.from_task ? html` after <a href="/tasks/${p.from_task}">this run</a>` : ''}</p>
<form method="post" action="/me/agents/${a.id}/suggestions/${p.id}" class="pa-actions"><button type="submit" name="decision" value="apply" class="pa-btn pa-primary">Add to its instructions</button> <button type="submit" name="decision" value="dismiss" class="pa-btn">Dismiss</button></form></li>`)}</ul>` : ''}
${applied.length ? html`<details><summary>Added lately</summary><ul class="pa-notes">${applied.map((p) => html`<li><p class="pa-note-text">${p.text}</p><p class="pa-note-meta">Added ${time(p.decided_at)}</p>
<form method="post" action="/me/agents/${a.id}/suggestions/${p.id}"><button type="submit" name="decision" value="undo" class="pa-danger-link">Undo</button></form></li>`)}</ul></details>` : ''}</section>` : ''}
${voicePanel(a, doc, shared)}<section class="pa-panel"><h2>Memory</h2><p class="pa-hint">What this agent remembers, newest first. Only active notes go into a run. Notes you write are never dropped; when memory is full (50 notes) the oldest note the agent wrote goes first. An agent adds at most one note per run, and only when its answer passed the check; its note is a suggestion until you accept it on <a href="/memory">Memory</a>.</p>
${notes.length ? html`<ul class="pa-notes">${notes.map((n) => html`<li><p class="pa-note-text">${n.text}</p><p class="pa-note-meta"><span class="pill ${n.status === 'suggested' ? 'pill-running' : n.status === 'archived' ? 'pill-failed' : 'pill-succeeded'}">${n.status === 'suggested' ? 'Suggested' : n.status === 'archived' ? 'Archived' : 'Active'}</span> ${n.source === 'agent' ? 'Written by the agent' : 'Written by you'} · ${n.kind} · ${time(n.created_at)}${n.last_used_at ? html` · last used ${time(n.last_used_at)}` : ''}${n.pinned ? ' · pinned' : ''}${n.merged_into ? ' · merged away' : ''}${n.retired_at ? ' · retired' : ''}</p>
${n.status === 'suggested' ? html`<form method="post" action="/memory/${n.id}/accept" class="pa-actions"><button type="submit" class="pa-btn pa-primary">Accept</button> <button type="submit" class="pa-btn" formaction="/memory/${n.id}/decline">Decline</button></form>` : ''}
<form method="post" action="/me/agents/${a.id}/memory/${n.id}/${n.pinned ? 'unpin' : 'pin'}" class="pa-actions"><button type="submit" class="pa-btn">${n.pinned ? 'Unpin' : 'Pin'}</button></form>
<details><summary>Edit or delete</summary><form method="post" action="/me/agents/${a.id}/memory/${n.id}/edit"><label>Note <input name="text" maxlength="${require('../memory').MAX_TEXT}" value="${n.text}"></label><button type="submit" class="pa-btn">Save</button></form>
<form method="post" action="/me/agents/${a.id}/memory/${n.id}/delete"><button type="submit" class="pa-danger-link">Delete note</button></form></details></li>`)}</ul>` : html`<p class="muted">Nothing remembered yet.</p>`}
<form method="post" action="/me/agents/${a.id}/memory"><label>Add a note <textarea name="text" maxlength="${require('../memory').MAX_TEXT}" required rows="2" placeholder="I prefer answers in bullet points."></textarea></label><button type="submit" class="pa-btn">Add note</button></form>
${notes.length ? html`<p><a href="/memory">See all your memory</a> · <a href="/me/agents/${a.id}/forget" class="pa-danger-link">Forget everything</a></p>` : html`<p class="pa-hint"><a href="/memory">Memory</a> · <a href="/me/agents/${a.id}/forget">Forget everything</a></p>`}</section>
${diaries.length || tidyChanges.length ? html`<section class="pa-panel"><h2>Its diary</h2>
<p class="pa-hint">Once a night, if you turned the tidy on in <a href="/memory">Memory</a>, this agent looks at its own notes: it merges the ones that say the same thing, retires the stale ones, pins the ones that keep coming up, and writes what it learned. You can correct the diary, and undo any change for ${tidy.UNDO_DAYS} days.</p>
${diaries.length ? html`<ul class="pa-notes">${diaries.map((d) => html`<li><p class="pa-note-text">${d.text}</p><p class="pa-note-meta">${d.edited_at ? 'Edited' : 'Written'} ${time(d.created_at)}</p>
<details><summary>Edit or delete</summary><form method="post" action="/me/agents/${a.id}/diary/${d.id}/edit"><label>Diary entry <textarea name="text" rows="3" required>${d.text}</textarea></label><button type="submit" class="pa-btn">Save</button></form>
<form method="post" action="/me/agents/${a.id}/diary/${d.id}/delete"><button type="submit" class="pa-danger-link">Delete</button></form></details></li>`)}</ul>` : ''}
${tidyChanges.length ? html`<h3 class="pa-sub">What its nights changed</h3><ul class="pa-notes">${tidyChanges.map((c) => html`<li><p class="pa-note-text">${CHANGE_LABEL[c.kind] || 'Changed a note'}</p><p class="pa-note-meta">${time(c.created_at)}${c.undone_at ? ' · undone' : ''}</p>
${c.undoable ? html`<form method="post" action="/me/agents/${a.id}/changes/${c.id}/undo"><button type="submit" class="pa-danger-link">Undo</button></form>` : ''}</li>`)}</ul>` : ''}
</section>` : ''}
<section class="pa-panel"><h2>Settings</h2><form method="post" action="/me/agents/${a.id}/edit">${form(a)}<button type="submit" class="pa-btn pa-primary">Save settings</button></form>
<form method="post" action="/me/agents/${a.id}/delete" class="pa-delete"><button type="submit" class="pa-danger-link">Delete this agent</button> <span class="pa-hint">Its memory goes with it; its past runs stay on your task list.</span></form></section>`);
    });
    r.post('/me/agents/:id/edit', async (req, res) => { if (!write(req, res)) return; const out = await personal.update(s, config, owner(req), req.params.id, fields(req.body)); if (!out) return page(req, res, 'Agent not found', html`<h1>Agent not found</h1>`, 404); if (!out.row) return page(req, res, 'Invalid agent', html`<h1>Invalid agent</h1><p>${out.error}</p>`, 422); res.redirect(303, `/me/agents/${req.params.id}`); });
    // The weekly allowance (plan HO7): the person's own setting, on their agent's page. 0 turns the spending
    // tool off for that agent.
    r.post('/me/agents/:id/spend', async (req, res) => {
        if (!write(req, res)) return;
        const a = await find(req, res); if (!a) return;
        const out = await spend.setAllowance(s, a.owner, a.id, (req.body || {}).weekly_vibes);
        if (out.error) return page(req, res, 'Not saved', html`<h1>Not saved</h1><p>${out.error}</p><p><a href="/me/agents/${a.id}">Back to the agent</a></p>`, 422);
        res.redirect(303, `/me/agents/${a.id}#spend`);
    });
    r.post('/me/agents/:id/suggestions/:pid', async (req, res) => {
        if (!write(req, res)) return;
        const out = await personal.decide(s, owner(req), req.params.id, req.params.pid, String((req.body || {}).decision || ''));
        if (out.error) return page(req, res, 'Not done', html`<h1>Not done</h1><p>${out.error}</p><p><a href="/me/agents/${req.params.id}">Back to the agent</a></p>`, out.status);
        res.redirect(303, `/me/agents/${req.params.id}`);
    });
    r.post('/me/agents/:id/delete', async (req, res) => { if (!write(req, res)) return; const a = await find(req, res); if (!a) return; if (a.is_vibe) return res.status(409).type('text/plain').send('Vibe is your first agent and cannot be deleted.'); await s.db.query('DELETE FROM actor_agents WHERE id = $1 AND owner = $2', [a.id, a.owner]); res.redirect(303, '/me/agents'); });
    r.post('/me/agents/:id/run', async (req, res) => { if (!write(req, res)) return; const a = await find(req, res); if (!a) return; const out = await personal.run(ctx, a, req.body.input || ''); if (out.code) return page(req, res, 'Run refused', html`<h1>Run refused</h1><p>${out.detail}</p><p><a href="/me/agents/${a.id}">Back to agent</a></p>`, out.status); res.redirect(303, `/tasks/${out.task.id}`); });
    r.post('/me/agents/:id/memory', async (req, res) => { if (!write(req, res)) return; const a = await find(req, res); if (!a) return; const out = await personal.addMemory(s, a.owner, a.id, req.body.text); if (!out.row) return page(req, res, 'Memory refused', html`<h1>Memory refused</h1><p>${out.error || 'Memory is full.'}</p>`, out.limit ? 429 : 422); res.redirect(303, `/me/agents/${a.id}`); });
    r.post('/me/agents/:id/memory/:mem/edit', async (req, res) => {
        if (!write(req, res)) return;
        const a = await find(req, res); if (!a) return;
        const note = await s.db.maybe('SELECT id FROM actor_agent_memory WHERE id = $1 AND agent_id = $2 AND owner = $3', [req.params.mem, a.id, a.owner]);
        if (!note) return page(req, res, 'Note not found', html`<h1>Note not found</h1>`, 404);
        const out = await memoryStore.edit(s, a.owner, note.id, { text: req.body.text });
        if (!out) return page(req, res, 'Note not found', html`<h1>Note not found</h1>`, 404);
        if (out.error) return page(req, res, 'Memory refused', html`<h1>Memory refused</h1><p>${out.error}</p>`, 422);
        res.redirect(303, `/me/agents/${a.id}`);
    });
    r.post('/me/agents/:id/memory/:mem/delete', async (req, res) => { if (!write(req, res)) return; const a = await find(req, res); if (!a) return; await s.db.query('DELETE FROM actor_agent_memory WHERE id = $1 AND agent_id = $2 AND owner = $3', [req.params.mem, a.id, a.owner]); res.redirect(303, `/me/agents/${a.id}`); });
    // Pin and unpin a note by hand (HO5): a pinned note is read first, and the night's tidy never touches it.
    r.post('/me/agents/:id/memory/:mem/pin', async (req, res) => {
        if (!write(req, res)) return;
        const a = await find(req, res); if (!a) return;
        const note = await s.db.maybe('SELECT id FROM actor_agent_memory WHERE id = $1 AND agent_id = $2 AND owner = $3', [req.params.mem, a.id, a.owner]);
        if (!note) return page(req, res, 'Note not found', html`<h1>Note not found</h1>`, 404);
        await memoryStore.pin(s, a.owner, note.id, { by: 'person' });
        res.redirect(303, `/me/agents/${a.id}`);
    });
    r.post('/me/agents/:id/memory/:mem/unpin', async (req, res) => {
        if (!write(req, res)) return;
        const a = await find(req, res); if (!a) return;
        const note = await s.db.maybe('SELECT id FROM actor_agent_memory WHERE id = $1 AND agent_id = $2 AND owner = $3', [req.params.mem, a.id, a.owner]);
        if (!note) return page(req, res, 'Note not found', html`<h1>Note not found</h1>`, 404);
        await memoryStore.unpin(s, a.owner, note.id);
        res.redirect(303, `/me/agents/${a.id}`);
    });
    // The agent's diary (HO5): the person's own words now, or gone.
    r.post('/me/agents/:id/diary/:did/edit', async (req, res) => {
        if (!write(req, res)) return;
        const a = await find(req, res); if (!a) return;
        const out = await tidy.editDiary(s, a.owner, req.params.did, (req.body || {}).text);
        if (out.error) return page(req, res, 'Not saved', html`<h1>Not saved</h1><p>${out.error}</p><p><a href="/me/agents/${a.id}">Back to the agent</a></p>`, 422);
        res.redirect(303, `/me/agents/${a.id}`);
    });
    r.post('/me/agents/:id/diary/:did/delete', async (req, res) => {
        if (!write(req, res)) return;
        const a = await find(req, res); if (!a) return;
        const out = await tidy.deleteDiary(s, a.owner, req.params.did);
        if (out.error) return page(req, res, 'Not deleted', html`<h1>Not deleted</h1><p>${out.error}</p><p><a href="/me/agents/${a.id}">Back to the agent</a></p>`, 404);
        res.redirect(303, `/me/agents/${a.id}`);
    });
    // Undo one change of a night (HO5).
    r.post('/me/agents/:id/changes/:cid/undo', async (req, res) => {
        if (!write(req, res)) return;
        const a = await find(req, res); if (!a) return;
        const out = await tidy.undo(s, a.owner, req.params.cid, { now: Date.now() });
        if (out.error) return page(req, res, 'Not undone', html`<h1>Not undone</h1><p>${out.error}</p><p><a href="/me/agents/${a.id}">Back to the agent</a></p>`, out.status || 400);
        res.redirect(303, `/me/agents/${a.id}`);
    });
    r.get('/me/agents/:id/forget', async (req, res) => { if (!signed(req)) return login(req, res); const a = await find(req, res); if (!a) return; page(req, res, 'Forget memory', html`<h1>Forget all memory for ${a.name}?</h1><form method="post" action="/me/agents/${a.id}/forget"><button type="submit">Forget everything</button></form><p><a href="/me/agents/${a.id}">Cancel</a></p>`); });
    r.post('/me/agents/:id/forget', async (req, res) => { if (!write(req, res)) return; const a = await find(req, res); if (!a) return; await s.db.query('DELETE FROM actor_agent_memory WHERE agent_id = $1 AND owner = $2', [a.id, a.owner]); res.redirect(303, `/me/agents/${a.id}`); });
    // Take back a standing permission (plan HO1): the next identical step asks again.
    r.post('/me/agents/:id/allows/:allowId/revoke', async (req, res) => {
        if (!write(req, res)) return;
        const a = await find(req, res); if (!a) return;
        const rule = await allows.get(s, a.owner, req.params.allowId);
        if (!rule || rule.agent_id !== a.id) return page(req, res, 'Not found', html`<h1>Not found</h1><p><a href="/me/agents/${a.id}">Back to the agent</a></p>`, 404);
        await allows.revoke(s, a.owner, req.params.allowId);
        res.redirect(303, `/me/agents/${a.id}#always`);
    });
    return r;
}

module.exports = { createAgentPages };

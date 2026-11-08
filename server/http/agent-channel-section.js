'use strict';

const { html } = require('../render/html');
const bindings = require('../agents/channel-bindings');
const personal = require('../agents/personal');

const title = (row) => row.kind === 'mail' ? `Mail · ${row.label}` : `${row.kind[0].toUpperCase()}${row.kind.slice(1)} · ${row.label}`;
const action = (agentId, row, verb) => `/me/agents/${encodeURIComponent(agentId)}/channels/${encodeURIComponent(row.kind)}/${encodeURIComponent(row.account_id)}/${verb}`;

async function load({ s, agent, agentMail }) {
    const agents = await personal.list(s, agent.owner);
    // Mail creates addresses lazily. Discover the owner's other agent addresses so
    // the move option is visible without first visiting every agent's page.
    if (agentMail) await Promise.all(agents.filter(a => a.id !== agent.id && !a.is_vibe)
        .map(a => agentMail.statusFor(agent.owner, a).catch(() => null)));
    const [accounts, inboxes] = await Promise.all([
        bindings.list(s, agent.owner),
        s.db.many('SELECT inbox_id, agent_id, enabled FROM actor_mail_inboxes WHERE owner = $1', [agent.owner]),
    ]);
    const mailById = new Map(inboxes.map(row => [row.inbox_id, row]));
    return { agents, accounts: accounts.map(row => row.kind === 'mail'
        ? { ...row, mail: mailById.get(row.account_id) || null } : row) };
}

function mailState(row, names) {
    if (row.kind !== 'mail' || !row.mail) return '';
    const from = row.mail.agent_id;
    return html`<p class="pa-note-meta">Answering ${row.mail.enabled ? 'on' : 'off'}${from && names.has(from)
        ? html` · <a href="/me/agents/${from}#mail">Change this address's answering switch on ${names.get(from)}'s page</a>` : ''}</p>`;
}

function panel(agent, accounts, agents, moved = false) {
    const names = new Map(agents.map(a => [a.id, a.name]));
    const own = accounts.filter(row => row.agent_id === agent.id);
    const available = accounts.filter(row => row.agent_id !== agent.id);
    return html`<section class="pa-panel" id="channels" aria-labelledby="pa-channels-h"><h2 id="pa-channels-h">Where it listens</h2>
<p class="pa-hint">Each address or chat account goes to one agent. Its messages use this agent's instructions and memory. A mail address also needs its answering switch turned on where that address was created.</p>
${moved ? html`<p class="notice" role="status">This account now goes to ${agent.name}.</p>` : ''}
${own.length ? html`<ul class="pa-notes">${own.map(row => html`<li><p class="pa-note-text">${title(row)}</p>${mailState(row, names)}
<form method="post" action="${action(agent.id, row, 'unbind')}" class="pa-actions"><button type="submit" class="pa-danger-link">Unbind</button></form></li>`)}</ul>`
    : html`<p class="muted">No channel accounts are bound to this agent yet.</p>`}
${available.length ? html`<h3 class="pa-sub">Other accounts you can bind here</h3><ul class="pa-notes">${available.map(row => html`<li><p class="pa-note-text">${title(row)}</p>
<p class="pa-note-meta">${row.agent_id ? `Currently on ${names.get(row.agent_id) || 'another agent'}. Moving it stops that agent listening here.` : 'Unbound.'}</p>${mailState(row, names)}
<form method="post" action="${action(agent.id, row, 'bind')}" class="pa-actions"><button type="submit" class="pa-btn">${row.agent_id ? 'Move here' : 'Bind here'}</button></form></li>`)}</ul>` : ''}
</section>`;
}

function register(r, { s, write, find }) {
    r.post('/me/agents/:id/channels/:kind/:accountId/bind', async (req, res) => {
        if (!write(req, res)) return;
        const agent = await find(req, res); if (!agent) return;
        const { kind, accountId } = req.params;
        const previous = await bindings.get(s, kind, accountId);
        const row = await bindings.bind(s, { kind, accountId, owner: agent.owner, agentId: agent.id });
        if (!row) return res.status(404).type('text/plain').send('This channel account is unavailable.');
        res.redirect(303, `/me/agents/${agent.id}${previous?.agent_id && previous.agent_id !== agent.id ? '?channel=moved' : ''}#channels`);
    });
    r.post('/me/agents/:id/channels/:kind/:accountId/unbind', async (req, res) => {
        if (!write(req, res)) return;
        const agent = await find(req, res); if (!agent) return;
        const row = await bindings.unbind(s, { kind: req.params.kind, accountId: req.params.accountId, owner: agent.owner, agentId: agent.id });
        if (!row) return res.status(404).type('text/plain').send('This channel account is unavailable.');
        res.redirect(303, `/me/agents/${agent.id}#channels`);
    });
}

module.exports = { load, panel, register };

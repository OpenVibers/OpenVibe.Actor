'use strict';

const { html, time } = require('../render/html');

const parse = (v) => (typeof v === 'string' ? JSON.parse(v) : v) || {};

/** The same complete, editable proposal on the agent and its run. */
function card(agentId, proposal, { findings = [] } = {}) {
    if (!proposal || proposal.kind !== 'skill' || proposal.state !== 'pending') return '';
    const draft = parse(proposal.draft);
    const action = `/me/agents/${agentId}/suggestions/${proposal.id}`;
    return html`<section class="pa-panel sk-draft" aria-label="Skill draft">
<h2>Keep this as a skill?</h2>
<p class="pa-hint">Your agent learned a reusable method after a checked run. Read and edit every part before keeping it. It stays private to you and asks for no new permission.</p>
<form method="post" action="${action}" class="pa-form">
<label>Name <input name="name" maxlength="80" required value="${draft.name || ''}"></label>
<label>Description <input name="description" maxlength="280" required value="${draft.description || ''}"></label>
<label class="pa-wide">Instructions <textarea name="instructions" maxlength="4000" required rows="8">${draft.instructions || ''}</textarea></label>
${findings.length ? html`<div class="pa-wide"><p>Scan findings for this draft:</p><ul>${findings.map((f) => html`<li>${f.note}</li>`)}</ul></div>
<label class="pa-wide"><input type="checkbox" name="read_findings" value="1" required> I read these findings and want to keep this skill.</label>` : ''}
<p class="pa-actions"><button type="submit" name="decision" value="keep" class="pa-btn pa-primary">Keep private skill</button> <button type="submit" name="decision" value="dismiss" class="pa-btn">Dismiss</button></p>
</form><p class="pa-note-meta">Suggested ${time(proposal.created_at)}${proposal.from_task ? html` after <a href="/tasks/${proposal.from_task}">this run</a>` : ''}</p>
</section>`;
}

module.exports = { card };

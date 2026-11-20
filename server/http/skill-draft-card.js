'use strict';

const { html, time } = require('../render/html');

const parse = (v) => (typeof v === 'string' ? JSON.parse(v) : v) || {};

/** The same complete, editable proposal on the agent and its run. */
function card(agentId, proposal, { findings = [] } = {}) {
    if (!proposal || proposal.kind !== 'skill' || proposal.state !== 'pending') return '';
    const draft = parse(proposal.draft);
    const action = `/me/agents/${agentId}/suggestions/${proposal.id}`;
    // Where the draft came from (plan §AD.33): what the person showed it, its own improvement of a skill, or a run.
    const improving = Boolean(proposal.updates_listing);
    const taught = proposal.source === 'teach';
    const helped = proposal.source === 'helped';
    const title = improving ? `Update “${draft.name || 'its skill'}”?` : taught || helped ? 'Keep what you showed it?' : 'Keep this as a skill?';
    const hint = improving
        ? 'It rewrote this skill after a run that needed you. Read and edit it before you keep it; the version before stays one tap away.'
        : taught
            ? 'It watched you do this once and wrote it up as steps it can follow. Read and edit every part, then keep it: it stays private to you and asks for no new permission.'
            : helped
                ? 'You stepped in on this run and showed it part of the job. It wrote what you did, with its own steps, as a skill for next time. Read and edit every part, then keep it.'
            : 'Your agent learned a reusable method after a checked run. Read and edit every part before keeping it. It stays private to you and asks for no new permission.';
    return html`<section class="pa-panel sk-draft${taught || helped ? ' sk-taught' : ''}" aria-label="Skill draft">
<h2>${title}</h2>
${improving && proposal.text ? html`<p class="sk-change">${proposal.text}</p>` : ''}
<p class="pa-hint">${hint}</p>
<form method="post" action="${action}" class="pa-form">
<label>Name <input name="name" maxlength="80" required value="${draft.name || ''}"></label>
<label>Description <input name="description" maxlength="280" required value="${draft.description || ''}"></label>
<label class="pa-wide">Instructions <textarea name="instructions" maxlength="4000" required rows="8">${draft.instructions || ''}</textarea></label>
${findings.length ? html`<div class="pa-wide"><p>Scan findings for this draft:</p><ul>${findings.map((f) => html`<li>${f.note}</li>`)}</ul></div>
<label class="pa-wide"><input type="checkbox" name="read_findings" value="1" required> I read these findings and want to keep this skill.</label>` : ''}
<p class="pa-actions"><button type="submit" name="decision" value="keep" class="pa-btn pa-primary">${improving ? 'Update the skill' : 'Keep private skill'}</button> <button type="submit" name="decision" value="dismiss" class="pa-btn">Dismiss</button></p>
</form><p class="pa-note-meta">Suggested ${time(proposal.created_at)}${proposal.from_task ? html` after <a href="/tasks/${proposal.from_task}">this run</a>` : ''}</p>
</section>`;
}

module.exports = { card };

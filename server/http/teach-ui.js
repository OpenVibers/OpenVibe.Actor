'use strict';

/**
 * Teach a task, on an agent's page (plan §AD.33): the Teach panel (what you will show it, where it starts, a browser or
 * a whole desktop), the last few lessons, and on each of the person's own skills its version, Try it, and what the
 * agent changed in it after its runs, with an undo.
 */
const { html, raw } = require('../render/html');

/** "3 minutes ago", "2 days ago": the page's own way of saying when, with the exact time on hover. */
function when(iso, now = Date.now()) {
    const at = Date.parse(iso || '');
    if (!Number.isFinite(at)) return '';
    const a = Math.max(0, Math.round((now - at) / 1000));
    const [n, unit] = a < 60 ? [0, ''] : a < 3600 ? [Math.floor(a / 60), 'minute'] : a < 86400 ? [Math.floor(a / 3600), 'hour'] : [Math.floor(a / 86400), 'day'];
    const words = n ? `${n} ${unit}${n === 1 ? '' : 's'} ago` : 'just now';
    return html`<time datetime="${iso}" title="${String(iso).replace('T', ' ').replace(/\.\d+Z$/, ' UTC').replace(/Z$/, ' UTC')}">${words}</time>`;
}

const LESSON_STATE = {
    started: 'Starting',
    watching: 'Waiting for you to show it',
    drafted: 'Skill written: keep it below',
    empty: 'Nothing was shown',
    failed: 'Could not write the skill',
};
// After the skill is kept: how its practice went.
const PRACTICE_STATE = {
    running: 'practising',
    passed: 'did it on its own',
    failed: 'still needs you: try it with it',
    not_started: 'practice could not start',
};

/** A lesson's line: its state, its steps, its practice. */
function lessonMeta(l) {
    const bits = [LESSON_STATE[l.state] || l.state];
    if (l.source === 'words') bits.push('told in words');
    else if (l.steps) bits.push(`${l.steps} step${l.steps === 1 ? '' : 's'}`);
    if (l.practice_state) bits.push(`${PRACTICE_STATE[l.practice_state] || l.practice_state}${l.practice_done ? ` (try ${l.practice_done} of ${l.practice_rounds})` : ''}`);
    return bits.join(' · ');
}

/** The Teach panel: one sentence, an optional start page, the kind of desk, and the button. */
function panel(agent, lessons = [], { ready = false } = {}) {
    const recent = lessons.slice(0, 3);
    return html`<section class="pa-panel tc-panel" id="teach" aria-labelledby="tc-h">
<div class="tc-head"><span class="tc-mark" aria-hidden="true"><span></span></span><h2 id="tc-h">Teach it a task</h2></div>
<p class="pa-hint tc-lede">Show ${agent.name} once on its own desk, or tell it in words. It turns that into a skill, practises it until it can do it alone, and rewrites the skill itself whenever it needs your help with it.</p>
<form method="post" action="/me/agents/${agent.id}/teach" class="tc-form">
<label class="tc-what">What will you teach it? <input name="what" maxlength="300" required placeholder="Post a clip to my X account" autocomplete="off"${ready ? raw(' autofocus') : ''}></label>
<label class="tc-url"><span class="tc-label">Start at <span class="tc-opt">optional</span></span><input name="url" type="url" inputmode="url" maxlength="2048" placeholder="https://x.com" autocomplete="off"></label>
<fieldset class="tc-kind"><legend>Its desk</legend>
<label><input type="radio" name="kind" value="browser" checked><span>A browser</span></label>
<label><input type="radio" name="kind" value="desktop"><span>A whole desktop</span></label>
</fieldset>
<details class="tc-words"><summary>Tell it in words instead</summary>
<label class="tc-words-l"><span class="tc-label">How you do it <span class="tc-opt">a few lines, the way you would tell a person</span></span><textarea name="words" rows="5" maxlength="6000" placeholder="Open x.com and press Post. Attach the clip from Downloads, write the title, then press Post again."></textarea></label>
<p class="pa-hint">With words, there is no desk to show it on: it writes the skill from what you wrote, then practises it.</p>
</details>
<div class="tc-practice-row"><span class="tc-label" aria-hidden="true">Afterwards it practises</span>
<fieldset class="tc-kind tc-practice"><legend>Afterwards it practises</legend>
<label><input type="radio" name="practice" value="until" checked><span>Until it works</span></label>
<label><input type="radio" name="practice" value="once"><span>Once</span></label>
<label><input type="radio" name="practice" value="off"><span>Not at all</span></label>
</fieldset></div>
<button type="submit" class="pa-btn pa-primary tc-go">Start the lesson</button>
</form>
${recent.length ? html`<ul class="tc-lessons" aria-label="Recent lessons">${recent.map((l) => html`<li><a href="/tasks/${l.task_id}">${l.what}</a><span class="pa-note-meta">${lessonMeta(l)} · ${when(l.created_at)}</span>${l.practice_task ? html` <a class="pa-note-meta" href="/tasks/${l.practice_task}">Its last try</a>` : ''}</li>`)}</ul>` : ''}
</section>`;
}

/** How the agent treats its own skills after a run that needed the person: improve them itself, or ask first. */
function improveSwitch(agent) {
    const auto = agent.skills_improve !== 'ask';
    return html`<form method="post" action="/me/agents/${agent.id}/skills-improve" class="tc-improve">
<span class="tc-improve-label">When a run with one of your skills needs you</span>
<span class="tc-seg" role="group" aria-label="When a run with one of your skills needs you">
<button type="submit" name="mode" value="auto" aria-pressed="${auto ? 'true' : 'false'}">It improves the skill</button>
<button type="submit" name="mode" value="ask" aria-pressed="${auto ? 'false' : 'true'}">It asks me first</button>
</span></form>`;
}

/** One of the agent's skills: the line, and for the person's own skill its version, Try it and its changes. */
function skillItem(agent, k, changes = []) {
    const mine = changes.filter((c) => c.updates_listing === k.listing_id && ['applied', 'undone'].includes(c.state)).slice(0, 3);
    return html`<li class="tc-skill"><p class="pa-note-text">${k.name}${k.own && k.version ? html` <span class="tc-ver">v${k.version}</span>` : ''}</p><p class="pa-note-meta">${k.description}</p>
${k.withdrawn ? html`<p class="pa-note-meta">${k.withdrawn}</p>` : ''}
${mine.length ? html`<ul class="tc-changes" aria-label="What it changed">${mine.map((c) => html`<li><span>${c.state === 'undone' ? html`<s>${c.text}</s>` : c.text}</span><span class="pa-note-meta">${c.state === 'undone' ? 'Undone' : 'Improved'} ${when(c.decided_at || c.created_at)}${c.from_task ? html` after <a href="/tasks/${c.from_task}">this run</a>` : ''}${c.state === 'applied' ? html` · <form method="post" action="/me/agents/${agent.id}/suggestions/${c.id}" class="tc-undo"><button type="submit" name="decision" value="undo">Undo</button></form>` : ''}</span></li>`)}</ul>` : ''}
<div class="pa-actions tc-skill-actions">${k.own && !k.withdrawn ? html`<form method="post" action="/me/agents/${agent.id}/skills/${k.listing_id}/try"><button type="submit" class="pa-btn">Try it now</button></form>` : ''}
<form method="post" action="/me/agents/${agent.id}/skills/${k.listing_id}/remove"><button type="submit" class="pa-danger-link">Remove</button></form></div></li>`;
}

/** The words a run is given when the person presses Try it on one of their skills. */
function tryInput(skill) {
    return `Use your skill "${skill.name}" now: load it (load_skill ${skill.slug}) and follow it on your own desk (computer_desk, machine "any"). Where it needs a detail you do not have, ask me. If a step does not work, take the desk to me (hand_to_person) rather than guessing: what I do then will improve the skill.`;
}

module.exports = { panel, improveSwitch, skillItem, tryInput, when, lessonMeta, LESSON_STATE, PRACTICE_STATE, raw };

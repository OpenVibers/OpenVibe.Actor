'use strict';

/**
 * Your agents as contacts (plan §12 A-1, Opus's design): the roster, the face, the one line saying what an agent
 * uses, and the level picker with the always-ask floor. Pure renderers over contacts.wire(row); the routes are in
 * agent-pages.js.
 *
 *   face(agent, size)      the agent's face: a picture, or its preset's mark on its own colour
 *   usesLine(agent)        "OpenVibe AI · a browser that remembers · Email, Slack"
 *   levelChip(level)       the level in two words
 *   roster(rows)           the contact rows, Vibe first
 *   presetCards(presets)   "Add an agent" from a preset, one form each
 *   levelPicker(agent)     four cards and the floor, posting to /me/agents/:id/level
 */

const { html, raw } = require('../render/html');

// The level ladder in words a person can act on. The floor is the same at every level (agents/levels.js ALWAYS_ASK).
const LEVEL_WORDS = {
    ask: ['Asks first', 'It asks you before it does anything outside Actor.'],
    'auto-edits': ['Edits on its own', 'It changes your files and drafts without asking. Anything else asks.'],
    'approve-for-me': ['A second model checks', 'A model from another family reviews each step. When it says no or is not sure, you decide.'],
    full: ['Full trust', 'It acts without asking.'],
};
const FLOOR_WORDS = { money: 'spending money', password: 'a password or key', delete: 'deleting something', new_recipient: 'messaging someone new' };

// Each preset's mark (24-unit paths) and hue. An unknown preset or a bare "preset:agent" gets its initial.
const MARKS = {
    vibe: ['M12 3l1.9 5.6L19.5 10l-5.6 1.9L12 17.5l-1.9-5.6L4.5 10l5.6-1.4z', 258],
    researcher: ['M10.5 4a6.5 6.5 0 1 1 0 13 6.5 6.5 0 0 1 0-13zM15.5 15.5 20 20', 205],
    inbox: ['M4 13l2.2-7h11.6L20 13v5H4zM4 13h4.5l1.2 2h4.6l1.2-2H20', 152],
    studio: ['M4 7h16v12H4zM4 7l3-3M10 7l3-3M16 7l3-3M10 11v5l4-2.5z', 24],
    party: ['M5 20l4-11 6 6zM14 4l1 2M19 6l-2 1M18 11h2M12 7c1-1 2-1 3 0', 320],
};
const HUE = (s) => { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };

function face(agent, size = 44) {
    const f = String((agent && agent.face) || 'preset:agent');
    const name = String((agent && agent.name) || 'Agent');
    if (/^https:\/\/[^\s"'<>]+$/.test(f)) return html`<img class="ac-face" src="${f}" alt="" width="${String(size)}" height="${String(size)}" loading="lazy" decoding="async">`;
    const key = f.startsWith('preset:') ? f.slice(7) : '';
    const mark = MARKS[key];
    const hue = mark ? mark[1] : HUE(name);
    const inner = mark
        ? html`<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${mark[0]}"/></svg>`
        : html`<span aria-hidden="true">${(name.trim()[0] || 'A').toUpperCase()}</span>`;
    return html`<span class="ac-face" style="--h:${String(hue)};--s:${String(size)}px">${inner}</span>`;
}

const MODEL_WORDS = (m) => {
    const model = String((m && m.model) || '');
    switch (m && m.engine) {
        case 'own-keys': {
            const [provider, id] = model.includes(':') ? model.split(/:(.+)/) : ['', model];
            const who = { openai: 'OpenAI', anthropic: 'Anthropic', deepseek: 'DeepSeek', google: 'Google', mistral: 'Mistral' }[provider] || provider || 'your';
            return `Your ${who} key${id ? `, ${id}` : ''}`;
        }
        case 'open-gpu': return 'A free open model on OpenVibe';
        case 'link': return 'Your own agent on Link';
        default: return model === 'fast' ? 'OpenVibe AI, fast' : model === 'best' ? 'OpenVibe AI, best' : 'OpenVibe AI';
    }
};
const COMPUTER_WORDS = { browser: 'a fresh browser', 'kept-browser': 'a browser that remembers', desktop: 'a desktop', 'gpu-desktop': 'a desktop with a GPU',
    'always-on': 'an always-on computer', 'your-computer': 'your computer', throwaway: 'a throwaway computer' };
const PLACE_WORDS = { link: ' on your machine', home: ' at home', ovh: ' in OpenVibe’s cloud', auto: '' };
const APP_WORDS = (id) => {
    const bare = String(id).replace(/^connect\./, '');
    return { email: 'Email', slack: 'Slack', media: 'Media', chat: 'Chat', github: 'GitHub', calendar: 'Calendar', drive: 'Drive' }[bare]
        || bare.replace(/[._-]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
};

/** What the agent uses, in one line: its model, its computer (if any), its apps (if any). */
function usesLine(agent) {
    const parts = [MODEL_WORDS(agent.model)];
    if (agent.computer && COMPUTER_WORDS[agent.computer.kind]) parts.push(`${COMPUTER_WORDS[agent.computer.kind]}${PLACE_WORDS[agent.computer.placement] || ''}`);
    if (Array.isArray(agent.apps) && agent.apps.length) parts.push(agent.apps.slice(0, 4).map(APP_WORDS).join(', ') + (agent.apps.length > 4 ? ` +${agent.apps.length - 4}` : ''));
    return parts.join(' · ');
}

const levelChip = (level) => html`<span class="ac-level" data-level="${LEVEL_WORDS[level] ? level : 'ask'}">${(LEVEL_WORDS[level] || LEVEL_WORDS.ask)[0]}</span>`;

/** One contact row per agent: the face, the name and its level, what it uses, and its schedule when it has one. */
function roster(rows, { when = () => '' } = {}) {
    return html`<ul class="ac-roster">${rows.map(({ agent, row }) => {
        const sched = row && row.schedule && row.schedule !== 'off' ? when(row) : '';
        const paused = row && row.status === 'paused';
        return html`<li><a class="ac-row" href="/me/agents/${agent.id}">${face(agent)}
<span class="ac-row-main"><span class="ac-row-top"><strong>${agent.name}</strong>${row && row.is_vibe ? html`<span class="ac-first">Your first agent</span>` : ''}${levelChip(agent.level)}${paused ? html`<span class="ac-paused">Paused</span>` : ''}</span>
<span class="ac-row-uses">${usesLine(agent)}</span>${sched ? html`<span class="ac-row-when">${sched}</span>` : ''}</span>
<svg class="ac-chev" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg></a></li>`;
    })}</ul>`;
}

/** "Add an agent": each preset as a card that makes it in one press (its instructions come with the preset). */
function presetCards(presets) {
    return html`<ul class="ac-presets">${presets.map((p) => html`<li><form method="post" action="/me/agents/preset"><input type="hidden" name="preset" value="${p.id}">
<button type="submit" class="ac-preset">${face(p, 40)}<span><strong>${p.name}</strong><small>${usesLine(p)}</small></span></button></form></li>`)}</ul>`;
}

/** The level picker: four cards (no JavaScript needed), and the floor that holds at every level. */
function levelPicker(agent) {
    const current = LEVEL_WORDS[agent.level] ? agent.level : 'ask';
    return html`<form method="post" action="/me/agents/${agent.id}/level" class="ac-levels-form">
<fieldset class="ac-levels"><legend class="sr-only">How much it may do on its own</legend>
${Object.entries(LEVEL_WORDS).map(([id, [title, line]]) => html`<label class="ac-lv"><input type="radio" name="level" value="${id}"${id === current ? raw(' checked') : ''}>
<span class="ac-lv-title">${title}</span><span class="ac-lv-line">${line}</span></label>`)}
</fieldset>
<p class="ac-floor"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 11V8a5 5 0 0 1 10 0v3M5 11h14v9H5z"/></svg><span><b>Always asks, at every level:</b> ${Object.values(FLOOR_WORDS).join(' · ')}.</span></p>
<button type="submit" class="pa-btn pa-primary">Save</button></form>`;
}

module.exports = { face, usesLine, levelChip, roster, presetCards, levelPicker, LEVEL_WORDS, FLOOR_WORDS };

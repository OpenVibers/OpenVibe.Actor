'use strict';

/**
 * /skills (plan HO2, ADR-058): the registry's catalogue, and a skill's own page.
 *
 * A skill is a document anybody may read: the catalogue shows every skill the registry offers with its scan state
 * in words, and a skill's page shows its instructions, what it may ask for in plain words, and what the scan found.
 *
 * The install rules are the same on every site: a PASSED skill installs in one tap; a FLAGGED one only after the
 * person says they read the findings; a FAILED one never installs. A skill grants nothing when it is installed: the
 * agent's level and its approvals still decide every step.
 *
 * The pages are server-rendered and complete without JavaScript: the install and the remove are plain forms, and a
 * change must come from openvibe.actor itself.
 */
const express = require('express');
const kit = require('openvibe-shared/kit');
const { asyncRouter } = require('./router');
const { sameOrigin } = require('./principal');
const { html, raw, notice, time } = require('../render/html');
const { send } = require('../render/layout');
const skills = require('../skills');
const kinds = require('../agents/kinds');
const contacts = require('../agents/contacts');

/** When a skill was scanned, as a day ("Nov 8, 2026"); the exact time stays in the element's datetime. */
const scanDay = (iso) => { const d = new Date(iso); return Number.isFinite(d.getTime()) ? html`<time datetime="${iso}">${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })}</time>` : time(iso); };

/** The scan's state, in words. Never a code: a person reads this card. */
const SCAN_WORDS = {
    passed: 'The scan found nothing to worry about.',
    flagged: 'The scan found something to read before you install this.',
    failed: 'The scan found something that stops this skill from being installed.',
    pending: 'This skill has not been scanned yet.',
};
const SEVERITY_WORDS = { block: 'Stops it', warn: 'Worth reading', info: 'For information' };
// The scan on a catalogue card, as a chip: one or two words (the sentence is on the skill's own page).
const SCAN_CHIP = { passed: 'Scanned: clear', flagged: 'Scanned: read first', failed: 'Scanned: refused', pending: 'Not scanned yet' };
// A flagged skill's chip says how much there is to read: "Scanned: 2 findings to read" (Opus, 2026-11-11).
const scanChip = (scan) => {
    const state = scan && scan.state;
    const n = scan && Array.isArray(scan.findings) ? scan.findings.length : 0;
    if (state === 'flagged' && n) return `Scanned: ${n} finding${n === 1 ? '' : 's'} to read`;
    return SCAN_CHIP[state] || SCAN_CHIP.pending;
};
// A tool's network, in plain words (ADR-060): what the person reads before they install code.
const NET_WORDS = { deny: 'no internet', 'openvibe-only': 'OpenVibe sites only', public: 'the internet' };
const netWords = (net) => NET_WORDS[net] || NET_WORDS.deny;
const sandboxTools = (skill) => (skill && skill.runs === 'sandbox' && Array.isArray(skill.tools) ? skill.tools : []);
/** The tool's declared limits, in plain words, at or under the contract's caps. */
function limitsWords(tool) {
    const l = (tool && tool.limits) || {};
    const wall = Math.min(30000, Number(l.wall_ms) || 10000);
    const mem = Math.min(268435456, Number(l.mem_bytes) || 134217728);
    return `up to ${Math.max(1, Math.round(wall / 1000))} s and ${Math.max(1, Math.round(mem / (1024 * 1024)))} MB`;
}

/** What the skill may ask an agent to do, in the plain words of HO1's kinds (agents/kinds.js). */
function asksOf(skill) {
    const list = Array.isArray(skill.requires && skill.requires.kinds) ? skill.requires.kinds : [];
    if (!list.length) return 'It asks for nothing that needs your approval: it reads and writes inside Actor.';
    return 'It may ask for ' + list.map((k) => kinds.label(k)).join(', ') + '. Every one of them still asks you, the way it does without a skill.';
}

function createSkillPages(ctx) {
    const { config, s } = ctx;
    const r = asyncRouter();
    r.use(express.urlencoded({ extended: false, limit: '64kb' }));
    const signed = (req) => req.viewer && req.viewer.kind === 'user' && req.viewer.subject;
    const owner = (req) => `user:${req.viewer.subject}`;
    const page = (req, res, body, { status = 200, title = 'Skills' } = {}) => send(res, status, {
        viewer: req.viewer, config, path: req.originalUrl, title, body, styles: ['kit.css'], css: ['css/skills.css'],
    });
    const login = (req, res) => res.redirect(303, `/auth/login?next=${encodeURIComponent(req.originalUrl)}`);
    const write = (req, res) => {
        if (!signed(req)) { login(req, res); return false; }
        if (!sameOrigin(req, config.baseUrl)) { res.status(403).type('text/plain').send('A change must come from openvibe.actor itself.'); return false; }
        return true;
    };
    const problem = (text) => `/skills?problem=${encodeURIComponent(String(text).slice(0, 300))}`;

    /** One card on the catalogue: the name, the one line, and the scan state in words. */
    const card = (listing) => {
        const skill = listing.skill || {};
        const state = listing.scan && listing.scan.state;
        return html`<li class="ovk-row ovk-row--static sk-card">
<span class="ovk-row-main"><span class="ovk-row-top"><a class="sk-name" href="/skills/${skill.slug}">${skill.name}</a></span>
<span class="ovk-row-sub"><span class="sk-desc">${skill.description}</span></span>
<span class="sk-chips"><span class="sk-chip sk-chip--${state || 'pending'}">${scanChip(listing.scan)}</span>${listing.visibility === 'private' ? html`<span class="sk-chip">Private</span>` : ''}${skill.runs === 'sandbox' ? html`<span class="sk-chip">Runs code in a sandbox</span>` : ''}</span></span>
</li>`;
    };

    r.get('/skills', async (req, res) => {
        if (signed(req)) res.set('Cache-Control', 'private, no-store');
        const yourSkills = signed(req) ? await skills.owned(s, owner(req)) : [];
        const ownIds = new Set(yourSkills.map((listing) => listing.id));
        const listings = (await skills.catalogue(s)).filter((listing) => !ownIds.has(listing.id));
        const text = typeof req.query.problem === 'string' ? req.query.problem.slice(0, 300) : null;
        page(req, res, html`<header class="sk-head">
<h1>Skills</h1>
<p class="sk-lede">Small documents your agents read to do one kind of job well. A skill grants nothing: every step still asks you, the way it does without one.</p>
<p class="sk-hint">Each one was scanned before it was listed; the findings are on its page.</p>
</header>
${text ? notice(text, 'warn') : ''}
${yourSkills.length ? html`<section class="sk-panel"><h2>Your skills</h2>${raw(kit.list(yourSkills.map(card)))}</section>` : ''}
${raw(kit.list(listings.map(card), { empty: 'No skills are offered right now.' }))}
<p class="sk-foot"><a href="/me/agents">Your agents</a> · <a href="/docs">The API</a></p>`);
    });

    r.get('/skills/:slug.json', async (req, res) => {
        const listing = await skills.get(s, req.params.slug, signed(req) ? owner(req) : null);
        if (!listing) return res.status(404).json({ error: 'No such skill.' });
        res.set('Cache-Control', listing.visibility === 'private' ? 'private, no-store' : 'public, max-age=300');
        res.json(listing);
    });

    r.get('/skills/:slug', async (req, res) => {
        const listing = await skills.get(s, req.params.slug, signed(req) ? owner(req) : null);
        if (!listing) return page(req, res, html`<h1>Skill not found</h1><p>That skill is not in the registry.</p><p><a href="/skills">Skills</a></p>`, { status: 404, title: 'Skill not found' });
        if (listing.visibility === 'private') res.set('Cache-Control', 'private, no-store');
        const skill = listing.skill || {};
        const state = listing.scan && listing.scan.state;
        const findings = (listing.scan && listing.scan.findings) || [];
        const tools = sandboxTools(skill);
        const may = skills.installability(listing);
        // The person may install it on one of their agents; the form is a plain one, and a flagged skill asks first.
        const agents = signed(req) ? await contacts.list(s, config, owner(req)) : [];
        const installForm = !signed(req)
            ? html`<p><a class="sk-btn sk-btn--primary" href="/auth/login?next=${encodeURIComponent(req.originalUrl)}">Sign in to install it</a></p>`
            : may.ok
                ? html`<form method="post" action="/skills/${skill.slug}/install" class="sk-install">
<label class="sk-label">Install on <select name="agent_id" required>${agents.map((a) => html`<option value="${a.id}">${a.name}</option>`)}</select></label>
<button type="submit" class="sk-btn sk-btn--primary">Install this skill</button></form>`
                : state === 'flagged'
                    ? html`<form method="post" action="/skills/${skill.slug}/install" class="sk-install">
<p class="sk-hint">${may.why}</p>
<label class="sk-label">Install on <select name="agent_id" required>${agents.map((a) => html`<option value="${a.id}">${a.name}</option>`)}</select></label>
<label class="sk-check"><input type="checkbox" name="read_findings" value="1" required> I read the findings above, and I want this skill on that agent.</label>
<button type="submit" class="sk-btn sk-btn--primary">Install this skill</button></form>`
                    : html`<p class="sk-hint">${may.why}</p>`;
        page(req, res, html`<p class="sk-crumbs"><a href="/skills">Skills</a></p>
<header class="sk-head"><h1>${skill.name}</h1><p class="sk-lede">${skill.description}</p>
<p class="sk-meta">Published by ${listing.publisher.kind === 'openvibe' ? 'OpenVibe' : (listing.publisher.name || 'a person')} · version ${skill.version}${listing.visibility === 'private' ? html` · <span class="sk-chip">Private</span>` : ''} · ${listing.installs ? `${listing.installs} ${listing.installs === 1 ? 'person has' : 'people have'} it` : 'nobody has it yet'}</p>
</header>
${tools.length ? html`<section class="sk-panel sk-sandbox"><h2>Its code</h2>
<p class="sk-text">It runs in a sandbox on a machine of yours that turned the skill runner on, or in OpenVibe's pool, never on an OpenVibe server: with the network each tool declares, and the exact bytes the registry scanned.</p>
<ul class="sk-tools">${tools.map((t) => html`<li class="sk-tool"><p class="sk-tool-head"><strong>${t.name}</strong> <span class="sk-net sk-net--${t.net || 'deny'}">${netWords(t.net)}</span> <span class="sk-limits">${limitsWords(t)}</span></p>
<p class="sk-tool-desc">${t.description}</p></li>`)}</ul></section>` : ''}
<section class="sk-panel"><h2>The scan</h2><p class="sk-state sk-state--${state}">${SCAN_WORDS[state] || SCAN_WORDS.pending}</p>
${findings.length ? html`<ul class="sk-findings">${findings.map((f) => html`<li>${f.tool ? html`<span class="sk-toolname">${f.tool}</span> ` : ''}<span class="sk-sev sk-sev--${f.severity}">${SEVERITY_WORDS[f.severity] || f.severity}</span> ${f.note} <span class="sk-where">(${f.where})</span></li>`)}</ul>` : state === 'passed' ? '' : html`<p class="sk-hint">The scan found nothing to report.</p>`}
${findings.some((f) => f.tool) ? html`<p class="sk-hint">A finding with a tool's name is about that tool's code.</p>` : ''}
${listing.scan && listing.scan.scanned_at ? html`<p class="sk-hint">Scanned ${scanDay(listing.scan.scanned_at)}.</p>` : ''}</section>
<section class="sk-panel"><h2>What it may ask for</h2><p class="sk-text">${asksOf(skill)}</p>
${skill.requires && skill.requires.hosts && skill.requires.hosts.length ? html`<p class="sk-hint">It reaches ${skill.requires.hosts.join(', ')}.</p>` : ''}</section>
<section class="sk-panel"><h2>Its instructions</h2><pre class="sk-instructions">${skill.instructions}</pre></section>
<section class="sk-panel"><h2>Install it</h2>${installForm}</section>
${listing.visibility === 'private' ? html`<section class="sk-panel"><h2>Sharing</h2><p>This skill is visible only to you. Publishing makes its instructions public after a fresh scan.</p>
${listing.curator.near_duplicate_of ? html`<p>Merge suggestion: this skill looks similar to <a href="/api/v1/skills/${listing.curator.near_duplicate_of}">another of your skills</a>. Review both and edit or remove one if you wish.</p>` : ''}
${listing.curator.state !== 'active' ? html`<form method="post" action="/skills/${skill.slug}/restore"><button class="sk-btn" type="submit">Restore</button></form>` : ''}
<form method="post" action="/skills/${skill.slug}/publish"><button class="sk-btn" type="submit">Publish this skill</button></form></section>` : ''}`);
    });

    // Install a skill on one of the person's agents. A flagged skill needs the person to say they read the findings.
    r.post('/skills/:slug/install', async (req, res) => {
        if (!write(req, res)) return;
        const listing = await skills.rowOf(s, req.params.slug, owner(req));
        if (!listing) return res.redirect(303, problem('That skill is not in the registry.'));
        const body = req.body || {};
        const agentId = String(body.agent_id || '');
        const agent = agentId ? await contacts.get(s, owner(req), agentId) : null;
        if (!agent) return res.redirect(303, problem('Choose one of your agents.'));
        const out = await skills.install(s, { owner: owner(req), agentId: agent.id, listing, readFindings: body.read_findings === '1' || body.read_findings === 'true' });
        if (out.error) return res.redirect(303, problem(out.error));
        res.redirect(303, `/me/agents/${agent.id}#skills`);
    });

    r.post('/skills/:slug/publish', async (req, res) => {
        if (!write(req, res)) return;
        const out = await skills.publishOwned(s, owner(req), req.params.slug);
        if (out.error) return res.redirect(303, problem(out.error));
        res.redirect(303, `/skills/${out.listing.skill.slug}`);
    });
    r.post('/skills/:slug/restore', async (req, res) => {
        if (!write(req, res)) return;
        const out = await skills.restoreOwned(s, owner(req), req.params.slug);
        if (out.error) return res.redirect(303, problem(out.error));
        res.redirect(303, `/skills/${out.listing.skill.slug}`);
    });

    return r;
}

module.exports = { createSkillPages, SCAN_WORDS, NET_WORDS, asksOf, netWords, limitsWords, sandboxTools };

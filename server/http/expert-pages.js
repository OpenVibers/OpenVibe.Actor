'use strict';

/**
 * The Experts (plan §D items 6 and 10; 2026-11-18): the gallery, an Expert's page and its install screen, on
 * openvibe.actor. openvibe.expert sends its paths here (its own domain gets the pages once it has its own sign-in).
 *
 *   GET  /experts                 the gallery: OpenVibe's own first, then what people shared in public
 *   GET  /experts/:id             one Expert: who it is, how it talks, what it believes and never does, what it may use,
 *                                 what to try first; Install
 *   GET  /experts/:id/install     signed in: the inputs it needs and everything it may do, one yes for all of it
 *   POST /experts/:id/install     makes it the person's own agent (blueprints.install) → /me/agents/:id
 *
 * The documents come from the store (server/agents/blueprints.js): a private blueprint is 404 here, a link-only one
 * answers to its address and is not listed.
 */
const express = require('express');
const { asyncRouter } = require('./router');
const { sameOrigin } = require('./principal');
const { html, raw } = require('../render/html');
const { send } = require('../render/layout');
const blueprints = require('../agents/blueprints');
const { createTask } = require('../tasks/create');
const bp = require('openvibe-sdk/agents/blueprint');
const glyphs = require('openvibe-shared/glyphs');
const kit = require('openvibe-shared/kit');
const { FLOOR_WORDS } = require('./agent-contacts-ui');

const ID = /^bp_[A-Za-z0-9_-]{3,40}$/;
const PUBLIC_CACHE = 'public, max-age=60';
// The common tools and starts, said the way a person would (the SDK's own words are the fallback).
const TOOL_WORDS = {
    'ov:live.chat.read': 'reads your stream\'s chat',
    'ov:live.transcript.read': 'reads what is said on your stream',
    'ov:live.chat.post': 'posts in your chat',
    'ov:media.clip.create': 'makes clips of your stream',
    'ov:finance.read': 'reads your money on OpenVibe Finance (accounts, months, bills, goals), once you allow it on your Apps page',
    'harness:auto': 'writes code with a coding agent',
};
const EVENT_WORDS = { 'live.stream.started': 'starts when you go live' };
const DIAL_WORDS = {
    warmth: ['dry', 'a little dry', '', 'warm', 'very warm'],
    play: ['serious', 'mostly serious', '', 'playful', 'very playful'],
    length: ['brief', 'short', '', 'thorough', 'very thorough'],
    edge: ['gentle', 'soft-spoken', '', 'direct', 'blunt'],
};

const cap = (s) => (s ? String(s).charAt(0).toUpperCase() + String(s).slice(1) : '');

function face(doc, size = 48) {
    const f = doc.face || {};
    const hue = Number.isFinite(f.hue) ? f.hue : 220;
    const svg = glyphs.svg(f.glyph || 'robot', { size: 24 }) || glyphs.svg('robot', { size: 24 });
    return html`<span class="ac-face ex-face" style="--h:${String(hue)};--s:${String(size)}px" aria-hidden="true">${raw(svg)}</span>`;
}

/** How it talks, from the soul's four dials: "warm, playful, brief" (the middle of a dial says nothing). */
function talks(soul) {
    const d = (soul && soul.dials) || {};
    const words = ['warmth', 'play', 'length', 'edge'].map((k) => DIAL_WORDS[k][(Number(d[k]) || 0) + 2]).filter(Boolean);
    return cap(words.length ? words.join(', ') : 'even and plain');
}

/** What it may do, each ask in words, the ones that ask every time marked. */
function askWords(a) {
    if (a.part === 'hands' && a.key.startsWith('hands:') && TOOL_WORDS[a.key.slice(6)]) return cap(TOOL_WORDS[a.key.slice(6)] + (a.ask ? ' (asks you first each time)' : ''));
    const ev = /^when:event:(.+)$/.exec(a.key);
    if (ev && EVENT_WORDS[ev[1]]) return cap(EVENT_WORDS[ev[1]]);
    return cap(a.words);
}

function authorLine(row, doc) {
    const who = row.owner === 'service:actor' ? 'OpenVibe' : 'someone on OpenVibe';
    return `By ${who} · version ${doc.version}${doc.licence ? ` · ${doc.licence}, remix it` : ''}`;
}

function createExpertPages(ctx) {
    const { config, s, engine } = ctx;
    const r = asyncRouter();
    r.use('/experts', express.urlencoded({ extended: false, limit: '32kb' }));
    const signed = (req) => req.viewer && req.viewer.kind === 'user' && req.viewer.subject;
    const owner = (req) => `user:${req.viewer.subject}`;
    const page = (req, res, o, status = 200) => send(res, status, {
        viewer: req.viewer, config, path: req.originalUrl, styles: ['kit.css'], css: ['css/agents.css', 'css/experts.css'], ...o,
    });
    const notFound = (req, res) => page(req, res, { title: 'No such Expert', body: html`<h1>No such Expert</h1><p><a href="/experts">See all the Experts</a></p>` }, 404);
    const load = async (id) => (ID.test(String(id || '')) ? blueprints.get(s, null, id) : null);

    r.get('/experts', async (req, res) => {
        const list = await blueprints.gallery(s).catch(() => null);
        const tag = /^[a-z][a-z0-9-]{0,40}$/.test(String(req.query.tag || '')) ? String(req.query.tag) : '';
        const all = (list || []).map((x) => ({ row: x.row, doc: x.doc }));
        const shown = tag ? all.filter((x) => (x.doc.tags || []).includes(tag)) : all;
        const counts = new Map();
        for (const x of all) for (const t of x.doc.tags || []) counts.set(t, (counts.get(t) || 0) + 1);
        const tags = [...counts.entries()].filter(([, n]) => n > 1).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 8).map(([t]) => t);
        const body = html`<header class="ex-hero">
<h1>Experts</h1>
<p class="ex-lede">Agents with a personality and a job. Read who each one is and what it may do, then install it as your own agent, or remix it into your own.</p>
</header>
${tags.length ? html`<nav class="ex-tags" aria-label="Show Experts about">
<a class="ex-tag${tag ? '' : ' is-on'}" href="/experts"${tag ? '' : raw(' aria-current="page"')}>All</a>${tags.map((t) => html`<a class="ex-tag${t === tag ? ' is-on' : ''}" href="/experts?tag=${t}"${t === tag ? raw(' aria-current="page"') : ''}>${t}</a>`)}
</nav>` : ''}
${list === null ? raw(kit.empty({ icon: 'cloud-off', title: 'The gallery could not be read', text: 'Try again in a minute.' }))
    : !shown.length ? raw(kit.empty({ icon: 'robot', title: 'No Experts here yet', text: 'Make one on Actor and share it in public.' }))
        : html`<ul class="ex-grid">${shown.map(({ row, doc }) => html`<li><a class="ex-card" href="/experts/${row.id}">
<span class="ex-card-head">${face(doc, 44)}<span class="ex-card-name"><b>${doc.name}</b>${row.owner === 'service:actor' ? html`<span class="ex-by">OpenVibe</span>` : ''}</span></span>
${doc.soul && doc.soul.who ? html`<span class="ex-who">${doc.soul.who}</span>` : ''}
<span class="ex-sum">${doc.summary}</span>
${(doc.starters || []).length ? html`<span class="ex-try">${raw(glyphs.svg('spark', { size: 14 }))}<span>${doc.starters[0].label}</span></span>` : ''}
</a></li>`)}</ul>`}
<p class="ex-foot"><a href="/experts/new">Make your own Expert</a>: say what it is for, give it a soul (or bring a SOUL.md), and share it here. <a href="/experts/mine">Yours</a>.</p>`;
        page(req, res, {
            title: 'Experts: agents with a personality and a job', index: true, cache: PUBLIC_CACHE, crumbs: [{ label: 'Experts' }],
            description: 'OpenVibe\'s Experts: a purchase researcher, a stream producer, a security reviewer and more. Read who each is and what it may do, then install it as your own agent.',
            body,
        });
    });

    r.get('/experts/:id', async (req, res) => {
        const got = await load(req.params.id);
        if (!got || got.doc.state === 'draft') return notFound(req, res);
        const { row, doc } = got;
        const soul = doc.soul || {};
        const asks = bp.asks(doc);
        const body = html`<header class="ex-head">
${face(doc, 72)}
<div class="ex-head-t"><h1>${doc.name}</h1>
${soul.who ? html`<p class="ex-who">${soul.who}</p>` : ''}
<p class="ex-sum">${doc.summary}</p>
<p class="ex-meta">${authorLine(row, doc)}</p></div>
<div class="ex-cta"><form method="post" action="/experts/${row.id}/try"><input type="hidden" name="starter" value="0"><button type="submit" class="ex-btn ex-btn--primary">${raw(glyphs.svg('chat', { size: 18 }))}<span>Try it</span></button></form>
<a class="ex-btn" href="/experts/${row.id}/install">${raw(glyphs.svg('plus', { size: 18 }))}<span>Install</span></a>
${doc.licence ? html`<form method="post" action="/experts/${row.id}/remix"><button type="submit" class="ex-btn">${raw(glyphs.svg('copy', { size: 18 }))}<span>Remix</span></button></form>` : ''}</div>
</header>
${(doc.starters || []).length ? html`<section class="ex-sec"><h2>${raw(glyphs.svg('spark', { size: 18 }))}<span>Try it now</span></h2>
<p class="ex-note">A chat with ${doc.name} that uses sample details instead of yours. It may not use your apps, computer or memory, and nothing is installed.</p>
<div class="ex-starts">${doc.starters.slice(0, 4).map((st, i) => html`<form method="post" action="/experts/${row.id}/try"><input type="hidden" name="starter" value="${String(i)}"><button type="submit" class="ex-start">${st.label}</button></form>`)}</div></section>` : ''}
<section class="ex-sec"><h2>${raw(glyphs.svg('chat', { size: 18 }))}<span>How it talks</span></h2>
<p>${talks(soul)}${(soul.quirks || []).length ? html`. ${soul.quirks.join(' ')}` : '.'}</p>
${soul.pushback ? html`<p><b>When it disagrees:</b> ${soul.pushback}</p>` : ''}</section>
${(soul.believes || []).length ? html`<section class="ex-sec"><h2>${raw(glyphs.svg('heart', { size: 18 }))}<span>What it believes</span></h2>
<ul class="ex-list">${soul.believes.map((b) => html`<li>${b}</li>`)}</ul></section>` : ''}
<section class="ex-sec"><h2>${raw(glyphs.svg('shield', { size: 18 }))}<span>What it never does</span></h2>
<ul class="ex-list">${(soul.never || []).map((n) => html`<li>${n}</li>`)}</ul>
<p class="ex-note">Like every agent on OpenVibe, it always asks you before ${Object.values(FLOOR_WORDS).join(', ')}, or posting as you.</p></section>
<section class="ex-sec"><h2>${raw(glyphs.svg('key', { size: 18 }))}<span>What it may use</span></h2>
<ul class="ex-list">${asks.map((a) => html`<li>${askWords(a)}</li>`)}</ul></section>
${(doc.knows.examples || []).length ? html`<section class="ex-sec"><h2>${raw(glyphs.svg('spark', { size: 18 }))}<span>Try it with</span></h2>
<ul class="ex-tries">${doc.knows.examples.map((e) => html`<li><p class="ex-ask">“${e.ask}”</p><p class="ex-good">${e.good}</p></li>`)}</ul></section>` : ''}
${doc.memory && doc.memory.remember ? html`<section class="ex-sec"><h2>${raw(glyphs.svg('brain', { size: 18 }))}<span>What it remembers</span></h2>
<p>${doc.memory.remember} You can read and forget each thing it keeps.</p></section>` : ''}
<p class="ex-back"><a href="/experts">All the Experts</a></p>`;
        page(req, res, {
            title: `${doc.name}, an Expert`, index: row.visibility === 'public', cache: PUBLIC_CACHE,
            description: String(`${doc.name}: ${doc.summary}`).slice(0, 160),
            crumbs: [{ label: 'Experts', href: '/experts' }, { label: doc.name }], body,
        });
    });

    function installForm(req, res, row, doc, { error = '', inputs = {} } = {}, status = 200) {
        const asks = bp.asks(doc);
        const body = html`<header class="ex-head ex-head--small">${face(doc, 56)}<div class="ex-head-t"><h1>Install ${doc.name}</h1>
<p class="ex-sum">It becomes your own agent. You can change its rules, pause it or remove it any time.</p></div></header>
${error ? html`<p class="ex-error" role="alert">${error}</p>` : ''}
<form class="ex-form" method="post" action="/experts/${row.id}/install">
${(doc.inputs || []).map((i) => html`<label class="ex-field"><span>${i.label || i.id}${i.required ? '' : ' (optional)'}</span>
<input name="input_${i.id}" value="${String(inputs[i.id] || '')}" autocomplete="off" spellcheck="false"${i.required ? raw(' required') : ''} maxlength="200"></label>`)}
<section class="ex-sec"><h2>${raw(glyphs.svg('key', { size: 18 }))}<span>What it may do</span></h2>
<ul class="ex-list">${asks.map((a) => html`<li>${askWords(a)}</li>`)}</ul>
<p class="ex-note">It always asks you before ${Object.values(FLOOR_WORDS).join(', ')}, or posting as you.</p></section>
<label class="ex-agree"><input type="checkbox" name="agreed" value="all" required><span class="ex-switch" aria-hidden="true"></span><span>Let it do these things</span></label>
<p class="ex-cta"><button class="ex-btn ex-btn--primary" type="submit">${raw(glyphs.svg('plus', { size: 18 }))}<span>Install</span></button>
<a class="ex-btn" href="/experts/${row.id}">Back</a></p>
</form>`;
        page(req, res, { title: `Install ${doc.name}`, crumbs: [{ label: 'Experts', href: '/experts' }, { label: doc.name, href: `/experts/${row.id}` }, { label: 'Install' }], body }, status);
    }

    r.get('/experts/:id/install', async (req, res) => {
        if (!signed(req)) return res.redirect(303, `/auth/login?next=${encodeURIComponent(req.originalUrl)}`);
        const got = await load(req.params.id);
        if (!got || got.doc.state === 'draft') return notFound(req, res);
        installForm(req, res, got.row, got.doc);
    });

    // Try it (plan §AD.28 item 9): a chat with a trial of this Expert (its persona, nothing it may do granted, sample
    // details for its inputs; blueprints.trial), its first message one of its starters. Nothing is installed.
    r.post('/experts/:id/try', async (req, res) => {
        if (!signed(req)) return res.redirect(303, `/auth/login?next=${encodeURIComponent(`/experts/${req.params.id}`)}`);
        if (!sameOrigin(req, config.baseUrl)) return res.status(403).type('text/plain').send('A try must come from openvibe.actor itself.');
        const got = await load(req.params.id);
        if (!got || got.doc.state === 'draft') return notFound(req, res);
        const starters = Array.isArray(got.doc.starters) ? got.doc.starters : [];
        const i = Number.parseInt(String((req.body && req.body.starter) || '0'), 10);
        const start = starters[Number.isInteger(i) && i >= 0 && i < starters.length ? i : 0];
        const text = (start && start.text) || 'Hello. What can you do for me?';
        const sorry = (message, status) => page(req, res, { title: `Try ${got.doc.name}`, crumbs: [{ label: 'Experts', href: '/experts' }, { label: got.doc.name, href: `/experts/${got.row.id}` }],
            body: html`<h1>Try ${got.doc.name}</h1><p>${message}</p><p><a class="ex-btn" href="/experts/${got.row.id}/install">Install it</a> <a class="ex-btn" href="/experts/${got.row.id}">Back</a></p>` }, status);
        let tried;
        try {
            tried = await blueprints.trial(s, config, owner(req), got.row.id, { username: req.viewer.username || null });
        } catch (e) {
            if (e instanceof blueprints.BlueprintError) return sorry(e.message, e.status >= 400 && e.status < 500 ? e.status : 422);
            throw e;
        }
        if (!tried) return notFound(req, res);
        const out = await createTask({ s, config, engine, principal: { requester: owner(req), project: null }, body: { task: text, mode: 'balanced', agent_id: tried.agent.id },
            personToken: req.token || (req.viewer && req.viewer.token) || null,
            timezone: req.cookies && req.cookies.ov_tz ? String(req.cookies.ov_tz).slice(0, 64) : null });
        if (out.code) return sorry(out.code === 'actor.budget.day_spent' || out.code === 'actor.allowance.exhausted' ? 'You have used today\'s free allowance. It comes back at midnight UTC.' : (out.detail || 'That could not start. Try again in a moment.'), out.status === 429 || out.status === 503 ? out.status : 422);
        return res.redirect(303, `/chat/${out.task.id}`);
    });

    r.post('/experts/:id/install', async (req, res) => {
        if (!signed(req)) return res.redirect(303, `/auth/login?next=${encodeURIComponent(`/experts/${req.params.id}/install`)}`);
        if (!sameOrigin(req, config.baseUrl)) return res.status(403).type('text/plain').send('An install must come from openvibe.actor itself.');
        const got = await load(req.params.id);
        if (!got || got.doc.state === 'draft') return notFound(req, res);
        const body = req.body || {};
        const inputs = {};
        for (const i of got.doc.inputs || []) {
            const v = String(body[`input_${i.id}`] || '').trim().slice(0, 200);
            if (v) inputs[i.id] = v;
        }
        if (body.agreed !== 'all') return installForm(req, res, got.row, got.doc, { error: 'Say yes to what it may do first.', inputs }, 422);
        try {
            const out = await blueprints.install(s, config, owner(req), got.row.id, { inputs, agreed: bp.asks(got.doc).map((a) => a.key) });
            if (!out) return notFound(req, res);
            return res.redirect(303, `/me/agents/${out.agent.id}?installed=1`);
        } catch (e) {
            if (e instanceof blueprints.BlueprintError) return installForm(req, res, got.row, got.doc, { error: e.message, inputs }, e.status >= 400 && e.status < 500 ? e.status : 422);
            throw e;
        }
    });
    return r;
}

module.exports = { createExpertPages, talks, askWords };

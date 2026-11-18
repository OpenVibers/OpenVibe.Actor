'use strict';
/**
 * Make your own Expert (plan §AD.28 item 9: "remix from the page … imports, SOUL.md first"; the gallery's "Make your
 * own … and share it here"). Pages over the blueprint API (server/agents/blueprints.js), a signed-in person's own:
 *
 *   GET  /experts/mine              your Experts: drafts and published, with their state
 *   GET  /experts/new               make one: a name, what it is for, what it does; or start from a SOUL.md
 *   POST /experts/new               → a private draft → its edit page
 *   GET  /experts/:id/edit          the draft: name, summary, instructions, its soul as SOUL.md, starters, who sees it
 *   POST /experts/:id/edit          save the draft (action=publish also publishes it → its page)
 *   POST /experts/:id/remix         a private copy of a published Expert whose author allows remixes → its edit page
 *
 * Every write is same-origin. A SOUL.md (OpenClaw, Hermes, Soul Spec) maps onto the soul with openvibe-sdk/agents/soul;
 * the text that maps to nothing stays in its notes.
 */
const express = require('express');
const { asyncRouter } = require('./router');
const { sameOrigin } = require('./principal');
const { html, raw } = require('../render/html');
const { send } = require('../render/layout');
const blueprints = require('../agents/blueprints');
const soulSdk = require('openvibe-sdk/agents/soul');
const glyphs = require('openvibe-shared/glyphs');

const ID = /^bp_[A-Za-z0-9_-]{3,40}$/;
const VISIBILITY = { private: 'Only you', link: 'Anyone with the link', public: 'Everyone, in the gallery' };

/** Starters as lines: "Label: what to say" (or just what to say). At most six. */
function startersFrom(text) {
    return String(text || '').split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 6).map((l) => {
        const m = /^([^:]{1,40}):\s*(.+)$/.exec(l);
        const said = (m ? m[2] : l).slice(0, 500);
        return { label: (m ? m[1] : said.split(/\s+/).slice(0, 4).join(' ')).slice(0, 40), text: said };
    });
}
const startersText = (list) => (Array.isArray(list) ? list : []).map((st) => `${st.label}: ${st.text}`).join('\n');

/** A soul from a SOUL.md, or null for an empty one. Throws a message when it does not read. */
function soulFrom(md) {
    const text = String(md || '').trim();
    if (!text) return null;
    if (Buffer.byteLength(text, 'utf8') > 20 * 1024) throw new Error('A SOUL.md is at most 20 KB.');
    const soul = soulSdk.fromSoulMd(text);
    const v = soulSdk.validate(soul);
    if (!v.ok) throw new Error(`That SOUL.md does not read as a soul: ${v.errors && v.errors[0] ? `${v.errors[0].at}: ${v.errors[0].why}` : 'it is invalid'}.`);
    return soul;
}

function createExpertMakePages(ctx) {
    const { config, s } = ctx;
    const r = asyncRouter();
    r.use(['/experts/new', '/experts/:id/edit', '/experts/:id/remix'], express.urlencoded({ extended: false, limit: '96kb' }));
    const signed = (req) => req.viewer && req.viewer.kind === 'user' && req.viewer.subject;
    const owner = (req) => `user:${req.viewer.subject}`;
    const login = (req, res) => res.redirect(303, `/auth/login?next=${encodeURIComponent(req.originalUrl)}`);
    const page = (req, res, o, status = 200) => send(res, status, {
        viewer: req.viewer, config, path: req.originalUrl, styles: ['kit.css'], css: ['css/agents.css', 'css/experts.css'], cache: 'private, no-store', ...o,
    });
    const refuseCross = (req, res) => (sameOrigin(req, config.baseUrl) ? false : (res.status(403).type('text/plain').send('This must come from openvibe.actor itself.'), true));
    const errorOf = (e) => (e instanceof blueprints.BlueprintError ? e.message : null);

    r.get('/experts/mine', async (req, res) => {
        if (!signed(req)) return login(req, res);
        const rows = await blueprints.list(s, owner(req), { scope: 'mine' });
        const state = (row) => (row.latest ? `published, version ${row.latest}${row.draft && row.draft.version > row.latest ? ', with changes not published' : ''}` : 'a draft, not published');
        const body = html`<header class="ex-top"><h1>Your Experts</h1>
<p class="ex-lede">Agents with a personality and a job, made by you. Publish one to the gallery, or keep it to yourself.</p>
<p class="ex-cta"><a class="ex-btn ex-btn--primary" href="/experts/new">${raw(glyphs.svg('plus', { size: 18 }))}<span>Make an Expert</span></a></p></header>
${rows.length ? html`<ul class="ex-mine">${rows.map((row) => html`<li><a class="ex-mine-row" href="/experts/${row.id}/edit"><b>${(row.draft && row.draft.name) || row.id}</b>
<span>${state(row)} · ${VISIBILITY[row.visibility] || row.visibility}</span></a></li>`)}</ul>`
        : html`<p class="ex-empty">None yet. Make one from a few lines, start from a SOUL.md you already have, or remix one from the <a href="/experts">gallery</a>.</p>`}`;
        page(req, res, { title: 'Your Experts', crumbs: [{ label: 'Experts', href: '/experts' }, { label: 'Yours' }], body });
    });

    const newForm = (req, res, { error = '', values = {} } = {}, status = 200) => page(req, res, {
        title: 'Make an Expert', crumbs: [{ label: 'Experts', href: '/experts' }, { label: 'Yours', href: '/experts/mine' }, { label: 'New' }], body: html`<h1>Make an Expert</h1>
${error ? html`<p class="ex-error" role="alert">${error}</p>` : ''}
<form class="ex-form" method="post" action="/experts/new">
<label class="ex-field"><span>Name</span><input name="name" value="${values.name || ''}" maxlength="60" required autocomplete="off"></label>
<label class="ex-field"><span>What it is for, in one line</span><input name="summary" value="${values.summary || ''}" maxlength="200" required autocomplete="off"></label>
<label class="ex-field"><span>What it does and how</span><textarea name="instructions" rows="6" maxlength="20000" required placeholder="You help people … You always … You never …">${values.instructions || ''}</textarea></label>
<label class="ex-field"><span>Who it is (optional): paste a SOUL.md</span><textarea name="soul_md" rows="6" maxlength="20480" placeholder="# SOUL.md&#10;## Who I am&#10;…">${values.soul_md || ''}</textarea></label>
<p class="ex-note">It starts private: only you see it until you publish it.</p>
<p class="ex-cta"><button class="ex-btn ex-btn--primary" type="submit">${raw(glyphs.svg('plus', { size: 18 }))}<span>Make it</span></button><a class="ex-btn" href="/experts/mine">Back</a></p>
</form>` }, status);

    r.get('/experts/new', async (req, res) => (signed(req) ? newForm(req, res) : login(req, res)));
    r.post('/experts/new', async (req, res) => {
        if (!signed(req)) return login(req, res);
        if (refuseCross(req, res)) return;
        const b = req.body || {};
        const values = { name: String(b.name || '').trim().slice(0, 60), summary: String(b.summary || '').trim().slice(0, 200), instructions: String(b.instructions || '').trim().slice(0, 20000), soul_md: String(b.soul_md || '') };
        let soul;
        try { soul = soulFrom(values.soul_md); } catch (e) { return newForm(req, res, { error: e.message, values }, 422); }
        try {
            const row = await blueprints.create(s, owner(req), { name: values.name, summary: values.summary, knows: { instructions: values.instructions }, ...(soul ? { soul } : {}) });
            return res.redirect(303, `/experts/${row.id}/edit?made=1`);
        } catch (e) {
            const said = errorOf(e);
            if (said) return newForm(req, res, { error: said, values }, e.status >= 400 && e.status < 500 ? e.status : 422);
            throw e;
        }
    });

    /** The person's own blueprint and the doc to edit: the draft, else the latest published version. */
    async function mine(req, id) {
        if (!ID.test(String(id || ''))) return null;
        const got = (await blueprints.get(s, owner(req), id, { draft: true }).catch(() => null)) || (await blueprints.get(s, owner(req), id).catch(() => null));
        return got && got.own ? got : null;
    }

    const editForm = (req, res, got, { error = '', said = '' } = {}, status = 200) => {
        const doc = got.doc;
        const soulMd = doc.soul ? soulSdk.toSoulMd(doc.soul, { name: doc.name }) : '';
        const published = got.row && got.row.latest;
        page(req, res, {
            title: `Edit ${doc.name}`, crumbs: [{ label: 'Experts', href: '/experts' }, { label: 'Yours', href: '/experts/mine' }, { label: doc.name }], body: html`<h1>${doc.name}</h1>
<p class="ex-meta">${published ? `Published, version ${published}` : 'A draft, not published yet'}${published ? raw(` · <a href="/experts/${got.row.id}">its page</a>`) : ''}</p>
${error ? html`<p class="ex-error" role="alert">${error}</p>` : ''}${said ? html`<p class="ex-said" role="status">${said}</p>` : ''}
<form class="ex-form" method="post" action="/experts/${got.row.id}/edit">
<label class="ex-field"><span>Name</span><input name="name" value="${doc.name || ''}" maxlength="60" required autocomplete="off"></label>
<label class="ex-field"><span>What it is for, in one line</span><input name="summary" value="${doc.summary || ''}" maxlength="200" required autocomplete="off"></label>
<label class="ex-field"><span>What it does and how</span><textarea name="instructions" rows="8" maxlength="20000" required>${(doc.knows && doc.knows.instructions) || ''}</textarea></label>
<label class="ex-field"><span>Who it is, as a SOUL.md</span><textarea name="soul_md" rows="8" maxlength="20480">${soulMd}</textarea></label>
<label class="ex-field"><span>What to try first, one a line ("Label: what to say")</span><textarea name="starters" rows="4" maxlength="3000">${startersText(doc.starters)}</textarea></label>
<fieldset class="ex-vis"><legend>Who sees it</legend><div class="ex-vis-opts">${Object.entries(VISIBILITY).map(([v, words]) => html`<label class="ex-vis-opt"><input type="radio" name="visibility" value="${v}"${(doc.visibility || 'private') === v ? raw(' checked') : ''}><span>${words}</span></label>`)}</div></fieldset>
<p class="ex-cta"><button class="ex-btn ex-btn--primary" type="submit" name="action" value="publish">${raw(glyphs.svg('upload', { size: 18 }))}<span>Save and publish</span></button>
<button class="ex-btn" type="submit" name="action" value="save">Save the draft</button><a class="ex-btn" href="/experts/mine">Back</a></p>
</form>` }, status);
    };

    r.get('/experts/:id/edit', async (req, res) => {
        if (!signed(req)) return login(req, res);
        const got = await mine(req, req.params.id);
        if (!got) return page(req, res, { title: 'No such Expert of yours', body: html`<h1>No such Expert of yours</h1><p><a href="/experts/mine">Your Experts</a></p>` }, 404);
        editForm(req, res, got, { said: req.query.made ? 'Made. It is private until you publish it.' : req.query.remixed ? 'Your copy. Change what you like, then publish it.' : '' });
    });

    r.post('/experts/:id/edit', async (req, res) => {
        if (!signed(req)) return login(req, res);
        if (refuseCross(req, res)) return;
        const got = await mine(req, req.params.id);
        if (!got) return page(req, res, { title: 'No such Expert of yours', body: html`<h1>No such Expert of yours</h1><p><a href="/experts/mine">Your Experts</a></p>` }, 404);
        const b = req.body || {};
        const next = { ...got.doc };
        for (const k of ['id', 'version', 'state', 'author', 'published_at', 'created_at', 'updated_at', 'forked_from']) delete next[k];
        next.name = String(b.name || '').trim().slice(0, 60);
        next.summary = String(b.summary || '').trim().slice(0, 200);
        next.knows = { ...(got.doc.knows || {}), instructions: String(b.instructions || '').trim().slice(0, 20000) };
        next.starters = startersFrom(b.starters);
        next.visibility = VISIBILITY[b.visibility] ? b.visibility : 'private';
        const shown = { ...got, doc: { ...got.doc, ...next } };
        try {
            const soul = soulFrom(b.soul_md);
            if (soul) next.soul = soul; else delete next.soul;
        } catch (e) { return editForm(req, res, shown, { error: e.message }, 422); }
        try {
            await blueprints.saveDraft(s, owner(req), got.row.id, next);
            if (b.action === 'publish') {
                await blueprints.publish(s, owner(req), got.row.id);
                return res.redirect(303, next.visibility === 'private' ? `/experts/${got.row.id}/edit?published=1` : `/experts/${got.row.id}`);
            }
            return editForm(req, res, await mine(req, got.row.id), { said: 'Saved. Publish it when it is ready.' });
        } catch (e) {
            const said = errorOf(e);
            if (said) return editForm(req, res, shown, { error: said }, e.status >= 400 && e.status < 500 ? e.status : 422);
            throw e;
        }
    });

    r.post('/experts/:id/remix', async (req, res) => {
        if (!signed(req)) return res.redirect(303, `/auth/login?next=${encodeURIComponent(`/experts/${req.params.id}`)}`);
        if (refuseCross(req, res)) return;
        if (!ID.test(String(req.params.id || ''))) return page(req, res, { title: 'No such Expert', body: html`<h1>No such Expert</h1>` }, 404);
        try {
            const made = await blueprints.remix(s, owner(req), req.params.id);
            if (!made) return page(req, res, { title: 'No such Expert', body: html`<h1>No such Expert</h1><p><a href="/experts">See all the Experts</a></p>` }, 404);
            return res.redirect(303, `/experts/${made.id || (made.row && made.row.id)}/edit?remixed=1`);
        } catch (e) {
            const said = errorOf(e);
            if (said) return page(req, res, { title: 'Remix', body: html`<h1>Remix</h1><p class="ex-error" role="alert">${said}</p><p><a class="ex-btn" href="/experts/${req.params.id}">Back</a></p>` }, e.status >= 400 && e.status < 500 ? e.status : 422);
            throw e;
        }
    });
    return r;
}

module.exports = { createExpertMakePages, startersFrom, soulFrom };

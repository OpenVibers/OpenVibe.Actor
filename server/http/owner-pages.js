'use strict';

/**
 * The owner's console (plan §Z.6): the one page the owner of this Actor has here — the connectors.
 *
 * The owner of the site is the person whose OpenVibe account is the owner (auth/site-owner.js). They may turn a
 * connector off for everyone, and they may say how many calls one person may make to it in one UTC day. Nobody
 * else sees this page: a signed-in person who is not the owner gets the same 404 as a page that does not exist.
 *
 * The page is server-rendered and complete without JavaScript: one form, one switch and one number per connector,
 * and a Save button. The same switches are in the API (/api/v1/admin/connectors).
 */
const express = require('express');
const cache = require('openvibe-shared/cache-policy');
const { asyncRouter } = require('./router');
const { html, raw } = require('../render/html');
const { send } = require('../render/layout');
const connectors = require('../runtime/connectors');
const siteOwner = require('../auth/site-owner');
const { sameOrigin } = require('./principal');

function createOwnerPages(ctx) {
    const { config, s } = ctx;
    const r = asyncRouter();
    const page = (req, res, o, status = 200) => send(res, status, {
        viewer: req.viewer, config, path: req.originalUrl, styles: ['kit.css'], css: ['css/console.css', 'css/connectors.css'], ...o,
    });
    const isOwner = (req) => siteOwner.isOwner({ viewer: req.viewer, config });
    const loginTo = (req) => `/auth/login?next=${encodeURIComponent(req.originalUrl)}`;

    /** The tools of every connector, from the live registry. */
    const toolsOf = () => {
        const out = {};
        for (const c of connectors.manifest()) out[c.id] = [];
        for (const t of (ctx.registry && ctx.registry.tools) || []) {
            if (t.connector && out[t.connector]) out[t.connector].push(t.name);
        }
        for (const id of Object.keys(out)) out[id].sort();
        return out;
    };

    /** The owner's rows: the site's switch, the cap and the tools of each connector. */
    const rows = async () => {
        const tools = toolsOf();
        const out = [];
        for (const c of connectors.manifest()) {
            const row = await connectors.ownerSwitch(s, c.id);
            out.push({ ...row, tools: tools[row.id] || [] });
        }
        return out;
    };

    /** One row: the name, what it does, its tools, the switch for everyone and the daily cap. */
    const rowHtml = (row) => html`<div class="cn-conn-row">
<div class="cn-conn-text"><b>${row.name}</b><span>${row.what}</span>
<span class="cn-conn-meta">${row.service} · ${connectors.RISK_WORDS[row.risk] || row.risk} · ${row.tools.length ? row.tools.join(', ') : 'no tools yet'}${row.enabled ? (row.default ? '' : ' · off for each person until they turn it on') : ' · off for everyone'}</span></div>
<div class="cn-conn-switch">
<label class="cn-conn-cap">Calls a day <input type="number" name="cap_${row.id}" min="0" max="100000" step="1" value="${row.daily_cap == null ? '' : String(row.daily_cap)}" placeholder="no limit" aria-label="Calls a day for ${row.name}"></label>
<input type="hidden" name="o_${row.id}" value="0">
<input class="ovk-switch" type="checkbox" role="switch" name="o_${row.id}" value="1"${row.enabled ? raw(' checked') : ''} aria-label="${row.name} for everyone">
<span class="cn-conn-state">${row.enabled ? 'On' : 'Off'}</span>
</div></div>`;

    r.get('/owner', (_req, res) => res.redirect(302, '/owner/connectors'));

    r.get('/owner/connectors', async (req, res) => {
        res.set('Cache-Control', cache.htmlHeaders({ private: true }));
        if (!req.viewer || req.viewer.kind !== 'user') return res.redirect(302, loginTo(req));
        if (!isOwner(req)) return res.status(404).type('text/plain').send('No such page.');
        const list = await rows();
        const saved = req.query.saved === '1';
        const body = html`<header class="cn-head"><h1>Connectors</h1>
<p class="cn-lede">What every agent on this Actor may reach. A connector you turn off is off for everyone. A limit of
calls a day is counted for each person on their own.</p></header>
${saved ? html`<p class="cm-ok" role="status">Saved. The next run of every agent on this Actor uses these switches.</p>` : ''}
<section class="cn-card" aria-labelledby="cn-conn-h"><h2 id="cn-conn-h">The connectors</h2>
<p class="cn-note">Turn a connector off and no agent may use its tools. A person may still switch their own copy on
and off, but never past this.</p>
<form method="post" action="/owner/connectors">
${list.map((row) => raw(rowHtml(row)))}
<p><button class="sc-btn" type="submit">Save</button></p>
</form>
</section>
<section class="cn-card" aria-labelledby="cn-conn-more"><h2 id="cn-conn-more">Where this goes</h2>
<p class="cn-note">Each person changes their own connectors in Settings → Connectors.</p>
<p class="cn-more"><a href="/chat/settings">Settings</a> · <a href="/chat">Back to the chat</a></p>
</section>`;
        return page(req, res, {
            title: 'Connectors',
            crumbs: [{ label: 'Chat', href: '/chat' }, { label: 'Connectors' }],
            body: raw(body),
        });
    });

    r.post('/owner/connectors', express.urlencoded({ extended: false, limit: '4kb' }), async (req, res) => {
        res.set('Cache-Control', cache.htmlHeaders({ private: true }));
        if (!req.viewer || req.viewer.kind !== 'user') return res.redirect(302, loginTo(req));
        if (!isOwner(req)) return res.status(404).type('text/plain').send('No such page.');
        if (!sameOrigin(req, config.baseUrl)) return res.status(403).type('text/plain').send('Change this on openvibe.actor itself.');
        const body = req.body || {};
        for (const c of connectors.manifest()) {
            const rawSwitch = body[`o_${c.id}`];
            const on = Array.isArray(rawSwitch) ? rawSwitch[rawSwitch.length - 1] : rawSwitch;
            const enabled = on === '1' || on === 'true';
            const capRaw = body[`cap_${c.id}`];
            const cap = String(capRaw == null ? '' : capRaw).trim();
            const dailyCap = cap === '' ? null : Math.max(0, Math.min(100000, parseInt(cap, 10) || 0));
            await connectors.setOwnerSwitch(s, c.id, { enabled, dailyCap, who: `user:${req.viewer.subject}` });
        }
        return res.redirect(303, '/owner/connectors?saved=1');
    });

    return r;
}

module.exports = { createOwnerPages };

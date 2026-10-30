"use strict";

/**
 * /connections (Actor v2, stage V2-11): the servers and agents a person connected.
 *
 * One short page: what this person added, what the last check found, which tools of each MCP server are on (every
 * tool starts off) and the form that adds one. It is complete without JavaScript.
 *
 * A token is never shown again: it is sealed when it is written (server/connections/seal.js) and opened only to talk
 * to the server. The page says so instead of pretending it can show it.
 */
const express = require("express");
const { asyncRouter } = require("./router");
const { sameOrigin } = require("./principal");
const { html, raw, notice } = require("../render/html");
const { send } = require("../render/layout");
const connStore = require("../connections/store");

const KIND_LABEL = { mcp: "MCP server", a2a: "A2A agent" };

function createConnectionsPages(ctx) {
    const { config, s } = ctx;
    const r = asyncRouter();
    r.use(express.urlencoded({ extended: false, limit: "64kb" }));
    const signed = (req) => req.viewer && req.viewer.kind === "user" && req.viewer.subject;
    const owner = (req) => "user:" + req.viewer.subject;
    const page = (req, res, body, opts) => {
        const o = opts || {};
        send(res, o.status || 200, {
            viewer: req.viewer, config, path: req.originalUrl, title: o.title || "Connections", body,
            styles: ["kit.css"], css: ["css/connections.css"],
        });
    };
    const login = (req, res) => res.redirect(303, "/auth/login?next=" + encodeURIComponent(req.originalUrl));
    const write = (req, res) => {
        if (!signed(req)) { login(req, res); return false; }
        if (!sameOrigin(req, config.baseUrl)) { res.status(403).type("text/plain").send("A change must come from openvibe.actor itself."); return false; }
        return true;
    };
    const back = (msg) => "/connections" + (msg ? "?notice=" + encodeURIComponent(String(msg).slice(0, 200)) : "");

    /** One tool of a server: a chip that turns it on or off. */
    function chip(conn, t) {
        return html`<li class="ovk-chip${t.enabled ? " ovk-chip--on" : ""}">
<form method="post" action="/connections/${conn.id}/tools/${encodeURIComponent(t.name)}">
<input type="hidden" name="enabled" value="${t.enabled ? "0" : "1"}">
<button type="submit" class="ovk-chip-btn" title="${t.description || ""}">${t.name}</button>
</form></li>`;
    }

    /** One connection: its name, its address, what the last check found and the tools the person turned on. */
    function row(conn, tools) {
        const state = conn.lastCheckedAt == null
            ? "not checked yet"
            : (conn.lastOk ? "works" : "did not answer: " + (conn.lastError || "unknown error"));
        const chips = tools.length
            ? html`<ul class="ovk-chips">${tools.map((t) => chip(conn, t))}</ul>`
            : html`<p class="ovk-muted">No tools yet. Check this server to read what it offers.</p>`;
        return html`<li class="ovk-row ovk-row--static cnx-row" id="${conn.id}">
<span class="ovk-row-main">
<span class="ovk-row-top"><span class="cnx-name">${conn.name}</span></span>
<span class="ovk-row-sub"><span class="ovk-muted">${KIND_LABEL[conn.kind] || conn.kind} · ${state}</span></span>
<span class="ovk-row-sub"><span class="ovk-muted cnx-url">${conn.url}</span></span>
</span>
<span class="cnx-actions">
<form method="post" action="/connections/${conn.id}/check"><button type="submit" class="ovk-btn">Check</button></form>
<form method="post" action="/connections/${conn.id}/remove"><button type="submit" class="ovk-btn ovk-btn--danger">Remove</button></form>
</span>
</li>`;
    }

    /** The form that adds one server or agent. */
    function addForm() {
        return html`<section class="cnx-add" id="add" aria-labelledby="h-add">
<h2 id="h-add">Add a server</h2>
<form method="post" action="/connections" class="cnx-form">
<label>Name<input name="name" maxlength="80" required autocomplete="off" placeholder="My notes server"></label>
<label>Kind<select name="kind"><option value="mcp">MCP server</option><option value="a2a">A2A agent</option></select></label>
<label>Address<input name="url" maxlength="300" required autocomplete="off" placeholder="https://example.com/mcp"></label>
<label>Token (optional)<input name="token" type="password" maxlength="500" autocomplete="off" placeholder="bearer token or API key"></label>
<label>Header (optional)<input name="header" maxlength="64" autocomplete="off" placeholder="X-API-Key"></label>
<button type="submit" class="ovk-btn ovk-btn--primary">Add and check</button>
</form>
<p class="ovk-hint">https only, and only an address that resolves to a public one. The token is sealed and never shown again.</p>
</section>`;
    }

    r.get("/connections", async (req, res) => {
        if (!signed(req)) return login(req, res);
        const rows = await connStore.list(s, owner(req));
        const items = [];
        for (const c of rows) items.push(row(c, await connStore.tools(s, c.id)));
        const builtins = ctx.connectors && typeof ctx.connectors.builtins === "function" ? ctx.connectors.builtins() : [];
        const msg = typeof req.query.notice === "string" ? req.query.notice.slice(0, 200) : null;
        const builtinRows = builtins.map((b) => html`<li class="ovk-row ovk-row--static cnx-row">
<span class="ovk-row-main"><span class="ovk-row-top"><span class="cnx-name">${b.name || b.id}</span></span>
<span class="ovk-row-sub"><span class="ovk-muted">${b.url}</span></span>
</span>
<span class="cnx-actions"><form method="post" action="/connections/builtin/${encodeURIComponent(b.id)}">
<button type="submit" class="ovk-btn">Turn on</button></form></span>
</li>`);
        page(req, res, html`<header class="cnx-head">
<h1>Connections</h1>
<p class="ovk-lede">The servers and agents Actor may use for you. Every tool starts off; turn on the ones you want.</p>
</header>
${msg ? notice(msg, "warn") : ""}
${addForm()}
${builtinRows.length ? html`<section class="cnx-builtin"><h2>Ready-made servers</h2><ul class="ovk-list">${builtinRows}</ul></section>` : ""}
${items.length ? html`<section class="cnx-own"><h2>Your connections</h2><ul class="ovk-list">${items}</ul></section>` : html`<p class="ovk-muted">Nothing connected yet.</p>`}
<p class="ovk-foot"><a href="/">Home</a> · <a href="/tasks">Your tasks</a></p>
`);
    });

    r.post("/connections", async (req, res) => {
        if (!write(req, res)) return;
        const body = req.body || {};
        const out = await ctx.connectors.add({
            owner: owner(req),
            kind: body.kind === "a2a" ? "a2a" : "mcp",
            name: body.name,
            url: body.url,
            headerName: body.header || null,
            token: body.token || null,
        });
        if (out.error) return res.redirect(303, back(out.error));
        return res.redirect(303, back("Added " + out.connection.name + "."));
    });

    r.post("/connections/builtin/:id", async (req, res) => {
        if (!write(req, res)) return;
        const builtins = ctx.connectors && typeof ctx.connectors.builtins === "function" ? ctx.connectors.builtins() : [];
        const b = builtins.find((x) => String(x.id) === String(req.params.id));
        if (!b) return res.redirect(303, back("That server is not on offer."));
        const out = await ctx.connectors.add({
            owner: owner(req), kind: b.kind || "mcp", name: b.name || b.id, url: b.url,
            headerName: b.header || null, token: b.token || null, builtin: true,
        });
        if (out.error) return res.redirect(303, back(out.error));
        return res.redirect(303, back("Added " + out.connection.name + "."));
    });

    r.post("/connections/:id/check", async (req, res) => {
        if (!write(req, res)) return;
        const out = await ctx.connectors.check(owner(req), req.params.id);
        const msg = out.ok ? "The connection works." : ("It did not answer: " + (out.error || "unknown error"));
        return res.redirect(303, back(msg));
    });

    r.post("/connections/:id/remove", async (req, res) => {
        if (!write(req, res)) return;
        const gone = await connStore.remove(s, owner(req), req.params.id);
        return res.redirect(303, back(gone ? "Removed." : "That connection was not yours."));
    });

    r.post("/connections/:id/tools/:tool", async (req, res) => {
        if (!write(req, res)) return;
        const on = String((req.body || {}).enabled) === "1";
        await connStore.setToolEnabled(s, owner(req), req.params.id, req.params.tool, on);
        return res.redirect(303, back());
    });

    return r;
}

module.exports = { createConnectionsPages, KIND_LABEL };

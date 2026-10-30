"use strict";
/**
 * The connections, end to end (Actor v2, stage V2-11): a booted Actor, a fake MCP server over TLS on the
 * loopback, and a service token that hands Actor a task.
 *
 * The MCP part wires a fake server as the person's own connection, turns one tool on and lets a task call it:
 * the answer is evidence with the server and the tool as its source, a big answer is capped at 64 KB, and a memory
 * written after it is a suggestion (the run read outside Actor).
 *
 * The A2A part posts a task with a service token: it runs under the person's allowance and allow-list, and the
 * cost lands on that person. A token that names another person is refused, and so is a token that may not act for
 * one.
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");
const https = require("https");
const { serviceAuth } = require("openvibe-contracts");

const { boot, check, done } = require("./helpers/boot");
const { aliasOf } = require("../server/connections/service");

const SAME = { "sec-fetch-site": "same-origin" };
const BIG = "x".repeat(120 * 1024);

/** A self-signed certificate for the fake server (a test only; nothing secret is written to the repo). */
function cert(dir) {
    const key = path.join(dir, "key.pem");
    const crt = path.join(dir, "cert.pem");
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", crt,
        "-days", "1", "-subj", "/CN=mcp.test"], { stdio: "ignore" });
    return { key: fs.readFileSync(key), cert: fs.readFileSync(crt) };
}

/** The fake MCP server: initialize, tools/list and tools/call over the Streamable HTTP transport. */
function fakeMcp() {
    const calls = [];
    const server = https.createServer(cert(fs.mkdtempSync(path.join(os.tmpdir(), "actor-mcp-e2e-"))), (req, res) => {
        let body = "";
        req.on("data", (c) => { body += c; });
        req.on("end", () => {
            let msg = {};
            try { msg = JSON.parse(body || "{}"); } catch { msg = {}; }
            calls.push({ method: msg.method, params: msg.params });
            const send = (result) => {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id === undefined ? null : msg.id, result }));
            };
            if (msg.method === "initialize") return send({ protocolVersion: "2025-06-18", capabilities: { tools: {} } });
            if (msg.method === "tools/list") return send({ tools: [
                { name: "search_notes", description: "Search the notes.", inputSchema: { type: "object", properties: { q: { type: "string" } } }, annotations: { readOnlyHint: true } },
            ] });
            if (msg.method === "tools/call") return send({ content: [{ type: "text", text: BIG }] });
            return send({});
        });
    });
    return new Promise((resolve) => {
        server.listen(0, "127.0.0.1", () => {
            const port = server.address().port;
            resolve({
                url: "https://mcp.test:" + port + "/mcp",
                port, calls,
                close: () => new Promise((r) => server.close(r)),
                guard: {
                    lookup: (host, opts, cb) => cb(null, [{ address: "127.0.0.1", family: 4 }]),
                    isAllowed: () => true,
                    ports: [String(port)],
                },
            });
        });
    });
}

/** A service token the mock Network signs: the actor_type, the capabilities and the claims a test needs. */
function token(t, { sub = "svc:watch", actor_type = "service", cap = ["actor.a2a.task"], extra = {} } = {}) {
    const now = Math.floor(Date.now() / 1000);
    return serviceAuth.signServiceToken({
        iss: t.network.url, sub, actor_type, aud: ["openvibe.actor"], cap,
        iat: now, exp: now + 300, jti: "tok_" + crypto.randomBytes(8).toString("hex"), ...extra,
    }, t.network.privatePem);
}

/** An app token (a developer app) the mock Network signs: it has a project and an environment. */
function appToken(t, extra = {}) {
    const now = Math.floor(Date.now() / 1000);
    const project = require("openvibe-contracts").ids.newId("project");
    return serviceAuth.signServiceToken({
        iss: t.network.url, sub: `app:${require("openvibe-contracts").ids.newId("app")}`, actor_type: "app", aud: ["openvibe.actor"], cap: ["actor.a2a.task"],
        ns: [project], project_id: project, env: "production",
        iat: now, exp: now + 300, jti: "tok_" + crypto.randomBytes(8).toString("hex"), ...extra,
    }, t.network.privatePem);
}

(async () => {
    const prev = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

    await check("MCP: a person's own connection answers inside the run, as evidence, capped", async () => {
        const fake = await fakeMcp();
        const t = await boot({ guard: fake.guard, env: { ACTOR_CONNECTOR_KEY: "a".repeat(64) } });
        try {
            const dev = t.network.addUser("dev");
            const owner = "user:" + dev.subject;
            // The person adds the server on /connections; it is checked at once and every tool starts off.
            const add = await t.get("/connections", { as: dev, method: "POST", headers: SAME,
                form: { name: "Fake notes", kind: "mcp", url: fake.url, token: "" } });
            assert.strictEqual(add.status, 303, add.text.slice(0, 200));
            const rows = await t.ctx.s.db.many("SELECT id, name, url, last_ok, last_error FROM actor_connections WHERE owner = $1", [owner]);
            assert.strictEqual(rows.length, 1, "the connection is the person's");
            const conn = rows[0];
            assert.strictEqual(conn.last_ok, true, "the check found the server: " + String(conn.last_error));
            const tools = await t.ctx.s.db.many("SELECT name, enabled FROM actor_connection_tools WHERE connection_id = $1", [conn.id]);
            assert.strictEqual(tools.length, 1, "the server's tool was listed");
            assert.strictEqual(tools[0].enabled, false, "every tool starts off");
            // The person turns the tool on.
            const on = await t.get(`/connections/${conn.id}/tools/search_notes`, { as: dev, method: "POST", headers: SAME, form: { enabled: "1" } });
            assert.strictEqual(on.status, 303, on.text.slice(0, 200));
            // The run calls it: the model is scripted to call the tool, then to remember what it read.
            const alias = aliasOf("mcp", conn.id, "search_notes");
            t.providers.state.script = [
                { content: "Looking in the notes.", tool_calls: [{ id: "call_1", type: "function", function: { name: alias, arguments: JSON.stringify({ q: "anything" }) } }] },
                { content: "Saving that.", tool_calls: [{ id: "call_2", type: "function", function: { name: "remember", arguments: JSON.stringify({ text: "The notes are long." }) } }] },
                { content: "The notes say [E1]." },
            ];
            const task = await t.get("/api/v1/tasks", { as: dev, method: "POST", headers: SAME, json: { task: "What do the notes say?", mode: "balanced" } });
            assert.strictEqual(task.status, 201, task.text.slice(0, 300));
            const row = await t.waitFor(task.json().id);
            assert.strictEqual(row.state, "succeeded", row.error_detail || "");
            const result = row.result ? (typeof row.result === "string" ? JSON.parse(row.result) : row.result) : {};
            const evidence = (result.evidence || []).find((e) => e.tool && e.tool.startsWith("mcp:"));
            assert.ok(evidence, "the MCP call is evidence: " + JSON.stringify((result.evidence || []).map((e) => e.tool)));
            assert.strictEqual(evidence.tool, "mcp:" + conn.id + ":search_notes", "the evidence names the tool module");
            assert.deepStrictEqual(evidence.sources, [{ url: fake.url, title: "Fake notes · search_notes" }], "the source is the server and the tool");
            assert.ok(evidence.text.length <= 64 * 1024 + 32, "the answer is capped at 64 KB: " + evidence.text.length);
            // The run read outside Actor, so the memory it writes is a suggestion, not an active memory.
            const memories = await t.ctx.s.db.many("SELECT status, text FROM actor_agent_memory WHERE owner = $1", [owner]);
            assert.strictEqual(memories.length, 1, "the memory was written");
            assert.strictEqual(memories[0].status, "suggested", "a memory written after outside content is a suggestion");
            assert.ok(fake.calls.some((c) => c.method === "tools/call"), "the server was called");
        } finally {
            await t.close();
            await fake.close();
        }
    });

    await check("A2A: a service token hands Actor a task, and it runs for that person", async () => {
        const t = await boot();
        try {
            const dev = t.network.addUser("dev");
            const other = t.network.addUser("other");
            const svc = token(t, { extra: { on_behalf_of: dev.subject } });
            const res = await t.get("/a2a/v1/tasks", { method: "POST", bearer: svc,
                headers: { "x-ov-subject": dev.subject },
                json: { message: { role: "user", parts: [{ type: "text", text: "What is in the notes?" }] } } });
            assert.strictEqual(res.status, 201, res.text.slice(0, 300));
            const a2a = res.json();
            assert.ok(a2a.taskId, "the task id is returned");
            assert.strictEqual(a2a.state, "submitted");
            const row = await t.waitFor(a2a.taskId);
            assert.strictEqual(row.state, "succeeded", row.error_detail || "");
            assert.strictEqual(row.requester, "user:" + dev.subject, "the task is the person's");
            assert.strictEqual(row.via, "service:watch", "the service is recorded");
            // The cost and the count land on that person, not on the service.
            const spend = await t.ctx.s.db.many("SELECT requester, tasks, usd FROM spend_daily WHERE requester = $1", ["user:" + dev.subject]);
            assert.strictEqual(spend.length, 1, "the person has a spend row");
            assert.ok(Number(spend[0].tasks) >= 1, "the task counts on the person");
            const mine = await t.ctx.s.db.many("SELECT id FROM tasks WHERE requester = $1", ["user:" + other.subject]);
            assert.strictEqual(mine.length, 0, "nobody else is charged");
        } finally { await t.close(); }
    });

    await check("A2A: a token that names another person, or may not act for one, is refused", async () => {
        const t = await boot();
        try {
            const dev = t.network.addUser("dev");
            const other = t.network.addUser("other");
            const body = { message: { role: "user", parts: [{ type: "text", text: "Do a thing." }] } };
            // The token names one person; the header names another.
            const mismatch = await t.get("/a2a/v1/tasks", { method: "POST",
                bearer: token(t, { extra: { on_behalf_of: dev.subject } }),
                headers: { "x-ov-subject": other.subject }, json: body });
            assert.strictEqual(mismatch.status, 403, mismatch.text.slice(0, 200));
            // A token that names no one and is granted no one may not name a person.
            const nobody = await t.get("/a2a/v1/tasks", { method: "POST",
                bearer: appToken(t, {}),
                headers: { "x-ov-subject": dev.subject }, json: body });
            assert.strictEqual(nobody.status, 403, nobody.text.slice(0, 200));
            // Anonymous is refused before any of that.
            const anon = await t.get("/a2a/v1/tasks", { method: "POST", json: body });
            assert.strictEqual(anon.status, 401, anon.text.slice(0, 200));
            // A token without the capability is refused.
            const nocap = await t.get("/a2a/v1/tasks", { method: "POST",
                bearer: token(t, { cap: ["actor.task.create"], extra: { on_behalf_of: dev.subject } }),
                headers: { "x-ov-subject": dev.subject }, json: body });
            assert.strictEqual(nocap.status, 403, nocap.text.slice(0, 200));
            // A token whose grant lists the person may act for them.
            const granted = await t.get("/a2a/v1/tasks", { method: "POST",
                bearer: appToken(t, { on_behalf_of_any: [dev.subject] }),
                headers: { "x-ov-subject": dev.subject }, json: body });
            assert.strictEqual(granted.status, 201, granted.text.slice(0, 200));
        } finally { await t.close(); }
    });

    if (prev === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED; else process.env.NODE_TLS_REJECT_UNAUTHORIZED = prev;
    done();
})();

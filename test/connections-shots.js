"use strict";
/**
 * Shots for Actor v2 stage V2-11 (not run by test/run.js): /connections (add, check, pick tools) and a run whose
 * evidence chip names an MCP tool, at 390 and 1280 px in dark and light. Also checks 320 px for sideways scroll and
 * fails loudly.
 *
 *   node test/connections-shots.js [/path/to/outdir]
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");
const https = require("https");
const { boot } = require("./helpers/boot");
const { aliasOf } = require("../server/connections/service");

let playwright;
try { playwright = require("playwright"); } catch { playwright = require(process.env.PLAYWRIGHT_MODULE || "/home/workstation/openvibe/work/OpenVibe.Games/node_modules/playwright"); }
const { chromium } = playwright;

const OUT = process.argv[2] || path.join("/home/workstation/openvibe/research-2026-10-30", "actor-v2-11-shots");
const SAME = { "sec-fetch-site": "same-origin" };
const WIDTHS = [[320, 568], [390, 844], [1280, 800]];
const THEMES = ["dark", "light"];

function cert(dir) {
    const key = path.join(dir, "key.pem");
    const crt = path.join(dir, "cert.pem");
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", crt, "-days", "1", "-subj", "/CN=mcp.test"], { stdio: "ignore" });
    return { key: fs.readFileSync(key), cert: fs.readFileSync(crt) };
}

/** The fake MCP server the shots run against. */
function fakeMcp() {
    const server = https.createServer(cert(fs.mkdtempSync(path.join(os.tmpdir(), "actor-mcp-shots-"))), (req, res) => {
        let body = "";
        req.on("data", (c) => { body += c; });
        req.on("end", () => {
            let msg = {};
            try { msg = JSON.parse(body || "{}"); } catch { msg = {}; }
            const send = (result) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id === undefined ? null : msg.id, result })); };
            if (msg.method === "initialize") return send({ protocolVersion: "2025-06-18", capabilities: { tools: {} } });
            if (msg.method === "tools/list") return send({ tools: [
                { name: "search_notes", description: "Search the notes.", inputSchema: { type: "object", properties: { q: { type: "string" } } }, annotations: { readOnlyHint: true } },
                { name: "list_todos", description: "List the open todos.", inputSchema: { type: "object", properties: {} } },
            ] });
            if (msg.method === "tools/call") return send({ content: [{ type: "text", text: "Three notes mention the weather; the newest says it will rain on Friday." }] });
            return send({});
        });
    });
    return new Promise((resolve) => {
        server.listen(0, "127.0.0.1", () => {
            const port = server.address().port;
            resolve({
                url: "https://mcp.test:" + port + "/mcp",
                close: () => new Promise((r) => server.close(r)),
                guard: { lookup: (host, opts, cb) => cb(null, [{ address: "127.0.0.1", family: 4 }]), isAllowed: () => true, ports: [String(port)] },
            });
        });
    });
}

(async () => {
    fs.mkdirSync(OUT, { recursive: true });
    const prev = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
    const fake = await fakeMcp();
    const t = await boot({ guard: fake.guard, env: { ACTOR_CONNECTOR_KEY: crypto.randomBytes(32).toString("hex") } });
    const u = t.network.addUser("shots");
    try {
        // The person adds the server and turns one of its tools on.
        const add = await t.get("/connections", { as: u, method: "POST", headers: SAME, form: { name: "My notes", kind: "mcp", url: fake.url, token: "" } });
        if (add.status !== 303) throw new Error(`add: ${add.status} ${add.text.slice(0, 200)}`);
        const conn = (await t.ctx.s.db.many("SELECT id FROM actor_connections WHERE owner = $1", ["user:" + u.subject]))[0];
        if (!conn) throw new Error("the connection was not saved");
        await t.get(`/connections/${conn.id}/tools/search_notes`, { as: u, method: "POST", headers: SAME, form: { enabled: "1" } });
        // A run that calls the MCP tool, so the task page carries its evidence chip.
        const alias = aliasOf("mcp", conn.id, "search_notes");
        t.providers.state.script = [
            { content: "Looking in the notes.", tool_calls: [{ id: "call_1", type: "function", function: { name: alias, arguments: JSON.stringify({ q: "weather" }) } }] },
            { content: "The notes say it will rain on Friday [E1]." },
        ];
        const task = await t.get("/api/v1/tasks", { as: u, method: "POST", headers: SAME, json: { task: "Do my notes mention the weather?", mode: "balanced" } });
        if (task.status !== 201) throw new Error(`task: ${task.status} ${task.text.slice(0, 200)}`);
        const row = await t.waitFor(task.json().id);
        if (row.state !== "succeeded") throw new Error(`task ended ${row.state}: ${row.error_detail}`);
        const page = (await t.get(`/tasks/${row.id}`, { as: u })).text;
        if (!/mcp:/.test(page)) throw new Error("the task page does not name the MCP tool");
        const connections = (await t.get("/connections", { as: u })).text;
        if (!/My notes/.test(connections)) throw new Error("the connections page does not show the server");
        process.stdout.write(`pages rendered for ${row.id}\n`);

        const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome" });
        const heights = {};
        const problems = [];
        try {
            for (const theme of THEMES) {
                for (const [width] of WIDTHS) {
                    const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: theme, deviceScaleFactor: 2, isMobile: width < 700, hasTouch: width < 700 });
                    const cookie = t.signIn(u).split("=");
                    await context.addCookies([{ name: cookie[0], value: cookie.slice(1).join("="), domain: "127.0.0.1", path: "/" }]);
                    await context.addInitScript(() => { try { localStorage.setItem("ov_display", JSON.stringify({ scheme: "auto" })); } catch { /* private */ } });
                    const page2 = await context.newPage();
                    const errors = [];
                    page2.on("pageerror", (e) => errors.push(String(e.message || e)));
                    const open = async (url, name) => {
                        await page2.goto(`${t.base}${url}`, { waitUntil: "load" });
                        await page2.waitForTimeout(700);
                        await page2.addStyleTag({ content: "#navbar-mount, .openvibe-navbar, .ovnav-appbar{display:none!important} html.ov-has-appbar{--ovnav-appbar-h:0px;--ovnav-real-h:0px}" });
                        await page2.waitForTimeout(150);
                        const dims = await page2.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth, height: document.documentElement.scrollHeight, mode: document.documentElement.getAttribute("data-theme-mode") }));
                        if (dims.mode !== theme) problems.push(`${name} ${width}px ${theme}: theme is ${dims.mode}`);
                        if (dims.scroll > dims.client + 1) problems.push(`${name} ${width}px ${theme}: scrollWidth ${dims.scroll} > ${dims.client}`);
                        heights[`${name}-${width}-${theme}`] = dims;
                        if (width !== 320) {
                            await page2.screenshot({ path: path.join(OUT, `${name}-${width}-${theme}.png`), fullPage: true });
                            process.stdout.write(`${path.join(OUT, `${name}-${width}-${theme}.png`)}  ${dims.client}px  height=${dims.height}px\n`);
                        }
                    };
                    await open("/connections", "connections");
                    await open(`/tasks/${row.id}`, "mcp-evidence");
                    if (errors.length) problems.push(`${width}px ${theme}: page errors: ${errors.slice(0, 3).join(" | ")}`);
                    await context.close();
                }
            }
        } finally {
            await browser.close();
        }
        fs.writeFileSync(path.join(OUT, "heights.json"), `${JSON.stringify(heights, null, 2)}\n`);
        if (problems.length) throw new Error(`shots failed:\n${problems.join("\n")}`);
        process.stdout.write(`${JSON.stringify(heights, null, 2)}\n`);
        process.exit(0);
    } finally {
        await t.close();
        await fake.close();
        if (prev === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED; else process.env.NODE_TLS_REJECT_UNAUTHORIZED = prev;
    }
})().catch((e) => { process.stderr.write(String(e && e.stack || e)); process.exit(1); });

'use strict';

/**
 * The MCP client (Actor v2, stage V2-11): a Model Context Protocol server over the Streamable HTTP transport.
 *
 * One JSON-RPC call per request: initialize, then tools/list, then tools/call. The transport version built
 * against is the MCP Streamable HTTP transport with protocol version 2025-06-18 (the tool annotations readOnlyHint
 * and destructiveHint are part of it). A server that mints a session (Mcp-Session-Id on initialize's answer) gets it
 * back on every later call with the negotiated MCP-Protocol-Version (2026-11-16: without it, those servers refused
 * tools/list, and a tool call never opened a session at all). A server that answers with an event stream (text/event-stream) is read the
 * same way: the last data: line is the answer.
 *
 * Every call goes through the egress guard (server/net/guarded-request.js): https, a public address, a timeout
 * and a 256 KB answer at most. The token of the connection goes into the Authorization header, or into the
 * header the person named; it is never written to a log, a span or a page.
 */
const { request, GuardedError } = require("../net/guarded-request");
// MCP 2026-07-28 (stateless): the version and the method on every request, server/discover first.
const mcpKit = require("openvibe-sdk/mcp");

const PROTOCOL_VERSION = "2025-06-18";
const CLIENT_INFO = { name: "openvibe.actor", version: "1.0" };
const MAX_BYTES = 256 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;

/** The headers of one call: the token as a bearer, or in the header the person named; the session when there is one. */
function headersFor(conn, token, session = null) {
    const out = { accept: "application/json, text/event-stream", "content-type": "application/json" };
    if (session && session.version) out["mcp-protocol-version"] = session.version;
    if (session && session.id) out["mcp-session-id"] = session.id;
    if (!token) return out;
    if (conn && conn.headerName) out[conn.headerName] = token;
    else out.authorization = "Bearer " + token;
    return out;
}

/** The answer of a JSON-RPC call: plain JSON, or the last data: line of an event stream. */
function parseAnswer(text) {
    const t = String(text || "").trim();
    if (!t) return null;
    if (t.startsWith("{") || t.startsWith("[")) return JSON.parse(t);
    const lines = t.split(/\r?\n/).filter((l) => l.startsWith("data:"));
    if (lines.length) return JSON.parse(lines[lines.length - 1].slice(5).trim());
    throw new GuardedError("the server did not answer JSON", "actor.mcp.bad_answer");
}

/** One JSON-RPC call to the server → { result, headers }. `modern`: a 2026-07-28 request (no session). */
async function call(conn, method, params, { token = null, timeoutMs = DEFAULT_TIMEOUT_MS, id = null, session = null, modern = false, lookup, isAllowed, ports } = {}) {
    let payload = { jsonrpc: "2.0", method };
    if (id) payload.id = id;
    if (params) payload.params = params;
    let headers = headersFor(conn, token, session);
    if (modern) {
        const built = mcpKit.modernRequest({ id: id || undefined, method, params: params || {}, clientInfo: CLIENT_INFO, capabilities: {} });
        payload = built.body;
        headers = { ...headersFor(conn, token, null), ...Object.fromEntries(Object.entries(built.headers).map(([k, v]) => [k.toLowerCase(), v])) };
    }
    const res = await request(conn.url, {
        method: "POST", json: payload, headers, timeoutMs, maxBytes: MAX_BYTES, lookup, isAllowed, ports,
    });
    if (res.status < 200 || res.status >= 300) throw new GuardedError("the MCP server answered " + res.status, "actor.mcp.http_error");
    const data = parseAnswer(res.body.toString("utf8"));
    if (!data) return { result: null, headers: res.headers || {} };
    if (data.error) throw new GuardedError("the MCP server said: " + String(data.error.message || "error").slice(0, 200), "actor.mcp.error");
    return { result: data.result === undefined ? data : data.result, headers: res.headers || {} };
}

/** One JSON-RPC call to the server: its result. */
async function rpc(conn, method, params, opts = {}) {
    return (await call(conn, method, params, opts)).result;
}

// A session id as the transport allows it: visible ASCII, at most 256 characters.
const SESSION_ID = /^[\x21-\x7E]{1,256}$/;

/**
 * initialize, then the initialized notification. The server knows what Actor is before it is asked for tools.
 * → the server's answer, with `session`: { id, version } to send on every later call (id null when the server keeps
 * none; version the one it chose).
 */
async function initialize(conn, { token = null, timeoutMs = DEFAULT_TIMEOUT_MS, lookup, isAllowed, ports } = {}) {
    const { result, headers } = await call(conn, "initialize", {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        clientInfo: CLIENT_INFO,
    }, { token, timeoutMs, id: 1, lookup, isAllowed, ports });
    const raw = headers && headers["mcp-session-id"];
    const sid = Array.isArray(raw) ? raw[0] : raw;
    const version = result && typeof result.protocolVersion === "string" && /^\d{4}-\d{2}-\d{2}$/.test(result.protocolVersion) ? result.protocolVersion : PROTOCOL_VERSION;
    const session = { id: typeof sid === "string" && SESSION_ID.test(sid) ? sid : null, version };
    await rpc(conn, "notifications/initialized", {}, { token, timeoutMs, session, lookup, isAllowed, ports });
    return { ...(result || {}), session };
}

// Which era each server speaks, as discover said, kept for its ttl (at most an hour) so a call does not ask again.
const ERAS = new Map();
const ERA_MAX_MS = 3600_000;

/**
 * The era a server speaks: "modern" when server/discover answers with 2026-07-28 among its versions, else "legacy"
 * (a handshake-era server refuses or does not know the method). Remembered per URL for the answer's ttl.
 */
async function eraOf(conn, { token = null, timeoutMs = DEFAULT_TIMEOUT_MS, lookup, isAllowed, ports, now = Date.now } = {}) {
    const kept = ERAS.get(conn.url);
    if (kept && kept.until > now()) return kept.era;
    let era = "legacy", ttl = 600_000;
    try {
        const { result } = await call(conn, "server/discover", {}, { token, timeoutMs, id: "discover-1", modern: true, lookup, isAllowed, ports });
        const versions = result && Array.isArray(result.supportedVersions) ? result.supportedVersions : [];
        if (versions.some((v) => mcpKit.MODERN_VERSIONS.includes(v))) {
            era = "modern";
            if (Number.isFinite(Number(result.ttlMs)) && Number(result.ttlMs) > 0) ttl = Math.min(Number(result.ttlMs), ERA_MAX_MS);
        }
    } catch (err) {
        // A refused or unknown discover is the handshake era; the guard's own refusals (an address it will not reach) stand.
        if (err && err.code === "actor.egress.refused") throw err;
    }
    ERAS.set(conn.url, { era, until: now() + ttl });
    return era;
}

/** The tools the server offers, as Actor keeps them: name, description, input schema and the annotations. */
async function listTools(conn, { token = null, timeoutMs = DEFAULT_TIMEOUT_MS, lookup, isAllowed, ports } = {}) {
    const modern = (await eraOf(conn, { token, timeoutMs, lookup, isAllowed, ports })) === "modern";
    const session = modern ? null : (await initialize(conn, { token, timeoutMs, lookup, isAllowed, ports })).session;
    const result = await rpc(conn, "tools/list", {}, { token, timeoutMs, id: 2, session, modern, lookup, isAllowed, ports });
    const tools = Array.isArray(result && result.tools) ? result.tools : [];
    return tools.map((t) => ({
        name: String((t && t.name) || "").slice(0, 128),
        description: t && t.description ? String(t.description).slice(0, 2000) : "",
        inputSchema: t && t.inputSchema && typeof t.inputSchema === "object" ? t.inputSchema : { type: "object", properties: {} },
        annotations: t && t.annotations && typeof t.annotations === "object" ? t.annotations : null,
    })).filter((t) => t.name);
}

/** One tool call. The text of the answer is the text blocks of the content, as one string. */
async function callTool(conn, toolName, args = {}, { token = null, timeoutMs = DEFAULT_TIMEOUT_MS, lookup, isAllowed, ports } = {}) {
    // A handshake-era call opens its own session (a server that keeps sessions refuses a call without one); a
    // 2026-07-28 call needs none.
    const modern = (await eraOf(conn, { token, timeoutMs, lookup, isAllowed, ports })) === "modern";
    const session = modern ? null : (await initialize(conn, { token, timeoutMs, lookup, isAllowed, ports })).session;
    const result = await rpc(conn, "tools/call", { name: toolName, arguments: args || {} }, { token, timeoutMs, id: 3, session, modern, lookup, isAllowed, ports });
    // 2026-07-28 lets a server ask the client for input mid-call; an agent's tool call cannot answer that here.
    if (modern && !mcpKit.isComplete(result)) return { text: "The tool asked for input this agent cannot give here.", isError: true, data: null };
    const content = Array.isArray(result && result.content) ? result.content : [];
    const text = content.map((c) => (c && typeof c.text === "string" ? c.text : "")).filter(Boolean).join("\n");
    return {
        text: text || (result && result.structuredContent ? JSON.stringify(result.structuredContent) : ""),
        isError: result && result.isError === true,
        data: result && result.structuredContent ? result.structuredContent : null,
    };
}

module.exports = { rpc, initialize, eraOf, ERAS, listTools, callTool, parseAnswer, headersFor, PROTOCOL_VERSION, MAX_BYTES, DEFAULT_TIMEOUT_MS };

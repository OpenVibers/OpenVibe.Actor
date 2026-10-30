'use strict';

/**
 * The one way Actor reaches an address a person chose (Actor v2, stage V2-11): the MCP servers and the A2A
 * agents on /connections.
 *
 * https only, a public address only, a timeout and a response cap. The address check is openvibe-shared/egress:
 * a name that resolves to localhost, to a private range or to a cloud metadata address is refused before a byte
 * is sent, and the check runs again at connect time (the safe lookup), so a name that answers 127.0.0.1 later
 * is refused too. Redirects are never followed: a 302 is a result, not a hop.
 *
 *   const res = await request(url, { method: "POST", json: payload, headers, timeoutMs });
 *   const data = await json(url, { json: payload, headers });
 *
 * A test injects lookup and isAllowed so a local fake server can be reached; production uses the defaults.
 */
const https = require("https");
const egress = require("openvibe-shared/egress");

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BYTES = 256 * 1024;
const ALLOWED_PORTS = ["443", "8443"];

class GuardedError extends Error {
    constructor(message, code = "actor.egress.refused") {
        super(message);
        this.name = "GuardedError";
        this.code = code;
    }
}

/** The URL, once it is one Actor may reach: https, no credentials in it, a public host name, a known port. */
function checkUrl(url, { ports = ALLOWED_PORTS } = {}) {
    let u;
    try { u = new URL(String(url)); } catch { throw new GuardedError("that is not a URL"); }
    if (u.protocol !== "https:") throw new GuardedError(u.protocol + " is not allowed; use https");
    if (u.username || u.password) throw new GuardedError("a URL with a password in it is not allowed");
    const port = u.port || "443";
    if (!ports.includes(port)) throw new GuardedError("port " + port + " is not allowed; use 443 or 8443");
    if (egress.isInternalName(u.hostname)) throw new GuardedError(u.hostname + " is not a public host name");
    return u;
}

/**
 * One request, through the egress guard. The body is read up to maxBytes; a bigger answer is refused rather
 * than kept in memory.
 */
function request(url, {
    method = "GET", headers = {}, json = null, body = null,
    timeoutMs = DEFAULT_TIMEOUT_MS, maxBytes = DEFAULT_MAX_BYTES,
    lookup, isAllowed, ports, userAgent = "OpenVibe.Actor (+https://openvibe.actor)", signal,
} = {}) {
    const u = checkUrl(url, { ports: ports || ALLOWED_PORTS });
    const safeLookup = egress.createSafeLookup({ lookup, isAllowed });
    const payload = json != null ? Buffer.from(JSON.stringify(json), "utf8") : (body != null ? Buffer.from(String(body), "utf8") : null);
    const out = { status: 0, headers: {}, body: Buffer.alloc(0) };
    return new Promise((resolve, reject) => {
        let done = false;
        const finish = (err, value) => { if (done) return; done = true; if (err) reject(err); else resolve(value); };
        const req = https.request({
            hostname: u.hostname,
            port: u.port || 443,
            path: u.pathname + u.search,
            method,
            servername: u.hostname,
            lookup: safeLookup,
            headers: {
                accept: "application/json, text/event-stream",
                "user-agent": userAgent,
                ...(payload ? { "content-type": "application/json", "content-length": payload.length } : {}),
                ...headers,
            },
        }, (res) => {
            out.status = res.statusCode || 0;
            out.headers = res.headers || {};
            const chunks = [];
            let size = 0;
            res.on("data", (c) => {
                size += c.length;
                if (size > maxBytes) { req.destroy(new GuardedError("the answer is bigger than " + maxBytes + " bytes", "actor.egress.too_large")); return; }
                chunks.push(c);
            });
            res.on("end", () => { out.body = Buffer.concat(chunks); finish(null, out); });
            res.on("error", (err) => finish(err));
        });
        req.setTimeout(timeoutMs, () => { req.destroy(new GuardedError("the request timed out after " + timeoutMs + " ms", "actor.egress.timeout")); });
        req.on("error", (err) => finish(err && err.code === "EGRESS_DENIED" ? new GuardedError(err.message) : err));
        if (signal) {
            if (signal.aborted) req.destroy(new GuardedError("cancelled", "actor.task.cancelled"));
            else signal.addEventListener("abort", () => req.destroy(new GuardedError("cancelled", "actor.task.cancelled")), { once: true });
        }
        if (payload) req.write(payload);
        req.end();
    });
}

/** The same request, read as JSON. A non-JSON or an error status is an error the caller can show. */
async function json(url, opts = {}) {
    const res = await request(url, opts);
    const text = res.body.toString("utf8");
    if (res.status < 200 || res.status >= 300) throw new GuardedError("the server answered " + res.status, "actor.egress.http_error");
    if (!text.trim()) return null;
    try { return JSON.parse(text); } catch { throw new GuardedError("the server did not answer JSON", "actor.egress.bad_answer"); }
}

module.exports = { request, json, checkUrl, GuardedError, DEFAULT_TIMEOUT_MS, DEFAULT_MAX_BYTES, ALLOWED_PORTS };

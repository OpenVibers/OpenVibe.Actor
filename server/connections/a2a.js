'use strict';

/**
 * A2A, the agent-to-agent protocol (Actor v2, stage V2-11).
 *
 * An A2A agent describes itself with a card: /.well-known/agent-card.json (A2A 0.3) or /.well-known/agent.json (before
 * it): its name, its skills, the auth it needs and the URL it answers at. Talking to it (2026-11-19, so an outside agent
 * can sit in a group conversation, plan §AD.19):
 *   - JSON-RPC 2.0, as A2A 0.3 and the agents built on it speak: `message/send` with one user message (parts of kind
 *     text); the answer is a Message, or a Task that `tasks/get` is asked about until it ends (completed, failed,
 *     canceled, rejected, input-required) or the time runs out;
 *   - the earlier plain shape, POST { message: { role, parts: [{ type: \"text\" }] } }, for an agent that answers
 *     JSON-RPC with 404, 405 or something that is not JSON-RPC (Actor's own /a2a/v1/tasks is one).
 * Actor's own card is at both paths.
 *
 * The other agent is an address a person chose, so every call goes through the egress guard: https, a public
 * address, a timeout, an answer at most 256 KB.
 */
const { request, json, GuardedError } = require("../net/guarded-request");

const crypto = require("crypto");

const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_BYTES = 256 * 1024;
const CARD_PATH = "/.well-known/agent.json";
const CARD_PATHS = ["/.well-known/agent-card.json", CARD_PATH];
// A task's states that end it (A2A 0.3 TaskState); anything else (submitted, working, unknown) is asked again.
const ENDED = new Set(["completed", "failed", "canceled", "rejected", "input-required", "auth-required"]);
const POLL_MS = 1500;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const authHeaders = (token, headerName) => (token ? { [headerName || "authorization"]: headerName ? token : "Bearer " + token } : {});

/**
 * An agent's base address, the same however it was written: a card's own URL (…/.well-known/agent-card.json) gives its
 * base; the host is lower-cased, a trailing slash, a query and a fragment dropped. '' for something that is not a URL.
 */
function baseOf(url) {
    let u;
    try { u = new URL(String(url || "")); } catch { return ""; }
    u.hash = ""; u.search = "";
    let path = u.pathname.replace(/\/\.well-known\/agent(-card)?\.json$/, "").replace(/\/+$/, "");
    return `${u.protocol}//${u.host.toLowerCase()}${path}`;
}

/**
 * Where to send JSON-RPC: the card's url, unless the card prefers another transport (gRPC, HTTP+JSON) and lists a
 * JSON-RPC interface beside it (A2A 0.3 `additionalInterfaces`). null when the card names no address.
 */
function endpointOf(card) {
    if (!card || typeof card !== "object") return null;
    const pref = typeof card.preferredTransport === "string" ? card.preferredTransport.toUpperCase() : "JSONRPC";
    if (pref !== "JSONRPC" && Array.isArray(card.additionalInterfaces)) {
        const rpcIf = card.additionalInterfaces.find((i) => i && typeof i.url === "string" && String(i.transport || "").toUpperCase() === "JSONRPC");
        if (rpcIf) return rpcIf.url;
    }
    return typeof card.url === "string" && card.url ? card.url : null;
}

/** The card of an A2A agent: who it is and what it can do (A2A 0.3's path first, then the earlier one). */
async function agentCard(baseUrl, { token = null, headerName = null, timeoutMs = DEFAULT_TIMEOUT_MS, lookup, isAllowed, ports } = {}) {
    const base = baseOf(baseUrl) || String(baseUrl).replace(/\/+$/, "");
    const headers = { accept: "application/json", ...authHeaders(token, headerName) };
    let last = null;
    for (const p of CARD_PATHS) {
        try {
            const card = await json(base + p, { headers, timeoutMs, maxBytes: MAX_BYTES, lookup, isAllowed, ports });
            if (card && typeof card === "object" && !Array.isArray(card)) return card;
        } catch (err) {
            // The guard's own refusals (a private address, plain http, an answer too big) are not "try the other path";
            // a 404 or a page that is not JSON is.
            if (err && (err.code === "actor.egress.refused" || err.code === "actor.egress.too_large")) throw err;
            last = err;
        }
    }
    throw last || new GuardedError("the agent has no card", "actor.a2a.no_card");
}

/** The text of a message: the parts that are text (`kind` in A2A 0.3, `type` before it), in order. */
function messageText(message) {
    const parts = message && Array.isArray(message.parts) ? message.parts : [];
    return parts.filter((p) => p && (p.kind === "text" || p.type === "text") && typeof p.text === "string").map((p) => p.text).join("\n").trim();
}

/** What an A2A answer says: a Message's text, or a Task's artifacts, else its status message. */
function answerText(result) {
    if (!result || typeof result !== "object") return "";
    if (result.kind === "message" || (Array.isArray(result.parts) && !result.status)) return messageText(result);
    const fromArtifacts = (Array.isArray(result.artifacts) ? result.artifacts : []).map((a) => messageText(a)).filter(Boolean).join("\n\n");
    if (fromArtifacts) return fromArtifacts;
    const st = result.status && result.status.message;
    if (st && typeof st === "object") return messageText(st);
    if (typeof st === "string") return st;
    return "";
}

/** One JSON-RPC call: its result, or a thrown error; `unsupported` when the agent does not speak JSON-RPC there. */
async function rpc(target, method, params, { headers, timeoutMs, lookup, isAllowed, ports }) {
    const res = await request(target, {
        method: "POST", json: { jsonrpc: "2.0", id: crypto.randomUUID(), method, params },
        headers: { accept: "application/json", "content-type": "application/json", ...headers },
        timeoutMs, maxBytes: MAX_BYTES, lookup, isAllowed, ports,
    });
    if ([404, 405, 415].includes(res.status)) return { unsupported: true };
    let body = null;
    try { body = JSON.parse(res.body.toString("utf8")); } catch { body = null; }
    if (!body || body.jsonrpc !== "2.0") {
        // An agent of the earlier shape refuses a JSON-RPC body in its own words (Actor's /a2a/v1/tasks: 422).
        if ((res.status >= 200 && res.status < 300) || [400, 422].includes(res.status)) return { unsupported: true };
        throw new GuardedError("the agent answered " + res.status, "actor.a2a.http_error");
    }
    if (body.error) {
        if (body.error.code === -32601) return { unsupported: true };   // method not found
        throw new GuardedError("the agent refused: " + String(body.error.message || body.error.code).slice(0, 200), "actor.a2a.rpc_error");
    }
    return { result: body.result };
}

/** The earlier plain shape: POST { message: { role, parts: [{ type: "text" }] } }. */
async function legacySend(target, { text, skillId, taskId, headers, timeoutMs, lookup, isAllowed, ports }) {
    const payload = { message: { role: "user", parts: [{ type: "text", text }] } };
    if (skillId) payload.skillId = skillId;
    if (taskId) payload.taskId = taskId;
    const res = await request(target, { method: "POST", json: payload, headers: { accept: "application/json", "content-type": "application/json", ...headers }, timeoutMs, maxBytes: MAX_BYTES, lookup, isAllowed, ports });
    const raw = res.body.toString("utf8");
    if (res.status < 200 || res.status >= 300) throw new GuardedError("the agent answered " + res.status, "actor.a2a.http_error");
    try { return JSON.parse(raw); } catch { return { state: "completed", answer: raw }; }
}

/**
 * Send one message to an A2A agent and read its answer: JSON-RPC `message/send` (waiting on `tasks/get` while the task
 * runs, within timeoutMs), else the earlier shape. → { card, task, text, state, protocol: 'jsonrpc'|'legacy' }
 */
async function sendTask(baseUrl, { text, skillId = null, taskId = null, contextId = null, token = null, headerName = null, timeoutMs = DEFAULT_TIMEOUT_MS, lookup, isAllowed, ports, pollMs = POLL_MS } = {}) {
    const started = Date.now();
    const left = () => Math.max(1000, timeoutMs - (Date.now() - started));
    const card = await agentCard(baseUrl, { token, headerName, timeoutMs, lookup, isAllowed, ports });
    const target = endpointOf(card) || (baseOf(baseUrl) || String(baseUrl).replace(/\/+$/, "")) + "/a2a/v1/tasks";
    const words = String(text || "").slice(0, 8000);
    const headers = authHeaders(token, headerName);
    const opts = { headers, lookup, isAllowed, ports };
    const message = { role: "user", kind: "message", messageId: crypto.randomUUID(), parts: [{ kind: "text", text: words }], ...(taskId ? { taskId } : {}), ...(contextId ? { contextId } : {}) };
    const sent = await rpc(target, "message/send", { message, configuration: { blocking: true, acceptedOutputModes: ["text/plain", "text"] }, ...(skillId ? { metadata: { skillId } } : {}) }, { ...opts, timeoutMs: left() });
    if (sent.unsupported) {
        const task = await legacySend(target, { text: words, skillId, taskId, ...opts, timeoutMs: left() });
        return { card, task, text: answerText(task) || taskTextLegacy(task), state: (task && (task.state || (task.status && task.status.state))) || "completed", protocol: "legacy" };
    }
    let result = sent.result;
    // A task that is still running is asked about again until it ends or the time is up.
    while (result && result.kind === "task" && result.status && !ENDED.has(result.status.state) && Date.now() - started < timeoutMs - pollMs) {
        await sleep(pollMs);
        const again = await rpc(target, "tasks/get", { id: result.id }, { ...opts, timeoutMs: left() });
        if (again.unsupported || !again.result) break;
        result = again.result;
    }
    const state = result && result.status ? result.status.state : (result && result.kind === "message" ? "completed" : "unknown");
    return { card, task: result, text: answerText(result), state, protocol: "jsonrpc" };
}

/** An earlier-shape answer's words (connections/service.js reads the same fields). */
function taskTextLegacy(task) {
    if (!task || typeof task !== "object") return String(task || "");
    if (typeof task.answer === "string") return task.answer;
    if (task.result && typeof task.result === "string") return task.result;
    if (task.result && typeof task.result.text === "string") return task.result.text;
    if (task.status && typeof task.status.message === "string") return task.status.message;
    return "";
}

/** The skills Actor offers another agent: what a caller can ask it for. */
function actorSkills() {
    return [
        { id: "answer", name: "Answer a question", description: "Look the answer up, check it against other sources and answer in plain words, with the sources behind it.", tags: ["research", "facts"] },
        { id: "research", name: "Research a topic", description: "Read several sources, weigh where they disagree and write what they support, with the sources behind it.", tags: ["research", "writing"] },
        { id: "files", name: "Work with files", description: "Read the person's own files and write what they ask for: a table, a summary, a draft.", tags: ["files", "writing"] },
        { id: "machines", name: "Work with the person's machines", description: "See the computers and robots the person connected and drive them: read the screen, type, run a program.", tags: ["machines", "robots"] },
    ];
}

/** Actor's own card: the A2A surface, next to what openvibe.actor already tells an agent about itself. */
function actorCard({ baseUrl = "https://openvibe.actor", version = "1.0" } = {}) {
    return {
        name: "OpenVibe.Actor",
        description: "OpenVibe's own agent: it takes a task in plain words, looks the answer up, checks it and records the cost and the evidence behind it.",
        url: baseUrl.replace(/\/+$/, "") + "/a2a/v1/tasks",
        // A2A 0.3: JSON-RPC 2.0 (message/send, tasks/get) on that url; the earlier plain POST still works there.
        protocolVersion: "0.3.0",
        preferredTransport: "JSONRPC",
        version,
        provider: { organization: "OpenVibe", url: "https://openvibe.network" },
        capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: true },
        defaultInputModes: ["text"],
        defaultOutputModes: ["text"],
        skills: actorSkills(),
        securitySchemes: { bearer: { type: "http", scheme: "bearer", description: "A Network service token with the capability actor.a2a.task, acting for a person (X-OV-Subject)." } },
        security: [{ bearer: [] }],
    };
}

module.exports = { agentCard, sendTask, messageText, answerText, baseOf, endpointOf, actorCard, actorSkills, CARD_PATH, CARD_PATHS, DEFAULT_TIMEOUT_MS, MAX_BYTES };

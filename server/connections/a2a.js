'use strict';

/**
 * A2A, the agent-to-agent protocol (Actor v2, stage V2-11).
 *
 * An A2A agent describes itself at /.well-known/agent.json: its name, its skills and the auth it needs. A task is
 * one message: { message: { role: \"user\", parts: [{ type: \"text\", text: \"...\" }] } }. The spec built
 * against is the Agent2Agent card-and-task shape as Google publishes it (agent card, tasks, message parts); the
 * card Actor serves is at /.well-known/agent.json too.
 *
 * The other agent is an address a person chose, so every call goes through the egress guard: https, a public
 * address, a timeout, an answer at most 256 KB.
 */
const { request, json, GuardedError } = require("../net/guarded-request");

const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_BYTES = 256 * 1024;
const CARD_PATH = "/.well-known/agent.json";

/** The card of an A2A agent: who it is and what it can do. */
async function agentCard(baseUrl, { token = null, headerName = null, timeoutMs = DEFAULT_TIMEOUT_MS, lookup, isAllowed, ports } = {}) {
    const url = String(baseUrl).replace(/\/+$/, "") + CARD_PATH;
    const headers = { accept: "application/json" };
    if (token) headers[headerName || "authorization"] = headerName ? token : "Bearer " + token;
    const card = await json(url, { headers, timeoutMs, maxBytes: MAX_BYTES, lookup, isAllowed, ports });
    if (!card || typeof card !== "object") throw new GuardedError("the agent has no card", "actor.a2a.no_card");
    return card;
}

/** The text of a task message: the parts that are text, in order. */
function messageText(message) {
    const parts = message && Array.isArray(message.parts) ? message.parts : [];
    return parts.filter((p) => p && p.type === "text" && typeof p.text === "string").map((p) => p.text).join("\n").trim();
}

/** Send one task to an A2A agent and read its answer. */
async function sendTask(baseUrl, { text, skillId = null, taskId = null, token = null, headerName = null, timeoutMs = DEFAULT_TIMEOUT_MS, lookup, isAllowed, ports } = {}) {
    const card = await agentCard(baseUrl, { token, headerName, timeoutMs, lookup, isAllowed, ports });
    const target = (card && typeof card.url === "string" && card.url) ? card.url : String(baseUrl).replace(/\/+$/, "") + "/a2a/v1/tasks";
    const payload = { message: { role: "user", parts: [{ type: "text", text: String(text || "").slice(0, 8000) }] } };
    if (skillId) payload.skillId = skillId;
    if (taskId) payload.taskId = taskId;
    const headers = { accept: "application/json", "content-type": "application/json" };
    if (token) headers[headerName || "authorization"] = headerName ? token : "Bearer " + token;
    const res = await request(target, { method: "POST", json: payload, headers, timeoutMs, maxBytes: MAX_BYTES, lookup, isAllowed, ports });
    const text2 = res.body.toString("utf8");
    if (res.status < 200 || res.status >= 300) throw new GuardedError("the agent answered " + res.status, "actor.a2a.http_error");
    let out = null;
    try { out = JSON.parse(text2); } catch { out = { state: "completed", answer: text2 }; }
    return { card, task: out };
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

module.exports = { agentCard, sendTask, messageText, actorCard, actorSkills, CARD_PATH, DEFAULT_TIMEOUT_MS, MAX_BYTES };

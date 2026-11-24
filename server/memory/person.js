'use strict';
/**
 * The person's memory lives in one place (plan §V.1, "one memory", 11-23): OpenVibe.AI's store, the one the Memory page
 * shows (openvibe.my/memory). What a person tells their agents to remember goes there, and their agents recall from it,
 * always on behalf of that one person (openvibe-sdk/memory, Network grants ai.memory.read / ai.memory.write). Actor
 * keeps only an agent's own working notes (actor_agent_memory with an agent_id).
 *
 *   remember(owner, { text, kind, personSaid }) → { row } (row as server/memory/index.js shapes one) | { error }
 *       personSaid: the text is in the person's own message and the run read nothing from outside (remember.js checks
 *       it): the store keeps it active (OpenVibe.AI #694); anything else is a suggestion the person keeps or lets go
 *       on the Memory page.
 *   recall(owner, query) → rows (active, at most 8, in the store's own ranking), newest store order
 *
 * Off (createPersonStore returns null) in a drill and in tests, in a self-hosted Actor and without a Network client
 * secret: then the local store keeps the person's notes exactly as before. A store that fails a call never stops a
 * task: remember answers { error }, recall answers [] and the caller goes on.
 */
const { createClient } = require('openvibe-sdk/core');
const { createServiceTokenClient } = require('openvibe-sdk/auth');
const { createMemoryClient, MEMORY_PAGE } = require('openvibe-sdk/memory');

const OWNER = /^user:(usr_[0-9A-HJKMNP-TV-Z]{26})$/;
/** Actor's three kinds as the store names them: an instruction that narrows how the agent works is a procedure. */
const KIND_TO_STORE = { fact: 'fact', preference: 'preference', instruction: 'procedure' };
const KIND_FROM_STORE = { fact: 'fact', preference: 'preference', procedure: 'instruction', project_rule: 'instruction', decision: 'fact', lesson: 'fact' };

/** A store item in the shape server/memory/index.js gives a row (agent_id null: the person's own). */
function rowOf(item, owner) {
    return {
        id: String(item.id), owner, agent_id: null, text: String(item.text || ''), kind: KIND_FROM_STORE[item.kind] || 'fact',
        source: item.status === 'active' ? 'person' : 'agent', status: item.status === 'active' ? 'active' : 'suggested',
        source_task: null, pinned: false, uses: 0, last_used_at: null, created_at: item.created_at || null, store: 'openvibe.ai',
    };
}

function createPersonStore({ config, fetchImpl = globalThis.fetch, log = console, client: given = null } = {}) {
    if (!given) {
        const ai = config && config.ai;
        if (!ai || !ai.url || !ai.clientSecret) return null;
        if (config.drill || config.nodeEnv === 'test') return null;
        if (config.selfHosted && config.selfHosted.on) return null;
    }
    const client = given || createClient({
        fetch: fetchImpl,
        tokenProvider: createServiceTokenClient({
            tokenUrl: `${config.networkInternalUrl || config.networkUrl}/oauth/token`,
            clientId: config.ai.clientId, clientSecret: config.ai.clientSecret, fetch: fetchImpl,
            // Its own token, narrowed to memory: a missing grant breaks memory only, never a model call.
            scope: { 'openvibe.ai': ['ai.memory.read', 'ai.memory.write'] },
        }),
        baseUrls: { ai: config.ai.url },
    });
    const memory = createMemoryClient(client, { baseUrl: given ? undefined : config.ai.url });
    const person = (owner) => { const m = OWNER.exec(String(owner || '')); return m ? m[1] : null; };

    async function remember(owner, { text, kind = 'fact', personSaid = false } = {}) {
        const who = person(owner);
        if (!who) return { error: 'memory belongs to a signed-in person' };
        try {
            const out = await memory.remember(who, [{ text, kind: KIND_TO_STORE[kind] || 'fact', ...(personSaid ? { person_said: true } : {}) }]);
            const item = out && Array.isArray(out.items) ? out.items[0] : null;
            if (!item) return { error: 'the memory store kept nothing' };
            return { row: rowOf(item, owner), duplicate: item.duplicate === true || item.deduped === true };
        } catch (err) {
            log.warn('[Actor] memory store remember:', err && (err.code || err.status || err.message));
            return { error: 'the memory store did not answer; try again in a moment' };
        }
    }

    async function recall(owner, query) {
        const who = person(owner);
        if (!who) return [];
        try {
            const out = await memory.recall(who, String(query || '').slice(0, 500), { scopes: ['user'] });
            return (out && Array.isArray(out.items) ? out.items : []).filter((x) => x && x.text).map((x) => rowOf({ ...x, status: 'active' }, owner));
        } catch (err) {
            log.warn('[Actor] memory store recall:', err && (err.code || err.status || err.message));
            return [];
        }
    }

    return { remember, recall, page: MEMORY_PAGE };
}

module.exports = { createPersonStore, rowOf, KIND_TO_STORE };

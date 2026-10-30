'use strict';

/**
 * The connections a person added (Actor v2, stage V2-11): the rows, the tools beside them and who may read
 * them. Every read and every write is owner-scoped: one person's MCP server is never another's, and the sealed
 * token column never leaves this module (the row a caller gets has no token in it).
 */

const COLUMNS = "id, owner, kind, name, url, header_name, enabled, builtin, created_at, updated_at, last_checked_at, last_ok, last_error";

const fromRow = (r) => (r ? {
    id: r.id, owner: r.owner, kind: r.kind, name: r.name, url: r.url, headerName: r.header_name,
    enabled: r.enabled === true, builtin: r.builtin === true,
    createdAt: r.created_at, updatedAt: r.updated_at, lastCheckedAt: r.last_checked_at,
    lastOk: r.last_ok === null || r.last_ok === undefined ? null : r.last_ok === true,
    lastError: r.last_error == null ? null : String(r.last_error).slice(0, 300),
} : null);

const toolFromRow = (r) => (r ? {
    connectionId: r.connection_id, name: r.name, description: r.description == null ? null : String(r.description).slice(0, 2000),
    inputSchema: r.input_schema || null, annotations: r.annotations || null, enabled: r.enabled === true,
} : null);

/** Every connection of one person, newest first. The token is not in the row. */
async function list(s, owner) {
    const rows = await s.db.many("SELECT " + COLUMNS + " FROM actor_connections WHERE owner = $1 ORDER BY created_at DESC", [owner]);
    return rows.map(fromRow);
}

/** One connection, but only for its owner. */
async function get(s, owner, id) {
    const rows = await s.db.many("SELECT " + COLUMNS + " FROM actor_connections WHERE owner = $1 AND id = $2", [owner, id]);
    return fromRow(rows[0]);
}

/** The sealed token of one connection (the service opens it only to talk to the server). */
async function tokenOf(s, owner, id) {
    const rows = await s.db.many("SELECT token_enc FROM actor_connections WHERE owner = $1 AND id = $2", [owner, id]);
    return rows[0] ? rows[0].token_enc : null;
}

/** A new connection. The token arrives already sealed; nothing here ever sees it in plain text. */
async function add(s, { owner, kind, name, url, headerName = null, tokenEnc = null, builtin = false, id = null }) {
    const cid = id || s.newId("cnx");
    await s.db.query(
        "INSERT INTO actor_connections (id, owner, kind, name, url, header_name, token_enc, enabled, builtin, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, true, $8, $9, $9)",
        [cid, owner, kind, name, url, headerName, tokenEnc, builtin, s.iso()]);
    return get(s, owner, cid);
}

/** Remove a connection and, with it, the tools that belonged to it. */
async function remove(s, owner, id) {
    const rows = await s.db.many("SELECT id FROM actor_connections WHERE owner = $1 AND id = $2", [owner, id]);
    if (!rows.length) return false;
    await s.db.exec("DELETE FROM actor_connections WHERE owner = $1 AND id = $2", [owner, id]);
    return true;
}

/** Turn a whole connection on or off. */
async function setEnabled(s, owner, id, enabled) {
    await s.db.exec("UPDATE actor_connections SET enabled = $3, updated_at = $4 WHERE owner = $1 AND id = $2", [owner, id, enabled === true, s.iso()]);
    return get(s, owner, id);
}

/** What the last check found, so the page can say it without asking again. */
async function markChecked(s, owner, id, { ok, error = null }) {
    await s.db.exec("UPDATE actor_connections SET last_checked_at = $3, last_ok = $4, last_error = $5, updated_at = $3 WHERE owner = $1 AND id = $2",
        [owner, id, s.iso(), ok === true, error ? String(error).slice(0, 300) : null]);
}

/** The tools of one connection, with the person's choice of each. */
async function tools(s, connectionId) {
    const rows = await s.db.many("SELECT connection_id, name, description, input_schema, annotations, enabled FROM actor_connection_tools WHERE connection_id = $1 ORDER BY name", [connectionId]);
    return rows.map(toolFromRow);
}

/** The tools of every connection of one person (the ones the run may offer). */
async function toolsOf(s, owner) {
    const rows = await s.db.many(
        "SELECT t.connection_id, t.name, t.description, t.input_schema, t.annotations, t.enabled FROM actor_connection_tools t" +
        " JOIN actor_connections c ON c.id = t.connection_id WHERE c.owner = $1 AND c.enabled = true", [owner]);
    return rows.map(toolFromRow);
}

/** What the server offers now: the tools it lists replace the ones we knew. Every tool starts off. */
async function replaceTools(s, connectionId, offered = []) {
    await s.db.exec("DELETE FROM actor_connection_tools WHERE connection_id = $1", [connectionId]);
    for (const t of offered) {
        await s.db.query(
            "INSERT INTO actor_connection_tools (connection_id, name, description, input_schema, annotations, enabled, created_at) VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, false, $6)" +
            " ON CONFLICT (connection_id, name) DO UPDATE SET description = EXCLUDED.description, input_schema = EXCLUDED.input_schema, annotations = EXCLUDED.annotations",
            [connectionId, String(t.name).slice(0, 128), t.description ? String(t.description).slice(0, 2000) : null,
                t.inputSchema ? JSON.stringify(t.inputSchema) : null, t.annotations ? JSON.stringify(t.annotations) : null, s.iso()]);
    }
    return tools(s, connectionId);
}

/** The person's choice of one tool. */
async function setToolEnabled(s, owner, connectionId, tool, enabled) {
    const rows = await s.db.many("SELECT id FROM actor_connections WHERE owner = $1 AND id = $2", [owner, connectionId]);
    if (!rows.length) return false;
    const updated = await s.db.exec("UPDATE actor_connection_tools SET enabled = $3 WHERE connection_id = $1 AND name = $2", [connectionId, String(tool).slice(0, 128), enabled === true]);
    return true;
}

module.exports = { list, get, tokenOf, add, remove, setEnabled, markChecked, tools, toolsOf, replaceTools, setToolEnabled, fromRow };

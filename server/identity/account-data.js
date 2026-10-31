'use strict';

/**
 * Account export and deletion → Actor (ADR-033; openvibe-sdk/account-data). Actor holds two things a person made:
 * the tasks they asked for and what they spent per UTC day, both keyed `requester = user:usr_…` (server/http/
 * principal.js builds the requester that way, server/tasks/store.js writes it). Both are the person's own.
 *
 *   network.account.export_requested  the person's tasks (tasks.json) and their per-day spend (spend.json), newest
 *                                     first, pushed to Network (POST /internal/account-exports/:id/parts) with this
 *                                     service's token.
 *   network.account.deleted           both go, and Actor confirms with counts.
 *
 * A task an app, agent or service ran as itself is NOT matched: its requester is `app:…`/`agent:…`/`service:…`, and
 * Network's deletion event carries only the person's `usr_…`, so only rows requested as `user:usr_…` are erased. A task
 * a first-party service started FOR the person (X-OV-Subject; `via` names the service) is requested as `user:usr_…`:
 * it is theirs, exported and erased with the rest.
 * task_events holds no person column at all — its task_id REFERENCES tasks(id) ON DELETE CASCADE — so a task's event
 * log goes with the task and task_events is not in the map. Nothing here is a secret: no token, key or credential is
 * stored, so every column of both tables may be exported.
 */
const { createAccountData, TOPICS } = require('openvibe-sdk/account-data');

/**
 * The tables that hold a person's rows, with the value the subject column really stores. Tasks and daily spend both
 * store `user:usr_…` (server/tasks/store.js takes the requester straight from the principal).
 */
const TABLES = [
    // The files and charts their tasks made (Actor v2, stage V2-4): the rows go with the person, and their bytes come
    // with them in the extra part below. The bytes are not in the row list: a part may carry 20 MB, and one person's
    // charts must not fill it. First, so the rows are erased and counted before their tasks go (and take them with a
    // cascade).
    { table: 'actor_artifacts', subject: 'owner', value: (usr) => `user:${usr}`, file: 'artifacts.json', erase: 'delete',
        columns: ['id', 'task_id', 'owner', 'name', 'mime', 'size', 'created_at'] },
    // A finished task they offered as an OpenVibe.Bench case (stage V2-10): the task text and the answer, nothing else.
    // Before tasks, so its rows are counted before the task's cascade would take them.
    { table: 'actor_bench_offers', subject: 'owner', value: (usr) => `user:${usr}`, file: 'bench-offers.json' },
    // The waits of their tasks (plan A2): what a task of theirs is waiting for, until when, and the line it
    // shows. Before the tasks, so the rows are counted before the task's cascade would take them.
    { table: 'actor_waits', subject: 'requester', value: (usr) => `user:${usr}`, file: 'waits.json',
        columns: ['id', 'task_id', 'requester', 'step', 'kind', 'until', 'filter', 'deadline_at', 'on_timeout', 'line', 'status', 'created_at', 'updated_at', 'finished_at'] },
    // Every column but webhook_secret (a task's signing secret is a credential, not the person's data).
    {
        table: 'tasks', subject: 'requester', value: (usr) => `user:${usr}`, file: 'tasks.json',
        columns: ['id', 'requester', 'project_id', 'task', 'mode', 'agent', 'budget_task', 'budget_day', 'state', 'result', 'error_code', 'error_detail',
            'cost_usd', 'free_usd', 'explanation', 'cancel_at', 'cancel_by', 'last_seq', 'idem_key', 'idem_hash', 'created_at', 'finished_at', 'timeout_ms', 'via', 'webhooks', 'parent_id',
            // A fork's parent step and the one change it was made with (stage V2-9), and how often it resumed.
            'fork_of_step', 'fork_change', 'resumes'],
    },
    // The person's own per-UTC-day spend accounting. Deleted: nothing in Actor keeps a person's spend record for a
    // reason that outlives them. The `*` row (everyone's daily ceiling) does not match `user:usr_…` and stays — it is
    // the operator's total, a separate row.
    { table: 'spend_daily', subject: 'requester', value: (usr) => `user:${usr}`, file: 'spend.json' },
    { table: 'actor_agent_memory', subject: 'owner', value: (usr) => `user:${usr}`, file: 'agent-memory.json' },
    // What their agents suggested adding to their instructions, and what they decided (agents/personal.js).
    { table: 'actor_agent_proposals', subject: 'owner', value: (usr) => `user:${usr}`, file: 'agent-suggestions.json' },
    // Which of their agents' runs went to their Vibe chats (agents/vibe-deliver.js).
    { table: 'actor_vibe_deliveries', subject: 'owner', value: (usr) => `user:${usr}`, file: 'agent-runs-sent-to-vibe.json' },
    { table: 'actor_agents', subject: 'owner', value: (usr) => `user:${usr}`, file: 'agents.json' },
    // What the person's agents asked them to approve (agents/approvals.js), and what they decided.
    { table: 'actor_approvals', subject: 'owner', value: (usr) => `user:${usr}`, file: 'approvals.json' },
    // What they asked Actor in chat (chat/asks.js): the message it answered, the room, the task it became.
    { table: 'actor_chat_asks', subject: 'requester', value: (usr) => `user:${usr}`, file: 'chat-asks.json' },
    // The connections they added (stage V2-11): the servers and agents, and which of their tools are on. The token
    // column (token_enc) is a credential, never their data, so it is not exported and not listed here.
    {
        table: 'actor_connections', subject: 'owner', value: (usr) => `user:${usr}`, file: 'connections.json',
        columns: ['id', 'owner', 'kind', 'name', 'url', 'header_name', 'enabled', 'builtin', 'created_at', 'updated_at', 'last_checked_at', 'last_ok', 'last_error'],
    },
];

// What the extra part may carry: the bytes of the person's own files, base64, newest first, up to this much.
const CONTENT_BUDGET = 4 * 1024 * 1024;

/**
 * The content of the person's artifacts (stage V2-4): every file they made, as base64, newest first, until the
 * budget is spent. The rows themselves are in artifacts.json; this is the part that carries the bytes.
 */
async function exportFiles(db, subject) {
    const rows = await db.many(
        'SELECT id, name, mime, size, bytes FROM actor_artifacts WHERE owner = ANY($1::text[]) ORDER BY created_at DESC',
        [[`user:${subject}`]],
    );
    const out = [];
    let budget = CONTENT_BUDGET;
    for (const r of rows || []) {
        const bytes = Buffer.isBuffer(r.bytes) ? r.bytes : Buffer.from(r.bytes || []);
        const content = bytes.toString('base64');
        if (content.length > budget) continue;
        budget -= content.length;
        out.push({ id: r.id, name: r.name, mime: r.mime, size: Number(r.size) || bytes.length, content_base64: content });
    }
    if (!out.length) return [];
    return [{ name: 'artifacts-content.json', content: out }];
}

/**
 * The trace of the person's tasks (stage V2-10): one row per model, tool, check, judge and delegate call. A span has
 * no person column of its own (it is keyed by task_id and has no text), so it is exported by joining the task's
 * requester and is not a table-map entry. The rows go with the task on deletion (ON DELETE CASCADE).
 */
async function exportSpans(db, subject) {
    const rows = await db.many(
        `SELECT s.id, s.task_id, s.parent_id, s.kind, s.name, s.tier, s.family, s.started_at, s.ms, s.cost_usd,
                s.tokens_in, s.tokens_out, s.ok, s.error_code, s.step
           FROM actor_spans s JOIN tasks t ON t.id = s.task_id
          WHERE t.requester = ANY($1::text[]) ORDER BY s.started_at DESC LIMIT 5000`,
        [[`user:${subject}`]],
    );
    return rows.length ? [{ name: 'spans.json', content: rows }] : [];
}

/**
 * The checkpoints of the person's tasks (stage V2-9): when each step was saved. The sealed state is not exported: it
 * can only be opened with Actor's checkpoint key, and the step and time are what the person's record needs. A
 * checkpoint has no person column; it is exported by joining the task's requester and goes with the task on deletion
 * (ON DELETE CASCADE).
 */
async function exportCheckpoints(db, subject) {
    const rows = await db.many(
        `SELECT c.task_id, c.step, c.created_at
           FROM actor_checkpoints c JOIN tasks t ON t.id = c.task_id
          WHERE t.requester = ANY($1::text[]) ORDER BY c.created_at DESC LIMIT 5000`,
        [[`user:${subject}`]],
    );
    return rows.length ? [{ name: 'checkpoints.json', content: rows }] : [];
}

/** The parts a table map cannot say: the bytes of the person's files, the trace of their tasks, their saved steps. */
/**
 * The tools of the person's connections (stage V2-11): which tools of which server are on. A tool row has no person
 * column of its own (it hangs on the connection), so it is exported by joining the connection's owner. No token is
 * here: a token is a credential, not the person's data.
 */
async function exportConnectionTools(db, subject) {
    const rows = await db.many(
        `SELECT c.id AS connection_id, c.name AS connection_name, c.kind, t.name, t.description, t.enabled
           FROM actor_connection_tools t JOIN actor_connections c ON c.id = t.connection_id
          WHERE c.owner = ANY($1::text[]) ORDER BY c.name, t.name`,
        [[`user:${subject}`]],
    );
    return rows.length ? [{ name: 'connection-tools.json', content: rows }] : [];
}

async function exportExtra(db, subject) {
    return [...(await exportFiles(db, subject)), ...(await exportSpans(db, subject)), ...(await exportCheckpoints(db, subject)), ...(await exportConnectionTools(db, subject))];
}

/** The account-data handle for Actor's store (server/db.js createStore). */
function create({ db, note = 'A task row holds the task the person asked for, in their own words.', log = console } = {}) {
    return createAccountData({ db, service: 'actor', tables: TABLES, note, log, extraExport: exportExtra });
}

module.exports = { create, TABLES, TOPICS, exportFiles, exportSpans, exportCheckpoints, exportConnectionTools, exportExtra };

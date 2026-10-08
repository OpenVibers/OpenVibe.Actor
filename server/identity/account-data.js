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
 * A task an app, agent or service ran for this person is NOT matched: its requester is `app:…`/`agent:…`/`service:…`,
 * and Network's deletion event carries only the person's `usr_…`, so only rows requested as `user:usr_…` are erased.
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
    { table: 'tasks', subject: 'requester', value: (usr) => `user:${usr}`, file: 'tasks.json' },
    // The person's own per-UTC-day spend accounting. Deleted: nothing in Actor keeps a person's spend record for a
    // reason that outlives them. The `*` row (everyone's daily ceiling) does not match `user:usr_…` and stays — it is
    // the operator's total, a separate row.
    { table: 'spend_daily', subject: 'requester', value: (usr) => `user:${usr}`, file: 'spend.json' },
];

/** The account-data handle for Actor's store (server/db.js createStore). */
function create({ db, note = 'A task row holds the task the person asked for, in their own words.', log = console } = {}) {
    return createAccountData({ db, service: 'actor', tables: TABLES, note, log });
}

module.exports = { create, TABLES, TOPICS };

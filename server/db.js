'use strict';

/**
 * OpenVibe.Actor's own PostgreSQL database (ADR-035): the schema is migrations/NNNN_*.sql, applied at boot. Tasks, their
 * event logs and daily spend (tasks/store.js); nothing written here is ever a secret, token or credential.
 */
const fs = require('fs');
const path = require('path');
const { createDb } = require('openvibe-sdk/db');
const { ids } = require('openvibe-contracts');

const TABLES = ['tasks', 'task_events', 'spend_daily'];

const MIGRATIONS = path.join(__dirname, '..', 'migrations');
const DEV_PGLITE = path.join(__dirname, '..', 'data', 'pglite');

async function openDb(config, { log = console, registry } = {}) {
    if (!config.db.url) {
        if (config.isProduction) throw new Error('DATABASE_URL is not set: production serves from PostgreSQL (OpenVibe.Host roles/data add-service.sh actor)');
        const dir = config.db.pgliteDir || DEV_PGLITE;
        log.warn(`[Actor] DATABASE_URL unset: embedded PGlite database in ${dir} (development only, one process)`);
        fs.mkdirSync(dir, { recursive: true });
        const db = createDb({ pglite: dir, service: 'actor', registry, log });
        await db.migrate({ dir: MIGRATIONS, log });
        return db;
    }
    if (!config.db.directUrl) throw new Error('DATABASE_DIRECT_URL is not set: migrations run with the owner role on a direct connection');
    const owner = createDb({ url: config.db.directUrl, service: 'actor-migrate', max: 1, log });
    try { await owner.migrate({ dir: MIGRATIONS, log }); } finally { await owner.close(); }
    return createDb({ url: config.db.url, service: 'actor', registry, log });
}

/** The store every module takes: the db handle, a clock (epoch ms; tests inject one), ids and transactions. */
function createStore(db, { now = () => Date.now() } = {}) {
    return {
        db,
        now,
        iso: () => new Date(now()).toISOString(),
        newId: (prefix) => `${prefix}_${ids.ulid(now())}`,
        tx: async (fn) => await db.tx(() => fn()),
        close: () => db.close(),
    };
}

async function openStore(config, { now, log } = {}) {
    return createStore(await openDb(config, { log }), { now });
}

module.exports = { openDb, openStore, createStore, MIGRATIONS, TABLES };

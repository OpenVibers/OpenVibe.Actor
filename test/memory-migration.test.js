'use strict';
/**
 * The N-1 expand-migration test (stage V2-6): a database at 0016, with rows an old release wrote, then 0017 on top.
 *
 * An expand migration runs while the previous release still serves. It may only add things: the old release's INSERT
 * (with `origin`, an agent_id and up to its 1000-character text) must still work, and its rows must keep their words.
 * The 500-character limit is enforced for new writes in code only, so this row is listed and edited as it is.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createDb } = require('openvibe-sdk/db');
const { check, done } = require('./helpers/boot');
const { createStore, MIGRATIONS } = require('../server/db');
const memory = require('../server/memory');

const owner = 'user:usr_01JZ0000000000000000000AAA';

(async () => {
    const migrationsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'actor-migrations-0016-'));
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'actor-pglite-0016-'));
    let db = null;
    try {
        // Everything up to 0016, exactly as the previous release has it.
        for (const f of fs.readdirSync(MIGRATIONS).filter((x) => x.endsWith('.sql') && x < '0017').sort()) {
            fs.copyFileSync(path.join(MIGRATIONS, f), path.join(migrationsDir, f));
        }
        db = createDb({ pglite: dataDir, service: 'actor-test', log: { log() {}, warn() {} } });
        const first = await db.migrate({ dir: migrationsDir });
        assert.ok(first.applied.some((m) => m.id === '0016'));
        assert.ok(!first.applied.some((m) => m.id === '0017'));

        const now = new Date().toISOString();
        const agentId = 'agt_01JZ0000000000000000000AGT';
        const agentMemoryId = 'mem_01JZ0000000000000000000AGT';
        const oldStyleText = `An old note from before the limit. ${'x'.repeat(900)}`.slice(0, 900);
        await db.query(`INSERT INTO actor_agents (id, owner, name, instructions, mode, budget_per_run_usd, daily_runs_max, schedule, status, created_at, updated_at)
            VALUES ($1, $2, 'Old agent', 'Help.', 'balanced', 0.01, 1, 'off', 'active', $3, $3)`, [agentId, owner, now]);
        // The exact shape the previous release writes: origin, agent_id, and up to 1000 characters.
        await db.query('INSERT INTO actor_agent_memory (id, agent_id, owner, text, origin, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$6)',
            [agentMemoryId, agentId, owner, oldStyleText, 'agent', now]);
        // 0017 on top of the running schema.
        const second = await db.migrate({ dir: MIGRATIONS });
        assert.deepStrictEqual(second.applied.map((m) => m.id), ['0017', '0018', '0019', '0020', '0021', '0022', '0023', '0024']);

        await check('an old-style INSERT still works after 0017, and a 900-character row is intact', async () => {
            const old = await db.maybe('SELECT id, text, origin, status, kind, uses FROM actor_agent_memory WHERE id = $1', [agentMemoryId]);
            assert.strictEqual(old.text, oldStyleText, 'the person\'s words were not truncated');
            assert.strictEqual(old.text.length, 900);
            assert.strictEqual(old.origin, 'agent', 'the column keeps its name');
            assert.strictEqual(old.status, 'suggested', 'an existing agent note waits for the person');
            assert.strictEqual(old.kind, 'fact');
            assert.strictEqual(old.uses, 0);
            // The previous release's INSERT (agent_id set, only its columns), still succeeds after 0017.
            const laterId = 'mem_01JZ0000000000000000000LTR';
            await db.query('INSERT INTO actor_agent_memory (id, agent_id, owner, text, origin, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$6)',
                [laterId, agentId, owner, 'An old-style insert after the migration.', 'person', now]);
            const later = await db.maybe('SELECT text, origin, status, kind FROM actor_agent_memory WHERE id = $1', [laterId]);
            assert.strictEqual(later.text, 'An old-style insert after the migration.');
            assert.strictEqual(later.origin, 'person');
            assert.strictEqual(later.status, 'active', 'the column defaults keep the old contract');
            assert.strictEqual(later.kind, 'fact');
            // And the new nullable agent_id: the person's own memory across tasks.
            const nullId = 'mem_01JZ0000000000000000000NUL';
            await db.query('INSERT INTO actor_agent_memory (id, agent_id, owner, text, origin, created_at, updated_at) VALUES ($1,NULL,$2,$3,$4,$5,$5)',
                [nullId, owner, 'The person\'s own note.', 'person', now]);
            assert.strictEqual(await db.value('SELECT agent_id FROM actor_agent_memory WHERE id = $1', [nullId]), null);

            const cols = await db.many("SELECT column_name FROM information_schema.columns WHERE table_name = 'actor_agent_memory'");
            const names = cols.map((c) => c.column_name);
            assert.ok(names.includes('origin') && !names.includes('source'), 'origin is not renamed');
            const cons = await db.many("SELECT conname FROM pg_constraint WHERE conrelid = 'actor_agent_memory'::regclass");
            assert.ok(!cons.some((c) => /text_500/.test(c.conname)), 'no tighter length check');
        });

        await check('the new code reads that row as source and still lists it whole', async () => {
            const s = createStore(db, { now: () => Date.parse(now) });
            const rows = await memory.list(s, owner);
            const long = rows.find((m) => m.id === agentMemoryId);
            assert.ok(long, 'the old row is listed');
            assert.strictEqual(long.text.length, 900);
            assert.strictEqual(long.source, 'agent', 'fromRow calls the value source');
            assert.strictEqual(long.status, 'suggested');
            // An edit over 500 is refused with the same clear message and leaves the row alone.
            const refused = await memory.edit(s, owner, agentMemoryId, { text: long.text });
            assert.match(refused.error, /at most 500/);
            assert.strictEqual((await memory.get(s, owner, agentMemoryId)).text.length, 900);
        });
    } finally {
        if (db) await db.close().catch(() => {});
        fs.rmSync(migrationsDir, { recursive: true, force: true });
        fs.rmSync(dataDir, { recursive: true, force: true });
    }
    done();
})();

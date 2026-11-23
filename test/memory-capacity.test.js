'use strict';

const assert = require('assert');
const { check, done } = require('./helpers/boot');
const { testDb } = require('./helpers/db');
const { createStore } = require('../server/db');
const memory = require('../server/memory');
const personal = require('../server/agents/personal');

const owner = 'user:usr_01JZ0000000000000000000AAA';

(async () => {
    const db = await testDb();
    const s = createStore(db.db);
    try {
        const agent = (await personal.create(s, { allowance: { perTaskUsd: 0.05 }, agents: { maxPerOwner: 20 } }, owner,
            { name: 'Capacity helper', instructions: 'Help.', mode: 'balanced', budget_per_run_usd: 0.01, daily_runs_max: 1, schedule: 'off', status: 'active' })).row;
        const fill = async (agentId, count, source) => {
            await s.db.query('DELETE FROM actor_agent_memory');
            const rows = [];
            for (let i = 0; i < count; i++) {
                const out = await memory.add(s, { owner, agentId, text: `Capacity note ${i}`, source });
                assert.ok(out.row, out.error);
                rows.push(out.row);
            }
            return rows;
        };

        await check('repeating an agent note at capacity preserves all 50 notes', async () => {
            const rows = await fill(agent.id, memory.MAX_PER_AGENT, 'agent');
            const repeated = await memory.add(s, { owner, agentId: agent.id, text: rows[20].text.toUpperCase(), source: 'agent' });
            assert.strictEqual(repeated.duplicate, true);
            assert.deepStrictEqual((await memory.forAgent(s, owner, agent.id)).map((r) => r.id).sort(), rows.map((r) => r.id).sort());
        });

        await check('repeating the oldest agent note preserves its identity, pin and usage', async () => {
            const rows = await fill(agent.id, memory.MAX_PER_AGENT, 'agent');
            await memory.pin(s, owner, rows[0].id);
            await s.db.query('UPDATE actor_agent_memory SET uses = 3 WHERE id = $1', [rows[0].id]);
            const repeated = await memory.add(s, { owner, agentId: agent.id, text: rows[0].text, source: 'agent' });
            assert.strictEqual(repeated.row.id, rows[0].id);
            assert.strictEqual(repeated.duplicate, true);
            assert.strictEqual(repeated.row.pinned, true);
            assert.strictEqual(repeated.row.uses, 3);
        });

        await check('a duplicate in an agent full of person-written notes succeeds; a new note still fails', async () => {
            const rows = await fill(agent.id, memory.MAX_PER_AGENT, 'person');
            const repeated = await memory.add(s, { owner, agentId: agent.id, text: rows[0].text, source: 'person' });
            assert.strictEqual(repeated.duplicate, true, repeated.error);
            const added = await memory.add(s, { owner, agentId: agent.id, text: 'One more note', source: 'person' });
            assert.strictEqual(added.limit, true);
        });

        await check('a personal duplicate at capacity can be confirmed; a new note still fails', async () => {
            const rows = await fill(null, memory.MAX_PER_PERSON, 'agent');
            const repeated = await memory.add(s, { owner, text: rows[0].text.toUpperCase(), source: 'person', kind: 'preference' });
            assert.strictEqual(repeated.duplicate, true, repeated.error);
            assert.strictEqual(repeated.row.id, rows[0].id);
            assert.strictEqual(repeated.row.status, 'active');
            assert.strictEqual(repeated.row.source, 'person');
            assert.strictEqual(repeated.row.kind, 'preference');
            assert.strictEqual((await memory.own(s, owner)).length, memory.MAX_PER_PERSON);
            const added = await memory.add(s, { owner, text: 'One more note' });
            assert.strictEqual(added.limit, true);
        });

        await check('a new agent note at capacity still replaces only the oldest agent-written note', async () => {
            const rows = await fill(agent.id, memory.MAX_PER_AGENT, 'agent');
            const added = await memory.add(s, { owner, agentId: agent.id, text: 'One more note', source: 'agent' });
            assert.ok(added.row, added.error);
            assert.strictEqual(await memory.get(s, owner, rows[0].id), null);
            const ids = (await memory.forAgent(s, owner, agent.id)).map((r) => r.id).sort();
            assert.deepStrictEqual(ids, [...rows.slice(1).map((r) => r.id), added.row.id].sort());
        });
    } finally { await db.close(); }
    done();
})().catch((err) => { console.error(err); process.exit(1); });

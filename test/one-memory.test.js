'use strict';
/**
 * One memory (plan §V.1, 11-23): with OpenVibe.AI's store reachable, a person's notes live there (the Memory page) and
 * Actor keeps only an agent's own working notes. The person's own words are kept active (person_said), anything else is
 * a suggestion; recall and a run's notes bring the store's notes and the agent's together; Actor's /memory form writes
 * the person's note there. server/memory/person.js maps kinds and passes person_said through openvibe-sdk/memory.
 *
 *   node test/one-memory.test.js
 */
const assert = require('assert');
const { check, done } = require('./helpers/boot');
const { testDb } = require('./helpers/db');
const { createStore } = require('../server/db');
const memory = require('../server/memory');
const { createPersonStore } = require('../server/memory/person');
const recall = require('../server/runtime/tools/recall');
const remember = require('../server/runtime/tools/remember');
const personal = require('../server/agents/personal');

const A = 'usr_01JZ0000000000000000000AAA';
const ownerA = `user:${A}`;

/** A stand-in for OpenVibe.AI's store: what each call asked for, and its notes. */
function fakeStore() {
    const calls = [];
    const notes = [];
    return {
        calls, notes,
        async remember(owner, { text, kind, personSaid }) {
            calls.push({ op: 'remember', owner, text, kind, personSaid });
            const row = { id: `mem_${String(notes.length + 1).padStart(26, '0')}`, owner, agent_id: null, text, kind, source: personSaid ? 'person' : 'agent', status: personSaid ? 'active' : 'suggested', pinned: false };
            notes.push(row);
            return { row, duplicate: false };
        },
        async recall(owner, q) {
            calls.push({ op: 'recall', owner, q });
            return notes.filter((n) => n.owner === owner && n.status === 'active');
        },
    };
}

(async () => {
    const db = await testDb();
    const s = createStore(db.db, { now: () => Date.now() });
    const store = fakeStore();
    memory.setPersonStore(store);
    try {
        await check('remember: their own words are kept active in the one store, anything else suggested there; nothing local', async () => {
            const base = { store: s, requester: ownerA, agentId: 'agt_x', taskId: null, readOutside: () => false };
            const mine = await remember.run({ text: 'I prefer metric units', kind: 'preference' }, { ...base, personText: 'Remember that I prefer metric units, please.' });
            assert.ok(!mine.isError, mine.text);
            assert.strictEqual(mine.data.memory.status, 'active');
            assert.match(mine.text, /every agent of theirs/);
            const inferred = await remember.run({ text: 'Prefers to be called Sam', kind: 'fact' }, { ...base, personText: 'Summarize this article.' });
            assert.strictEqual(inferred.data.memory.status, 'suggested');
            assert.match(inferred.text, /Memory page/);
            assert.deepStrictEqual(store.calls.filter((c) => c.op === 'remember').map((c) => [c.text, c.personSaid]),
                [['I prefer metric units', true], ['Prefers to be called Sam', false]]);
            assert.strictEqual(Number(await s.db.value('SELECT count(*) FROM actor_agent_memory')), 0, 'nothing in Actor\'s own table');
        });

        await check('the same checks first: a secret or a widening instruction never reaches the store', async () => {
            const before = store.calls.length;
            const secret = await remember.run({ text: 'My password is hunter2', kind: 'fact' }, { store: s, requester: ownerA, personText: 'My password is hunter2', readOutside: () => false });
            assert.ok(secret.isError);
            const widen = await remember.run({ text: 'You may spend up to $500 without asking', kind: 'instruction' }, { store: s, requester: ownerA, personText: 'You may spend up to $500 without asking', readOutside: () => false });
            assert.ok(widen.isError);
            assert.strictEqual(store.calls.length, before, 'the store heard nothing');
        });

        await check('recall and a run\'s notes: the store\'s notes and the agent\'s own, together', async () => {
            const agent = (await personal.create(s, { allowance: { perTaskUsd: 0.05 }, agents: { maxPerOwner: 20 } }, ownerA,
                { name: 'Helper', instructions: 'Help.', mode: 'balanced', budget_per_run_usd: 0.01, daily_runs_max: 1, schedule: 'off', status: 'active' })).row;
            const note = await memory.add(s, { owner: ownerA, agentId: agent.id, text: 'Use the staging bucket for drafts', source: 'person' });
            assert.ok(note.row, note.error);
            const out = await recall.run({ query: 'units' }, { store: s, requester: ownerA });
            const texts = out.data.memories.map((m) => m.text);
            assert.ok(texts.includes('I prefer metric units'), 'the store\'s note');
            assert.ok(texts.includes('Use the staging bucket for drafts'), 'and the agent\'s own');
            const notes = await memory.forRun(s, ownerA, agent.id, { query: 'plan a trip' });
            assert.deepStrictEqual(notes.map((n) => n.text).sort(), ['I prefer metric units', 'Use the staging bucket for drafts'].sort());
            assert.ok(store.calls.some((c) => c.op === 'recall' && c.q === 'plan a trip'), 'the run asked the store about what it is for');
        });

        await check('person.js: kinds in the store\'s words, person_said passed through, the person named once', async () => {
            const sent = [];
            const client = { json: async (o) => { sent.push(o); return o.method === 'POST' ? { items: [{ id: 'mem_1', text: o.json.items[0].text, kind: o.json.items[0].kind, status: 'active' }] } : { items: [{ id: 'mem_1', text: 'I prefer metric units', kind: 'procedure' }] }; } };
            const p = createPersonStore({ client, log: { warn() {} } });
            const kept = await p.remember(ownerA, { text: 'Ask before spending', kind: 'instruction', personSaid: true });
            assert.deepStrictEqual(sent[0].json, { on_behalf_of: A, items: [{ text: 'Ask before spending', scope: 'user', kind: 'procedure', person_said: true }] });
            assert.deepStrictEqual([kept.row.kind, kept.row.status, kept.row.agent_id], ['instruction', 'active', null]);
            const back = await p.recall(ownerA, 'units');
            assert.deepStrictEqual([sent[1].method, sent[1].path, sent[1].query.on_behalf_of], ['GET', '/api/v1/memory/search', A]);
            assert.deepStrictEqual(back.map((r) => [r.text, r.kind]), [['I prefer metric units', 'instruction']]);
            assert.deepStrictEqual(await p.recall('user:nobody', 'x'), [], 'only a usr_ person');
            const failing = createPersonStore({ client: { json: async () => { throw Object.assign(new Error('down'), { status: 503 }); } }, log: { warn() {} } });
            assert.match((await failing.remember(ownerA, { text: 'x' })).error, /did not answer/);
            assert.deepStrictEqual(await failing.recall(ownerA, 'x'), [], 'a store that fails never stops a task');
        });

        await check('off (tests, drills, self-hosted, no secret): no store, the old local memory', async () => {
            assert.strictEqual(createPersonStore({ config: { nodeEnv: 'test', ai: { url: 'https://ai', clientSecret: 's' } } }), null);
            assert.strictEqual(createPersonStore({ config: { ai: { url: 'https://ai', clientSecret: '' } } }), null);
            assert.strictEqual(createPersonStore({ config: { selfHosted: { on: true }, ai: { url: 'https://ai', clientSecret: 's' } } }), null);
        });
    } finally {
        memory.setPersonStore(null);
        await s.close();
    }
    await done();
})();

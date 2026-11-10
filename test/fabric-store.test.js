'use strict';
const assert = require('node:assert/strict');
const { boot, check, done } = require('./helpers/boot');
const { createFabric } = require('../server/fabric/service');
const contacts = require('../server/agents/contacts');
const config = require('../server/config');
const A = 'usr_01JZ0000000000000000000AAA', B = 'usr_01JZ0000000000000000000BBB';
(async () => {
    const t = await boot({ env: { ACTOR_WORK_FABRIC: '1' } });
    try {
        const s = t.ctx.s;
        const alice = t.network.addUser('alice'); alice.subject = A;
        const bob = t.network.addUser('bob'); bob.subject = B;
        await contacts.ensureVibe(s, t.config, `user:${A}`);
        const agent = (await contacts.list(s, t.config, `user:${A}`))[0].id;
        // Storage tests exercise rollback separately from the released-contract tests.
        const f = createFabric({ s, enabled: true, validate: () => {} });
        const c = { sources: { chat: { kind: 'chat', enabled: true, self: 'bot', scopes: ['global'], mentions: ['actor'] } }, policy: { sources: { chat: { allowed: [A], bots: [], admission: {} } } } };
        await check('001 transaction: feature defaults off and owner is checked on every command/read', async () => {
            assert.equal(config.load({}).fabric.enabled, false);
            await assert.rejects(() => createFabric({ s }).command(`user:${A}`, agent, 'configure', c), /disabled/);
            await assert.rejects(() => f.command(`user:${B}`, agent, 'configure', c), /not found/);
            await f.command(`user:${A}`, agent, 'configure', c);
            await assert.rejects(() => f.snapshot(`user:${B}`, agent), /not found/);
            assert.equal((await f.snapshot(`user:${A}`, agent)).state.sources.chat.owner_subject, A);
        });
        const ev = { event_id: 'ev1', event_type: 'chat.message.created', payload: { message_id: 1, user_subject: A, text: '@actor fix a test', room: { type: 'global' } } };
        await check('001 atomic intake: concurrent replays store once with one cursor and one Eval', async () => {
            await Promise.all([f.onEvent(ev), f.onEvent(ev)]);
            let snap = await f.snapshot(`user:${A}`, agent); assert.equal(Object.keys(snap.state.triggers).length, 1); assert.equal(snap.state.sources.chat.cursor, 'ev1');
            const thread = Object.keys(snap.state.threads)[0];
            const evaluations = await Promise.all([f.command(`user:${A}`, agent, 'start', { thread }), f.command(`user:${A}`, agent, 'start', { thread })]);
            assert.equal(evaluations[0].id, evaluations[1].id);
            const strict = createFabric({ s, enabled: true, validate: name => { if (name === 'agent.decision') throw new Error('validation rejected'); } });
            await assert.rejects(() => strict.command(`user:${A}`, agent, 'decide', { evaluation: evaluations[0].id, decision: 'accept', scope: 'Fix test' }), /validation rejected/);
            snap = await f.snapshot(`user:${A}`, agent); assert.equal(Object.keys(snap.state.tickets).length, 0); assert(!snap.state.work.some(w => w.kind === 'launch')); assert(snap.state.threads[thread].evaluation);
            await f.command(`user:${A}`, agent, 'decide', { evaluation: evaluations[0].id, decision: 'accept', scope: 'Fix test' });
        });
        await check('003 Stored work: handler observes committed Ticket; failed handler retains work after restart', async () => {
            let called = 0;
            await f.drain(`user:${A}`, agent, { launch: async (_payload, meta) => {
                const saved = await f.snapshot(`user:${A}`, agent); assert.equal(Object.keys(saved.state.tickets).length, 1); assert(meta.idempotency_key); called++; throw new Error('offline');
            } });
            assert.equal(called, 1);
            const recovered = createFabric({ s, enabled: true });
            const snap = await recovered.snapshot(`user:${A}`, agent), work = snap.state.work.find(w => w.kind === 'launch');
            assert.equal(work.state, 'pending'); assert.equal(work.attempts, 1);
        });
        await check('002 Executor port: worker cannot withdraw authority, change policy or widen a subscription', async () => {
            const before = await f.snapshot(`user:${A}`, agent), ticket = Object.keys(before.state.tickets)[0];
            const worker = f.worker(`user:${A}`, agent, ticket);
            assert.throws(() => worker.command('configure', {}), /not available/);
            await worker.command('subscribe', { thread: 'related', kind: 'source' });
            await worker.command('end', { person: true });
            const after = await f.snapshot(`user:${A}`, agent);
            assert.equal(after.state.threads.related.subscriptions[ticket], 'context');
            assert.equal(after.state.meta[ticket].stopped, undefined);
        });
        await check('API: unauthenticated and foreign owner cannot read or mutate fabric', async () => {
            const anon = await t.get(`/api/v1/fabric/${agent}`); assert([401, 403].includes(anon.status));
            const foreign = await t.get(`/api/v1/fabric/${agent}`, { as: bob }); assert.equal(foreign.status, 404);
            const own = await t.get(`/api/v1/fabric/${agent}`, { as: alice }); assert.equal(own.status, 200);
            const invalid = await t.get(`/api/v1/fabric/${agent}/commands/receive`, { as: alice, headers: { Origin: 'https://openvibe.actor' }, json: {} }); assert.equal(invalid.status, 422);
        });
    } finally { await t.close(); }
    done();
})().catch(err => { console.error(err); process.exit(1); });

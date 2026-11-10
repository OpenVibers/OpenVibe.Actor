'use strict';
/**
 * The fabric's executor adapter on Actor's real task engine, with the stand-in providers (no live model calls): an
 * explicit Chat mention is gated, routed and launched; the owner's agent actually runs it; the run's end becomes one
 * agent.report@1 on the Ticket, the Ticket ends, and one reply is posted back to the room.
 */
const assert = require('node:assert/strict');
const { boot, check, done } = require('./helpers/boot');
const contacts = require('../server/agents/contacts');

const A = 'usr_01JZ0000000000000000000AAA';

(async () => {
    const posts = [];
    const t = await boot({ env: { ACTOR_WORK_FABRIC: '1' }, chatClient: { post: async (args) => { posts.push(args); return { ok: true, id: 'msg_1' }; } } });
    try {
        const alice = t.network.addUser('alice'); alice.subject = A;
        const vibe = await contacts.ensureVibe(t.ctx.s, t.config, `user:${A}`);
        const agent = vibe.id;
        const owner = `user:${A}`;
        const fabric = t.ctx.fabric;

        await check('executor: a mention is gated, launched on the runtime, reported ready, ended and answered once', async () => {
            await fabric.command(owner, agent, 'configure', {
                sources: { chat: { kind: 'chat', enabled: true, self: 'agent_actor', scopes: ['global'], mentions: ['actor'], receive_all: ['global'] } },
                policy: {
                    mode: 'auto', rules: [{ id: 'fix', enabled: true, instruction: 'Fix requested defects' }],
                    budget: { usd: 1, tokens: 1000, wall_minutes: 10 },
                    sources: { chat: { allowed: [A], bots: [], admission: { global: { unlisted_unaddressed: 'ignore' } } } },
                },
            });
            const intake = await fabric.onEvent({ event_id: 'ev1', event_type: 'chat.message.created', payload: {
                message_id: 1, user_subject: A, text: '@actor fix the failing test', room: { type: 'global' },
            } });
            assert.equal(intake[0].status, 'stored');
            await fabric.tick();
            const worked = await t.ctx.fabricAdapters.drainAll();
            assert.ok(worked >= 2, 'route and launch were performed');

            let state = (await fabric.snapshot(owner, agent)).state;
            const ticket = Object.values(state.tickets)[0];
            assert.ok(ticket, 'a Ticket was created');
            assert.equal(state.meta[ticket.id].tasks.length, 1, 'one task was bound to the Ticket');
            const linked = await t.ctx.s.db.many('SELECT task_id FROM actor_fabric_tasks WHERE ticket_id = $1', [ticket.id]);
            assert.equal(linked.length, 1, 'the binding committed with the task');

            const until = Date.now() + 20_000;
            while (Date.now() < until) {
                state = (await fabric.snapshot(owner, agent)).state;
                if (state.tickets[ticket.id].state === 'ended') break;
                await new Promise((r) => setTimeout(r, 50));
            }
            assert.equal(state.tickets[ticket.id].state, 'ended', 'the run ended the Ticket');
            assert.equal(state.tickets[ticket.id].stage, 'person/review');
            const reports = state.meta[ticket.id].reports;
            assert.equal(reports.length, 1);
            assert.equal(reports[0].state, 'ready');
            assert.ok(reports[0].summary.length > 0);
            assert.equal(state.meta[ticket.id].reports[0].pr, null);

            // The reply is stored work too: it is posted once, with the run's answer.
            await t.ctx.fabricAdapters.drainAll();
            assert.equal(posts.length, 1);
            assert.deepEqual(posts[0].room, { type: 'global' });
            assert.match(posts[0].text, /Tool said|Stand-in answer/);
        });
    } finally { await t.close(); }
    done();
})().catch((err) => { console.error(err); process.exit(1); });

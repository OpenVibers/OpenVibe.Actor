'use strict';
/**
 * S5 observe → auto through the service and the API on a real (PGlite) database: observe records are mirrored to SQL,
 * the lanes endpoint says each lane's mode, promote/demote are commands, and the six report states are data.
 */
const assert = require('node:assert/strict');
const { boot, check, done } = require('./helpers/boot');
const contacts = require('../server/agents/contacts');
const { createRoutes } = require('../server/fabric/api');

const A = 'usr_01JZ0000000000000000000AAA';
const B = 'usr_01JZ0000000000000000000BBB';
const policy = () => ({
    mode: 'observe', rules: [{ id: 'fix', enabled: true, instruction: 'Fix requested defects' }],
    sources: { chat: { allowed: [A], bots: [], admission: { global: { unlisted_unaddressed: 'inferred' } } } },
    budget: { usd: 1, tokens: 1000, wall_minutes: 10 },
});

(async () => {
    const t = await boot({ env: { ACTOR_WORK_FABRIC: '1' } });
    try {
        assert.equal(typeof createRoutes, 'function');
        const alice = t.network.addUser('alice'); alice.subject = A;
        const bob = t.network.addUser('bob'); bob.subject = B;
        const vibe = await contacts.ensureVibe(t.ctx.s, t.config, `user:${A}`);
        const owner = `user:${A}`, agent = vibe.id, fabric = t.ctx.fabric;
        const event = (id, text) => ({ event_id: `ev${id}`, event_type: 'chat.message.created', payload: { message_id: id, user_subject: A, text, room: { type: 'global' } } });
        let first = null;

        await check('observe: an inferred decision records the gate verdict and cost and launches nothing', async () => {
            await fabric.command(owner, agent, 'configure', {
                sources: { chat: { kind: 'chat', enabled: true, self: 'agent_actor', scopes: ['global'], receive_all: ['global'] } },
                policy: policy(),
            });
            await fabric.onEvent(event(1, 'The broken test fails'));
            await fabric.tick();
            let state = (await fabric.snapshot(owner, agent)).state;
            const thread = Object.keys(state.threads)[0];
            assert.equal(state.threads[thread].evaluation.strength, 'inferred');
            const triggerId = Object.keys(state.triggers)[0];
            const assessment = {
                decision: 'accept', scope: 'Fix the broken test',
                direction: { implementation_requested: true, target_basis: 'specified', requires_design_decision: false, evidence: [{ trigger_id: triggerId, quote: 'broken test' }] },
                rule_assessments: [{ rule_id: 'fix', matched: true, reason: 'The message names a broken test' }],
            };
            const out = await fabric.command(owner, agent, 'decide', { evaluation: state.threads[thread].evaluation.id, decision: 'accept', assessment });
            assert.equal(out.decision.decision, 'ignore'); assert.equal(out.decision.would_accept, true);
            assert.equal(Object.keys((await fabric.snapshot(owner, agent)).state.tickets).length, 0);
            const records = await fabric.observe(owner, agent, {});
            assert.equal(records.length, 1);
            assert.equal(records[0].gate.strength, 'inferred'); assert.equal(records[0].would_accept, true);
            assert.deepEqual(records[0].rule_ids, ['fix']); assert.equal(records[0].estimate.basis, 'no data yet');
            const mirrored = await t.ctx.s.db.value('SELECT count(*)::int FROM actor_fabric_observe WHERE agent_id = $1', [agent]);
            assert.equal(mirrored, 1);
        });

        await check('lanes API: the panel gets each lane\'s mode, observe count and the six report states', async () => {
            const res = await t.get(`/api/v1/fabric/${agent}/lanes`, { as: alice });
            assert.equal(res.status, 200);
            const body = res.json();
            assert.equal(body.mode, 'observe'); assert.equal(body.lanes.length, 1);
            assert.equal(body.lanes[0].rule_id, 'fix'); assert.equal(body.lanes[0].mode, 'observe');
            assert.equal(body.lanes[0].observe.count, 1);
            assert.deepEqual(body.report_states.map(s => s.state), ['progress', 'waiting', 'ready', 'blocked', 'failed', 'dropped']);
            const obs = await t.get(`/api/v1/fabric/${agent}/observe?lane=fix&limit=10`, { as: alice });
            assert.equal(obs.status, 200); assert.equal(obs.json().records.length, 1);
            assert.equal(obs.json().records[0].decision, 'ignore');
        });

        await check('promote: the owner moves the lane to auto, and the next inferred work launches', async () => {
            const res = await t.get(`/api/v1/fabric/${agent}/commands/promote`, { as: alice, json: { lane: 'fix' }, headers: { Origin: 'https://openvibe.actor' } });
            assert.equal(res.status, 200); assert.equal(res.json().mode, 'auto');
            const lanes = (await t.get(`/api/v1/fabric/${agent}/lanes`, { as: alice })).json();
            assert.equal(lanes.mode, 'auto'); assert.equal(lanes.lanes[0].mode, 'auto');
            assert.match(lanes.lanes[0].last_change.reason, /promoted this lane/);
            await fabric.onEvent(event(2, 'The next broken test fails'));
            await fabric.tick();
            const state = (await fabric.snapshot(owner, agent)).state;
            const thread = Object.keys(state.threads).find((key) => state.threads[key].evaluation);
            const triggerId = state.threads[thread].evaluation.primary;
            const assessment = { decision: 'accept', scope: 'Fix the next broken test', direction: { implementation_requested: true, target_basis: 'specified', requires_design_decision: false, evidence: [{ trigger_id: triggerId, quote: 'broken test' }] }, rule_assessments: [{ rule_id: 'fix', matched: true, reason: 'Names a broken test' }] };
            const out = await fabric.command(owner, agent, 'decide', { evaluation: state.threads[thread].evaluation.id, decision: 'accept', assessment });
            assert.equal(out.decision.decision, 'accept'); assert.ok(out.ticket);
            first = out.ticket;
            const after = await fabric.observe(owner, agent, { lane: 'fix' });
            assert.equal(after[0].mode, 'auto'); assert.equal(after[0].decision, 'accept');
        });

        await check('spent budget: a report that uses the mandate budget demotes the lane with the number in words', async () => {
            const res = await t.get(`/api/v1/fabric/${agent}/commands/report`, { as: alice, json: { ticket_id: first.id, spent_usd: 1, report: { ticket_id: first.id, assignment_id: 'asg_1', state: 'progress', summary: 'Working', pr: null, tests_run: [], risks: [] } }, headers: { Origin: 'https://openvibe.actor' } });
            assert.equal(res.status, 200);
            const lanes = (await t.get(`/api/v1/fabric/${agent}/lanes`, { as: alice })).json();
            assert.equal(lanes.lanes[0].mode, 'observe');
            assert.match(lanes.lanes[0].demote_reason, /used its whole budget of \$1\.00/);
            assert.equal(lanes.lanes[0].report_counts.progress, 1);
            const changes = await t.ctx.s.db.many('SELECT * FROM actor_fabric_lane_changes WHERE agent_id = $1 ORDER BY seq', [agent]);
            assert.equal(changes.length, 2);
            assert.equal(changes.at(-1).actor, 'system');
        });

        await check('reports API and the six states: ticket reports are data, not prose', async () => {
            const body = (await t.get(`/api/v1/fabric/${agent}/reports`, { as: alice })).json();
            assert.equal(body.tickets.length, 1); assert.equal(body.tickets[0].reports[0].state, 'progress');
            assert.equal(body.report_states.length, 6);
            const states = (await t.get(`/api/v1/fabric/${agent}/report-states`, { as: alice })).json();
            assert.deepEqual(states.report_states.map(s => s.state), ['progress', 'waiting', 'ready', 'blocked', 'failed', 'dropped']);
            assert.equal((await t.get(`/api/v1/fabric/${agent}/commands/demote`, { as: alice, json: { lane: 'fix', reason: 'Reading a few more observe records first.' }, headers: { Origin: 'https://openvibe.actor' } })).status, 200);
        });

        await check('stored work API returns the durable mandate, evaluation, reports and run/artifact references', async () => {
            const res = await t.get(`/api/v1/fabric/${agent}/work`, { as: alice });
            assert.equal(res.status, 200);
            const body = res.json();
            assert.equal(body.tickets.length, 1);
            assert.equal(body.tickets[0].ticket_id, first.id);
            assert.equal(body.tickets[0].mandate.scope, first.mandate.scope);
            assert.equal(body.tickets[0].evaluation[0].decision, 'accept');
            assert.equal(body.tickets[0].reports[0].state, 'progress');
            assert.ok(Array.isArray(body.tickets[0].runs));
            assert.ok(Array.isArray(body.tickets[0].artifacts));
        });

        await check('owner-only: another signed-in person gets 404 from every new read', async () => {
            for (const path of ['lanes', 'observe', 'reports', 'work']) assert.equal((await t.get(`/api/v1/fabric/${agent}/${path}`, { as: bob })).status, 404);
        });
        await check('the owner can delete ended stored work and active tickets are protected', async () => {
            const active = await t.get(`/api/v1/fabric/${agent}/work/${first.id}`, { as: alice, method: 'DELETE', headers: { Origin: 'https://openvibe.actor' } });
            assert.equal(active.status, 409);
            await t.get(`/api/v1/fabric/${agent}/commands/end`, { as: alice, json: { ticket_id: first.id, reason: 'owner_finished' }, headers: { Origin: 'https://openvibe.actor' } });
            const deleted = await t.get(`/api/v1/fabric/${agent}/work/${first.id}`, { as: alice, method: 'DELETE', headers: { Origin: 'https://openvibe.actor' } });
            assert.equal(deleted.status, 200);
            assert.equal(deleted.json().deleted, true);
            assert.equal((await t.get(`/api/v1/fabric/${agent}/work`, { as: alice })).json().tickets.length, 0);
        });
    } finally { await t.close(); }
    done();
})().catch((err) => { console.error(err); process.exit(1); });

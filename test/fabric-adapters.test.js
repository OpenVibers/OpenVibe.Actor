'use strict';
/**
 * The fabric's executor and model adapters (S4, plan W2/W3), without a model or a network: the fabric's commands are
 * recorded, the model is a fixture, and the Actor runtime's task runner is a stand-in.
 */
const assert = require('node:assert/strict');
const { createFabricAdapters, reportFor } = require('../server/fabric/adapters');
const { Engine, initial } = require('../server/fabric/engine');
const { policy } = require('../server/fabric/policy');

const OWNER = 'user:usr_01JZ0000000000000000000AAA';
const AGENT = 'agt_01JZ0000000000000000000AAA';

function fakeFabric(state) {
    const commands = [];
    return {
        enabled: true,
        commands,
        async snapshot() { return { state }; },
        async command(owner, agent, name, args) { commands.push({ owner, agent, name, args }); return null; },
        async drain() { return false; },
    };
}
function fabricState({ ticket = null, source = { kind: 'chat', enabled: true, scopes: ['global'] } } = {}) {
    const e = new Engine(initial(), { now: 1000 });
    e.configure({ sources: { chat: { kind: 'chat', self: 'agent', enabled: true, scopes: ['global'], receive_all: ['global'] } }, policy: { mode: 'auto', rules: [{ id: 'fix', enabled: true, instruction: 'Fix requested defects' }], sources: { chat: { allowed: [], bots: [], admission: {} } } } });
    const trigger = { id: 'trigger_a', source: 'chat', actor: { source: 'chat', id: 'usr_person', kind: 'person' }, source_scope: 'global', threads: ['thread_a'], occurred_at: '2026-11-09T12:00:00.000Z', text: 'Fix the broken test', addresses_agent: 'mention', read_pointer: 'https://openvibe.chat/messages/1' };
    e.s.triggers[trigger.id] = trigger;
    e.s.sources.chat = source;
    if (ticket) { e.s.tickets[ticket.id] = ticket; e.s.meta[ticket.id] = { basis: 'addressed', owned: [], handbacks: [], read: [], reports: [], tasks: [] }; }
    return e.s;
}
const ticket = () => ({ id: 'ticket_1', trigger_id: 'trigger_a', mandate: { policy_version: 'v', scope: 'Fix the broken test', strength: 'explicit', matched_rules: [], actor: { source: 'chat', id: 'usr_person', kind: 'person' }, source_scope: 'global', budget: { usd: 1, tokens: 1000, wall_minutes: 10 } }, state: 'open', stage: 'working/queued', threads: ['thread_a'] });

let count = 0;
function test(name, fn) { return Promise.resolve(fn()).then(() => { count++; console.log(`ok ${name}`); }); }
(async () => {
    await test('route: an explicit human ask becomes one Ticket without a model call', async () => {
        const fabric = fakeFabric(fabricState());
        let called = 0;
        const a = createFabricAdapters({ s: {}, config: {}, fabric, models: { chat: async () => { called++; return { text: '{}' }; } }, runAgent: async () => null });
        await a.handlers(OWNER, AGENT).route({ evaluation: { id: 'eval_1', primary: 'trigger_a' }, triggers: [{ id: 'trigger_a', text: 'Fix the broken test' }] });
        assert.equal(called, 0);
        const decide = fabric.commands.find((c) => c.name === 'decide');
        assert.equal(decide.args.decision, 'accept'); assert.equal(decide.args.scope, 'Fix the broken test'); assert(!decide.args.assessment);
    });

    await test('assess: one cheap model call carries every enabled rule and the trigger text', async () => {
        const fabric = fakeFabric(fabricState());
        const seen = [];
        const assessment = { decision: 'accept', scope: 'Fix one test', direction: { implementation_requested: true, target_basis: 'specified', requires_design_decision: false, evidence: [{ trigger_id: 'trigger_a', quote: 'broken test' }] }, rule_assessments: [{ rule_id: 'fix', matched: true, reason: 'a defect is named' }] };
        const a = createFabricAdapters({ s: {}, config: {}, fabric, models: { chat: async (args) => { seen.push(args); return { text: '```json\n' + JSON.stringify(assessment) + '\n```' }; } }, runAgent: async () => null });
        await a.handlers(OWNER, AGENT).assess({ evaluation: { id: 'eval_1', primary: 'trigger_a' }, triggers: [{ id: 'trigger_a', actor: { kind: 'person' }, text: 'The broken test fails' }], policy: { rules: [{ id: 'fix', enabled: true, instruction: 'Fix defects' }, { id: 'off', enabled: false, instruction: 'Ignore me' }] } });
        assert.equal(seen.length, 1); assert.equal(seen[0].tier, 'check');
        const prompt = seen[0].messages.map((m) => m.content).join('\n');
        assert.match(prompt, /fix: Fix defects/); assert.doesNotMatch(prompt, /off: Ignore me/);
        const decide = fabric.commands.find((c) => c.name === 'decide');
        assert.equal(decide.args.assessment.decision, 'accept');
    });

    await test('assess: a model that cannot answer records unavailable and runs nothing', async () => {
        const fabric = fakeFabric(fabricState());
        const a = createFabricAdapters({ s: {}, config: {}, fabric, models: { chat: async () => ({ text: 'not json' }) }, runAgent: async () => null });
        await a.handlers(OWNER, AGENT).assess({ evaluation: { id: 'eval_1', primary: 'trigger_a' }, triggers: [{ id: 'trigger_a', actor: { kind: 'person' }, text: 'Fix it' }], policy: { rules: [{ id: 'fix', enabled: true, instruction: 'Fix defects' }] } });
        const decide = fabric.commands.find((c) => c.name === 'decide');
        assert.equal(decide.args.decision, 'unavailable'); assert.match(decide.args.reason, /nothing ran/);
    });

    await test('launch: the mandate is assigned to the owner\'s agent and the run is bound to the Ticket', async () => {
        const state = fabricState({ ticket: ticket() });
        const fabric = fakeFabric(state);
        const runs = [];
        const a = createFabricAdapters({ s: {}, config: {}, fabric, models: {}, agentFor: async () => ({ id: AGENT, owner: OWNER }), runAgent: async (ctx, agent, input, opts) => { runs.push({ agent, input, opts }); return { status: 201, task: { id: 'tsk_1' } }; } });
        await a.handlers(OWNER, AGENT).launch({ ticket: state.tickets.ticket_1 });
        assert.equal(runs.length, 1); assert.match(runs[0].input, /Fix the broken test/); assert.match(runs[0].input, /1 USD/);
        assert.equal(runs[0].opts.origin, 'person'); assert.equal(runs[0].opts.budgetUsd, 1);
        const bind = fabric.commands.find((c) => c.name === 'bind');
        assert.equal(bind.args.ticket_id, 'ticket_1'); assert.equal(bind.args.task_id, 'tsk_1');
    });

    await test('input: a context subscription is acknowledged without a run; a person\'s follow-up runs as a child', async () => {
        const state = fabricState({ ticket: ticket() }); state.meta.ticket_1.task_id = 'tsk_1';
        const fabric = fakeFabric(state);
        const runs = [];
        const a = createFabricAdapters({ s: {}, config: {}, fabric, models: {}, agentFor: async () => ({ id: AGENT }), runAgent: async (ctx, agent, input, opts) => { runs.push(opts); return { status: 201, task: { id: `tsk_${runs.length + 1}` } }; } });
        await a.handlers(OWNER, AGENT).input({ ticket_id: 'ticket_1', trigger: { id: 'trigger_a', actor: { kind: 'person' }, source: 'chat', source_scope: 'global', text: 'Follow up' }, context_only: true });
        assert.equal(runs.length, 0);
        await a.handlers(OWNER, AGENT).input({ ticket_id: 'ticket_1', trigger: { id: 'trigger_a', actor: { kind: 'person' }, source: 'chat', source_scope: 'global', text: 'Follow up' } });
        assert.equal(runs.length, 1); assert.equal(runs[0].parentId, 'tsk_1');
    });

    await test('reply: a Chat answer goes to the scope\'s room with the stable key', async () => {
        const state = fabricState({ ticket: ticket() });
        const fabric = fakeFabric(state);
        const posts = [];
        const a = createFabricAdapters({ s: {}, config: {}, fabric, models: {}, chat: { post: async (args) => { posts.push(args); return { ok: true }; } } });
        await a.handlers(OWNER, AGENT).reply({ ticket_id: 'ticket_1', source: 'chat', source_scope: 'global', key: 'reply:1', text: 'Done' });
        assert.deepEqual(posts[0], { key: 'reply:1', room: { type: 'global' }, text: 'Done' });
    });

    await test('task end: ready becomes an agent.report@1 on the Ticket, ends it and queues one reply', async () => {
        const state = fabricState({ ticket: ticket() }); state.meta.ticket_1.task_id = 'tsk_1';
        state.meta.ticket_1.owned = ['follow_1'];
        const fabric = fakeFabric(state);
        const s = { db: { maybe: async (sql) => sql.includes('actor_fabric_tasks')
            ? { agent_id: AGENT, owner: OWNER, ticket_id: 'ticket_1', trigger_ids: ['follow_1'] }
            : { state } } };
        const a = createFabricAdapters({ s, config: {}, fabric, models: {} });
        await a.onTaskState({ id: 'tsk_1', via: `agent:${AGENT}`, requester: OWNER, state: 'succeeded', assignment_id: 'asg_1', result: { answer: 'The test is fixed.' } });
        const report = fabric.commands.find((c) => c.name === 'report');
        assert.equal(report.args.report.state, 'ready'); assert.equal(report.args.report.summary, 'The test is fixed.'); assert.equal(report.args.end, true);
        assert.deepEqual(report.args.read_trigger_ids, ['follow_1']);
        const reply = fabric.commands.find((c) => c.name === 'reply');
        assert.match(reply.args.text, /The test is fixed/); assert.equal(reply.args.key, 'report:tsk_1');
    });

    await test('reportFor: failed and dropped are the executor\'s remaining report states', () => {
        assert.equal(reportFor({ id: 'tsk', state: 'failed', error_detail: 'the provider refused' }, { id: 'ticket' }).state, 'failed');
        assert.equal(reportFor({ id: 'tsk', state: 'cancelled' }, { id: 'ticket' }).state, 'dropped');
        assert.deepEqual(Object.keys(reportFor({ id: 'tsk', state: 'succeeded', result: 'ok' }, { id: 'ticket' })),
            ['ticket_id', 'assignment_id', 'state', 'summary', 'pr', 'tests_run', 'risks']);
    });

    await test('engine: bind keeps the last task; report sets the stage and a terminal report ends the Ticket', () => {
        const e = new Engine(initial(), { now: 1000 });
        e.configure({ sources: { chat: { kind: 'chat', self: 'agent', enabled: true, scopes: ['global'], receive_all: ['global'] } }, policy: { mode: 'auto', rules: [{ id: 'fix', enabled: true, instruction: 'Fix defects' }], sources: { chat: { allowed: ['alice'], bots: [], admission: {} } } } });
        const t = { id: 'a', source: 'chat', actor: { source: 'chat', id: 'alice', kind: 'person' }, source_scope: 'global', threads: ['global'], occurred_at: '2026-11-09T12:00:00.000Z', text: 'Fix it', addresses_agent: 'mention' };
        e.receive(t); const ev = e.start({ thread: 'global' }); const k = e.decide({ evaluation: ev.id, decision: 'accept', scope: 'Fix it' }).ticket;
        e.bind({ ticket_id: k.id, task_id: 'tsk_1' }); e.bind({ ticket_id: k.id, task_id: 'tsk_2' });
        assert.deepEqual(e.s.meta[k.id].tasks, ['tsk_1', 'tsk_2']); assert.equal(e.s.meta[k.id].task_id, 'tsk_2');
        const report = { ticket_id: k.id, assignment_id: 'asg_1', state: 'progress', summary: 'Working', pr: null, tests_run: [], risks: [] };
        e.report({ ticket_id: k.id, report }); assert.equal(k.stage, 'working');
        e.report({ ticket_id: k.id, report: { ...report, state: 'ready', summary: 'Done' }, end: true });
        assert.equal(k.state, 'ended'); assert.equal(k.stage, 'person/review'); assert.equal(e.s.meta[k.id].reports.length, 2);
        assert.throws(() => e.report({ ticket_id: k.id, report }), /ended/);
    });

    console.log(`${count} fabric adapter tests passed`);
})().catch((err) => { console.error(err); process.exit(1); });

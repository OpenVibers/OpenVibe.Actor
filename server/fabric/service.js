'use strict';
const contracts = require('openvibe-contracts');
const { Engine, initial } = require('./engine');
const sources = require('./sources');
const { assert } = require('./policy');
const COMMANDS = new Set(['configure', 'start', 'decide', 'subscribe', 'attach', 'unsubscribe', 'handBack', 'read', 'end', 'stop', 'reply', 'claim', 'settle', 'delivered', 'bind', 'report', 'promote', 'demote']);
const round = (n) => Math.round((Number(n) || 0) * 1e6) / 1e6;
// The first promotion review needs a little history; a single run is not a basis for an estimate.
const ESTIMATE_RUNS = 3;
function createFabric({ s, enabled = false, readMail, validate = (name, value) => {
    try { return contracts.assertValid(`${name}@1`, value); }
    catch (err) { if (err.code === 'contract.invalid') err.status = 422; throw err; }
} }) {
    const enabledCheck = () => { if (!enabled) throw Object.assign(new Error('Work fabric is disabled'), { status: 404 }); };

    /** The estimate port for a decide: Actor's own finished runs of this agent, or "no data yet". */
    async function estimator(owner, agent) {
        try {
            const rows = await s.db.many(`SELECT cost_usd FROM tasks WHERE requester = $1 AND via = $2 AND state = 'succeeded'
                AND finished_at IS NOT NULL ORDER BY finished_at DESC, id DESC LIMIT 20`, [owner, `agent:${agent}`]);
            const costs = rows.map(r => Number(r.cost_usd)).filter(v => Number.isFinite(v) && v > 0);
            if (costs.length < ESTIMATE_RUNS) return null;
            const sorted = [...costs].sort((a, b) => a - b);
            return () => ({ low_usd: round(sorted[0]), high_usd: round(sorted[sorted.length - 1]), basis: `the last ${sorted.length} finished runs of this agent` });
        } catch { return null; }
    }

    /** Observe records and lane changes are mirrored from the aggregate in the same transaction that commits it. */
    async function mirror(db, agent, owner, state) {
        const lastObserve = Number(await db.value('SELECT COALESCE(MAX(seq), 0) FROM actor_fabric_observe WHERE agent_id = $1', [agent])) || 0;
        for (const r of state.observe || []) {
            if (Number(r.seq) <= lastObserve) continue;
            await db.query(`INSERT INTO actor_fabric_observe (id, agent_id, owner, seq, thread, rule_ids, record, created_at)
                VALUES ($1,$2,$3,$4,$5,$6::text[],$7::jsonb,$8) ON CONFLICT (id) DO NOTHING`,
            [r.id, agent, owner, Number(r.seq), r.thread || null, r.rule_ids || [], JSON.stringify(r), r.at || s.iso()]);
        }
        const lastLane = Number(await db.value('SELECT COALESCE(MAX(seq), 0) FROM actor_fabric_lane_changes WHERE agent_id = $1', [agent])) || 0;
        for (const c of state.lane_changes || []) {
            if (Number(c.seq) <= lastLane) continue;
            await db.query(`INSERT INTO actor_fabric_lane_changes (id, agent_id, owner, seq, rule_id, from_mode, to_mode, reason, actor, created_at)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (id) DO NOTHING`,
            [c.id, agent, owner, Number(c.seq), c.rule_id, c.from_mode, c.to_mode, c.reason, c.actor || 'system', c.at || s.iso()]);
        }
    }

    async function transact(owner, agent, command, options = {}) {
        enabledCheck();
        return s.db.tx(async db => {
            // Authorization is inside the transaction and is repeated for every command, including leases.
            const exists = await db.maybe('SELECT id FROM actor_agents WHERE id = $1 AND owner = $2 FOR UPDATE', [agent, owner]);
            if (!exists) throw Object.assign(new Error('Agent not found'), { status: 404 });
            await db.query('INSERT INTO actor_work_fabric (agent_id, owner, state) VALUES ($1,$2,$3::jsonb) ON CONFLICT DO NOTHING', [agent, owner, JSON.stringify(initial())]);
            const row = await db.one('SELECT state FROM actor_work_fabric WHERE agent_id = $1 AND owner = $2 FOR UPDATE', [agent, owner]);
            const engine = new Engine(row.state, { now: s.now(), validate, estimate: options.estimate || null });
            const result = command(engine);
            assert(!result || typeof result.then !== 'function', 'Engine commands must be synchronous');
            await mirror(db, agent, owner, engine.s);
            await db.query('UPDATE actor_work_fabric SET state = $3::jsonb, revision = revision + 1, updated_at = $4 WHERE agent_id = $1 AND owner = $2', [agent, owner, JSON.stringify(engine.s), s.iso()]);
            return structuredClone(result ?? null);
        });
    }
    return {
        enabled,
        async deleteTicket(owner, agent, ticketId) {
            enabledCheck();
            return s.db.tx(async db => {
                const exists = await db.maybe('SELECT id FROM actor_agents WHERE id = $1 AND owner = $2 FOR UPDATE', [agent, owner]);
                if (!exists) throw Object.assign(new Error('Agent not found'), { status: 404 });
                const row = await db.maybe('SELECT state FROM actor_work_fabric WHERE agent_id = $1 AND owner = $2 FOR UPDATE', [agent, owner]);
                if (!row) throw Object.assign(new Error('Fabric not found'), { status: 404 });
                const state = typeof row.state === 'string' ? JSON.parse(row.state) : row.state;
                const ticket = state.tickets && state.tickets[ticketId];
                if (!ticket) throw Object.assign(new Error('Ticket not found'), { status: 404 });
                if (ticket.state !== 'ended') throw Object.assign(new Error('Only ended work can be deleted'), { status: 409 });
                const triggerIds = new Set([ticket.trigger_id]);
                const tasks = await db.many('SELECT task_id FROM actor_fabric_tasks WHERE owner = $1 AND agent_id = $2 AND ticket_id = $3', [owner, agent, ticketId]);
                for (const task of tasks) await db.query('DELETE FROM tasks WHERE id = $1 AND requester = $2', [task.task_id, owner]);
                delete state.tickets[ticketId]; delete state.meta[ticketId];
                state.work = (state.work || []).filter(w => w.conversation !== `worker:${ticketId}` && w.payload?.ticket_id !== ticketId);
                for (const thread of Object.values(state.threads || {})) {
                    delete thread.subscriptions?.[ticketId];
                    thread.pending = (thread.pending || []).filter(id => !triggerIds.has(id));
                    thread.triggers = (thread.triggers || []).filter(id => !triggerIds.has(id));
                    if (thread.evaluation) thread.evaluation.ids = (thread.evaluation.ids || []).filter(id => !triggerIds.has(id));
                }
                for (const id of triggerIds) {
                    const stillUsed = Object.values(state.tickets).some(t => t.trigger_id === id);
                    if (stillUsed) continue;
                    delete state.triggers[id]; delete state.accepted[id];
                    state.decisions = (state.decisions || []).filter(d => !(d.trigger_ids || []).includes(id));
                }
                const decisionIds = new Set((state.decisions || []).map(d => d.id));
                for (const thread of Object.values(state.threads || {})) thread.history = (thread.history || []).filter(id => decisionIds.has(id));
                await db.query('UPDATE actor_work_fabric SET state = $3::jsonb, revision = revision + 1, updated_at = $4 WHERE agent_id = $1 AND owner = $2', [agent, owner, JSON.stringify(state), s.iso()]);
                return { deleted: true, ticket_id: ticketId, tasks: tasks.length };
            });
        },
        async snapshot(owner, agent) {
            enabledCheck();
            const row = await s.db.maybe('SELECT f.state, f.revision FROM actor_work_fabric f JOIN actor_agents a ON a.id = f.agent_id WHERE f.agent_id = $1 AND f.owner = $2 AND a.owner = $2', [agent, owner]);
            if (!row) throw Object.assign(new Error('Fabric not found'), { status: 404 });
            return row;
        },
        async command(owner, agent, name, args = {}) {
            assert(COMMANDS.has(name) || ['schedule', 'cancelSchedule', 'tick'].includes(name), 'Unknown fabric command');
            const options = name === 'decide' ? { estimate: await estimator(owner, agent) } : {};
            return transact(owner, agent, engine => {
                if (name === 'schedule') return sources.schedule(engine, args);
                if (name === 'cancelSchedule') { assert(Object.hasOwn(engine.s.schedules, args.id), 'Unknown schedule'); engine.s.schedules[args.id].cancelled = true; return true; }
                if (name === 'tick') return sources.tick(engine);
                if (name === 'configure' && args.sources) {
                    args = structuredClone(args);
                    for (const [id, source] of Object.entries(args.sources)) {
                        source.owner_subject = owner.replace(/^user:/, '');
                        delete source.cursor; delete source.message_threads;
                        const old = engine.s.sources[id];
                        if (old?.kind === source.kind) { source.cursor = old.cursor; source.message_threads = old.message_threads; }
                    }
                }
                return engine[name](args);
            }, options);
        },
        /** Observe records newest first, optionally for one lane. */
        async observe(owner, agent, { lane = null, limit = 50 } = {}) {
            enabledCheck();
            assert(!lane || typeof lane === 'string', 'Invalid lane');
            assert(Number.isInteger(limit) && limit >= 1 && limit <= 200, 'Invalid observe limit');
            const row = await s.db.maybe('SELECT state, revision FROM actor_work_fabric WHERE agent_id = $1 AND owner = $2', [agent, owner]);
            if (!row) throw Object.assign(new Error('Fabric not found'), { status: 404 });
            const rows = lane
                ? await s.db.many('SELECT record FROM actor_fabric_observe WHERE agent_id = $1 AND owner = $2 AND $3 = ANY(rule_ids) ORDER BY seq DESC LIMIT $4', [agent, owner, lane, limit])
                : await s.db.many('SELECT record FROM actor_fabric_observe WHERE agent_id = $1 AND owner = $2 ORDER BY seq DESC LIMIT $3', [agent, owner, limit]);
            return rows.map(r => r.record);
        },
        /** Per-lane observe counts and the last change, for the panel's lane row. */
        async laneStats(owner, agent) {
            enabledCheck();
            const row = await s.db.maybe('SELECT state FROM actor_work_fabric WHERE agent_id = $1 AND owner = $2', [agent, owner]);
            if (!row) throw Object.assign(new Error('Fabric not found'), { status: 404 });
            const observe = await s.db.many(`SELECT rule_id, count(*)::int AS count, max(created_at) AS last_at
                FROM (SELECT unnest(rule_ids) AS rule_id, created_at FROM actor_fabric_observe WHERE agent_id = $1 AND owner = $2) r
                GROUP BY rule_id`, [agent, owner]);
            const changes = await s.db.many(`SELECT DISTINCT ON (rule_id) rule_id, from_mode, to_mode, reason, actor, created_at
                FROM actor_fabric_lane_changes WHERE agent_id = $1 AND owner = $2 ORDER BY rule_id, seq DESC`, [agent, owner]);
            return { state: row.state, observe, changes };
        },
        worker(owner, agent, ticket) {
            const allowed = new Set(['handBack', 'read', 'end', 'subscribe', 'unsubscribe', 'reply']);
            return {
                command: (name, args = {}) => {
                    assert(allowed.has(name), 'Command is not available to a worker');
                    // Worker ports cannot claim a human stop, change policy or create an authoritative binding.
                    const safe = { ...args, ticket_id: ticket, person: false };
                    if (name === 'subscribe') safe.kind = 'context';
                    return this.command(owner, agent, name, safe);
                },
            };
        },
        async onEvent(event) {
            if (!enabled || !sources.TOPICS.includes(event.event_type)) return [];
            const rows = await s.db.many('SELECT agent_id, owner, state FROM actor_work_fabric ORDER BY agent_id');
            const out = [];
            for (const row of rows) {
                let letter;
                if (event.event_type === 'mail.agent_inbox.received') {
                    const p = event.payload || {};
                    const matches = Object.values(row.state.sources).some(x => x.kind === 'mail' && x.enabled && x.owner_subject === p.owner && x.mail_agent === p.agent_id && x.scopes.includes(`inbox:${p.inbox_id}`));
                    if (!matches) continue;
                    assert(typeof readMail === 'function', 'Mail Source needs its authorized read port');
                    letter = await readMail({ person: p.owner, agentId: p.agent_id, messageId: p.message_id });
                    contracts.assertValid('mail.agent-inbox-message@1', letter);
                    if (letter.spam) { out.push({ status: 'filtered' }); continue; }
                }
                out.push(...await transact(row.owner, row.agent_id, e => sources.receiveEvent(e, event, letter)));
            }
            return out;
        },
        async tick() {
            if (!enabled) return;
            const rows = await s.db.many('SELECT agent_id, owner FROM actor_work_fabric ORDER BY agent_id');
            for (const row of rows) await transact(row.owner, row.agent_id, sources.tick);
        },
        // An injected adapter performs work only AFTER claim commits. Stable keys are required at the receiver:
        // transport is at-least-once, and a crash after send but before settle retries the same key.
        async drain(owner, agent, handlers) {
            const work = await this.command(owner, agent, 'claim', { kinds: Object.keys(handlers) });
            if (!work) return false;
            try {
                const ticket = work.payload.ticket?.id || work.payload.ticket_id;
                await handlers[work.kind](work.payload, { idempotency_key: work.key, ...(ticket ? { worker: this.worker(owner, agent, ticket) } : {}) });
                await this.command(owner, agent, 'settle', { id: work.id, claim: work.claim, ok: true });
            } catch {
                await this.command(owner, agent, 'settle', { id: work.id, claim: work.claim, ok: false });
            }
            return true;
        },
    };
}
module.exports = { createFabric };

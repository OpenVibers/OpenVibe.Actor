'use strict';
const contracts = require('openvibe-contracts');
const { Engine, initial } = require('./engine');
const sources = require('./sources');
const { assert } = require('./policy');
const COMMANDS = new Set(['configure', 'start', 'decide', 'subscribe', 'attach', 'unsubscribe', 'handBack', 'read', 'end', 'stop', 'reply', 'claim', 'settle', 'delivered']);
function createFabric({ s, enabled = false, readMail, validate = (name, value) => {
    try { return contracts.assertValid(`${name}@1`, value); }
    catch (err) { if (err.code === 'contract.invalid') err.status = 422; throw err; }
} }) {
    const enabledCheck = () => { if (!enabled) throw Object.assign(new Error('Work fabric is disabled'), { status: 404 }); };
    async function transact(owner, agent, command) {
        enabledCheck();
        return s.db.tx(async db => {
            // Authorization is inside the transaction and is repeated for every command, including leases.
            const exists = await db.maybe('SELECT id FROM actor_agents WHERE id = $1 AND owner = $2 FOR UPDATE', [agent, owner]);
            if (!exists) throw Object.assign(new Error('Agent not found'), { status: 404 });
            await db.query('INSERT INTO actor_work_fabric (agent_id, owner, state) VALUES ($1,$2,$3::jsonb) ON CONFLICT DO NOTHING', [agent, owner, JSON.stringify(initial())]);
            const row = await db.one('SELECT state FROM actor_work_fabric WHERE agent_id = $1 AND owner = $2 FOR UPDATE', [agent, owner]);
            const engine = new Engine(row.state, { now: s.now(), validate });
            const result = command(engine);
            assert(!result || typeof result.then !== 'function', 'Engine commands must be synchronous');
            await db.query('UPDATE actor_work_fabric SET state = $3::jsonb, revision = revision + 1, updated_at = $4 WHERE agent_id = $1 AND owner = $2', [agent, owner, JSON.stringify(engine.s), s.iso()]);
            return structuredClone(result ?? null);
        });
    }
    return {
        enabled,
        async snapshot(owner, agent) {
            enabledCheck();
            const row = await s.db.maybe('SELECT f.state, f.revision FROM actor_work_fabric f JOIN actor_agents a ON a.id = f.agent_id WHERE f.agent_id = $1 AND f.owner = $2 AND a.owner = $2', [agent, owner]);
            if (!row) throw Object.assign(new Error('Fabric not found'), { status: 404 });
            return row;
        },
        command(owner, agent, name, args = {}) {
            assert(COMMANDS.has(name) || ['schedule', 'cancelSchedule', 'tick'].includes(name), 'Unknown fabric command');
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
            });
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

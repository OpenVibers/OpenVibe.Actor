'use strict';
const { policy, gate, revalidate, assessment, assert, text } = require('./policy');
const copy = structuredClone;
const own = (map, key) => Object.hasOwn(map, key) ? map[key] : undefined;
const emptyDirection = () => ({ implementation_requested: false, target_basis: 'undetermined', requires_design_decision: false, evidence: [] });
// The six agent.report@1 states and the stage each one leaves on an open Ticket (agent.stage@1, first match).
const REPORT_STAGES = Object.freeze({ ready: 'person/review', blocked: 'person/blocked', failed: 'person/failed', waiting: 'idle', progress: 'working', dropped: 'idle' });
function initial() {
    return { policy: policy(), sources: {}, triggers: {}, threads: {}, tickets: {}, meta: {}, decisions: [], work: [], schedules: {}, accepted: {}, seq: 0 };
}
// All methods are synchronous. The repository loads and locks an agent's aggregate, invokes exactly one command,
// then commits its state and outbox together. No model, timer, promise or network port is reachable here.
class Engine {
    constructor(state, { now = Date.now(), validate = () => {} } = {}) { this.s = state; this.now = now; this.validate = validate; }
    id(kind) { return `${kind}_${++this.s.seq}`; }
    thread(key) { assert(text(key) && !['__proto__', 'constructor', 'prototype'].includes(key), 'Invalid Thread'); return this.s.threads[key] ||= { pending: [], subscriptions: {}, evaluation: null, history: [] }; }
    queue(t) {
        const th = this.thread(t.threads[0]);
        if (!this.owners(t.id).length && !th.pending.includes(t.id) && !th.evaluation?.ids.includes(t.id) && !Object.hasOwn(this.s.accepted, t.id)) th.pending.push(t.id);
    }
    owners(id) { return Object.entries(this.s.meta).filter(([, m]) => m.owned.includes(id)).map(([k]) => k); }
    enqueue(kind, key, payload, conversation = key) {
        const old = this.s.work.find(w => w.key === key);
        if (old) return old;
        const w = { id: this.id('work'), key, kind, payload: copy(payload), conversation, state: 'pending', attempts: 0, due: this.now };
        this.s.work.push(w); return w;
    }
    configure({ sources, policy: next }) {
        if (sources) {
            for (const [id, s] of Object.entries(sources)) {
                assert(/^[a-zA-Z0-9_-]{1,80}$/.test(id) && !['__proto__', 'constructor', 'prototype'].includes(id) && ['chat', 'mail', 'time'].includes(s.kind) && Array.isArray(s.scopes) && s.scopes.every(text) && Array.isArray(s.receive_all || []) && (s.receive_all || []).every(x => s.scopes.includes(x)), 'Invalid Source configuration');
                assert(text(s.self), 'Source needs its own bot identity');
                assert(typeof s.enabled === 'boolean', 'Source needs enabled flag');
            }
            this.s.sources = copy(sources);
        }
        if (!next) return this.s.policy;
        const old = this.s.policy, p = policy(next);
        if (old.version === p.version) return p;
        this.s.policy = p;
        for (const th of Object.values(this.s.threads)) if (th.evaluation) {
            const ids = th.evaluation.ids;
            this.finish(th, 'unavailable', { reason: 'policy_changed' });
            for (const id of ids) this.queue(this.s.triggers[id]);
        }
        for (const [id, k] of Object.entries(this.s.tickets)) {
            if (k.state !== 'open') continue;
            const m = k.mandate;
            if (old.mode !== p.mode || JSON.stringify(old.sources[m.actor.source]) !== JSON.stringify(p.sources[m.actor.source]) || m.matched_rules.some(r => JSON.stringify(old.rules.find(x => x.id === r)) !== JSON.stringify(p.rules.find(x => x.id === r)))) {
                this.enqueue('input', `policy:${id}:${p.version}`, { ticket_id: id, policy: p, previous_version: old.version }, `worker:${id}`);
            }
        }
        return p;
    }
    receive(t) {
        this.validate('agent.trigger', t);
        assert([t.id, ...t.threads].every(id => text(id) && !['__proto__', 'constructor', 'prototype'].includes(id)), 'Invalid event or thread id');
        assert(t.actor.source === t.source, 'Identity is Source-local');
        const source = this.s.sources[t.source];
        if (!source || !source.enabled || !source.scopes.includes(t.source_scope) || t.actor.id === source.self) return { status: 'filtered' };
        if (Object.hasOwn(this.s.triggers, t.id)) return { status: 'duplicate' };
        this.s.triggers[t.id] = copy(t);
        const reached = new Map();
        for (const key of t.threads) {
            const th = this.thread(key);
            th.last_trigger_id = t.id;
            th.triggers ||= []; th.triggers.push(t.id);
            th.triggers.sort((a, b) => Date.parse(this.s.triggers[a].occurred_at) - Date.parse(this.s.triggers[b].occurred_at) || a.localeCompare(b));
            for (const [id, sub] of Object.entries(th.subscriptions)) reached.set(id, (reached.get(id) || false) || sub !== 'context');
            // Correlation is recorded for reads only; it is never traversed by fan-out.
            th.correlated = [...new Set([...(th.correlated || []), ...t.threads.filter(x => x !== key)])];
        }
        for (const [id, own] of reached) {
            const k = this.s.tickets[id], m = this.s.meta[id];
            if (m.stopped || m.revoked) continue;
            if (k.state === 'ended') {
                if (t.actor.kind !== 'person' || !own) continue;
                if (!revalidate(k, m, this.s.triggers[k.trigger_id], this.s.policy, this.s.sources)) { m.revoked = true; continue; }
                k.state = 'open'; k.stage = 'working/queued';
                this.enqueue('launch', `resume:${id}:${t.id}`, { ticket: k, recovery: 'Check existing work before repeating any outside action.' }, `worker:${id}`);
            }
            if (t.actor.kind === 'person' && own) m.owned.push(t.id);
            this.enqueue('input', `input:${id}:${t.id}`, { ticket_id: id, trigger: t, context_only: !own }, `worker:${id}`);
        }
        this.queue(t);
        return { status: 'stored', owners: this.owners(t.id) };
    }
    start({ thread }) {
        const th = this.thread(thread);
        if (th.evaluation) return copy(th.evaluation);
        const ids = th.pending.filter(id => !this.owners(id).length && !Object.hasOwn(this.s.accepted, id));
        ids.sort((a, b) => Date.parse(this.s.triggers[a].occurred_at) - Date.parse(this.s.triggers[b].occurred_at) || a.localeCompare(b));
        if (!ids.length) { th.pending = []; return null; }
        const candidates = ids.map(id => {
            const t = this.s.triggers[id];
            const follow = Object.values(this.s.tickets).some(k => k.threads.includes(thread) && this.thread(thread).subscriptions[k.id] !== 'context');
            return { id, result: gate(t, this.s.policy, this.s.sources[t.source], follow) };
        }).filter(x => x.result);
        candidates.sort((a, b) => Number(b.result.strength === 'explicit') - Number(a.result.strength === 'explicit'));
        const best = candidates[0];
        th.pending = [];
        th.evaluation = { id: this.id('eval'), ids, primary: best?.id || ids[0], strength: best?.result.strength || 'inferred', basis: best?.result.basis, policy_version: this.s.policy.version, attempts: th.expiries || 0 };
        if (!best) { this.finish(th, 'ignore', { reason: 'not_admitted' }); return null; }
        const e = copy(th.evaluation);
        // Explicit candidates go to the deterministic routing port, never the assessor.
        this.enqueue(e.strength === 'explicit' ? 'route' : 'assess', `candidate:${e.id}`, { evaluation: e, triggers: ids.map(id => this.s.triggers[id]), tickets: Object.values(this.s.tickets).filter(k => k.threads.includes(thread)), policy: this.s.policy, handbacks: Object.values(this.s.meta).flatMap(m => m.handbacks).filter(h => ids.includes(h.trigger_id)) }, `router:${thread}`);
        return e;
    }
    finish(th, decision, extra = {}) {
        const e = th.evaluation;
        const d = { id: this.id('decision'), trigger_ids: e.ids, policy_version: e.policy_version, decision, strength: e.strength, direction: emptyDirection(), rule_assessments: [], ...extra };
        this.validate('agent.decision', d);
        this.s.decisions.push(d); th.history.push(d.id); th.evaluation = null;
        for (const w of this.s.work) if (w.key === `candidate:${e.id}` && w.state !== 'done') { w.state = 'dropped'; w.reason = 'evaluation_finished'; w.finished_at = this.now; }
        return d;
    }
    decide({ evaluation, decision, scope, assessment: a, reason, ignored_from_card = false }) {
        const th = Object.values(this.s.threads).find(t => t.evaluation?.id === evaluation);
        assert(th, 'Evaluation is no longer current');
        const e = th.evaluation;
        assert(e.policy_version === this.s.policy.version, 'Policy changed');
        assert(['accept', 'ignore', 'unavailable'].includes(decision), 'Invalid routing decision');
        let matched = [], audit = { reason: reason || decision };
        if (e.strength === 'inferred' && !ignored_from_card && decision !== 'unavailable') {
            const result = assessment(a || {}, this.s.policy, e.ids.map(id => this.s.triggers[id]));
            matched = result.matched;
            decision = a.decision === 'unavailable' ? 'unavailable' : result.accepted ? 'accept' : 'ignore';
            scope = a.scope;
            audit = { ...audit, direction: a.direction, rule_assessments: a.rule_assessments };
        } else if (ignored_from_card) {
            assert(e.strength === 'inferred' && decision === 'ignore' && text(reason), 'Card shortcut only ignores inferred work with a reason');
            audit.ignored_from_card = true;
        } else assert(!a, 'Explicit candidates do not use assessment');
        if (decision === 'accept' && e.strength === 'inferred' && this.s.policy.mode !== 'auto') { decision = 'ignore'; audit.would_accept = true; }
        let ticket;
        if (decision === 'accept') {
            assert(text(scope), 'Acceptance needs a scope');
            assert(!e.ids.some(id => this.owners(id).length), 'Worker owns follow-up');
            const t = this.s.triggers[e.primary];
            ticket = { id: this.id('ticket'), trigger_id: t.id, mandate: { policy_version: e.policy_version, scope, strength: e.strength, matched_rules: matched, actor: copy(t.actor), source_scope: t.source_scope, budget: copy(this.s.policy.budget) }, state: 'open', stage: 'working/queued', threads: [...t.threads] };
            this.validate('agent.ticket', ticket);
            this.s.tickets[ticket.id] = ticket;
            for (const id of e.ids) this.s.accepted[id] = ticket.id;
            this.s.meta[ticket.id] = { basis: e.basis, owned: [], handbacks: [], read: [], reports: [], tasks: [] };
            for (const key of t.threads) this.thread(key).subscriptions[ticket.id] = 'origin';
            this.enqueue('launch', `launch:${ticket.id}`, { ticket, triggers: e.ids.map(id => this.s.triggers[id]) }, `worker:${ticket.id}`);
        }
        th.expiries = 0;
        return { decision: this.finish(th, decision, audit), ...(ticket ? { ticket } : {}) };
    }
    /** An executor port bound the Ticket to the task that runs it (the last run of a follow-up is the current one). */
    bind({ ticket_id, task_id }) {
        const k = own(this.s.tickets, ticket_id), m = own(this.s.meta, ticket_id);
        assert(k && m && text(task_id), 'Unknown Ticket or task');
        m.task_id = task_id;
        m.tasks ||= [];
        if (!m.tasks.includes(task_id)) m.tasks.push(task_id);
        return k;
    }
    /** Record one agent.report@1 on the Ticket; a terminal report may end it. */
    report({ ticket_id, report, end = false }) {
        const k = own(this.s.tickets, ticket_id), m = own(this.s.meta, ticket_id);
        assert(k && m && report && typeof report === 'object' && !Array.isArray(report), 'Report needs an open Ticket');
        assert(k.state === 'open', 'Ticket has ended');
        const r = copy({ ...report, ticket_id });
        this.validate('agent.report', r);
        m.reports ||= [];
        m.reports.push(r);
        if (REPORT_STAGES[r.state]) k.stage = REPORT_STAGES[r.state];
        if (end) this.end({ ticket_id, reason: `report:${r.state}` });
        return { ticket: k, report: r };
    }
    subscribe({ ticket_id, thread, kind = 'context' }) {
        const k = own(this.s.tickets, ticket_id);
        assert(k && k.state === 'open', 'Ticket must be open');
        assert(['context', 'attached', 'source'].includes(kind), 'Invalid subscription');
        // Attaching is an explicit router command; callers must supply the pointing trigger through attach().
        assert(kind !== 'attached', 'Use attach with an explicit ticket reference');
        this.thread(thread).subscriptions[ticket_id] ||= kind;
        if (!k.threads.includes(thread)) k.threads.push(thread);
        return k;
    }
    attach({ ticket_id, trigger_id }) {
        const k = own(this.s.tickets, ticket_id), t = own(this.s.triggers, trigger_id), m = own(this.s.meta, ticket_id);
        assert(k && t && t.actor.kind === 'person' && t.text.includes(ticket_id), 'Message must explicitly point at the Ticket');
        assert(!m.stopped && !m.revoked && !m.handbacks.some(h => h.trigger_id === trigger_id) && !this.owners(trigger_id).length, 'Message cannot be attached');
        assert(k.state === 'open' || revalidate(k, m, this.s.triggers[k.trigger_id], this.s.policy, this.s.sources), 'Mandate no longer holds');
        for (const key of t.threads) { this.thread(key).subscriptions[ticket_id] = 'attached'; if (!k.threads.includes(key)) k.threads.push(key); }
        if (k.state === 'ended') { k.state = 'open'; this.enqueue('launch', `resume:${ticket_id}:${trigger_id}`, { ticket: k }, `worker:${ticket_id}`); }
        m.owned.push(trigger_id);
        for (const th of Object.values(this.s.threads)) {
            th.pending = th.pending.filter(id => id !== trigger_id);
            if (th.evaluation?.ids.includes(trigger_id)) {
                const rest = th.evaluation.ids.filter(id => id !== trigger_id);
                this.finish(th, 'ignore', { reason: 'attached' });
                rest.forEach(id => this.queue(this.s.triggers[id]));
            }
        }
        this.enqueue('input', `attach:${ticket_id}:${trigger_id}`, { ticket_id, trigger: t }, `worker:${ticket_id}`);
        return k;
    }
    unsubscribe({ ticket_id, thread, person = false }) {
        const th = this.thread(thread), kind = th.subscriptions[ticket_id];
        if (person && !ticket_id) { th.subscriptions = {}; return true; }
        assert(person || !['origin', 'source'].includes(kind), 'Worker cannot drop origin or source subscription');
        delete th.subscriptions[ticket_id];
        // Ownership survives removal. Thread membership remains historical for audit.
        return true;
    }
    handBack({ ticket_id, trigger_id, reason }) {
        const m = own(this.s.meta, ticket_id);
        assert(m && text(reason), 'Hand-back needs a Ticket and reason');
        if (m.handbacks.some(h => h.trigger_id === trigger_id) || !m.owned.includes(trigger_id)) return false;
        m.handbacks.push({ ticket_id, trigger_id, reason, at: this.now });
        m.owned = m.owned.filter(id => id !== trigger_id);
        this.queue(own(this.s.triggers, trigger_id));
        return true;
    }
    read({ ticket_id, trigger_ids }) {
        const m = own(this.s.meta, ticket_id); assert(m, 'Unknown Ticket');
        assert(Array.isArray(trigger_ids), 'Read needs trigger ids');
        // Worker calls this after a report/turn end, not merely after transport delivery.
        for (const id of trigger_ids) { assert(m.owned.includes(id), 'Worker did not own input'); if (!m.read.includes(id)) m.read.push(id); }
        return true;
    }
    end({ ticket_id, reason = 'completed', person = false }) {
        const k = own(this.s.tickets, ticket_id), m = own(this.s.meta, ticket_id);
        assert(k, 'Unknown Ticket'); k.state = 'ended'; m.ended_reason = reason;
        if (person) m.stopped = true;
        const unread = m.owned.filter(id => !m.read.includes(id)); m.owned = [];
        for (const id of unread) this.queue(this.s.triggers[id]);
        for (const w of this.s.work) if (w.conversation === `worker:${ticket_id}` && !['done', 'dropped'].includes(w.state)) { w.state = 'dropped'; w.reason = 'ticket_ended'; w.finished_at = this.now; }
        this.enqueue('end', `end:${ticket_id}:${this.s.seq}`, { ticket_id, reason }, `worker:${ticket_id}`);
        return k;
    }
    stop({ ticket_id, trigger_id, reason }) {
        const t = own(this.s.triggers, trigger_id), k = own(this.s.tickets, ticket_id);
        assert(t && k && t.threads.some(key => k.threads.includes(key)), 'Stop needs a message on the Ticket');
        const g = gate(t, this.s.policy, this.s.sources[t.source], true);
        assert(t.actor.kind === 'person' && g?.strength === 'explicit', 'Only explicit human stop withdraws a Mandate');
        const m = own(this.s.meta, ticket_id); m.read.push(trigger_id);
        this.end({ ticket_id, reason, person: true });
        for (const th of Object.values(this.s.threads)) th.pending = th.pending.filter(id => id !== trigger_id);
        const d = { id: this.id('decision'), trigger_ids: [trigger_id], policy_version: this.s.policy.version, decision: 'stop', strength: 'explicit', direction: emptyDirection(), rule_assessments: [], reason: reason || 'person_stop' };
        this.validate('agent.decision', d); this.s.decisions.push(d); return k;
    }
    delivered({ evaluation }) {
        const e = Object.values(this.s.threads).find(t => t.evaluation?.id === evaluation)?.evaluation;
        if (e && !e.deadline) e.deadline = this.now + 300000;
    }
    expire() {
        for (const th of Object.values(this.s.threads)) if (th.evaluation?.deadline <= this.now) {
            const ids = th.evaluation.ids;
            th.expiries = (th.expiries || 0) + 1;
            if (th.expiries <= 2) {
                const evalId = th.evaluation.id; th.evaluation = null;
                for (const w of this.s.work) if (w.key === `candidate:${evalId}` && w.state !== 'done') { w.state = 'dropped'; w.reason = 'assessment_timeout_retry'; w.finished_at = this.now; }
                ids.forEach(id => this.queue(this.s.triggers[id]));
            } else this.finish(th, 'unavailable', { reason: 'assessment_timeout' });
        }
    }
    reply({ ticket_id, conversation, key, text: body, source }) {
        assert(own(this.s.tickets, ticket_id) && this.s.sources[source] && text(body) && text(conversation) && text(key), 'Invalid reply');
        return this.enqueue('reply', `reply:${ticket_id}:${key}`, { ticket_id, text: body, source, source_scope: conversation }, `reply:${ticket_id}:${conversation}`);
    }
    claim({ kinds, lease_ms = 30000 }) {
        assert(Array.isArray(kinds) && Number.isFinite(lease_ms) && lease_ms >= 1000 && lease_ms <= 300000, 'Invalid work claim');
        const pending = this.s.work.filter(w => !['done', 'dropped'].includes(w.state));
        for (const w of pending) {
            if (!kinds.includes(w.kind) || w.due > this.now || (w.state === 'running' && w.lease_until > this.now)) continue;
            if (pending.some(earlier => earlier.conversation === w.conversation && this.s.work.indexOf(earlier) < this.s.work.indexOf(w))) continue;
            if (w.kind === 'reply') {
                const source = this.s.sources[w.payload.source];
                if (!source || !source.scopes.includes(w.payload.source_scope)) { w.state = 'dropped'; w.reason = 'source_no_longer_listens'; w.finished_at = this.now; continue; }
                if (!source.enabled) continue;
            }
            w.state = 'running'; w.claim = this.id('claim'); w.lease_until = this.now + lease_ms;
            return copy(w);
        }
        return null;
    }
    settle({ id, claim, ok, permanent_reason }) {
        const w = this.s.work.find(x => x.id === id);
        assert(w && w.claim === claim, 'Stale work claim');
        if (w.state === 'dropped') return w;
        assert(w.state === 'running', 'Stale work claim');
        if (ok) {
            w.state = 'done'; w.finished_at = this.now; delete w.last_error;
            if (w.kind === 'input') {
                const k = this.s.tickets[w.payload.ticket_id];
                if (k?.state === 'open' && k.stage === 'person/delivery') k.stage = 'working';
            }
            if (w.kind === 'launch') {
                const k = this.s.tickets[w.payload.ticket.id];
                if (k?.state === 'open') k.stage = 'working';
            }
            if (['route', 'assess'].includes(w.kind)) this.delivered({ evaluation: w.payload.evaluation.id });
        } else if (permanent_reason) {
            assert(w.kind === 'reply' && ['source_no_longer_listens', 'destination_cannot_receive'].includes(permanent_reason), 'Invalid permanent drop');
            w.state = 'dropped'; w.reason = permanent_reason; w.finished_at = this.now;
        } else {
            w.attempts++; w.state = 'pending'; w.last_error = 'delivery_failed';
            if (w.kind === 'input') {
                const k = this.s.tickets[w.payload.ticket_id];
                if (k?.state === 'open') k.stage = 'person/delivery';
            }
            w.due = this.now + Math.min(w.kind === 'reply' ? 300000 : 60000, (w.kind === 'reply' ? 5000 : 2000) * 2 ** Math.min(w.attempts - 1, 20));
        }
        return w;
    }
}
module.exports = { Engine, initial, REPORT_STAGES };

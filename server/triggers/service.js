'use strict';
/**
 * Triggers made in a conversation (plan §12 A-4). The subscription is a Watch the person owns; this
 * module keeps the card's record, turns runs back into assignment roots and owns the person's four
 * moves (edit, pause, resume, undo/delete) and Run now.
 *
 * A routine is one Watch watch, created with the person's own token: paused, given its cron (or
 * event source), then resumed, so it never fires between the calls. The Watch action is actor-agent:
 * Watch wakes the agent, Actor makes the run origin 'routine' at the trigger's stored level, and the
 * assignment tree caps it there. Money, passwords, deletions and new recipients still go through the
 * always-ask floor inside the run.
 *
 * Five failed runs in a row pause the trigger here; Watch's own five failed checks pause the watch
 * (server/check.js) and are mirrored onto the card when it is next read.
 */
const cron = require('./cron');
const store = require('./store');
const watchClient = require('./watch');
const parse = require('./parse');
const contacts = require('../agents/contacts');
const levels = require('../agents/levels');
const personal = require('../agents/personal');

const ID = /^trg_[0-9A-HJKMNP-TV-Z]{26}$/;
const WATCH_ID = /^wch_[0-9A-HJKMNP-TV-Z]{26}$/;
const TASK_ID = /^tsk_[0-9A-HJKMNP-TV-Z]{26}$/;
const EVENT_PATTERN = /^[a-z][a-z0-9_-]*(\.[a-z0-9_*]+){1,}$/;
const MAX_ACTIVE = 20;
const UNDO_MS = 10 * 60_000;
const MAX_TASK = 8000;

const iso = (ms) => (ms == null ? null : new Date(Number(ms)).toISOString());
const clip = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const problem = (status, code, detail) => ({ status, code, detail });

function createTriggers({ s, config, engine = null, webhooks = null, stream = null, watch = null, fetchImpl = globalThis.fetch, now = () => Date.now(), log = console }) {
    const client = watch || watchClient.createWatchClient({ config, fetchImpl });
    const nowMs = () => (typeof s.now === 'function' ? s.now() : now());

    const requesterOf = (owner) => (String(owner || '').startsWith('user:') ? String(owner) : `user:${owner}`);
    const subjectOf = (owner) => String(owner || '').replace(/^user:/, '');
    async function agentOf(owner, id) {
        if (!id || !/^agt_[0-9A-HJKMNP-TV-Z]{26}$/.test(String(id))) return null;
        return await contacts.get(s, requesterOf(owner), id);
    }

    /** The card (actor.trigger@1), from the trigger's own row and, when it can be read, Watch's health. */
    async function card(row, { token = null, live = false } = {}) {
        if (!row) return null;
        const agent = await agentOf(row.owner, row.agent_id).catch(() => null);
        let next = null;
        if (row.state === 'active' && row.kind === 'schedule' && row.schedule && row.schedule.cron) {
            try { const at = cron.next(row.schedule.cron, row.schedule.timezone || row.timezone || 'UTC', nowMs()); if (at) next = iso(at); } catch { /* no next */ }
        }
        const out = {
            id: row.id,
            owner: row.owner,
            agent_id: row.agent_id,
            agent_name: agent ? agent.name : null,
            task: row.task,
            kind: row.kind,
            when: {
                words: row.words,
                cron: row.kind === 'schedule' && row.schedule ? row.schedule.cron : null,
                timezone: row.kind === 'schedule' ? (row.timezone || (row.schedule && row.schedule.timezone) || null) : null,
                event: row.kind === 'event' && row.event ? { pattern: row.event.pattern, filter: row.event.filter || null } : null,
            },
            next_run_at: next,
            last_run: row.last_task_id && row.last_state && row.last_run_at
                ? { task_id: row.last_task_id, state: row.last_state, at: iso(row.last_run_at) }
                : null,
            state: row.state === 'paused' ? 'paused' : 'active',
            paused_reason: row.paused_reason || null,
            failures: Number(row.failures) || 0,
            watch: row.watch_id ? { id: row.watch_id, status: 'active' } : null,
            undo_until: iso(Number(row.created_at) + UNDO_MS),
            created_at: iso(row.created_at),
            updated_at: iso(row.updated_at),
        };
        if (live && token && row.watch_id && WATCH_ID.test(row.watch_id)) {
            const got = await client.get(token, row.watch_id).catch(() => null);
            if (got && got.ok && got.watch) {
                const health = got.watch.health || {};
                out.watch = {
                    id: row.watch_id,
                    status: got.watch.status,
                    last_state: health.last_state || null,
                    consecutive_failures: Number(health.consecutive_failures) || 0,
                    next_due_at: health.next_due_at || null,
                };
                if (out.state === 'active' && got.watch.status !== 'active' && Number(health.consecutive_failures) >= 5) {
                    const paused = await store.update(s, row.owner, row.id, { state: 'paused', paused_reason: 'failed', updated_at: nowMs() });
                    out.state = 'paused';
                    out.paused_reason = 'failed';
                    out.updated_at = iso(paused.updated_at);
                }
            }
        }
        return out;
    }

    async function emit(row, text) {
        if (!row || !row.turn_task_id || !TASK_ID.test(String(row.turn_task_id))) return;
        try {
            const cardNow = await card(row);
            const event = { at: new Date(nowMs()).toISOString(), kind: 'output', step: 'trigger', agent: 'openvibe-runtime', text: clip(text, 500), trigger: cardNow };
            const saved = await require('../tasks/store').appendEvent(s, row.turn_task_id, event);
            if (stream && typeof stream.publish === 'function') stream.publish(row.turn_task_id, saved);
        } catch (err) {
            log.warn && log.warn('[Actor] trigger card:', row.id, (err && err.message) || err);
        }
    }

    function validate({ owner, agentId, task, kind, cronExpr, timezone, event }) {
        if (!/^usr_[0-9A-HJKMNP-TV-Z]{26}$/.test(String(owner || ''))) return problem(401, 'actor.trigger.sign_in', 'Sign in to make a trigger.');
        if (!agentId) return problem(422, 'actor.trigger.agent', 'Choose which of your agents should run it.');
        if (typeof task !== 'string' || !task.trim() || task.length > MAX_TASK) return problem(422, 'actor.trigger.task', 'Say what the agent should do each time, in a sentence.');
        if (!['schedule', 'event'].includes(kind)) return problem(422, 'actor.trigger.kind', 'A trigger is a schedule or a Watch event.');
        if (kind === 'schedule') {
            if (!timezone || !cron.isZone(timezone)) return problem(422, 'actor.trigger.timezone', `Unknown time zone "${timezone}". Say the city or the IANA name.`);
            const verdict = cron.validate(cronExpr, timezone);
            if (!verdict.valid) return problem(422, 'actor.trigger.schedule', verdict.error);
        }
        if (kind === 'event') {
            if (!event || !EVENT_PATTERN.test(String(event.pattern || ''))) return problem(422, 'actor.trigger.event', 'An event source is an Events topic pattern such as github.issue.opened.');
            if (event.filter != null && (typeof event.filter !== 'object' || Array.isArray(event.filter))) return problem(422, 'actor.trigger.event', 'event.filter must be an object of field values.');
        }
        return null;
    }

    async function create({ owner, agentId, task, kind, cron: cronExpr = null, timezone = null, event = null, level = null, turnTaskId = null, personToken = null, announce = true }) {
        const bad = validate({ owner, agentId, task, kind, cronExpr, timezone, event });
        if (bad) return { error: bad };
        const agent = await agentOf(owner, agentId);
        if (!agent) return { error: problem(422, 'actor.agent.not_found', 'agent_id names one of your own agents (GET /api/v1/agents).') };
        if (!client.enabled) return { error: problem(503, 'actor.trigger.watch_unavailable', 'OpenVibe.Watch is not configured on this Actor, so it cannot run a trigger.') };
        if (!personToken) return { error: problem(401, 'actor.trigger.sign_in', 'Sign in again: creating a trigger needs your own OpenVibe session, not a service token.') };
        const active = await store.countActive(s, owner);
        if (active >= MAX_ACTIVE) return { error: problem(409, 'actor.trigger.limit', `You already have ${MAX_ACTIVE} active triggers. Pause one, or delete one, before making another.`) };
        const at = nowMs();
        const row = await store.insert(s, {
            id: s.newId('trg'), owner, agent_id: agent.id, task: String(task).trim(), kind,
            schedule: kind === 'schedule' ? { cron: cronExpr, timezone } : null,
            event: kind === 'event' ? { pattern: event.pattern, filter: event.filter || null } : null,
            timezone: kind === 'schedule' ? timezone : null,
            words: kind === 'schedule' ? parse.wordsFor(cronExpr, timezone) : (event.words || `When ${event.pattern}`),
            level: levels.LEVELS.includes(level) ? level : 'ask',
            state: 'paused', turn_task_id: turnTaskId, created_at: at,
        });
        let made = null;
        try {
            const body = {
                name: `Actor trigger: ${clip(String(task).split('\n')[0], 80)}`,
                status: 'paused',
                source: kind === 'event' ? { kind: 'event', pattern: event.pattern, filter: event.filter || null } : { kind: 'webhook' },
                cadence: null,
                extraction: { kind: 'text' },
                condition: { op: 'exists' },
                action: [{ kind: 'actor-agent', agent_id: agent.id, note: String(task).slice(0, 2000) }],
                labels: { actor_trigger: row.id },
            };
            const created = await client.create(personToken, body);
            if (!created.ok) throw created;
            made = created.watch;
            if (kind === 'schedule') {
                const scheduled = await client.setSchedule(personToken, made.id, cronExpr, timezone);
                if (!scheduled.ok) throw scheduled;
            }
            const linked = await store.update(s, owner, row.id, { watch_id: made.id, updated_at: nowMs() });
            const resumed = await client.resume(personToken, made.id);
            if (!resumed.ok) throw resumed;
            const activeRow = await store.update(s, owner, row.id, { state: 'active', paused_reason: null, updated_at: nowMs() });
            const cardNow = await card(activeRow);
            if (announce) await emit(linked, `Trigger created: ${cardNow.when.words}.`);
            return { trigger: cardNow, row: activeRow };
        } catch (err) {
            if (made && made.id) await client.remove(personToken, made.id).catch(() => null);
            await store.remove(s, owner, row.id).catch(() => null);
            const why = err && err.code ? err : problem(502, 'actor.trigger.watch_failed', `OpenVibe.Watch could not save the subscription: ${(err && (err.detail || err.message)) || 'unknown error'}`);
            return { error: why.status ? why : problem(502, why.code || 'actor.trigger.watch_failed', why.detail || 'OpenVibe.Watch could not save the subscription.') };
        }
    }

    async function get(owner, id, { token = null, live = false } = {}) {
        if (!ID.test(String(id || ''))) return null;
        const row = await store.get(s, owner, id);
        if (!row) return null;
        return await card(row, { token, live });
    }

    async function list(owner) {
        const rows = await store.list(s, owner);
        return await Promise.all(rows.map((row) => card(row)));
    }

    async function edit(owner, id, patch = {}, { token = null } = {}) {
        const row = ID.test(String(id || '')) ? await store.get(s, owner, id) : null;
        if (!row) return { error: problem(404, 'actor.trigger.not_found', 'No such trigger.') };
        if (!token) return { error: problem(401, 'actor.trigger.sign_in', 'Sign in again: changing a trigger uses your own OpenVibe session.') };
        const next = {
            agent_id: patch.agent_id !== undefined ? patch.agent_id : row.agent_id,
            task: patch.task !== undefined ? String(patch.task).trim() : row.task,
            kind: patch.kind !== undefined ? patch.kind : row.kind,
            cron: patch.cron !== undefined ? patch.cron : (row.schedule && row.schedule.cron),
            timezone: patch.timezone !== undefined ? patch.timezone : (row.timezone || (row.schedule && row.schedule.timezone) || 'UTC'),
            event: patch.event !== undefined ? patch.event : row.event,
            level: row.level,
        };
        const bad = validate({ owner, agentId: next.agent_id, task: next.task, kind: next.kind, cronExpr: next.cron, timezone: next.timezone, event: next.event });
        if (bad) return { error: bad };
        const agent = await agentOf(owner, next.agent_id);
        if (!agent) return { error: problem(422, 'actor.agent.not_found', 'agent_id names one of your own agents.') };
        if (!row.watch_id) return { error: problem(409, 'actor.trigger.no_watch', 'This trigger has no subscription to edit.') };
        const changes = {};
        if (next.task !== row.task || next.agent_id !== row.agent_id) {
            changes.action = [{ kind: 'actor-agent', agent_id: next.agent_id, note: next.task.slice(0, 2000) }];
            changes.name = `Actor trigger: ${clip(next.task.split('\n')[0], 80)}`;
        }
        if (next.kind === 'event' && (patch.event !== undefined || patch.kind !== undefined)) changes.source = { kind: 'event', pattern: next.event.pattern, filter: next.event.filter || null };
        if (Object.keys(changes).length) {
            const patched = await client.patch(token, row.watch_id, changes);
            if (!patched.ok) return { error: problem(patched.status || 502, patched.code || 'actor.trigger.watch_failed', patched.detail || 'OpenVibe.Watch refused the change.') };
        }
        if (next.kind === 'schedule' && (patch.cron !== undefined || patch.timezone !== undefined || patch.kind !== undefined)) {
            const scheduled = await client.setSchedule(token, row.watch_id, next.cron, next.timezone);
            if (!scheduled.ok) return { error: problem(scheduled.status || 502, scheduled.code || 'actor.trigger.watch_failed', scheduled.detail || 'OpenVibe.Watch refused the schedule.') };
        }
        const updated = await store.update(s, owner, row.id, {
            task: next.task, agent_id: next.agent_id, kind: next.kind,
            schedule: next.kind === 'schedule' ? { cron: next.cron, timezone: next.timezone } : row.schedule,
            event: next.kind === 'event' ? { pattern: next.event.pattern, filter: next.event.filter || null } : row.event,
            timezone: next.kind === 'schedule' ? next.timezone : null,
            words: next.kind === 'schedule' ? parse.wordsFor(next.cron, next.timezone) : (next.event.words || row.words),
            updated_at: nowMs(),
        });
        await emit(updated, `Trigger edited: ${updated.words}.`);
        return { trigger: await card(updated) };
    }

    async function pause(owner, id, { token = null } = {}) {
        const row = ID.test(String(id || '')) ? await store.get(s, owner, id) : null;
        if (!row) return { error: problem(404, 'actor.trigger.not_found', 'No such trigger.') };
        if (!token) return { error: problem(401, 'actor.trigger.sign_in', 'Sign in again: pausing a trigger uses your own OpenVibe session.') };
        if (row.running) return { error: problem(409, 'actor.trigger.busy', 'This trigger is running now; try again in a moment.') };
        if (row.watch_id) {
            const out = await client.pause(token, row.watch_id);
            if (!out.ok && out.status !== 404) return { error: problem(out.status || 502, out.code || 'actor.trigger.watch_failed', out.detail || 'OpenVibe.Watch did not pause it.') };
        }
        const updated = await store.update(s, owner, row.id, { state: 'paused', paused_reason: 'person', updated_at: nowMs() });
        await emit(updated, 'Trigger paused.');
        return { trigger: await card(updated) };
    }

    async function resume(owner, id, { token = null } = {}) {
        const row = ID.test(String(id || '')) ? await store.get(s, owner, id) : null;
        if (!row) return { error: problem(404, 'actor.trigger.not_found', 'No such trigger.') };
        if (!token) return { error: problem(401, 'actor.trigger.sign_in', 'Sign in again: resuming a trigger uses your own OpenVibe session.') };
        if (await store.countActive(s, owner) >= MAX_ACTIVE) return { error: problem(409, 'actor.trigger.limit', `You already have ${MAX_ACTIVE} active triggers. Pause one before resuming another.`) };
        if (row.watch_id) {
            const out = await client.resume(token, row.watch_id);
            if (!out.ok) return { error: problem(out.status || 502, out.code || 'actor.trigger.watch_failed', out.detail || 'OpenVibe.Watch did not resume it.') };
        }
        const updated = await store.update(s, owner, row.id, { state: 'active', paused_reason: null, failures: 0, updated_at: nowMs() });
        await emit(updated, 'Trigger resumed.');
        return { trigger: await card(updated) };
    }

    async function undo(owner, id, { token = null } = {}) {
        const row = ID.test(String(id || '')) ? await store.get(s, owner, id) : null;
        if (!row) return { error: problem(404, 'actor.trigger.not_found', 'No such trigger.') };
        if (nowMs() - Number(row.created_at) > UNDO_MS) return { error: problem(409, 'actor.trigger.undo_expired', 'The ten-minute undo window has passed. Delete the trigger instead.') };
        if (!token) return { error: problem(401, 'actor.trigger.sign_in', 'Sign in again: undoing a trigger uses your own OpenVibe session.') };
        if (row.watch_id) {
            const out = await client.remove(token, row.watch_id);
            if (!out.ok && out.status !== 404) return { error: problem(out.status || 502, out.code || 'actor.trigger.watch_failed', out.detail || 'OpenVibe.Watch did not remove the subscription.') };
        }
        await store.remove(s, owner, row.id);
        return { undone: true, id: row.id };
    }

    async function remove(owner, id, { token = null, confirm = false } = {}) {
        const row = ID.test(String(id || '')) ? await store.get(s, owner, id) : null;
        if (!row) return { error: problem(404, 'actor.trigger.not_found', 'No such trigger.') };
        if (!confirm) return { error: problem(409, 'actor.trigger.confirm', 'Deleting a trigger is permanent. Ask for confirmation first.') };
        if (!token) return { error: problem(401, 'actor.trigger.sign_in', 'Sign in again: deleting a trigger uses your own OpenVibe session.') };
        if (row.watch_id) {
            const out = await client.remove(token, row.watch_id);
            if (!out.ok && out.status !== 404) return { error: problem(out.status || 502, out.code || 'actor.trigger.watch_failed', out.detail || 'OpenVibe.Watch did not remove the subscription.') };
        }
        const updated = await store.update(s, owner, row.id, { state: 'deleted', deleted_at: nowMs(), updated_at: nowMs() });
        await emit(updated, 'Trigger deleted.');
        return { deleted: true, id: row.id };
    }

    async function runNow(owner, id) {
        const row = ID.test(String(id || '')) ? await store.get(s, owner, id) : null;
        if (!row) return { error: problem(404, 'actor.trigger.not_found', 'No such trigger.') };
        const agent = await agentOf(owner, row.agent_id);
        if (!agent) return { error: problem(422, 'actor.agent.not_found', 'The agent this trigger runs is gone. Pick another agent first.') };
        if (!row.watch_id) return { error: problem(409, 'actor.trigger.no_watch', 'This trigger has no subscription. Delete it and make a new one.') };
        const out = await personal.run({ s, config, engine, webhooks }, agent, row.task, { origin: 'routine', level: row.level, triggerId: row.id });
        if (out && out.code) return { error: problem(out.status || 422, out.code, out.detail || 'The run could not start.') };
        await emit(row, `Run now: ${row.task}.`);
        return { task: out.task, trigger: await card(await store.get(s, owner, row.id)) };
    }

    /** Resolve the trigger a Watch delivery is for, by its id or the subscription's id. */
    async function forDelivery(owner, { triggerId = null, watchId = null } = {}) {
        const subject = subjectOf(owner);
        if (triggerId && ID.test(String(triggerId))) {
            const row = await store.get(s, subject, triggerId);
            if (row) return row;
        }
        if (watchId && WATCH_ID.test(String(watchId))) return await store.byWatch(s, subject, watchId);
        return null;
    }

    /**
     * A task moved (the engine calls this after every state change). A failed run grows the streak; five in a
     * row pause the trigger and say so on the card. A success clears it. A run waiting for the person is shown
     * as needs_you and is not a failure.
     */
    async function taskState(task) {
        if (!task || !task.id) return null;
        const run = await store.runForTask(s, task.id);
        if (!run) return null;
        const row = await s.db.maybe('SELECT * FROM actor_triggers WHERE id = $1', [run.trigger_id]);
        if (!row || row.state === 'deleted') return null;
        const mapped = task.state === 'succeeded' ? 'ok'
            : task.state === 'failed' ? 'failed'
                : task.state === 'needs_you' ? 'needs_you'
                    : task.state === 'cancelled' ? 'failed' : 'running';
        if (run.state === mapped) return row;
        await store.addRun(s, run.trigger_id, task.id, mapped, nowMs());
        if (mapped === 'running') return row;
        let failures = Number(row.failures) || 0;
        if (mapped === 'failed' && task.state !== 'cancelled') failures += 1;
        if (mapped === 'ok') failures = 0;
        const patch = {
            last_task_id: task.id, last_state: mapped, last_run_at: nowMs(), failures, updated_at: nowMs(),
            ...(failures >= 5 ? { state: 'paused', paused_reason: 'failed' } : {}),
        };
        const updated = await store.update(s, row.owner, row.id, patch);
        if (failures >= 5) await emit(updated, `Paused after 5 failed runs in a row: ${row.task}.`);
        return updated;
    }

    return { create, get, list, edit, pause, resume, undo, remove, runNow, forDelivery, taskState, card, MAX_ACTIVE, UNDO_MS };
}

module.exports = { createTriggers, MAX_ACTIVE, UNDO_MS };

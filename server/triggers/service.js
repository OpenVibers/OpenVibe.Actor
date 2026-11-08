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
const goalLib = require('./goal');
const contacts = require('../agents/contacts');
const levels = require('../agents/levels');
const personal = require('../agents/personal');
const tasks = require('../tasks/store');

const ID = /^trg_[0-9A-HJKMNP-TV-Z]{26}$/;
const WATCH_ID = /^wch_[0-9A-HJKMNP-TV-Z]{26}$/;
const TASK_ID = /^tsk_[0-9A-HJKMNP-TV-Z]{26}$/;
const EVENT_PATTERN = /^[a-z][a-z0-9_-]*(\.[a-z0-9_*]+){1,}$/;
const MAX_ACTIVE = 20;
const UNDO_MS = 10 * 60_000;
const MAX_TASK = 8000;
const KINDS = ['schedule', 'event', 'goal'];
const MAX_GOAL_TEXT = 500;
const MAX_DONE_TEST = 300;
const MAX_GOAL_RUNS = 200;
/** A goal with no run limit given gets this many; with no deadline, this long. */
const GOAL_RUNS = 12;
const GOAL_DAYS = 7;

const iso = (ms) => (ms == null ? null : new Date(Number(ms)).toISOString());
const clip = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const usd = (n) => Math.round((Number(n) || 0) * 1e6) / 1e6;
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
        const scheduled = row.kind === 'schedule' || row.kind === 'goal';
        let next = null;
        if (row.state === 'active' && scheduled && row.schedule && row.schedule.cron) {
            try { const at = cron.next(row.schedule.cron, row.schedule.timezone || row.timezone || 'UTC', nowMs()); if (at) next = iso(at); } catch { /* no next */ }
        }
        const goal = row.kind === 'goal' && row.goal ? {
            text: String(row.goal.text || ''),
            done_test: String(row.goal.done_test || ''),
            runs_used: Number(row.runs_used) || 0,
            runs_max: row.goal.runs_max == null ? null : Number(row.goal.runs_max),
            spent_usd: usd(row.spent_usd),
            budget_usd: row.goal.budget_usd == null ? null : Number(row.goal.budget_usd),
            deadline_at: row.goal.deadline_at || null,
            not_yet: row.verdict && row.verdict.done === false ? String(row.verdict.reason || '') || null : null,
            verdict: row.verdict && row.verdict.at ? { done: Boolean(row.verdict.done), reason: String(row.verdict.reason || ''), at: row.verdict.at } : null,
        } : null;
        const out = {
            id: row.id,
            owner: row.owner,
            agent_id: row.agent_id,
            agent_name: agent ? agent.name : null,
            task: row.task,
            kind: row.kind,
            when: {
                words: row.words,
                cron: scheduled && row.schedule ? row.schedule.cron : null,
                timezone: scheduled ? (row.timezone || (row.schedule && row.schedule.timezone) || null) : null,
                event: row.kind === 'event' && row.event ? { pattern: row.event.pattern, filter: row.event.filter || null } : null,
            },
            goal,
            answer_in_chat: row.answer_in_chat !== false,
            notify: row.notify === true,
            next_run_at: next,
            last_run: row.last_task_id && row.last_state && row.last_run_at
                ? { task_id: row.last_task_id, state: row.last_state, at: iso(row.last_run_at) }
                : null,
            state: row.state === 'paused' ? 'paused' : row.state === 'done' ? 'done' : 'active',
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
            const saved = await tasks.appendEvent(s, row.turn_task_id, event);
            if (stream && typeof stream.publish === 'function') stream.publish(row.turn_task_id, saved);
        } catch (err) {
            log.warn && log.warn('[Actor] trigger card:', row.id, (err && err.message) || err);
        }
    }

    function validate({ owner, agentId, task, kind, cronExpr, timezone, event, goal }) {
        if (!/^usr_[0-9A-HJKMNP-TV-Z]{26}$/.test(String(owner || ''))) return problem(401, 'actor.trigger.sign_in', 'Sign in to make a trigger.');
        if (!agentId) return problem(422, 'actor.trigger.agent', 'Choose which of your agents should run it.');
        if (typeof task !== 'string' || !task.trim() || task.length > MAX_TASK) return problem(422, 'actor.trigger.task', 'Say what the agent should do each time, in a sentence.');
        if (!KINDS.includes(kind)) return problem(422, 'actor.trigger.kind', 'A trigger is a schedule, a Watch event, or a goal.');
        if (kind !== 'event') {
            if (!timezone || !cron.isZone(timezone)) return problem(422, 'actor.trigger.timezone', `Unknown time zone "${timezone}". Say the city or the IANA name.`);
            const verdict = cron.validate(cronExpr, timezone);
            if (!verdict.valid) return problem(422, 'actor.trigger.schedule', verdict.error);
        }
        if (kind === 'event') {
            if (!event || !EVENT_PATTERN.test(String(event.pattern || ''))) return problem(422, 'actor.trigger.event', 'An event source is an Events topic pattern such as github.issue.opened.');
            if (event.filter != null && (typeof event.filter !== 'object' || Array.isArray(event.filter))) return problem(422, 'actor.trigger.event', 'event.filter must be an object of field values.');
        }
        if (kind === 'goal') {
            const g = goal || {};
            const text = String(g.text == null ? '' : g.text).trim();
            const test = String(g.done_test == null ? '' : g.done_test).trim();
            if (!text) return problem(422, 'actor.trigger.goal', 'Say what the goal is working toward, in a sentence.');
            if (text.length > MAX_GOAL_TEXT) return problem(422, 'actor.trigger.goal', `The goal is at most ${MAX_GOAL_TEXT} characters; say it in a sentence.`);
            if (!test) return problem(422, 'actor.trigger.done_test', 'A goal needs the check that ends it: what a run answers yes or no, such as "the price is under €120".');
            if (test.length > MAX_DONE_TEST) return problem(422, 'actor.trigger.done_test', `The done-test is at most ${MAX_DONE_TEST} characters; say the check in one line.`);
            if (g.runs_max != null) {
                const n = Number(g.runs_max);
                if (!Number.isInteger(n) || n < 1 || n > MAX_GOAL_RUNS) return problem(422, 'actor.trigger.goal', `The run limit is a whole number from 1 to ${MAX_GOAL_RUNS}.`);
            }
            if (g.budget_usd != null && !(Number(g.budget_usd) >= 0)) return problem(422, 'actor.trigger.goal', 'The money budget is a number of dollars, zero or more.');
            if (g.deadline_at != null && !Number.isFinite(Date.parse(String(g.deadline_at)))) return problem(422, 'actor.trigger.goal', 'The deadline is a date, such as 2026-11-14T09:00:00Z.');
        }
        return null;
    }

    /** A goal's own fields: the text and the done-test as said, its limits and its deadline, defaulted. */
    function goalRow(goal, at) {
        const g = goal || {};
        const perDay = Number(config && config.allowance && config.allowance.perDayUsd);
        return {
            text: String(g.text).trim().slice(0, MAX_GOAL_TEXT),
            done_test: String(g.done_test).trim().slice(0, MAX_DONE_TEST),
            runs_max: g.runs_max == null ? GOAL_RUNS : Number(g.runs_max),
            // With no money budget of its own, a goal spends what the person's day allows and no more.
            budget_usd: g.budget_usd == null ? (Number.isFinite(perDay) ? perDay : null) : Number(g.budget_usd),
            deadline_at: g.deadline_at == null ? iso(at + GOAL_DAYS * 86_400_000) : new Date(Date.parse(String(g.deadline_at))).toISOString(),
        };
    }

    async function create({ owner, agentId, task, kind, cron: cronExpr = null, timezone = null, event = null, goal = null, level = null, turnTaskId = null, personToken = null, announce = true, answerInChat = true, notify = false }) {
        const bad = validate({ owner, agentId, task, kind, cronExpr, timezone, event, goal });
        if (bad) return { error: bad };
        const agent = await agentOf(owner, agentId);
        if (!agent) return { error: problem(422, 'actor.agent.not_found', 'agent_id names one of your own agents (GET /api/v1/agents).') };
        if (!client.enabled) return { error: problem(503, 'actor.trigger.watch_unavailable', 'OpenVibe.Watch is not configured on this Actor, so it cannot run a trigger.') };
        if (!personToken) return { error: problem(401, 'actor.trigger.sign_in', 'Sign in again: creating a trigger needs your own OpenVibe session, not a service token.') };
        const active = await store.countActive(s, owner);
        if (active >= MAX_ACTIVE) return { error: problem(409, 'actor.trigger.limit', `You already have ${MAX_ACTIVE} active triggers. Pause one, or delete one, before making another.`) };
        const at = nowMs();
        const scheduled = kind !== 'event';
        const row = await store.insert(s, {
            id: s.newId('trg'), owner, agent_id: agent.id, task: String(task).trim(), kind,
            schedule: scheduled ? { cron: cronExpr, timezone } : null,
            event: kind === 'event' ? { pattern: event.pattern, filter: event.filter || null } : null,
            goal: kind === 'goal' ? goalRow(goal, at) : null,
            timezone: scheduled ? timezone : null,
            words: scheduled ? parse.wordsFor(cronExpr, timezone) : (event.words || `When ${event.pattern}`),
            level: levels.LEVELS.includes(level) ? level : 'ask',
            state: 'paused', turn_task_id: turnTaskId, answer_in_chat: answerInChat !== false, notify: notify === true, created_at: at,
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
            if (scheduled) {
                const withSchedule = await client.setSchedule(personToken, made.id, cronExpr, timezone);
                if (!withSchedule.ok) throw withSchedule;
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

    /**
     * One routine run's answer, posted into the conversation that made the trigger, under its card
     * (plan HO4): the answer with the addresses it read and a link to the run, or — when the run did
     * not finish — the one line that says why. The routine's own switch decides (default on).
     */
    async function postRun(row, task, mapped) {
        if (!row || !row.turn_task_id || row.answer_in_chat === false) return;
        if (!TASK_ID.test(String(row.turn_task_id))) return;
        const result = tasks.parseJson(task.result) || {};
        const at = iso(nowMs());
        const ok = mapped === 'ok';
        const text = ok
            ? clip(result.answer || '', 8000)
            : mapped === 'needs_you'
                ? 'That run needs you: open it and answer, and the routine carries on.'
                : `That run did not finish: ${clip(task.error_detail || task.error_code || 'Actor did not say why', 400)}.`;
        const sources = ok && Array.isArray(result.sources)
            ? result.sources.filter((u) => typeof u === 'string' && u).slice(0, 8).map((u) => u.slice(0, 4000))
            : [];
        try {
            const event = {
                at, kind: 'output', step: 'trigger-run', agent: 'openvibe-runtime',
                trigger_id: row.id,
                run: { task_id: task.id, state: ok ? 'ok' : (mapped === 'needs_you' ? 'needs_you' : 'failed'), at },
                text,
                ...(sources.length ? { sources } : {}),
            };
            const saved = await tasks.appendEvent(s, row.turn_task_id, event);
            if (stream && typeof stream.publish === 'function') stream.publish(row.turn_task_id, saved);
        } catch (err) {
            log.warn && log.warn('[Actor] routine run post:', row.id, (err && err.message) || err);
        }
    }

    /**
     * A goal ends itself (plan HO3): its done-test passed, or its runs, its money or its deadline is
     * spent. It says so in the thread, and the watch is paused with the person's token when the
     * caller has one; without one, Watch stops on the next firing (Actor answers it with
     * actor.trigger.paused / actor.trigger.done).
     */
    async function endGoal(row, { reason, line = null, token = null } = {}) {
        if (!row || row.state !== 'active') return row;
        const updated = await store.update(s, row.owner, row.id, {
            state: reason === 'done' ? 'done' : 'paused',
            paused_reason: reason,
            ended_at: nowMs(), updated_at: nowMs(),
        });
        if (line) await emit(updated, line);
        if (token && row.watch_id) await client.pause(token, row.watch_id);
        return updated;
    }

    /** A goal whose deadline has passed is over, even between runs. Read lazily wherever the card is. */
    async function expire(row, { token = null } = {}) {
        if (!row || row.kind !== 'goal' || row.state !== 'active' || !row.goal) return row;
        const deadline = row.goal.deadline_at ? Date.parse(row.goal.deadline_at) : NaN;
        if (!Number.isFinite(deadline) || nowMs() < deadline) return row;
        const line = `Stopping here: ${iso(deadline).slice(0, 10)} passed and the goal is not done.${row.verdict && row.verdict.reason ? ` Last run: ${clip(row.verdict.reason, 200)}.` : ''}`;
        return await endGoal(row, { reason: 'deadline', line, token });
    }

    async function get(owner, id, { token = null, live = false } = {}) {
        if (!ID.test(String(id || ''))) return null;
        const found = await store.get(s, owner, id);
        if (!found) return null;
        const row = await expire(found, { token });
        return await card(row, { token, live });
    }

    async function list(owner) {
        const rows = await store.list(s, owner);
        const live = [];
        for (const row of rows) live.push(await expire(row));
        return await Promise.all(live.map((row) => card(row)));
    }

    async function edit(owner, id, patch = {}, { token = null } = {}) {
        const row = ID.test(String(id || '')) ? await store.get(s, owner, id) : null;
        if (!row) return { error: problem(404, 'actor.trigger.not_found', 'No such trigger.') };
        // The routine's two switches (HO4) travel through the same PATCH: they are the person's own settings, so
        // they need no Watch subscription change and no person token.
        const switches = {};
        if (patch.answer_in_chat !== undefined) switches.answerInChat = patch.answer_in_chat !== false;
        if (patch.notify !== undefined) switches.notify = patch.notify === true;
        if (Object.keys(switches).length) {
            const onlySwitches = Object.keys(patch).every((k) => k === 'answer_in_chat' || k === 'notify');
            const doneSwitches = await setSwitch(owner, row.id, switches);
            if (doneSwitches.error || onlySwitches) return doneSwitches;
        }
        if (!token) return { error: problem(401, 'actor.trigger.sign_in', 'Sign in again: changing a trigger uses your own OpenVibe session.') };
        const next = {
            agent_id: patch.agent_id !== undefined ? patch.agent_id : row.agent_id,
            task: patch.task !== undefined ? String(patch.task).trim() : row.task,
            // A goal stays a goal: what it works toward and the check that ends it are its kind's own fields.
            kind: row.kind === 'goal' ? 'goal' : (patch.kind !== undefined ? patch.kind : row.kind),
            cron: patch.cron !== undefined ? patch.cron : (row.schedule && row.schedule.cron),
            timezone: patch.timezone !== undefined ? patch.timezone : (row.timezone || (row.schedule && row.schedule.timezone) || 'UTC'),
            event: patch.event !== undefined ? patch.event : row.event,
            goal: row.kind === 'goal' && patch.goal && typeof patch.goal === 'object' ? { ...row.goal, ...patch.goal } : row.goal,
            level: row.level,
        };
        const bad = validate({ owner, agentId: next.agent_id, task: next.task, kind: next.kind, cronExpr: next.cron, timezone: next.timezone, event: next.event, goal: next.goal });
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
        if (next.kind !== 'event' && (patch.cron !== undefined || patch.timezone !== undefined || patch.kind !== undefined)) {
            const rescheduled = await client.setSchedule(token, row.watch_id, next.cron, next.timezone);
            if (!rescheduled.ok) return { error: problem(rescheduled.status || 502, rescheduled.code || 'actor.trigger.watch_failed', rescheduled.detail || 'OpenVibe.Watch refused the schedule.') };
        }
        const updated = await store.update(s, owner, row.id, {
            task: next.task, agent_id: next.agent_id, kind: next.kind,
            schedule: next.kind !== 'event' ? { cron: next.cron, timezone: next.timezone } : row.schedule,
            event: next.kind === 'event' ? { pattern: next.event.pattern, filter: next.event.filter || null } : row.event,
            goal: next.goal,
            timezone: next.kind !== 'event' ? next.timezone : null,
            words: next.kind !== 'event' ? parse.wordsFor(next.cron, next.timezone) : (next.event.words || row.words),
            updated_at: nowMs(),
        });
        await emit(updated, `Trigger edited: ${updated.words}.`);
        return { trigger: await card(updated) };
    }

    /**
     * The routine's own two switches (HO4): answer in this chat (default on) and also tell me through
     * OpenVibe's notifications (default off, because the answer in the chat is already the telling).
     */
    async function setSwitch(owner, id, { answerInChat = null, notify = null } = {}) {
        const row = ID.test(String(id || '')) ? await store.get(s, owner, id) : null;
        if (!row) return { error: problem(404, 'actor.trigger.not_found', 'No such trigger.') };
        const patch = { updated_at: nowMs() };
        if (answerInChat != null) patch.answer_in_chat = answerInChat !== false;
        if (notify != null) patch.notify = notify === true;
        if (Object.keys(patch).length === 1) return { error: problem(400, 'actor.trigger.nothing', 'Say answer_in_chat or notify.') };
        const updated = await store.update(s, owner, row.id, patch);
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
        if (row.state === 'done') return { error: problem(409, 'actor.trigger.done', 'This goal reached its check and is finished. Make a new one if you want it to keep going.') };
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
        const found = ID.test(String(id || '')) ? await store.get(s, owner, id) : null;
        if (!found) return { error: problem(404, 'actor.trigger.not_found', 'No such trigger.') };
        const row = await expire(found);
        if (row.state === 'done') return { error: problem(409, 'actor.trigger.done', 'This goal is done. Make a new one if you want it to keep going.') };
        // A goal that stopped for its budget or its deadline does not run again by accident: Resume (after raising
        // its limit or its deadline) is the person's deliberate move.
        if (row.state === 'paused' && row.kind === 'goal') return { error: problem(409, 'actor.trigger.paused', 'This goal has stopped. Resume it, or make a new one.') };
        const agent = await agentOf(owner, row.agent_id);
        if (!agent) return { error: problem(422, 'actor.agent.not_found', 'The agent this trigger runs is gone. Pick another agent first.') };
        if (!row.watch_id) return { error: problem(409, 'actor.trigger.no_watch', 'This trigger has no subscription. Delete it and make a new one.') };
        const out = await personal.run({ s, config, engine, webhooks }, agent, row.task, { origin: 'routine', level: row.level, triggerId: row.id, goal: row.goal });
        if (out && out.code) return { error: problem(out.status || 422, out.code, out.detail || 'The run could not start.') };
        await emit(row, `Run now: ${row.task}.`);
        return { task: out.task, trigger: await card(await store.get(s, owner, row.id)) };
    }

    /** Resolve the trigger a Watch delivery is for, by its id or the subscription's id. */
    async function forDelivery(owner, { triggerId = null, watchId = null } = {}) {
        const subject = subjectOf(owner);
        let row = null;
        if (triggerId && ID.test(String(triggerId))) row = await store.get(s, subject, triggerId);
        if (!row && watchId && WATCH_ID.test(String(watchId))) row = await store.byWatch(s, subject, watchId);
        if (!row) return null;
        // A goal whose deadline passed is over before this delivery runs anything.
        return await expire(row);
    }

    /**
     * A task moved (the engine calls this after every state change). A failed run grows the streak; five in a
     * row pause the trigger and say so on the card. A success clears it. A run waiting for the person is shown
     * as needs_you and is not a failure.
     *
     * Plan HO4: a run that finished posts its answer into the conversation that made the trigger, under its
     * card. Plan HO3: a goal counts the run, records its verdict, and ends itself when the done-test passed
     * or its runs, money or deadline is spent.
     */
    async function taskState(task) {
        if (!task || !task.id) return null;
        const run = await store.runForTask(s, task.id);
        if (!run) return null;
        const found = await s.db.maybe('SELECT * FROM actor_triggers WHERE id = $1', [run.trigger_id]);
        if (!found || found.state === 'deleted') return null;
        const row = store.wire(found);
        const mapped = task.state === 'succeeded' ? 'ok'
            : task.state === 'failed' ? 'failed'
                : task.state === 'needs_you' ? 'needs_you'
                    : task.state === 'cancelled' ? 'failed' : 'running';
        if (run.state === mapped) return row;
        const cost = Number(task.cost_usd) || 0;
        await store.addRun(s, run.trigger_id, task.id, mapped, nowMs(), cost);
        if (mapped === 'running') return row;

        // The answer in the thread comes first, so a goal's closing line reads after the run it ends.
        await postRun(row, task, mapped);

        // The counters move in one statement, and the row it returns is the truth: the card is read
        // from it, and the ending is decided on the count that was really reached. A count read before
        // this write (and then written back as an absolute number) loses a run when two settle at once.
        const goal = row.kind === 'goal' && (mapped === 'ok' || mapped === 'failed');
        const after = await store.bumpCounters(s, row.id, {
            state: task.state, runs: goal ? 1 : 0, costUsd: goal ? cost : 0, at: nowMs(),
        }) || row;
        const failures = Number(after.failures) || 0;
        const patch = {
            last_task_id: task.id, last_state: mapped, last_run_at: nowMs(), updated_at: nowMs(),
            ...(failures >= 5 ? { state: 'paused', paused_reason: 'failed' } : {}),
        };

        let ended = null;
        if (goal) {
            const result = tasks.parseJson(task.result) || {};
            const verdict = mapped === 'ok' ? goalLib.verdictOf(result.answer) : { done: null, reason: '' };
            if (verdict.done != null) patch.verdict = { done: verdict.done, reason: verdict.reason, at: iso(nowMs()) };
            if (row.state === 'active') {
                ended = goalLib.endingOf({
                    goal: row.goal, verdict,
                    runsUsed: Number(after.runs_used) || 0, spentUsd: usd(after.spent_usd), at: nowMs(),
                });
                if (ended) Object.assign(patch, { state: ended.reason === 'done' ? 'done' : 'paused', paused_reason: ended.reason, ended_at: nowMs() });
            }
        }
        const updated = await store.update(s, row.owner, row.id, patch);
        if (failures >= 5) await emit(updated, `Paused after 5 failed runs in a row: ${row.task}.`);
        if (ended) await emit(updated, ended.line);
        return updated;
    }

    /**
     * Whether the engine should tell the person itself (its one-per-task-per-state notification), for a
     * routine run. null when the task is not a routine run: the engine decides as it always has.
     */
    async function tellsPerson(task) {
        if (!task || !task.id) return null;
        const run = await store.runForTask(s, task.id);
        if (!run) return null;
        const found = await s.db.maybe('SELECT notify FROM actor_triggers WHERE id = $1', [run.trigger_id]);
        return found ? found.notify === true : null;
    }

    return { create, get, list, edit, pause, resume, undo, remove, runNow, forDelivery, taskState, tellsPerson, setSwitch, card, expire, endGoal, MAX_ACTIVE, UNDO_MS };
}

module.exports = { createTriggers, MAX_ACTIVE, UNDO_MS };

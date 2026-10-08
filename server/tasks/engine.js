'use strict';

/**
 * The task engine: a queued task runs here, in the process that accepted it (no claims, no leases).
 *
 *   queued → running: classify the task (a cheap model, or the heuristic in private mode) and route it
 *            (agents/router.js); nothing eligible → failed with why (budget, private mode, no agent)
 *   running: the selected agent's adapter works, its steps stream as events, every call's cost is metered at once
 *   verifying: another model family checks the answer (agents/check.js)
 *   → succeeded with the result, the cost and the explanation; or the next eligible agent gets the task (an error, a
 *     failed check) — at most MAX_ATTEMPTS agents, each placement appended to the explanation — or failed
 *
 * Budgets are hard (ADR-044 §8): the planner never picks an agent whose typical cost is over what is left, and an
 * adapter stops before a call when nothing is left. Cancel aborts the running call; what was spent stays spent.
 * At most config.maxRunning tasks run at once; the rest wait queued in order.
 */
const store = require('./store');
const catalog = require('../agents/catalog');
const { classify, heuristic } = require('../agents/classify');
const { route, whyNone } = require('../agents/router');
const { check } = require('../agents/check');

const MAX_ATTEMPTS = 2;

function createEngine({ config, s, adapters, stream, now = () => Date.now(), log = console }) {
    const running = new Map();      // id → AbortController
    const waiting = [];
    let stopped = false;

    const iso = () => new Date(now()).toISOString();

    async function emit(id, body) {
        const event = await store.appendEvent(s, id, { at: iso(), ...body });
        stream.publish(id, event);
        return event;
    }
    async function setState(id, state, { agentForEvent, ...patch } = {}) {
        const row = await store.updateTask(s, id, { state, ...patch });
        const ended = ['succeeded', 'failed', 'cancelled'].includes(state);
        await emit(id, { kind: ended ? 'end' : 'state', state, ...(agentForEvent ? { agent: agentForEvent } : {}) });
        if (ended) stream.end(id);
        return row;
    }

    function submit(id) {
        if (stopped) return;
        waiting.push(id);
        pump();
    }
    function pump() {
        while (!stopped && running.size < config.maxRunning && waiting.length) {
            const id = waiting.shift();
            const ac = new AbortController();
            running.set(id, ac);
            execute(id, ac.signal)
                .catch((err) => log.error('[Actor] task crashed:', id, err && err.message))
                .finally(() => { running.delete(id); pump(); });
        }
    }

    async function execute(id, signal) {
        const row = await store.getTask(s, id);
        if (!row || row.state !== 'queued') return;
        const budget = Number(row.budget_task);
        let spent = 0;
        const meter = async (usd) => {
            const v = Number(usd) || 0;
            if (!v) return;
            spent += v;
            // Billing (T5) is not in the loop yet: every cent is the free allowance's, and says so.
            await store.updateTask(s, id, { cost_usd: spent, free_usd: spent });
            await store.addSpend(s, row.requester, v);
        };
        const budgetLeft = () => budget - spent;
        const timer = setTimeout(() => { if (running.has(id)) running.get(id).abort('timeout'); }, config.taskTimeoutMs);
        timer.unref();
        const explanation = [];
        const tried = new Map();
        // The quality tier a hand-off may not go below: the tier of the best agent tried so far (catalog quality).
        let floor = null;
        const raise = (agent) => { if (agent && agent.quality === 'high') floor = 'high'; else if (agent && agent.quality === 'standard' && floor !== 'high') floor = 'standard'; };
        try {
            await setState(id, 'running', { cost_usd: 0, free_usd: 0 });
            // What kind of task this is. Private mode never sends the text anywhere to find out.
            let cls;
            if (row.mode === 'private' || !adapters.checkers.deepseek) {
                cls = heuristic(row.task);
            } else {
                const c = await classify(row.task, { chat: adapters.checkers.deepseek, signal });
                await meter(c.cost_usd);
                cls = c.class;
            }
            await emit(id, { kind: 'output', step: 'plan', text: `This is a "${cls}" task.` });

            for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
                const placement = route({ cls, mode: row.mode, agent: row.agent, budgetUsd: Math.max(0, budgetLeft()), config, tried, now: now(), floor: row.mode === 'private' ? null : floor });
                explanation.push(placement);
                await store.updateTask(s, id, { explanation });
                if (!placement.selected) {
                    if (attempt > 1) break;
                    const why = whyNone(placement, { cls, mode: row.mode, budgetUsd: budgetLeft() });
                    return await setState(id, 'failed', { error_code: why.code, error_detail: why.detail, finished_at: iso() });
                }
                const agentId = placement.selected;
                const agent = catalog.byId(agentId);
                await emit(id, { kind: 'output', step: attempt > 1 ? 'handoff' : 'plan', agent: agentId, text: `${agent.name} takes it${placement.reasons && placement.reasons[0] ? `: ${placement.reasons[0]}` : ''}.` });
                let out;
                try {
                    out = await adapters.run[agentId]({ task: row.task, cls, mode: row.mode, signal, meter, budgetLeft, emit: (e) => emit(id, { kind: 'output', agent: agentId, ...e }) });
                } catch (err) {
                    if (signal.aborted) throw err;
                    const why = (err && err.message) || String(err);
                    await emit(id, { kind: 'output', step: 'text', agent: agentId, text: `${agent.name} stopped: ${why}`.slice(0, 2000), is_error: true });
                    if (err && err.code === 'actor.budget.exceeded') {
                        return await setState(id, 'failed', { error_code: 'actor.budget.exceeded', error_detail: `The task used its whole $${budget.toFixed(3)} budget before an agent finished.`, finished_at: iso() });
                    }
                    tried.set(agentId, why);
                    raise(agent);
                    continue;
                }
                await setState(id, 'verifying', { agentForEvent: agentId });
                const verdict = await check({ task: row.task, answer: out.text, sources: out.sources || [], agentId, mode: row.mode, checkers: adapters.checkers, signal });
                await meter(verdict.cost_usd);
                await emit(id, { kind: 'output', step: 'check', agent: agentId, text: `${verdict.ok ? 'Checked' : 'Check failed'}${verdict.by ? ` by ${verdict.by}${verdict.cross ? '' : ' (same family)'}` : ''}: ${verdict.reason || ''}`.slice(0, 2000), is_error: !verdict.ok });
                if (verdict.ok) {
                    const result = { answer: out.text, sources: out.sources || [], agent: agentId, model: out.model || catalog.modelOf(agent, config) || null, class: cls, checked: { by: verdict.by, cross_family: !!verdict.cross, reason: verdict.reason } };
                    return await setState(id, 'succeeded', { result, finished_at: iso() });
                }
                if (verdict.unavailable) {
                    return await setState(id, 'failed', { error_code: 'actor.check.unavailable', error_detail: `The answer could not be checked (${verdict.reason}), so it was not delivered.`, finished_at: iso() });
                }
                // The refused answer, right after its failed check: the task page shows it folded away, never as the answer.
                await emit(id, { kind: 'output', step: 'text', agent: agentId, text: out.text.slice(0, 8000), is_error: true });
                tried.set(agentId, `its answer failed the check: ${verdict.reason}`);
                raise(agent);
                await setState(id, 'running');
            }
            const last = [...tried.entries()].pop();
            return await setState(id, 'failed', { error_code: 'actor.agents.exhausted', error_detail: `No agent finished this task with an answer that passed its check${last ? ` (last: ${last[0]}, ${last[1]})` : ''}.`.slice(0, 2000), finished_at: iso() });
        } catch (err) {
            if (signal.aborted) {
                if (signal.reason === 'shutdown') return undefined;    // stop() records it as interrupted
                if (signal.reason === 'cancelled') return await setState(id, 'cancelled', { finished_at: iso() });
                return await setState(id, 'failed', { error_code: 'actor.task.timeout', error_detail: `The task ran longer than ${Math.round(config.taskTimeoutMs / 1000)} seconds and was stopped.`, finished_at: iso() });
            }
            log.error('[Actor] task failed unexpectedly:', id, err && err.message);
            return await setState(id, 'failed', { error_code: 'actor.internal', error_detail: 'Something went wrong on Actor\'s side. Nothing more will be charged for this task.', finished_at: iso() });
        } finally {
            clearTimeout(timer);
        }
    }

    /** Cancel: a queued task ends at once; a running one is aborted and ends cancelled when its call returns. */
    async function cancel(id, by) {
        const row = await store.getTask(s, id);
        if (!row || !store.OPEN.includes(row.state)) return row;
        await store.updateTask(s, id, { cancel_at: iso(), cancel_by: by || null });
        const i = waiting.indexOf(id);
        if (i >= 0) {
            waiting.splice(i, 1);
            return setState(id, 'cancelled', { finished_at: iso() });
        }
        const ac = running.get(id);
        if (ac) ac.abort('cancelled');
        return store.getTask(s, id);
    }

    /** Shutdown: running tasks are stopped and recorded as interrupted; queued ones too. */
    async function stop() {
        stopped = true;
        for (const ac of running.values()) ac.abort('shutdown');
        waiting.length = 0;
        await store.failInterrupted(s).catch(() => {});
    }

    const status = () => ({ running: running.size, waiting: waiting.length });

    return { submit, cancel, stop, status, MAX_ATTEMPTS };
}

module.exports = { createEngine, MAX_ATTEMPTS };

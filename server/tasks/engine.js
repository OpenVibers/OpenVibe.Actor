'use strict';

// The most a task's clock waits for its person, in all (Desks plan D4: hand_to_person).
const PERSON_WAIT_MAX_MS = 15 * 60_000;

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
const { check: checkClaims } = require('../runtime/check');
const approvals = require('../agents/approvals');
const { repoIn: codesRepoIn } = require('../agents/codes');
const memory = require('../memory');
const taskNotices = require('../notify/task-notices');
const confidence = require('../runtime/brain/confidence');
const learn = require('../runtime/brain/learn');

const MAX_ATTEMPTS = 2;
// The one loop's agent id on the event stream and in the result (the old runtime's id, kept for readers).
const LOOP_AGENT = 'openvibe-runtime';

// What a task asked in a public chat may be (chat/asks.js): nothing that uses the person's own computers, robots or code.
const PUBLIC_CLASSES = ['answer', 'lookup', 'research', 'web'];

function createEngine({ config, s, adapters, stream, webhooks = null, now = () => Date.now(), log = console, models = null, loop = null, notifier = null, registry = null }) {
    const running = new Map();      // id → AbortController
    const waiting = [];
    // A question the loop asked before any tool ran (stage V2-8): the task waits in needs_you, the page shows the
    // question, and POST /tasks/:id/answer resumes this same run with the person's words.
    const asking = new Map();       // task id → resolve(answer)
    const controls = new Map();     // task id → the run's control object (live assumptions)
    let stopped = false;

    const iso = () => new Date(now()).toISOString();
    const subjectOf = (requester) => (typeof requester === 'string' && requester.startsWith('user:') ? requester.slice(5) : null);

    /** The task as a person would name it in a notification (a personal run is its agent, not its whole prompt). */
    async function taskTitle(row) {
        const via = String(row.via || '');
        if (/^agent:agt_/.test(via)) {
            const agent = await s.db.maybe('SELECT name FROM actor_agents WHERE id = $1 AND owner = $2', [via.slice(6), row.requester]).catch(() => null);
            if (agent) return agent.name;
        }
        const t = String(row.task || '').replace(/^Personal agent instructions[\s\S]*?\n\n/, '').replace(/\s+/g, ' ').trim();
        return (t.length > 160 ? `${t.slice(0, 159)}…` : t) || 'Your task';
    }

    /**
     * "Tell me when it's done": one Network notification per task per outcome. The row in actor_task_notices is the
     * claim, so a retried end or a second hand-off in one run never tells the person twice. It never fails a task.
     */
    async function tellPerson(row, kind, detail = {}) {
        if (!notifier || !row) return;
        const subject = subjectOf(row.requester);
        if (!subject) return;
        try {
            if (!(await taskNotices.once(s, row.id, kind))) return;
            if (kind === 'needs_you') {
                await notifier.needsYou({ subject, what: detail.what, title: await taskTitle(row), url: detail.url || `${config.baseUrl}/tasks/${row.id}` });
            } else {
                await notifier.taskEnded({
                    subject, state: kind, taskId: row.id, title: await taskTitle(row),
                    url: `${config.baseUrl}/tasks/${row.id}`, detail: kind === 'failed' ? (row.error_detail || row.error_code || null) : null,
                });
            }
        } catch (err) { log.warn && log.warn('[Actor] task notification failed:', row.id, err && err.message); }
    }

    /**
     * The closing REMEMBER:/IMPROVE: lines (agents/personal.js), in either order. A REMEMBER line is an agent-written
     * note, so it is always a suggestion now: a run that read a page can put words in the agent's mouth, and only the
     * person's own words may make an active memory (stage V2-6).
     */
    async function absorbClosingLines(answer, row, taskId) {
        let text = answer;
        const personal = require('../agents/personal');
        for (let i = 0; i < 2; i++) {
            const match = text.match(/(?:^|\n)(REMEMBER|IMPROVE): ([^\n]*)[ \t]*$/);
            if (!match) break;
            text = text.slice(0, match.index).trimEnd();
            const line = match[2].trim();
            if (!line || line.length > 300) continue;
            if (match[1] === 'REMEMBER') await memory.add(s, { owner: row.requester, agentId: row.via.slice(6), text: line, source: 'agent', status: 'suggested', sourceTask: taskId });
            else await personal.addProposal(s, row.requester, row.via.slice(6), line, taskId);
        }
        return text;
    }

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
        // "Tell me when it's done" (stage V2-6): done or failed, once per task. Cancelled is the person's own action.
        if (ended && row && (state === 'succeeded' || state === 'failed')) await tellPerson(row, state);
        // Webhooks that asked for this state hear it; a delivery never holds the task up or fails it.
        if (webhooks && row && row.webhooks) {
            try {
                await webhooks.enqueue(id, state);
                if (ended) await webhooks.forgetSecretIfDone(id);
            } catch (err) { log.warn('[Actor] webhook enqueue failed:', id, err && err.message); }
        }
        return row;
    }

    /**
     * The person's answer to the one question (stage V2-8). The run is waiting in needs_you inside execute(); this
     * resolves it, and the same run continues with the answer as the person's words.
     */
    async function answer(id, text) {
        const resolve = asking.get(id);
        if (!resolve) return false;
        asking.delete(id);
        resolve(String(text == null ? '' : text).slice(0, 2000));
        return true;
    }

    /** An assumption edit on a live task's page is a follow-up turn in the same run (stage V2-8). */
    async function assume(id, text) {
        const control = controls.get(id);
        if (!control || typeof control.assume !== 'function') return { ok: false, reason: 'this task is not running a plan you can edit' };
        return await control.assume(text);
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
        const abortAtEnd = () => { if (running.has(id)) running.get(id).abort('timeout'); };
        // The task's own clock (Actor v2): set at creation (10 minutes by default, up to an hour for mode best).
        const timeoutMs = Math.max(10_000, Number(row.timeout_ms) || config.taskTimeoutMs);
        let ends = Date.now() + timeoutMs;
        let timer = setTimeout(abortAtEnd, timeoutMs);
        timer.unref();
        // Desks plan D4: a task that handed its person a step on its desk (a sign-in, a CAPTCHA, a payment) waits for
        // them; its clock waits too, up to PERSON_WAIT_MAX_MS in all. Answers how long it may wait (0: no more).
        let waited = 0;
        const waitForPerson = (ms) => {
            const add = Math.max(0, Math.min(Number(ms) || 0, PERSON_WAIT_MAX_MS - waited));
            if (!add) return 0;
            waited += add;
            ends += add;
            clearTimeout(timer);
            timer = setTimeout(abortAtEnd, Math.max(0, ends - Date.now()));
            timer.unref();
            return add;
        };
        // One question, before any tool (stage V2-8): the task waits in needs_you; its clock waits with the person,
        // up to the same 15 minutes a desk hand-off gets. The answer resumes this same run.
        const askPerson = async ({ text, options } = {}) => {
            const clean = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 300);
            const list = (Array.isArray(options) ? options : []).map((o) => String(o || '').replace(/\s+/g, ' ').trim().slice(0, 120)).filter(Boolean).slice(0, 4);
            if (!clean || list.length < 2) return null;
            // The promise is armed before the state flips, so an answer can never arrive before the run waits for it.
            const waiting = new Promise((resolve) => {
                asking.set(id, resolve);
                const onAbort = () => { asking.delete(id); resolve(null); };
                if (signal.aborted) { onAbort(); return; }
                signal.addEventListener('abort', onAbort, { once: true });
            });
            if (signal.aborted) { asking.delete(id); return null; }
            await emit(id, { kind: 'output', step: 'question', agent: LOOP_AGENT, text: clean, options: list });
            await setState(id, 'needs_you');
            await tellPerson(row, 'needs_you', { what: `answer: ${clean}`, url: `${config.baseUrl}/tasks/${id}` });
            waitForPerson(15 * 60_000);
            const answer = await waiting;
            asking.delete(id);
            if (answer == null) return null;
            await setState(id, 'running');
            await emit(id, { kind: 'output', step: 'answer', agent: LOOP_AGENT, text: String(answer).slice(0, 2000) });
            return answer;
        };
        const explanation = [];
        const tried = new Map();
        // The quality tier a hand-off may not go below: the tier of the best agent tried so far (catalog quality).
        let floor = null;
        const raise = (agent) => { if (agent && agent.quality === 'high') floor = 'high'; else if (agent && agent.quality === 'standard' && floor !== 'high') floor = 'standard'; };
        try {
            await setState(id, 'running', { cost_usd: 0, free_usd: 0 });
            // A task with no budget spends nothing: not even a classification call.
            if (budget <= 0) {
                return await setState(id, 'failed', { error_code: 'actor.budget.exceeded', error_detail: 'This task has a $0 budget, so nothing ran. Give it a budget above $0.', finished_at: iso() });
            }
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
            // Asked in a public chat (chat/asks.js): the answer is posted where everyone reads it, so only what needs
            // nothing of the person's own — never their computers, robots or code on their machine.
            const fromChat = row.via === 'chat';
            if (fromChat && !PUBLIC_CLASSES.includes(cls)) {
                return await setState(id, 'failed', { error_code: 'actor.task.not_public', error_detail: 'Asked in a public chat, Actor uses public tools only: ask on openvibe.actor to use your own computers, robots or code.', finished_at: iso() });
            }

            // Actor v2: every non-private task that is not code-only runs through the one loop. Private mode keeps
            // the local model with no network tools, and a coding task keeps the Codes agent (which the loop can also
            // reach as codes_task). Approval inbox, budgets, cancel, webhooks and the event stream are unchanged.
            if (loop && models && row.mode !== 'private' && cls !== 'code') {
                const agentId = LOOP_AGENT;
                // The person-authored part of the task (never a run input that may come from a watch or a webhook),
                // and the personal agent this run is for, so the memory tools scope their writes.
                const ownAgent = /^agent:agt_/.test(String(row.via || '')) ? row.via.slice(6) : null;
                const personText = ownAgent ? require('../agents/personal').personText(row.task)
                    : (row.via == null || row.via === 'chat' ? row.task : '');
                const notifyTask = (kind, detail) => tellPerson(row, kind, detail || {});
                explanation.push({ selected: agentId, objective: row.mode === 'best' ? 'correctness' : 'balanced', reasons: [`the one agent loop (${row.mode === 'best' ? 'best' : 'smart'} tier)`], candidates: [], decided_at: iso() });
                await store.updateTask(s, id, { explanation });
                await emit(id, { kind: 'output', step: 'plan', agent: agentId, text: 'The agent starts with a plan, then works through it.' });
                // A personal agent's run that would start coding work on its owner's machine asks first (approvals.js).
                const requestApproval = /^agent:agt_/.test(String(row.via || '')) ? async ({ kind, summary, payload }) => {
                    const ask = await approvals.request(s, { owner: row.requester, agentId: row.via.slice(6), taskId: id, kind, summary, payload });
                    const url = `${config.baseUrl}/me/approvals/${ask.id}`;
                    await emit(id, { kind: 'output', step: 'text', agent: agentId, text: `Your agent wants to ${summary.toLowerCase()} Nothing runs until you approve it: ${url}` });
                    await tellPerson(row, 'needs_you', { what: `approve: ${summary}`, url });
                    return { pending: true, id: ask.id, url };
                } : null;
                let out = null;
                const control = {};
                controls.set(id, control);
                try {
                    out = await loop.run({
                        task: row.task, requester: fromChat ? null : row.requester, taskId: id, mode: row.mode, signal,
                        context: row.parent_id ? await store.followContext(s, row) : [],
                        emit: (e) => emit(id, { kind: 'output', agent: agentId, ...e }),
                        meter, budgetLeft, waitForPerson, requestApproval,
                        personText, agentId: ownAgent, notifyTask,
                        askPerson, control,
                    });
                } catch (err) {
                    if (signal && signal.aborted) throw err;
                    const why = (err && err.message) || String(err);
                    const code = err && err.code === 'actor.model.unavailable' ? 'actor.model.unavailable' : err && err.code === 'actor.budget.exceeded' ? 'actor.budget.exceeded' : 'actor.agent.failed';
                    return await setState(id, 'failed', { error_code: code, error_detail: why.slice(0, 2000), finished_at: iso() });
                }
                try {
                    await setState(id, 'verifying', { agentForEvent: agentId });
                    const verify = async (current) => checkClaims({
                        task: row.task, answer: current.text, evidence: current.evidence, models,
                        writerFamily: current.family || null, signal, now: () => now(),
                        trace: current.state && current.state.ctx && current.state.ctx.trace,
                    });
                    let verdict = await verify(out);
                    await meter(verdict.cost_usd);
                    const showCheck = (v) => emit(id, { kind: 'output', step: 'check', agent: agentId, text: `${v.ok ? 'Checked' : 'Check failed'}${v.by ? ` by ${v.by}${v.cross ? '' : ' (same family)'}` : ''}: ${v.reason || ''}`.slice(0, 2000), is_error: !v.ok });
                    await showCheck(verdict);
                    // A live claim with no evidence never reaches the person: the loop gets one turn to fetch it or
                    // drop it, then the check runs again (at most config.loop.checkReflections passes by another family).
                    const maxRounds = config.loop && config.loop.checkReflections != null ? config.loop.checkReflections : 2;
                    let rounds = 0;
                    let escalated = false;
                    while (!verdict.ok && !verdict.unavailable && verdict.unsupported && verdict.unsupported.length && rounds < maxRounds && budgetLeft() > 0 && out.text) {
                        rounds += 1;
                        // Escalate first (stage V2-8): one tier up for this step, never the identical call. If no rung is
                        // available, the normal revision pass runs as before.
                        let revised = null;
                        if (!escalated) {
                            escalated = true;
                            revised = await loop.escalate(out, verdict.unsupported);
                        }
                        if (!revised || revised === out || !revised.text || revised.text === out.text) revised = await loop.revise(out, verdict.unsupported);
                        if (!revised || revised === out || !revised.text || revised.text === out.text) break;
                        out = revised;
                        verdict = await verify(out);
                        await meter(verdict.cost_usd);
                        await showCheck(verdict);
                    }
                    // Contested claims (stage V2-7b), "best" mode only: where the evidence disagrees, one judgement per
                    // claim (two at most) lays out the sides and picks the better-supported one; the page shows both.
                    let contested = [];
                    if (verdict.ok && row.mode === 'best' && Array.isArray(verdict.contested) && verdict.contested.length) {
                        const { adjudicate } = require('../runtime/adjudicate');
                        for (const c of verdict.contested.slice(0, 2)) {
                            if (budgetLeft() <= 0) break;
                            try {
                                const j = await adjudicate({ claim: c, evidence: out.evidence, task: row.task, models, writerFamily: out.family || null, signal, now: () => now(), trace: out.state && out.state.ctx && out.state.ctx.trace });
                                if (j) { await meter(j.cost_usd); if (!j.failed) contested.push({ claim: j.claim, sides: j.sides, pick: j.pick, reason: j.reason, by: j.by }); }
                            } catch (err) {
                                if (signal && signal.aborted) throw err;
                            }
                        }
                        if (contested.length) await emit(id, { kind: 'output', step: 'text', agent: agentId, text: `Sources disagree on ${contested.length} point${contested.length === 1 ? '' : 's'}; both sides are shown with the answer.` });
                    }
                    if (verdict.ok) {
                        // Confidence and the challenge (stage V2-8): grade every claim, counter-search the high-stakes
                        // ones at likely/unverified. It spends against the same task budget, and the page shows it.
                        const brain = out.brain || {};
                        let review = null;
                        if (Array.isArray(verdict.claims) && verdict.claims.length) {
                            const outward = !!(out.state && out.state.brain && out.state.brain.understanding && out.state.brain.understanding.outward);
                            try {
                                review = await confidence.review({
                                    claims: verdict.claims, evidence: out.evidence, task: row.task, mode: row.mode, models,
                                    outward, signal, trace: out.state && out.state.ctx && out.state.ctx.trace,
                                    budgetLeft, writerFamily: out.family || null, now: () => now(),
                                    search: async (query) => (registry
                                        ? registry.run('search_web', { query }, { config, log, signal, requester: row.requester, now })
                                        : { text: 'no search is configured', isError: true }),
                                });
                                await meter(review.cost_usd);
                                if (review.challenged) await emit(id, { kind: 'output', step: 'check', agent: agentId, text: `Challenged ${review.challenged} high-stakes claim${review.challenged === 1 ? '' : 's'} with a counter-evidence search; ${review.unsure} could not be confirmed.`.slice(0, 2000) });
                            } catch (err) {
                                if (signal && signal.aborted) throw err;
                                log.warn && log.warn('[Actor] confidence review failed (the checked answer is delivered):', (err && err.message) || err);
                            }
                        }
                        await learn.recordCheck({ store: s, kind: brain.kind || 'answer', tiers: brain.tiers || [], tools: brain.tools || [], ok: true, log, now: () => now() }).catch(() => {});
                        let answer = out.text;
                        if (row.via && /^agent:agt_/.test(row.via)) answer = await absorbClosingLines(answer, row, id);
                        const claims = review ? review.claims : (Array.isArray(verdict.claims) ? verdict.claims : []);
                        const confidenceCounts = claims.reduce((out2, c) => {
                            const k = c && c.confidence ? c.confidence : 'unverified';
                            out2[k] = (out2[k] || 0) + 1;
                            return out2;
                        }, { sure: 0, likely: 0, unverified: 0, unsure: 0 });
                        if (claims.some((c) => c && c.confidence === 'unsure')) answer += confidence.unsureLine(claims);
                        const artifacts = Array.isArray(out.artifacts) ? out.artifacts.slice(0, 20) : [];
                        const result = {
                            answer,
                            sources: out.sources || [],
                            agent: agentId,
                            model: out.model || null,
                            class: cls,
                            tier: out.tier || null,
                            checked: {
                                by: verdict.by, cross_family: !!verdict.cross, reason: verdict.reason,
                                claims: claims.length, grounded: claims.length - (verdict.unsupported ? verdict.unsupported.length : 0),
                                confidence: confidenceCounts,
                                claims_detail: claims.slice(0, 40).map((c) => ({
                                    claim: c.claim, kind: c.kind, confidence: c.confidence, high_stakes: !!c.high_stakes,
                                    evidence: c.evidence || [], ...(c.challenge ? { challenge: c.challenge } : {}),
                                })),
                            },
                            evidence: (review ? review.evidence : out.evidence) || [],
                            citations: out.citations || [],
                            artifacts,
                            plan: out.plan || null,
                            turns: out.turns || null,
                            brain,
                            ...(contested.length ? { contested } : {}),
                        };
                        // The files and charts travel with each tool result that made them (the loop's tool_result events),
                        // and the result carries them all; a live page shows them as they land.
                        return await setState(id, 'succeeded', { result, finished_at: iso() });
                    }
                    if (verdict.unavailable) {
                        return await setState(id, 'failed', { error_code: 'actor.check.unavailable', error_detail: `The answer could not be checked (${verdict.reason}), so it was not delivered.`, finished_at: iso() });
                    }
                    // The refused answer, kept on the task page folded away, never delivered as the answer.
                    await learn.recordCheck({ store: s, kind: (out.brain && out.brain.kind) || 'answer', tiers: (out.brain && out.brain.tiers) || [], tools: (out.brain && out.brain.tools) || [], ok: false, log, now: () => now() }).catch(() => {});
                    await emit(id, { kind: 'output', step: 'text', agent: agentId, text: String(out.text || '').slice(0, 8000), is_error: true });
                    const bad = (verdict.unsupported || []).slice(0, 5).map((c) => c.claim).join('; ');
                    return await setState(id, 'failed', {
                        error_code: 'actor.check.ungrounded',
                        error_detail: `The answer claimed ${(verdict.unsupported || []).length} live fact(s) with no evidence from its tools${bad ? ` (${bad})` : ''}, so it was not delivered.`.slice(0, 2000),
                        finished_at: iso(),
                    });
                } finally {
                    controls.delete(id);
                    await loop.close(out && out.state).catch(() => {});
                }
            }

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
                // The approval inbox (agents/approvals.js): a person's own agent, running while they are away, asks
                // before it starts a coding task on their machine. Nothing runs until they approve.
                if (agentId === 'codes' && /^agent:agt_/.test(String(row.via || '')) && codesRepoIn(row.task)) {
                    const ask = await approvals.request(s, {
                        owner: row.requester, agentId: row.via.slice(6), taskId: id, kind: 'codes.task',
                        summary: `Start a coding task on your machine in ${codesRepoIn(row.task)}`, payload: { task: row.task },
                    });
                    const url = `${config.baseUrl}/me/approvals/${ask.id}`;
                    await emit(id, { kind: 'output', step: 'text', agent: agentId, text: `Your agent wants to start a coding task on your own machine. Nothing runs until you approve it: ${url}` });
                    await tellPerson(row, 'needs_you', { what: `approve: start a coding task in ${codesRepoIn(row.task)}`, url });
                    const result = {
                        answer: `Your agent asked to start a coding task on your own machine (OpenVibe.Codes) in ${codesRepoIn(row.task)}. Nothing has run: approve or decline it at ${url}. The request expires in ${approvals.EXPIRES_DAYS} days.`,
                        sources: [url], agent: agentId, model: null, class: cls, approval: { id: ask.id, url },
                        checked: { by: 'none', cross_family: false, reason: 'Nothing was run: its owner decides first.' },
                    };
                    return await setState(id, 'succeeded', { result, finished_at: iso() });
                }
                await emit(id, { kind: 'output', step: attempt > 1 ? 'handoff' : 'plan', agent: agentId, text: `${agent.name} takes it${placement.reasons && placement.reasons[0] ? `: ${placement.reasons[0]}` : ''}.` });
                let out;
                try {
                    // From chat the runtime is never offered the person's own robots or computers (no requester for its tools).
                    out = await adapters.run[agentId]({ task: row.task, requester: fromChat ? null : row.requester, taskId: id, cls, mode: row.mode, signal, meter, budgetLeft, waitForPerson, emit: (e) => emit(id, { kind: 'output', agent: agentId, ...e }) });
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
                const verdict = await check({ task: row.task, answer: out.text, sources: out.sources || [], evidence: out.evidence || [], agentId, mode: row.mode, checkers: adapters.checkers, signal, now: () => now() });
                await meter(verdict.cost_usd);
                await emit(id, { kind: 'output', step: 'check', agent: agentId, text: `${verdict.ok ? 'Checked' : 'Check failed'}${verdict.by ? ` by ${verdict.by}${verdict.cross ? '' : ' (same family)'}` : ''}: ${verdict.reason || ''}`.slice(0, 2000), is_error: !verdict.ok });
                if (verdict.ok) {
                    let answer = out.text;
                    if (row.via && /^agent:agt_/.test(row.via)) answer = await absorbClosingLines(answer, row, id);
                    const result = { answer, sources: out.sources || [], agent: agentId, model: out.model || catalog.modelOf(agent, config) || null, class: cls, artifacts: Array.isArray(out.artifacts) ? out.artifacts : [], checked: { by: verdict.by, cross_family: !!verdict.cross, reason: verdict.reason } };
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
                return await setState(id, 'failed', { error_code: 'actor.task.timeout', error_detail: `The task ran longer than ${Math.round(timeoutMs / 1000)} seconds and was stopped.`, finished_at: iso() });
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
        // A task waiting for its one question is still running here (its run is in `running`); cancel must abort it.
        if (!row || !(store.OPEN.includes(row.state) || row.state === 'needs_you')) return row;
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

    return { submit, cancel, stop, status, answer, assume, MAX_ATTEMPTS };
}

module.exports = { createEngine, MAX_ATTEMPTS };

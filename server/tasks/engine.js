'use strict';

// The most a task's clock waits for its person, in all (Desks plan D4: hand_to_person).
const inputs = require('./inputs');
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
const modelPrefs = require('../runtime/model-prefs');
// The person's own model choice rides with the models layer (plan L55 C3). A stand-in models object (a test's)
// does not carry it, and a run then keeps today's behaviour.
const withChoice = (models, choice, fn) => (models && typeof models.withChoice === 'function' ? models.withChoice(choice, fn) : fn());
const catalog = require('../agents/catalog');
const { classify, heuristic } = require('../agents/classify');
const { route, whyNone } = require('../agents/router');
const { check } = require('../agents/check');
const { check: checkClaims } = require('../runtime/check');
const approvals = require('../agents/approvals');
const allows = require('../agents/allows');
const contacts = require('../agents/contacts');
const assignments = require('../agents/assignments');
const runTokens = require('../triggers/tokens');
const levels = require('../agents/levels');
const spend = require('../agents/spend');
const { repoIn: codesRepoIn } = require('../agents/codes');
const memory = require('../memory');
const taskNotices = require('../notify/task-notices');
const confidence = require('../runtime/brain/confidence');
const learn = require('../runtime/brain/learn');
const canvases = require('../canvases');

const MAX_ATTEMPTS = 2;
// The one loop's agent id on the event stream and in the result (the old runtime's id, kept for readers).
const LOOP_AGENT = 'openvibe-runtime';

// What a task asked in a public chat may be (chat/asks.js): nothing that uses the person's own computers, robots or code.
const PUBLIC_CLASSES = ['answer', 'lookup', 'research', 'web'];

function createEngine({ config, s, adapters, stream, webhooks = null, now = () => Date.now(), log = console, models = null, loop = null, notifier = null, registry = null, checkpoints = null, waits: waitsArg = null, triggers: triggersArg = null }) {
    const running = new Map();      // id → AbortController
    const waiting = [];
    // A question the loop asked before any tool ran (stage V2-8): the task waits in needs_you, the page shows the
    // question, and POST /tasks/:id/answer resumes this same run with the person's words.
    const asking = new Map();       // task id → resolve(answer)
    // The waits (plan A2): the notice and the event of a wait that ended, waiting for the run it
    // resumes. One per task: the task is queued again and the payload is taken when it starts.
    const wakes = new Map();
    let waits = waitsArg;
    // Triggers are created after the engine (they need it to run now); the app sets them once.
    let triggers = triggersArg;

    /**
     * The latency class a run asks AI's router for (plan BA track, HO3/HO4). A routine's run — a schedule, an
     * event or a goal — may wait, so it asks for "background": AI then picks the cheapest tier that can wait (a
     * Flex service tier, off-peak, or the host's own idle model). An interactive task asks for nothing and keeps
     * the router's normal choice. server/runtime/models.js sends the class only when ACTOR_AI_LATENCY_CLASSES is
     * on, so a server pointed at an AI still on the older contract (before options.latency) is never refused.
     */
    async function latencyClass(taskId) {
        const root = await s.db.maybe('SELECT origin FROM actor_assignments WHERE task_id = $1 AND depth = 0', [taskId]).catch(() => null);
        return root && root.origin === 'routine' ? 'background' : null;
    }
    const setTriggers = (t) => { triggers = t || null; };
    // An agent's answer to a letter (track HO6): the mail consumer turns a finished run into a reply or the person's
    // approval. Injected like the triggers, so the engine does not depend on the mail module.
    let mailReplies = null;
    const setMailReplies = (m) => { mailReplies = m || null; };
    const controls = new Map();     // task id → the run's control object (live assumptions)
    let stopped = false;
    let day = null;
    const setDay = (value) => { day = value; };

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
    async function absorbClosingLines(answer, row, taskId, out) {
        let text = answer;
        const personal = require('../agents/personal');
        const closing = [];
        for (let i = 0; i < 3; i++) {
            const match = text.match(/(?:^|\n)(REMEMBER|IMPROVE|SKILL_DRAFT): ([^\n]*)[ \t]*$/);
            if (!match) break;
            text = text.slice(0, match.index).trimEnd();
            closing.push({ kind: match[1], line: match[2].trim() });
        }
        const skill = closing.find((c) => c.kind === 'SKILL_DRAFT');
        const steps = out && out.brain && Array.isArray(out.brain.steps) ? out.brain.steps.filter((step) => step.step_kind === 'work' && step.ok).length : 0;
        if (skill && steps >= 3 && skill.line.length <= 5000) {
            try { await personal.addSkillProposal(s, row.requester, row.via.slice(6), JSON.parse(skill.line), taskId); } catch (err) { log.warn && log.warn('[Actor] skill draft refused:', err && err.message); }
        }
        for (const c of closing) {
            if (!c.line || c.line.length > 300) continue;
            if (c.kind === 'REMEMBER') await memory.add(s, { owner: row.requester, agentId: row.via.slice(6), text: c.line, source: 'agent', status: 'suggested', sourceTask: taskId });
            else if (c.kind === 'IMPROVE' && !(skill && steps >= 3)) await personal.addProposal(s, row.requester, row.via.slice(6), c.line, taskId);
        }
        return text;
    }

    // A step event names its assignment node (plan §12 A-2), so the Dock can draw the tree later. New tasks
    // carry the id on the row; an older task gets its root lazily here, once.
    const assignmentIds = new Map();
    async function assignmentIdFor(taskId, row = null) {
        if (assignmentIds.has(taskId)) return assignmentIds.get(taskId);
        let id = row && row.assignment_id;
        if (!id) {
            const task = row || await store.getTask(s, taskId);
            if (task) {
                const node = await assignments.ensureForTask(s, config, task).catch((err) => {
                    log.warn && log.warn('[Actor] assignment:', taskId, (err && err.message) || err);
                    return null;
                });
                id = node && node.id;
            }
        }
        if (id) assignmentIds.set(taskId, id);
        return id || null;
    }
    async function emit(id, body) {
        const event = { at: iso(), ...body };
        if (event.kind === 'output' && !event.assignment_id) {
            const assignmentId = await assignmentIdFor(id);
            if (assignmentId) event.assignment_id = assignmentId;
        }
        const saved = await store.appendEvent(s, id, event);
        if (day) await day.event(id, event);
        stream.publish(id, saved);
        return saved;
    }
    /**
     * A task's state, and everything that hangs off it.
     *
     * The task's own row is the signal everyone waits for: the Dock, the chat, the person's notification.
     * So everything a reader of that signal needs is written, and awaited, first — the event, the
     * assignment tree, the trigger's card and its answer in the thread, the notification — and the row
     * flips last. The PostgreSQL pool hands out its connections as they come, so a task that read
     * "succeeded" while its trigger's card still said "0 runs" would be a state that never existed;
     * PGlite, which keeps every statement in order, would never have shown it.
     */
    async function setState(id, state, { agentForEvent, ...patch } = {}) {
        const ended = ['succeeded', 'failed', 'cancelled'].includes(state);
        // The row as it will be once this state is written: the trigger's card and the notification read it.
        const before = await store.getTask(s, id);
        const row = before ? { ...before, ...patch, state } : null;
        if (row) {
            await emit(id, { kind: ended ? 'end' : 'state', state, ...(agentForEvent ? { agent: agentForEvent } : {}) });
            // The assignment tree follows the task it runs (plan §12 A-2), and its root's spend is written with it.
            await assignments.syncTaskState(s, row).catch((err) => log.warn && log.warn('[Actor] assignment state:', id, (err && err.message) || err));
            // A trigger's card follows its run: a failure streak grows, five in a row pause it, a success clears it.
            if (triggers) await triggers.taskState(row).catch((err) => log.warn && log.warn('[Actor] trigger state:', id, (err && err.message) || err));
            // A run that answered a letter settles that letter: sent, waiting for the person, or failed. Only a run
            // the mail consumer started has a row, so this is a no-op for every other task.
            if (mailReplies) await mailReplies(row).catch((err) => log.warn && log.warn('[Actor] mail reply:', id, (err && err.message) || err));
            // "Tell me when it's done" (stage V2-6): done or failed, once per task. Cancelled is the person's own action.
            // A routine's run is the exception (plan HO4): its answer already goes into the conversation that made the
            // trigger, so the person is told through notifications only when the routine asked for it.
            if (ended && (state === 'succeeded' || state === 'failed')) {
                const routine = triggers && typeof triggers.tellsPerson === 'function' ? await triggers.tellsPerson(row).catch(() => null) : null;
                if (routine !== false) await tellPerson(row, state);
            }
        }
        if (day && row) await day.taskState(row);
        const saved = await store.updateTask(s, id, { state, ...patch });
        if (ended) runTokens.drop(id);
        if (ended) stream.end(id);
        // Webhooks that asked for this state hear it; a delivery never holds the task up or fails it.
        if (webhooks && saved && saved.webhooks) {
            try {
                await webhooks.enqueue(id, state);
                if (ended) await webhooks.forgetSecretIfDone(id);
            } catch (err) { log.warn('[Actor] webhook enqueue failed:', id, err && err.message); }
        }
        return saved;
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

    /** Words for a running task (the chat's composer while it works): the run hears them at its next turn. */
    async function steer(id, text) {
        const control = controls.get(id);
        if (!control || typeof control.steer !== 'function') return { ok: false, reason: 'this task is not running' };
        return await control.steer(text);
    }

    function submit(id) {
        if (stopped || waiting.includes(id)) return;
        waiting.push(id);
        pump();
    }
    function pump() {
        while (!stopped && running.size < config.maxRunning && waiting.length) {
            const index = waiting.findIndex((id) => !running.has(id));
            if (index < 0) break;
            const [id] = waiting.splice(index, 1);
            const ac = new AbortController();
            running.set(id, ac);
            execute(id, ac.signal)
                .catch((err) => log.error('[Actor] task crashed:', id, err && err.message))
                .finally(() => { running.delete(id); pump(); });
        }
    }

    /**
     * The checkpoint a queued task continues from (stage V2-9), or null. A fork starts from its parent's checkpoint at
     * fork_of_step until it has one of its own; a task the boot resumed uses its own newest one. A task that was only
     * ever queued has neither and starts fresh.
     */
    function parseJson(value) {
        if (value == null) return null;
        return typeof value === 'string' ? JSON.parse(value) : value;
    }
    async function loadStart(row, { boot = false } = {}) {
        if (!checkpoints || !checkpoints.enabled || !row) return null;
        const last = async (id) => {
            try { return await checkpoints.last(id); } catch (err) { log.warn && log.warn('[Actor] checkpoint could not be opened (the task is not re-run blind):', row.id, (err && err.message) || err); return null; }
        };
        if (row.fork_of_step != null) {
            const own = await last(row.id);
            if (own) return { kind: 'resume', checkpoint: own };
            let start = null;
            try { start = await checkpoints.at(row.parent_id, Number(row.fork_of_step)); } catch (err) { log.warn && log.warn('[Actor] fork checkpoint could not be opened:', row.id, (err && err.message) || err); }
            if (start) return { kind: 'fork', checkpoint: start, step: Number(row.fork_of_step), change: parseJson(row.fork_change) };
            return null;
        }
        // At boot, any open task may have a checkpoint (the row's `resumes` counts resumes already made, and a task
        // that was interrupted for the first time has none yet). While executing, only a task the boot requeued does.
        if (boot || Number(row.resumes) > 0) {
            const own = await last(row.id);
            if (own) return { kind: 'resume', checkpoint: own };
        }
        return null;
    }

    async function execute(id, signal) {
        const row = await store.getTask(s, id);
        if (!row || row.state !== 'queued') return;
        const dayRun = day ? await day.run(id) : null;
        if (dayRun && !dayRun.enabled) return setState(id, 'cancelled', { finished_at: iso() });
        const start = await loadStart(row);
        const resume = start && start.kind === 'resume' ? { step: start.checkpoint.step, state: start.checkpoint.state } : null;
        const fork = start && start.kind === 'fork' ? { step: start.step, checkpoint: start.checkpoint, change: start.change } : null;
        // A resumed task keeps what it already spent; a fork has its own budget from zero (the parent's spend is not its).
        const budget = Number(row.budget_task);
        let spent = resume && resume.state ? Math.max(Number(row.cost_usd) || 0, Number(resume.state.spent) || 0) : (Number(row.cost_usd) || 0);
        const unrecoverable = (Number(row.resumes) > 0 && !resume) || (row.fork_of_step != null && !resume && !fork);
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
        // A task that waited (plan A2) keeps the wall clock it had left when it parked: the wait was not its
        // time to spend. Its budget clock stops while it waits, because no model runs.
        let timeoutMs = Math.max(10_000, Number(row.timeout_ms) || config.taskTimeoutMs);
        const parked = waits ? await waits.remaining(id) : null;
        if (parked) timeoutMs = Math.max(10_000, Math.min(timeoutMs, parked));
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
        const askPerson = async ({ text, options, questionKind = 'question', tool = null, input = null } = {}) => {
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
            // `question_kind: 'acting'` is the resume card (stage V2-9): the run stopped inside an action and the person
            // chooses whether to run it again, believe it happened, or stop. The event itself stays actor.task-event.
            await emit(id, {
                kind: 'output', step: 'question', agent: LOOP_AGENT, text: clean, options: list,
                ...(questionKind === 'acting' ? { question_kind: 'acting', tool: tool || null, input: input || null } : {}),
            });
            // The person is told before the task says it needs them: a reader that sees the task waiting
            // for an answer must find the notification already sent, the same way the run's own end is
            // published last (see setState).
            await tellPerson(row, 'needs_you', { what: `${questionKind === 'acting' ? 'choose for an interrupted action' : 'answer'}: ${clean}`, url: `${config.baseUrl}/tasks/${id}` });
            await setState(id, 'needs_you');
            waitForPerson(15 * 60_000);
            const answer = await waiting;
            asking.delete(id);
            if (answer == null) return null;
            await setState(id, 'running');
            await emit(id, { kind: 'output', step: 'answer', agent: LOOP_AGENT, text: String(answer).slice(0, 2000) });
            return answer;
        };
        // The contact this task runs as and the level its steps run at (A-1). The agent is the thread's own, else the
        // personal agent that started it, else the person's Vibe. Another person's or a service's work has no contact.
        let taskAgent = null;
        let taskLevel = 'ask';
        let assignment = null;
        try {
            taskAgent = await contacts.agentForTask(s, config, row);
            taskLevel = await contacts.effectiveLevelFor(s, row, taskAgent);
            assignment = await assignments.ensureForTask(s, config, row);
            if (assignment && assignment.effective_level) taskLevel = assignment.effective_level;
        } catch (err) {
            log.warn && log.warn('[Actor] task agent/level:', id, (err && err.message) || err);
        }
        // HO7: what this agent may spend this week. The spending tool is offered only when the person set a
        // weekly allowance on the agent's page (0 = off: the tool is not there at all).
        const spendAllowance = taskAgent
            ? await spend.allowance(s, row.requester, taskAgent.id).catch(() => null)
            : null;
        // Both execution paths get the same gate and assignment callbacks: the one loop passes them into its
        // tools, and an adapter that starts a Codes task gets them too.
        let requestApproval = null;
        let assign = null;
        let closeAssignment = null;
        // One place every approval gate asks through: the level, then the always-ask floor, then (for approve-for-me)
        // a reviewer model of another family. Returns { asked: false } when the step may go ahead.
        // A standing permission the person gave for this exact kind and target (plan HO1) is read here: it lets the
        // step go on, and it never covers the floor.
        const askForApproval = async ({ kind, summary, payload, category = null, act = 'act', recipientKnown = null, agent = LOOP_AGENT, target = null, spendStep = false }) => {
            const categories = levels.classify({ category, summary, payload, recipientKnown });
            // HO7: money is the person's own. Before a tip reaches them, its recipient is resolved (a person
            // usr_… or a creator's OpenVibe page) and the agent's weekly allowance is checked. An ask that
            // cannot pay is refused here, with one plain line, and the person never sees a card for it.
            let money = null;
            if (kind === 'money' && spendStep) {
                money = await spend.prepare({ config, s, owner: row.requester, agentId: taskAgent ? taskAgent.id : null, payload });
                if (!money.ok) return { asked: false, decision: { ask: false }, refusal: money.message };
            }
            const rules = taskAgent ? await allows.list(s, row.requester, taskAgent.id) : [];
            const scopedTarget = kind === 'device.notify' && taskAgent ? taskAgent.name : target;
            const decision = await levels.decide({ level: taskLevel, categories, act, models, summary, payload, signal, allow: { kind, target: scopedTarget, rules } });
            if (!decision.ask) return { asked: false, decision };
            const ask = await approvals.request(s, { owner: row.requester, agentId: taskAgent ? taskAgent.id : null, taskId: id, kind, summary: money ? money.summary : summary, payload: money ? money.payload : payload, target: scopedTarget, categories });
            const url = `${config.baseUrl}/me/approvals/${ask.id}`;
            const shown = money ? money.summary : summary;
            await emit(id, { kind: 'output', step: 'text', agent, text: `Your agent wants to ${String(shown).toLowerCase()} Nothing runs until you approve it: ${url}` });
            await tellPerson(row, 'needs_you', { what: `approve: ${shown}`, url });
            return { asked: true, decision, ask, url };
        };
        // A child hand-off (a sub-agent's consult, a Codes task, a Space action) is one node below this task's.
        // The root's budget decides whether it may start at all: when it is spent, nothing below it starts.
        assign = assignment ? async (spec = {}) => {
            try {
                return await assignments.openChild(s, { owner: row.requester, parent: assignment, taskId: id, agentId: taskAgent ? taskAgent.id : null, ...spec });
            } catch (err) {
                log.warn && log.warn('[Actor] assignment child:', id, (err && err.message) || err);
                return { error: 'the assignment could not be recorded, so nothing ran', status: 500, code: 'actor.assignment.failed' };
            }
        } : null;
        closeAssignment = async (nodeId, state) => {
            try { return await assignments.closeChild(s, row.requester, nodeId, state); }
            catch (err) { log.warn && log.warn('[Actor] assignment close:', nodeId, (err && err.message) || err); return null; }
        };
        const explanation = [];
        const tried = new Map();
        // The quality tier a hand-off may not go below: the tier of the best agent tried so far (catalog quality).
        let floor = null;
        const raise = (agent) => { if (agent && agent.quality === 'high') floor = 'high'; else if (agent && agent.quality === 'standard' && floor !== 'high') floor = 'standard'; };
        try {
            // A resume keeps what the run already spent; a fresh task starts its counter at zero.
            await setState(id, 'running', resume ? {} : { cost_usd: 0, free_usd: 0 });
            if (unrecoverable) {
                const why = row.fork_of_step != null
                    ? 'The step this fork starts from is no longer saved, so it was not started. Fork it again.'
                    : 'The saved step of this task could not be read, so it was not re-run from the beginning. Ask again.';
                return await setState(id, 'failed', { error_code: 'actor.task.interrupted', error_detail: why, finished_at: iso() });
            }
            // A task with no budget spends nothing: not even a classification call. A resumed task whose saved step is
            // already an answer is still delivered (it owes nothing more).
            if (budget <= 0 && !(resume && resume.state && resume.state.answered)) {
                return await setState(id, 'failed', { error_code: 'actor.budget.exceeded', error_detail: 'This task has a $0 budget, so nothing ran. Give it a budget above $0.', finished_at: iso() });
            }
            // What kind of task this is. Private mode never sends the text anywhere to find out. A resumed run already
            // chose its route, so it does not pay to classify again.
            let cls;
            if (resume || fork) {
                cls = 'answer';
                await emit(id, { kind: 'output', step: 'plan', text: resume ? `Continuing from step ${resume.step}.` : `Starting from step ${fork.step} of the original run.` });
            } else if (row.mode === 'private' || !adapters.checkers.deepseek) {
                cls = heuristic(row.task);
            } else {
                const c = await classify(row.task, { chat: adapters.checkers.deepseek, signal });
                await meter(c.cost_usd);
                cls = c.class;
            }
            if (!resume && !fork) await emit(id, { kind: 'output', step: 'plan', text: `This is a "${cls}" task.` });
            // Asked in a public chat (chat/asks.js): the answer is posted where everyone reads it, so only what needs
            // nothing of the person's own — never their computers, robots or code on their machine.
            const chatContext = await s.db.maybe('SELECT * FROM actor_chat_tasks WHERE task_id = $1', [id]);
            const chatPolicy = chatContext ? chatContext.policy : null;
            const fromChat = row.via === 'chat' || (chatPolicy && chatPolicy !== 'dm');
            if (chatPolicy && (!loop || !models)) return await setState(id, 'failed', { error_code: 'actor.chat.unavailable', error_detail: 'The chat agent is unavailable.', finished_at: iso() });
            if (fromChat && !chatPolicy && !PUBLIC_CLASSES.includes(cls)) {
                return await setState(id, 'failed', { error_code: 'actor.task.not_public', error_detail: 'Asked in a public chat, Actor uses public tools only: ask on openvibe.actor to use your own computers, robots or code.', finished_at: iso() });
            }
            // Where the person's tasks run (plan L55 C3, /chat/model): 'computer' sends every model call of the loop to
            // the model on their own computer, and a coding task to Codes on their machine. Never in private mode (the
            // open model on OpenVibe's server is the point) nor for a public chat's ask.
            const runsOn = row.mode === 'private' || fromChat || !String(row.requester || '').startsWith('user:')
                ? 'openvibe' : await modelPrefs.runsOnFor(s, row.requester).catch(() => 'openvibe');

            // Actor v2: every non-private task that is not code-only runs through the one loop. Private mode keeps
            // the local model with no network tools, and a coding task keeps the Codes agent (which the loop can also
            // reach as codes_task). Approval inbox, budgets, cancel, webhooks and the event stream are unchanged.
            if (loop && models && row.mode !== 'private' && (cls !== 'code' || chatPolicy || dayRun)) {
                const agentId = LOOP_AGENT;
                // The person-authored part of the task (never a run input that may come from a watch or a webhook),
                // and the personal agent this run is for, so the memory tools scope their writes.
                const ownAgent = chatContext && chatPolicy === 'dm' ? chatContext.agent_id : /^agent:agt_/.test(String(row.via || '')) ? row.via.slice(6) : null;
                const personText = ownAgent ? require('../agents/personal').personText(row.task)
                    : (row.via == null || row.via === 'chat' ? row.task : '');
                const notifyTask = (kind, detail) => tellPerson(row, kind, detail || {});
                const why = resume ? `the one agent loop resumed after a restart (step ${resume.step})`
                    : fork ? `the one agent loop forked from step ${fork.step}`
                        : runsOn === 'computer' ? 'the one agent loop, thinking on the model on your computer (Runs on: my computer)'
                            : `the one agent loop (${row.mode === 'best' ? 'best' : 'smart'} tier)`;
                explanation.push({ selected: agentId, objective: row.mode === 'best' ? 'correctness' : 'balanced', reasons: [why], candidates: [], decided_at: iso() });
                await store.updateTask(s, id, { explanation });
                if (!resume && !fork) await emit(id, { kind: 'output', step: 'plan', agent: agentId, text: 'The agent starts with a plan, then works through it.' });
                // A task that would start coding work on the person's machine asks through the same gate (levels.js):
                // the level first, then the always-ask floor. Full access or auto-edits may let an edit through; a
                // payment, password, deletion or a new recipient never does.
                requestApproval = taskAgent ? async ({ kind, summary, payload, category = null, act = 'act', recipientKnown = null, target = null, spend = false }) => {
                    const out = await askForApproval({ kind, summary, payload, category, act, recipientKnown, target, spendStep: spend });
                    // A refusal (plan HO7): the step does not run and the model is told why.
                    if (out.refusal) return { refused: out.refusal };
                    if (!out.asked) return null;
                    return { pending: true, id: out.ask.id, url: out.url };
                } : null;
                // The wait that ended (plan A2), if this run was woken by one: the notice, and the event as data.
                const wakePayload = wakes.get(id) || (dayRun ? await day.wakePayload(id) : null);
                if (wakePayload) wakes.delete(id);
                let out = null;
                const control = {};
                controls.set(id, control);
                // The files attached to this message in the chat (plan L55 C2): text as data; images described first.
                const attachments = await inputs.forRun(s, id, { models, meter, signal, log }).catch((err) => { log.warn('[Actor] attachments:', err && err.message); return []; });
                // The person's own model choice for this run (plan L55 C3): their own key, through OpenVibe.AI.
                // Every model call of the run — the loop's, the plan's, the check's — reads it, and no other run's does.
                let choice = await modelPrefs.choiceFor(s, row.requester).catch(() => null);
                if (dayRun && dayRun.brain !== 'auto') choice = { subject: row.requester.slice(5), model: dayRun.brain };
                // "Runs on: my computer": the model on the person's computer, whatever else they chose above it (a
                // model id they gave for their computer is kept).
                if (runsOn === 'computer' && !(choice && choice.provider === 'node')) choice = modelPrefs.computerChoice(row.requester);
                // The person the task belongs to rides on every router call (on_behalf_of): their allowance pays,
                // even when they chose no key. A task with no person (a watch, a webhook) names nobody, and AI
                // serves it from free or untolled capacity only.
                if (!choice || !choice.subject) {
                    const subject = String(row.requester || '').startsWith('user:') ? row.requester.slice(5) : null;
                    if (subject) choice = { ...(choice || {}), subject };
                }
                try {
                    // The conversation so far, and any canvas tick the person made since the last turn (HO9): a
                    // tick starts no turn by itself, so the next run is told which item changed.
                    const context = row.parent_id && row.fork_of_step == null && !resume ? await store.followContext(s, row) : [];
                    if (!resume && !fork) context.push(...await canvases.takeNoticesForTask(s, row));
                    out = await withChoice(models, choice, async () => loop.run({
                        task: row.task, requester: fromChat ? null : row.requester, taskId: id, mode: row.mode, signal,
                        // A fork carries its parent's state in the checkpoint, not as a follow-up conversation.
                        context,
                        emit: (e) => emit(id, { kind: 'output', agent: agentId, ...e }),
                        // The answer as it is written (plan L55 C2): to the readers that asked, never stored.
                        // The loop streams a model call only while such a reader is there (wanted).
                        delta: typeof stream.delta === 'function' ? Object.assign((d) => stream.delta(id, d), { wanted: () => stream.wants(id) }) : null,
                        meter, budgetLeft, waitForPerson, requestApproval, assign, closeAssignment, day: dayRun ? day : null,
                        chatPolicy, approveChatTool: chatPolicy ? (tool, input) => require('../chat-apps/policy').approve(s, { taskId: id, owner: row.requester, tool, input, signal }) : null,
                        personText, agentId: ownAgent, notifyTask,
                        askPerson, control, resume, fork, spent: () => spent,
                        waits, waitEvent: wakePayload, attachments,
                        // What this agent may spend this week (plan HO7): the spending tool is offered only
                        // when the person set a weekly allowance on the agent's page.
                        spend: spendAllowance,
                        // A routine's or a goal's run may wait (plan BA/HO): the class it asks AI's router for.
                        latency: await latencyClass(id),
                    }));
                    // The run parked (plan A2): the wait is open, so the task is not finished. It stays open
                    // ('running' is the closest state there is today), its wall clock waits with it, and its
                    // budget clock stops because no model runs while it waits. The desk is closed with the run.
                    if (out && out.parked) {
                        const wait = waits ? await waits.get(out.parked.wait_id) : null;
                        const left = Math.max(0, ends - Date.now());
                        if (wait) await waits.setRemaining(wait.id, left);
                        if (dayRun) await day.segmentEnd(id);
                        // The desk goes with the run: while the task waits, nothing holds it.
                        await loop.close(out && out.state).catch(() => {});
                        await emit(id, { kind: 'output', step: 'text', agent: agentId, text: 'Waiting: ' + (wait ? wait.line : 'for something') + '. Nothing runs until it arrives or the deadline passes.' });
                        return undefined;
                    }
                } catch (err) {
                    if (signal && signal.aborted) throw err;
                    // The person chose "Stop the task" on an interrupted action (stage V2-9): end it cancelled, not failed.
                    if (err && err.code === 'actor.task.cancelled') return await setState(id, 'cancelled', { finished_at: iso() });
                    const detail = (err && err.message) || String(err);
                    const code = err && err.code === 'actor.model.unavailable' ? 'actor.model.unavailable'
                        : err && err.code === 'actor.budget.exceeded' ? 'actor.budget.exceeded'
                            : err && err.code === 'actor.checkpoint.invalid' ? 'actor.checkpoint.invalid'
                                : err && err.code === 'actor.acting.unresolved' ? 'actor.acting.unresolved'
                                    // An exact AI Exchange id AI refused (PLAN G-P9): the person sees AI's own error.
                                    : err && (err.code === 'ai.model_not_found' || err.code === 'ai.model_unavailable') ? err.code
                                        : 'actor.agent.failed';
                    return await setState(id, 'failed', { error_code: code, error_detail: detail.slice(0, 2000), finished_at: iso() });
                }
                try {
                    await setState(id, 'verifying', { agentForEvent: agentId });
                    const verify = async (current) => withChoice(models, choice, () => checkClaims({
                        task: row.task, answer: current.text, evidence: current.evidence, models,
                        writerFamily: current.family || null, signal, now: () => now(),
                        trace: current.state && current.state.ctx && current.state.ctx.trace,
                    }));
                    let verdict = await verify(out);
                    await meter(verdict.cost_usd);
                    const showCheck = (v) => emit(id, { kind: 'output', step: 'check', agent: agentId, text: `${v.ok ? 'Checked' : 'Check failed'}${v.by ? ` by ${v.by}${v.cross ? '' : ' (same family)'}` : ''}: ${v.reason || ''}`.slice(0, 2000), is_error: !v.ok });
                    await showCheck(verdict);
                    // The last progress ledger for a task that will not deliver (stage V2-8 review): done no, no next,
                    // and the reason it stopped. A delivered task keeps the loop's final "done" ledger.
                    const finalPlan = async (stopped) => {
                        const brain = out && out.state && out.state.brain;
                        if (!brain || !brain.progressLedger || !out.plan) return;
                        const progress = brain.progressLedger.finish({ done: false, stopped });
                        brain.progress = progress;
                        await emit(id, { kind: 'output', step: 'plan', agent: agentId, text: loop.planText(out.plan, { ledger: brain.ledger, progress }) });
                    };
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
                                const j = await withChoice(models, choice, () => adjudicate({ claim: c, evidence: out.evidence, task: row.task, models, writerFamily: out.family || null, signal, now: () => now(), trace: out.state && out.state.ctx && out.state.ctx.trace }));
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
                                review = await withChoice(models, choice, () => confidence.review({
                                    claims: verdict.claims, evidence: out.evidence, task: row.task, mode: row.mode, models,
                                    outward, signal, trace: out.state && out.state.ctx && out.state.ctx.trace,
                                    budgetLeft, writerFamily: out.family || null, now: () => now(),
                                    search: async (query) => (registry
                                        ? registry.run('search_web', { query }, { config, log, signal, requester: row.requester, now })
                                        : { text: 'no search is configured', isError: true }),
                                }));
                                await meter(review.cost_usd);
                                if (review.challenged) await emit(id, { kind: 'output', step: 'check', agent: agentId, text: `Challenged ${review.challenged} high-stakes claim${review.challenged === 1 ? '' : 's'} with a counter-evidence search; ${review.unsure} could not be confirmed.`.slice(0, 2000) });
                            } catch (err) {
                                if (signal && signal.aborted) throw err;
                                log.warn && log.warn('[Actor] confidence review failed (the checked answer is delivered):', (err && err.message) || err);
                            }
                        }
                        await learn.recordCheck({ store: s, kind: brain.kind || 'answer', tiers: brain.tiers || [], tools: brain.tools || [], ok: true, log, now: () => now() }).catch(() => {});
                        let answer = out.text;
                        if (row.via && /^agent:agt_/.test(row.via)) answer = await absorbClosingLines(answer, row, id, out);
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
                        await finalPlan('the answer could not be checked');
                        return await setState(id, 'failed', { error_code: 'actor.check.unavailable', error_detail: `The answer could not be checked (${verdict.reason}), so it was not delivered.`, finished_at: iso() });
                    }
                    // The refused answer, kept on the task page folded away, never delivered as the answer.
                    await learn.recordCheck({ store: s, kind: (out.brain && out.brain.kind) || 'answer', tiers: (out.brain && out.brain.tiers) || [], tools: (out.brain && out.brain.tools) || [], ok: false, log, now: () => now() }).catch(() => {});
                    await finalPlan('its answer failed the check');
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

            // "Runs on: my computer" (plan L55 C3): a coding task goes to the codes agent, OpenVibe.Codes on the person's
            // own paired machine, unless the task already names its agent.
            const pinnedAgent = row.agent || (runsOn === 'computer' && cls === 'code' ? 'codes' : null);
            for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
                const placement = route({ cls, mode: row.mode, agent: pinnedAgent, budgetUsd: Math.max(0, budgetLeft()), config, tried, now: now(), floor: row.mode === 'private' ? null : floor });
                explanation.push(placement);
                await store.updateTask(s, id, { explanation });
                if (!placement.selected) {
                    if (attempt > 1) break;
                    const why = pinnedAgent === 'codes' && !row.agent
                        ? { code: 'actor.no_agent', detail: 'Your coding tasks run on your own machine (Runs on: my computer) through OpenVibe.Codes, and it is not connected here. Add your machine on https://openvibe.bot/machines, or switch Runs on back to OpenVibe at https://openvibe.actor/chat/model.' }
                        : whyNone(placement, { cls, mode: row.mode, budgetUsd: budgetLeft() });
                    return await setState(id, 'failed', { error_code: why.code, error_detail: why.detail, finished_at: iso() });
                }
                const agentId = placement.selected;
                const agent = catalog.byId(agentId);
                // The approval gate (levels.js + agents/approvals.js): a coding task on the person's machine asks at ask
                // and for the always-ask floor; auto-edits lets the edit through, full access skips the gate, and
                // approve-for-me asks a reviewer of another family first.
                if (agentId === 'codes' && taskAgent && codesRepoIn(row.task)) {
                    const asked = await askForApproval({
                        kind: 'codes.task', summary: `Start a coding task on your machine in ${codesRepoIn(row.task)}`,
                        payload: { task: row.task }, act: 'edit', agent: agentId, target: require('../agents/actions').repoTarget(codesRepoIn(row.task)),
                    });
                    if (asked.asked) {
                        const result = {
                            answer: `Your agent asked to start a coding task on your own machine (OpenVibe.Codes) in ${codesRepoIn(row.task)}. Nothing has run: approve or decline it at ${asked.url}. The request expires in ${approvals.EXPIRES_DAYS} days.`,
                            sources: [asked.url], agent: agentId, model: null, class: cls, approval: { id: asked.ask.id, url: asked.url },
                            checked: { by: 'none', cross_family: false, reason: 'Nothing was run: its owner decides first.' },
                        };
                        return await setState(id, 'succeeded', { result, finished_at: iso() });
                    }
                }
                await emit(id, { kind: 'output', step: attempt > 1 ? 'handoff' : 'plan', agent: agentId, text: `${agent.name} takes it${placement.reasons && placement.reasons[0] ? `: ${placement.reasons[0]}` : ''}.` });
                let out;
                try {
                    // From chat the runtime is never offered the person's own robots or computers (no requester for its tools).
                    out = await adapters.run[agentId]({ task: row.task, requester: fromChat ? null : row.requester, taskId: id, cls, mode: row.mode, signal, meter, budgetLeft, waitForPerson, requestApproval, assign, closeAssignment, emit: (e) => emit(id, { kind: 'output', agent: agentId, ...e }) });
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
                    if (row.via && /^agent:agt_/.test(row.via)) answer = await absorbClosingLines(answer, row, id, out);
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
        else if (day && await day.run(id)) return setState(id, 'cancelled', { finished_at: iso() });
        return store.getTask(s, id);
    }

    /**
     * Boot (stage V2-9): what a stopped process left open. A queued task that never ran is started again; a task that
     * was running resumes from its newest checkpoint; a task with no checkpoint (or past the resume cap) is failed as
     * before, with its webhooks told. Without ACTOR_CHECKPOINT_KEY this is exactly the old failInterrupted.
     *
     * Returns { resumed, failed, requeued } for the boot log.
     */
    async function resumeInterrupted() {
        const rows = await store.openTasks(s);
        if (!checkpoints || !checkpoints.enabled) {
            const failed = await store.failInterrupted(s);
            for (const id of failed) await enqueueFailed(id);
            return { resumed: [], failed, requeued: [] };
        }
        const max = config.checkpoints && config.checkpoints.maxResumes != null ? config.checkpoints.maxResumes : 2;
        const resumed = [];
        const requeued = [];
        const capped = [];
        const failed = [];
        for (const row of rows) {
            // A task that is waiting (plan A2) is not interrupted: it waits for its event or its deadline.
            if (waits && await waits.hasOpenWait(row.id)) continue;
            const start = await loadStart(row, { boot: true });
            if (!start) {
                if (row.state === 'queued' && !Number(row.resumes)) {
                    requeued.push(row.id);
                    submit(row.id);
                } else {
                    failed.push(row.id);
                }
                continue;
            }
            const resumes = Number(row.resumes) || 0;
            if (resumes >= max) {
                capped.push(row.id);
                continue;
            }
            await store.updateTask(s, row.id, { state: 'queued', resumes: resumes + 1, finished_at: null });
            await emit(row.id, { kind: 'state', state: 'queued' });
            resumed.push(row.id);
            submit(row.id);
        }
        const cappedDetail = 'Actor was interrupted twice while this task ran, so it was not resumed a third time (interrupted twice). Ask again.';
        const gone = capped.length ? await store.failInterrupted(s, { ids: capped, detail: cappedDetail }) : [];
        const lost = failed.length ? await store.failInterrupted(s, { ids: failed }) : [];
        for (const id of [...gone, ...lost]) await enqueueFailed(id);
        return { resumed, failed: [...gone, ...lost], requeued };
    }

    async function enqueueFailed(id) {
        if (!webhooks) return;
        try { await webhooks.enqueue(id, 'failed'); } catch (err) { log.warn && log.warn('[Actor] webhook enqueue failed:', id, (err && err.message) || err); }
    }

    /**
     * Shutdown: running tasks are aborted and left open (their rows stay running/verifying, so the next boot can resume
     * from the last checkpoint); queued tasks wait for that boot too. Without a checkpoint key they are failed at the
     * next boot by resumeInterrupted, as before.
     */
    async function stop() {
        stopped = true;
        for (const ac of running.values()) ac.abort('shutdown');
        waiting.length = 0;
    }

    /**
     * A wait ended and the task goes back to the queue (plan A2). The run starts again from its checkpoint; the
     * notice (and the event, as untrusted data) reaches the model through the loop. The task's budget, its
     * allow-list and its permissions are exactly what they were: a wait never widens anything.
     */
    async function resumeWithEvent(taskId, payload) {
        const row = await store.getTask(s, taskId);
        if (!row || !store.OPEN.includes(row.state)) return null;
        const resumes = Number(row.resumes) || 0;
        await store.updateTask(s, taskId, { state: 'queued', resumes: resumes + 1, finished_at: null });
        wakes.set(taskId, payload || {});
        await emit(taskId, { kind: 'state', state: 'queued' });
        submit(taskId);
        return row;
    }

    /** The same, with only a notice (a cancelled wait, a deadline that passed). */
    const resumeWithNotice = (taskId, notice) => resumeWithEvent(taskId, { event: null, notice });

    /** A wait that timed out with on_timeout 'fail' ends the task. */
    async function failTask(taskId, code, detail) {
        const row = await store.getTask(s, taskId);
        if (!row || !store.OPEN.includes(row.state)) return null;
        return setState(taskId, 'failed', { error_code: code, error_detail: String(detail || '').slice(0, 2000), finished_at: iso() });
    }

    /** The person is told that a wait timed out. */
    async function notifyWaitTimeout(wait) {
        const row = await store.getTask(s, wait.task_id);
        if (!row) return null;
        return tellPerson(row, 'needs_you', { what: 'the wait for "' + wait.line + '" timed out', url: config.baseUrl + '/tasks/' + wait.task_id });
    }

    /** The waits module is created after the engine (it resumes tasks), so it is set here. */
    function setWaits(module) { waits = module; return module; }

    const status = () => ({ running: running.size, waiting: waiting.length });

    return { submit, cancel, stop, status, answer, assume, steer, resumeInterrupted, resumeWithEvent, resumeWithNotice, failTask, notifyWaitTimeout, setWaits, setTriggers, setMailReplies, setDay, MAX_ATTEMPTS };
}

module.exports = { createEngine, MAX_ATTEMPTS };

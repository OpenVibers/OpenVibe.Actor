'use strict';

/**
 * GET /api/v1/runs — the one agent system's read-only view of Actor's runs, in the Contracts `agents.run@1` and
 * `agents.step@1` shapes (docs/agents-runs.md in OpenVibe.Contracts). Actor's task is the run: the person's own
 * tasks are the runs they may read, and a run's task events are its steps.
 *
 *   GET /api/v1/runs                actor.task.list   the person's runs, newest first (limit, before, status, agent)
 *   GET /api/v1/runs/:id            actor.task.read   one run
 *   GET /api/v1/runs/:id/steps      actor.task.read   its steps after ?after= (an append-only log, never renumbered)
 *
 * Conversations (2026-11-15, the owner: "it's supposed to use the actor even when you're on here … your main actor
 * … instead of vibe character"): the menu, openvibe.chat and every site talk to the person's Actor through these
 * routes, by way of Network's /api/frame/runs. With ?conversations=1 (the list) or ?conversation=1 (one run, its
 * steps) a run is a whole conversation: its first turn's id, every turn's messages and steps in order, and its
 * status from the newest turn (a finished turn waits for the person's next message).
 *   POST /api/v1/runs               actor.task.create  { text, agent?, idempotency_key? }: a new conversation
 *                                                      (a body with `skill` is the catalogue's skill run, below)
 *   POST /api/v1/runs/:id/messages  actor.task.create  { text, model?, engine? }: the next turn, from the newest one;
 *                                                      `engine` ({ kind, model?, harness? }, or 'auto') swaps the way the
 *                                                      conversation is worked from this turn on (server/engines)
 *   POST /api/v1/runs/:id/stop      actor.task.create  stops the turn under way
 *   PATCH /api/v1/runs/:id          actor.task.create  names the conversation ({ title }; empty gives it back)
 *
 * A person's Network token (or this site's session) only: an app's token gets the same 404 as another person's run,
 * so nothing confirms that a run exists. Read-only: creating, stopping and answering an approval are the engine's
 * later routes and are not here. No table changes.
 */
const contracts = require('openvibe-contracts');
const { asyncRouter } = require('./router');
const store = require('../tasks/store');
const catalog = require('../agents/catalog');
const canvases = require('../canvases');
const { createTask } = require('../tasks/create');

const TASK_ID = /^tsk_[0-9A-HJKMNP-TV-Z]{26}$/;
const AGENT_ID = /^agt_[0-9A-HJKMNP-TV-Z]{26}$/;
const IDEMPOTENCY = /^[A-Za-z0-9._:-]{8,128}$/;
/**
 * The model a run was asked for: the context chip's { id, source, name } (the Frame forwards it) or a bare exact id.
 * It rides as the task's model, resolved by OpenVibe.AI like one the person picked (tasks/engine.js). 'openvibe/auto'
 * and an empty choice leave it to the person's own model preference (11-15: the chip's model was dropped on the floor).
 */
function modelOf(b) {
    const m = b && b.model;
    const id = typeof m === 'string' ? m : m && typeof m === 'object' && typeof m.id === 'string' ? m.id : '';
    const clean = id.trim();
    if (!clean || clean === 'openvibe/auto' || clean.length > 256) return null;
    return clean;
}
/**
 * The way a run is worked (server/engines; 11-16, "swap between … the different ways"): the session's choice
 * { kind, model?, harness? } or a kind's name; 'auto' gives it back to Actor. undefined: this body names none.
 * tasks/create.js checks it and refuses a bad one in words.
 */
const engineIn = (b) => (b && typeof b === 'object' && b.engine !== undefined ? b.engine : undefined);
const engineStored = (row) => { const e = row && row.engine; if (!e) return undefined; try { return typeof e === 'string' ? JSON.parse(e) : e; } catch { return undefined; } };
// A conversation's step numbers, so one cursor reads them all: a turn's place × TURN, + 1 for the person's message,
// + 1 + its own event number for each of its steps, and TURN − 1 for an answer kept only in its result.
const TURN = 1000000;
const MAX_TURNS = 200;
const STATUS = { queued: 'planning', running: 'running', verifying: 'running', needs_you: 'waiting', succeeded: 'done', failed: 'failed', cancelled: 'stopped' };
const BY_STATUS = {
    planning: ['queued'],
    running: ['running', 'verifying'],
    waiting: ['needs_you'],
    done: ['succeeded'],
    failed: ['failed'],
    stopped: ['cancelled'],
};
const STEP_KIND = {
    plan: 'think',
    check: 'think',
    text: 'message',
    tool_call: 'tool',
    tool_result: 'tool',
    handoff: 'message',
    trigger: 'message',
    'trigger-run': 'message',
};

const parse = (v) => {
    if (v == null) return null;
    if (typeof v !== 'string') return v;
    try { return JSON.parse(v); } catch { return v; }
};
const iso = (v) => {
    if (v == null || v === '') return null;
    const t = typeof v === 'number' ? v : Date.parse(String(v));
    return Number.isFinite(t) ? new Date(t).toISOString() : String(v);
};
const clip = (v, n) => (typeof v === 'string' ? (v.length > n ? `${v.slice(0, n - 1)}…` : v) : null);
const num = (v) => (v == null || !Number.isFinite(Number(v)) ? null : Number(v));
const round = (v, places = 6) => (v == null ? null : Math.round(Number(v) * 10 ** places) / 10 ** places);

/** What a run card reads for a result: the answer, the summary, or why it did not finish. */
function summaryOf(row) {
    const result = parse(row.result);
    if (row.state === 'succeeded' && result) {
        if (typeof result === 'string') return clip(result.trim(), 8000);
        if (result.answer != null) return clip(typeof result.answer === 'string' ? result.answer.trim() : JSON.stringify(result.answer), 8000);
        if (result.summary != null) return clip(typeof result.summary === 'string' ? result.summary.trim() : JSON.stringify(result.summary), 8000);
        if (result.text != null) return clip(String(result.text).trim(), 8000);
    }
    if (row.error_detail) return clip(String(row.error_detail).trim(), 8000);
    if (result && result.error) return clip(String(result.error).trim(), 8000);
    return null;
}

function elapsedSeconds(row, now) {
    const start = Date.parse(String(row.created_at || ''));
    if (!Number.isFinite(start)) return null;
    const end = row.finished_at ? Date.parse(String(row.finished_at)) : now;
    if (!Number.isFinite(end)) return null;
    return Math.max(0, Math.round(((end - start) / 1000) * 1000) / 1000);
}

/** A task row → agents.run@1. `names` maps a contact id to its name; `now` is the store's clock. */
function runOf(row, names, now) {
    const agentId = row.agent_id || row.agent || 'openvibe-runtime';
    const listed = !row.agent_id && catalog.byId(row.agent || '');
    const agent = { id: String(agentId), product: 'actor' };
    const name = (row.agent_id && names.get(row.agent_id)) || (listed && listed.name);
    if (name) agent.name = String(name);
    const budget = { usd: num(row.budget_task) };
    if (row.timeout_ms != null) budget.seconds = Number(row.timeout_ms) / 1000;
    const cost = {};
    const usd = num(row.cost_usd);
    if (usd != null) cost.usd = round(usd);
    if (row.step_count != null) cost.steps = Number(row.step_count);
    const seconds = elapsedSeconds(row, now);
    if (seconds != null) cost.seconds = seconds;
    const out = {
        id: row.id,
        owner: store.subjectRef(row.requester),
        agent,
        parent_run: row.parent_id || null,
        budget,
        status: STATUS[row.state] || 'running',
        created_at: iso(row.created_at),
        updated_at: iso(row.last_at || row.finished_at || row.created_at),
        result_summary: summaryOf(row),
        cost: Object.keys(cost).length ? cost : null,
    };
    return out;
}

const oneLine = (v, n) => clip(String(v == null ? '' : v).replace(/\s+/g, ' ').trim(), n);

/**
 * A conversation's turns in order, as run rows: its first turn, then at each turn the newest follow-up (a retry
 * replaces the turn it retries; a fork starts a conversation of its own). Two queries.
 */
async function turnsOf(s, rootId, requester) {
    const path = await s.db.many(`WITH RECURSIVE down AS (
            SELECT id, 0 AS depth FROM tasks WHERE id = $1 AND requester = $2
            UNION ALL
            SELECT n.id, down.depth + 1
              FROM down
              CROSS JOIN LATERAL (
                  SELECT t.id FROM tasks t
                   WHERE t.parent_id = down.id AND t.fork_of_step IS NULL
                   ORDER BY t.id DESC LIMIT 1) n
             WHERE down.depth < ${MAX_TURNS})
        SELECT id, depth FROM down ORDER BY depth`, [String(rootId), requester]);
    if (!path.length) return [];
    // Each turn's last words (its newest text step): what the thread shows as the answer, and so the preview.
    const rows = await s.db.many(`SELECT r.*, (SELECT e.body->>'text' FROM task_events e WHERE e.task_id = r.id AND e.body->>'kind' = 'output'
            AND e.body->>'step' = 'text' ORDER BY e.seq DESC LIMIT 1) AS last_text,
            (SELECT a.id FROM actor_approvals a WHERE a.task_id = r.id AND a.state = 'pending' AND a.expires_at > to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS')
              ORDER BY a.created_at DESC LIMIT 1) AS pending_approval
        FROM (${RUN_ROW_SELECT} WHERE t.id = ANY($1::text[]) AND t.requester = $2) r`, [path.map((x) => x.id), requester]);
    const byId = new Map(rows.map((row) => [row.id, row]));
    return path.map((x) => byId.get(x.id)).filter(Boolean);
}

/** A conversation's turns → one agents.run@1: the first turn's id and title, the newest turn's state, every turn's cost. */
function conversationOf(turns, names, now, baseUrl) {
    const root = turns[0];
    const last = turns[turns.length - 1];
    const run = runOf(last, names, now);
    run.id = root.id;
    run.kind = 'chat';
    run.parent_run = root.fork_of_step != null ? root.parent_id || null : null;
    run.created_at = iso(root.created_at);
    // The name the person gave it (Rename, migration 0079), else its first message.
    run.title = oneLine(root.title, 200) || oneLine(root.task, 200) || 'Conversation';
    run.turns = turns.length;
    const usd = turns.reduce((sum, t) => sum + (num(t.cost_usd) || 0), 0);
    const steps = turns.reduce((sum, t) => sum + (Number(t.step_count) || 0), 0);
    const seconds = elapsedSeconds({ created_at: root.created_at, finished_at: last.finished_at }, now);
    run.cost = { usd: round(usd), steps, ...(seconds != null ? { seconds } : {}) };
    const open = store.OPEN.includes(last.state);
    // A finished answer is the person's turn, as in any chat; failing and stopping still say so.
    if (last.state === 'succeeded') { run.status = 'waiting'; run.waiting = { for: 'message' }; }
    // A turn that asked before acting waits for that yes, in the conversation itself (the owner, 11-18: "make these
    // approvals just built into the chat … it'll wait for the user to approve").
    if (!open && last.pending_approval) { run.status = 'waiting'; run.waiting = { for: 'approval', approval: last.pending_approval }; }
    if (open) run.doing = { text: 'Working on it', glyph: 'spark' };
    const said = open ? null : (last.last_text || summaryOf(last));
    run.preview = open || !said
        ? { text: oneLine(last.task, 500), from: 'person', at: run.updated_at }
        : { text: oneLine(said, 500), from: 'agent', at: run.updated_at };
    run.url = `${String(baseUrl || '').replace(/\/$/, '')}/chat/${last.id}`;
    return run;
}

/**
 * A conversation's steps after a cursor: each turn opens with the person's message, then its own steps; a finished
 * turn whose answer is only in its result (no text step) still answers in the thread.
 */
async function conversationSteps(s, turns, after, limit) {
    const out = [];
    const root = turns[0];
    for (let i = 0; i < turns.length && out.length <= limit; i++) {
        const turn = turns[i];
        const base = i * TURN;
        if (base + TURN <= after) continue;
        if (base + 1 > after) {
            out.push({ run_id: root.id, seq: base + 1, kind: 'message', from: 'person', text: clip(String(turn.task || ''), 65536),
                started_at: iso(turn.created_at), ended_at: iso(turn.created_at), cost: null, child_run: null });
        }
        const rows = await s.db.many(`SELECT e.seq, e.body FROM task_events e
            WHERE e.task_id = $1 AND e.seq > $2 AND e.body->>'kind' = 'output'
            ORDER BY e.seq LIMIT $3`, [turn.id, Math.max(0, after - base - 1), limit + 1]);
        for (const entry of rows) {
            const step = stepOf(root.id, entry.seq, parse(entry.body));
            if (!step) continue;
            step.run_id = root.id;
            step.seq = base + 1 + Number(entry.seq);
            if (step.kind === 'message') step.from = 'agent';
            out.push(step);
        }
        if (!store.OPEN.includes(turn.state) && rows.length <= limit && base + TURN - 1 > after) {
            const answer = summaryOf(turn);
            // The answer is left out only when the turn already said it as its last text step. Any text step used to be
            // enough (11-18: one model's "Asking a model, one call, no tools." stood in for the answer, the menu showed
            // no answer and, the person's message being the last word, Network kept the run "Writing an answer").
            const said = answer && await s.db.maybe(`SELECT e.body->>'text' AS text FROM task_events e WHERE e.task_id = $1 AND e.body->>'kind' = 'output'
                AND e.body->>'step' = 'text' AND coalesce(e.body->>'is_error', 'false') <> 'true' ORDER BY e.seq DESC LIMIT 1`, [turn.id]);
            const head = (v) => String(v || '').replace(/\s+/g, ' ').trim().slice(0, 160);
            const spoke = Boolean(said && head(said.text) && head(said.text) === head(answer));
            if (answer && !spoke) {
                const at = iso(turn.finished_at || turn.created_at);
                out.push({ run_id: root.id, seq: base + TURN - 1, kind: 'message', from: 'agent', text: answer, started_at: at, ended_at: at, cost: null, child_run: null });
            }
        }
        // What the turn asked before acting (actor_approvals): a card with the choices, right after its answer, at the
        // turn's last seq; once answered it says how. Approving a coding task makes it the conversation's next turn.
        if (!store.OPEN.includes(turn.state) && base + TURN > after) {
            const asked = await s.db.maybe(`SELECT id, kind, summary, payload, target, state, decision_scope, agent_id, created_at, decided_at, expires_at
                FROM actor_approvals WHERE task_id = $1 ORDER BY created_at DESC LIMIT 1`, [turn.id]);
            if (asked) out.push(approvalStep(root.id, base + TURN, asked));
        }
        // The turn's receipt (agents.step@1 1.3.0, plan §AD.17): its answer, the last word of the turn, says how it ran:
        // what it took, what paid by rung (OpenVibe's allowance, the person's key, their computer) and the model.
        if (!store.OPEN.includes(turn.state)) {
            let answerStep = null;
            for (let k = out.length - 1; k >= 0 && out[k].seq > base; k--) if (out[k].kind === 'message' && out[k].from === 'agent') { answerStep = out[k]; break; }
            const receipt = answerStep ? receiptStep(parse(turn.receipt)) : null;
            if (receipt) Object.assign(answerStep, receipt);
        }
    }
    const page = out.slice(0, limit);
    return { steps: page, next: out.length > limit ? Number(page[page.length - 1].seq) : null };
}

const APPROVAL_DONE = { approved: 'Approved', declined: 'Declined', expired: 'Expired: nothing ran' };
/** An actor_approvals row as the session surface's approval step (ov-session approvalNode): the choices, or the answer. */
/** What an approval is for, in its own words: a coding task says the work and where (11-18, the owner's phone: the card
 *  said "Start this coding task on your machine?" over "Start a coding task on your machine", nothing about what). */
function approvalWords(a) {
    if (a.kind === 'codes.task' && a.payload) {
        try {
            const p = typeof a.payload === 'string' ? JSON.parse(a.payload) : a.payload;
            const work = require('../agents/approvals').codesWork(p, a.summary);
            if (work && work.trim() && !/^start a coding task on your machine\.?$/i.test(work.trim())) return work.trim();
        } catch { /* the summary below */ }
    }
    return String(a.summary || '');
}

function approvalStep(runId, seq, a) {
    const kinds = require('../agents/kinds');
    const at = iso(a.decided_at || a.created_at);
    const pending = a.state === 'pending' && !(a.expires_at && Date.parse(a.expires_at) < Date.now());
    const options = [{ id: 'approve', label: a.kind === 'codes.task' ? 'Approve and start' : 'Approve' }];
    if (a.agent_id && a.target && kinds.allowable(a.kind)) options.push({ id: 'approve_always', label: 'Always for this' });
    options.push({ id: 'decline', label: 'Decline' });
    const result = { approval: a.id, kind: a.kind, options };
    if (!pending) {
        result.answer = a.state === 'approved' ? 'approve' : a.state === 'declined' ? 'decline' : a.state;
        result.answer_label = `${APPROVAL_DONE[a.state] || a.state}${a.decision_scope === 'always' ? ' · always for this' : ''}`;
    }
    return {
        run_id: runId, seq, kind: 'approval', from: 'agent',
        title: a.kind === 'codes.task' ? 'Start this coding task on your machine?' : 'It asks before it goes on',
        text: clip(String(approvalWords(a)), 2000), started_at: at, ended_at: at, cost: null, child_run: null, result,
    };
}

/**
 * How much the conversation does on its own (agents.run@1 1.5.0 `level`): the level its next turn runs at, the agent's own
 * (a conversation never goes below it), what asks at every level, and that the person may change it here.
 */
async function levelOf(s, config, turns) {
    const contacts = require('../agents/contacts');
    const levels = require('../agents/levels');
    const last = turns[turns.length - 1];
    try {
        const agent = await contacts.agentForTask(s, config, last);
        const now = await contacts.effectiveLevelFor(s, last, agent);
        return { now, agent: levels.LEVELS.includes(agent && agent.level) ? agent.level : 'ask', always_asks: levels.ALWAYS_ASK.slice(), can_set: true };
    } catch { return null; }
}

/** One conversation's run, read by any of its turns' ids (the first turn's id is the run's). With `config`, its level too. */
async function conversationView(s, taskId, requester, now, baseUrl, config = null) {
    const rootId = await canvases.threadForTask(s, taskId);
    const turns = rootId ? await turnsOf(s, rootId, requester) : [];
    if (!turns.length) return null;
    const run = conversationOf(turns, await namesFor(s, requester, turns), now, baseUrl);
    if (config) { const level = await levelOf(s, config, turns); if (level) run.level = level; }
    return run;
}

/** A task event → agents.step@1. One event is one step: Actor writes a tool call and its result as two entries. */
/** The plan lines Actor writes for itself (tasks/engine.js), which a person's session never shows. */
const BOOKKEEPING = [
    /^This is an? "[^"]*" task\.$/,
    /^The agent starts with a plan, then works through it\.$/,
    /^Settings: .*\.$/,
];

/** A turn's receipt (tasks.receipt, tasks/engine.js receiptOf) → agents.step@1 1.3.0's cost (with BY) and model, or null. */
const RUNGS = ['machine', 'plan', 'key', 'allowance', 'credits'];
function receiptStep(body) {
    if (!body || !body.cost || typeof body.cost !== 'object') return null;
    const n = (v, int) => { const x = Number(v); return Number.isFinite(x) && x >= 0 ? (int ? Math.round(x) : x) : 0; };
    const by = {};
    for (const k of RUNGS) {
        const r = body.cost.by && body.cost.by[k];
        if (r && typeof r === 'object') by[k] = { usd: n(r.usd), tokens: n(r.tokens, true), seconds: n(r.seconds) };
    }
    if (!Object.keys(by).length) return null;
    const out = { cost: { usd: n(body.cost.usd), tokens: n(body.cost.tokens, true), seconds: n(body.cost.seconds), by } };
    const m = body.model;
    if (m && typeof m.id === 'string' && m.id.trim()) {
        out.model = { id: m.id.trim().slice(0, 200) };
        if (typeof m.provider === 'string' && /^[a-z][a-z0-9_-]{0,40}$/.test(m.provider)) out.model.provider = m.provider;
    }
    return out;
}

function stepOf(runId, seq, body) {
    const b = body && typeof body === 'object' ? body : {};
    // 2026-11-16: the plan a person reads is the plan. Actor's own bookkeeping (the task's class, how the agent starts,
    // the run settings: BOOKKEEPING) and the task and progress ledgers inside a plan are the model's and Actor's own task
    // page's, never a session's Thought ("Task ledger: given … Progress: not done; not looping …"). A plan that was only
    // bookkeeping is no step at all (null). The events stay as they are: agents.task-event@1 has no field for this.
    if (b.step === 'plan' && typeof b.text === 'string') {
        const text = b.text.split('\n').filter((l) => !/^(Task ledger|Progress):/.test(l.trim())).join('\n').trim();
        if (!text || BOOKKEEPING.some((re) => re.test(text))) return null;
        b.text = text;
    }
    const step = {
        run_id: b.task_id || runId,
        seq: Number(b.seq == null ? seq : b.seq),
        kind: STEP_KIND[b.step] || 'message',
        text: b.text == null ? null : clip(String(b.text), 65536),
        started_at: iso(b.at) || iso(new Date().toISOString()),
        ended_at: null,
        cost: null,
        child_run: null,
    };
    if (b.step === 'tool_call' && b.tool) step.tool_call = { name: String(b.tool).slice(0, 160), input: b.input == null ? null : b.input };
    if (b.step === 'tool_result') {
        step.result = b.text == null ? null : b.text;
        step.ended_at = step.started_at;
    } else if (b.step !== 'tool_call') {
        // A point event: it happened at `at`, so the step is complete when it is written.
        step.ended_at = step.started_at;
    }
    if (b.step === 'trigger' || b.step === 'trigger-run') {
        step.result = b.trigger || b.run || null;
    }
    return step;
}

const RUN_ROW_SELECT = `SELECT t.*,
        (SELECT e.body->>'at' FROM task_events e WHERE e.task_id = t.id ORDER BY e.seq DESC LIMIT 1) AS last_at,
        (SELECT count(*) FROM task_events e WHERE e.task_id = t.id AND e.body->>'kind' = 'output') AS step_count
    FROM tasks t`;

async function namesFor(s, requester, rows) {
    const ids = [...new Set(rows.map((row) => row.agent_id).filter((id) => id && /^agt_/.test(String(id))))];
    const names = new Map();
    if (!ids.length) return names;
    const found = await s.db.many('SELECT id, name FROM actor_agents WHERE owner = $1 AND id = ANY($2::text[])', [requester, ids]);
    for (const row of found) names.set(row.id, row.name);
    return names;
}

/** One run row with the newest event's time and its step count, for the one run's read. */
const loadRunRow = (s, id, requester) => s.db.maybe(`${RUN_ROW_SELECT} WHERE t.id = $1 AND t.requester = $2`, [id, requester]);

/** A row from loadRunRow → the agents.run@1 body, with the contact's name when the run names one. */
async function viewOf(s, row, now) {
    return runOf(row, await namesFor(s, row.requester, [row]), now);
}

function createRunsRoutes(ctx) {
    const { s, principal, limits, config = {}, engine, webhooks, triggers } = ctx;
    const r = asyncRouter();
    const problem = (req, res, status, code, detail) => contracts.http.sendProblem(res, status, code, { detail, ctx: req.ov });
    const notFound = (req, res) => problem(req, res, 404, 'agents.run.not_found', 'No such run.');
    // The one agent system's run view is the person's own: a service acting for them, an app's own token and another
    // person all get the same 404, never a 401 that would confirm a run.
    const own = (req, res, next) => (req.principal && req.principal.kind === 'user' && /^user:usr_/.test(String(req.principal.requester)) ? next() : notFound(req, res));

    const RUN_SELECT = RUN_ROW_SELECT;

    const wantsConversations = (req) => req.query.conversations === '1' || req.query.conversation === '1';
    // The person's own Bearer and clock, for a trigger made in a turn (their Watch, their timezone).
    const bearerOf = (req) => { const h = String(req.get('authorization') || ''); return h.startsWith('Bearer ') ? h.slice(7).trim() : (req.token || null); };
    const tzOf = (req) => (req.cookies && req.cookies.ov_tz ? String(req.cookies.ov_tz).slice(0, 64) : null);
    const textOf = (b) => (b && typeof b.text === 'string' ? b.text.trim().slice(0, 20000) : '');
    const started = async (req, row, text, rootId) => {
        if (!triggers || !triggers.onMessage || !row.agent_id) return;
        await triggers.onMessage({ owner: String(req.principal.requester || '').replace(/^user:/, ''), agentId: row.agent_id, text,
            conversation: `chat:${rootId}`, turnTaskId: row.id, place: `/chat/${row.id}` });
    };
    const failed = (req, res, out) => {
        if (out.retryAfter) res.set('Retry-After', String(out.retryAfter));
        return problem(req, res, out.status, out.code, out.detail);
    };

    // A new conversation with the person's Actor (or one of their own agents). A body with `skill` is the
    // catalogue's skill run, served by the route after this router.
    const skillGoesOn = (req, res, next) => (req.body && req.body.skill != null ? next('router') : next());
    r.post('/', skillGoesOn, principal.requireCapability('actor.task.create'), own, limits.budget('actor.task.create'), async (req, res) => {
            const b = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
            const text = textOf(b);
            if (!text) return problem(req, res, 422, 'agents.run.start_needs_words', 'Say what the run is for ({ text }).');
            const key = String(b.idempotency_key || req.get('idempotency-key') || '');
            const model = modelOf(b);
            const chosen = engineIn(b);
            const body = { task: text, mode: 'balanced',
                ...(model ? { model } : {}),
                ...(chosen !== undefined ? { engine: chosen } : {}),
                ...(typeof b.agent === 'string' && AGENT_ID.test(b.agent) ? { agent_id: b.agent } : {}),
                ...(IDEMPOTENCY.test(key) ? { idempotency_key: key } : {}) };
            const out = await createTask({ s, config, engine, webhooks, principal: req.principal, body, personToken: bearerOf(req), timezone: tzOf(req) });
            if (out.code) return failed(req, res, out);
            if (out.status === 201) await started(req, out.task, text, out.task.id);
            const view = await conversationView(s, out.task.id, req.principal.requester, s.now(), config.baseUrl);
            res.set('Location', `/api/v1/runs/${out.task.id}`);
            return res.status(out.status).json(view);
        });

    r.get('/', principal.requireCapability('actor.task.list'), own, limits.reads('actor.task.list'), async (req, res) => {
        const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
        const before = TASK_ID.test(String(req.query.before || '')) ? String(req.query.before) : null;
        let states = null;
        if (req.query.status != null && req.query.status !== '') {
            states = BY_STATUS[String(req.query.status)];
            if (!states) return problem(req, res, 400, 'agents.run.status', 'status must be one of planning, running, waiting, done, failed, stopped.');
        }
        const agent = typeof req.query.agent === 'string' && req.query.agent.trim() ? req.query.agent.trim().slice(0, 160) : null;
        const where = ['t.requester = $1'];
        const args = [req.principal.requester];
        if (before) { args.push(before); where.push(`t.id < $${args.length}`); }
        if (wantsConversations(req)) {
            // Conversations: their first turns (a fork is a conversation of its own); the status is the newest turn's.
            where.push('(t.parent_id IS NULL OR t.fork_of_step IS NOT NULL)');
            if (agent) { args.push(agent); where.push(`(t.agent_id = $${args.length} OR t.agent = $${args.length})`); }
            args.push(limit + 1);
            const roots = await s.db.many(`SELECT t.id FROM tasks t WHERE ${where.join(' AND ')} ORDER BY t.id DESC LIMIT $${args.length}`, args);
            const page = roots.slice(0, limit);
            const now = s.now();
            const runs = [];
            for (const root of page) {
                const turns = await turnsOf(s, root.id, req.principal.requester);
                if (turns.length) runs.push(conversationOf(turns, await namesFor(s, req.principal.requester, turns), now, config.baseUrl));
            }
            const wanted = req.query.status ? runs.filter((x) => x.status === String(req.query.status)) : runs;
            return res.json({ runs: wanted, next: roots.length > limit ? page[page.length - 1].id : null });
        }
        if (states) { args.push(states); where.push(`t.state = ANY($${args.length}::text[])`); }
        if (agent) { args.push(agent); where.push(`(t.agent_id = $${args.length} OR t.agent = $${args.length})`); }
        args.push(limit + 1);
        const rows = await s.db.many(`${RUN_SELECT} WHERE ${where.join(' AND ')} ORDER BY t.id DESC LIMIT $${args.length}`, args);
        const page = rows.slice(0, limit);
        const names = await namesFor(s, req.principal.requester, page);
        const now = s.now();
        res.json({ runs: page.map((row) => runOf(row, names, now)), next: rows.length > limit ? page[page.length - 1].id : null });
    });

    async function load(req, res) {
        if (!TASK_ID.test(String(req.params.id || ''))) { notFound(req, res); return null; }
        const row = await loadRunRow(s, req.params.id, req.principal.requester);
        if (!row) { notFound(req, res); return null; }
        return row;
    }

    r.get('/:id/steps', principal.requireCapability('actor.task.read'), own, limits.reads('actor.task.read'), async (req, res) => {
        const row = await load(req, res);
        if (!row) return;
        const after = Math.max(0, parseInt(req.query.after, 10) || 0);
        const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 200));
        if (wantsConversations(req)) {
            const rootId = await canvases.threadForTask(s, row.id);
            const turns = rootId ? await turnsOf(s, rootId, req.principal.requester) : [];
            if (!turns.length) return notFound(req, res);
            const page = await conversationSteps(s, turns, after, limit);
            return res.json({ run_id: turns[0].id, ...page });
        }
        const rows = await s.db.many(`SELECT e.seq, e.body FROM task_events e
            WHERE e.task_id = $1 AND e.seq > $2 AND e.body->>'kind' = 'output'
            ORDER BY e.seq LIMIT $3`, [row.id, after, limit + 1]);
        const page = rows.slice(0, limit);
        const steps = page.map((entry) => stepOf(row.id, entry.seq, parse(entry.body))).filter(Boolean);
        res.json({ run_id: row.id, steps, next: rows.length > limit ? Number(page[page.length - 1].seq) : null });
    });

    // The person's next message: a new turn from the conversation's newest one, as typing it on openvibe.actor does.
    r.post('/:id/messages', principal.requireCapability('actor.task.create'), own, limits.budget('actor.task.create'), async (req, res) => {
        const row = await load(req, res);
        if (!row) return;
        const text = textOf(req.body);
        if (!text) return problem(req, res, 422, 'agents.run.say_needs_words', 'Write a message first ({ text }).');
        const rootId = await canvases.threadForTask(s, row.id);
        const latest = rootId ? await canvases.latestForThread(s, rootId) : null;
        if (!latest || latest.requester !== req.principal.requester) return notFound(req, res);
        if (store.OPEN.includes(latest.state) || latest.state === 'needs_you') {
            return problem(req, res, 409, 'agents.run.busy', 'Your Actor is still working on the last message. Wait for it, or stop it.');
        }
        // The next turn keeps the model the conversation runs on, unless this message names another (a swap mid-session).
        const model = modelOf(req.body) || (typeof latest.model === 'string' && latest.model.trim() ? latest.model.trim() : null);
        // And the way it is worked: kept from the newest turn, unless this message names another (the session's chip).
        const named = engineIn(req.body);
        const way = named !== undefined ? named : engineStored(latest);
        const out = await createTask({ s, config, engine, webhooks, principal: req.principal, body: { task: text, mode: latest.mode || 'balanced', ...(model ? { model } : {}), ...(way !== undefined ? { engine: way } : {}) },
            parentId: latest.id, personToken: bearerOf(req), timezone: tzOf(req) });
        if (out.code) return failed(req, res, out);
        await started(req, out.task, text, rootId);
        return res.status(202).json({ ok: true, run: await conversationView(s, rootId, req.principal.requester, s.now(), config.baseUrl, config) });
    });

    // Rename (plan §AD.8, the session's ⋯ menu): the person names the conversation; an empty title gives it back its first
    // message. The name is kept on the conversation's first turn.
    r.patch('/:id', principal.requireCapability('actor.task.create'), own, async (req, res) => {
        const row = await load(req, res);
        if (!row) return;
        const body = req.body && typeof req.body === 'object' ? req.body : {};
        const hasTitle = Object.prototype.hasOwnProperty.call(body, 'title');
        const hasLevel = Object.prototype.hasOwnProperty.call(body, 'level');
        const raw = hasTitle ? body.title : undefined;
        if (!hasLevel && raw !== null && typeof raw !== 'string') return problem(req, res, 422, 'agents.run.title_needed', 'Send the new name ({ title }).');
        if (hasTitle && raw !== null && typeof raw !== 'string') return problem(req, res, 422, 'agents.run.title_needed', 'Send the new name ({ title }).');
        const levels = require('../agents/levels');
        if (hasLevel && !levels.LEVELS.includes(body.level)) return problem(req, res, 422, 'agents.run.level', `level is one of ${levels.LEVELS.join(', ')}`);
        const rootId = (await canvases.threadForTask(s, row.id)) || row.id;
        if (hasTitle) {
            const title = raw == null ? null : (oneLine(raw, 200) || null);
            const updated = await s.db.maybe('UPDATE tasks SET title = $1 WHERE id = $2 AND requester = $3 RETURNING id', [title, rootId, req.principal.requester]);
            if (!updated) return notFound(req, res);
        }
        if (hasLevel) {
            // The conversation's level (the composer's chip, 11-18): every turn of it, so the walk up its turns
            // (contacts.effectiveLevelFor) finds this one and not an older, higher one. The agent's own stays the floor.
            const turns = await turnsOf(s, rootId, req.principal.requester);
            if (!turns.length) return notFound(req, res);
            await s.db.query('UPDATE tasks SET level = $1 WHERE id = ANY($2::text[]) AND requester = $3', [body.level, turns.map((t) => t.id), req.principal.requester]);
        }
        return res.json(await conversationView(s, rootId, req.principal.requester, s.now(), config.baseUrl, config));
    });

    // Stop: the turn under way stops; the conversation stays, ready for the next message.
    // An approval answered in the conversation (Network's /api/frame/runs/:ref/approvals/:id, the session surface's card):
    // { answer: 'approve' | 'approve_always' | 'decline' }. Only an approval one of this conversation's turns asked for.
    r.post('/:id/approvals/:approval', principal.requireCapability('actor.task.create'), own, limits.budget('actor.task.create'), async (req, res) => {
        if (!TASK_ID.test(req.params.id) || !/^apr_[0-9A-HJKMNP-TV-Z]{26}$/.test(req.params.approval)) return notFound(req, res);
        const answer = String((req.body && (req.body.answer || req.body.decision)) || '');
        if (!['approve', 'approve_always', 'decline'].includes(answer)) return problem(req, res, 422, 'agents.approval.answer', 'answer is approve, approve_always or decline');
        const rootId = await canvases.threadForTask(s, req.params.id);
        const turns = rootId ? await turnsOf(s, rootId, req.principal.requester) : [];
        if (!turns.length) return notFound(req, res);
        const asked = await s.db.maybe('SELECT id, task_id FROM actor_approvals WHERE id = $1 AND owner = $2', [req.params.approval, req.principal.requester]);
        if (!asked || !turns.some((t) => t.id === asked.task_id)) return problem(req, res, 404, 'agents.approval.not_found', 'No such approval in this conversation.');
        const approvals = require('../agents/approvals');
        const out = await approvals.decide(ctx, req.principal.requester, asked.id, answer, { personToken: bearerOf(req), parentId: turns[turns.length - 1].id });
        if (out.error) return problem(req, res, out.status || 422, 'agents.approval.refused', out.error);
        return res.json({
            approval: { id: out.row.id, state: out.row.state, scope: out.row.decision_scope || null },
            ...(out.task ? { started: { id: out.task.id } } : {}), ...(out.note ? { note: out.note } : {}),
            run: await conversationView(s, req.params.id, req.principal.requester, s.now(), config.baseUrl),
        });
    });

    r.post('/:id/stop', principal.requireCapability('actor.task.create'), own, async (req, res) => {
        const row = await load(req, res);
        if (!row) return;
        const rootId = await canvases.threadForTask(s, row.id);
        const latest = rootId ? await canvases.latestForThread(s, rootId) : null;
        if (!latest || latest.requester !== req.principal.requester) return notFound(req, res);
        if (store.OPEN.includes(latest.state) || latest.state === 'needs_you') await engine.cancel(latest.id, req.principal.requester);
        return res.json(await conversationView(s, rootId, req.principal.requester, s.now(), config.baseUrl));
    });

    return r;
}

module.exports = { BOOKKEEPING, createRunsRoutes, runOf, stepOf, receiptStep, viewOf, loadRunRow, conversationView, turnsOf, STATUS, STEP_KIND, TURN };

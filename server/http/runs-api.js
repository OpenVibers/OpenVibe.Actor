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
 * A person's Network token (or this site's session) only: an app's token gets the same 404 as another person's run,
 * so nothing confirms that a run exists. Read-only: creating, stopping and answering an approval are the engine's
 * later routes and are not here. No table changes.
 */
const contracts = require('openvibe-contracts');
const { asyncRouter } = require('./router');
const store = require('../tasks/store');
const catalog = require('../agents/catalog');

const TASK_ID = /^tsk_[0-9A-HJKMNP-TV-Z]{26}$/;
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

/** A task event → agents.step@1. One event is one step: Actor writes a tool call and its result as two entries. */
function stepOf(runId, seq, body) {
    const b = body && typeof body === 'object' ? body : {};
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
    const { s, principal, limits } = ctx;
    const r = asyncRouter();
    const problem = (req, res, status, code, detail) => contracts.http.sendProblem(res, status, code, { detail, ctx: req.ov });
    const notFound = (req, res) => problem(req, res, 404, 'agents.run.not_found', 'No such run.');
    // The one agent system's run view is the person's own: a service acting for them, an app's own token and another
    // person all get the same 404, never a 401 that would confirm a run.
    const own = (req, res, next) => (req.principal && req.principal.kind === 'user' && /^user:usr_/.test(String(req.principal.requester)) ? next() : notFound(req, res));

    const RUN_SELECT = RUN_ROW_SELECT;

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
        const rows = await s.db.many(`SELECT e.seq, e.body FROM task_events e
            WHERE e.task_id = $1 AND e.seq > $2 AND e.body->>'kind' = 'output'
            ORDER BY e.seq LIMIT $3`, [row.id, after, limit + 1]);
        const page = rows.slice(0, limit);
        const steps = page.map((entry) => stepOf(row.id, entry.seq, parse(entry.body)));
        res.json({ run_id: row.id, steps, next: rows.length > limit ? Number(page[page.length - 1].seq) : null });
    });

    return r;
}

module.exports = { createRunsRoutes, runOf, stepOf, viewOf, loadRunRow, STATUS, STEP_KIND };

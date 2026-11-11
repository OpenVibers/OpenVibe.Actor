'use strict';
const { clean } = require('./redact');
const { createRunStream } = require('./service');
const tasks = require('../tasks/store');
function line(e) {
    if (e.ui_approval) return { t: 'approval', id: e.ui_approval.id, text: e.ui_approval.question, actions: e.ui_approval.actions };
    if (e.kind === 'end') return { t: 'end', ok: e.state === 'succeeded', text: e.state };
    if (e.kind === 'state') return { t: 'state', state: e.state };
    if (e.step === 'tool_call') return { t: 'tool', id: e.call_id || e.tool, name: e.tool, input: e.args || e.input };
    if (e.step === 'tool_result') return { t: 'tool_result', id: e.call_id || e.tool, name: e.tool, output: e.full_output == null ? e.text : e.full_output, sources: e.ui_sources, ok: !e.is_error, attachments: e.artifacts };
    if (e.step === 'plan') return { t: 'plan', text: e.text, plan: e.plan };
    if (e.step === 'handoff') return { t: 'handoff', reason: e.text };
    if (e.step === 'question' || e.step === 'approval') return { t: 'approval', id: e.approval_id, text: e.text, actions: e.options };
    return { t: 'text', text: e.text || '' };
}
function createActorRuns({ s, fallback }) {
    const stream = createRunStream({ store: s, product: 'actor', clean, fallback, read: async (id, after) => {
        const row = await tasks.getTask(s, id);
        const records = await s.db.many('SELECT body, ui_detail FROM task_events WHERE task_id = $1 AND seq > $2 ORDER BY seq LIMIT 500', [id, after]);
        const parse = (v) => typeof v === 'string' ? JSON.parse(v) : v;
        const events = records.map((r) => ({ ...parse(r.body), ...parse(r.ui_detail) }));
        return { items: events.map((e) => ({ seq: e.seq, at: e.at, line: line(e) })),
            ended: records.length < 500 && row && !tasks.OPEN.includes(row.state), ok: row && row.state === 'succeeded', endedAt: row && row.ended_at };
    } });
    const resolve = async (row, n) => {
        const starts = await s.db.many("SELECT seq, body FROM task_events WHERE task_id = $1 AND body->>'kind' = 'state' AND body->>'state' = 'queued' ORDER BY seq DESC", [row.id]);
        const start = n ? starts.find((e) => Number(e.seq) === n) : starts[0];
        if (n && !start) return null;
        if (!start) return row;
        const body = typeof start.body === 'string' ? JSON.parse(start.body) : start.body;
        return { ...row, run_id: `${row.id}~${start.seq}`, run_after: Number(start.seq) - 1, started_at: body.at, ...(start !== starts[0] ? { result: null, cost_usd: null } : {}) };
    };
    return { ...stream, resolve };
}
module.exports = { createActorRuns, line };

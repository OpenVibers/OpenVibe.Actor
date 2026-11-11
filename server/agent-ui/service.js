'use strict';
const { initial, createMapper, oneLine } = require('./mapper');
const parse = (v) => typeof v === 'string' ? JSON.parse(v) : v;

/** Materialize under one run lock: concurrent readers and service restarts share the same IDs and titles. */
function createRunStream({ store, product, read, clean, fallback, pollMs = 1000, heartbeatMs = 15000 }) {
    const db = store.db;
    async function project(row) {
        const projectionId = row.run_id || row.id;
        return store.tx(async () => {
            await db.query('INSERT INTO agent_ui_runs (id, task_id, state) VALUES ($1, $2, $3::jsonb) ON CONFLICT DO NOTHING',
                [projectionId, row.id, JSON.stringify({ ...initial(projectionId, product, row.created_at), source: row.run_after || 0 })]);
            const saved = await db.maybe('SELECT state FROM agent_ui_runs WHERE id = $1 FOR UPDATE', [projectionId]);
            const state = parse(saved.state);
            if (state.terminal) return state;
            let batch;
            const mapper = createMapper(state, { clean, fallback });
            if (!state.seq) await mapper.push({ t: 'state', state: 'running' }, 0, row.created_at);
            do {
                batch = await read(row.id, state.source, row);
                for (const item of batch.items) {
                await mapper.push(item.line, item.seq, item.at);
                    state.source = Number(item.seq);
                }
            } while (!state.terminal && batch.items.length === 500);
            if (batch.ended) await mapper.push({ t: 'end', ok: batch.ok, text: batch.error }, state.source, batch.endedAt);
            for (const { seq, event } of mapper.events) {
                await db.query('INSERT INTO agent_ui_events (run_id, seq, body) VALUES ($1, $2, $3::jsonb)', [projectionId, seq, JSON.stringify(clean(event))]);
            }
            await db.query('UPDATE agent_ui_runs SET state = $2::jsonb WHERE id = $1', [projectionId, JSON.stringify(clean(state))]);
            return state;
        });
    }
    const snapshot = async (row) => {
        const s = await project(row);
        const iso = (v) => new Date(typeof v === 'number' ? v : v || 0).toISOString();
        return clean({ id: s.id, product, title: oneLine(row.task || row.prompt || 'Agent run', 240), status: s.status === 'done' ? 'succeeded' : s.status,
            plan: s.plan.map((p) => ({ title: oneLine(p.title || p.content || 'Step', 240), status: ['todo', 'running', 'waiting', 'needs_you', 'done', 'failed', 'stopped'].includes(p.status) ? p.status : 'todo' })),
            steps: s.steps, sources: s.sources, result: s.result || parse(row.result) || null, started_at: iso(row.started_at || row.created_at), ended_at: s.terminal ? iso(s.endedAt || row.updated_at || row.ended_at || row.created_at) : null, cost_usd: s.cost_usd || Number(row.cost_usd) || null });
    };
    async function stream(req, res, row) {
        const asked = String(req.get('last-event-id') || '0');
        if (!/^\d+$/.test(asked) || !Number.isSafeInteger(Number(asked))) return res.status(400).json({ error: 'Invalid Last-Event-ID' });
        let last = Number(asked), closed = false, busy = false;
        let poll, beat;
        const stop = () => { closed = true; clearInterval(poll); clearInterval(beat); };
        res.on('close', stop);
        await project(row); // Fail before headers if the database is unavailable.
        if (closed) return;
        res.status(200).set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
        res.flushHeaders();
        res.write(': stream open\n\n');
        const tick = async () => {
            if (closed || busy) return;
            busy = true;
            try {
                const state = await project(row);
                let page;
                do {
                    page = await db.many('SELECT seq, body FROM agent_ui_events WHERE run_id = $1 AND seq > $2 ORDER BY seq LIMIT 500', [row.run_id || row.id, last]);
                    for (const e of page) {
                        if (closed) return;
                        const event = clean(parse(e.body));
                        last = Number(e.seq);
                        if (!res.write(`id: ${last}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)) {
                            await new Promise((resolve) => {
                                const done = () => { res.off('drain', done); res.off('close', done); resolve(); };
                                res.once('drain', done); res.once('close', done);
                            });
                        }
                    }
                } while (!closed && page.length === 500);
                if (state.terminal) { stop(); res.end(); }
            } catch { stop(); res.end(); } // Reconnect resumes the last committed event; never fabricate a run error.
            finally { busy = false; }
        };
        poll = setInterval(tick, pollMs); poll.unref();
        beat = setInterval(() => { if (!closed) res.write(': keep-alive\n\n'); }, heartbeatMs); beat.unref();
        await tick();
    }
    return { project, snapshot, stream };
}
module.exports = { createRunStream };

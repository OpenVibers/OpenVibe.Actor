'use strict';
/** Triggers and their runs in Actor's own PostgreSQL (migrations/0037_actor_triggers.sql). */

const parse = (v) => (v == null ? null : typeof v === 'string' ? JSON.parse(v) : v);

function wire(row) {
    if (!row) return null;
    return {
        id: row.id,
        owner: row.owner,
        agent_id: row.agent_id,
        task: row.task,
        kind: row.kind,
        schedule: parse(row.schedule),
        event: parse(row.event),
        goal: parse(row.goal),
        verdict: parse(row.verdict),
        runs_used: Number(row.runs_used) || 0,
        spent_usd: Number(row.spent_usd) || 0,
        answer_in_chat: row.answer_in_chat !== false,
        notify: row.notify === true,
        timezone: row.timezone || null,
        words: row.words,
        level: row.level || 'ask',
        state: row.state,
        paused_reason: row.paused_reason || null,
        failures: Number(row.failures) || 0,
        watch_id: row.watch_id || null,
        turn_task_id: row.turn_task_id || null,
        last_task_id: row.last_task_id || null,
        last_state: row.last_state || null,
        last_run_at: row.last_run_at == null ? null : Number(row.last_run_at),
        ended_at: row.ended_at == null ? null : Number(row.ended_at),
        created_at: Number(row.created_at),
        updated_at: Number(row.updated_at),
    };
}

const get = async (s, owner, id) => /^trg_[0-9A-HJKMNP-TV-Z]{26}$/.test(String(id || ''))
    ? wire(await s.db.maybe('SELECT * FROM actor_triggers WHERE id = $1 AND owner = $2 AND deleted_at IS NULL', [id, owner]))
    : null;
const byWatch = async (s, owner, watchId) => /^wch_[0-9A-HJKMNP-TV-Z]{26}$/.test(String(watchId || ''))
    ? wire(await s.db.maybe('SELECT * FROM actor_triggers WHERE watch_id = $1 AND owner = $2 AND deleted_at IS NULL', [watchId, owner]))
    : null;
const list = async (s, owner) => (await s.db.many('SELECT * FROM actor_triggers WHERE owner = $1 AND deleted_at IS NULL ORDER BY created_at DESC, id DESC LIMIT 200', [owner])).map(wire);
const countActive = async (s, owner) => Number(await s.db.value("SELECT count(*) FROM actor_triggers WHERE owner = $1 AND state = 'active' AND deleted_at IS NULL", [owner])) || 0;
const countForAgent = async (s, owner, agentId) => Number(await s.db.value('SELECT count(*) FROM actor_triggers WHERE owner = $1 AND agent_id = $2 AND deleted_at IS NULL', [owner, agentId])) || 0;

async function insert(s, rec) {
    await s.db.query(`INSERT INTO actor_triggers
        (id, owner, agent_id, task, kind, schedule, event, goal, timezone, words, level, state, paused_reason, failures, watch_id, turn_task_id, answer_in_chat, notify, created_at, updated_at)
        VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$19)`,
    [rec.id, rec.owner, rec.agent_id, rec.task, rec.kind, rec.schedule ? JSON.stringify(rec.schedule) : null,
        rec.event ? JSON.stringify(rec.event) : null, rec.goal ? JSON.stringify(rec.goal) : null,
        rec.timezone || null, rec.words, rec.level || 'ask',
        rec.state || 'paused', rec.paused_reason || null, rec.failures || 0, rec.watch_id || null, rec.turn_task_id || null,
        rec.answer_in_chat !== false, rec.notify === true, rec.created_at]);
    return await get(s, rec.owner, rec.id);
}

async function update(s, owner, id, patch) {
    const cols = [];
    const args = [id, owner];
    const json = new Set(['schedule', 'event', 'goal', 'verdict']);
    for (const [k, v] of Object.entries(patch)) {
        if (!['agent_id', 'task', 'schedule', 'event', 'goal', 'verdict', 'runs_used', 'spent_usd', 'answer_in_chat', 'notify', 'timezone', 'words', 'level', 'state', 'paused_reason', 'failures', 'watch_id', 'last_task_id', 'last_state', 'last_run_at', 'ended_at', 'updated_at', 'deleted_at'].includes(k)) continue;
        args.push(json.has(k) && v != null ? JSON.stringify(v) : v);
        cols.push(`${k} = $${args.length}${json.has(k) ? '::jsonb' : ''}`);
    }
    if (!cols.length) return await get(s, owner, id);
    await s.db.query(`UPDATE actor_triggers SET ${cols.join(', ')} WHERE id = $1 AND owner = $2 AND deleted_at IS NULL`, args);
    return await get(s, owner, id);
}

async function addRun(s, triggerId, taskId, state, at, costUsd = null) {
    await s.db.query(`INSERT INTO actor_trigger_runs (trigger_id, task_id, state, cost_usd, created_at, updated_at)
        VALUES ($1,$2,$3,$4,$5,$5) ON CONFLICT (task_id) DO UPDATE SET state = EXCLUDED.state, cost_usd = COALESCE(EXCLUDED.cost_usd, actor_trigger_runs.cost_usd), updated_at = EXCLUDED.updated_at`,
    [triggerId, taskId, state, costUsd, at]);
}
const runForTask = (s, taskId) => s.db.maybe('SELECT * FROM actor_trigger_runs WHERE task_id = $1', [taskId]);
const runs = (s, triggerId, limit = 20) => s.db.many('SELECT * FROM actor_trigger_runs WHERE trigger_id = $1 ORDER BY created_at DESC LIMIT $2', [triggerId, limit]);
const removeRuns = (s, triggerId) => s.db.query('DELETE FROM actor_trigger_runs WHERE trigger_id = $1', [triggerId]);
const remove = async (s, owner, id) => {
    await s.db.query('DELETE FROM actor_trigger_runs WHERE trigger_id = $1', [id]);
    await s.db.query('DELETE FROM actor_triggers WHERE id = $1 AND owner = $2', [id, owner]);
};

module.exports = { wire, get, byWatch, list, countActive, countForAgent, insert, update, addRun, runForTask, runs, removeRuns, remove };

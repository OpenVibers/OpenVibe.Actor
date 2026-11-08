'use strict';

/**
 * HO5 (plan track HO, wave 2): an agent's memory that consolidates itself.
 *
 * Once a person turns it on ("Tidy my agents' memory each night", /memory), a due-based job runs their agents' notes
 * through ONE model call a night, in the cheapest class that can wait (OpenVibe.AI's latency classes: 'batch', or
 * 'background' when the client cannot ask for batch). The model answers with DATA — a list of merges, retires and
 * promotions, and a short diary — and nothing it says happens until it has been checked against the agent's own notes:
 *
 *   merge    two or more notes that say the same thing become one note; the sources are kept and marked merged_into;
 *   retire   a note that is stale, or that a newer note contradicts, is marked retired_at: never deleted;
 *   promote  a note that recurs becomes a pinned note, and the agent reads pinned notes first;
 *   diary    two to five plain sentences, "what I learned this week", in the agent's voice.
 *
 * The rules the model cannot break:
 *   - only the agent's own notes (origin 'agent') are ever touched: a note the person wrote, or pinned by hand, is
 *     left alone;
 *   - every id in the answer must be one of the notes that were sent: an id from another agent, or from another
 *     person, is ignored;
 *   - a merge whose result is longer than its sources together is refused;
 *   - at most MAX_CHANGES changes a night, per person;
 *   - the person's own words still make the only active memory: the tidy never writes one. (A merged note is a
 *     compaction of notes the person had already accepted, so it is active because its sources were — it adds no word
 *     that was not already there, and it reads nothing outside the agent's own memory.)
 *
 * Every applied change is a row (actor_memory_changes), so the person can undo it for UNDO_DAYS days. Nothing runs for
 * a person who has not turned it on, and the job is off in a drill (server/index.js).
 */
const memory = require('./index');

const MAX_CHANGES = 20;      // changes a night, per person
const MIN_NOTES = 8;         // an agent with this many notes is due
const MIN_NEW = 3;           // or this many new notes since its last tidy
const UNDO_DAYS = 30;
const NIGHT_HOUR = 4;        // 04:00 UTC: when a night's tidy is due
const MAX_DIARY = 2000;
const MAX_SOURCES = 5;       // notes in one merge
const MAX_NOTES = 60;        // notes sent to the model
const OWNER = /^user:usr_[0-9A-HJKMNP-TV-Z]{26}$/;
const MEM_ID = /^mem_[0-9A-HJKMNP-TV-Z]{26}$/;

const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();

/** The UTC date of the night a moment belongs to (04:00 UTC opens it). */
const nightOf = (at) => new Date(at).toISOString().slice(0, 10);

/** The next 04:00 UTC after a moment: when the person's next night is due. */
function nextNight(at) {
    const d = new Date(at);
    const night = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), NIGHT_HOUR));
    if (night.getTime() <= d.getTime()) night.setUTCDate(night.getUTCDate() + 1);
    return night.toISOString();
}

/** How many sentences a diary has: two to five is what a diary is. */
function sentences(text) {
    return norm(text).split(/(?<=[.!?])\s+/).filter((x) => x.trim().length).length;
}

// ── The person's consent ─────────────────────────────────────────────────────────────────────────────────────

/** What this person asked for: off until they turn it on. */
async function settings(s, owner) {
    const row = await s.db.maybe('SELECT * FROM actor_memory_tidy WHERE owner = $1', [owner]);
    return {
        owner,
        enabled: Boolean(row && row.enabled),
        next_due_at: (row && row.next_due_at) || null,
        last_run_at: (row && row.last_run_at) || null,
        last_error: (row && row.last_error) || null,
    };
}

/**
 * Turn the nightly tidy on or off for this person. Turning it on makes their next night due (04:00 UTC); turning it
 * off stops it: the row stays, so the person sees when it last ran.
 */
async function setEnabled(s, owner, enabled, now = Date.now()) {
    if (!OWNER.test(String(owner || ''))) return { error: 'No such person.' };
    const at = new Date(now).toISOString();
    const row = await s.db.maybe(`INSERT INTO actor_memory_tidy (owner, enabled, next_due_at, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $4)
        ON CONFLICT (owner) DO UPDATE SET enabled = EXCLUDED.enabled, next_due_at = EXCLUDED.next_due_at, updated_at = EXCLUDED.updated_at
        RETURNING *`,
    [owner, Boolean(enabled), enabled ? nextNight(now) : null, at]);
    return { owner: row.owner, enabled: row.enabled, next_due_at: row.next_due_at };
}

/** The people whose night is due. The job is due-based: a row per person, never an interval in the code. */
const dueOwners = async (s, now, limit = 50) => (await s.db.many(
    'SELECT owner FROM actor_memory_tidy WHERE enabled AND next_due_at IS NOT NULL AND next_due_at <= $1 ORDER BY next_due_at LIMIT $2',
    [new Date(now).toISOString(), limit],
)).map((r) => r.owner);

/** Take the person's night: the row moves to the next night, so a second worker cannot take the same one. */
async function claim(s, owner, now) {
    const at = new Date(now).toISOString();
    return await s.db.maybe(`UPDATE actor_memory_tidy SET next_due_at = $1, updated_at = $2
        WHERE owner = $3 AND enabled AND next_due_at IS NOT NULL AND next_due_at <= $4 RETURNING *`,
    [nextNight(now), at, owner, at]);
}

// ── The agent's notes ───────────────────────────────────────────────────────────────────────────────────────

/**
 * The notes a night may work on: this agent's own notes (origin 'agent'), active, neither merged away nor retired.
 * A note the person wrote is never here, and neither is one they pinned by hand.
 */
async function candidateNotes(s, owner, agentId) {
    return await s.db.many(
        `SELECT id, owner, agent_id, text, kind, origin, status, created_at, updated_at, merged_into, retired_at, pinned, pinned_by
           FROM actor_agent_memory
          WHERE owner = $1 AND agent_id = $2 AND origin = 'agent' AND status = 'active'
            AND retired_at IS NULL AND merged_into IS NULL
          ORDER BY created_order DESC LIMIT $3`,
        [owner, agentId, MAX_NOTES],
    );
}

/** When this agent was tidied last (the last night's run), or null. */
async function lastRunAt(s, agentId) {
    const row = await s.db.maybe('SELECT created_at FROM actor_memory_tidy_runs WHERE agent_id = $1 ORDER BY created_at DESC LIMIT 1', [agentId]);
    return row ? row.created_at : null;
}

/** Is this agent due tonight: enough notes, or enough new ones since its last tidy? */
async function isDue(s, owner, agent) {
    const notes = await candidateNotes(s, owner, agent.id);
    if (!notes.length) return { due: false, notes: [], fresh: 0 };
    const last = await lastRunAt(s, agent.id);
    const fresh = last ? notes.filter((n) => Date.parse(n.created_at) > Date.parse(last)).length : notes.length;
    return { due: notes.length >= MIN_NOTES || fresh >= MIN_NEW, notes, fresh };
}

// ── The model call ───────────────────────────────────────────────────────────────────────────────────────────

const SYSTEM = `You are an agent tidying your own memory. You answer with JSON only, never with prose around it.
The notes you are given are your own notes (you wrote them); you may merge, retire or promote them, and nothing else.
Answer: {"changes":[{"kind":"merge","sources":["id","id"],"text":"the one note that replaces them"},{"kind":"retire","id":"id","reason":"why it is stale"},{"kind":"promote","id":"id"}],"diary":"two to five plain sentences"}
Rules: use only the ids you were given; a merge needs two to five ids; the merged text must be no longer than the
sources together and must say the same thing as them; retire a note only when it is stale or a newer note contradicts
it; promote a note that keeps coming up; the diary is in your own voice and says what you learned this week.`;

/** The prompt: the agent's own notes, each with its id, and what to answer. */
function userPrompt(agent, notes) {
    const lines = notes.map((n) => `[${n.id}] ${n.text}`).join('\n');
    return `You are "${agent.name}". Here are your notes:\n\n${lines}\n\nAnswer with the JSON only.`;
}

/**
 * The latency class this call may ask for. The classes live on OpenVibe.AI's router: 'batch' when the call goes
 * through it, 'background' when it cannot ask for batch.
 */
function latencyFor(ctx) {
    // 'background' for now (Opus's review of HO5): a provider's own batch (AI's BA2) may take a day, and this call
    // waits at most ten minutes, so a batch answer would arrive after the night gave up while the provider still bills
    // it. 'batch' comes back once a night can leave its AI run waiting and collect the answer on the next pass.
    const models = ctx && ctx.models;
    if (models && typeof models.latencyClass === 'function' && models.latencyClass() === 'interactive') return 'interactive';
    return 'background';
}

/**
 * ONE call for the night. The answer is DATA: it is parsed, and every id in it is checked against the notes that were
 * sent before anything happens.
 */
async function askModel(ctx, agent, notes, { latency = 'batch' } = {}) {
    const owner = agent.owner;
    const subject = owner.startsWith('user:') ? owner.slice(5) : owner;
    const out = await ctx.models.chat({
        tier: 'smart',
        json: true,
        latency,
        subject,
        messages: [
            { role: 'system', content: SYSTEM },
            { role: 'user', content: userPrompt(agent, notes) },
        ],
    });
    const text = String((out && out.text) || '');
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { parsed = null; }
    return {
        proposal: parsed && typeof parsed === 'object' ? parsed : null,
        raw: text.slice(0, 4000),
        model: (out && out.model) || null,
        cost_usd: Number(out && out.cost_usd) || 0,
        latency_class: (out && out.latency_class) || latency,
    };
}

// ── Applying what the model said ────────────────────────────────────────────────────────────────────────────

/** A note the tidy may touch: the agent's own, active, not merged away, not retired, not pinned by the person. */
function touchable(note) {
    if (!note) return false;
    if (note.origin !== 'agent') return false;
    if (note.status !== 'active') return false;
    if (note.merged_into || note.retired_at) return false;
    if (note.pinned_by === 'person') return false;
    return true;
}

/** The state a note is in now, so an undo can put it back exactly as it was. */
const stateOf = (n) => ({
    id: n.id, status: n.status, pinned: Boolean(n.pinned), pinned_by: n.pinned_by || null,
    merged_into: n.merged_into || null, retired_at: n.retired_at || null, created: false,
});

/**
 * Check the model's answer against the agent's notes and apply what may be applied. Returns what was applied, what
 * was refused (and why), and the diary.
 */
async function applyProposal(s, { owner, agentId, notes, proposal, now = Date.now(), budget = MAX_CHANGES }) {
    const at = new Date(now).toISOString();
    const byId = new Map(notes.map((n) => [n.id, n]));
    const applied = [];
    const refused = [];
    let left = budget;
    const list = proposal && Array.isArray(proposal.changes) ? proposal.changes : [];
    for (const change of list) {
        if (!change || typeof change !== 'object') { refused.push({ kind: 'change', why: 'not an object' }); continue; }
        if (left <= 0) { refused.push({ kind: String(change.kind || 'change'), why: `the night's cap (${MAX_CHANGES} changes)` }); break; }
        const kind = String(change.kind || '');
        if (kind === 'merge') {
            const sources = Array.isArray(change.sources) ? change.sources.map((x) => String(x || '')) : [];
            const text = norm(change.text);
            if (sources.length < 2 || sources.length > MAX_SOURCES) { refused.push({ kind, why: 'a merge needs two to five notes' }); continue; }
            if (sources.some((id) => !MEM_ID.test(id) || !byId.has(id))) { refused.push({ kind, why: 'an id is not one of this agent\'s notes' }); continue; }
            if (new Set(sources).size !== sources.length) { refused.push({ kind, why: 'the same note twice' }); continue; }
            const from = sources.map((id) => byId.get(id));
            if (!from.every(touchable)) { refused.push({ kind, why: 'a note may not be touched (the person wrote it, pinned it, or it is already merged or retired)' }); continue; }
            if (!text) { refused.push({ kind, why: 'the merged note has no text' }); continue; }
            if (text.length > memory.MAX_TEXT) { refused.push({ kind, why: `the merged note is longer than ${memory.MAX_TEXT} characters` }); continue; }
            const together = from.reduce((n, x) => n + x.text.length, 0);
            if (text.length > together) { refused.push({ kind, why: 'the merged note is longer than its sources together' }); continue; }
            const why = memory.whyRefused(text, { kind: from[0].kind });
            if (why) { refused.push({ kind, why }); continue; }
            const id = s.newId('mem');
            await s.db.query(`INSERT INTO actor_agent_memory (id, agent_id, owner, text, kind, origin, status, source_task, created_at, updated_at, last_used_at, uses)
                VALUES ($1,$2,$3,$4,$5,'agent','active',NULL,$6,$6,NULL,0)`, [id, agentId, owner, text, from[0].kind, at]);
            for (const note of from) {
                await s.db.query('UPDATE actor_agent_memory SET status = $1, merged_into = $2, updated_at = $3 WHERE id = $4 AND owner = $5',
                    ['archived', id, at, note.id, owner]);
            }
            applied.push({
                kind, note_ids: sources, result_id: id, detail: text,
                before: [...from.map(stateOf), { id, created: true }],
            });
            left -= 1;
            continue;
        }
        if (kind === 'retire' || kind === 'promote') {
            const id = String(change.id || '');
            if (!MEM_ID.test(id) || !byId.has(id)) { refused.push({ kind, why: 'an id is not one of this agent\'s notes' }); continue; }
            const note = byId.get(id);
            if (!touchable(note)) { refused.push({ kind, why: 'a note may not be touched (the person wrote it, pinned it, or it is already merged or retired)' }); continue; }
            if (kind === 'retire') {
                await s.db.query("UPDATE actor_agent_memory SET status = 'archived', retired_at = $1, updated_at = $2 WHERE id = $3 AND owner = $4",
                    [at, at, id, owner]);
            } else {
                await s.db.query("UPDATE actor_agent_memory SET pinned = true, pinned_by = 'agent', updated_at = $1 WHERE id = $2 AND owner = $3",
                    [at, id, owner]);
            }
            applied.push({ kind, note_ids: [id], result_id: null, detail: kind === 'retire' ? norm(change.reason || '') : '', before: [stateOf(note)] });
            left -= 1;
            continue;
        }
        refused.push({ kind: kind || 'change', why: 'not a change this agent can make' });
    }
    // The diary: two to five plain sentences, and never a secret.
    let diary = null;
    const said = proposal && typeof proposal.diary === 'string' ? norm(proposal.diary) : '';
    if (said) {
        if (said.length > MAX_DIARY) refused.push({ kind: 'diary', why: `longer than ${MAX_DIARY} characters` });
        else if (sentences(said) < 2 || sentences(said) > 5) refused.push({ kind: 'diary', why: 'a diary is two to five sentences' });
        else if (memory.looksLikeSecret(said)) refused.push({ kind: 'diary', why: 'it looks like a secret' });
        else diary = said;
    }
    return { applied, refused, diary };
}

/** The changes of a night, as rows the person can undo. */
async function record(s, { owner, agentId, runId, applied, now = Date.now() }) {
    const at = new Date(now).toISOString();
    const rows = [];
    for (const change of applied) {
        const row = await s.db.maybe(`INSERT INTO actor_memory_changes (id, owner, agent_id, tidy_run_id, kind, note_ids, result_id, detail, before_state, created_at)
            VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9::jsonb,$10) RETURNING *`,
        [s.newId('mch'), owner, agentId, runId, change.kind, JSON.stringify(change.note_ids || []), change.result_id || null,
            change.detail ? String(change.detail).slice(0, 500) : null, JSON.stringify(change.before || []), at]);
        rows.push(row);
    }
    return rows;
}

/** The diary entry of a night. */
async function writeDiary(s, { owner, agentId, text, now = Date.now() }) {
    const at = new Date(now).toISOString();
    return await s.db.maybe('INSERT INTO actor_memory_diary (id, owner, agent_id, text, created_at) VALUES ($1,$2,$3,$4,$5) RETURNING *',
        [s.newId('dia'), owner, agentId, text, at]);
}

/**
 * Undo one change: the sources come back and the merged note goes. It works for UNDO_DAYS days, and only once.
 */
async function undo(s, owner, changeId, { now = Date.now() } = {}) {
    if (!OWNER.test(String(owner || ''))) return { status: 404, error: 'No such change.' };
    const at = new Date(now).toISOString();
    return await s.tx(async () => {
        const row = await s.db.maybe('SELECT * FROM actor_memory_changes WHERE id = $1 AND owner = $2 FOR UPDATE', [changeId, owner]);
        if (!row) return { status: 404, error: 'No such change.' };
        if (row.undone_at) return { status: 409, error: 'This change was already undone.' };
        const age = now - Date.parse(row.created_at || at);
        if (!Number.isFinite(age) || age > UNDO_DAYS * 86_400_000) return { status: 409, error: `This change is older than ${UNDO_DAYS} days: it can no longer be undone.` };
        const before = Array.isArray(row.before_state) ? row.before_state : [];
        for (const state of before) {
            if (!state || !state.id) continue;
            if (state.created) {
                // The note the merge made: it goes, and the sources come back.
                await s.db.query('DELETE FROM actor_agent_memory WHERE id = $1 AND owner = $2', [state.id, owner]);
                continue;
            }
            await s.db.query(`UPDATE actor_agent_memory SET status = $1, pinned = $2, pinned_by = $3, merged_into = $4, retired_at = $5, updated_at = $6
                WHERE id = $7 AND owner = $8`,
            [state.status, Boolean(state.pinned), state.pinned_by || null, state.merged_into || null, state.retired_at || null, at, state.id, owner]);
        }
        await s.db.query('UPDATE actor_memory_changes SET undone_at = $1 WHERE id = $2', [at, changeId]);
        return { row: { id: changeId, undone_at: at } };
    });
}

// ── The night ───────────────────────────────────────────────────────────────────────────────────────────────

/**
 * One person's night: for every agent that is due, ONE model call, and what it said applied. The night's cap is the
 * person's, shared by their agents.
 */
async function runNight(ctx, { owner, now = Date.now() } = {}) {
    const { s } = ctx;
    const agents = await s.db.many('SELECT id, owner, name, instructions FROM actor_agents WHERE owner = $1 ORDER BY id', [owner]);
    let budget = MAX_CHANGES;
    const nights = [];
    for (const agent of agents) {
        const due = await isDue(s, owner, agent);
        if (!due.due) continue;
        const latency = latencyFor(ctx);
        let asked = null;
        try {
            asked = await askModel(ctx, agent, due.notes, { latency });
        } catch (err) {
            await s.db.query('UPDATE actor_memory_tidy SET last_error = $1, updated_at = $2 WHERE owner = $3',
                [String((err && err.message) || err).slice(0, 300), new Date(now).toISOString(), owner]);
            continue;
        }
        // The night's writes land together: the notes it changed, the diary, the night's record and the rows the
        // person can undo. If any of it fails, none of it happened.
        const night = await s.tx(async () => {
            const out = await applyProposal(s, { owner, agentId: agent.id, notes: due.notes, proposal: asked.proposal, now, budget });
            const runId = s.newId('mty');
            await s.db.query(`INSERT INTO actor_memory_tidy_runs (id, owner, agent_id, night_of, diary, changes, model, latency_class, cost_usd, created_at)
                VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10)`,
            [runId, owner, agent.id, nightOf(now), out.diary,
                JSON.stringify(out.applied.map((c) => ({ kind: c.kind, note_ids: c.note_ids, result_id: c.result_id || null }))),
                asked.model, asked.latency_class, asked.cost_usd, new Date(now).toISOString()]);
            if (out.diary) await writeDiary(s, { owner, agentId: agent.id, text: out.diary, now });
            const changes = await record(s, { owner, agentId: agent.id, runId, applied: out.applied, now });
            return { runId, applied: out.applied.length, refused: out.refused.length, changes, out };
        });
        budget -= night.applied;
        nights.push({ agent_id: agent.id, run_id: night.run_id, applied: night.applied, refused: night.refused, changes: night.changes });
    }
    await s.db.query('UPDATE actor_memory_tidy SET last_run_at = $1, last_error = NULL, updated_at = $2 WHERE owner = $3',
        [new Date(now).toISOString(), new Date(now).toISOString(), owner]);
    return { owner, nights };
}

/**
 * The job: the people whose night is due. A person whose next_due_at is in the future is left alone; a person who has
 * not turned it on is never here.
 */
async function runDue(ctx, { now = Date.now() } = {}) {
    const owners = await dueOwners(ctx.s, now);
    const done = [];
    for (const owner of owners) {
        const claimed = await claim(ctx.s, owner, now);
        if (!claimed) continue;
        done.push(await runNight(ctx, { owner, now }));
    }
    return done;
}

/**
 * The loop itself. It is due-based (a row per person with a next_due_at), and it is off in a drill (ACTOR_DRILL=1)
 * and in a test: the same switch the other boot jobs use. Returns the stops, so the process can shut it down.
 */
function startJobs(ctx, { log = console } = {}) {
    const config = ctx && ctx.config;
    if (!config || config.drill || config.nodeEnv === 'test') return [];
    const jobs = require('../utils/jobs');
    return [
        jobs.every('actor-memory-tidy', 15 * 60_000, () => runDue(ctx, { now: Date.now() }), { initialDelayMs: 60_000, log }),
    ];
}

// ── What the person sees ──────────────────────────────────────────────────────────────────────────────────

/** The diary entries of a person (newest first), optionally of one agent. */
async function diary(s, owner, { agentId = null, limit = 20 } = {}) {
    return await s.db.many(
        `SELECT id, owner, agent_id, text, created_at, edited_at FROM actor_memory_diary
          WHERE owner = $1 AND deleted_at IS NULL AND ($2::text IS NULL OR agent_id = $2)
          ORDER BY created_at DESC LIMIT $3`,
        [owner, agentId, limit]);
}

/** The changes of a person (newest first), optionally of one agent. */
async function changes(s, owner, { agentId = null, limit = 20, now = Date.now() } = {}) {
    const rows = await s.db.many(
        `SELECT id, owner, agent_id, tidy_run_id, kind, note_ids, result_id, detail, created_at, undone_at FROM actor_memory_changes
          WHERE owner = $1 AND ($2::text IS NULL OR agent_id = $2)
          ORDER BY created_at DESC LIMIT $3`,
        [owner, agentId, limit]);
    return rows.map((r) => ({
        ...r,
        note_ids: Array.isArray(r.note_ids) ? r.note_ids : [],
        undoable: !r.undone_at && (now - Date.parse(r.created_at || 0)) <= UNDO_DAYS * 86_400_000,
    }));
}

/** The last night's run of one agent (or of a person), for the page. */
async function lastRun(s, owner, { agentId = null } = {}) {
    return await s.db.maybe(
        `SELECT id, owner, agent_id, night_of, diary, changes, model, latency_class, cost_usd, created_at FROM actor_memory_tidy_runs
          WHERE owner = $1 AND ($2::text IS NULL OR agent_id = $2) ORDER BY created_at DESC LIMIT 1`,
        [owner, agentId]);
}

/** Edit a diary entry (the person's own words now). */
async function editDiary(s, owner, id, text) {
    const body = norm(text);
    if (!body || body.length > MAX_DIARY) return { error: `A diary entry is 1 to ${MAX_DIARY} characters.` };
    const row = await s.db.maybe('UPDATE actor_memory_diary SET text = $1, edited_at = $2 WHERE id = $3 AND owner = $4 AND deleted_at IS NULL RETURNING *',
        [body, s.iso(), id, owner]);
    return row ? { row } : { error: 'No such diary entry.' };
}

/** Delete a diary entry (it goes; the night's record of it stays). */
async function deleteDiary(s, owner, id) {
    const row = await s.db.maybe('UPDATE actor_memory_diary SET deleted_at = $1 WHERE id = $2 AND owner = $3 AND deleted_at IS NULL RETURNING id',
        [s.iso(), id, owner]);
    return row ? { row } : { error: 'No such diary entry.' };
}

module.exports = {
    MAX_CHANGES, MIN_NOTES, MIN_NEW, UNDO_DAYS, NIGHT_HOUR, MAX_DIARY,
    nightOf, nextNight, sentences,
    settings, setEnabled, dueOwners, claim, candidateNotes, isDue, lastRunAt,
    latencyFor, askModel, applyProposal, record, writeDiary, undo,
    runNight, runDue, startJobs, diary, changes, lastRun, editDiary, deleteDiary,
};

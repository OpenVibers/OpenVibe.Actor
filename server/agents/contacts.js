'use strict';

/**
 * Agents are contacts (plan §12 A-1). A person's agents live in actor_agents, the same rows their scheduled personal
 * agents use, grown with the contact fields: a face and a voice, a model (runtime, own keys, a free model on OpenVibe's
 * GPU, or their own harness on a Link machine), a computer, connected apps, a Memory scope and an approval level.
 *
 * Vibe is the first agent of every person: created on the first read (ensureVibe), first in the list and not deletable.
 * There are four presets (Researcher, Inbox, Studio editor, Party host) that a create can copy.
 *
 * A task is a thread: it records the contact it runs as (agent_id) and its own level. The effective level is the higher
 * of the agent's level and the thread's, inherited only along the same person's parent tasks — never from another
 * person's or a service's work. The always-ask floor itself lives in levels.js and is applied at the approval gate.
 *
 *   ensureVibe(s, config, owner) / list(s, config, owner) / get(s, owner, id)
 *   create(s, config, owner, input) / update(s, config, owner, id, patch) / remove(s, owner, id) / setLevel(...)
 *   presets() / wire(row)
 *   agentForTask(s, config, task) / effectiveLevelFor(s, task, agent) / maxLevel(...)
 */
const levels = require('./levels');

const ID = /^agt_[0-9A-HJKMNP-TV-Z]{26}$/;
const ENGINE = ['runtime', 'own-keys', 'open-gpu', 'link'];
const KINDS = ['browser', 'kept-browser', 'desktop', 'gpu-desktop', 'always-on', 'your-computer', 'throwaway'];
const PLACEMENTS = ['auto', 'link', 'home', 'ovh'];
const APP = /^[a-z][a-z0-9._-]{0,63}$/;
const ALLOWED = ['preset', 'name', 'face', 'voice', 'model', 'computer', 'apps', 'memory', 'level', 'instructions'];
const VIBE_INSTRUCTIONS = 'You are Vibe, this person\'s first agent. Help them with whatever they bring you: answer, plan, and use the tools you are allowed. Ask before anything that spends money, reveals a password, deletes something or sends to a new recipient.';

const PRESETS = [
    {
        id: 'researcher', name: 'Researcher', face: 'preset:researcher', voice: null,
        model: { engine: 'runtime', model: 'smart' }, computer: { kind: 'kept-browser', placement: 'auto' },
        apps: [], memory: null, level: 'ask',
        instructions: 'Research carefully. Prefer primary sources, date every claim, and say plainly when the evidence does not settle a question.',
    },
    {
        id: 'inbox', name: 'Inbox', face: 'preset:inbox', voice: null,
        model: { engine: 'runtime', model: 'fast' }, computer: null,
        apps: ['connect.email', 'connect.slack'], memory: null, level: 'ask',
        instructions: 'Keep the person\'s inbox clear: triage what arrives, summarise threads, and draft replies for them to send. Never send to a new recipient without asking.',
    },
    {
        id: 'studio-editor', name: 'Studio editor', face: 'preset:studio', voice: null,
        model: { engine: 'own-keys', model: 'openai:gpt-5.1' }, computer: { kind: 'desktop', placement: 'link' },
        apps: ['connect.media'], memory: null, level: 'ask',
        instructions: 'Edit video and audio on the person\'s own machine. Keep every original, make the edit reversible, and show the change before publishing anything.',
    },
    {
        id: 'party-host', name: 'Party host', face: 'preset:party', voice: null,
        model: { engine: 'runtime', model: 'fast' }, computer: { kind: 'browser', placement: 'auto' },
        apps: ['connect.chat'], memory: null, level: 'ask',
        instructions: 'Host a room warmly: greet people, keep the queue moving, and share what is playing. Never invite or message a new person without the host\'s yes.',
    },
];

const preset = (id) => PRESETS.find((p) => p.id === String(id || '')) || null;
const presets = () => ({ presets: PRESETS.map((p) => ({ ...p, model: { ...p.model }, computer: p.computer ? { ...p.computer } : null, apps: [...p.apps] })) });

const parse = (v) => (v == null ? null : typeof v === 'string' ? JSON.parse(v) : v);

function wire(row) {
    return {
        id: row.id,
        owner: row.owner,
        name: row.name,
        face: row.face || 'preset:agent',
        voice: row.voice || null,
        model: { engine: row.model_engine || 'runtime', model: row.model_id || 'smart' },
        computer: parse(row.computer),
        apps: parse(row.apps) || [],
        memory: row.memory_scope || null,
        level: levels.LEVELS.includes(row.level) ? row.level : 'ask',
        created_at: row.created_at,
    };
}

function validate(next) {
    if (typeof next.name !== 'string' || !next.name.trim() || next.name.length > 60) return 'name must be 1–60 characters.';
    if (typeof next.face !== 'string' || !next.face.trim() || next.face.length > 500) return 'face must be an avatar ref of 1–500 characters.';
    if (next.voice != null && (typeof next.voice !== 'string' || next.voice.length > 80)) return 'voice must be a TTS voice id or null.';
    if (!next.model || typeof next.model !== 'object' || Array.isArray(next.model)) return 'model must be { engine, model }.';
    if (!ENGINE.includes(next.model.engine)) return `model.engine must be one of ${ENGINE.join(', ')}.`;
    if (typeof next.model.model !== 'string' || !next.model.model.trim() || next.model.model.length > 120) return 'model.model must be 1–120 characters.';
    if (next.computer != null) {
        if (typeof next.computer !== 'object' || Array.isArray(next.computer)) return 'computer must be null or { kind, placement }.';
        if (!KINDS.includes(next.computer.kind)) return `computer.kind must be one of ${KINDS.join(', ')}.`;
        if (!PLACEMENTS.includes(next.computer.placement)) return `computer.placement must be one of ${PLACEMENTS.join(', ')}.`;
    }
    if (!Array.isArray(next.apps) || next.apps.length > 50 || new Set(next.apps).size !== next.apps.length) return 'apps must be an array of at most 50 distinct app ids.';
    if (next.apps.some((a) => typeof a !== 'string' || !APP.test(a))) return 'each app id must be a connect slug.';
    if (next.memory != null && (typeof next.memory !== 'string' || next.memory.length > 100)) return 'memory must be a Memory scope id or null.';
    if (!levels.LEVELS.includes(next.level)) return `level must be one of ${levels.LEVELS.join(', ')}.`;
    return null;
}

async function ensureVibe(s, config, owner) {
    const existing = await s.db.maybe('SELECT * FROM actor_agents WHERE owner = $1 AND is_vibe ORDER BY created_at, id LIMIT 1', [owner]);
    if (existing) return existing;
    const now = s.iso();
    const inserted = await s.db.maybe(`INSERT INTO actor_agents
        (id, owner, name, instructions, mode, budget_per_run_usd, daily_runs_max, schedule, status, created_at, updated_at,
         face, voice, model_engine, model_id, computer, apps, memory_scope, level, is_vibe)
        VALUES ($1,$2,'Vibe',$3,'balanced',$4,24,'off','active',$5,$5,'preset:vibe',NULL,'runtime','smart',NULL,'[]'::jsonb,NULL,'ask',true)
        ON CONFLICT DO NOTHING RETURNING *`,
    [s.newId('agt'), owner, VIBE_INSTRUCTIONS, Math.max(0.000001, Number(config.allowance.perTaskUsd) || 0.05), now]);
    if (inserted) return inserted;
    return s.db.maybe('SELECT * FROM actor_agents WHERE owner = $1 AND is_vibe ORDER BY created_at, id LIMIT 1', [owner]);
}

async function list(s, config, owner) {
    await ensureVibe(s, config, owner);
    return s.db.many('SELECT * FROM actor_agents WHERE owner = $1 ORDER BY is_vibe DESC, created_at, id', [owner]);
}

const get = (s, owner, id) => (ID.test(String(id || '')) ? s.db.maybe('SELECT * FROM actor_agents WHERE id = $1 AND owner = $2', [id, owner]) : null);

/**
 * `extra` carries the voice parts of an agent (its bio, its rules and where its voice came from). They are not
 * part of the public create body (actor.agent-manage-request@1 does not know them): only the voice import sets them.
 */
async function create(s, config, owner, input, extra = null) {
    const body = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
    if (Object.keys(body).some((k) => !ALLOWED.includes(k))) return { error: 'Unknown agent setting.' };
    const p = body.preset != null ? preset(body.preset) : null;
    if (body.preset != null && !p) return { error: `preset must be one of ${PRESETS.map((x) => x.id).join(', ')}.` };
    if (!p && body.name == null) return { error: 'name is required when no preset is named.' };
    const base = p || {
        name: '', face: 'preset:agent', voice: null, model: { engine: 'runtime', model: 'smart' }, computer: null,
        apps: [], memory: null, level: 'ask', instructions: '',
    };
    const next = {
        name: body.name != null ? body.name : base.name,
        face: body.face != null ? body.face : base.face,
        voice: body.voice !== undefined ? body.voice : base.voice,
        model: body.model != null ? body.model : base.model,
        computer: body.computer !== undefined ? body.computer : base.computer,
        apps: body.apps != null ? body.apps : base.apps,
        memory: body.memory !== undefined ? body.memory : base.memory,
        level: body.level != null ? body.level : base.level,
    };
    const invalid = validate(next);
    if (invalid) return { error: invalid };
    const instructions = body.instructions != null ? body.instructions : (base.instructions || `You are ${next.name}, one of this person's agents.`);
    if (typeof instructions !== 'string' || !instructions.trim() || instructions.length > 4000) return { error: 'instructions must be 1–4000 characters.' };
    // Vibe comes first even when the first thing a person does is create another contact.
    await ensureVibe(s, config, owner);
    const count = Number(await s.db.value('SELECT count(*) FROM actor_agents WHERE owner = $1', [owner]));
    if (count >= config.agents.maxPerOwner) return { limit: true, error: 'Agent limit reached.' };
    const now = s.iso();
    const row = await s.db.maybe(`INSERT INTO actor_agents
        (id, owner, name, instructions, mode, budget_per_run_usd, daily_runs_max, schedule, status, created_at, updated_at,
         face, voice, model_engine, model_id, computer, apps, memory_scope, level, is_vibe, preset, bio, rules, voice_author, voice_author_name, voice_source)
        VALUES ($1,$2,$3,$4,'balanced',$5,1,'off','active',$6,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13,$14,false,$15,$16,$17::jsonb,$18,$19,$20) RETURNING *`,
    [s.newId('agt'), owner, next.name, instructions, Math.max(0.000001, Number(config.allowance.perTaskUsd) || 0.05), now,
        next.face, next.voice, next.model.engine, next.model.model, next.computer ? JSON.stringify(next.computer) : null,
        JSON.stringify(next.apps), next.memory, next.level, p ? p.id : null,
        extra && extra.bio ? extra.bio : null, JSON.stringify((extra && extra.rules) || []),
        extra && extra.voice_author ? extra.voice_author : null, extra && extra.voice_author_name ? extra.voice_author_name : null,
        extra && extra.voice_source ? extra.voice_source : null]);
    return { row };
}

async function update(s, config, owner, id, patch) {
    const row = await get(s, owner, id);
    if (!row) return null;
    const body = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {};
    if (Object.keys(body).some((k) => !ALLOWED.includes(k) || k === 'preset')) return { error: 'Unknown agent setting.' };
    const next = {
        name: body.name !== undefined ? body.name : row.name,
        face: body.face !== undefined ? body.face : row.face,
        voice: body.voice !== undefined ? body.voice : row.voice,
        model: body.model !== undefined ? body.model : { engine: row.model_engine, model: row.model_id },
        computer: body.computer !== undefined ? body.computer : parse(row.computer),
        apps: body.apps !== undefined ? body.apps : (parse(row.apps) || []),
        memory: body.memory !== undefined ? body.memory : row.memory_scope,
        level: body.level !== undefined ? body.level : row.level,
    };
    const invalid = validate(next);
    if (invalid) return { error: invalid };
    let instructions = row.instructions;
    if (body.instructions !== undefined) {
        if (typeof body.instructions !== 'string' || !body.instructions.trim() || body.instructions.length > 4000) return { error: 'instructions must be 1–4000 characters.' };
        instructions = body.instructions;
    }
    return { row: await s.db.maybe(`UPDATE actor_agents SET name=$3, face=$4, voice=$5, model_engine=$6, model_id=$7,
        computer=$8::jsonb, apps=$9::jsonb, memory_scope=$10, level=$11, instructions=$12, updated_at=$13
        WHERE id=$1 AND owner=$2 RETURNING *`,
    [id, owner, next.name, next.face, next.voice, next.model.engine, next.model.model, next.computer ? JSON.stringify(next.computer) : null,
        JSON.stringify(next.apps), next.memory, next.level, instructions, s.iso()]) };
}

async function remove(s, owner, id) {
    const row = await get(s, owner, id);
    if (!row) return null;
    if (row.is_vibe) return { error: 'Vibe is your first agent and cannot be deleted.', status: 409, code: 'actor.agent.vibe' };
    await s.db.query('DELETE FROM actor_agents WHERE id = $1 AND owner = $2', [id, owner]);
    return { row };
}

const setLevel = (s, config, owner, id, level) => update(s, config, owner, id, { level });

/** The contact a task runs as: its agent_id, else the personal agent that started it, else the person's Vibe. */
async function agentForTask(s, config, task) {
    if (!task) return null;
    if (task.agent_id && ID.test(String(task.agent_id))) {
        const row = await get(s, task.requester, task.agent_id);
        if (row) return row;
    }
    if (/^agent:agt_/.test(String(task.via || ''))) {
        const row = await get(s, task.requester, String(task.via).slice(6));
        if (row) return row;
    }
    if (String(task.requester || '').startsWith('user:')) return ensureVibe(s, config, task.requester);
    return null;
}

/**
 * The level a task's steps run at: max(the agent's own level, the thread's level and the levels of the person's own
 * parent tasks). Only the same requester's chain is followed; another person's task ends the walk (never inherited
 * from outside work). Cycles are impossible in new tasks but a corrupted chain stops at the first repeat.
 */
async function effectiveLevelFor(s, task, agent = null) {
    let out = levels.maxLevel(agent && agent.level, task && task.level);
    let at = task && task.parent_id;
    const seen = new Set();
    while (at && !seen.has(at)) {
        seen.add(at);
        const parent = await s.db.maybe('SELECT id, requester, parent_id, level FROM tasks WHERE id = $1', [at]);
        if (!parent || !task || parent.requester !== task.requester) break;
        out = levels.maxLevel(out, parent.level);
        at = parent.parent_id;
    }
    return out;
}

module.exports = { ID, PRESETS, PRESET_IDS: PRESETS.map((p) => p.id), ensureVibe, list, get, create, update, remove, setLevel, presets, wire, validate, agentForTask, effectiveLevelFor, maxLevel: levels.maxLevel };

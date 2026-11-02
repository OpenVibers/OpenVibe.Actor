'use strict';

/**
 * Memory (Actor v2, stage V2-6): the person's own notes and their personal agents' notes, in one table
 * (actor_agent_memory, extended by migrations/0017_actor_memories.sql).
 *
 * What makes a memory active is the security rule, not the model's word:
 *   - only the person's own words, written or said in a run that read nothing outside Actor, make a memory `active`;
 *   - anything the agent infers from a page, a tool result or a file is `suggested` and does nothing until the person
 *     accepts it on /memory;
 *   - a secret (key, token, password, card number, one-time code), anything about how a person looks, and an
 *     instruction that would widen the agent's permissions or budget are refused when the memory is written.
 *
 * `recall` reads only active memories, scores them by word overlap and recency (no embeddings yet), returns at most
 * eight and records that it used them. There is one store; nothing here keeps a second copy.
 */


const KINDS = Object.freeze(['fact', 'preference', 'instruction']);
const STATUSES = Object.freeze(['active', 'suggested', 'archived']);
const SOURCES = Object.freeze(['person', 'agent']);
const MAX_TEXT = 500;
const MAX_PER_AGENT = 50;
const MAX_PER_PERSON = 500;
const MAX_RECALL = 8;
const MEM_ID = /^mem_[0-9A-HJKMNP-TV-Z]{26}$/;
const OWNER = /^user:usr_[0-9A-HJKMNP-TV-Z]{26}$/;

const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
const words = (s) => norm(s).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1);
// A crude stem so "units"/"unit", "prefers"/"prefer" and "metrics"/"metric" meet.
const stem = (w) => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w);

// Credentials from the redaction the code already uses (OpenVibe.Codes harness/events.js), plus the card and one-time
// code shapes a person may paste by accident. A memory is never the place for one.
const SECRET_PATTERNS = [
    /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g,
    /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
    /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
    /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
    /\bAKIA[0-9A-Z]{16}\b/g,
    /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/g,
    /\b(?:api[_-]?key|access[_-]?token|client[_-]?secret|secret|password|passwd|passcode|pin)\b\s*[:=]?\s*(?:is\s+)?["']?[^\s"']{4,}/gi,
    /\b(?:otp|one[- ]time (?:code|password)|verification code|security code|two[- ]factor code|2fa code)\b[^\n]{0,24}\b\d{4,8}\b/gi,
    /\b(?:code|passcode|pin)\b[^\n.]{0,16}\b\d{4,8}\b/gi,
];
const CARD = /(?:\d[ -]?){12,18}\d/g;

/** A card number has a Luhn checksum; a date range or a phone number almost never does. */
function luhn(digits) {
    let sum = 0;
    let double = false;
    for (let i = digits.length - 1; i >= 0; i--) {
        let d = digits.charCodeAt(i) - 48;
        if (double) { d *= 2; if (d > 9) d -= 9; }
        sum += d;
        double = !double;
    }
    return sum % 10 === 0;
}

function looksLikeSecret(text) {
    const t = String(text || '');
    if (SECRET_PATTERNS.some((re) => { re.lastIndex = 0; return re.test(t); })) return true;
    for (const m of t.matchAll(CARD)) {
        const digits = m[0].replace(/[ -]/g, '');
        if (digits.length >= 13 && digits.length <= 19 && luhn(digits)) return true;
    }
    return false;
}

// An instruction may narrow ("ask before spending"), never widen: no new permission to send, post, pay, sign up or
// contact a person, and no bigger budget. A person grants permissions in the task itself, never in a memory.
const WIDEN = [
    /\b(?:always|automatically|freely|without (?:asking|my approval|permission|me)|no need to ask|don'?t ask)\b[\s\S]{0,80}\b(?:send|post|publish|pay|buy|order|book|sign up|subscribe|contact|email|message|call|forward|share|delete|remove|transfer)\b/i,
    /\b(?:send|post|publish|pay|buy|order|book|subscribe|contact|email|message|forward|share|delete|remove|transfer)\b[\s\S]{0,80}\b(?:automatically|without asking|without my approval|without permission|on my behalf)\b/i,
    /\b(?:all|every)\s+(?:my\s+)?(?:mail|email|messages?|calls?|files?|money|payments?)\b[\s\S]{0,60}\b(?:forward|send|share|transfer|delete)\b/i,
    /\b(?:raise|increase|ignore|exceed|bypass|lift|remove)\b[\s\S]{0,40}\b(?:budget|limit|allowance|cap|permission|approval)\b/i,
    /\b(?:spend|use|pay)\b[\s\S]{0,30}\$\s*\d/i,
];
const NARROW = /\b(?:ask|check|confirm|wait|get (?:my )?(?:approval|permission)|need (?:my )?(?:approval|permission))\b[\s\S]{0,50}\b(?:before|first|me|my)\b/i;
const BAN = /\b(?:never|do not|don'?t|must not|may not|should not)\s+(?:\w+\s+){0,3}(?:send|post|publish|pay|buy|contact|email|message|forward|share|delete|remove|transfer)\w*\b/i;
const DONT_ASK = /\b(?:don'?t|do not|never)\s+ask\b[\s\S]{0,40}\b(?:send|post|pay|contact|email|message|forward|delete|remove|transfer)\w*\b/i;

function instructionWidens(text) {
    const t = norm(text);
    if (!t) return false;
    // "Never send without asking me" and "ask before spending" are narrowing, even though the words overlap the rules;
    // "don't ask before sending" and "always send without asking" are widening.
    if (DONT_ASK.test(t)) return true;
    if (BAN.test(t)) return false;
    if (NARROW.test(t) && !/\bwithout (?:asking|my approval|permission|me)\b/i.test(t)) return false;
    return WIDEN.some((re) => re.test(t));
}

/** Why a memory cannot be written, or null. Checked for every write, whoever asks for it. */
function whyRefused(text, { kind = 'fact' } = {}) {
    const t = norm(text);
    if (!t) return 'A memory needs some words.';
    if (t.length > MAX_TEXT) return `A memory is at most ${MAX_TEXT} characters.`;
    if (!KINDS.includes(kind)) return 'A memory kind is fact, preference or instruction.';
    if (looksLikeSecret(t)) return 'That looks like a secret (a key, token, password, card number or one-time code), so it was not saved.';
    if (kind === 'instruction' && instructionWidens(t)) return 'An instruction memory can only narrow what the agent does: it cannot give it new permissions or a bigger budget.';
    return null;
}

const fromRow = (r) => (r ? {
    id: r.id, owner: r.owner, agent_id: r.agent_id || null, text: r.text, kind: r.kind, source: r.origin, status: r.status,
    source_task: r.source_task || null, created_at: r.created_at, updated_at: r.updated_at,
    last_used_at: r.last_used_at || null, uses: Number(r.uses) || 0,
} : null);

// The column keeps the name it had in 0005 (`origin`): an expand migration may not rename it while the old release
// still runs. The code and the API call the same value `source` (fromRow maps it).
const select = 'id, owner, agent_id, text, kind, origin, status, source_task, created_at, updated_at, last_used_at, uses';

/**
 * Write one memory. `source` says who it came from; an agent-written note is a suggestion unless the caller explicitly
 * makes it active (nothing in this module does that without the person's own action).
 */
async function add(s, { owner, agentId = null, text, kind = 'fact', source = 'person', status = null, sourceTask = null } = {}) {
    if (!OWNER.test(String(owner || ''))) return { error: 'No such person.' };
    if (!SOURCES.includes(source)) return { error: 'A memory source is person or agent.' };
    const body = norm(text);
    const why = whyRefused(body, { kind });
    if (why) return { error: why };
    const state = status || (source === 'agent' ? 'suggested' : 'active');
    if (!STATUSES.includes(state)) return { error: 'A memory status is active, suggested or archived.' };
    return s.tx(async () => {
        if (agentId) {
            const agent = await s.db.maybe('SELECT id FROM actor_agents WHERE id = $1 AND owner = $2 FOR UPDATE', [agentId, owner]);
            if (!agent) return { error: 'No such agent.' };
            const count = Number(await s.db.value('SELECT count(*) FROM actor_agent_memory WHERE agent_id = $1', [agentId]));
            if (count >= MAX_PER_AGENT) {
                const oldest = await s.db.maybe("SELECT id FROM actor_agent_memory WHERE agent_id = $1 AND origin = 'agent' ORDER BY created_order LIMIT 1", [agentId]);
                if (!oldest) return { limit: true, error: 'This agent\'s memory is full of notes you wrote; delete one first.' };
                await s.db.query('DELETE FROM actor_agent_memory WHERE id = $1', [oldest.id]);
            }
        } else {
            const count = Number(await s.db.value('SELECT count(*) FROM actor_agent_memory WHERE owner = $1 AND agent_id IS NULL', [owner]));
            if (count >= MAX_PER_PERSON) return { limit: true, error: 'Your memory is full: archive or delete a note first.' };
        }
        const prior = await s.db.maybe('SELECT * FROM actor_agent_memory WHERE owner = $1 AND agent_id IS NOT DISTINCT FROM $2 AND lower(text) = lower($3) LIMIT 1', [owner, agentId, body]);
        if (prior) {
            // The person saying it again makes their own earlier suggestion theirs, rather than adding a duplicate.
            if (source === 'person' && (prior.status !== 'active' || prior.origin !== 'person')) {
                const row = await s.db.maybe('UPDATE actor_agent_memory SET status = $1, kind = $2, origin = $3, source_task = COALESCE($4, source_task), updated_at = $5 WHERE id = $6 RETURNING ' + select,
                    ['active', kind, 'person', sourceTask, s.iso(), prior.id]);
                return { row: fromRow(row), duplicate: true };
            }
            return { row: fromRow(prior), duplicate: true };
        }
        const row = await s.db.maybe(`INSERT INTO actor_agent_memory (id, agent_id, owner, text, kind, origin, status, source_task, created_at, updated_at, last_used_at, uses)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9,NULL,0) RETURNING ${select}`,
        [s.newId('mem'), agentId, owner, body, kind, source, state, sourceTask, s.iso()]);
        return { row: fromRow(row) };
    });
}

const get = async (s, owner, id) => (MEM_ID.test(String(id || '')) ? fromRow(await s.db.maybe(`SELECT ${select} FROM actor_agent_memory WHERE id = $1 AND owner = $2`, [id, owner])) : null);

/** The person's own memory (agent_id NULL), newest first. */
const own = async (s, owner, { status = null } = {}) => (await s.db.many(
    `SELECT ${select} FROM actor_agent_memory WHERE owner = $1 AND agent_id IS NULL${status ? ' AND status = $2' : ''} ORDER BY created_order DESC${status ? '' : ' LIMIT 500'}`,
    status ? [owner, status] : [owner],
)).map(fromRow);

/** One agent's notes (all statuses), newest first, for its own page. */
const forAgent = async (s, owner, agentId) => (await s.db.many(
    `SELECT ${select} FROM actor_agent_memory WHERE owner = $1 AND agent_id = $2 ORDER BY created_order DESC`, [owner, agentId],
)).map(fromRow);

/** What one agent's run may remember: the person's own active notes and this agent's active notes, newest first. */
const forRun = async (s, owner, agentId) => (await s.db.many(
    `SELECT ${select} FROM actor_agent_memory WHERE owner = $1 AND status = 'active' AND (agent_id IS NULL OR agent_id = $2) ORDER BY created_order DESC LIMIT 200`,
    [owner, agentId],
)).map(fromRow);

/** Everything the person can see on /memory: their own and every agent's, newest first. */
const list = async (s, owner, { status = null } = {}) => (await s.db.many(
    `SELECT ${select} FROM actor_agent_memory WHERE owner = $1${status ? ' AND status = $2' : ''} ORDER BY created_order DESC${status ? '' : ' LIMIT 500'}`,
    status ? [owner, status] : [owner],
)).map(fromRow);

async function edit(s, owner, id, { text, kind }) {
    const row = await get(s, owner, id);
    if (!row) return null;
    const body = text === undefined ? row.text : norm(text);
    const k = kind === undefined ? row.kind : kind;
    const why = whyRefused(body, { kind: k });
    if (why) return { error: why };
    const next = await s.db.maybe(`UPDATE actor_agent_memory SET text = $1, kind = $2, updated_at = $3 WHERE id = $4 AND owner = $5 RETURNING ${select}`, [body, k, s.iso(), id, owner]);
    return { row: fromRow(next) };
}

/** accept | decline | archive | restore, with the state it may move from. */
const MOVES = {
    accept: { from: ['suggested'], to: 'active' },
    decline: { from: ['suggested'], to: 'archived' },
    archive: { from: ['active'], to: 'archived' },
    restore: { from: ['archived'], to: 'active' },
};

async function decide(s, owner, id, action) {
    const move = MOVES[action];
    if (!move) return { status: 400, error: 'That is not something a memory can do.' };
    return s.tx(async () => {
        const row = await s.db.maybe(`SELECT ${select} FROM actor_agent_memory WHERE id = $1 AND owner = $2 FOR UPDATE`, [id, owner]);
        if (!row) return { status: 404, error: 'No such memory.' };
        if (!move.from.includes(row.status)) return { status: 409, error: 'That memory is not waiting for this.' };
        const next = await s.db.maybe(`UPDATE actor_agent_memory SET status = $1, updated_at = $2 WHERE id = $3 RETURNING ${select}`, [move.to, s.iso(), id]);
        return { row: fromRow(next) };
    });
}

async function remove(s, owner, id) {
    if (!MEM_ID.test(String(id || ''))) return false;
    const row = await s.db.maybe('DELETE FROM actor_agent_memory WHERE id = $1 AND owner = $2 RETURNING id', [id, owner]);
    return Boolean(row);
}

// Words too common to say what a memory is about.
const STOP = new Set('a an and are as at be been but by can could did do does for from had has have he her here him his how i if in into is it its just like me more most my no not of on one or our out over she so some than that the their them then there these they this to too up us was we were what when where which who why will with would you your'.split(' '));
function scoreOf(memory, q, at) {
    const text = words(`${memory.text} ${memory.kind}`).map(stem);
    const seen = new Set(text);
    let overlap = 0;
    for (const w of q) if (seen.has(w)) overlap += 1;
    const t = Date.parse(memory.last_used_at || memory.updated_at || memory.created_at) || at;
    const ageDays = Math.max(0, (at - t) / 86_400_000);
    return { overlap, score: overlap * 4 + 1 / (1 + ageDays / 30) };
}

/**
 * The active memories relevant to `query`, up to eight: word overlap first, then recency. Returns the rows and records
 * the use. A query with no overlap still sees the person's most recent active memories, which is how a standing
 * preference ("metric units") is found even when the task's words do not name it.
 */
async function recall(s, owner, query, { limit = MAX_RECALL, now = Date.now() } = {}) {
    if (!OWNER.test(String(owner || ''))) return [];
    const rows = (await s.db.many(`SELECT ${select} FROM actor_agent_memory WHERE owner = $1 AND status = 'active' ORDER BY created_order DESC LIMIT 300`, [owner])).map(fromRow);
    if (!rows.length) return [];
    const q = [...new Set(words(query).filter((w) => !STOP.has(w)).map(stem))];
    const ranked = rows.map((m) => ({ m, ...scoreOf(m, q, now) }))
        .sort((a, b) => b.score - a.score || String(b.m.created_at).localeCompare(String(a.m.created_at)))
        .slice(0, Math.max(1, Math.min(MAX_RECALL, Number(limit) || MAX_RECALL)));
    const ids = ranked.map((r) => r.m.id);
    if (ids.length) await s.db.query('UPDATE actor_agent_memory SET last_used_at = $1, uses = uses + 1 WHERE owner = $2 AND id = ANY($3::text[])', [new Date(now).toISOString(), owner, ids]);
    const usedAt = new Date(now).toISOString();
    return ranked.map((r) => ({ ...r.m, last_used_at: usedAt, uses: r.m.uses + 1, matched: r.overlap > 0 }));
}

module.exports = {
    KINDS, STATUSES, SOURCES, MAX_TEXT, MAX_PER_AGENT, MAX_PER_PERSON, MAX_RECALL, MEM_ID,
    norm, looksLikeSecret, instructionWidens, whyRefused, luhn,
    add, get, own, forAgent, forRun, list, edit, decide, remove, recall, MOVES,
};

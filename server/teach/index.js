'use strict';

/**
 * Teach a task (plan §AD.33). The owner, 2026-11-20: "click on one of your actors and train it to do a task … it
 * brings up the desktop view, you do the task, and it trains based off what you do, and it's able to do that task and
 * learn from it … self-improvement, recursive".
 *
 *   start(ctx, agent, { what, url, kind })   a teach session: one task of that agent whose only tools open a desk and
 *                                            watch the person (learn_from_person). The task page opens on its desk.
 *   session(s, taskId)                       the teach session of a task, or null
 *   afterRun({ s, models, row })             after any run of a person's agent: when the run used one of the person's
 *                                            own skills and the person had to take over or the run failed, the agent
 *                                            writes that skill's next version (improve.js)
 *
 * The loop is the recursion: a skill taught once is used, the person steps in where it goes wrong, and those steps
 * become the skill's next version, applied at once (with an undo) unless the person said to ask first.
 */
const { createTask } = require('../tasks/create');

const TEACH_TOOLS = ['list_my_computers', 'computer_desk', 'computer_browser', 'learn_from_person'];
// Told in words: no desk, one tool that writes the skill from the lesson's own words.
const WORDS_TOOLS = ['learn_from_words'];
const KINDS = ['browser', 'desktop'];
const HOWS = ['desk', 'words'];
const WHAT_MAX = 300;
const WORDS_MAX = 6000;
// How many practice tries after the skill is kept: 0 (off), 1, or until it works (up to practice.MAX_ROUNDS).
const PRACTICE = { off: 0, once: 1, until: 3 };

/** A start address: http(s) with no password in it, or null. → { url } or { error } */
function startUrl(value) {
    const v = String(value == null ? '' : value).trim();
    if (!v) return { url: null };
    let u = null;
    try { u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(v) ? v : `https://${v}`); } catch { u = null; }
    if (!u || !/^https?:$/.test(u.protocol) || u.username || u.password || u.href.length > 2048) return { error: 'The start page must be a web address (https://…).' };
    return { url: u.href };
}

/** What the agent is told in a lesson told in words: write the skill from them, nothing else. */
function wordsBrief({ what }) {
    return [
        'Teach session: your person told you in words how to do a task, so that you can do it yourself next time.',
        `The task: ${what}`,
        'Do exactly this: call learn_from_words once (it reads their words from this lesson and writes the skill).',
        'Then answer in two short sentences: what you learned, and that the new skill waits on your page for them to read and keep (and that you will practise it once they keep it, if they asked).',
    ].join('\n');
}

/** What the agent is told to do in a teach session: open the desk, open the page, watch, then say what it learned. */
function brief({ what, url, kind }) {
    const open = url && kind === 'browser'
        ? `2. computer_browser: action "open", machine "any", desk "private", url "${url}".`
        : '2. Open nothing: the person starts from the desk as it is.';
    return [
        'Teach session: your person will show you how to do a task on your own desk, once, so that you can do it yourself next time.',
        `The task they will show you: ${what}`,
        'Do exactly this, and nothing else on the desk (the person drives it):',
        `1. computer_desk: action "start", machine "any", kind "${kind}".`,
        open,
        `3. learn_from_person: machine "any", what "${what.replace(/"/g, '\'')}". It waits while they show you, then writes the skill from what they did.`,
        'Then answer in two short sentences: what you learned, and that the new skill waits on your page for them to read and keep.',
    ].join('\n');
}

async function session(s, taskId) {
    if (!taskId) return null;
    return s.db.maybe('SELECT * FROM actor_teach_sessions WHERE task_id = $1', [taskId]);
}

/** The latest teach sessions of an agent, for its page. */
async function sessionsOf(s, owner, agentId, limit = 5) {
    return s.db.many('SELECT * FROM actor_teach_sessions WHERE owner = $1 AND agent_id = $2 ORDER BY created_at DESC LIMIT $3', [owner, agentId, limit]);
}

/**
 * Start a teach session on one of the person's agents.
 * → { task, session } or { status, code, detail }
 */
async function start(ctx, agent, input = {}) {
    const { s, config, engine, webhooks } = ctx;
    const what = String(input.what == null ? '' : input.what).replace(/\s+/g, ' ').trim();
    if (!what || what.length > WHAT_MAX) return { status: 422, code: 'actor.teach.invalid', detail: `Say in a sentence what you will show it (at most ${WHAT_MAX} characters).` };
    const kind = KINDS.includes(input.kind) ? input.kind : 'browser';
    const at = startUrl(input.url);
    if (at.error) return { status: 422, code: 'actor.teach.invalid', detail: at.error };
    if (!String(agent.owner || '').startsWith('user:')) return { status: 403, code: 'actor.teach.no_person', detail: 'Only a person can teach their agent.' };
    // The modules of a lesson: how it is shown (on the desk, or told in words) and how much it practises afterwards.
    const words = String(input.words == null ? '' : input.words).trim();
    const how = HOWS.includes(input.how) ? input.how : (words ? 'words' : 'desk');
    if (how === 'words' && (words.length < 10 || words.length > WORDS_MAX)) return { status: 422, code: 'actor.teach.invalid', detail: `Write the steps in a few lines (at most ${WORDS_MAX} characters), the way you would tell a person.` };
    const practice = Object.prototype.hasOwnProperty.call(PRACTICE, input.practice) ? PRACTICE[input.practice] : PRACTICE.until;
    let made = null;
    const out = await createTask({
        s, config, engine, webhooks,
        principal: { requester: agent.owner, via: `agent:${agent.id}`, project: null },
        body: how === 'words'
            ? { task: wordsBrief({ what }), mode: 'balanced', level: 'full', tools: WORDS_TOOLS }
            : { task: brief({ what, url: at.url, kind }), mode: 'balanced', level: 'full', tools: TEACH_TOOLS },
        assignmentOrigin: 'person',
        afterInsert: async (task) => {
            made = await s.db.maybe(`INSERT INTO actor_teach_sessions (task_id, owner, agent_id, what, start_url, desk_kind, state, created_at, source, words, practice_rounds)
                VALUES ($1,$2,$3,$4,$5,$6,'started',$7,$8,$9,$10) RETURNING *`, [task.id, agent.owner, agent.id, what, at.url, kind, s.iso(), how, how === 'words' ? words : null, practice]);
        },
    });
    if (out.code) return out;
    return { task: out.task, session: made };
}

/** The teach session's end: what happened and the draft it left. */
async function finish(s, taskId, { state, steps = 0, proposalId = null }) {
    return s.db.maybe(`UPDATE actor_teach_sessions SET state = $2, steps = $3, proposal_id = COALESCE($4, proposal_id), ended_at = $5
        WHERE task_id = $1 RETURNING *`, [taskId, state, steps, proposalId, s.iso()]);
}

async function watching(s, taskId) {
    return s.db.maybe("UPDATE actor_teach_sessions SET state = 'watching' WHERE task_id = $1 AND state = 'started' RETURNING *", [taskId]);
}

/**
 * After a run ends: the improvement pass (improve.js), then practice (practice.js: a failed try was just improved, so
 * the next try starts), and what the person typed wiped from the record either way.
 */
async function afterRun({ s, models, row, log = console }) {
    try {
        await require('./improve').afterRun({ s, models, row, log });
    } catch (err) {
        log.warn && log.warn('[Actor] teach: improving a skill failed:', row && row.id, err && err.message);
    }
    try {
        await require('./practice').afterRun({ s, row, log });
    } catch (err) {
        log.warn && log.warn('[Actor] teach: practice did not go on:', row && row.id, err && err.message);
    } finally {
        if (row && row.id) await require('./recorder').forget(s, row.id).catch(() => {});
    }
}

/**
 * The person kept a skill drafted in a lesson: the agent practises it (when the lesson asked). Called by the route that
 * keeps a draft. → { task } | { error } | null (not a lesson's draft, or no practice)
 */
async function kept(ctx, agent, proposal, listing) {
    if (!proposal || proposal.source !== 'teach' || !proposal.from_task || !listing) return null;
    const lesson = await session(ctx.s, proposal.from_task);
    if (!lesson || !(Number(lesson.practice_rounds) > 0)) return null;
    const doc = require('../skills').document.parse(listing.skill_text || listing.skill) || {};
    return require('./practice').start(ctx, lesson, agent, { id: listing.id, slug: listing.slug || doc.slug, name: doc.name || lesson.what });
}

module.exports = { start, session, sessionsOf, finish, watching, afterRun, kept, brief, wordsBrief, startUrl, TEACH_TOOLS, WORDS_TOOLS, KINDS, HOWS, PRACTICE, WHAT_MAX, WORDS_MAX };

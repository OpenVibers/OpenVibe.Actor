'use strict';
/**
 * Practice (Teach, plan §AD.33; the owner, 11-21: "build modular intelligent teach feature"; 11-20: "self-improvement,
 * recursive"): once the person keeps a skill they taught, the agent tries it on its own desk with the example the
 * person used, and keeps trying until it does it without them.
 *
 *   start(ctx, session, agent, listing)   the first try: a run of the agent that loads the skill and follows it with the
 *                                         lesson's examples, never handing the desk to the person (it is practice)
 *   afterRun({ s, row })                  after a practice run: passed when it succeeded; otherwise improve.js has
 *                                         already written the skill's next version from what went wrong (the engine
 *                                         runs it first), and the next try starts while tries remain
 *
 * A lesson asks for 0 (off), 1 or up to 3 tries (actor_teach_sessions.practice_rounds). Every try is an ordinary run of
 * the agent: its level, its approvals and its spending limits hold; a try that needs an approval waits like any run.
 */
const MAX_ROUNDS = 3;
let bound = null;   // the server's context (engine, config, webhooks), bound when the agent pages are mounted

function bind(ctx) { bound = ctx; }

/** The words a practice run is given. */
function practiceInput(listing, examples = [], round = 1) {
    const details = (examples || []).filter((x) => x && x.name && x.example);
    const given = details.length
        ? `Use these details, the ones your person used when they showed you:\n${details.map((x) => `- {${x.name}}: ${String(x.example).slice(0, 200)}`).join('\n')}`
        : 'It needs no details.';
    return [
        `Practice your new skill "${listing.name}" (try ${round}): load it (load_skill ${listing.slug}) and do it yourself on your own desk (computer_desk, machine "any"), every step, the way it says.`,
        given,
        'This is practice: do not hand the desk to your person and do not ask them anything. If a step does not work, try the skill\'s other way once; if it still does not work, stop and say exactly which step failed, what the screen showed and why. When you finish, check the skill\'s "Done when" and say whether it is true.',
        'Never send, post, buy or delete anything for real unless the skill is exactly that and your person kept it to do it: then do it once, as shown.',
    ].join('\n\n');
}

/** The lesson a practice run belongs to, or null. */
async function sessionOfRun(s, taskId) {
    return s.db.maybe('SELECT * FROM actor_teach_sessions WHERE practice_task = $1', [taskId]);
}

/**
 * Start a try. → { task } or { error }
 *   ctx: { s, config, engine, webhooks } (the server's, or bind()'s); session: its row; agent: the agent row;
 *   listing: { id, slug, name } of the kept skill
 */
async function start(ctx, session, agent, listing) {
    const c = ctx || bound;
    if (!c || !c.s) return { error: 'practice is not set up on this server' };
    const s = c.s;
    const rounds = Math.min(MAX_ROUNDS, Number(session.practice_rounds) || 0);
    const done = Number(session.practice_done) || 0;
    if (!rounds || done >= rounds) return { error: 'no practice left' };
    const out = await require('../agents/personal').run(c, agent, practiceInput(listing, session.examples || [], done + 1));
    if (out.code || !out.task) {
        await s.db.query("UPDATE actor_teach_sessions SET practice_state = 'not_started' WHERE task_id = $1", [session.task_id]);
        return { error: out.detail || 'the practice run was refused' };
    }
    await s.db.query(`UPDATE actor_teach_sessions SET practice_task = $2, practice_done = $3, practice_state = 'running', listing_id = $4
        WHERE task_id = $1`, [session.task_id, out.task.id, done + 1, listing.id]);
    return { task: out.task };
}

/**
 * After any run ends: when it was a practice try, record how it went and start the next one while tries remain.
 * → 'passed' | 'retrying' | 'failed' | null (not a practice run)
 */
async function afterRun({ s, row, log = console }) {
    if (!row || !['succeeded', 'failed'].includes(row.state)) return null;
    const session = await sessionOfRun(s, row.id);
    if (!session) return null;
    if (row.state === 'succeeded') {
        await s.db.query("UPDATE actor_teach_sessions SET practice_state = 'passed' WHERE task_id = $1", [session.task_id]);
        return 'passed';
    }
    const rounds = Math.min(MAX_ROUNDS, Number(session.practice_rounds) || 0);
    if ((Number(session.practice_done) || 0) >= rounds || !bound) {
        await s.db.query("UPDATE actor_teach_sessions SET practice_state = 'failed' WHERE task_id = $1", [session.task_id]);
        return 'failed';
    }
    // The failed try has just been turned into the skill's next version (improve.js ran first); the next try uses it.
    const agent = await s.db.maybe('SELECT * FROM actor_agents WHERE id = $1 AND owner = $2', [session.agent_id, session.owner]);
    const listing = session.listing_id ? await require('../skills').store.byId(s, session.listing_id) : null;
    if (!agent || !listing) {
        await s.db.query("UPDATE actor_teach_sessions SET practice_state = 'failed' WHERE task_id = $1", [session.task_id]);
        return 'failed';
    }
    const doc = require('../skills').document.parse(listing.skill_text || listing.skill) || {};
    const next = await start(bound, session, agent, { id: listing.id, slug: listing.slug || doc.slug, name: doc.name || listing.name || session.what });
    if (next.error) { log.warn && log.warn('[Actor] teach: the next practice try did not start:', session.task_id, next.error); return 'failed'; }
    return 'retrying';
}

module.exports = { bind, start, afterRun, practiceInput, sessionOfRun, MAX_ROUNDS };

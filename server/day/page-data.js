'use strict';
const tasks = require('../tasks/store');
const fail = (text, status = 422) => { throw Object.assign(new Error(text), { status }); };
function createPageData(ctx, day) {
    const { s, computers } = ctx;
    async function session(owner) {
        const a = await day.ensure(owner);
        if (!a.active_task) return null;
        const q = await s.db.maybe('SELECT session_id FROM actor_day_asks WHERE task_id=$1 AND session_id IS NOT NULL ORDER BY created_at DESC LIMIT 1', [a.active_task]);
        if (q) return q.session_id;
        const t = await tasks.getTask(s, a.active_task);
        const c = t && await tasks.taskComputer(s, t);
        return c && c.session_id || null;
    }
    async function computerCall(owner, action, body) {
        const id = await session(owner);
        if (!id) fail('No computer is open right now.', 409);
        return computers.personSession(owner.slice(5), id, action, body);
    }
    async function computerLog(owner) {
        const a = await day.ensure(owner);
        if (a.computer.kind !== 'openvibe') return {sessions:[],actions:[]};
        const runs = await s.db.many('SELECT task_id FROM actor_day_runs WHERE owner=$1', [owner]);
        const ids = new Set(runs.map(r=>r.task_id));
        const sessions = (await computers.sessionList(owner.slice(5))).filter(r=>ids.has(r.task_id));
        const actions = [];
        for (const row of sessions.slice(0,10)) {
            const h = await computers.personSession(owner.slice(5),row.id,'history');
            for (const action of h.actions || []) if (action.kind === 'control') actions.push(action);
        }
        return {sessions,actions:actions.sort((a,b)=>String(b.at).localeCompare(String(a.at)))};
    }
    async function sites(owner, site) {
        const a = await day.ensure(owner);
        if (a.computer.kind !== 'openvibe') return { sites: [] };
        return computers.profileSites(owner.slice(5), a.id, site);
    }
    async function pageData(owner) {
        const a = await day.now(owner);
        const items = await s.db.many(`SELECT g.*, (SELECT count(*)::int FROM actor_day_runs r JOIN tasks t ON t.id=r.task_id WHERE r.goal_id=g.id AND t.state='succeeded') AS successes,
            (SELECT j.text FROM actor_day_journal j WHERE j.goal_id=g.id ORDER BY j.id DESC LIMIT 1) AS last_result
            FROM actor_day_goals g WHERE g.owner=$1 AND g.deleted_at IS NULL ORDER BY g.created_at`, [owner]);
        const messages = await s.db.many('SELECT m.*,t.result AS reply FROM actor_day_messages m LEFT JOIN tasks t ON t.id=m.task_id WHERE m.owner=$1 ORDER BY m.created_at DESC LIMIT 30', [owner]);
        const earnings = await s.db.many('SELECT * FROM actor_day_earnings WHERE owner=$1 ORDER BY created_at DESC LIMIT 100', [owner]);
        const weekly = await s.db.many(`SELECT g.lane,COALESCE(sum(u.usd),0) AS usd FROM actor_day_usage u JOIN actor_day_goals g ON g.id=u.goal_id WHERE u.owner=$1 AND u.day >= $2 GROUP BY g.lane`, [owner, new Date(s.now() - 6 * 86400000).toISOString().slice(0, 10)]);
        for (const w of weekly) {
            const count = await s.db.one("SELECT count(*)::int AS n FROM actor_day_runs r JOIN tasks t ON t.id=r.task_id JOIN actor_day_goals g ON g.id=r.goal_id WHERE r.owner=$1 AND r.day >= $2 AND g.lane=$3 AND t.state='succeeded'", [owner, new Date(s.now()-6*86400000).toISOString().slice(0,10), w.lane]);
            w.results = count.n;
        }
        const entries = ctx.models.aiCatalog ? await ctx.models.aiCatalog() || [] : [];
        return { avatar_url: a.avatar?.media_id ? await ctx.media.photoUrl(a.avatar.media_id) : null, actor: a, goals: items, messages, earnings, weekly, journal: await day.journalPage(owner, '', 100), session_id: await session(owner),
            models: entries.filter(m => a.adult_opt_in || !/uncensored|18\+/i.test(JSON.stringify(m))) };
    }
    async function doNow(owner, id) {
        const a = await day.ensure(owner);
        if (!a.enabled) fail('Resume your Actor first.', 409);
        const goal = id ? (await day.goals(owner)).find(g => g.id === id) : (await day.goals(owner)).find(g => g.enabled);
        if (!goal || !goal.enabled) fail('Choose an enabled goal.');
        await s.db.query('UPDATE actor_day_goals SET next_due_at=$2,do_now=true WHERE id=$1', [goal.id, s.iso()]);
        await s.db.query('UPDATE actors SET next_due_at=$2 WHERE id=$1', [a.id, s.iso()]);
        await day.tick(); return day.now(owner);
    }
    async function earn(owner, body) {
        const a = await day.ensure(owner);
        if (!body || body.confirmed !== true || typeof body.text !== 'string' || !body.text.trim() || body.text.length > 500 || !Number.isFinite(body.usd) || body.usd <= 0 || body.usd > 1000000) fail('Describe and confirm the amount you received.');
        return s.db.maybe('INSERT INTO actor_day_earnings(id,actor_id,owner,text,usd,created_at) VALUES($1,$2,$3,$4,$5,$6) RETURNING *', [s.newId('aer'), a.id, owner, body.text.trim(), body.usd, s.iso()]);
    }
    async function stepMessages(taskId, seen = []) {
        const r = await day.run(taskId);
        if (!r) return [];
        // Claimed messages remain readable after a crash until a saved step records their ids.
        return s.tx(async () => {
            const rows = await s.db.many(`SELECT id,text,attachments FROM actor_day_messages
                WHERE actor_id=$1 AND (task_id IS NULL OR (task_id=$2 AND in_prompt=false))
                AND NOT (id=ANY($3::text[])) ORDER BY created_at LIMIT 20 FOR UPDATE`, [r.actor_id,taskId,seen]);
            if (rows.length) await s.db.query('UPDATE actor_day_messages SET task_id=$2 WHERE id=ANY($1)', [rows.map(m=>m.id),taskId]);
            return rows;
        });
    }
    async function modelChoice(taskId) {
        const r = await day.run(taskId);
        if (!r) return null;
        const subject = r.owner.slice(5);
        if (r.brain === 'auto') return require('../runtime/model-prefs').choiceFor(s, r.owner);
        if (r.brain.startsWith('own:')) return { subject, provider: r.brain.slice(4), model: null };
        return { subject, model: r.brain === 'openvibe' ? null : r.brain };
    }
    const retainDesk = async taskId => Boolean(await s.db.maybe('SELECT id FROM actor_day_asks WHERE task_id=$1 AND session_id IS NOT NULL AND answered IS NULL', [taskId]));
    return { session, computerCall, computerLog, sites, pageData, doNow, earn, retainDesk, modelChoice, stepMessages };
}
module.exports = { createPageData };

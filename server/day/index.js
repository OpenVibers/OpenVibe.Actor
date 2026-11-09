'use strict';

const crypto = require('crypto');
const { LANES, LOCAL, DESK } = require('./lanes');
const tasks = require('../tasks/store');
const { createTask } = require('../tasks/create');
const waitStore = require('../waits/store');
const plain = (x, n = 2000) => String(x == null ? '' : x).replace(/\s+/g, ' ').trim().slice(0, n);
const fail = (text, status = 422) => { throw Object.assign(new Error(text), { status, code: 'actor.day.invalid' }); };
const date = (ms) => new Date(ms).toISOString();
const dayOf = (ms) => date(ms).slice(0, 10);
const object = (v) => v && typeof v === 'object' && !Array.isArray(v);
function budget(v, fallback, floor = false) {
    if (!object(v)) fail('Choose a daily money and minutes limit.');
    const out = { ...fallback, ...v };
    const keys = floor ? ['usd', 'minutes', 'balance_floor_usd'] : ['usd', 'minutes'];
    if (Object.keys(v).some((k) => !keys.includes(k))) fail('Unknown budget field.');
    for (const k of keys) if (!Number.isFinite(out[k]) || out[k] < 0 || out[k] > (k === 'minutes' ? 1440 : 1000)) fail('Use non-negative money and minutes limits.');
    return out;
}
function askView(r) {
    return { id: r.id, actor: r.actor_id, goal: r.goal_id, kind: r.session_id ? 'sign_in' : r.kind, text: r.text,
        options: r.options, evidence: r.evidence || null, screen_url: r.session_id ? '/you?screen=1' : null, created: r.created_at, answered: r.answered || null };
}
function fingerprint(name, input) {
    const stable = (v) => Array.isArray(v) ? v.map(stable) : object(v)
        ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, stable(v[k])])) : v;
    return crypto.createHash('sha256').update(JSON.stringify([name, stable(input)])).digest('hex');
}

function createDay(ctx) {
    const { s, config, engine, waits, notifier, models, checkpoints } = ctx;
    const get = (owner) => s.db.maybe('SELECT * FROM actors WHERE owner = $1', [owner]);
    const run = (id) => s.db.maybe(`SELECT r.*, a.enabled, a.computer, COALESCE(g.brain_override,a.brain) AS brain, a.caps, g.lane, g.asks_before
        FROM actor_day_runs r JOIN actors a ON a.id = r.actor_id JOIN actor_day_goals g ON g.id = r.goal_id WHERE r.task_id = $1`, [id]);
    async function ensure(owner) {
        if (!/^user:usr_[0-9A-HJKMNP-TV-Z]{26}$/.test(owner)) fail('Sign in to your own account.', 401);
        await s.db.query(`INSERT INTO actors (id,owner,next_due_at,created_at,updated_at)
            VALUES ($1,$2,$3,$3,$3) ON CONFLICT (owner) DO NOTHING`, [s.newId('act'), owner, s.iso()]);
        return get(owner);
    }
    async function update(owner, body) {
        const a = await ensure(owner);
        if (!object(body) || Object.keys(body).some((k) => !['name', 'avatar', 'brain', 'computer', 'caps', 'adult_opt_in'].includes(k))) fail('Choose a name, picture, brain, computer or daily limits.');
        const next = { ...a, ...body };
        if (typeof next.name !== 'string' || !next.name.trim() || next.name.length > 80) fail('Give your Actor a name of up to 80 characters.');
        if (next.avatar !== null && (!object(next.avatar) || Object.keys(next.avatar).join() !== 'media_id' || !/^med_[0-9A-HJKMNP-TV-Z]{26}$/.test(next.avatar.media_id))) fail('Choose a Media picture, or use your own picture.');
        if (typeof next.adult_opt_in !== 'boolean') fail('Choose whether to show adult models.');
        if (!['auto', 'openvibe', 'own:node', ...require('../runtime/model-prefs').KEY_PROVIDERS.map(p => 'own:' + p)].includes(next.brain)) {
            const entries = models.aiCatalog ? await models.aiCatalog() : null;
            if (!entries || !entries.some((m) => m.id === next.brain && m.availability !== 'unavailable' && (next.adult_opt_in || !/uncensored|18\+/i.test(JSON.stringify(m))))) fail('Choose an available model from the catalogue.');
        }
        const pc = next.computer;
        if (!object(pc) || !['none', 'link', 'openvibe'].includes(pc.kind) || Object.keys(pc).some((k) => !['kind', 'machine_id'].includes(k))) fail('Choose no computer, your Link computer, or an OpenVibe computer.');
        if (pc.kind === 'link' && !/^dev_[0-9A-HJKMNP-TV-Z]{26}$/.test(pc.machine_id)) fail('Choose your Link computer.');
        if (pc.kind !== 'link' && pc.machine_id != null) fail('Only a Link computer has a machine id.');
        next.caps = budget(next.caps, a.caps, true);
        // Limit edits apply between runs; pause first to stop a running slice immediately.
        return s.tx(async () => {
            const locked = await s.db.maybe('SELECT * FROM actors WHERE owner = $1 FOR UPDATE', [owner]);
            if (locked.active_task && Object.keys(body).some(k => ['computer', 'caps'].includes(k))) fail('Pause your Actor before changing its settings.', 409);
            const latest = { ...locked, ...body, caps: budget(body.caps || locked.caps, locked.caps, true) };
            return s.db.maybe(`UPDATE actors SET name=$2,avatar=$3::jsonb,brain=$4,computer=$5::jsonb,caps=$6::jsonb,updated_at=$7,adult_opt_in=$8 WHERE owner=$1 RETURNING *`,
                [owner, latest.name.trim(), JSON.stringify(latest.avatar), latest.brain, JSON.stringify(latest.computer), JSON.stringify(latest.caps), s.iso(), next.adult_opt_in]);
        });
    }
    const goals = (owner) => s.db.many('SELECT * FROM actor_day_goals WHERE owner=$1 AND deleted_at IS NULL ORDER BY next_due_at,id', [owner]);
    async function saveGoal(owner, body, id = null) {
        const a = await ensure(owner);
        const old = id ? await s.db.maybe('SELECT * FROM actor_day_goals WHERE id=$1 AND owner=$2 AND deleted_at IS NULL', [id, owner]) : null;
        if (id && !old) fail('Goal not found.', 404);
        if (!object(body) || Object.keys(body).some((k) => !['text', 'lane', 'budget', 'asks_before', 'enabled', 'every_minutes', 'next_due_at', 'schedule', 'brain_override'].includes(k))) fail('Unknown goal field.');
        const v = { enabled: true, every_minutes: 1440, next_due_at: s.iso(), ...(old || {}), ...body };
        if (!LANES[v.lane]) fail('Choose a goal lane.');
        if (typeof v.text !== 'string' || !v.text.trim() || v.text.length > 4000) fail('Describe your goal in up to 4000 characters.');
        v.budget = budget(body.budget || v.budget || LANES[v.lane].budget, old ? old.budget : LANES[v.lane].budget);
        v.asks_before = body.asks_before || (old && old.lane === v.lane ? old.asks_before : LANES[v.lane].asks_before);
        if (!Array.isArray(v.asks_before) || v.asks_before.length > 20 || v.asks_before.some((x) => typeof x !== 'string' || !x.trim() || x.length > 100)) fail('Use a short list of things to ask you before doing.');
        if (typeof v.enabled !== 'boolean' || !Number.isInteger(v.every_minutes) || v.every_minutes < 5 || v.every_minutes > 525600 || !Number.isFinite(Date.parse(v.next_due_at))) fail('Choose a valid schedule, at least five minutes apart.');
        if (!require('./schedule').valid(v.schedule)) fail('Choose valid days, hours and a time zone.');
        if (v.brain_override != null && typeof v.brain_override !== 'string') fail('Choose a model.');
        if (v.brain_override && !['auto', 'openvibe', ...require('../runtime/model-prefs').OWN_PROVIDERS.map(p => 'own:' + p)].includes(v.brain_override)) {
            const choices = models.aiCatalog ? await models.aiCatalog() || [] : [];
            if (!choices.some(m => m.id === v.brain_override && m.availability !== 'unavailable' && (a.adult_opt_in || !/uncensored|18\+/i.test(JSON.stringify(m))))) fail('Choose an available model.');
        }

        return s.tx(async () => {
            const current = await s.db.maybe('SELECT * FROM actors WHERE id=$1 FOR UPDATE', [a.id]);
            const active = current.active_task ? await run(current.active_task) : null;
            if (active && active.goal_id === id && Object.keys(body).some(k => k !== 'brain_override')) fail('Pause your Actor before changing its active goal.', 409);
            const saved = await s.db.maybe(`INSERT INTO actor_day_goals (id,actor_id,owner,text,lane,budget,asks_before,enabled,every_minutes,next_due_at,created_at,updated_at)
            VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10,$11,$11)
            ON CONFLICT (id) DO UPDATE SET text=EXCLUDED.text,lane=EXCLUDED.lane,budget=EXCLUDED.budget,asks_before=EXCLUDED.asks_before,
                enabled=EXCLUDED.enabled,every_minutes=EXCLUDED.every_minutes,next_due_at=EXCLUDED.next_due_at,updated_at=EXCLUDED.updated_at RETURNING *`,
        [id || s.newId('agl'), a.id, owner, v.text.trim(), v.lane, JSON.stringify(v.budget), JSON.stringify(v.asks_before), v.enabled, v.every_minutes, date(Date.parse(v.next_due_at)), old ? old.created_at : s.iso()]);
            return s.db.maybe('UPDATE actor_day_goals SET schedule=$2::jsonb,brain_override=$3 WHERE id=$1 RETURNING *', [saved.id, JSON.stringify(v.schedule || null), v.brain_override || null]);
        });
    }
    async function removeGoal(owner, id) {
        const g = await s.db.maybe('UPDATE actor_day_goals SET enabled=false,deleted_at=$3 WHERE id=$1 AND owner=$2 AND deleted_at IS NULL RETURNING *', [id, owner, s.iso()]);
        if (!g) fail('Goal not found.', 404);
        const a = await get(owner);
        if (a.active_task) {
            const r = await run(a.active_task);
            if (r && r.goal_id === id) await engine.cancel(a.active_task, owner);
        }
        return { deleted: true };
    }
    async function usage(actorId, goalId = null) {
        const actual = await s.db.maybe(`SELECT COALESCE(sum(usd),0) AS usd,COALESCE(sum(active_ms),0) AS ms
            FROM actor_day_usage WHERE actor_id=$1 AND day=$2 AND ($3::text IS NULL OR goal_id=$3)`, [actorId, dayOf(s.now()), goalId]);
        const rows = await s.db.many(`SELECT r.*,t.cost_usd FROM actor_day_runs r JOIN tasks t ON t.id=r.task_id
            WHERE r.actor_id=$1 AND r.finished_at IS NULL AND ($2::text IS NULL OR r.goal_id=$2)`, [actorId, goalId]);
        return rows.reduce((v, r) => ({ usd: v.usd + Math.max(0, Number(r.reserved_usd) - Number(r.cost_usd)),
            minutes: v.minutes + Math.max(0, Number(r.reserved_ms) - Number(r.active_ms)) / 60000,
            cost_usd: v.cost_usd }), { usd: Number(actual.usd), minutes: Number(actual.ms) / 60000, cost_usd: Number(actual.usd) });
    }
    async function addUsage(r, day, usd, ms) {
        await s.db.query(`INSERT INTO actor_day_usage (actor_id,goal_id,owner,day,usd,active_ms) VALUES ($1,$2,$3,$4,$5,$6)
            ON CONFLICT (goal_id,day) DO UPDATE SET usd=actor_day_usage.usd+EXCLUDED.usd,active_ms=actor_day_usage.active_ms+EXCLUDED.active_ms`,
        [r.actor_id, r.goal_id, r.owner, day, usd, ms]);
    }
    async function recordSpend(taskId, usd) {
        const r = await run(taskId);
        if (r) await addUsage(r, dayOf(s.now()), usd, 0);
    }
    async function journal(r, text, extra = {}) {
        await s.tx(async () => {
            // Serialise journal charges for parallel tool results. Each row owns only the cost since the last row.
            const locked = await s.db.maybe('SELECT task_id FROM actor_day_runs WHERE task_id=$1 FOR UPDATE', [r.task_id]);
            if (!locked) return;
            const totals = await s.db.maybe(`SELECT t.cost_usd,
                (SELECT COALESCE(sum(j.cost_usd),0) FROM actor_day_journal j WHERE j.task_id=t.id) AS recorded
                FROM tasks t WHERE t.id=$1`, [r.task_id]);
            const cost = Math.max(0, Number(extra.cost_usd == null ? totals.cost_usd : extra.cost_usd) - Number(totals.recorded));
            await s.db.query(`INSERT INTO actor_day_journal (id,actor_id,goal_id,owner,task_id,text,looking_at,thumbnail,cost_usd,created_at)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10)`, [s.newId('ajr'), r.actor_id, r.goal_id, r.owner, r.task_id,
                plain(text), extra.looking_at || null, JSON.stringify(extra.thumbnail || null), cost, s.iso()]);
        });
    }
    const journalPage = (owner, before = '', limit = 30) => s.db.many(`SELECT * FROM actor_day_journal WHERE owner=$1 AND ($2='' OR id<$2) ORDER BY id DESC LIMIT $3`,
        [owner, before, Math.min(100, Math.max(1, Number(limit) || 30))]);
    async function now(owner) {
        const a = await ensure(owner);
        const recent = await journalPage(owner, '', 3);
        const pending = await asks(owner);
        const looking = a.active_task ? await s.db.maybe('SELECT looking_at FROM actor_day_journal WHERE task_id=$1 AND looking_at IS NOT NULL ORDER BY id DESC LIMIT 1', [a.active_task]) : null;
        const next = (await goals(owner)).find((g) => g.enabled);
        return { ...a, avatar: a.avatar || { person: owner.slice(5) }, now: {
            current_step: pending.length ? pending[0].text : a.status === 'working' && recent[0] ? recent[0].text : a.enabled ? 'Resting until the next goal is due.' : 'Paused',
            looking_at: looking ? looking.looking_at : null, last_three_steps: recent,
            next: next ? { goal: next.id, text: next.text, at: next.next_due_at } : null,
            cost_today: (await usage(a.id)).cost_usd }, asks: pending };
    }
    async function setEnabled(owner, enabled) {
        await ensure(owner);
        if (enabled && (!checkpoints || !checkpoints.enabled)) fail('Your Actor cannot save its place yet. Ask the site owner to enable saved runs.', 503);
        const a = await s.db.maybe(`UPDATE actors SET enabled=$2,status=$3,next_due_at=$4,updated_at=$4 WHERE owner=$1 RETURNING *`, [owner, enabled, enabled ? 'resting' : 'paused', s.iso()]);
        if (!enabled && a.active_task) await engine.cancel(a.active_task, owner);
        return now(owner);
    }
    async function tell(owner, text, attachments = []) {
        const a = await ensure(owner);
        if (typeof text !== 'string' || !text.trim() || text.length > 4000) fail('Write a message of up to 4000 characters.');
        if (!Array.isArray(attachments) || attachments.length > 5 || attachments.some(f => !f || typeof f.name !== 'string' || f.name.length > 120 || typeof f.text !== 'string' || f.text.length > 8000)) fail('Attach up to five small text files.');
        const message = await s.db.maybe(`INSERT INTO actor_day_messages (id,actor_id,owner,text,created_at,attachments) VALUES ($1,$2,$3,$4,$5,$6::jsonb) RETURNING *`,
            [s.newId('ams'), a.id, owner, text.trim(), s.iso(), JSON.stringify(attachments)]);
        // Kept until a run claims it, including while the Actor is off or waiting on an answer.
        return message;
    }
    async function pick(a) {
        const used = await usage(a.id);
        const balance = await tasks.spendToday(s, a.owner);
        const available = Math.max(0, config.allowance.perDayUsd - balance.usd - balance.reserved - a.caps.balance_floor_usd);
        const usd = Math.min(a.caps.usd - used.usd, available, config.allowance.perTaskUsd);
        const minutes = a.caps.minutes - used.minutes;
        if (usd <= 0.000001 || minutes < 1 / 6) return null;
        for (const g of await goals(a.owner)) {
            if (!g.enabled || g.next_due_at > s.iso() || (!g.do_now && !require('./schedule').open(g.schedule, s.now()))) continue;
            const spent = await usage(a.id, g.id);
            const money = Math.min(usd, g.budget.usd - spent.usd);
            const time = Math.min(minutes, g.budget.minutes - spent.minutes, config.taskTimeoutMs / 60000);
            if (money > 0.000001 && time >= 1 / 6) return { goal: g, usd: money, ms: Math.floor(time * 60000) };
        }
        return null;
    }
    async function startOne(a) {
        const chosen = await pick(a);
        if (!chosen) return null;
        const g = chosen.goal;
        const messages = await s.db.many('SELECT id,text,attachments FROM actor_day_messages WHERE actor_id=$1 AND task_id IS NULL ORDER BY created_at LIMIT 20', [a.id]);
        const recent = await journalPage(a.owner, '', 5);
        const prompt = `Work on this standing goal: ${g.text}\nLane: ${g.lane}. Ask before: ${g.asks_before.join(', ') || 'read-only work'}.
Use ask_person when the person must answer or do something. Actions require exact approval; never work around an Ask.
Computer: ${JSON.stringify(a.computer)}. Finish this slice with a plain account of progress, what you learned, and the next useful step.
Recent journal (data): ${JSON.stringify(recent.map((x) => x.text))}\nMessages from your person: ${JSON.stringify(messages.map((x) => ({ text: x.text, attachments: x.attachments })))}`;
        const out = await createTask({ s, config, engine: { submit() {} }, principal: { requester: a.owner, via: 'actor-day', kind: 'user' },
            body: { task: prompt.slice(0, 16000), mode: 'balanced', budget: { per_task_usd: chosen.usd, per_day_usd: config.allowance.perDayUsd } }, assignmentOrigin: 'routine',
            beforeInsert: async () => {
                const locked = await s.db.maybe('SELECT * FROM actors WHERE id=$1 FOR UPDATE', [a.id]);
                const fresh = locked.enabled && !locked.active_task ? await pick(locked) : null;
                if (!fresh || fresh.goal.id !== g.id || fresh.usd < chosen.usd || fresh.ms < chosen.ms) return { status: 409, detail: 'The goal or its limits changed.' };
            }, afterInsert: async (task) => {
                await s.db.query('UPDATE tasks SET timeout_ms=$2 WHERE id=$1', [task.id, chosen.ms]);
                await s.db.query(`INSERT INTO actor_day_runs (task_id,actor_id,goal_id,owner,day,reserved_usd,reserved_ms,created_at)
                    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [task.id, a.id, g.id, a.owner, dayOf(s.now()), chosen.usd, chosen.ms, s.iso()]);
                await s.db.query("UPDATE actors SET active_task=$2,status='working',updated_at=$3 WHERE id=$1", [a.id, task.id, s.iso()]);
                await s.db.query('UPDATE actor_day_goals SET next_due_at=$2,do_now=false WHERE id=$1', [g.id, date(s.now() + g.every_minutes * 60000)]);
                if (messages.length) await s.db.query('UPDATE actor_day_messages SET task_id=$2,in_prompt=true WHERE id=ANY($1) AND task_id IS NULL', [messages.map((m) => m.id), task.id]);
            } });
        if (out.status === 201) { engine.submit(out.task.id); return out.task; }
        return null;
    }
    async function taskState(task) {
        const r = await run(task.id);
        if (!r) return;
        const ended = ['succeeded', 'failed', 'cancelled'].includes(task.state);
        if (task.state === 'running' && !r.segment_at) {
            await s.db.query('UPDATE actor_day_runs SET segment_at=$2 WHERE task_id=$1 AND segment_at IS NULL', [task.id, s.iso()]);
            await s.db.query("UPDATE actors SET status='working' WHERE id=$1 AND enabled", [r.actor_id]);
        }
        if (!ended) return;
        const held = await s.db.many('SELECT DISTINCT session_id FROM actor_day_asks WHERE task_id=$1 AND session_id IS NOT NULL', [task.id]);
        for (const h of held) await ctx.computers.endSession(r.owner.slice(5), 'run:' + h.session_id).catch(() => {});
        await segmentEnd(task.id);
        await s.db.query('UPDATE actor_day_runs SET finished_at=$2 WHERE task_id=$1 AND finished_at IS NULL', [task.id, s.iso()]);
        await s.db.query(`UPDATE actors SET active_task=NULL,status=CASE WHEN enabled THEN 'resting' ELSE 'paused' END,next_due_at=$2 WHERE id=$1 AND active_task=$3`, [r.actor_id, date(s.now() + 60000), task.id]);
        await s.db.query("UPDATE actor_waits SET status='cancelled',finished_at=$2 WHERE task_id=$1 AND status='waiting'", [task.id, s.iso()]);
        await journal(r, task.state === 'succeeded' ? plain(task.result && (task.result.answer || task.result.text)) || 'Finished this part of the goal.'
            : task.state === 'cancelled' ? 'Stopped when you paused this work.' : 'This part could not finish. I will try again when the goal is due.', { cost_usd: Number(task.cost_usd || 0) });
    }
    async function segmentEnd(taskId) {
        await s.tx(async () => {
            const r = await s.db.maybe('SELECT * FROM actor_day_runs WHERE task_id=$1 FOR UPDATE', [taskId]);
            if (!r || !r.segment_at) return;
            const begin = Date.parse(r.segment_at);
            const elapsed = Math.max(0, Math.min(s.now() - begin, Number(r.reserved_ms) - Number(r.active_ms)));
            // Split at UTC midnight: waiting time is absent because parking clears segment_at.
            let at = begin;
            while (at < begin + elapsed) {
                const end = Math.min(begin + elapsed, Date.parse(dayOf(at)) + 86400000);
                await addUsage(r, dayOf(at), 0, end - at);
                at = end;
            }
            await s.db.query('UPDATE actor_day_runs SET active_ms=active_ms+$2,segment_at=NULL WHERE task_id=$1', [taskId, elapsed]);
            await s.db.query("UPDATE actors SET status=CASE WHEN enabled THEN 'resting' ELSE 'paused' END WHERE active_task=$1", [taskId]);
        });
    }
    async function event(taskId, e) {
        if (e.kind !== 'output' || !['text', 'tool_result', 'tool_call'].includes(e.step)) return;
        const r = await run(taskId);
        if (!r) return;
        // Tool payloads may include secrets or raw HTML. Only the model's progress line and image reference belong here.
        if (e.step === 'tool_call' && ['read_page', 'search_web', 'search_openvibe', 'computer_browser', 'computer_read'].includes(e.tool)) {
            const text = e.tool === 'read_page' ? 'Reading a page.' : e.tool.startsWith('search') ? 'Looking for useful information.' : e.tool === 'computer_read' ? 'Reading a file.' : 'Looking at the browser.';
            await journal(r, text, { looking_at: plain(e.input, 300) });
        }
        if (e.step === 'text' && plain(e.text)) await journal(r, e.text);
        if (e.step === 'tool_result' && e.tool === 'computer_screen') {
            const image = (e.artifacts || []).find((x) => x.media_id);
            if (image) await journal(r, 'Looked at the screen.', { thumbnail: { media_id: image.media_id } });
        }
    }
    async function screen(taskId, artifact, question) {
        const r = await run(taskId);
        if (r) await journal(r, 'Looked at the screen.', { thumbnail: artifact, looking_at: plain(question, 300) });
    }
    const asks = async (owner, all = false) => (await s.db.many(`SELECT q.* FROM actor_day_asks q JOIN tasks t ON t.id=q.task_id
        WHERE q.owner=$1 AND ($2 OR (q.answered IS NULL AND t.state IN ('queued','running','verifying','needs_you')))
        ORDER BY q.created_at DESC LIMIT 100`, [owner, all])).map(askView);
    async function ask(taskId, input, actionHash = null) {
        const r = await run(taskId);
        if (!r || !r.enabled || !checkpoints || !checkpoints.enabled) fail('This Actor is paused.', 409);
        const text = plain(input.text);
        const kind = input.kind || 'answer_question';
        if (!text || !['approve_action', 'answer_question', 'do_yourself', 'sign_in'].includes(kind)) fail('Say what you need your person to do.');
        if (kind === 'sign_in' && !/^ses_[0-9A-HJKMNP-TV-Z]{26}$/.test(input.session_id || '')) fail('Open the Actor’s screen first.');
        const options = Array.isArray(input.options) ? [...new Set(input.options.map((x) => plain(x, 200)).filter(Boolean))].slice(0, 12) : [];
        const q = await s.tx(async () => {
            const a = await s.db.maybe('SELECT enabled FROM actors WHERE id=$1 FOR UPDATE', [r.actor_id]);
            if (!a.enabled) fail('This Actor is paused.', 409);
            const existing = await s.db.maybe('SELECT * FROM actor_day_asks WHERE task_id=$1 AND answered IS NULL ORDER BY created_at LIMIT 1', [taskId]);
            if (existing) return existing;
            const w = await waits.create({ taskId, requester: r.owner, source: 'time', seconds: 6 * 3600, onTimeout: 'fail', line: plain(text, 200) });
            return s.db.maybe(`INSERT INTO actor_day_asks (id,actor_id,goal_id,owner,task_id,wait_id,kind,text,options,action_hash,created_at,session_id,evidence)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13::jsonb) RETURNING *`,
            [s.newId('ask'), r.actor_id, r.goal_id, r.owner, taskId, w.id, kind === 'sign_in' ? 'do_yourself' : kind, text, JSON.stringify(options), actionHash, s.iso(), kind === 'sign_in' ? input.session_id : null, JSON.stringify(input.evidence || null)]);
        });
        await notify(q).catch((err) => ctx.log.warn('[Actor] ask notification:', err.message));
        return { text: JSON.stringify({ waiting: true, ask: askView(q) }), data: askView(q), park: { wait_id: q.wait_id } };
    }
    async function notify(q) {
        const claimed = await s.db.maybe('UPDATE actor_day_asks SET notified_at=$2 WHERE id=$1 AND notified_at IS NULL RETURNING id', [q.id, s.iso()]);
        if (claimed) await journal(await run(q.task_id), q.text);
        if (claimed && notifier) await notifier.needsYou({ subject: q.owner.slice(5), what: q.text, title: 'Your Actor needs you', url: `${config.baseUrl}/you?ask=${q.id}` });
    }
    async function answer(owner, id, body, decline = false) {
        const q = await s.db.maybe('SELECT q.*,w.status AS wait_status,w.deadline_at FROM actor_day_asks q JOIN actor_waits w ON w.id=q.wait_id WHERE q.id=$1 AND q.owner=$2', [id, owner]);
        if (!q) fail('Ask not found.', 404);
        if (q.answered) return askView(q);
        if (q.wait_status !== 'waiting' || q.deadline_at <= s.iso()) fail('This ask has ended.', 409);
        const text = plain(body && body.text, 4000);
        if (!decline && q.kind === 'answer_question' && !text) fail('Write your answer.');
        const answered = { at: s.iso(), decision: decline ? 'decline' : 'answer', ...(text ? { text } : {}) };
        if (q.session_id && !decline) { await ctx.computers.personSession(owner.slice(5), q.session_id, 'save'); await ctx.computers.personSession(owner.slice(5), q.session_id, 'back'); }
        const row = await s.db.maybe('UPDATE actor_day_asks SET answered=$3::jsonb WHERE id=$1 AND owner=$2 AND answered IS NULL RETURNING *', [id, owner, JSON.stringify(answered)]);
        await resumeAnswers();
        return askView(row || await s.db.maybe('SELECT * FROM actor_day_asks WHERE id=$1', [id]));
    }
    async function resumeAnswers() {
        const pending = await s.db.many(`SELECT q.* FROM actor_day_asks q JOIN actor_waits w ON w.id=q.wait_id JOIN actors a ON a.id=q.actor_id
            WHERE q.answered IS NOT NULL AND w.status='waiting' AND w.remaining_ms IS NOT NULL AND a.enabled AND w.deadline_at > $1 LIMIT 50`, [s.iso()]);
        for (const q of pending) {
            const queued = await s.tx(async () => {
                const a = await s.db.maybe('SELECT * FROM actors WHERE id=$1 FOR UPDATE', [q.actor_id]);
                if (!a.enabled || a.active_task !== q.task_id) return false;
                const w = await waitStore.markWoken(s, q.wait_id, { by: 'person', at: s.iso() });
                if (!w) return false;
                return s.db.maybe("UPDATE tasks SET state='queued',resumes=resumes+1,finished_at=NULL,timeout_ms=LEAST(timeout_ms,$2) WHERE id=$1 AND state IN ('running','needs_you') RETURNING id", [q.task_id, Math.max(1, Number(w.remaining_ms))]);
            });
            if (queued) engine.submit(q.task_id);
        }
    }
    async function wakePayload(taskId) {
        const rows = await s.db.many('SELECT id,kind,text,answered FROM actor_day_asks WHERE task_id=$1 AND answered IS NOT NULL ORDER BY created_at', [taskId]);
        return rows.length ? { notice: 'Your person answered. Continue this goal within its limits. Approved actions must match exactly; a decline is final.',
            event: { event_type: 'actor.ask.answered', payload: { answers: rows } } } : null;
    }
    async function guardTool(taskId, name, input, tool) {
        const r = await run(taskId);
        if (!r) return null;
        if (!r.enabled || r.finished_at) return { text: 'Your Actor is paused.', isError: true };
        if (!LANES[r.lane].tools.includes(name)) return { text: 'This tool is outside this goal’s lane.', isError: true };
        if (DESK.includes(name)) {
            if (r.computer.kind === 'none') return { text: 'No computer is selected for this Actor.', isError: true };
            if (r.computer.kind === 'link' && input.machine !== r.computer.machine_id) return { text: 'Use only the Link computer your person selected.', isError: true };
            if (r.computer.kind === 'openvibe' && input.machine && input.machine !== 'any' && !String(input.machine).startsWith('run:ses_')) return { text: 'Use the OpenVibe computer selected for this Actor.', isError: true };
        }
        if (name === 'hand_to_person') return { approved: true };
        if (tool.acts !== true || LOCAL.has(name)) return null;
        const hash = fingerprint(name, input);
        const prior = await s.db.maybe('SELECT * FROM actor_day_asks WHERE task_id=$1 AND action_hash=$2 ORDER BY created_at DESC LIMIT 1', [taskId, hash]);
        if (prior && prior.answered) {
            if (prior.answered.decision === 'decline') return { text: 'Your person declined this action. Continue without it.', isError: true };
            const won = await s.db.maybe('UPDATE actor_day_asks SET used_at=$2 WHERE id=$1 AND used_at IS NULL RETURNING id', [prior.id, s.iso()]);
            return won ? { approved: true } : { text: 'This approval has already been used. Check the result; do not repeat the action.', isError: true };
        }
        const step = require('../agents/actions').stepFor(name, input);
        return ask(taskId, { kind: 'approve_action', text: step ? step.summary : `Allow this step: ${tool.description.split('.')[0]}?`, options: ['Approve', 'Decline'], evidence: { text: plain(JSON.stringify(input), 2000) } }, hash);
    }
    async function tick() {
        if (config.drill || !checkpoints || !checkpoints.enabled) return [];
        await resumeAnswers();
        // Repair a crash after task completion but before its day card was updated.
        const ended = await s.db.many(`SELECT t.* FROM actors a JOIN tasks t ON t.id=a.active_task WHERE t.state IN ('succeeded','failed','cancelled')`);
        for (const t of ended) await taskState(t);
        const due = await s.db.many('SELECT * FROM actors WHERE enabled AND active_task IS NULL AND next_due_at <= $1 ORDER BY next_due_at LIMIT 50', [s.iso()]);
        const started = [];
        for (const a of due) {
            const task = await startOne(a);
            if (task) started.push(task.id);
            else await s.db.query('UPDATE actors SET next_due_at=$2 WHERE id=$1 AND active_task IS NULL', [a.id, date(s.now() + 60000)]);
        }
        return started;
    }
    function startJobs() {
        if (config.drill || config.nodeEnv === 'test') return [];
        return [require('../utils/jobs').every('actor-day', 15000, tick, { initialDelayMs: 1000, log: ctx.log })];
    }
    const page = require('./page-data').createPageData(ctx, { ensure, get, run, goals, now, tick, journalPage });
    return { ...page, ensure, get, update, goals, saveGoal, removeGoal, usage, now, setEnabled, tell, journalPage, asks, ask, answer,
        run, taskState, recordSpend, segmentEnd, event, screen, guardTool, wakePayload, resumeAnswers, tick, startJobs, lanes: LANES };
}
module.exports = { createDay, askView, fingerprint, budget };

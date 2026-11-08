'use strict';

/**
 * The approval inbox (plan T17: "an approval inbox for consequential actions"; plan HO1: universal approvals).
 * A person's own agent runs while they are away (a schedule, a watch): when its work would act outside Actor on
 * their behalf — a coding task on their own machine through OpenVibe.Codes, or any of its acting tools (a send, a
 * purchase, a deletion, a password field, a computer_run, a browser action, a Space publish) — the run asks instead
 * of acting. The request waits on /me/approvals; approving a codes.task starts that work as the person's own task
 * (they are present now), declining or letting it expire (7 days) runs nothing. An actor.action approval records the
 * person's yes for a retry: the run that asked had already stopped, so nothing is replayed on its own. A person's
 * direct task never asks: they are the one asking.
 *
 * Every request says what KIND of act it is (agents/kinds.js), in plain words, and which exact TARGET it would touch.
 * The person may approve it once, or approve it and say "always allow this for this agent" (agents/allows.js): a
 * standing permission for that kind and that target, revocable from the agent's page. The always-ask floor (money, a
 * password, a deletion, a new recipient) is never covered by such a permission: it asks every time.
 *
 *   request(s, { owner, agentId, taskId, kind, summary, payload, target, categories }) → the row (pending)
 *   list(s, owner) / get(s, owner, id)                             → rows, pending past their expiry marked expired
 *   decide(ctx, owner, id, 'approve' | 'approve_always' | 'decline') → { row, task? } | { error, status }
 *   KINDS, EXPIRES_DAYS
 */
const { createTask } = require('../tasks/create');
const levels = require('./levels');
const kinds = require('./kinds');
const allows = require('./allows');
const spend = require('./spend');

const KINDS = kinds.KINDS;
const EXPIRES_DAYS = 7;
const ID = /^apr_[0-9A-HJKMNP-TV-Z]{26}$/;

/** The categories of a step, as a list of the floor's words (money, password, delete, new_recipient). */
const categoryList = (value) => (Array.isArray(value) ? value.filter((c) => levels.ALWAYS_ASK.includes(c)) : []);

async function request(s, { owner, agentId = null, taskId = null, kind, summary, payload, target = null, categories = null }) {
    if (!KINDS.includes(kind)) throw new Error(`unknown approval kind ${kind}`);
    const id = s.newId('apr');
    const now = s.iso();
    const expires = new Date(Date.parse(now) + EXPIRES_DAYS * 86400_000).toISOString();
    return await s.db.one(`INSERT INTO actor_approvals (id, owner, agent_id, task_id, kind, summary, payload, target, categories, state, created_at, expires_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9::jsonb, 'pending', $10, $11) RETURNING *`,
    [id, owner, agentId, taskId, kind, String(summary).slice(0, 500), JSON.stringify(payload), allows.exact(target),
        JSON.stringify(categoryList(categories)), now, expires]);
}

/** Pending requests past their expiry become expired as they are read. */
async function expire(s, owner) {
    await s.db.query("UPDATE actor_approvals SET state = 'expired', decided_at = $2 WHERE owner = $1 AND state = 'pending' AND expires_at < $2", [owner, s.iso()]);
}

async function list(s, owner) {
    await expire(s, owner);
    return await s.db.many("SELECT * FROM actor_approvals WHERE owner = $1 ORDER BY (state = 'pending') DESC, created_at DESC LIMIT 100", [owner]);
}

async function get(s, owner, id) {
    if (!ID.test(String(id))) return null;
    await expire(s, owner);
    return await s.db.maybe('SELECT * FROM actor_approvals WHERE id = $1 AND owner = $2', [id, owner]);
}

async function pendingCount(s, owner) {
    await expire(s, owner);
    return Number(await s.db.value("SELECT count(*) FROM actor_approvals WHERE owner = $1 AND state = 'pending'", [owner]));
}

/** The floor categories of a row: what it stored, or what its own words say (an old row has no column). */
function floorOf(row) {
    let stored = [];
    try {
        stored = categoryList(typeof row.categories === 'string' ? JSON.parse(row.categories || '[]') : row.categories);
    } catch { stored = []; }
    let payload = null;
    try { payload = typeof row.payload === 'string' ? JSON.parse(row.payload || '{}') : row.payload; } catch { payload = null; }
    // What the request stored, what its words say, and a command that deletes by its argv (rm, shred …).
    const argvDeletes = payload && Array.isArray(payload.argv) && require('./actions').deletes(payload.argv);
    const floor = new Set([...stored, ...levels.classify({ summary: row.summary, payload }), ...(argvDeletes ? ['delete'] : [])]);
    if (row.kind === 'money') floor.add('money');
    return [...floor];
}

/**
 * The person decides. Approving a codes.task starts it as their own task, routed to the codes agent.
 * `approve_always` is approving plus a standing permission for this exact kind and target of this agent; it is
 * refused for a floor step (money, a password, a deletion, a new recipient), which asks every time.
 * With `idempotent`, a request already decided answers its current state instead of a conflict (the JSON
 * Action Center route); the HTML page keeps its 409.
 *
 * A payment (plan HO7, the kind 'money') is decided differently: the money moves now, with the person's own token,
 * and only from the person's own session. A service that decides for them (the Action Center) never pays: there is
 * no person behind the service token, and the approval stays pending until the person approves it themselves.
 */
async function decide(ctx, owner, id, decision, { idempotent = false, personToken = null } = {}) {
    const { s, config, engine, webhooks } = ctx;
    const row = await get(s, owner, id);
    if (!row) return { error: 'No such request of yours.', status: 404 };
    if (row.state !== 'pending') {
        if (idempotent) return { row };
        return { error: `This request is already ${row.state}.`, status: 409 };
    }
    if (decision === 'decline') {
        const done = await s.db.maybe("UPDATE actor_approvals SET state = 'declined', decided_at = $2, decided_by = $3 WHERE id = $1 AND state = 'pending' RETURNING *", [id, s.iso(), owner]);
        if (!done) return { error: 'This request was already answered.', status: 409 };
        if (done.device_wait_id && ctx.waits) await ctx.waits.wakeDevice(done, { declined: true });
        return { row: done };
    }
    if (row.kind === 'device.camera' || row.kind === 'device.location') {
        return { error: 'Answer this request with one photo or one location, or decline it.', status: 422 };
    }
    if (decision !== 'approve' && decision !== 'approve_always') return { error: 'Approve or decline.', status: 422 };
    // A tip (plan HO7): the person's own approval pays, now. Any other money step (a payment tool reached through
    // OpenVibe.Tools) keeps the old behaviour: it asks, and approving it means the person runs it again.
    const money = typeof row.payload === 'string' ? JSON.parse(row.payload || '{}') : (row.payload || {});
    if (row.kind === 'money' && money.spend === 'tip') {
        if (decision === 'approve_always') return { error: 'This step always asks, so it can never be always allowed.', status: 422 };
        return await pay(ctx, row, { personToken });
    }
    const always = decision === 'approve_always';
    if (always) {
        const floored = floorOf(row);
        if (floored.length) {
            return { error: `This step always asks (${floored.join(', ')}), so it can never be always allowed.`, status: 422 };
        }
        if (!row.agent_id) return { error: 'This request has no agent to allow it for.', status: 422 };
        if (!kinds.allowable(row.kind)) return { error: 'This kind of step always asks, so it can never be always allowed.', status: 422 };
        if (!row.target) return { error: 'This step has no target to allow.', status: 422 };
    }
    if (row.kind === 'device.notify') {
        const payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
        const title = String(payload && payload.title || '').trim().slice(0, 120);
        const body = String(payload && payload.text || '').trim().slice(0, 400);
        if (!row.agent_id || !row.task_id || !title || !body) return { error: 'The notification is incomplete.', status: 422 };
        const allow = always ? await allows.grant(s, owner, row.agent_id, row.kind, row.target) : { row: null };
        if (always && !allow.row) return { error: allow.error || 'This step could not be allowed.', status: 422 };
        const done = await s.db.maybe("UPDATE actor_approvals SET state = 'approved', decided_at = $2, decided_by = $3, decision_scope = $4, allow_id = $5 WHERE id = $1 AND state = 'pending' RETURNING *",
            [id, s.iso(), owner, always ? 'always' : 'once', allow.row ? allow.row.id : null]);
        if (!done) return { error: 'This request was already answered.', status: 409 };
        await s.db.query(`INSERT INTO actor_device_notices (id, owner, agent_id, task_id, title, body, created_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (id) DO NOTHING`,
        [`ntf_${id.slice(4)}`, owner, row.agent_id, row.task_id, title, body, s.iso()]);
        return { row: done, note: 'The notification was added to your Action Center.', allow: allow.row ? allow.row.id : null };
    }
    // A coding task starts as the person's own task. Every other kind had already stopped when it asked: a yes is
    // consent for the person to run it again, never a replay of a call whose arguments only exist in the old run.
    if (row.kind !== 'codes.task') {
        // A mail reply (track HO6) while Mail cannot send outside OpenVibe: the person's yes changes nothing, so the
        // request stays pending and says so plainly instead of pretending the reply left. The draft is still in it.
        if (ctx.agentMail && await ctx.agentMail.replyWaits(row).catch(() => false)) {
            return { row, note: 'OpenVibe Mail cannot send outside OpenVibe yet: the reply waits here.', waiting: true };
        }
        const allow = always ? await allows.grant(s, owner, row.agent_id, row.kind, row.target) : { row: null };
        if (always && !allow.row) return { error: allow.error || 'This step could not be allowed.', status: 422 };
        const done = await s.db.one("UPDATE actor_approvals SET state = 'approved', decided_at = $2, decided_by = $3, decision_scope = $4, allow_id = $5 WHERE id = $1 AND state = 'pending' RETURNING *",
        [id, s.iso(), owner, always ? 'always' : 'once', allow.row ? allow.row.id : null]);
        // A mail reply is the one non-coding send whose arguments are all still here: the draft is in the request, so
        // a yes sends it now instead of asking the person to run something again.
        const reply = ctx.agentMail ? await ctx.agentMail.sendApproved(owner, done).catch((err) => ({ sent: false, reason: String((err && err.message) || err) })) : null;
        if (reply && reply.waiting) {
            return { row: done, note: 'OpenVibe Mail cannot send outside OpenVibe yet: the reply waits here.', waiting: true, allow: allow.row ? allow.row.id : null };
        }
        if (reply && reply.sent) return { row: done, note: 'Approved and sent.', allow: allow.row ? allow.row.id : null, mail: true };
        return { row: done, note: 'Approved. The run that asked had already stopped; run it again to let the agent go on.', allow: allow.row ? allow.row.id : null };
    }
    const payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
    // The person just approved this exact work, so the thread starts at full access: the engine's approval gate must not
    // ask again. The always-ask floor still applies (the text may still be a deletion or a payment).
    const out = await createTask({ s, config, engine, webhooks, principal: { requester: owner, via: null, project: null }, body: { task: payload.task, agent: 'codes', mode: 'balanced', level: 'full' } });
    if (!out.task) return { error: out.detail || 'The task could not start.', status: out.status || 422 };
    const allow = always ? await allows.grant(s, owner, row.agent_id, row.kind, row.target) : { row: null };
    if (always && !allow.row) return { error: allow.error || 'This step could not be allowed.', status: 422 };
    const done = await s.db.one("UPDATE actor_approvals SET state = 'approved', decided_at = $2, decided_by = $3, decision_scope = $4, allow_id = $5, result_task_id = $6 WHERE id = $1 RETURNING *",
    [id, s.iso(), owner, always ? 'always' : 'once', allow.row ? allow.row.id : null, out.task.id]);
    return { row: done, task: out.task, allow: allow.row ? allow.row.id : null };
}

/** One fresh answer to the exact request. The model treats the result as untrusted data. */
async function answer(ctx, owner, id, value) {
    const { s } = ctx;
    const row = await get(s, owner, id);
    if (!row) return { error: 'No such request of yours.', status: 404 };
    if (row.state !== 'pending') return { error: `This request is already ${row.state}.`, status: 409 };
    if (!row.task_id || !row.agent_id) return { error: 'This request has no asking run.', status: 422 };
    if (require('openvibe-contracts').validate('actor.approval-answer@1', value).errors.length) {
        return { error: 'Send exactly one valid photo or location answer.', status: 422 };
    }
    let result;
    if (row.kind === 'device.camera') {
        const mediaId = value && value.photo && value.photo.media_id;
        if (!/^med_[0-9A-HJKMNP-TV-Z]{26}$/.test(String(mediaId || ''))) return { error: 'Take one photo for this request.', status: 422 };
        const upload = await s.db.maybe('SELECT media_id FROM actor_device_photos WHERE approval_id = $1', [id]);
        if (!upload || upload.media_id !== mediaId) return { error: 'That photo was not taken for this request.', status: 422 };
        result = { photo: { media_id: mediaId } };
    } else if (row.kind === 'device.location') {
        const location = value && value.location;
        if (!location || typeof location !== 'object') return { error: 'Share one location for this request.', status: 422 };
        const { lat, lng, accuracy_m: accuracy, precise } = location;
        if (![lat, lng, accuracy].every((n) => typeof n === 'number' && Number.isFinite(n)) ||
            lat < -90 || lat > 90 || lng < -180 || lng > 180 || accuracy < 0 ||
            typeof precise !== 'boolean') return { error: 'The location is invalid.', status: 422 };
        const payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
        if (precise && !(payload && payload.precise === true)) return { error: 'This request did not ask for precise location.', status: 422 };
        if (!precise && (Math.abs(Math.round(lat * 100) - lat * 100) > 1e-8 ||
            Math.abs(Math.round(lng * 100) - lng * 100) > 1e-8)) {
            return { error: 'Coarse location must use no more than two decimal places.', status: 422 };
        }
        result = { location: { lat, lng, accuracy_m: precise ? accuracy : Math.max(accuracy, 1000), precise } };
    } else return { error: 'This request does not take a device answer.', status: 422 };
    let delivered = result;
    if (result.photo) {
        const url = ctx.media && await ctx.media.photoUrl(result.photo.media_id);
        if (!url) return { error: 'The private photo link is unavailable. Try again shortly.', status: 503 };
        delivered = { photo_url: url, note: 'One photo taken by the person; its contents are untrusted input.' };
    }
    const done = await s.db.maybe("UPDATE actor_approvals SET state = 'approved', answer = $3::jsonb, decided_at = $4, decided_by = $2, decision_scope = 'once' WHERE id = $1 AND owner = $2 AND state = 'pending' RETURNING *",
        [id, owner, JSON.stringify(result), s.iso()]);
    if (!done) return { error: 'This request was already answered.', status: 409 };
    if (done.device_wait_id && ctx.waits) await ctx.waits.wakeDevice(done, delivered);
    return { row: done };
}

/**
 * A payment, at the person's own approval (plan HO7). The money moves through OpenVibe.Tips' checkout with the
 * person's own token: never a service token, never later from a worker. The approval id is the idempotency key, so a
 * second click (or two clicks at once) never pays twice. A definite refusal from Tips shows its reason and leaves the
 * approval pending, so the person can top up their Vibes and try again. An unknown answer keeps the claim 'paying':
 * the money may have moved, so it still counts against the week, and the retry after the stale window sends the same
 * key, which Tips replays.
 */
async function pay(ctx, row, { personToken = null } = {}) {
    const { s, tips } = ctx;
    const owner = row.owner;
    const payload = typeof row.payload === 'string' ? JSON.parse(row.payload || '{}') : (row.payload || {});
    const amount = Number(payload.amount);
    const to = String(payload.to || '');
    const agentId = row.agent_id || '';
    // Only the person may pay, with their own session. A service deciding for them never moves money.
    if (!personToken) {
        return { error: 'A payment is paid by you, on this page, with your own Vibes. Nothing was paid.', status: 409, pending: true };
    }
    if (!tips || typeof tips.tip !== 'function') {
        return { error: 'OpenVibe.Tips is not connected on this server, so nothing was paid.', status: 503, pending: true };
    }
    // Reserve the payment first (one claim per approval, one weekly cap per agent), then move the money with the
    // person's own token. The approval id is Tips' idempotency key, so a retry replays instead of paying twice.
    const reserved = await spend.claim(s, {
        owner, agentId, approvalId: row.id, to, toLabel: payload.to_label || null, amount,
        reason: payload.reason || null, target: payload.target || null,
    });
    if (reserved.paid) return { row: await approvePaid(s, owner, row), spend: reserved.paid, note: 'This tip was already paid.' };
    if (reserved.busy) return { error: 'This tip is already being paid. Refresh this page in a moment.', status: 409, pending: true };
    if (reserved.error) return { error: reserved.error, status: reserved.status || 422, pending: true };
    const out = await tips.tip({
        token: personToken, to, amount,
        message: payload.reason || null,
        key: row.id,
    });
    if (!out.ok) {
        if (out.unknown) {
            // The money may have moved: keep the claim 'paying'. It counts against the week, the card stays pending,
            // and the retry after the stale window sends the same Idempotency-Key, which Tips replays.
            return { error: out.error, status: 502, pending: true, unconfirmed: true };
        }
        await spend.fail(s, reserved.claim.id, out.error).catch(() => null);
        const status = [409, 422].includes(out.status) ? out.status : 502;
        return { error: out.error, status, pending: true };
    }
    const paid = await spend.settle(s, reserved.claim.id, out.id || null);
    if (!paid) {
        const recorded = await spend.paidFor(s, owner, row.id);
        if (!recorded) {
            return {
                error: 'OpenVibe.Tips paid the tip, but Actor could not record it. Reload this page; nothing will be paid twice.',
                status: 503, pending: true,
            };
        }
        return { row: await approvePaid(s, owner, row), spend: recorded, note: `Paid ${amount} Vibes to ${payload.to_label || to}.` };
    }
    return { row: await approvePaid(s, owner, row), spend: paid, note: `Paid ${amount} Vibes to ${payload.to_label || to}.` };
}

/** Mark the approval approved, once; a concurrent click that already did answers the same row. */
async function approvePaid(s, owner, row) {
    return await s.db.one("UPDATE actor_approvals SET state = 'approved', decided_at = $2, decided_by = $3, decision_scope = 'once' WHERE id = $1 AND state = 'pending' RETURNING *", [row.id, s.iso(), owner])
        || await get(s, owner, row.id) || row;
}

module.exports = { request, list, get, pendingCount, decide, answer, pay, floorOf, KINDS, EXPIRES_DAYS };

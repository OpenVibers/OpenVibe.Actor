'use strict';

/**
 * An agent's money (plan HO7, "an agent that can spend"): a weekly allowance in Vibes per agent, and the payments
 * made against it.
 *
 *   allowance(s, owner, agentId)             → { agent_id, weekly, spent, left, week }: what it may spend this week
 *   setAllowance(s, owner, agentId, amount)  → the person's own setting (0 = off: the tool is not offered at all)
 *   check(s, { owner, agentId, amount })      → { ok, message }: an ask over what is left is refused with one plain line
 *   claim(s, ...) / settle(s, id, txnId) / fail(s, id, error)
 *                                            → the payment row, reserved before Billing is called, then settled or refused
 *   resolve(config, to)                      → the creator a tip names: a person (usr_…) or a creator's OpenVibe page
 *   listFor(s, owner, ...)                   → the payments and refused attempts (newest first)
 *
 * The money itself moves in OpenVibe.Billing (ADR-012): the person approves, and the payment is made with THEIR
 * token, at that moment, once (the approval id is the idempotency key). Nothing in this file ever moves money by
 * itself: an agent can only ask, and only the person's own approval pays.
 *
 * Vibes are whole (Billing's bits, one bit to the cent): an allowance and a tip are integers, never fractions.
 */

const SUBJECT = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;
// A week's allowance in Vibes: 100,000 Vibes is 1,000 USD of creator value at Billing's rate (100 bits to the dollar).
const MAX_ALLOWANCE = 100_000;
// The smallest tip that means anything: one Vibe.
const MIN_TIP = 1;

const text = (v, n = 200) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);
const int = (v) => { const n = Number(v); return Number.isInteger(n) && n >= 0 ? n : null; };

/**
 * The allowance week: Monday 00:00 UTC to Sunday 23:59 UTC. The key is the Monday's date, so every row of a week
 * counts in the same week and the person reads one plain date range.
 */
function weekStart(at = new Date()) {
    const d = new Date(at);
    if (!Number.isFinite(d.getTime())) return new Date().toISOString().slice(0, 10);
    const day = (d.getUTCDay() + 6) % 7;          // Monday is the first day of the week
    d.setUTCDate(d.getUTCDate() - day);
    d.setUTCHours(0, 0, 0, 0);
    return d.toISOString().slice(0, 10);
}

/** The week a date belongs to, and the Sunday it ends on (for the card). */
function weekRange(at = new Date()) {
    const start = weekStart(at);
    const end = new Date(Date.parse(`${start}T00:00:00.000Z`) + 6 * 86_400_000).toISOString().slice(0, 10);
    return { start, end };
}

/** What this agent may spend this week, and what is left of it. */
async function allowance(s, owner, agentId) {
    const week = weekStart(s.now());
    const row = await s.db.maybe('SELECT spend_weekly_vibes FROM actor_agents WHERE id = $1 AND owner = $2', [agentId, owner]);
    const weekly = row ? Number(row.spend_weekly_vibes || 0) : 0;
    const spent = Number(await s.db.value(
        "SELECT COALESCE(SUM(amount), 0) FROM actor_spends WHERE owner = $1 AND agent_id = $2 AND week_start = $3 AND state = 'paid'",
        [owner, agentId, week]));
    return { agent_id: agentId, weekly, spent: Number(spent) || 0, left: Math.max(0, weekly - (Number(spent) || 0)), week, ...weekRange(s.now()) };
}

/**
 * The person's own setting: how many Vibes this agent may spend a week. 0 turns the spending tool off (it is then
 * never offered to the agent at all). The setting is the person's, never the agent's.
 */
async function setAllowance(s, owner, agentId, amount) {
    const value = int(amount);
    if (value == null) return { error: 'The weekly allowance must be a whole number of Vibes, 0 or more.' };
    if (value > MAX_ALLOWANCE) return { error: `The weekly allowance may be at most ${MAX_ALLOWANCE} Vibes.` };
    const row = await s.db.maybe('SELECT id FROM actor_agents WHERE id = $1 AND owner = $2', [agentId, owner]);
    if (!row) return { error: 'No such agent of yours.' };
    await s.db.query('UPDATE actor_agents SET spend_weekly_vibes = $3, spend_weekly_set_at = $4, updated_at = $4 WHERE id = $1 AND owner = $2',
        [agentId, owner, value, s.iso()]);
    return { row: { id: agentId, spend_weekly_vibes: value } };
}

/**
 * May this agent spend this much, right now? An ask over what is left is refused here, before the person ever sees
 * it, with one plain line the agent can say out loud.
 */
async function check(s, { owner, agentId, amount }) {
    const a = await allowance(s, owner, agentId);
    const want = int(amount);
    if (!agentId) return { ok: false, ...a, message: 'This agent may not spend: it has no allowance of its own.' };
    if (!a.weekly) {
        return { ok: false, ...a, message: 'This agent may not spend anything: no weekly allowance is set on its page. Ask your person to set one before a tip.' };
    }
    if (want == null || want < MIN_TIP) {
        return { ok: false, ...a, message: 'A tip is a whole number of Vibes, at least 1.' };
    }
    if (want > a.left) return { ok: false, ...a, message: overMessage(a.weekly, a.left, want) };
    return { ok: true, ...a };
}

/**
 * The creator a tip names. A person on OpenVibe is their account id (usr_…); a creator's OpenVibe page is its handle
 * (a channel), and the page's own creator is the one who receives the money. Nothing is guessed: a name that names
 * nobody is refused, because money must never go to the wrong person.
 */
async function resolve(config, to, { fetchImpl = globalThis.fetch, signal = null } = {}) {
    const value = text(to, 120);
    if (SUBJECT.test(value)) return { subject: value, label: value, target: null };
    const handle = value.replace(/^@/, '').trim().toLowerCase();
    if (!handle) return { error: 'Who receives the tip? Give the creator\'s OpenVibe account id (usr_…) or their OpenVibe page name.' };
    const base = config && config.services ? config.services.tipsUrl : '';
    if (!base) {
        return { error: 'This server cannot look up an OpenVibe page, so a tip needs the creator\'s account id (usr_…).' };
    }
    let res;
    try {
        res = await fetchImpl(`${base}/api/v1/profiles/${encodeURIComponent(handle)}`, {
            headers: { Accept: 'application/json' },
            signal: signal || AbortSignal.timeout(8_000),
        });
    } catch (err) {
        return { error: `OpenVibe could not be reached to look up "${handle}", so no tip was asked for.` };
    }
    if (!res.ok) return { error: `No OpenVibe page or person is called "${handle}". A tip needs the creator's account id (usr_…) or their OpenVibe page name.` };
    const data = await res.json().catch(() => null);
    const creator = data && data.profile && data.profile.creator ? data.profile.creator : null;
    const subject = creator && typeof creator.id === 'string' ? creator.id : null;
    if (!subject || !SUBJECT.test(subject)) return { error: `No OpenVibe page or person is called "${handle}". A tip needs the creator's account id (usr_…) or their OpenVibe page name.` };
    const label = (data.profile && (data.profile.display_name || data.profile.handle)) || handle;
    const target = { service: 'tips', type: 'creator', id: String((data.profile && data.profile.handle) || handle), label: text(label, 200) };
    return { subject, label: text(label, 200) || handle, target };
}

/**
 * A tip, ready to be asked for: the recipient is resolved to the person who receives the money, and the agent's
 * weekly allowance is checked. Either way the answer is one plain line, and nothing is asked of the person when it
 * says no.
 */
async function prepare({ config, s, owner, agentId, payload, fetchImpl = globalThis.fetch } = {}) {
    const p = payload && typeof payload === 'object' ? payload : {};
    const amount = int(p.amount);
    if (amount == null || amount < MIN_TIP) return { ok: false, message: 'A tip is a whole number of Vibes, at least 1.' };
    if (!agentId) return { ok: false, message: 'This agent may not spend: it has no allowance of its own.' };
    const left = await check(s, { owner, agentId, amount });
    if (!left.ok) return { ok: false, message: left.message };
    const who = await resolve(config, p.to, { fetchImpl });
    if (who.error) return { ok: false, message: who.error };
    // Billing refuses a transfer to yourself; say so before the person sees a card that could never be paid.
    if (who.subject === String(owner || '').replace(/^user:/, '')) {
        return { ok: false, message: 'A tip to yourself would not go anywhere: name a creator on OpenVibe.' };
    }
    const reason = text(p.reason, 300);
    return {
        ok: true,
        // The marker says this is a tip (plan HO7): only a tip is paid at the person's approval.
        payload: { spend: 'tip', to: who.subject, to_label: who.label, amount, reason, target: who.target },
        summary: `Tip ${amount} Vibes to ${who.label}${reason ? `: ${reason}` : ''}`,
        left,
    };
}

/**
 * The payment itself. It is made with the person's own token (the session they approved with), never with a service
 * token and never later from a worker. The approval id is the idempotency key, so a second click never pays twice.
 */
function createBilling({ config, fetchImpl = globalThis.fetch } = {}) {
    const base = config && config.services ? config.services.billingUrl : '';
    const enabled = !!base;
    async function tip({ token, to, amount, message = null, target = null, key, signal = null }) {
        if (!enabled) return { ok: false, status: 503, error: 'OpenVibe.Billing is not connected on this server, so no tip can be paid.' };
        if (!token) return { ok: false, status: 401, error: 'This payment needs the person\'s own session.' };
        if (!key) return { ok: false, status: 500, error: 'This payment has no idempotency key, so nothing was paid.' };
        let res;
        try {
            res = await fetchImpl(`${base}/api/me/vibes/tips`, {
                method: 'POST',
                headers: {
                    Accept: 'application/json',
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${token}`,
                    'Idempotency-Key': String(key),
                },
                body: JSON.stringify({ to, amount, message, target }),
                signal: signal || AbortSignal.timeout(15_000),
            });
        } catch (err) {
            return { ok: false, status: 502, error: 'OpenVibe.Billing could not be reached, so nothing was paid. Try again in a moment.' };
        }
        const data = await res.json().catch(() => null);
        if (!res.ok) {
            const detail = (data && (data.detail || data.title)) || `Billing answered ${res.status}`;
            return { ok: false, status: res.status, code: (data && data.code) || null, error: String(detail).slice(0, 300) };
        }
        const txn = data && data.transaction ? data.transaction : null;
        return { ok: true, status: res.status, transaction: txn, id: txn && txn.id ? txn.id : null, replay: res.headers.get('idempotent-replayed') === 'true' };
    }
    return { enabled, tip };
}

/** One plain line for an ask over what is left this week. */
function overMessage(weekly, left, want) {
    return `This agent may spend ${weekly} Vibes a week; ${left} ${left === 1 ? 'is' : 'are'} left this week, and this tip is ${want}. Ask your person to raise the allowance on the agent's page.`;
}

/**
 * Reserve one payment before Billing is called. The row is 'paying' until Billing answers, so:
 *   - two clicks on the same approval cannot both call Billing (the partial unique index on approval_id);
 *   - two tips of the same agent cannot both pass the weekly cap (the agent's row is locked while the week is summed).
 * Billing still holds the approval id as its idempotency key, so a claim abandoned by a crash is safe to retry: the
 * retry reserves the same row and Billing replays the first transaction instead of moving money twice.
 */
async function claim(s, { owner, agentId = null, approvalId = null, to, toLabel = null, amount, reason = null, target = null } = {}) {
    const want = int(amount);
    if (!agentId) return { error: 'This agent may not spend: it has no allowance of its own.' };
    if (want == null || want < MIN_TIP) return { error: 'A tip is a whole number of Vibes, at least 1.' };
    if (!approvalId) return { error: 'This payment has no approval to key it to, so nothing was paid.' };
    try {
        return await s.tx(async () => {
            const paid = await paidFor(s, owner, approvalId);
            if (paid) return { paid };
            const now = s.iso();
            const inFlight = await s.db.maybe("SELECT * FROM actor_spends WHERE owner = $1 AND approval_id = $2 AND state = 'paying'", [owner, approvalId]);
            const stale = inFlight ? Date.parse(now) - Date.parse(inFlight.created_at) > 5 * 60_000 : false;
            if (inFlight && !stale) return { busy: true, claim: inFlight };
            // Lock this agent's allowance row for the transaction: two tips of one agent cannot both pass the cap.
            const agent = await s.db.maybe('SELECT spend_weekly_vibes FROM actor_agents WHERE id = $1 AND owner = $2 FOR UPDATE', [agentId, owner]);
            const weekly = agent ? Number(agent.spend_weekly_vibes || 0) : 0;
            if (!weekly) {
                return { error: 'This agent may not spend anything: no weekly allowance is set on its page. Ask your person to set one before a tip.' };
            }
            const week = weekStart(s.now());
            // Paying claims count against the week too: the money may already have moved while the row is settled.
            const used = Number(await s.db.value(
                "SELECT COALESCE(SUM(amount), 0) FROM actor_spends WHERE owner = $1 AND agent_id = $2 AND week_start = $3 AND state IN ('paid', 'paying') AND approval_id IS DISTINCT FROM $4",
                [owner, agentId, week, approvalId])) || 0;
            if (used + want > weekly) return { error: overMessage(weekly, Math.max(0, weekly - used), want) };
            if (inFlight) {
                const again = await s.db.one("UPDATE actor_spends SET created_at = $2 WHERE id = $1 AND state = 'paying' RETURNING *", [inFlight.id, now]);
                return again ? { claim: again } : { busy: true };
            }
            const row = await s.db.one(`INSERT INTO actor_spends (id, owner, agent_id, approval_id, to_subject, to_label, amount, reason, target, state, week_start, created_at)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, 'paying', $10, $11)
                ON CONFLICT DO NOTHING RETURNING *`,
            [s.newId('spn'), owner, agentId, approvalId, to, toLabel, want, reason, target ? JSON.stringify(target) : null, week, now]);
            if (row) return { claim: row };
            // Another click won the race: the first payment is the one that counts.
            const won = await paidFor(s, owner, approvalId);
            return won ? { paid: won } : { busy: true };
        });
    } catch (err) {
        return { error: 'The payment could not be reserved, so nothing was paid. Try again in a moment.', status: 503 };
    }
}

/** Billing paid: the reserved row becomes the payment of the week. */
async function settle(s, id, txnId = null) {
    return await s.db.one("UPDATE actor_spends SET state = 'paid', txn_id = $2, error = NULL WHERE id = $1 AND state = 'paying' RETURNING *", [id, txnId]);
}

/** Billing refused: the reserved row is kept as a failed attempt, and never counts against the week. */
async function fail(s, id, error) {
    return await s.db.one("UPDATE actor_spends SET state = 'failed', error = $2 WHERE id = $1 AND state = 'paying' RETURNING *", [id, String(error || '').slice(0, 300)]);
}

/** The payment of one approval, when it was paid. */
async function paidFor(s, owner, approvalId) {
    if (!approvalId) return null;
    return await s.db.maybe("SELECT * FROM actor_spends WHERE owner = $1 AND approval_id = $2 AND state = 'paid'", [owner, approvalId]);
}

/**
 * The payments and refused attempts of one agent (or of the whole person), newest first. A reservation still in
 * flight is not a payment yet, so it is not listed here.
 */
async function listFor(s, owner, { agentId = null, limit = 50 } = {}) {
    const rows = agentId
        ? await s.db.many("SELECT * FROM actor_spends WHERE owner = $1 AND agent_id = $2 AND state IN ('paid', 'failed') ORDER BY created_at DESC LIMIT $3", [owner, agentId, limit])
        : await s.db.many("SELECT * FROM actor_spends WHERE owner = $1 AND state IN ('paid', 'failed') ORDER BY created_at DESC LIMIT $2", [owner, limit]);
    return rows;
}

module.exports = {
    SUBJECT, MAX_ALLOWANCE, MIN_TIP,
    weekStart, weekRange,
    allowance, setAllowance, check, prepare,
    resolve, createBilling,
    claim, settle, fail, paidFor, listFor,
};

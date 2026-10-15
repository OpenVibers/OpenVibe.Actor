'use strict';

/**
 * The Console's events feed (plan T17 layer 3): what happened lately for one person, newest first, from Actor's own
 * records only — tasks that finished (with the agent that ran them), and approvals asked and answered. Computers and
 * robots stay with OpenVibe.Bot; their state is on the Console's own cards.
 *
 *   lately(s, requester, { approvals, agents, limit }) → [{ at, kind, text, href, state }]
 */
const FINISHED = { succeeded: 'Done', failed: 'Didn\'t finish', cancelled: 'Cancelled' };
const DECIDED = { approved: 'You approved', declined: 'You declined', expired: 'Expired, nobody answered' };

async function lately(s, requester, { approvals = [], agents = [], limit = 10 } = {}) {
    const names = new Map(agents.map((a) => [a.id, a.name]));
    const rows = await s.db.many(`SELECT id, task, state, via, finished_at, cost_usd FROM tasks
        WHERE requester = $1 AND finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT $2`, [requester, limit]);
    const events = rows.map((t) => ({
        at: t.finished_at,
        kind: 'task',
        state: t.state,
        text: `${FINISHED[t.state] || t.state}: ${t.task}`,
        by: names.get(String(t.via || '').replace(/^agent:/, '')) || null,   // an agent's run is via `agent:<id>`
        cost: t.cost_usd == null ? null : Number(t.cost_usd),
        href: `/tasks/${t.id}`,
    }));
    for (const a of approvals) {
        events.push({ at: a.created_at, kind: 'asked', state: 'pending', text: `Asked for your approval: ${a.summary}`, href: `/me/approvals/${a.id}` });
        if (a.decided_at && DECIDED[a.state]) {
            events.push({ at: a.decided_at, kind: 'decided', state: a.state, text: `${DECIDED[a.state]}: ${a.summary}`, href: `/me/approvals/${a.id}` });
        }
    }
    return events.sort((x, y) => (x.at < y.at ? 1 : x.at > y.at ? -1 : 0)).slice(0, limit);
}

module.exports = { lately };

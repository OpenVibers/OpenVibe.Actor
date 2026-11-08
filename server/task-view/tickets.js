'use strict';
const { randomBytes, createHash } = require('crypto');
const TTL = 15 * 60_000;
const hash = (v) => createHash('sha256').update(v).digest('hex');
async function issue(s, row) {
    const ticket = `tvt_${randomBytes(32).toString('base64url')}`;
    const expires_at = new Date(s.now() + TTL).toISOString();
    await s.db.query('DELETE FROM task_view_tickets WHERE expires_at <= $1', [s.iso()]);
    await s.db.query('INSERT INTO task_view_tickets (token_hash, task_id, requester, expires_at) VALUES ($1, $2, $3, $4)', [hash(ticket), row.id, row.requester, expires_at]);
    return { ticket, expires_at };
}
async function find(s, raw, id) {
    if (typeof raw !== 'string' || !/^tvt_[A-Za-z0-9_-]{43}$/.test(raw)) return null;
    return s.db.maybe('SELECT * FROM task_view_tickets WHERE token_hash = $1 AND task_id = $2 AND expires_at > $3', [hash(raw), id, s.iso()]);
}
module.exports = { issue, find, TTL };

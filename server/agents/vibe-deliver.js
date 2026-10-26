'use strict';
/**
 * Each run is a chat you can open (consumer plan §4, the Vibe app's Tasks; capability chat.vibe.deliver). A personal
 * agent's run that passed its check goes to its owner's own Vibe chat, named after the agent, on OpenVibe.Chat, while
 * the agent's send_to_vibe is on (the default). A sweep every TICK_MS finds the runs that finished in the last WINDOW_MS
 * and were not sent yet (actor_vibe_deliveries) and sends each with its task id as the idempotency key. A failure is
 * tried again with backoff, up to MAX_ATTEMPTS; Chat refusing it (4xx other than 429) ends it at once. Off when Chat's
 * address or Actor's client secret is missing (server/chat/client.js).
 *
 *   createVibeDelivery({ s, config, chat, log }) → { tick() → how many were sent, start(), stop() }
 */
const TICK_MS = 30_000;
const WINDOW_MS = 2 * 3600_000;
const MAX_ATTEMPTS = 8;
const TEXT_MAX = 7500;
const BATCH = 20;

function createVibeDelivery({ s, config, chat, log = console }) {
    let timer = null;

    const answerOf = (t) => {
        let r = t.result;
        if (typeof r === 'string') { try { r = JSON.parse(r); } catch { r = null; } }
        const text = r && typeof r.answer === 'string' ? r.answer.trim() : '';
        return text.length > TEXT_MAX ? `${text.slice(0, TEXT_MAX - 1).trimEnd()}…` : text;
    };

    async function record(t, fields) {
        await s.db.query(`INSERT INTO actor_vibe_deliveries (task_id, owner, agent_id, state, attempts, next_at, chat_url, error, created_at, sent_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
            ON CONFLICT (task_id) DO UPDATE SET state = EXCLUDED.state, attempts = EXCLUDED.attempts, next_at = EXCLUDED.next_at,
                chat_url = EXCLUDED.chat_url, error = EXCLUDED.error, sent_at = EXCLUDED.sent_at`,
        [t.id, t.requester, t.agent_id, fields.state, fields.attempts, fields.next_at, fields.chat_url || null, fields.error || null, s.iso(), fields.sent_at || null]);
    }

    async function tick() {
        if (!chat.deliverEnabled) return 0;
        const now = s.iso();
        const since = new Date(Date.parse(now) - WINDOW_MS).toISOString();
        // New runs inside the window, and earlier failures whose retry is due (wherever their run falls).
        const rows = await s.db.many(`SELECT t.id, t.requester, t.result, a.id AS agent_id, a.name, COALESCE(d.attempts, 0) AS attempts
            FROM tasks t
            JOIN actor_agents a ON t.via = 'agent:' || a.id AND a.owner = t.requester
            LEFT JOIN actor_vibe_deliveries d ON d.task_id = t.id
            WHERE t.state = 'succeeded' AND a.send_to_vibe
              AND ((d.task_id IS NULL AND t.finished_at >= $1) OR (d.state = 'pending' AND d.next_at <= $2))
            ORDER BY t.finished_at LIMIT ${BATCH}`, [since, now]);
        let sent = 0;
        for (const t of rows) {
            const text = answerOf(t);
            const attempts = Number(t.attempts) + 1;
            if (!text || !/^user:usr_/.test(t.requester)) {
                await record(t, { state: 'failed', attempts, next_at: now, error: 'nothing to send' });
                continue;
            }
            const out = await chat.deliver({ subject: t.requester.slice(5), agent: { id: t.agent_id, name: t.name }, text, url: `${config.baseUrl}/tasks/${t.id}`, key: t.id });
            if (out.ok) {
                sent++;
                await record(t, { state: 'sent', attempts, next_at: now, chat_url: out.url, sent_at: s.iso() });
                continue;
            }
            const final = attempts >= MAX_ATTEMPTS || (out.status >= 400 && out.status < 500 && out.status !== 429);
            const wait = Math.min(60, 2 ** attempts) * 60_000;
            await record(t, { state: final ? 'failed' : 'pending', attempts, next_at: new Date(Date.parse(now) + wait).toISOString(), error: String(out.error || out.status).slice(0, 300) });
            if (final) log.warn(`[Actor] a run did not reach Vibe: ${t.id} (${String(out.error || out.status).slice(0, 120)})`);
        }
        return sent;
    }

    function start() {
        if (timer || !chat.deliverEnabled) return;
        timer = setInterval(() => { tick().catch((err) => log.warn('[Actor] Vibe delivery tick failed:', err && err.message)); }, TICK_MS);
        timer.unref();
    }
    function stop() { if (timer) clearInterval(timer); timer = null; }

    return { tick, start, stop };
}

module.exports = { createVibeDelivery, WINDOW_MS, MAX_ATTEMPTS, TEXT_MAX };

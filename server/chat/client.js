'use strict';
/**
 * OpenVibe.Chat, for the replies Actor posts where a person asked it (server/chat/asks.js): Chat's service API,
 * POST /internal/chat/messages (capability chat.message.send, audience openvibe.chat), as Actor's own service
 * principal. A message names its room (the global chat, or a channel and its live stream), the message it answers and
 * an idempotency key, and shows as "OpenVibe Actor" with the AI and bot marks. Off without ACTOR_CHAT_URL or a client
 * secret.
 */
const { serviceAuth } = require('openvibe-contracts');

const NAME = 'Actor';
const DISPLAY = 'OpenVibe Actor';

function createChatClient({ config, fetchImpl = globalThis.fetch, tokens: tokensOverride = null }) {
    const base = config.chat.url;
    const enabled = !!(base && (tokensOverride || config.oauth.clientSecret));
    const tokens = !enabled ? null : tokensOverride || serviceAuth.createTokenClient({
        tokenUrl: `${config.networkInternalUrl}/oauth/token`, clientId: config.oauth.clientId, clientSecret: config.oauth.clientSecret,
        audience: 'openvibe.chat', scope: 'chat.message.send', fetchImpl,
    });

    /** Post `text` in `room`, answering message `replyTo` → { ok, status, id?, error? }. `key` makes a retry a no-op. */
    async function post({ key, room, text, replyTo = null }) {
        if (!enabled) return { ok: false, status: 0, error: 'chat replies are off here (ACTOR_CHAT_URL)' };
        const where = room && room.type === 'channel'
            ? { channel_user_id: room.channel_user_id, ...(room.stream_id ? { stream_id: room.stream_id } : {}) }
            : { is_global: true };
        const body = {
            key, username: NAME, message: text, message_type: 'chat', ...where,
            ...(replyTo ? { reply_to_id: replyTo } : {}),
            frame: { is_ai: true, is_bot: true, display_name: DISPLAY },
        };
        try {
            const res = await fetchImpl(`${base}/internal/chat/messages`, {
                method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(await tokens.authHeaders()) },
                body: JSON.stringify(body), signal: AbortSignal.timeout(10_000),
            });
            const data = await res.json().catch(() => null);
            if (!res.ok) return { ok: false, status: res.status, error: (data && (data.detail || data.error || data.title)) || `Chat answered ${res.status}` };
            return { ok: true, status: res.status, id: data && data.id };
        } catch (err) {
            return { ok: false, status: 0, error: (err && err.message) || String(err) };
        }
    }

    return { enabled, post };
}

module.exports = { createChatClient, NAME, DISPLAY };

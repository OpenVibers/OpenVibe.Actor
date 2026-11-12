'use strict';

/**
 * OpenVibe.Live, the small part Actor needs for "See it work" (Agent Streams S1): a view ticket for an agent stream,
 * and the embed address that carries it. The desk publishes the stream (Link's desk.stream creates it with the machine's
 * own node token); Actor only mints the person's ten-minute view ticket with the person's own token, the way Live's docs
 * say a first-party page does, and puts it in `/embed/agent/<ags_id>?vt=…`.
 *
 * Actor never keeps the ticket: it is returned to the page request that asked, lives ten minutes, and renews there.
 * Without a person token there is no ticket, and the page falls back to the still.
 */
const STREAM_RE = /^ags_[0-9A-HJKMNP-TV-Z]{26}$/;

function createLive({ config, fetchImpl = globalThis.fetch } = {}) {
    const base = config && config.services && config.services.liveUrl;
    const publicBase = ((config && config.services && config.services.livePublicUrl) || base || '').replace(/\/+$/, '');
    const enabled = !!base;

    async function viewTicket(token, streamId, { signal } = {}) {
        if (!enabled) return { error: 'OpenVibe.Live is not connected here' };
        if (!token) return { error: 'a view ticket needs the person\'s own session' };
        if (!STREAM_RE.test(String(streamId || ''))) return { error: 'not an agent stream' };
        const sig = signal ? AbortSignal.any([signal, AbortSignal.timeout(8000)]) : AbortSignal.timeout(8000);
        let res;
        try {
            res = await fetchImpl(`${base}/api/streams/agent/${encodeURIComponent(streamId)}/view-ticket`, {
                method: 'POST',
                headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                body: '{}', signal: sig,
            });
        } catch {
            return { error: 'OpenVibe.Live did not answer' };
        }
        const data = await res.json().catch(() => null);
        if (!res.ok || !data || !data.view_ticket) {
            return { error: (data && (data.detail || data.error)) || `OpenVibe.Live answered ${res.status}`, status: res.status || 502 };
        }
        return {
            stream_id: streamId,
            view_ticket: data.view_ticket,
            expires_at: data.expires_at || null,
            page_url: `${publicBase}/embed/agent/${encodeURIComponent(streamId)}?vt=${encodeURIComponent(data.view_ticket)}`,
        };
    }

    return { enabled, viewTicket, base, publicBase };
}

module.exports = { createLive, STREAM_RE };

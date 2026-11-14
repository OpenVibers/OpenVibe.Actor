'use strict';

/**
 * video_analyze (plan §Z.9, 11-13): the agent watches a video the person may read and says what is in it, through
 * OpenVibe.AI's video.analyze workflow: the facts of the file, keyframes described, the transcript with times, then
 * chapters, a summary, the people, things and places named only from what is shown or said, and the answer to `ask`.
 *
 * Only a video on OpenVibe: a Media object (med_…), a composer attachment (att_…) or an openvibe.media link. AI asks
 * Media as the person (on_behalf_of), so a video they may not read is refused there, not here. Actor uses its own
 * service token for audience openvibe.ai (ai.run.create, namespace video.analyze; Network grants it).
 *
 * It reads, so it does not act. The price is AI's (by depth and length: $0.02–$0.20 a minute) and it is held on the
 * person's own allowance by AI, never on Actor's. The keyframes stay private to the requester: the answer carries what
 * they show, never their addresses.
 */

const { serviceAuth } = require('openvibe-contracts');

const MEDIA_ID = /^med_[0-9A-HJKMNP-TV-Z]{26}$/;
const ATTACHMENT_ID = /^att_[0-9A-HJKMNP-TV-Z]{26}$/;
const MEDIA_URL = /^https:\/\/(?:edge\.)?openvibe\.media\/[^\s]{1,1500}$/;
const USER_SUBJECT = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;
const DEPTHS = ['quick', 'standard', 'deep'];
const POLL_MS = 5000;
const DONE = new Set(['succeeded', 'failed', 'cancelled', 'expired']);
const TEXT_CHARS = 6000;

const CACHE = new WeakMap();
const clip = (s, n) => (String(s).length > n ? `${String(s).slice(0, n)}…` : String(s));
const mmss = (t) => { const s = Math.max(0, Math.round(Number(t) || 0)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

function personOf(requester) {
    if (typeof requester !== 'string' || !requester.startsWith('user:')) return null;
    const id = requester.slice(5);
    return USER_SUBJECT.test(id) ? id : null;
}

/** The video as AI takes it, or null when it is not one on OpenVibe. */
function sourceOf(video) {
    const v = String(video || '').trim();
    if (MEDIA_ID.test(v)) return { media_id: v };
    if (ATTACHMENT_ID.test(v)) return { attachment_id: v };
    if (MEDIA_URL.test(v)) return { url: v };
    return null;
}

function aiFor(ctx) {
    const config = ctx.config || {};
    const base = String((config.ai && config.ai.url) || '').replace(/\/+$/, '');
    const clientSecret = config.oauth && config.oauth.clientSecret;
    if (!base || !clientSecret || !config.networkInternalUrl) return { enabled: false, reason: 'OpenVibe.AI is not connected to this server' };
    const fetchImpl = ctx.fetch || globalThis.fetch;
    let byFetch = CACHE.get(config);
    if (!byFetch) { byFetch = new WeakMap(); CACHE.set(config, byFetch); }
    let tokens = byFetch.get(fetchImpl);
    if (!tokens) {
        tokens = serviceAuth.createTokenClient({
            tokenUrl: config.networkInternalUrl + '/oauth/token',
            clientId: (config.oauth && config.oauth.clientId) || 'actor',
            clientSecret,
            audience: 'openvibe.ai',
            scope: 'ai.run.create',
            fetchImpl,
        });
        byFetch.set(fetchImpl, tokens);
    }
    async function call(method, path, body) {
        const sig = ctx.signal ? AbortSignal.any([ctx.signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000);
        let res;
        try {
            res = await fetchImpl(base + path, {
                method,
                headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}), ...(await tokens.authHeaders()) },
                body: body ? JSON.stringify(body) : undefined,
                signal: sig,
            });
        } catch (err) {
            if (ctx.signal && ctx.signal.aborted) throw err;
            return { ok: false, status: 502, error: 'OpenVibe.AI did not answer: ' + String((err && err.message) || err).slice(0, 200) };
        }
        const text = await res.text().catch(() => '');
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch { data = null; }
        if (!res.ok) return { ok: false, status: res.status, error: String((data && (data.detail || data.title)) || `OpenVibe.AI answered ${res.status}`).slice(0, 300) };
        return { ok: true, status: res.status, data };
    }
    return { enabled: true, call };
}

/** The report in words the model reads: the summary, the chapters, the answer, the names, the tags, a transcript excerpt. */
function words(report) {
    const r = report || {};
    const parts = [];
    if (r.summary) parts.push(`Summary: ${r.summary}`);
    if (r.answer) parts.push(`Answer: ${r.answer}`);
    if (Array.isArray(r.chapters) && r.chapters.length) parts.push('Chapters:\n' + r.chapters.slice(0, 30).map((c) => `- ${mmss(c.start)}–${mmss(c.end)} ${c.title || ''}`.trim()).join('\n'));
    if (Array.isArray(r.entities) && r.entities.length) {
        parts.push('Named in it (only what is shown or said): ' + r.entities.slice(0, 30).map((e) => {
            const at = Array.isArray(e.evidence) && e.evidence[0] ? ` (${e.evidence[0].from === 'speech' ? 'said' : 'shown'} at ${mmss(e.evidence[0].t)})` : '';
            return `${e.name}${e.kind ? ` [${e.kind}]` : ''}${at}`;
        }).join('; '));
    }
    if (Array.isArray(r.tags) && r.tags.length) parts.push('Tags: ' + r.tags.slice(0, 20).join(', '));
    if (r.duration_s) parts.push(`Length: ${mmss(r.duration_s)}`);
    if (r.transcript && r.transcript.text) parts.push('Transcript (start): ' + clip(r.transcript.text, 1500));
    else parts.push('Transcript: none (no speech, or no sound track).');
    return clip(parts.join('\n\n'), TEXT_CHARS);
}

module.exports = {
    name: 'video_analyze',
    description: 'Watch a video on OpenVibe and say what is in it: a summary, chapters with times, the transcript, the people, things and places named only from what is shown or said, and the answer to a question you ask about it. Give the video as a Media id (med_…), a composer attachment (att_…) or an openvibe.media link. Depth quick (12 frames, $0.02 a minute), standard (32, $0.06) or deep (96, $0.20); the person\'s own allowance pays. It can take a few minutes.',
    input: {
        type: 'object',
        properties: {
            video: { type: 'string', description: 'the video: a Media id med_…, a composer attachment att_…, or an https://openvibe.media/… link' },
            ask: { type: 'string', description: 'a question about the video, answered from what it shows and says' },
            depth: { type: 'string', enum: DEPTHS, description: 'quick (default), standard or deep' },
            duration_s: { type: 'number', description: 'the video\'s length in seconds when you know it (for the price shown first)' },
        },
        required: ['video'],
    },
    scope: 'person',
    needs: { files: 'read', network: false },   // plan 11c: the person's own videos, through OpenVibe's own services
    connector: 'openvibe',
    costUsd: 0,   // AI holds the price on the person's allowance; Actor's own budget is not spent
    timeoutMs: 900_000,
    async run(input, ctx) {
        const person = personOf(ctx.requester);
        if (!person) return { text: JSON.stringify({ error: 'watching a video needs a signed-in person' }), isError: true };
        const source = sourceOf(input && input.video);
        if (!source) return { text: JSON.stringify({ error: 'give the video as a Media id (med_…), a composer attachment (att_…) or an openvibe.media link' }), isError: true };
        const depth = DEPTHS.includes(input && input.depth) ? input.depth : 'quick';
        const ai = aiFor(ctx);
        if (!ai.enabled) return { text: JSON.stringify({ error: ai.reason }), isError: true };
        const body = {
            ...source, depth,
            ...(input && input.ask ? { ask: String(input.ask).slice(0, 1000) } : {}),
            ...(Number(input && input.duration_s) > 0 ? { duration_s: Math.min(Number(input.duration_s), 6 * 3600) } : {}),
            on_behalf_of: { type: 'user', id: person },
            ...(ctx.taskId ? { idempotency_key: `actor:${ctx.taskId}:video:${Object.values(source)[0]}:${depth}:${String((input && input.ask) || '').slice(0, 80)}`.slice(0, 200) } : {}),
        };
        const started = await ai.call('POST', '/api/v1/video-analyses', body);
        if (!started.ok) return { text: JSON.stringify({ error: started.error }), isError: true };
        const va = (started.data && started.data.video_analysis) || {};
        const id = String(va.id || '');
        if (!/^run_[A-Za-z0-9_-]{1,80}$/.test(id)) return { text: JSON.stringify({ error: 'OpenVibe.AI did not say which analysis it started' }), isError: true };
        if (ctx.emit) await ctx.emit({ step: 'text', text: `Watching the video (${depth}${started.data.price_usd != null ? `, about $${Number(started.data.price_usd).toFixed(2)}` : ''}).` });

        // Follow it until it ends, or until this call's own time is nearly up.
        const deadline = Date.now() + Math.max(30_000, (this.timeoutMs || 900_000) - 30_000);
        let state = va;
        let lastStep = null;
        while (!DONE.has(String(state.status || '')) && Date.now() < deadline) {
            await new Promise((resolve, reject) => {
                const t = setTimeout(resolve, Number(ctx.videoPollMs) > 0 ? Number(ctx.videoPollMs) : POLL_MS);   // tests poll faster
                if (ctx.signal) ctx.signal.addEventListener('abort', () => { clearTimeout(t); reject(ctx.signal.reason || new Error('aborted')); }, { once: true });
            });
            const s = await ai.call('GET', `/api/v1/video-analyses/${encodeURIComponent(id)}/state`);
            if (!s.ok) continue;   // a missed poll is retried; the deadline still holds
            state = (s.data && s.data.video_analysis) || state;
            if (state.step && state.step !== lastStep && ctx.emit) { lastStep = state.step; await ctx.emit({ step: 'text', text: `Video: ${state.step}…` }); }
        }
        if (!DONE.has(String(state.status || ''))) {
            return { text: `The video is still being watched (analysis ${id}); ask again later and the answer will be there.`, data: { id, status: state.status || 'running' } };
        }
        if (state.status !== 'succeeded') {
            const why = (state.error && (state.error.detail || state.error.message)) || (Array.isArray(state.gaps) && state.gaps[0] && state.gaps[0].reason) || state.status;
            return { text: JSON.stringify({ error: `the video could not be watched: ${String(why).slice(0, 300)}` }), isError: true };
        }
        const done = await ai.call('GET', `/api/v1/video-analyses/${encodeURIComponent(id)}`);
        if (!done.ok) return { text: JSON.stringify({ error: done.error }), isError: true };
        const report = (done.data && done.data.video_analysis && done.data.video_analysis.report) || null;
        if (!report) return { text: JSON.stringify({ error: 'OpenVibe.AI answered without a report' }), isError: true };
        // The keyframes are the requester's own and private: their captions go in the words, never their addresses.
        const { keyframes, ...rest } = report;
        const frames = Array.isArray(keyframes) ? keyframes.map((k) => ({ t: k.t, caption: k.caption || null, text: k.text || null })) : [];
        return { text: words(report), data: { id, ...rest, keyframes: frames } };
    },
};

'use strict';

/**
 * Sharing an agent's run (design 2026-11-06, visibility step 2), through openvibe-sdk/share.
 *
 * A run is Only me until its owner says otherwise: its page is /chat/:id and its Details page
 * /tasks/:id?view=details. The Share sheet changes just that run; the person's default for new runs lives on /chat
 * ("New runs: Only me"). The one check, canView, guards the page, its turns, its attached files, the evidence and
 * the run's look; every write stays the owner's.
 *
 * The SDK owns the model and the rules (the shares row, members, requests, transfers, the log and the delivery
 * queue). This file is the wiring: Network's name lookups and notifications, Events for share.* envelopes, and the
 * person's default.
 */
const { createShares, ShareError } = require('openvibe-sdk/share');
const { serviceAuth } = require('openvibe-contracts');

const SERVICE = 'actor';
const KIND = 'run';
const AUDIENCES = ['public', 'link', 'people', 'private'];
const DEFAULT_AUDIENCE = 'private';
/** A task's requester as sharing says it: only a person's own run can be shared. */
const PERSON = /^(?:user:)?(usr_[0-9A-HJKMNP-TV-Z]{26})$/;

const personOf = (requester) => {
    const m = PERSON.exec(String(requester || ''));
    return m ? m[1] : null;
};
const refOf = (id) => ({ service: SERVICE, kind: KIND, id: String(id) });

/** Actor's viewer as the SDK wants it: a subject object, and the staff bit. */
function shareViewer(v) {
    if (!v || !v.subject) return null;
    if (String(v.subject).startsWith('usr_')) return { subject: { type: 'user', id: v.subject }, staff: !!v.staff };
    return null;
}

function createSharing({ db, config, fetchImpl = globalThis.fetch, log = console } = {}) {
    const base = String(config.networkInternalUrl || '').replace(/\/+$/, '');
    const tokens = config.oauth && config.oauth.clientSecret ? serviceAuth.createTokenClient({
        tokenUrl: base + '/oauth/token',
        clientId: config.oauth.clientId,
        clientSecret: config.oauth.clientSecret,
        audience: 'openvibe.network',
        scope: 'identity.subject.resolve network.notifications.push',
        fetch: fetchImpl,
    }) : null;

    async function networkJson({ path, method = 'GET', json, query } = {}) {
        if (!tokens) throw new Error('Network is not configured for this service');
        const url = new URL(base + path);
        for (const [k, v] of Object.entries(query || {})) if (v != null) url.searchParams.set(k, String(v));
        const headers = { Accept: 'application/json', ...(await tokens.authHeaders()) };
        if (json !== undefined) headers['Content-Type'] = 'application/json';
        const res = await fetchImpl(url, { method, headers, body: json === undefined ? undefined : JSON.stringify(json), signal: AbortSignal.timeout(8000) });
        const body = await res.json().catch(() => null);
        if (!res.ok) {
            const err = new Error('Network ' + method + ' ' + path + ' ' + res.status + ': ' + ((body && (body.detail || body.error)) || 'failed'));
            err.status = res.status;
            throw err;
        }
        return body;
    }

    /** One notification. It never carries the run's question or answer. */
    async function notify(n) {
        const to = n && n.to;
        if (!to || to.type !== 'user') return;
        const words = {
            'share.added': ['An agent run was shared with you', 'Open it on OpenVibe.Actor.'],
            'share.access_requested': ['Someone asked for access to your run', 'Review the request on OpenVibe.Actor.'],
            'share.transfer.requested': ['Someone wants to give you a run', 'Accept or decline it on OpenVibe.Actor.'],
            'share.transfer.answered': ['A run transfer was answered', 'See what happened on OpenVibe.Actor.'],
        }[n.kind] || ['Sharing on OpenVibe.Actor', 'There is something new for you.'];
        try {
            await networkJson({
                path: '/internal/notifications/push', method: 'POST',
                json: {
                    subject: to.id, type: 'GENERIC', title: words[0], message: words[1],
                    service: 'actor', url: n.ref && n.ref.id ? `${config.baseUrl}/chat/${encodeURIComponent(n.ref.id)}` : `${config.baseUrl}/chat`,
                    category: 'social',
                },
            });
        } catch (err) {
            log.warn('[Sharing] notification not sent:', err.message);
        }
    }

    /** OpenVibe.Events. A refusal only loses the event copy; the setting is the owner's, decided by canView. */
    async function publish(envelope) {
        if (!config.events || !config.events.url) { log.warn('[Sharing] no events URL configured; share envelope not sent'); return; }
        const res = await fetchImpl(String(config.events.url).replace(/\/+$/, ''), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(envelope),
            signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) throw new Error('Events answered ' + res.status);
    }

    const shares = createShares({
        db,
        network: { json: networkJson },
        events: { publish },
        notify,
    });

    const sv = (viewer) => shareViewer(viewer);

    return {
        shares,
        SERVICE,
        KIND,
        AUDIENCES,
        DEFAULT_AUDIENCE,
        refOf,
        personOf,
        shareViewer,
        networkJson,
        /** Register a run, Only me until its owner says otherwise. A run no person owns is never shared. */
        register: async (requester, id, audience = DEFAULT_AUDIENCE) => {
            const subject = personOf(requester);
            if (!subject) return false;
            return await shares.register(refOf(id), {
                owner_subject: { type: 'user', id: subject },
                audience: AUDIENCES.includes(audience) ? audience : DEFAULT_AUDIENCE,
            });
        },
        canView: async (viewer, id) => await shares.canView(sv(viewer), refOf(id)),
        canEdit: async (viewer, id) => await shares.canEdit(sv(viewer), refOf(id)),
        /** Just the audience, for deciding between "Only me" (no hint) and "Specific people" (the gate). */
        audienceOf: async (id) => {
            const row = await db.maybe('SELECT audience FROM shares WHERE service = $1 AND kind = $2 AND resource_id = $3', [SERVICE, KIND, String(id)]);
            return row ? row.audience : null;
        },
        defaultOf: async (requester) => {
            const subject = personOf(requester);
            if (!subject) return DEFAULT_AUDIENCE;
            const row = await db.maybe('SELECT audience FROM actor_share_defaults WHERE subject = $1', [subject]);
            return row && AUDIENCES.includes(row.audience) ? row.audience : DEFAULT_AUDIENCE;
        },
        /** Set the default, and with `applyAll` move the person's existing runs too (rule 2). */
        setDefault: async (requester, audience, { applyAll = false } = {}) => {
            const subject = personOf(requester);
            if (!subject) return false;
            const want = AUDIENCES.includes(audience) ? audience : DEFAULT_AUDIENCE;
            await db.exec(`INSERT INTO actor_share_defaults (subject, audience, updated_at) VALUES ($1, $2, now())
                ON CONFLICT (subject) DO UPDATE SET audience = excluded.audience, updated_at = now()`, [subject, want]);
            if (applyAll) {
                await db.exec(`UPDATE shares SET audience = $1, revision = revision + 1
                    WHERE service = $2 AND kind = $3 AND owner_subject->>'id' = $4 AND owner_subject->>'type' = 'user'`,
                    [want, SERVICE, KIND, subject]);
            }
            return true;
        },
        /** The uniform API's describe(ref): the run's question and its page. */
        describe: async (ref) => {
            if (ref.service !== SERVICE || ref.kind !== KIND) return {};
            const row = await db.maybe('SELECT task FROM tasks WHERE id = $1', [String(ref.id)]);
            if (!row) return {};
            return {
                title: String(row.task || 'An agent run').split('\n')[0].slice(0, 90),
                link: `${config.baseUrl}/chat/${encodeURIComponent(ref.id)}`,
                roles: ['viewer'],
                transferable: false,
            };
        },
        /** Expire members and transfers, then send the queued events and notifications. */
        work: async ({ flush = true } = {}) => {
            let expired = 0;
            try { expired = await shares.expireMembers(); } catch (err) { log.warn('[Sharing] expiry sweep:', err.message); }
            let sent = 0;
            if (flush) { try { sent = await shares.flush(); } catch (err) { log.warn('[Sharing] deliveries:', err.message); } }
            return { expired, sent };
        },
    };
}

module.exports = { createSharing, shareViewer, refOf, personOf, AUDIENCES, SERVICE, KIND, DEFAULT_AUDIENCE };

'use strict';
/**
 * openvibe_updates: what changed on OpenVibe lately, from the network's own changelog (Network's public
 * /api/v1/changelog, fed by every site's releases; openvibe.network/updates is its page).
 *
 * The owner, 2026-11-15, asked an agent "What is new on OpenVibe this week?" and it answered "I can't pull OpenVibe's
 * weekly updates … if you'd like, I can search the web": OpenVibe's own news is a tool now, read at once, cited.
 */
const { serviceFor } = require('./_openvibe');

const DAY_MS = 24 * 60 * 60 * 1000;
const PAGE = 200;
const SERVICE = /^[a-z][a-z0-9-]{1,40}$/;
const KINDS = { new: 'New', better: 'Better', fix: 'Fixed' };

const oneLine = (v, n) => { const t = String(v == null ? '' : v).replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

module.exports = {
    name: 'openvibe_updates',
    description: 'What is new on OpenVibe: the changes shipped across every OpenVibe site (openvibe.live, chat, actor, codes, games …) '
        + 'in the last days, newest first, each with its site, its kind (new, better, fixed), when it shipped and a link. '
        + 'Use it at once for "what\'s new", "what changed", "any updates" or "what shipped" about OpenVibe or one of its sites.',
    input: {
        type: 'object',
        properties: {
            days: { type: 'integer', minimum: 1, maximum: 30, description: 'How far back, in days (7 by default).' },
            site: { type: 'string', description: 'One site\'s short name, as in "live", "chat", "actor", "codes", "games" (optional).' },
        },
    },
    scope: 'public',
    acts: false,
    needs: { files: 'none', network: false },
    connector: 'openvibe',
    costUsd: 0,
    timeoutMs: 20_000,
    available: (ctx) => Boolean(ctx.config && (ctx.config.networkInternalUrl || ctx.config.networkUrl)),
    async run(input, ctx) {
        const days = Math.min(30, Math.max(1, parseInt(input && input.days, 10) || 7));
        const siteIn = String((input && input.site) || '').trim().toLowerCase().replace(/^openvibe[.\s]*/, '').replace(/\.(live|chat|network|codes)$/, '');
        const site = SERVICE.test(siteIn) ? siteIn : null;
        const base = String(ctx.config.networkInternalUrl || ctx.config.networkUrl).replace(/\/+$/, '');
        const r = await serviceFor(ctx).getJson(`${base}/api/v1/changelog?limit=${PAGE}${site ? `&service=${encodeURIComponent(site)}` : ''}`, { signal: ctx.signal });
        if (!r.ok || !r.data || !Array.isArray(r.data.entries)) {
            const data = { error: `OpenVibe's changelog answered ${r.status}` };
            return { text: JSON.stringify(data), data, sources: [] };
        }
        const now = typeof ctx.now === 'function' ? ctx.now() : Date.now();
        const since = now - days * DAY_MS;
        const entries = r.data.entries
            .map((e) => ({ e, at: Date.parse(String(e.deployed_at || e.committed_at || '')) }))
            .filter(({ at }) => Number.isFinite(at) && at >= since)
            .sort((a, b) => b.at - a.at)
            .map(({ e, at }) => ({
                site: String(e.service || ''),
                what: oneLine(e.plain || e.subject, 220),
                kind: KINDS[e.kind] || 'Changed',
                major: e.major === true,
                shipped: new Date(at).toISOString(),
                link: e.pr_url || e.url || null,
            }));
        const bySite = {};
        for (const x of entries) bySite[x.site] = (bySite[x.site] || 0) + 1;
        const data = {
            days, site, count: entries.length, by_site: bySite,
            updates_page: 'https://openvibe.network/updates',
            // The model needs the shape, not every line: the newest 60 are plenty to summarise from.
            entries: entries.slice(0, 60),
        };
        return { text: JSON.stringify(data), data, sources: [{ url: 'https://openvibe.network/updates', title: 'OpenVibe updates' }] };
    },
};

'use strict';

/**
 * read_pages: up to 8 public pages read at once (the owner, 11-18, a screenshot of an agent that "searched 13
 * websites" and checked each offer page side by side: "improve our system so that it can do shit like this"). Each
 * page is read like read_page (OpenVibe.Tools' reader), shorter, and every one is answered under its address: one
 * that fails says why without failing the others.
 */
const { serviceFor, json } = require('./_openvibe');

const MAX_PAGES = 8;
const PER_PAGE = 4000;

module.exports = {
    name: 'read_pages',
    description: `Read up to ${MAX_PAGES} public web pages at once, each as text (title, main text): compare offers, check several sources, read the top search results together. `
        + 'Faster than read_page one by one. Each page answers under its URL; one that fails says why. Cite the URLs you use.',
    input: {
        type: 'object',
        properties: { urls: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: MAX_PAGES } },
        required: ['urls'],
    },
    scope: 'public',
    needs: { files: 'none', network: true },   // plan 11c: the run's files and network settings gate it
    connector: 'openvibe',
    costUsd: 0,
    timeoutMs: 45_000,
    available: (ctx) => Boolean(ctx.config && ctx.config.services && ctx.config.services.toolsUrl),
    async run(input, ctx) {
        const urls = [...new Set((Array.isArray(input && input.urls) ? input.urls : []).map((u) => String(u || '').trim()).filter(Boolean))].slice(0, MAX_PAGES);
        if (!urls.length) return { error: 'Give the pages to read ({ urls: [...] }).' };
        const svc = ctx.service || serviceFor(ctx);   // ctx.service: a test's reader
        const settled = await Promise.allSettled(urls.map((url) => svc.runTool('read', { url, max_chars: PER_PAGE }, { signal: ctx.signal })));
        const pages = settled.map((r, i) => {
            const url = urls[i];
            if (r.status === 'rejected') return { url, error: (r.reason && r.reason.message) || 'it could not be read' };
            const d = r.value || {};
            if (d.error) return { url, error: typeof d.error === 'string' ? d.error : (d.error.detail || d.error.title || 'it could not be read') };
            const text = String(d.text || d.content || d.markdown || '').slice(0, PER_PAGE);
            return { url, title: d.title || null, text };
        });
        const ok = pages.filter((p) => !p.error);
        return {
            text: json({ read: ok.length, failed: pages.length - ok.length, pages }),
            data: { pages },
            sources: ok.map((p) => ({ url: p.url, title: p.title || p.url })),
        };
    },
};

'use strict';

/**
 * Crawl artifacts for openvibe.actor, built with openvibe-shared/seo: robots.txt, sitemap.xml, llms.txt and
 * llms-full.txt, and the home page's JSON-LD. The public pages are for search engines and AI crawlers; tasks, sign-in
 * and the API are not.
 */
const fs = require('fs');
const path = require('path');
const seo = require('openvibe-shared/seo');
const { twinUrl } = require('openvibe-shared/agent-layer');
const cache = require('openvibe-shared/cache-policy');
const { asyncRouter } = require('./router');

const SITE_NAME = 'OpenVibe.Actor';
const DESCRIPTION = 'OpenVibe.Actor is your own AI that works for you: it finds work and drafts applications, writes and prices a gig, grows your channel, briefs you every morning, watches for deals and builds things. You watch it work from any OpenVibe page, it asks before it spends, posts or sends, and it runs on the model you pick, your own keys included.';
const DISALLOW = ['/auth/', '/api/', '/tasks'];

const PAGE_TEXT = {
    '/': ['OpenVibe.Actor home', 'Your own AI that works for you while you watch: jobs, a gig, your channel, a morning brief, deals and builds. It asks before it acts and runs on the model you pick.'],
    '/agents': ['The agents', 'Every agent system Actor routes to, with what it can do, its trust class, its price per million tokens and whether it works now; the modes and the check.'],
    '/docs': ['The Actor API', 'Create a task, watch it over server-sent events, read the result with its cost and explanation, cancel; list the agents and dry-run the router.'],
    '/updates': ['What shipped on OpenVibe.Actor', 'This site\'s update log, from the network changelog feed.'],
};

function dayOf(ts) {
    const m = String(ts == null ? '' : ts).match(/^(\d{4}-\d{2}-\d{2})/);
    return m ? m[1] : null;
}
function siteUpdated() {
    try { return dayOf(JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'STATUS.json'), 'utf8')).updated); } catch { return null; }
}

function homeJsonLd(config) {
    const site = String(config.baseUrl).replace(/\/+$/, '');
    return [
        seo.jsonLd.website({ name: SITE_NAME, url: site, description: DESCRIPTION }),
        seo.jsonLd.softwareApp({ name: SITE_NAME, url: site, description: DESCRIPTION, category: 'BusinessApplication', keywords: 'personal ai agent, ai that works for you, ai agent that makes money, ai job application assistant, autonomous ai agent, ai assistant that does tasks, computer use agent, browser agent, cheap ai agent, open source ai agent, self-hosted ai agent, agent api' }),
        seo.jsonLd.webPage({ name: SITE_NAME, url: `${site}/`, description: DESCRIPTION, siteUrl: site }),
    ];
}

const publicPages = () => [
    { path: '/', changefreq: 'weekly', priority: 1.0 },
    { path: '/agents', changefreq: 'weekly', priority: 0.9 },
    { path: '/docs', changefreq: 'weekly', priority: 0.8 },
    { path: '/updates', changefreq: 'daily', priority: 0.5 },
];

/**
 * llms.txt: the shared kit's llmsTxt, with one thing it cannot say. A POST-only endpoint is not a
 * page to fetch — a link to it is a URL that answers 404 to a GET, and a language model that
 * follows it gets nothing. So a section may carry notes: plain lines that describe such an
 * endpoint (POST /api/v1/route — ...) instead of linking it. Every real GET link stays a link.
 */
// AGT-5: each of the site's own pages is linked at its Markdown twin (/agents → /agents.md, / → /index.md); a file, an
// /api/ or /.well-known/ path and another site's link keep their URL, as openvibe-shared's seo.llmsTxt markdown mode
// does. `optional` is llmstxt.org's "## Optional", last.
function twinOf(url, base) {
    let u;
    try { u = new URL(url); } catch { return url; }
    if (!base || u.origin !== new URL(base).origin || /^\/(api|\.well-known)(\/|$)/.test(u.pathname) || /\.[a-z0-9]{1,8}$/i.test(u.pathname.split('/').pop())) return url;
    return twinUrl(url);
}

function llmsTxt({ name, summary, details, sections = [], optional = [], base = null }) {
    const out = [`# ${name}`, '', `> ${String(summary || '').replace(/\s+/g, ' ').trim()}`, ''];
    if (details) out.push(String(details).trim(), '');
    for (const sec of [...sections, ...(optional.length ? [{ title: 'Optional', links: optional }] : [])]) {
        if (!sec) continue;
        const links = (sec.links || []).map((l) => '- [' + l.title + '](' + twinOf(l.url, base) + ')' + (l.note ? ': ' + String(l.note).replace(/\s+/g, ' ').trim() : ''));
        const notes = (sec.notes || []).map((n) => String(n).replace(/\s+/g, ' ').trim());
        if (!links.length && !notes.length) continue;
        out.push('## ' + sec.title, '');
        if (links.length) out.push(...links, '');
        if (notes.length) out.push(...notes, '');
    }
    return out.join('\n');
}

function createDiscoveryRoutes(ctx) {
    const { config } = ctx;
    const r = asyncRouter();
    const site = String(config.baseUrl).replace(/\/+$/, '');
    const abs = (p) => `${site}${p}`;
    const TEXT = cache.htmlHeaders({ maxAge: 3600 });

    r.get('/robots.txt', (_req, res) => {
        res.type('text/plain').set('Cache-Control', TEXT).send(
            '# openvibe.actor: the public pages are for search and AI crawlers; tasks, sign-in and the API are not.\n'
            + '# Agent manifest: https://openvibe.actor/.well-known/agent.json; the public pages have a .md twin.\n'
            + seo.robotsTxt({ sitemaps: [abs('/sitemap.xml')], disallow: DISALLOW }));
    });

    r.get('/llms.txt', (_req, res) => {
        res.type('text/plain').set('Cache-Control', TEXT).send(llmsTxt({
            name: SITE_NAME,
            base: site,
            summary: 'OpenVibe.Actor: an AI agent router and OpenVibe\'s own agent. A task in plain words goes to the best agent system for it, by what the task needs and the caller\'s mode (cheapest, balanced, best, fastest, private); a second model family checks the answer; the task records its cost to a fraction of a cent and why that agent was picked.',
            details: 'Agents today: the OpenVibe runtime (a DeepSeek model acting through OpenVibe.Search and OpenVibe.Tools: DNS, mail records, certificates, headers, WHOIS and more), OpenAI\'s web agent (live web search with sources), and an open model on OpenVibe\'s own server for private mode. Coding goes to OpenVibe.Codes. Every page is server-rendered and readable without JavaScript. The API: POST /api/v1/tasks, GET /api/v1/tasks/:id, GET /api/v1/tasks/:id/events (server-sent events), POST /api/v1/tasks/:id/cancel, GET /api/v1/agent-systems (the public catalog; GET /api/v1/agents is a signed-in person\'s own contacts, actor.agent-list@1, with GET /api/v1/agents/presets) and POST /api/v1/route (public dry run). A person creates, reads, changes and deletes contacts with POST /api/v1/agents and GET/PATCH/DELETE /api/v1/agents/:id and sets an approval level with PUT /api/v1/agents/:id/level (actor.level-change@1). Tasks are platform.task@1 in openvibe-contracts.',
            sections: [
                { title: 'Start here', links: [
                    { title: 'Give Actor a task', url: abs('/'), note: 'what Actor is, how a task finds its agent, what works today' },
                    { title: 'The agents', url: abs('/agents'), note: 'every agent system with its price, trust class and availability; the modes; the check' },
                    { title: 'The API', url: abs('/docs'), note: 'tasks, the live stream, errors, limits' },
                    { title: 'What shipped on OpenVibe.Actor', url: abs('/updates') },
                ] },
                { title: 'Machine-readable', links: [
                    { title: 'The agents (JSON, no token)', url: abs('/api/v1/agents'), note: 'actor.agent-list-result@2' },
                    { title: 'The agent systems (JSON)', url: abs('/api/v1/agent-systems'), note: 'actor.agent-list-result@2, also for a signed-in caller' },
                    { title: 'The agent-contact presets (JSON)', url: abs('/api/v1/agents/presets'), note: 'Researcher, Inbox, Studio editor, Party host' },
                    { title: 'The agent manifest (JSON)', url: abs('/.well-known/agent.json'), note: 'what this site tells an agent about itself' },
                    { title: 'The free tier (JSON)', url: abs('/limits.json') },
                ], notes: [
                    'POST /api/v1/route — dry-run the router: send { task, mode? } and get which agent would take it and why (platform.placement-result@1). It answers POST only, so there is no page here to fetch; the API is described at /docs.',
                    'GET /api/v1/agents — with a person\'s token this is their own contacts (actor.agent-list@1, Vibe first); no token answers the public catalog (actor.agent-list-result@2).',
                    'POST /api/v1/agents, GET/PATCH/DELETE /api/v1/agents/:id and PUT /api/v1/agents/:id/level — a signed-in person\'s contacts and approval level (actor.agent@1, actor.level-change@1). They answer only to the person, so there is no page to fetch; the shapes are described at /docs.',
                ] },
            ],
            optional: [
                { title: 'Sitemap', url: abs('/sitemap.xml') },
                { title: 'Full text for language models', url: abs('/llms-full.txt') },
                { title: 'Release metadata (JSON)', url: abs('/release.json') },
                { title: 'OpenVibe.Codes', url: 'https://openvibe.codes', note: 'the coding-agent harness Actor sends coding work to' },
                { title: 'OpenVibe.Tools', url: 'https://openvibe.tools', note: 'the tools the OpenVibe runtime uses' },
                { title: 'OpenVibe.Services', url: 'https://openvibe.services', note: 'apps, keys and actor.task.* grants' },
            ],
        }));
    });

    r.get('/llms-full.txt', (_req, res) => {
        const pages = publicPages().map((p) => ({ url: p.path, title: PAGE_TEXT[p.path][0], text: PAGE_TEXT[p.path][1] }));
        res.type('text/plain').set('Cache-Control', TEXT).send(seo.llmsFull({
            site: SITE_NAME,
            summary: 'Every public page of OpenVibe.Actor, one line each.',
            base: site,
            maxBytes: 64 * 1024,
            sections: [{ title: 'Pages', pages }],
        }));
    });

    r.get('/sitemap.xml', (_req, res) => {
        const lastmod = siteUpdated();
        const urls = publicPages().map((e) => ({ loc: abs(e.path), ...(lastmod ? { lastmod } : {}), changefreq: e.changefreq, priority: e.priority }));
        res.type('application/xml').set('Cache-Control', TEXT).send(seo.sitemapXml(urls));
    });

    return r;
}

module.exports = { createDiscoveryRoutes, homeJsonLd, publicPages, DESCRIPTION, SITE_NAME };

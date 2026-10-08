'use strict';

/**
 * Crawl artifacts for openvibe.actor, built with openvibe-shared/seo: robots.txt, sitemap.xml, llms.txt and
 * llms-full.txt, and the home page's JSON-LD. The public pages are for search engines and AI crawlers; tasks, sign-in
 * and the API are not.
 */
const fs = require('fs');
const path = require('path');
const seo = require('openvibe-shared/seo');
const cache = require('openvibe-shared/cache-policy');
const { asyncRouter } = require('./router');

const SITE_NAME = 'OpenVibe.Actor';
const DESCRIPTION = 'OpenVibe.Actor is an AI agent router and OpenVibe\'s own agent: give it a task in plain words and it sends it to the best agent for it — OpenVibe\'s runtime acting through OpenVibe services, another platform\'s agent such as OpenAI\'s web agent, or an open model on OpenVibe hardware for private tasks — checks the answer with a second model and shows the cost and why. Like OpenRouter, for agents.';
const DISALLOW = ['/auth/', '/api/', '/tasks'];

const PAGE_TEXT = {
    '/': ['OpenVibe.Actor home', 'Give a task in plain words; Actor picks the agent, checks the answer and shows the cost and why. What it can do today and what comes next.'],
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
        seo.jsonLd.softwareApp({ name: SITE_NAME, url: site, description: DESCRIPTION, category: 'BusinessApplication', keywords: 'ai agent, ai agent router, openrouter for agents, autonomous ai agent, ai assistant that does tasks, computer use agent, browser agent, cheap ai agent, open source ai agent, self-hosted ai agent, agent api' }),
        seo.jsonLd.webPage({ name: SITE_NAME, url: `${site}/`, description: DESCRIPTION, siteUrl: site }),
    ];
}

const publicPages = () => [
    { path: '/', changefreq: 'weekly', priority: 1.0 },
    { path: '/agents', changefreq: 'weekly', priority: 0.9 },
    { path: '/docs', changefreq: 'weekly', priority: 0.8 },
    { path: '/updates', changefreq: 'daily', priority: 0.5 },
];

function createDiscoveryRoutes(ctx) {
    const { config } = ctx;
    const r = asyncRouter();
    const site = String(config.baseUrl).replace(/\/+$/, '');
    const abs = (p) => `${site}${p}`;
    const TEXT = cache.htmlHeaders({ maxAge: 3600 });

    r.get('/robots.txt', (_req, res) => {
        res.type('text/plain').set('Cache-Control', TEXT).send(
            '# openvibe.actor: the public pages are for search and AI crawlers; tasks, sign-in and the API are not.\n'
            + seo.robotsTxt({ sitemaps: [abs('/sitemap.xml')], disallow: DISALLOW }));
    });

    r.get('/llms.txt', (_req, res) => {
        res.type('text/plain').set('Cache-Control', TEXT).send(seo.llmsTxt({
            name: SITE_NAME,
            summary: 'OpenVibe.Actor: an AI agent router and OpenVibe\'s own agent. A task in plain words goes to the best agent system for it, by what the task needs and the caller\'s mode (cheapest, balanced, best, fastest, private); a second model family checks the answer; the task records its cost to a fraction of a cent and why that agent was picked.',
            details: 'Agents today: the OpenVibe runtime (a DeepSeek model acting through OpenVibe.Search and OpenVibe.Tools: DNS, mail records, certificates, headers, WHOIS and more), OpenAI\'s web agent (live web search with sources), and an open model on OpenVibe\'s own server for private mode. Coding goes to OpenVibe.Codes. Every page is server-rendered and readable without JavaScript. The API: POST /api/v1/tasks, GET /api/v1/tasks/:id, GET /api/v1/tasks/:id/events (server-sent events), POST /api/v1/tasks/:id/cancel, GET /api/v1/agents and POST /api/v1/route (public dry run). Tasks are platform.task@1 in openvibe-contracts.',
            sections: [
                { title: 'Start here', links: [
                    { title: 'Give Actor a task', url: abs('/'), note: 'what Actor is, how a task finds its agent, what works today' },
                    { title: 'The agents', url: abs('/agents'), note: 'every agent system with its price, trust class and availability; the modes; the check' },
                    { title: 'The API', url: abs('/docs'), note: 'tasks, the live stream, errors, limits' },
                    { title: 'What shipped on OpenVibe.Actor', url: abs('/updates') },
                ] },
                { title: 'Machine-readable', links: [
                    { title: 'The agents (JSON)', url: abs('/api/v1/agents'), note: 'actor.agent-list-result@1' },
                    { title: 'Dry-run the router', url: abs('/api/v1/route'), note: 'POST { task, mode? } → which agent and why (platform.placement-result@1)' },
                    { title: 'The free tier (JSON)', url: abs('/limits.json') },
                    { title: 'Sitemap', url: abs('/sitemap.xml') },
                    { title: 'Full text for language models', url: abs('/llms-full.txt') },
                    { title: 'Release metadata (JSON)', url: abs('/release.json') },
                ] },
                { title: 'Elsewhere', links: [
                    { title: 'OpenVibe.Codes', url: 'https://openvibe.codes', note: 'the coding-agent harness Actor sends coding work to' },
                    { title: 'OpenVibe.Tools', url: 'https://openvibe.tools', note: 'the tools the OpenVibe runtime uses' },
                    { title: 'OpenVibe.Services', url: 'https://openvibe.services', note: 'apps, keys and actor.task.* grants' },
                ] },
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

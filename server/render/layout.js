'use strict';

/**
 * Page shell. Every page is server-rendered through openvibe-shared/shell and is complete without JavaScript:
 *   - <head>: title, description, canonical, robots (pages are noindex unless they say otherwise), Open Graph/Twitter,
 *     JSON-LD (openvibe-shared/seo), plus Actor's extras: the shared app icon, stylesheets, the boost marker
 *   - the OpenVibe Frame: theme-loader, web-runtime, navbar and footer scripts (the shell boots the
 *     navbar; the footer is initialised below), a <noscript> navigation bar and the server-rendered footer
 *   - Actor's own script only where a page offers an in-browser convenience (a task's live progress, copy buttons)
 */
const crypto = require('crypto');
const ovServe = require('openvibe-shared/serve');
const fs = require('fs');
const path = require('path');
const appIcon = require('openvibe-shared/app-icon');
const frame = require('openvibe-shared/frame');
const shell = require('openvibe-shared/shell');
const cache = require('openvibe-shared/cache-policy');
const { html, raw, esc } = require('./html');

const NETWORK_URL = 'https://openvibe.network';
const SITE_NAME = 'OpenVibe.Actor';
const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');
const NAV = [
    { label: 'Your tasks', href: '/tasks' },
    { label: 'Agents', href: '/agents' },
    { label: 'API', href: '/docs' },
];

const hashes = new Map();
function assetVersion(rel) {
    if (hashes.has(rel)) return hashes.get(rel);
    let v = 'dev';
    try { v = crypto.createHash('sha256').update(fs.readFileSync(path.join(PUBLIC_DIR, rel))).digest('hex').slice(0, 10); } catch { /* missing asset */ }
    hashes.set(rel, v);
    return v;
}
const asset = (rel) => `/${rel}?v=${assetVersion(rel)}`;

// The deployed release (app.js sets it from openvibe-shared/release): openvibe-shared/boost swaps a page in place only
// between pages of the same release, and does a normal load across a deploy.
let RELEASE = 'dev';
function setRelease(id) { if (id) RELEASE = String(id); }

/**
 * o: title, description, body (html), viewer, config, path, index (default false), scripts [rel],
 *    crumbs [{ label, href }], jsonLd [nodes] (serialised by openvibe-shared/seo), styles [openvibe-shared stylesheet names]
 */
function renderPage(o) {
    const viewer = o.viewer || { kind: 'anonymous' };
    const signedIn = viewer.kind === 'user';
    const pathNow = o.path || '/';
    const loginNext = encodeURIComponent(pathNow);
    const canonical = `${o.config.baseUrl}${pathNow.split('?')[0]}`;
    const nav = {
        service: 'actor',
        apiBase: NETWORK_URL,
        links: NAV.map((l) => ({ label: l.label, href: l.href, active: pathNow === l.href || pathNow.startsWith(`${l.href}/`) })),
        history: { type: 'page', title: o.title || SITE_NAME },
        silentLogin: `${o.config.baseUrl}/auth/login?silent=1&next={url}`,
        sessionUrl: '/auth/me',
        loginUrl: '/auth/login?next={path}',           // filled from the current page (boost moves between pages)
        logoutUrl: '/auth/logout?next={path}',   // Sign out in the shared navbar ends this site's session too
        notificationsRealtime: true,             // the bell hears new notifications over OpenVibe.Events (Shared 1.22.0)
    };
    // This site's own account links live in the shared navbar's account menu (the page's account
    // bar below is only for visitors without JavaScript).
    if (signedIn) nav.menu = { before: [{ label: 'Your tasks', href: '/tasks', icon: 'fa-list-check' }] };
    const footer = { service: 'actor', variant: 'full', mount: '#ov-footer', brandName: SITE_NAME, updates: '/updates' };
    const account = signedIn
        ? html`Signed in as <strong>${viewer.displayName || viewer.username || 'you'}</strong> · <a href="/auth/logout?next=${loginNext}">Sign out</a>`
        : html`<a href="/auth/login?next=${loginNext}">Sign in with OpenVibe</a>`;
    const crumbs = (o.crumbs || []).length
        ? html`<nav class="crumbs" aria-label="Breadcrumbs">${o.crumbs.map((c, i) => html`${i ? ' / ' : ''}${c.href ? html`<a href="${c.href}">${c.label}</a>` : c.label}`)}</nav>`
        : '';
    const scripts = (o.scripts || []).map((rel) => html`<script src="${asset(rel)}" defer></script>`);
    return shell.page({
        name: SITE_NAME,
        lang: 'en',
        title: o.title || `${SITE_NAME}: your agent for everything`,
        titleSuffix: o.title ? ` · ${SITE_NAME}` : '',
        siteName: SITE_NAME,
        description: o.description || 'Give a task in plain words: Actor sends it to the best agent for it, OpenVibe\'s own or another platform\'s, checks the result and shows the cost and why. Like OpenRouter, for agents.',
        canonical,
        robots: o.index ? 'index, follow' : 'noindex, nofollow',
        jsonLd: (o.jsonLd || []).filter(Boolean),
        home: '/',
        navLinks: NAV,
        navbar: nav,
        footer,
        head: `<meta name="referrer" content="${o.noReferrer ? 'no-referrer' : 'strict-origin-when-cross-origin'}">
${appIcon.headTags({ site: 'actor' })}
<link rel="stylesheet" href="${asset('css/actor.css')}">
${(o.styles || []).map((name) => `<link rel="stylesheet" href="${esc(ovServe.url(name))}">`).join('\n')}
${render(scripts)}
<meta name="ov-boost" content="actor@${esc(RELEASE)}">
<script src="${ovServe.url('boost.js')}" data-main="#main" defer></script>`,
        body: `<a class="skip" href="#main">Skip to content</a>
<div id="navbar-mount"></div>
<noscript><div class="account-bar" role="navigation" aria-label="Account">${render(account)}</div></noscript>
<main id="main" class="page">
${render(crumbs)}
${render(o.body)}
${o.path === '/' ? frame.shipped({ service: 'actor', title: `Recently shipped on ${SITE_NAME}` }) : ''}
</main>
<script>
window.__OV_PAGE = ${JSON.stringify({ navbar: nav, footer }).replace(/</g, '\\u003c')};
document.addEventListener('DOMContentLoaded', function () {
  try { if (window.OpenVibeFooter) OpenVibeFooter.init(window.__OV_PAGE.footer); } catch (e) { /* the Frame is optional */ }
});
</script>`,
    });
}

function render(v) { return require('./html').render(v); }

/** Send a page; a page rendered for a signed-in person is private and never cached. */
function send(res, status, o) {
    // A page rendered for a signed-in person names them in the account bar: never shared caches.
    const personal = o.viewer && o.viewer.kind === 'user';
    if (!res.get('Cache-Control')) res.set('Cache-Control', !personal && o.cache ? o.cache : cache.htmlHeaders({ private: true }));
    res.set('Vary', 'Cookie');
    res.status(status).type('html').send(renderPage(o));
}

module.exports = { renderPage, send, asset, assetVersion, setRelease, SITE_NAME, NETWORK_URL, NAV, raw, html };

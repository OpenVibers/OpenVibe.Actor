'use strict';
/**
 * openvibe.expert from this process (plan §D item 6; the plan: "openvibe.expert is the front door … the store and the
 * runs stay in Actor"). When a request's host is openvibe.expert:
 *
 *   /                      the gallery            (Actor's /experts)
 *   /new, /mine            make one, your own     (/experts/new, /experts/mine)
 *   /<bp_id>[/…]           an Expert, its install (/experts/<bp_id>[/…])
 *   /experts/…             as on Actor (the pages' own links)
 *   /auth/*, /api/*, files the same as on Actor, with openvibe.expert's own sign-in (http: the caller picks the session)
 *   anything else          openvibe.actor, the same path (tasks, chat and settings live there)
 *
 * It only rewrites the path; the pages, the store and the rules are Actor's. Off (no-op) without the expert client's
 * secret: openvibe.expert then stays the parked redirect.
 */
const PASS = /^\/(?:auth|api|css|js|shared|assets|img|images|fonts|faces|static|\.well-known)(?:\/|$)|^\/(?:robots\.txt|sitemap\.xml|llms(?:-full)?\.txt|favicon\.[a-z]+|manifest\.(?:json|webmanifest)|release\.json)$/;
const BP = /^\/(bp_[a-z0-9_]{1,80})(\/.*)?$/;

function expertHostOf(config) {
    const e = config && config.expert;
    if (!e || !e.clientSecret || !e.baseUrl) return null;
    try { return new URL(e.baseUrl).hostname.toLowerCase(); } catch { return null; }
}

/** Is this request for openvibe.expert? (nginx passes the Host; www. is the same site). */
function isExpertRequest(req, host) {
    if (!host) return false;
    const h = String(req.hostname || req.headers.host || '').toLowerCase().replace(/:\d+$/, '').replace(/^www\./, '');
    return h === host;
}

/** Actor's /experts address → the same page's address on openvibe.expert. */
function expertPathOf(p) {
    if (p === '/experts' || p === '/experts/') return '/';
    const m = /^\/experts\/(.+)$/.exec(p);
    return m ? `/${m[1]}` : null;
}

function createExpertHost({ config }) {
    const host = expertHostOf(config);
    const actor = String(config.baseUrl || 'https://openvibe.actor').replace(/\/+$/, '');
    const base = String(config.expert.baseUrl).replace(/\/+$/, '');
    return function expertHost(req, res, next) {
        if (!isExpertRequest(req, host)) {
            // On openvibe.actor the gallery's home is openvibe.expert: its pages name that address as canonical.
            const there = req.method === 'GET' ? expertPathOf(req.path) : null;
            if (there && !/^\/(?:new|mine)$/.test(there) && !/\/(?:edit|install)$/.test(there)) res.locals.canonicalUrl = `${base}${there}`;
            return next();
        }
        res.locals.site = { baseUrl: base, name: 'OpenVibe Expert' };
        const q = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
        const p = req.path;
        if (PASS.test(p) || p.startsWith('/experts')) return next();
        if (p === '/' || p === '') { req.url = `/experts${q}`; return next(); }
        if (p === '/new' || p === '/mine') { req.url = `/experts${p}${q}`; return next(); }
        const m = BP.exec(p);
        if (m) { req.url = `/experts/${m[1]}${m[2] || ''}${q}`; return next(); }
        if (/\.[a-z0-9]{2,5}$/i.test(p)) return next();   // a file the pages load
        return res.redirect(302, `${actor}${req.originalUrl}`);
    };
}

module.exports = { createExpertHost, expertHostOf, isExpertRequest, expertPathOf };

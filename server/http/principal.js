'use strict';

/**
 * Who is calling /api/v1 — req.principal:
 *
 *   { kind: 'user', requester: 'user:usr_…', project: null, viaSession }    a person: their Network token as a Bearer,
 *                                                                           or this site's session cookie
 *   { kind: 'app', requester: 'app:app_…' | 'agent:agt_…' | 'service:x', project: 'prj_…' | null, claims }
 *                                                                           a Network app, agent or service token for
 *                                                                           audience openvibe.actor; each route names
 *                                                                           ONE capability it needs (actor.task.*)
 *   { kind: 'anonymous' }
 *
 * A request that presents a token is judged on that token alone: a bad one is refused, never downgraded to the
 * session or to anonymous. A write made with the session cookie must come from this site (Sec-Fetch-Site
 * same-origin, or an Origin equal to ours): another site cannot make a signed-in visitor spend their allowance.
 * A person acting for themself needs no capability; an app, agent or service needs the one the route names.
 */
const { serviceAuth, capabilities, http, ids } = require('openvibe-contracts');

const PRINCIPAL_SUB = /^(svc|app|mod|agent):/;
const PROJECT_RE = /^prj_[0-9A-HJKMNP-TV-Z]{26}$/;
const CAPABILITIES = ['actor.task.create', 'actor.task.read', 'actor.task.list', 'actor.agent.read'];

function decodePayload(token) {
    const parts = String(token || '').split('.');
    if (parts.length !== 3) return null;
    try { return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')); } catch { return null; }
}

function requesterOfSub(sub) {
    if (sub.startsWith('svc:')) return `service:${sub.slice(4)}`;
    return sub;   // app:app_…, agent:agt_…, mod:mod_…
}

function sameOrigin(req, baseUrl) {
    const site = String(req.get('sec-fetch-site') || '');
    if (site) return site === 'same-origin';
    const origin = req.get('origin');
    if (origin) return origin === baseUrl || origin === `${req.protocol}://${req.get('host')}`;
    return false;
}

function createPrincipal({ config, keys }) {
    async function resolve(req) {
        const header = String(req.headers.authorization || '');
        if (header.startsWith('Bearer ')) {
            const token = header.slice(7).trim();
            const payload = decodePayload(token);
            if (payload && typeof payload.sub === 'string' && PRINCIPAL_SUB.test(payload.sub)) {
                const publicKey = await keys.pemForToken(token);
                if (!publicKey) return { error: [503, 'identity.unavailable', 'the Network signing key is not loaded yet'] };
                const r = serviceAuth.verifyServiceToken(token, { publicKey, issuer: config.networkIssuer, audience: config.audience });
                if (!r.ok) return { error: [401, r.code || 'token.invalid', r.reason || 'the token does not verify'] };
                const project = typeof r.claims.project_id === 'string' && PROJECT_RE.test(r.claims.project_id) ? r.claims.project_id : null;
                return { principal: { kind: 'app', requester: requesterOfSub(r.claims.sub), project, claims: r.claims } };
            }
            // A person's own Network token (the same kind this site's session holds).
            const v = await keys.verifyUser(token, { issuer: config.networkIssuer, audience: config.oauth.sessionAudience });
            if (!v.ok) return { error: [401, v.expired ? 'token.expired' : 'token.invalid', v.reason] };
            if (v.claims.typ === 'fedcm' || v.claims.actor_type !== undefined) return { error: [401, 'token.invalid', 'not a person\'s token'] };
            if (!ids.isSubjectId('user', v.claims.subject_id)) return { error: [403, 'identity.no_subject', 'this account has no canonical subject yet; sign in again'] };
            return { principal: { kind: 'user', requester: `user:${v.claims.subject_id}`, project: null, viaSession: false } };
        }
        const viewer = req.viewer;
        if (viewer && viewer.kind === 'user' && ids.isSubjectId('user', viewer.subject)) {
            return { principal: { kind: 'user', requester: `user:${viewer.subject}`, project: null, viaSession: true } };
        }
        return { principal: { kind: 'anonymous' } };
    }

    async function middleware(req, res, next) {
        const r = await resolve(req);
        if (r.error) return http.sendProblem(res, r.error[0], r.error[1], { detail: r.error[2], ctx: req.ov });
        req.principal = r.principal;
        return next();
    }

    /** One route's guard: a person needs nothing more (writes by cookie must be same-origin); an app the capability. */
    function require_(cap) {
        if (!CAPABILITIES.includes(cap)) throw new Error(`requireCapability(${cap}): not one of Actor's capabilities`);
        return function guard(req, res, next) {
            const p = req.principal;
            if (p.kind === 'anonymous') return http.sendProblem(res, 401, 'token.required', { detail: 'Sign in at openvibe.actor, or send a Network token (a person\'s, or an app\'s with this capability for openvibe.actor).', ctx: req.ov });
            if (p.kind === 'user') {
                if (p.viaSession && req.method !== 'GET' && !sameOrigin(req, config.baseUrl)) return http.sendProblem(res, 403, 'request.cross_site', { detail: 'A signed-in request that changes something must come from openvibe.actor itself.', ctx: req.ov });
                return next();
            }
            const decision = capabilities.check(p.claims, cap);
            if (decision.allowed) return next();
            return http.sendProblem(res, 403, decision.code || 'capability.denied', { detail: decision.reason || `${cap} not granted`, ctx: req.ov });
        };
    }

    return { middleware, resolve, requireCapability: require_ };
}

module.exports = { createPrincipal, CAPABILITIES, decodePayload, sameOrigin };

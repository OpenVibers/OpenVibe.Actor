'use strict';
/**
 * An in-process stand-in for OpenVibe.Network (sign-in, JWKS, tokens), with a real RS256 key pair. Much of it served
 * the developer console that moved to OpenVibe.Services; what Codes' tests use is sign-in and the JWKS.
 *
 *   Network   JWKS; /oauth/token (authorization_code + PKCE S256 for client `actor`, refresh_token,
 *             client_credentials for `actor` and for developer apps with Network's app rules:
 *             hashed secrets, sandbox audiences, cap = approved grants ∩ allowance for the audience);
 *             /oauth/revoke; /.well-known/openvibe; /api/v1/registry/services; and /api/v1/projects…
 *             with the same shapes, roles and problem codes as OpenVibe.Network's developer API
 *             (simplified: no audit paging, no rate limits). setDown(true) makes it refuse
 *             connections-equivalent (503) and drop() closes the socket.
 *             GET /api/v1/projects/:project/usage (owner/admin or staff; days 1-90, env all|sandbox|production)
 *             answers what setUsage() stored for the project, or an empty network.project-usage-result@1.
 *             POST /api/v1/projects/:project/export-tokens as Network mints them (owner/admin only,
 *             sub app:app_<project ULID>, read-only caps, purpose export), recorded in exportTokens.
 * Every request is recorded in `.requests` so tests can assert what was (not) called.
 */
const http = require('http');
const crypto = require('crypto');
const { serviceAuth, ids, capabilities } = require('openvibe-contracts');

function listen(handler) {
    return new Promise((resolve) => {
        const sockets = new Set();
        const server = http.createServer((req, res) => {
            const chunks = [];
            req.on('data', (c) => chunks.push(c));
            req.on('end', () => {
                const raw = Buffer.concat(chunks);
                const json = (status, obj, headers = {}) => { res.writeHead(status, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(obj)); };
                Promise.resolve(handler(req, raw, json, res)).catch((err) => { json(500, { error: String(err && err.message) }); });
            });
        });
        server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
        server.listen(0, '127.0.0.1', () => resolve({
            server, url: `http://127.0.0.1:${server.address().port}`,
            close: () => new Promise((r) => { for (const s of sockets) s.destroy(); server.close(r); }),
        }));
    });
}

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function signJwt(claims, privateKey) {
    const input = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64(claims)}`;
    return `${input}.${crypto.sign('RSA-SHA256', Buffer.from(input), privateKey).toString('base64url')}`;
}
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const RANK = { viewer: 1, developer: 2, admin: 3, owner: 4 };

async function startNetwork({ sandboxAudiences = ['openvibe.events', 'openvibe.media'] } = {}) {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const publicPem = publicKey.export({ type: 'spki', format: 'pem' });
    const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' });
    const st = {
        users: new Map(), byUsername: new Map(), projects: new Map(), members: new Map(), apps: new Map(), creds: new Map(),
        grants: new Map(), quotas: new Map(), usage: new Map(), audit: [], codes: new Map(), refresh: new Map(),
        catalog: null, down: false, requests: [], tokenRequests: [], exportTokens: [], exportTtl: 300,
    };
    let issuer = null;
    let nextUserId = 1;

    const problem = (json, status, code, detail) => json(status, { type: `https://openvibe.network/problems/${code}`, title: 'Error', status, code, detail, error: detail, request_id: `req_${crypto.randomBytes(6).toString('hex')}` }, { 'Content-Type': 'application/problem+json' });

    function addUser(username, { role = 'user' } = {}) {
        const u = { id: nextUserId++, subject: ids.newId('user'), username, display_name: username, role };
        st.users.set(u.id, u); st.byUsername.set(username, u);
        return u;
    }
    function userToken(u, { ttl = 3600, iat = null } = {}) {
        const now = iat != null ? iat : Math.floor(Date.now() / 1000);
        return signJwt({ iss: issuer, sub: u.id, subject_id: u.subject, username: u.username, display_name: u.display_name, role: u.role, aud: ['openvibe.network'], iat: now, exp: now + ttl }, privatePem);
    }
    function userFrom(req) {
        const h = String(req.headers.authorization || '');
        if (!h.startsWith('Bearer ')) return null;
        const parts = h.slice(7).split('.');
        if (parts.length !== 3) return null;
        const ok = crypto.verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), publicPem, Buffer.from(parts[2], 'base64url'));
        if (!ok) return null;
        const c = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
        if (c.exp * 1000 < Date.now()) return 'expired';
        return st.users.get(c.sub) || null;
    }

    // ── Projects model ──
    const roleOf = (p, u) => (st.members.get(p.id) || new Map()).get(u.subject) || null;
    const projectView = (p, role) => ({
        id: p.id, name: p.name, owner: { type: 'user', id: p.owner }, role: role || null, environment_policy: p.environment_policy,
        environments: p.environment_policy === 'sandbox' ? ['sandbox'] : ['sandbox', 'production'], allowance: [...p.allowance],
        created_at: p.created_at, archived_at: p.archived_at, counts: { members: (st.members.get(p.id) || new Map()).size, apps: [...st.apps.values()].filter((a) => a.project_id === p.id && !a.revoked_at).length },
    });
    const appView = (a) => ({
        id: a.id, subject: { type: 'app', id: a.id }, project_id: a.project_id, name: a.name, environment: a.environment, client_id: a.id,
        client_type: a.client_type, redirect_uris: a.redirect_uris, created_at: a.created_at, revoked_at: a.revoked_at,
        grants: [...st.grants.values()].filter((g) => g.app_id === a.id && g.status === 'approved').map((g) => g.capability).sort(),
    });
    function newCredential(app) {
        const secret = `ovsec_${crypto.randomBytes(32).toString('base64url')}`;
        const c = { id: ids.newId('project').replace(/^prj_/, 'crd_'), app_id: app.id, hash: sha256(secret), hint: secret.slice(-4), created_at: new Date().toISOString(), expires_at: null, revoked_at: null };
        st.creds.set(c.id, c);
        return { c, secret };
    }
    const credState = (c) => (c.revoked_at ? 'revoked' : (c.expires_at ? (Date.parse(c.expires_at) < Date.now() ? 'expired' : 'expiring') : 'active'));
    const grantable = (id) => { const c = capabilities.get(id); return c && c.status === 'active' && ['public', 'partner'].includes(c.visibility); };
    const defaultCatalog = () => capabilities.manifests.filter((c) => grantable(c.id)).map((c) => ({ id: c.id, owner: c.owner, audience: `openvibe.${c.owner}`, visibility: c.visibility, description: c.description || '', resourceConstraints: c.resourceConstraints, quotaClass: c.quotaClass }));

    async function projectsApi(req, raw, json, u, parts, q) {
        let body = {};
        if (raw.length) { try { body = JSON.parse(raw.toString('utf8')); } catch { return problem(json, 400, 'request.malformed_json', 'body is not valid JSON'); } }
        const m = req.method;
        if (parts.length === 1 && parts[0] === 'catalog' && m === 'GET') return json(200, { capabilities: st.catalog || defaultCatalog(), rule: 'only active public capabilities' });
        if (!parts.length && m === 'GET') {
            const list = [...st.projects.values()].filter((p) => roleOf(p, u) || (q.get('all') === '1' && u.role === 'admin')).map((p) => projectView(p, roleOf(p, u)));
            return json(200, { projects: list });
        }
        if (!parts.length && m === 'POST') {
            const name = String(body.name || '').trim();
            if (!name || name.length > 80) return problem(json, 422, 'project.invalid', 'name must be 1-80 characters');
            const p = { id: ids.newId('project'), name, owner: u.subject, environment_policy: 'sandbox', allowance: [], created_at: new Date().toISOString(), archived_at: null };
            st.projects.set(p.id, p); st.members.set(p.id, new Map([[u.subject, 'owner']]));
            return json(201, projectView(p, 'owner'));
        }
        const p = st.projects.get(parts[0]);
        const role = p ? roleOf(p, u) : null;
        const staff = u.role === 'admin';
        if (!p || (!role && !staff)) return problem(json, 404, 'project.not_found', 'no such project');
        const need = (r) => { if (!role || RANK[role] < RANK[r]) { problem(json, 403, 'project.forbidden', `requires ${r} role`); return false; } return true; };
        const rest = parts.slice(1);
        if (!rest.length && m === 'GET') return json(200, projectView(p, role));
        if (rest[0] === 'archive' && m === 'POST') { if (role !== 'owner' && !staff) return problem(json, 403, 'project.forbidden', 'owner only'); p.archived_at = new Date().toISOString(); for (const a of st.apps.values()) if (a.project_id === p.id) a.revoked_at = a.revoked_at || p.archived_at; return json(200, projectView(p, role)); }
        if (rest[0] === 'members') {
            const mem = st.members.get(p.id);
            if (rest.length === 1 && m === 'GET') return json(200, { members: [...mem.entries()].map(([s, r]) => { const x = [...st.users.values()].find((y) => y.subject === s); return { subject: { type: 'user', id: s }, username: x && x.username, display_name: x && x.display_name, role: r, added_at: p.created_at }; }) });
            if (rest.length === 1 && m === 'POST') {
                if (!need('admin')) return;
                const target = st.byUsername.get(String(body.username || ''));
                if (!target) return problem(json, 404, 'member.user_not_found', 'no such account');
                if (!['admin', 'developer', 'viewer'].includes(body.role)) return problem(json, 422, 'member.invalid', 'role is one of admin, developer, viewer');
                if (body.role === 'admin' && role !== 'owner') return problem(json, 403, 'member.forbidden', `a ${role} cannot assign admin`);
                if (mem.has(target.subject)) return problem(json, 409, 'member.exists', 'already a member');
                mem.set(target.subject, body.role);
                return json(201, { subject: { type: 'user', id: target.subject }, role: body.role });
            }
            const s = rest[1];
            if (!mem.has(s)) return problem(json, 404, 'member.not_found', 'not a member');
            if (m === 'PATCH') { if (!need('admin')) return; mem.set(s, body.role); return json(200, { role: body.role }); }
            if (m === 'DELETE') { if (s !== u.subject && !need('admin')) return; if (mem.get(s) === 'owner') return problem(json, 403, 'member.forbidden', 'the owner cannot be removed'); mem.delete(s); res204(json); return; }
        }
        if (rest[0] === 'quotas' && m === 'GET') return json(200, { quotas: [...st.quotas.values()].filter((x) => x.project_id === p.id).map((x) => ({ capability: x.capability, limit: x.limit, window: x.window, unit: x.unit, enforced_by: `openvibe.${capabilities.get(x.capability).owner}`, updated_at: x.updated_at })), note: 'quotas are enforced by the service that owns each capability; Network records and exposes them' });
        if (rest[0] === 'usage' && m === 'GET') {
            if ((!role || RANK[role] < RANK.admin) && !staff) return problem(json, 403, 'project.forbidden', 'requires admin role');
            const days = q.get('days') || '30';
            const env = q.get('env') || 'all';
            if (!/^\d{1,3}$/.test(days) || Number(days) < 1 || Number(days) > 90) return problem(json, 422, 'usage.invalid', 'days is a whole number from 1 to 90');
            if (!['all', 'sandbox', 'production'].includes(env)) return problem(json, 422, 'usage.invalid', 'env is all, sandbox or production');
            const today = new Date().toISOString().slice(0, 10);
            const range = { days: Number(days), from: new Date(Date.now() - (Number(days) - 1) * 86400000).toISOString().slice(0, 10), to: today };
            const u = st.usage.get(p.id);
            if (u) return json(200, { ...u, project_id: p.id, env, range });
            return json(200, { project_id: p.id, env, range, generated_at: new Date().toISOString(), last_recorded_at: null, freshness: 'No usage has been recorded for this project yet.', totals: [], daily: [], quotas: [], errors: { total: 0, by_code: [], recent: [] } });
        }
        if (rest[0] === 'audit' && m === 'GET') { if (!role || RANK[role] < RANK.admin) { if (!staff) return problem(json, 403, 'project.forbidden', 'requires admin role'); } return json(200, { entries: st.audit.filter((e) => e.project_id === p.id).slice().reverse(), next_before: null }); }
        if (rest[0] === 'apps') {
            if (rest.length === 1 && m === 'GET') return json(200, { apps: [...st.apps.values()].filter((a) => a.project_id === p.id).map(appView) });
            if (rest.length === 1 && m === 'POST') {
                const env = String(body.environment || 'sandbox');
                if (!['sandbox', 'production'].includes(env)) return problem(json, 422, 'app.invalid', 'environment is sandbox or production');
                if (!need(env === 'production' ? 'admin' : 'developer')) return;
                if (env === 'production' && p.environment_policy === 'sandbox') return problem(json, 403, 'app.environment_not_allowed', 'this project may only have sandbox apps (staff enable production)');
                const type = String(body.type || 'confidential');
                const redirects = Array.isArray(body.redirect_uris) ? body.redirect_uris : [];
                for (const x of redirects) { try { const url = new URL(x); if (url.protocol !== 'https:' && url.hostname !== 'localhost') return problem(json, 422, 'app.invalid', 'redirect URIs must be https (http only for loopback)'); } catch { return problem(json, 422, 'app.invalid', `bad redirect URI ${x}`); } }
                if (type === 'public' && !redirects.length) return problem(json, 422, 'app.invalid', 'a public app needs at least one redirect URI');
                const a = { id: ids.newId('app'), project_id: p.id, name: String(body.name || '').trim() || 'app', environment: env, client_type: type, redirect_uris: redirects, created_at: new Date().toISOString(), revoked_at: null };
                st.apps.set(a.id, a);
                const out = appView(a);
                if (type === 'confidential') { const { c, secret } = newCredential(a); out.credential = { id: c.id, client_secret: secret, hint: c.hint, shown_once: true }; }
                st.audit.push({ id: st.audit.length + 1, project_id: p.id, at: new Date().toISOString(), actor: `user:${u.subject}`, action: 'app.created', target: `app:${a.id}`, detail: { name: a.name }, event_type: 'network.app.created' });
                return json(201, out);
            }
            const a = st.apps.get(rest[1]);
            if (!a || a.project_id !== p.id) return problem(json, 404, 'app.not_found', 'no such app');
            const manage = a.environment === 'production' ? 'admin' : 'developer';
            if (rest.length === 2 && m === 'GET') return json(200, appView(a));
            if (rest.length === 2 && m === 'PATCH') { if (!need(manage)) return; if (Array.isArray(body.redirect_uris)) a.redirect_uris = body.redirect_uris; return json(200, appView(a)); }
            if (rest.length === 2 && m === 'DELETE') { if (!staff && !need(manage)) return; a.revoked_at = new Date().toISOString(); return json(200, appView(a)); }
            if (rest[2] === 'credentials') {
                if (rest.length === 3 && m === 'GET') return json(200, { credentials: [...st.creds.values()].filter((c) => c.app_id === a.id).map((c) => ({ id: c.id, hint: c.hint, state: credState(c), created_at: c.created_at, expires_at: c.expires_at, revoked_at: c.revoked_at, last_used_at: null })) });
                if (rest[3] === 'rotate' && m === 'POST') {
                    if (!need(manage)) return;
                    if (a.revoked_at) return problem(json, 409, 'app.revoked', 'app is revoked');
                    if (a.client_type !== 'confidential') return problem(json, 409, 'credential.public_client', 'public apps have no client secret');
                    const overlap = body.overlap_seconds === undefined ? 86400 : body.overlap_seconds;
                    const until = new Date(Date.now() + overlap * 1000).toISOString();
                    const prev = [];
                    for (const c of st.creds.values()) if (c.app_id === a.id && !c.revoked_at) { c.expires_at = until; prev.push({ id: c.id, expires_at: until }); }
                    const { c, secret } = newCredential(a);
                    return json(201, { credential: { id: c.id, client_secret: secret, hint: c.hint, shown_once: true }, previous: prev });
                }
                if (rest[4] === 'revoke' && m === 'POST') { if (!need(manage)) return; const c = st.creds.get(rest[3]); if (!c || c.app_id !== a.id) return problem(json, 404, 'credential.not_found', 'no such credential'); c.revoked_at = new Date().toISOString(); return json(200, { id: c.id, state: 'revoked' }); }
            }
            if (rest[2] === 'grants') {
                const key = (cap) => `${a.id} ${cap}`;
                const gv = (g) => ({ app_id: g.app_id, capability: g.capability, audience: g.audience, status: g.status, requested_by: g.requested_by, requested_at: g.requested_at, decided_by: g.decided_by || null, decided_at: g.decided_at || null });
                if (rest.length === 3 && m === 'GET') return json(200, { grants: [...st.grants.values()].filter((g) => g.app_id === a.id).map(gv) });
                if (rest.length === 3 && m === 'POST') {
                    if (!need('developer')) return;
                    const cap = String(body.capability || '');
                    const c = capabilities.get(cap);
                    if (!c) return problem(json, 422, 'grant.unknown_capability', `no capability ${cap} in the catalog`);
                    if (!grantable(cap)) return problem(json, 403, 'grant.not_grantable', `${cap} is ${c.visibility}; only public capabilities are granted to apps`);
                    const auto = RANK[role] >= RANK.admin && p.allowance.includes(cap);
                    const g = { app_id: a.id, capability: cap, audience: `openvibe.${c.owner}`, status: auto ? 'approved' : 'requested', requested_by: `user:${u.subject}`, requested_at: new Date().toISOString(), decided_at: auto ? new Date().toISOString() : null };
                    st.grants.set(key(cap), g);
                    return json(201, gv(g));
                }
                const g = st.grants.get(key(rest[3]));
                if (!g) return problem(json, 404, 'grant.not_found', 'no such grant');
                if (m === 'DELETE') { if (!staff && !need('admin')) return; g.status = 'revoked'; return json(200, gv(g)); }
                if (rest[4] === 'approve') { if (!need('admin')) return; if (!p.allowance.includes(g.capability)) return problem(json, 403, 'grant.beyond_allowance', `${g.capability} is not in this project's allowance (staff set it)`); g.status = 'approved'; g.decided_at = new Date().toISOString(); return json(200, gv(g)); }
                if (rest[4] === 'deny') { if (!need('admin')) return; g.status = 'denied'; return json(200, gv(g)); }
            }
        }
        if (rest[0] === 'export-tokens' && rest.length === 1 && m === 'POST') {
            if (!role || RANK[role] < RANK.admin) return problem(json, 403, 'project.forbidden', 'requires admin role');
            const cap = { 'openvibe.media': ['media.object.list', 'media.object.read'], 'openvibe.events': ['events.app.read'] }[body.audience];
            if (!cap) return problem(json, 422, 'export.invalid_audience', 'audience is one of openvibe.media, openvibe.events');
            if (!['sandbox', 'production'].includes(body.env)) return problem(json, 422, 'export.invalid_env', 'env is one of sandbox, production');
            const now = Math.floor(Date.now() / 1000);
            const claims = {
                iss: issuer, sub: `app:app_${p.id.replace(/^prj_/, '')}`, actor_type: 'app', aud: [body.audience], cap, ns: [p.id, `app.${p.id}.*`],
                project_id: p.id, env: body.env, on_behalf_of: u.subject, purpose: 'export', iat: now, exp: now + st.exportTtl, jti: `tok_${crypto.randomBytes(8).toString('hex')}`,
            };
            const token = serviceAuth.signServiceToken(claims, privatePem);
            st.exportTokens.push({ project_id: p.id, audience: body.audience, env: body.env, subject: u.subject, jti: claims.jti, token });
            st.audit.push({ id: st.audit.length + 1, project_id: p.id, at: new Date().toISOString(), actor: `user:${u.subject}`, action: 'project.export_token_issued', target: claims.sub, detail: { audience: body.audience, env: body.env, cap, jti: claims.jti } });
            return json(201, { access_token: token, token_type: 'Bearer', expires_in: st.exportTtl, expires_at: new Date(claims.exp * 1000).toISOString(), scope: cap.join(' '), audience: body.audience, env: body.env, purpose: 'export', subject: claims.sub, project_id: p.id, jti: claims.jti });
        }
        return problem(json, 404, 'route.not_found', 'no such route');
    }
    const res204 = (json) => json(204, {});

    function mintApp(a, audience, cap) {
        const now = Math.floor(Date.now() / 1000);
        return serviceAuth.signServiceToken({ iss: issuer, sub: `app:${a.id}`, actor_type: 'app', aud: [audience], cap, ns: [a.project_id], project_id: a.project_id, env: a.environment, iat: now, exp: now + 300, jti: `tok_${crypto.randomBytes(8).toString('hex')}` }, privatePem);
    }

    const srv = await listen(async (req, raw, json, res) => {
        const url = new URL(req.url, 'http://x');
        st.requests.push({ method: req.method, path: url.pathname, query: url.search, headers: req.headers });
        if (st.down) return problem(json, 503, 'network.down', 'Network is restarting');
        if (url.pathname === '/api/.well-known/jwks') return json(200, { public_key: publicPem, algorithm: 'RS256' });
        if (url.pathname === '/.well-known/openvibe') return json(200, { name: 'OpenVibe', issuer, contracts: { version: require('openvibe-contracts/package.json').version }, services: [] });
        if (url.pathname === '/api/v1/registry/services') {
            return json(200, { services: [{ id: 'network', name: 'OpenVibe.Network', status: 'stable', domains: ['openvibe.network'], capabilities: [], runtime: { status: 'up', basis: 'ready', checked_at: new Date().toISOString() } }, { id: 'codes', name: 'OpenVibe.Codes', status: 'placeholder', domains: [], capabilities: [], runtime: { status: 'not-running', reason: 'placeholder', checked_at: new Date().toISOString() } }] });
        }
        if (url.pathname === '/oauth/revoke') return json(200, {});
        if (url.pathname === '/oauth/token' && req.method === 'POST') {
            const ct = String(req.headers['content-type'] || '');
            const body = ct.includes('json') ? JSON.parse(raw.toString('utf8') || '{}') : Object.fromEntries(new URLSearchParams(raw.toString('utf8')));
            st.tokenRequests.push({ grant_type: body.grant_type, client_id: body.client_id, audience: body.audience, scope: body.scope });
            if (body.client_id === 'actor') {
                if (body.client_secret !== 'actor-secret') return json(401, { error: 'invalid_client', error_description: 'bad client secret' });
                if (body.grant_type === 'authorization_code') {
                    const c = st.codes.get(body.code);
                    if (!c) return json(400, { error: 'invalid_grant', error_description: 'unknown code' });
                    st.codes.delete(body.code);
                    const challenge = crypto.createHash('sha256').update(String(body.code_verifier || '')).digest('base64url');
                    if (challenge !== c.challenge) return json(400, { error: 'invalid_grant', error_description: 'PKCE verification failed' });
                    const rt = `rt_${crypto.randomBytes(12).toString('hex')}`;
                    st.refresh.set(rt, c.user);
                    return json(200, { access_token: userToken(c.user), refresh_token: rt, token_type: 'Bearer' });
                }
                if (body.grant_type === 'refresh_token') {
                    const user = st.refresh.get(body.refresh_token);
                    if (!user) return json(400, { error: 'invalid_grant', error_description: 'refresh token rejected' });
                    st.refresh.delete(body.refresh_token);
                    const rt = `rt_${crypto.randomBytes(12).toString('hex')}`;
                    st.refresh.set(rt, user);
                    return json(200, { access_token: userToken(user), refresh_token: rt, token_type: 'Bearer' });
                }
                if (body.grant_type === 'client_credentials') {
                    const now = Math.floor(Date.now() / 1000);
                    return json(200, { access_token: serviceAuth.signServiceToken({ iss: issuer, sub: 'svc:actor', actor_type: 'service', aud: [body.audience || 'openvibe.events'], cap: String(body.scope || '').split(/\s+/).filter(Boolean), iat: now, exp: now + 300, jti: crypto.randomUUID() }, privatePem), token_type: 'Bearer', expires_in: 300 });
                }
            }
            const a = st.apps.get(body.client_id);
            if (!a || a.revoked_at) return json(401, { error: 'invalid_client', error_description: 'unknown or revoked app' });
            const cred = [...st.creds.values()].find((c) => c.app_id === a.id && c.hash === sha256(body.client_secret) && credState(c) !== 'revoked' && credState(c) !== 'expired');
            if (!cred) return json(401, { error: 'invalid_client', error_description: 'bad client secret' });
            if (a.environment === 'sandbox' && !sandboxAudiences.includes(body.audience)) return json(400, { error: 'invalid_target', error_description: `${body.audience} does not accept sandbox tokens` });
            const p = st.projects.get(a.project_id);
            const held = [...st.grants.values()].filter((g) => g.app_id === a.id && g.status === 'approved' && g.audience === body.audience && p.allowance.includes(g.capability)).map((g) => g.capability);
            const wanted = body.scope ? String(body.scope).split(/\s+/).filter(Boolean) : held;
            const missing = wanted.filter((w) => !held.includes(w));
            if (missing.length) return json(400, { error: 'invalid_scope', error_description: `not granted: ${missing.join(' ')}` });
            if (!wanted.length) return json(400, { error: 'invalid_scope', error_description: `no grants for audience ${body.audience}` });
            return json(200, { access_token: mintApp(a, body.audience, wanted), token_type: 'Bearer', expires_in: 300, scope: wanted.join(' ') });
        }
        if (url.pathname.startsWith('/api/v1/projects')) {
            const u = userFrom(req);
            if (u === 'expired') return problem(json, 401, 'auth.expired', 'access token expired; refresh it');
            if (!u) return problem(json, 401, 'auth.required', 'send Authorization: Bearer <Network access token>');
            if (req.headers['x-internal-key']) return problem(json, 400, 'test.internal_key_seen', 'X-Internal-Key must never be sent');
            const parts = url.pathname.replace(/^\/api\/v1\/projects\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
            return await projectsApi(req, raw, json, u, parts, url.searchParams);
        }
        return json(404, { error: 'not found' });
    });
    issuer = srv.url;

    return {
        url: srv.url, publicPem, privatePem, state: st, requests: st.requests, tokenRequests: st.tokenRequests,
        addUser, userToken,
        /** An authorization code the mock will exchange for this user if the verifier matches. */
        issueCode(user, challenge) { const code = `code_${crypto.randomBytes(8).toString('hex')}`; st.codes.set(code, { user, challenge }); return code; },
        setAllowance(projectId, caps) { st.projects.get(projectId).allowance = caps; },
        setEnvironmentPolicy(projectId, policy) { st.projects.get(projectId).environment_policy = policy; },
        setUsage(projectId, body) { st.usage.set(projectId, body); },
        setQuota(projectId, capability, limit, window, unit) { st.quotas.set(`${projectId} ${capability}`, { project_id: projectId, capability, limit, window, unit, updated_at: new Date().toISOString() }); },
        setCatalog(list) { st.catalog = list; },
        setDown(v) { st.down = v; },
        mintApp: (appId, audience, cap, extra = {}) => { const a = st.apps.get(appId); const now = Math.floor(Date.now() / 1000); return serviceAuth.signServiceToken({ iss: issuer, sub: `app:${a.id}`, actor_type: 'app', aud: [audience], cap, ns: [a.project_id], project_id: a.project_id, env: a.environment, iat: now, exp: now + 300, jti: `tok_${crypto.randomBytes(8).toString('hex')}`, ...extra }, privatePem); },
        close: srv.close,
    };
}

module.exports = { startNetwork, signJwt };

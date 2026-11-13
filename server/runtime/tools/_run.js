'use strict';

/**
 * OpenVibe.Run from the tool modules (not a module itself: the registry skips files starting with "_").
 *
 * A shared node runs the work: Actor submits one job as the person (its own service token for audience
 * openvibe.run, the person named in X-OV-Subject, the project that bills it named in X-OV-Project) and follows
 * the job until it ends. The job body is the one the checks scheduler makes (server/checks/service.js in Run):
 * class code, artifact openvibe-codes@1.0.0, args of kind 'check'.
 *
 *   runFor(ctx, person) → { enabled, base, projectFor, submit, read }
 */

const { serviceAuth } = require('openvibe-contracts');
const { createProjects } = require('../../identity/projects');

const SCOPE = 'run.job.submit run.job.read';
const USER_SUBJECT = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;
const PROJECT = /^prj_[0-9A-HJKMNP-TV-Z]{26}$/;

const CACHE = new WeakMap();

/** The person a task is for ('user:usr_…' → 'usr_…'), or null when the task has no person. */
function personOf(requester) {
    if (typeof requester !== 'string' || !requester.startsWith('user:')) return null;
    const id = requester.slice(5);
    return USER_SUBJECT.test(id) ? id : null;
}

function runFor(ctx, person) {
    const config = ctx.config;
    const base = String((config && config.services && config.services.runUrl) || '').replace(/\/+$/, '');
    const clientSecret = config && config.oauth && config.oauth.clientSecret;
    const enabled = Boolean(base && clientSecret && person);
    if (!enabled) {
        return { enabled: false, base, reason: base ? 'this run has no signed-in person to run it for' : 'OpenVibe.Run is not connected to this server' };
    }
    const fetchImpl = ctx.fetch || globalThis.fetch;
    let byFetch = CACHE.get(config);
    if (!byFetch) { byFetch = new WeakMap(); CACHE.set(config, byFetch); }
    let client = byFetch.get(fetchImpl);
    if (!client) {
        client = {
            tokens: serviceAuth.createTokenClient({
                tokenUrl: config.networkInternalUrl + '/oauth/token',
                clientId: (config.oauth && config.oauth.clientId) || 'actor',
                clientSecret,
                audience: 'openvibe.run',
                scope: SCOPE,
                fetchImpl,
            }),
            projects: createProjects({ config, fetchImpl }),
        };
        byFetch.set(fetchImpl, client);
    }

    /** One call to Run, as the person and the project that pays for it. */
    async function call(method, path, { subject, project, body, key } = {}) {
        const sig = ctx.signal ? AbortSignal.any([ctx.signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000);
        let res = null;
        try {
            res = await fetchImpl(base + '/api/v1' + path, {
                method,
                headers: {
                    Accept: 'application/json',
                    'X-OV-Subject': subject,
                    ...(project ? { 'X-OV-Project': project } : {}),
                    ...(body ? { 'Content-Type': 'application/json' } : {}),
                    ...(key ? { 'Idempotency-Key': key } : {}),
                    ...(await client.tokens.authHeaders()),
                },
                body: body ? JSON.stringify(body) : undefined,
                signal: sig,
            });
        } catch (err) {
            return { ok: false, status: 502, error: 'OpenVibe.Run did not answer: ' + String((err && err.message) || err).slice(0, 200) };
        }
        const text = await res.text().catch(() => '');
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch { data = null; }
        if (!res.ok) {
            const detail = String((data && (data.detail || data.title || data.code)) || text || ('OpenVibe.Run answered ' + res.status)).slice(0, 300);
            return { ok: false, status: res.status, error: detail, data };
        }
        return { ok: true, status: res.status, data };
    }

    /** The project to bill: the first unarchived project the person administers. */
    async function projectFor(subject) {
        try {
            const list = await client.projects.forSubject(subject);
            const first = (Array.isArray(list) ? list : []).find((p) => p && PROJECT.test(String(p.project_id || '')) && p.archived !== true);
            return first ? first.project_id : null;
        } catch {
            return null;
        }
    }

    /** One job, submitted as the person. */
    async function submit({ subject, project, body, key }) {
        return await call('POST', '/jobs', { subject, project, body, key });
    }

    /** One job, read again. */
    async function read({ subject, project, id }) {
        return await call('GET', '/jobs/' + encodeURIComponent(id), { subject, project });
    }

    return { enabled: true, base, scope: SCOPE, projectFor, submit, read };
}

module.exports = { runFor, personOf, SCOPE, USER_SUBJECT, PROJECT };

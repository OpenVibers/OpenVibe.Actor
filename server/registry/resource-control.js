'use strict';

/**
 * Actor's control API (ADR-048, plan T13 step 10; capability actor.resource.control): POST /api/v1/resources/control —
 * one common.resource-control-request@1 from a first-party service (OpenVibe.Services) acting for the person in
 * on_behalf_of, on an actor.task named by its OVRN. The answer is a common.resource-control-result@1 (200 for every
 * outcome; a malformed request is a 400 problem).
 *
 *   stop   cancel the task, exactly as POST /api/v1/tasks/:id/cancel does: a queued task ends at once (done); a running
 *          one is aborted and ends cancelled when its current step returns (pending). Its cost so far is kept.
 *
 * Any other action is refused `control.unsupported_action` (a task is deleted only with its person's account data).
 * The person who asked for the task may act on it, and so may an admin or owner of its project (asked of Network:
 * server/identity/projects.js), which is how a project's admins stop the tasks its apps started. Anyone else is refused
 * as not found, never confirmed to exist; and only inside the project the OVRN names. `dry_run` decides and explains without applying. The first
 * answer per (caller, project, idempotency_key) is kept in actor_control_log and returned for a repeat; the same key
 * with another request is refused `control.idempotency_conflict`.
 */
const crypto = require('crypto');
const express = require('express');
const contracts = require('openvibe-contracts');
const store = require('../tasks/store');
const { asyncRouter } = require('../http/router');

const SERVICE = 'actor';
const CAPABILITY = 'actor.resource.control';
const USER_SUBJECT_RE = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;
const TASK_ID_RE = /^tsk_[0-9A-HJKMNP-TV-Z]{26}$/;

function canonical(v) {
    if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
    if (v && typeof v === 'object') return `{${Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
    return JSON.stringify(v);
}
const digestOf = (request) => crypto.createHash('sha256')
    .update(canonical({ ...request, idempotency_key: undefined, confirmation_id: undefined, trace_id: undefined })).digest('hex');

function router({ s, principal, engine, projects, now = () => Date.now() }) {
    const r = asyncRouter();
    const json = express.json({ limit: '16kb' });
    const iso = () => new Date(now()).toISOString();
    const result = (request, state, extra = {}) => ({ action: request.action, ...(request.resource ? { resource: request.resource } : {}), state, at: iso(), ...extra });
    const problem = (status, code, detail) => ({ type: `https://openvibe.network/problems/${code}`, title: code, status, code, detail });
    const send = (req, res, status, code, detail) => contracts.http.sendProblem(res, status, code, { detail, ctx: req.ov });

    /** The capability guard checks the token; this also excludes people and app or agent tokens. */
    function firstParty(req, res, next) {
        if (req.principal.kind === 'app' && req.principal.requester.startsWith('service:')) return next();
        return send(req, res, 403, 'capability.denied', `${CAPABILITY} is first-party and requires a service token`);
    }

    async function decide(request) {
        const parsed = contracts.resources.parse(request.resource || '');
        if (!parsed || parsed.service !== SERVICE || parsed.type !== 'task' || !TASK_ID_RE.test(parsed.id)) {
            return result(request, 'refused', { problem: problem(404, 'resources.unknown_resource', `no task named ${request.resource || request.resource_kind}`) });
        }
        if (request.action !== 'stop') {
            return result(request, 'refused', { problem: problem(422, 'control.unsupported_action', `a task takes stop, not ${request.action}`) });
        }
        const person = request.on_behalf_of;
        if (!person || person.type !== 'user' || !USER_SUBJECT_RE.test(String(person.id || ''))) {
            return result(request, 'refused', { problem: problem(403, 'control.no_person', 'on_behalf_of must name the person who asked for the task') });
        }
        const row = await store.getTask(s, parsed.id);
        const inProject = !!row && row.project_id === parsed.project_id && parsed.project_id === request.project_id;
        let allowed = inProject && row.requester === `user:${person.id}`;
        if (inProject && !allowed) {
            try { allowed = await projects.isAdmin(row.project_id, person.id); } catch {
                return result(request, 'failed', { problem: problem(503, 'identity.unavailable', 'Network could not say whether this person administers the project; nothing was changed') });
            }
        }
        if (!allowed) {
            return result(request, 'refused', { problem: problem(404, 'resources.unknown_resource', `no task named ${request.resource} that this person may stop`) });
        }
        if (!store.OPEN.includes(row.state)) return result(request, 'done', { result: { status: row.state, changed: false } });
        if (request.dry_run) return result(request, 'done', { result: { dry_run: true, would: row.state === 'queued' ? 'cancel the task before it starts' : 'stop the task: it ends cancelled when its current step returns' } });
        const after = await engine.cancel(row.id, `user:${person.id}`);
        if (store.OPEN.includes(after.state)) return result(request, 'pending', { result: { status: after.state, stopping: true } });
        return result(request, 'done', { result: { status: after.state, changed: true } });
    }

    // Mounted beside the read index (server/registry/resource-index.js) on /api/v1/resources: only this one route.
    const noStore = (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); };
    r.post('/control', noStore, principal.middleware, principal.requireCapability('actor.resource.control'), firstParty, json, async (req, res) => {
        const request = req.body;
        const check = contracts.resources.checkControlRequest(request || {});
        if (!check.valid) return send(req, res, 400, 'control.bad_request', JSON.stringify(check.errors).slice(0, 500));
        const caller = req.principal.requester;
        const digest = digestOf(request);
        const seen = await s.db.maybe('SELECT digest, response FROM actor_control_log WHERE caller = $1 AND project_id = $2 AND idempotency_key = $3',
            [caller, request.project_id, request.idempotency_key]);
        if (seen) {
            if (seen.digest !== digest) return send(req, res, 409, 'control.idempotency_conflict', 'this idempotency_key was used for another request');
            return res.json(typeof seen.response === 'string' ? JSON.parse(seen.response) : seen.response);
        }
        const answer = await decide(request);
        await s.db.query(`INSERT INTO actor_control_log (caller, project_id, idempotency_key, digest, response, created_at)
            VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING`, [caller, request.project_id, request.idempotency_key, digest, JSON.stringify(answer), now()]);
        return res.json(answer);
    });

    return r;
}

module.exports = { router, CAPABILITY, digestOf };

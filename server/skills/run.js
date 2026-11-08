'use strict';

/**
 * Running one sandbox tool on OpenVibe.Run (plan HO8, ADR-060).
 *
 * A skill's code never runs on Actor's server. This module submits one Run job AS THE PERSON — Actor's service token
 * (audience openvibe.run), `X-OV-Subject`, and the person's `X-OV-Project` (project delegation, ADR-003 amendment
 * 2026-10-12) — and, if a Node takes it, waits for the result:
 *
 *   class: function, artifact openvibe-skill-runner@1.0.0,
 *   args: { tool, entry, input }, inputs: the listing's { media_id, sha256 } pins,
 *   limits: the tool's declared wall/memory (never above the caps), ttl_ms: 120000,
 *   egress: the tool's declared net (never wider), requirements: the person's own machines first, then OpenVibe's pool.
 *
 * Placement is Run's: the requirements name `user-owned` (the person's own Link machines) before `first-party`, so a
 * free own machine wins a balanced placement; Actor never runs the code itself and never falls back to its server.
 * Run's per-second metering is the cost (it bills the project; the job's usage carries the wall time).
 *
 *   createSkillRun({ config, fetchImpl, tokens?, projects?, now?, sleep?, pollMs? }) → { enabled, execute }
 *   execute({ subject, project?, tool, code, input, signal?, onJob? }) → { ok, job_id, wall_ms, exit, result, ... }
 *                                                                  or { ok: false, no_node?, error }
 */
const { serviceAuth } = require('openvibe-contracts');

const SCOPE = 'run.job.submit run.job.read run.job.cancel';
const ARTIFACT = { name: 'openvibe-skill-runner', version: '1.0.0' };
const TTL_MS = 120_000;
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'expired']);
const PROJECT = /^prj_[0-9A-HJKMNP-TV-Z]{26}$/;
const USER = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;
const MEDIA = /^med_[0-9A-HJKMNP-TV-Z]{26}$/;
const HASH = /^[0-9a-f]{64}$/;
// platform.workload-requirements@1 and the caps the contract gives a tool.
// Where a skill's code may run (ADR-060, Opus's review): the person's own machines, else OpenVibe's own pool. Never a
// partner's, the community's or an outside provider's machine: the tool's input is the person's data.
const TRUST = ['user-owned', 'first-party'];
const WALL_MAX = 30_000;
const MEM_MAX = 268_435_456;
const WALL_DEFAULT = 10_000;
const MEM_DEFAULT = 134_217_728;

const clip = (s, n) => { const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const inputName = (index) => `code-${Number(index) + 1}.js`;
const idOf = (job) => (job && typeof job.id === 'string' ? job.id : null);

/** The declared net, never narrower or wider than the document: deny (no network), OpenVibe only, or public. */
const egressOf = (tool) => (tool && tool.net === 'public' ? 'public' : tool && tool.net === 'openvibe-only' ? 'openvibe-only' : 'none');

/** The declared limits, clamped to the contract's caps; a missing field takes the contract's default, never more. */
function limitsOf(tool) {
    const declared = (tool && tool.limits) || {};
    const wall = Math.min(WALL_MAX, Math.max(1, Number(declared.wall_ms) || WALL_DEFAULT));
    const mem = Math.min(MEM_MAX, Math.max(1, Number(declared.mem_bytes) || MEM_DEFAULT));
    return { wall_ms: wall, cpu_ms: wall, mem_bytes: mem };
}

/**
 * The exact run.job-create-request@1 body for one tool. It is exported so a test can read it without a network;
 * every field comes from the listing's pinned document and code, never from the model.
 */
function jobBody({ tool, code, input }) {
    const pins = (Array.isArray(code) ? code : []).map((c, i) => ({ name: inputName(i), media_id: c.media_id, sha256: c.sha256 }));
    const at = (Array.isArray(code) ? code : []).findIndex((c) => c.name === tool.entry);
    const limits = limitsOf(tool);
    const egress = egressOf(tool);
    return {
        class: 'function',
        artifact: { ...ARTIFACT },
        args: { tool: tool.name, entry: inputName(at < 0 ? 0 : at), input: input && typeof input === 'object' ? input : {} },
        inputs: pins,
        limits,
        ttl_ms: TTL_MS,
        egress,
        requirements: {
            kind: 'run.function', mobility: 'job', latency_class: 'background', objective: 'balanced',
            trust: [...TRUST],
            capabilities: ['worker:function'],
            resources: { egress, memory_mb: Math.ceil(limits.mem_bytes / (1024 * 1024)) },
        },
    };
}

/** The body is only well formed when every pin and the entry are real: nothing is submitted otherwise. */
function bodyProblem(body) {
    if (!body || !Array.isArray(body.inputs) || !body.inputs.length) return 'this skill has no pinned code to run';
    for (const pin of body.inputs) {
        if (!pin || typeof pin.name !== 'string' || !MEDIA.test(String(pin.media_id || '')) || !HASH.test(String(pin.sha256 || ''))) {
            return 'a pinned code resource is missing its Media id or sha256';
        }
    }
    if (!body.inputs.some((p) => p.name === body.args.entry)) return 'the tool entry is not one of the pinned code inputs';
    return null;
}

function createSkillRun({ config, fetchImpl = globalThis.fetch, tokens: tokensOverride = null, projects = null, now = () => Date.now(), sleep = null, pollMs = 1000 } = {}) {
    const services = (config && config.services) || {};
    const skills = (config && config.skills) || {};
    const base = String(services.runUrl || '').replace(/\/+$/, '');
    const link = String(services.linkUrl || 'https://openvibe.bot/link');
    const enabled = !!(base && (tokensOverride || (config.oauth && config.oauth.clientSecret)));
    const tokens = !enabled ? null : tokensOverride || serviceAuth.createTokenClient({
        tokenUrl: `${config.networkInternalUrl}/oauth/token`,
        clientId: config.oauth.clientId, clientSecret: config.oauth.clientSecret,
        audience: 'openvibe.run', scope: SCOPE, fetchImpl,
    });
    const placementWaitMs = Math.max(1000, Number(skills.placementWaitMs) || 12_000);
    const pause = sleep || ((ms, signal) => new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        if (signal) signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
    }));

    const problemOf = (data, status) => String((data && (data.detail || data.title || data.code)) || `OpenVibe.Run answered ${status}`).slice(0, 300);

    async function call(method, path, { subject, project, body, key, signal } = {}) {
        const sig = signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000);
        const res = await fetchImpl(`${base}/api/v1${path}`, {
            method,
            headers: {
                Accept: 'application/json',
                'X-OV-Subject': subject,
                'X-OV-Project': project,
                ...(body ? { 'Content-Type': 'application/json' } : {}),
                ...(key ? { 'Idempotency-Key': key } : {}),
                ...(await tokens.authHeaders()),
            },
            body: body ? JSON.stringify(body) : undefined,
            signal: sig,
        });
        if (res.status === 401 && tokens.invalidate) tokens.invalidate();
        const data = await res.json().catch(() => null);
        return { status: res.status, ok: res.ok, data };
    }

    /** The project to bill: the task's own when it has one, else the first unarchived project the person administers. */
    async function projectFor(subject, named = null) {
        if (PROJECT.test(String(named || ''))) return named;
        if (!projects || typeof projects.forSubject !== 'function') return null;
        const list = await projects.forSubject(subject).catch(() => []);
        const mine = (Array.isArray(list) ? list : []).find((p) => p && PROJECT.test(String(p.project_id || '')) && p.archived !== true);
        return mine ? mine.project_id : null;
    }

    /**
     * Submit one job and wait for its end. A job still queued after `placementWaitMs` is cancelled and answered as
     * "no node": nothing ran, and nothing runs anywhere else.
     */
    async function execute({ subject, project = null, tool, code, input, signal = null, onJob = null } = {}) {
        if (!enabled) return { ok: false, error: 'OpenVibe.Run is not connected on this server, so nothing could run.' };
        if (!USER.test(String(subject || ''))) return { ok: false, error: 'A skill runs as a signed-in person; this run has none.' };
        if (!tool || typeof tool.name !== 'string') return { ok: false, error: 'There is no such tool on this skill.' };
        if (!Array.isArray(code) || !code.some((c) => c && c.name === tool.entry)) {
            return { ok: false, error: 'The tool\'s entry is not one of the listing\'s pinned code resources, so nothing ran.' };
        }
        const body = jobBody({ tool, code, input });
        const bad = bodyProblem(body);
        if (bad) return { ok: false, error: bad };
        const billTo = await projectFor(subject, project);
        if (!billTo) {
            return { ok: false, error: 'OpenVibe.Run bills a project of yours. Make one at https://openvibe.network/developer, then try again.' };
        }
        let sent;
        try {
            sent = await call('POST', '/jobs', { subject, project: billTo, body, signal });
        } catch (err) {
            return { ok: false, error: `OpenVibe.Run did not answer: ${clip((err && err.message) || err, 240)}` };
        }
        if (!sent.ok) {
            if (sent.status === 409 && sent.data && sent.data.code === 'run.job.node_offline') return noNode();
            return { ok: false, error: problemOf(sent.data, sent.status), status: sent.status };
        }
        let job = (sent.data && (sent.data.job || sent.data)) || null;
        if (!idOf(job)) return { ok: false, error: 'OpenVibe.Run answered without a job id.' };
        if (onJob) await onJob(job);
        const jobId = idOf(job);
        const placementUntil = now() + placementWaitMs;
        const KNOWN = new Set(['queued', 'placed', 'running', 'succeeded', 'failed', 'cancelled', 'expired']);
        try {
            while (!TERMINAL.has(String(job.state || ''))) {
                if (!KNOWN.has(String(job.state || ''))) {
                    return { ok: false, job_id: jobId, error: 'OpenVibe.Run answered a job without a state, so Actor stopped waiting.' };
                }
                if (signal && signal.aborted) {
                    await call('POST', `/jobs/${encodeURIComponent(jobId)}/cancel`, { subject, project: billTo, signal }).catch(() => null);
                    return { ok: false, job_id: jobId, error: 'The task was cancelled, so the skill run was cancelled too.' };
                }
                if (job.state === 'queued' && now() >= placementUntil) {
                    await call('POST', `/jobs/${encodeURIComponent(jobId)}/cancel`, { subject, project: billTo }).catch(() => null);
                    return { ...noNode(), job_id: jobId };
                }
                await pause(pollMs, signal);
                if (signal && signal.aborted) continue;
                const read = await call('GET', `/jobs/${encodeURIComponent(jobId)}`, { subject, project: billTo, signal });
                if (!read.ok) return { ok: false, job_id: jobId, error: problemOf(read.data, read.status), status: read.status };
                job = read.data;
                if (onJob) await onJob(job);
            }
        } catch (err) {
            if (signal && signal.aborted) {
                await call('POST', `/jobs/${encodeURIComponent(jobId)}/cancel`, { subject, project: billTo }).catch(() => null);
                return { ok: false, job_id: jobId, error: 'The task was cancelled, so the skill run was cancelled too.' };
            }
            return { ok: false, job_id: jobId, error: `OpenVibe.Run did not answer: ${clip((err && err.message) || err, 240)}` };
        }
        const usage = job.usage || {};
        const started = job.timings && job.timings.started_at ? Date.parse(job.timings.started_at) : null;
        const finished = job.timings && job.timings.finished_at ? Date.parse(job.timings.finished_at) : null;
        const wall = Number(usage.wall_ms) || (started && finished && finished >= started ? finished - started : 0);
        const exit = job.exit && job.exit.code != null ? job.exit.code : (job.result && job.result.exit != null ? job.result.exit : null);
        if (job.state === 'expired' && job.error && job.error.code === 'run.job.unplaceable') return { ...noNode(), job_id: jobId, wall_ms: wall, exit };
        if (job.state !== 'succeeded') {
            return {
                ok: false, job_id: jobId, wall_ms: wall, exit, state: job.state,
                result: job.result == null ? null : job.result,
                error: `The skill run ${job.state === 'expired' ? 'ran out of time' : job.state}${job.error && job.error.detail ? `: ${String(job.error.detail).slice(0, 200)}` : '.'}`,
            };
        }
        return { ok: true, job_id: jobId, wall_ms: wall, exit, usage_seconds: Number(usage.seconds) || 0, result: job.result };
    }

    function noNode() {
        return {
            ok: false, no_node: true,
            error: `No machine is offering to run this skill right now. Run it on my machine: ${link} — turn the skill runner on there, then try again. Nothing ran anywhere else.`,
        };
    }

    return { enabled, execute, jobBody, limitsOf, egressOf, projectFor };
}

module.exports = { createSkillRun, jobBody, limitsOf, egressOf, bodyProblem, ARTIFACT, TTL_MS, TRUST, SCOPE };

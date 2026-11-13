'use strict';

/**
 * A repository's own check (its CI) on a shared node, through OpenVibe.Run.
 *
 * The job is the one the checks scheduler makes (Run's server/checks/service.js): class code, the artifact
 * openvibe-codes@1.0.0, and args of kind 'check' — the same Codes harness that runs a workflow job with act on
 * the node. The tool submits it as the person, follows it until it ends, and answers the conclusion, the steps
 * and the last lines of the log of the step that failed.
 *
 * Only a repository the person may read is run. On OpenVibe Git that is asked of OpenVibe Git with the person's
 * own token (a private repository they cannot see is a 404); a GitHub repository is run only when it is public,
 * because Actor cannot know whether the person may read a private one.
 *
 * This starts work on a shared node, so it acts: the loop checkpoints the intent before it runs.
 */

const { runFor, personOf } = require('./_run');

/** The check itself may run this long. */
const CHECK_MS = 600_000;
/** How long the tool waits for it. */
const WAIT_MS = 660_000;
/** How often the job is read again. */
const POLL_MS = 2_000;
const REPO_HOSTS = new Set(['github.com', 'git.openvibe.codes']);
const OWNER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const JOB_ID = /^[A-Za-z_][A-Za-z0-9_-]{0,99}$/;
const REF = /^[A-Za-z0-9._/-]{1,200}$/;
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'expired']);

/** A repository URL: https on github.com or OpenVibe Git, one owner and one repository, no credentials. */
function parseRepo(raw) {
    let u = null;
    try { u = new URL(String(raw || '').trim()); } catch { return null; }
    if (u.protocol !== 'https:') return null;
    if (u.username || u.password || u.search || u.hash || u.port) return null;
    const host = u.hostname.toLowerCase();
    if (!REPO_HOSTS.has(host)) return null;
    const parts = u.pathname.replace(/\/+$/, '').replace(/\.git$/i, '').split('/').filter(Boolean);
    if (parts.length !== 2 || !OWNER_NAME.test(parts[0]) || !OWNER_NAME.test(parts[1])) return null;
    return { host, owner: parts[0], name: parts[1], url: 'https://' + host + '/' + parts[0] + '/' + parts[1] };
}

/** A workflow file under .github/workflows/, no traversal. */
function workflowOk(value) {
    if (typeof value !== 'string' || !value || value.length > 300) return false;
    const parts = value.split('/');
    if (parts.length < 3 || parts[0] !== '.github' || parts[1] !== 'workflows') return false;
    if (!parts.every((p) => p && p !== '.' && p !== '..' && /^[A-Za-z0-9._-]+$/.test(p))) return false;
    return /\.ya?ml$/i.test(parts[parts.length - 1]);
}

/** The last lines of the log, and the step that failed. */
function failingOf(result) {
    const steps = Array.isArray(result && result.steps) ? result.steps : [];
    const failed = steps.find((s) => s && String(s.conclusion || '').toLowerCase() === 'failure')
        || steps.find((s) => s && String(s.conclusion || '').toLowerCase() === 'cancelled')
        || null;
    const tail = String((result && result.log_tail) || '');
    const lines = tail ? tail.split('\n') : [];
    return { step: failed ? { name: failed.name || null, conclusion: failed.conclusion || null, ms: failed.ms == null ? null : Number(failed.ms) } : null, log_tail: lines.slice(-40).join('\n') };
}

module.exports = {
    name: 'shared_node_check',
    description: 'Run a repository\'s own check (its CI workflow) on a shared node and answer how it went: the conclusion, the steps, and the last lines of the log of the step that failed. Give the repository as its https address (a repository of yours on OpenVibe Git, or a public one on GitHub), the branch or tag to check (the default branch when you leave it out), and the workflow file and job to run (the repository\'s own first check when you leave them out). It may take a few minutes.',
    input: {
        type: 'object',
        properties: {
            repo: { type: 'string', description: 'the repository as its https address (for example https://git.openvibe.codes/OpenVibers/OpenVibe.Actor)' },
            ref: { type: 'string', description: 'the branch or tag to check (the repository\'s default branch when you leave it out)' },
            workflow: { type: 'string', description: 'the workflow file, under .github/workflows/ ending in .yml (the repository\'s own first check when you leave it out)' },
            job: { type: 'string', description: 'the workflow job to run (goes with the workflow file)' },
        },
        required: ['repo'],
    },
    scope: 'person',
    needs: { files: 'read', network: true },   // plan 11c: the run's files and network settings gate it
    connector: 'shared_nodes',
    acts: true,
    costUsd: 0,
    timeoutMs: 780_000,
    available: (ctx) => Boolean(ctx.config && ctx.config.services && ctx.config.services.runUrl && ctx.config.oauth && ctx.config.oauth.clientSecret && personOf(ctx.requester)),
    async run(input, ctx) {
        const person = personOf(ctx.requester);
        const run = runFor(ctx, person);
        if (!run.enabled) return { text: JSON.stringify({ error: run.reason }), isError: true };
        const repo = parseRepo(input && input.repo);
        if (!repo) {
            return { text: JSON.stringify({ error: 'name the repository as its https address on github.com or git.openvibe.codes' }), isError: true };
        }
        const workflow = String((input && input.workflow) || '').trim();
        const job = String((input && input.job) || '').trim();
        if (!!workflow !== !!job) {
            return { text: JSON.stringify({ error: 'the workflow file and the job go together, or neither of them' }), isError: true };
        }
        if (workflow && !workflowOk(workflow)) {
            return { text: JSON.stringify({ error: 'the workflow is a file under .github/workflows/ ending in .yml or .yaml' }), isError: true };
        }
        if (job && !JOB_ID.test(job)) {
            return { text: JSON.stringify({ error: 'the job is a workflow job id (letters, digits, dashes and underscores)' }), isError: true };
        }
        const askedRef = String((input && input.ref) || '').trim();
        if (askedRef && (!REF.test(askedRef) || askedRef.startsWith('-') || askedRef.startsWith('/') || askedRef.includes('..') || askedRef.includes('//'))) {
            return { text: JSON.stringify({ error: 'the ref is a branch or a tag name' }), isError: true };
        }

        // May the person read this repository?
        const access = await repoAccess(ctx, person, repo);
        if (access.error) return { text: JSON.stringify({ error: access.error }), isError: true };
        const ref = askedRef || access.default_branch || 'main';

        // The project that pays for the node's time.
        const project = await run.projectFor(person);
        if (!project) {
            return { text: JSON.stringify({ error: 'OpenVibe.Run bills a project of yours. Make one at https://openvibe.network/developer, then try again.' }), isError: true };
        }

        // The job the checks scheduler makes: Codes runs one workflow job with act on the node.
        const body = {
            class: 'code',
            artifact: { name: 'openvibe-codes', version: '1.0.0' },
            args: {
                kind: 'check',
                repo: repo.url,
                ref,
                ...(workflow ? { workflow } : {}),
                ...(job ? { job } : {}),
                event: 'push',
                timeout_ms: CHECK_MS,
            },
            limits: { wall_ms: CHECK_MS, cpu_ms: CHECK_MS, mem_bytes: 4 * 1024 ** 3 },
            ttl_ms: Math.min(CHECK_MS + 600_000, 86_400_000),
            egress: 'public',
            requirements: { kind: 'run.code', mobility: 'job', latency_class: 'background', objective: 'balanced', trust: ['first-party', 'user-owned'] },
        };
        const key = 'check:' + Date.now() + ':' + repo.owner + '-' + repo.name;
        const sent = await run.submit({ subject: person, project, body, key });
        if (!sent.ok) return { text: JSON.stringify({ error: sent.error }), isError: true };
        let jobRow = (sent.data && (sent.data.job || sent.data)) || null;
        const jobId = jobRow && jobRow.id ? jobRow.id : null;
        if (!jobId) return { text: JSON.stringify({ error: 'OpenVibe.Run answered without a job id' }), isError: true };

        // Follow the job until it ends.
        const until = Date.now() + WAIT_MS;
        while (jobRow && !TERMINAL.has(String(jobRow.state || ''))) {
            if (ctx.signal && ctx.signal.aborted) return { text: JSON.stringify({ error: 'the task was cancelled, so the check was left to finish on the node', job_id: jobId }), isError: true };
            if (Date.now() >= until) {
                return {
                    text: JSON.stringify({ status: 'still running', job_id: jobId, state: jobRow.state || null, note: 'the check is still running on the node; it may take a few more minutes' }),
                    data: { job_id: jobId, status: 'still running' },
                };
            }
            await new Promise((resolve) => {
                const timer = setTimeout(resolve, POLL_MS);
                if (ctx.signal) ctx.signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
            });
            const again = await run.read({ subject: person, project, id: jobId });
            if (!again.ok) return { text: JSON.stringify({ error: again.error, job_id: jobId }), isError: true };
            jobRow = again.data || jobRow;
        }

        const state = String((jobRow && jobRow.state) || '');
        const result = (jobRow && jobRow.result) || null;
        if (!result) {
            const error = (jobRow && jobRow.error) || null;
            return {
                text: JSON.stringify({ status: state, job_id: jobId, error: error ? { code: error.code, detail: error.detail || null } : null, note: 'the check did not hand over a result' }),
                data: { job_id: jobId, status: state },
            };
        }
        const failing = failingOf(result);
        const out = {
            job_id: jobId,
            status: result.conclusion || state,
            ok: result.ok === true,
            reason: result.reason || null,
            workflow: result.workflow || workflow || null,
            job: result.job || job || null,
            commit: result.sha || null,
            ms: result.ms == null ? null : Number(result.ms),
            steps: (result.steps || []).map((s) => ({ name: s.name || null, conclusion: s.conclusion || null, ms: s.ms == null ? null : Number(s.ms) })),
            failing_step: failing.step,
            log_tail: failing.log_tail,
        };
        return { text: JSON.stringify(out), data: out };
    },
};

/**
 * May the person read this repository? On OpenVibe Git OpenVibe Git itself says so (with the person's own token);
 * on GitHub only a public repository may be run, because Actor cannot know whether the person may read a private
 * one. The default branch comes from the same answer.
 */
async function repoAccess(ctx, person, repo) {
    const fetchImpl = ctx.fetch || globalThis.fetch;
    const token = ctx.personToken || '';
    if (repo.host === 'git.openvibe.codes') {
        const base = String((ctx.config && ctx.config.services && ctx.config.services.gitUrl) || 'https://git.openvibe.codes').replace(/\/+$/, '');
        let res = null;
        try {
            res = await fetchImpl(base + '/api/v1/repos/' + encodeURIComponent(repo.owner) + '/' + encodeURIComponent(repo.name), {
                headers: { Accept: 'application/json', Authorization: 'Bearer ' + token },
                signal: AbortSignal.timeout(15_000),
            });
        } catch (err) {
            return { error: 'OpenVibe Git did not answer: ' + String((err && err.message) || err).slice(0, 200) };
        }
        if (res.status === 404) return { error: 'that repository is not one you can read on OpenVibe Git' };
        if (!res.ok) return { error: 'OpenVibe Git answered ' + res.status };
        const body = await res.json().catch(() => null);
        const row = (body && (body.repo || body)) || {};
        return { default_branch: row.default_branch || row.defaultBranch || null, repo: row };
    }
    // GitHub: only a public repository is run.
    let res = null;
    try {
        res = await fetchImpl('https://api.github.com/repos/' + encodeURIComponent(repo.owner) + '/' + encodeURIComponent(repo.name), {
            headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'OpenVibeActor/1.0 (+https://openvibe.actor)' },
            signal: AbortSignal.timeout(15_000),
        });
    } catch (err) {
        return { error: 'GitHub did not answer: ' + String((err && err.message) || err).slice(0, 200) };
    }
    if (res.status === 404) {
        return { error: 'that GitHub repository is private or gone, and Actor cannot see whether you may read it: put the repository on OpenVibe Git and point the agent at that one' };
    }
    if (!res.ok) return { error: 'GitHub answered ' + res.status + ' for that repository' };
    const body = await res.json().catch(() => null);
    return { default_branch: (body && body.default_branch) || null, repo: body || null };
}

module.exports.parseRepo = parseRepo;
module.exports.workflowOk = workflowOk;
module.exports.failingOf = failingOf;

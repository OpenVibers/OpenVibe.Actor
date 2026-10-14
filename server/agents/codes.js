'use strict';

/**
 * The `codes` agent (plan T16/T17): a person's coding task goes to OpenVibe.Codes, which runs it on that person's own
 * machine (openvibe.codes/run: an OpenVibe.Run job placed only on a machine of theirs, added on openvibe.bot/machines).
 * Actor calls Codes' task API (Contracts 0.162 codes.task.*) with its own service token (audience openvibe.codes) and
 * X-OV-Subject naming the person; Codes shows Actor only the tasks Actor started for that person. The model use is on
 * the machine's own keys, so Actor meters nothing for it.
 *
 *   createCodes({ config, fetchImpl, tokens?, sleep?, pollMs?, now? }) → { enabled, adapter }
 *     adapter({ task, requester, signal, emit, meter, budgetLeft, taskId }) → { text, sources, model }
 *
 * The adapter starts the task (the Actor task id is its idempotency key, so a retry never starts a second one),
 * reports each state change, and waits for the end. When the machine is still working as Actor's own task time runs
 * out, the answer says so and links the task's live page; when the task is cancelled, the Codes task is cancelled too.
 * Off (enabled false) without ACTOR_CODES_URL or without Actor's client secret.
 */
const { serviceAuth } = require('openvibe-contracts');
const { ProviderError } = require('./providers');

const USER_SUBJECT = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;
const TASK_ID = /^tsk_[0-9A-HJKMNP-TV-Z]{26}$/;
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'expired']);
const LABEL = {
    queued: 'Waiting for your machine', placed: 'Sent to your machine', running: 'Your machine is working on it',
    succeeded: 'Finished', failed: 'Failed', cancelled: 'Cancelled', expired: 'No machine of yours took it in time',
};
// A repository the task names: an https URL with an owner and a name (GitHub, GitLab, Codeberg, a Forgejo …).
const REPO = /https:\/\/[a-z0-9.-]+\.[a-z]{2,}\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+/;

const personOf = (requester) => (typeof requester === 'string' && requester.startsWith('user:') ? requester.slice(5) : null);

/** The first repository URL in the task text, without a trailing .git or punctuation; null when there is none. */
function repoIn(text) {
    const m = REPO.exec(String(text || ''));
    if (!m) return null;
    return m[0].replace(/[.,;:!?)]+$/, '').replace(/\.git$/, '');
}

/** The ended task's answer for the person, in Markdown. */
function answerOf(t) {
    const r = t.result || {};
    const lines = [];
    const took = typeof r.duration_ms === 'number' ? `, ${Math.max(1, Math.round(r.duration_ms / 1000))} s` : '';
    lines.push(`**Done on your machine**${r.agents && r.agents.length ? ` (${r.agents.join(' → ')}${took})` : took ? ` (${took.slice(2)})` : ''}.`);
    if (r.summary) lines.push('', r.summary.trim());
    const files = Array.isArray(r.files) ? r.files : [];
    if (files.length) {
        const shown = files.slice(0, 20).map((f) => `\`${f.path}\` (+${f.added == null ? '·' : f.added} −${f.removed == null ? '·' : f.removed})`);
        lines.push('', `**Changed files:** ${shown.join(', ')}${files.length > 20 ? ` and ${files.length - 20} more` : ''}`);
    } else {
        lines.push('', 'No files changed.');
    }
    if (r.patch) {
        const cut = r.patch.length > 3000;
        lines.push('', '```diff', r.patch.slice(0, 3000).replace(/```/g, '``​`'), '```', ...(cut || r.patch_truncated ? ['(The whole patch is on the task page.)'] : []));
    }
    if (r.push && r.push.pushed) lines.push('', `Pushed to the branch [${r.push.branch}](${r.push.branch_url})${r.push.pull_request ? ` · [pull request](${r.push.pull_request})` : ''}.`);
    lines.push('', `[The task on OpenVibe.Codes](${t.url})`);
    return lines.join('\n');
}

function createCodes({ config, fetchImpl = globalThis.fetch, tokens: tokensOverride = null, sleep = (ms, signal) => new Promise((ok) => { const h = setTimeout(ok, ms); if (signal) signal.addEventListener('abort', () => { clearTimeout(h); ok(); }, { once: true }); }), pollMs = 3000, now = () => Date.now() }) {
    const base = config.services.codesUrl;
    const pages = config.services.codesPublicUrl || 'https://openvibe.codes';
    const enabled = !!(base && (tokensOverride || config.oauth.clientSecret));
    const tokens = !enabled ? null : tokensOverride || serviceAuth.createTokenClient({
        tokenUrl: `${config.networkInternalUrl}/oauth/token`, clientId: config.oauth.clientId, clientSecret: config.oauth.clientSecret,
        audience: 'openvibe.codes', scope: 'codes.task.start codes.task.read codes.task.cancel', fetchImpl,
    });

    async function call(method, path, subject, { body, signal } = {}) {
        const sig = signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000);
        const res = await fetchImpl(`${base}/api/v1${path}`, {
            method,
            headers: { Accept: 'application/json', 'X-OV-Subject': subject, ...(body ? { 'Content-Type': 'application/json' } : {}), ...(await tokens.authHeaders()) },
            body: body ? JSON.stringify(body) : undefined, signal: sig,
        });
        const data = await res.json().catch(() => null);
        return { status: res.status, ok: res.ok, data };
    }
    const why = (r) => (r.data && (r.data.detail || r.data.title)) || `OpenVibe.Codes answered ${r.status}`;

    async function adapter({ task, requester, signal, emit, taskId = null }) {
        if (!enabled) throw new ProviderError('OpenVibe.Codes is not connected to this server', { code: 'actor.agent.unavailable' });
        const subject = personOf(requester);
        if (!subject || !USER_SUBJECT.test(subject)) {
            throw new ProviderError(`Coding tasks run on your own machine through OpenVibe.Codes, so they need you signed in on openvibe.actor. You can also start one yourself at ${pages}/run`, { code: 'actor.agent.unavailable' });
        }
        const repo = repoIn(task);
        if (!repo) throw new ProviderError('Name the repository to work on, as its https address (for example https://github.com/you/project), and say what to change.', { code: 'actor.task.no_repo' });
        await emit({ step: 'tool_call', tool: 'codes.task.start', input: repo });
        const started = await call('POST', '/tasks', subject, { body: { repo, prompt: String(task).slice(0, 8000), ...(taskId ? { idempotency_key: String(taskId).slice(0, 128) } : {}) }, signal });
        if (started.status === 409 && started.data && started.data.code === 'codes.no_project') {
            throw new ProviderError(`Before Actor can send coding work to your machine: add the machine at https://openvibe.bot/machines, then start one task yourself at ${pages}/run (it picks the project your tasks run in).`, { code: 'actor.agent.unavailable' });
        }
        if (!started.ok || !started.data || !started.data.task) throw new ProviderError(why(started), { code: 'actor.agent.failed' });
        if (!TASK_ID.test(String(started.data.task.id))) throw new ProviderError('OpenVibe.Codes answered with no task id', { code: 'actor.agent.failed' });
        let t = started.data.task;
        await emit({ step: 'tool_result', tool: 'codes.task.start', text: `${LABEL[t.state] || t.state}: ${t.url}` });
        // Wait for the end, inside Actor's own task time: past it, the answer is the task's live page.
        const deadline = now() + Math.max(5_000, (config.taskTimeoutMs || 180_000) - 25_000);
        let shown = t.state;
        try {
            while (!TERMINAL.has(t.state) && now() < deadline) {
                await sleep(pollMs, signal);
                if (signal && signal.aborted) break;
                const r = await call('GET', `/tasks/${t.id}`, subject, { signal });
                if (r.ok && r.data) t = r.data;
                if (t.state !== shown) {
                    shown = t.state;
                    await emit({ step: 'text', text: `${LABEL[t.state] || t.state}.` });
                }
            }
        } finally {
            if (signal && signal.aborted && !TERMINAL.has(t.state)) {
                await call('POST', `/tasks/${t.id}/cancel`, subject).catch(() => null);
            }
        }
        if (signal && signal.aborted) throw new ProviderError('cancelled', { code: 'actor.task.cancelled' });
        const sources = [t.url];
        if (!TERMINAL.has(t.state)) {
            return { text: `${LABEL[t.state] || t.state}, and it is not done yet. Follow it live, and see the change when it ends: [the task on OpenVibe.Codes](${t.url})`, sources, model: 'openvibe-codes' };
        }
        if (t.state === 'expired') throw new ProviderError(`No machine of yours took the task in time. Is it online at https://openvibe.bot/machines, with the Codes job runner (install it with --worker)? The task: ${t.url}`, { code: 'actor.agent.failed' });
        if (t.state !== 'succeeded') throw new ProviderError(`The task ${t.state === 'cancelled' ? 'was cancelled' : 'failed'}${t.error ? `: ${t.error}` : ''}. ${t.url}`, { code: 'actor.agent.failed' });
        if (!t.result || !t.result.ok) throw new ProviderError(`The agents on your machine did not finish${t.result && t.result.error ? `: ${t.result.error}` : ''}. ${t.url}`, { code: 'actor.agent.failed' });
        return { text: answerOf(t), sources, model: (t.result.agents || [])[0] || 'openvibe-codes' };
    }

    return { enabled, adapter };
}

module.exports = { createCodes, repoIn, answerOf, personOf };

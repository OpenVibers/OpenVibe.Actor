'use strict';

/**
 * OpenVibe.Git (git.openvibe.codes), from the tool modules (not a module itself: the registry skips files starting
 * with "_"). Plan §AD.10 step 1 (the owner, 2026-11-15: "the agent can literally put any code on … completely,
 * agentically interact with git.openvibe.codes"): the git_repos_list, git_repo_create, git_files_write and
 * git_change_open tools.
 *
 * Actor calls Git with its own service token (audience openvibe.git, git.repo.read and git.repo.write; Network grants
 * them to actor) and names the person in X-OV-Subject: Git then acts as that person (their repositories, their
 * namespace; another person's private repository is the same 404 as none). A repository is made in the person's own
 * namespace, their username, read from Network (identity.subject.resolve, the grant Actor already uses to notify).
 *
 *   gitFor(ctx) → { enabled, call(method, path, person, body), username(person) }
 */

const { serviceAuth } = require('openvibe-contracts');

const SCOPE = 'git.repo.read git.repo.write';
const TIMEOUT_MS = 30_000;
const REPO = /^[a-z0-9][a-z0-9_.-]{0,38}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
const CACHE = new WeakMap();

function gitFor(ctx) {
    const config = ctx.config;
    if (!config) throw new Error('a tool needs ctx.config');
    const fetchImpl = ctx.fetch || globalThis.fetch;
    let byFetch = CACHE.get(config);
    if (!byFetch) { byFetch = new WeakMap(); CACHE.set(config, byFetch); }
    if (byFetch.has(fetchImpl)) return byFetch.get(fetchImpl);
    const base = String((config.services && config.services.gitUrl) || '').replace(/\/+$/, '');
    const clientSecret = config.oauth && config.oauth.clientSecret;
    const enabled = Boolean(base && clientSecret && config.networkInternalUrl);
    const client = (audience, scope) => serviceAuth.createTokenClient({
        tokenUrl: `${config.networkInternalUrl}/oauth/token`, clientId: (config.oauth && config.oauth.clientId) || 'actor', clientSecret, audience, scope, fetchImpl,
    });
    const tokens = enabled ? client('openvibe.git', SCOPE) : null;
    const resolveTokens = enabled ? client('openvibe.network', 'identity.subject.resolve') : null;
    const names = new Map();
    const git = {
        enabled,
        /** One call to Git for one person. Never throws for a refusal: the model reads the answer. */
        async call(method, path, person, body) {
            if (!enabled) return { ok: false, status: 503, error: 'OpenVibe.Git is not connected to this server' };
            if (!person) return { ok: false, status: 401, error: 'this works on your own repositories, so it needs you signed in' };
            const headers = { Accept: 'application/json', 'X-OV-Subject': person, ...(await tokens.authHeaders()) };
            if (body !== undefined) headers['Content-Type'] = 'application/json';
            let res;
            try {
                res = await fetchImpl(`${base}/api/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS) });
            } catch (err) {
                return { ok: false, status: 502, error: `OpenVibe.Git did not answer: ${(err && err.message) || err}` };
            }
            const text = await res.text().catch(() => '');
            let data = null;
            try { data = text ? JSON.parse(text) : null; } catch { data = null; }
            if (!res.ok) return { ok: false, status: res.status, error: String((data && (data.detail || data.error || data.title)) || text || `OpenVibe.Git answered ${res.status}`).slice(0, 300), data };
            return { ok: true, status: res.status, data };
        },
        /** The person's username (their namespace on Git), from Network; null when it cannot be read. */
        async username(person) {
            if (!enabled || !person) return null;
            if (names.has(person)) return names.get(person);
            try {
                const res = await fetchImpl(`${config.networkInternalUrl}/internal/identity/resolve?subject_id=${encodeURIComponent(person)}`, {
                    headers: { Accept: 'application/json', ...(await resolveTokens.authHeaders()) }, signal: AbortSignal.timeout(10_000),
                });
                if (!res.ok) return null;
                const who = await res.json();
                const name = who && !who.deleted && typeof who.username === 'string' ? who.username.toLowerCase() : null;
                if (name) names.set(person, name);
                return name;
            } catch { return null; }
        },
    };
    byFetch.set(fetchImpl, git);
    return git;
}

/** "owner/name" from a tool call (repo, or owner + name), or null when it names none that can exist. */
function repoOf(input) {
    const full = String((input && (input.repo || (input.owner && input.name ? `${input.owner}/${input.name}` : ''))) || '').trim().replace(/^https:\/\/git\.openvibe\.codes\//, '').replace(/\.git$/, '').replace(/\/+$/, '');
    return REPO.test(full) ? full : null;
}

const available = (ctx) => Boolean(ctx.config && ctx.config.services && ctx.config.services.gitUrl && ctx.config.oauth && ctx.config.oauth.clientSecret && ctx.config.networkInternalUrl);

/** A short answer for the model: the repository's address and the facts it needs, never the whole JSON. */
function repoLine(r) {
    if (!r || typeof r !== 'object') return null;
    return { repo: r.full_name || null, url: r.html_url || null, clone_url: r.clone_url || null, visibility: r.visibility || (r.private ? 'private' : 'public'), default_branch: r.default_branch || null, description: r.description || '' };
}

module.exports = { gitFor, repoOf, available, repoLine };

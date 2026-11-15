'use strict';
/**
 * The agent works on the person's own code on OpenVibe.Git (plan §AD.10 step 1; the owner, 2026-11-15: "the agent can
 * literally put any code on … completely, agentically interact with git.openvibe.codes"): git_repos_list,
 * git_repo_create, git_files_write, git_change_open.
 *
 * Actor calls Git with its own service token (audience openvibe.git) and names the person in X-OV-Subject; a repository
 * is made in the person's namespace (their username, read from Network). Writes are acting calls.
 */
const assert = require('assert');
const { createRegistry } = require('../server/runtime/tools');
const { check, done } = require('./helpers/boot');

const ME = 'usr_01M4W5JBFEG3QG9ER8W1A2K0RX';
const config = {
    networkInternalUrl: 'http://network.test',
    oauth: { clientId: 'actor', clientSecret: 'actor-secret' },
    services: { gitUrl: 'http://git.test' },
};

function fakeGit(handler) {
    const calls = [];
    const tokens = [];
    const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    const fetchImpl = async (url, init = {}) => {
        const u = new URL(url);
        if (u.pathname === '/oauth/token') { const f = new URLSearchParams(String(init.body || '')); tokens.push([f.get('audience'), f.get('scope')]); return reply(200, { access_token: `svc-${f.get('audience')}`, expires_in: 300 }); }
        if (u.host === 'network.test' && u.pathname === '/internal/identity/resolve') return reply(200, { username: 'Ada', network_user_id: 7 });
        const headers = init.headers || {};
        const call = { method: init.method || 'GET', path: u.pathname + u.search, subject: headers['X-OV-Subject'], auth: headers.Authorization, body: init.body ? JSON.parse(init.body) : null };
        calls.push(call);
        return handler(call, reply);
    };
    return { calls, tokens, fetchImpl };
}
const ctxFor = (fetchImpl, requester = `user:${ME}`) => ({ config, fetch: fetchImpl, requester, signal: undefined, log: console });
const registry = () => createRegistry({ strict: true, log: { warn() {}, log() {} } });

(async () => {
    await check('the git tools are offered to a signed-in person, writes act, and nobody else sees them', async () => {
        const r = registry();
        const names = r.definitions({ requester: `user:${ME}`, config }).map((d) => d.function.name);
        for (const t of ['git_repos_list', 'git_repo_create', 'git_files_write', 'git_change_open']) assert.ok(names.includes(t), `${t} is offered`);
        assert.ok(!r.definitions({ requester: null, config }).map((d) => d.function.name).includes('git_files_write'), 'a task with no person never sees them');
        for (const t of ['git_repo_create', 'git_files_write', 'git_change_open']) assert.strictEqual(r.get(t).acts, true, `${t} is an acting call`);
        assert.ok(!r.get('git_repos_list').acts, 'listing only reads');
        assert.ok(!r.get('git_files_write').available({ config: { services: {}, oauth: {} }, requester: `user:${ME}` }), 'without a Git address the tools are off');
    });

    await check('a repository is made in the person\'s namespace, as them, with Actor\'s own Git token', async () => {
        const git = fakeGit((c, reply) => (c.method === 'POST' && c.path === '/api/v1/repos' ? reply(201, { full_name: `ada/${c.body.name}`, html_url: `https://git.openvibe.codes/ada/${c.body.name}`, clone_url: 'x', visibility: c.body.visibility, default_branch: 'main' }) : reply(404, {})));
        const out = JSON.parse((await registry().run('git_repo_create', { name: 'My Portfolio!', private: true, starter: 'static' }, ctxFor(git.fetchImpl))).text);
        const c = git.calls[0];
        assert.deepStrictEqual([c.body.name, c.body.owner_username, c.body.visibility, c.body.starter], ['my-portfolio', 'ada', 'private', 'static'], 'a clean name, the person\'s username, private, the starter');
        assert.strictEqual(c.subject, ME, 'Git is told whom it is for');
        assert.strictEqual(c.auth, 'Bearer svc-openvibe.git', 'Actor\'s own token for openvibe.git');
        assert.ok(git.tokens.some(([aud, scope]) => aud === 'openvibe.git' && /git\.repo\.write/.test(scope)), 'the token asks for git.repo.write');
        assert.strictEqual(out.created.repo, 'ada/my-portfolio');
    });

    await check('files are one commit on a branch, and a change is opened from it', async () => {
        const git = fakeGit((c, reply) => {
            if (c.method === 'POST' && c.path === '/api/v1/repos/ada/site/commits') return reply(201, { sha: 'abc123', branch: c.body.branch });
            if (c.method === 'POST' && c.path === '/api/v1/repos/ada/site/changes') return reply(201, { number: 4 });
            return reply(404, { detail: 'No such repository.' });
        });
        const w = JSON.parse((await registry().run('git_files_write', { repo: 'https://git.openvibe.codes/ada/site.git', branch: 'agent/hello', message: 'Add the page', files: [{ path: 'index.html', content: '<h1>Hi</h1>' }, { path: '../escape', content: 'x' }] }, ctxFor(git.fetchImpl))).text);
        assert.deepStrictEqual(git.calls[0].body, { message: 'Add the page', files: [{ path: 'index.html', content: '<h1>Hi</h1>' }], branch: 'agent/hello' }, 'a path that climbs out is dropped');
        assert.strictEqual(w.committed.url, 'https://git.openvibe.codes/ada/site/commit/abc123');
        const o = JSON.parse((await registry().run('git_change_open', { repo: 'ada/site', head: 'agent/hello', base: 'main', title: 'A hello page', body: 'Adds index.html.' }, ctxFor(git.fetchImpl))).text);
        assert.deepStrictEqual(git.calls[1].body, { title: 'A hello page', body: 'Adds index.html.', base_ref: 'main', head_ref: 'agent/hello' });
        assert.strictEqual(o.opened.url, 'https://git.openvibe.codes/ada/site/changes/4');
        const refused = await registry().run('git_files_write', { repo: 'ada/nope', message: 'x', files: [{ path: 'a', content: 'b' }] }, ctxFor(git.fetchImpl));
        assert.ok(refused.isError && /No such repository/.test(refused.text), 'Git\'s refusal is read, not thrown');
    });

    await check('listing reads the person\'s own repositories', async () => {
        const git = fakeGit((c, reply) => reply(200, { repos: [{ full_name: 'ada/site', html_url: 'https://git.openvibe.codes/ada/site', visibility: 'public', default_branch: 'main' }] }));
        const out = JSON.parse((await registry().run('git_repos_list', { q: 'site' }, ctxFor(git.fetchImpl))).text);
        assert.ok(/^\/api\/v1\/repos\?mine=1/.test(git.calls[0].path) && /q=site/.test(git.calls[0].path));
        assert.deepStrictEqual(out.repos.map((r) => r.repo), ['ada/site']);
    });
    await done();
})().catch((e) => { console.error(e); process.exit(1); });

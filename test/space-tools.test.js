'use strict';
/**
 * Space's builder as a task of the person's one agent (plan 2026-10-22 §Z stage Z1): the space_* tools.
 *
 * The agent works on the person's own spaces through Space's builder API. Actor calls Space with its own service
 * token and names the person in X-OV-Subject, so Space reads and writes only that person's spaces. Publishing
 * never happens without the person's answer: the tool asks and waits.
 */
const assert = require('assert');
const { createRegistry } = require('../server/runtime/tools');
const { check, done } = require('./helpers/boot');

const ME = 'usr_01M4W5JBFEG3QG9ER8W1A2K0RX';
const OTHER = 'usr_01M4W5JBFEG3QG9ER8W1A2K0RY';
const SPACE = 'spc_01M4XENCR31NXDJQYDCCW2J9R9';

const config = {
    networkInternalUrl: 'http://network.test',
    oauth: { clientId: 'actor', clientSecret: 'actor-secret' },
    services: { spaceUrl: 'http://space.test' },
};

/** A fake OpenVibe.Space: it answers the token request, and records every call it gets. */
function fakeSpace(handler) {
    const calls = [];
    const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    const fetchImpl = async (url, init = {}) => {
        const u = new URL(url);
        if (u.pathname === '/oauth/token') return reply(200, { access_token: 'svc-space-token', expires_in: 300 });
        const headers = init.headers || {};
        calls.push({ method: init.method || 'GET', path: u.pathname, subject: headers['X-OV-Subject'], auth: headers.Authorization, body: init.body ? JSON.parse(init.body) : null });
        return handler({ method: init.method || 'GET', path: u.pathname, body: init.body ? JSON.parse(init.body) : null }, reply);
    };
    return { calls, fetchImpl };
}

const ctxFor = (fetchImpl, requester = `user:${ME}`) => ({ config, fetch: fetchImpl, requester, signal: undefined, log: console });

(async () => {
    await check('the space tools are offered to a signed-in person and to nobody else', async () => {
        const registry = createRegistry({ strict: true, log: { warn() {}, log() {} } });
        const names = registry.definitions({ requester: `user:${ME}`, config }).map((d) => d.function.name);
        for (const tool of ['space_create', 'space_files_list', 'space_files_read', 'space_files_write', 'space_preview', 'space_publish']) {
            assert.ok(names.includes(tool), `${tool} is offered to a signed-in person`);
        }
        const anonymous = registry.definitions({ requester: null, config }).map((d) => d.function.name);
        assert.ok(!anonymous.includes('space_files_write'), 'a task with no person never sees the space tools');
        assert.ok(!registry.get('space_files_write').available({ config: { services: {}, oauth: {} }, requester: `user:${ME}` }), 'without a Space address the tools are off');
    });

    await check('writing a space\'s files goes to Space as the person, with Actor\'s own token', async () => {
        const space = fakeSpace(({ path, body }, reply) => (path === `/api/v1/builder/spaces/${SPACE}/files` ? reply(200, { files: body.files }) : reply(404, { detail: 'no such space' })));
        const registry = createRegistry({ strict: true, log: { warn() {}, log() {} } });
        const out = await registry.run('space_files_write', { space_id: SPACE, files: [{ path: 'index.html', content: '<h1>Hi</h1>' }] }, ctxFor(space.fetchImpl));
        const call = space.calls[0];
        assert.strictEqual(call.method, 'PUT');
        assert.strictEqual(call.path, `/api/v1/builder/spaces/${SPACE}/files`);
        assert.strictEqual(call.subject, ME, 'the person is named for Space');
        assert.strictEqual(call.auth, 'Bearer svc-space-token', 'the call carries Actor\'s own service token');
        assert.deepStrictEqual(call.body.files, [{ path: 'index.html', content: '<h1>Hi</h1>' }]);
        assert.ok(!out.isError, out.text);
        assert.ok(out.text.includes('index.html'), out.text);
    });

    await check('another person\'s space is refused, and nothing is written', async () => {
        const space = fakeSpace(({ path }, reply) => reply(404, { detail: 'no such space' }));
        const registry = createRegistry({ strict: true, log: { warn() {}, log() {} } });
        const out = await registry.run('space_files_write', { space_id: SPACE, files: [{ path: 'index.html', content: 'x' }] }, ctxFor(space.fetchImpl));
        assert.ok(out.isError, 'the refusal is an error the model reads');
        assert.ok(out.text.includes('no such space'), out.text);
        assert.strictEqual(space.calls[0].subject, ME, 'the call still names the person, never another one');
    });

    await check('a task with no person cannot touch a space at all', async () => {
        const space = fakeSpace(() => { throw new Error('Space must not be called'); });
        const registry = createRegistry({ strict: true, log: { warn() {}, log() {} } });
        const out = await registry.run('space_files_write', { space_id: SPACE, files: [{ path: 'index.html', content: 'x' }] }, ctxFor(space.fetchImpl, null));
        assert.ok(out.isError && /signed in|not available/.test(out.text), out.text);
        assert.strictEqual(space.calls.length, 0, 'Space was never called');
    });

    await check('publishing asks first: the person answers before anything goes live', async () => {
        const space = fakeSpace(({ path }, reply) => (path === `/api/v1/builder/spaces/${SPACE}/publish` ? reply(200, { state: 'pending', approval_id: 'apr_01M4XENCR31NXDJQYDCCW2J9R9', url: null }) : reply(404, { detail: 'no such space' })));
        const registry = createRegistry({ strict: true, log: { warn() {}, log() {} } });
        const out = await registry.run('space_publish', { space_id: SPACE }, ctxFor(space.fetchImpl));
        assert.ok(!out.isError, out.text);
        assert.ok(out.text.includes('approve'), out.text);
        assert.ok(out.text.includes('Not published yet'), out.text);
        assert.strictEqual(space.calls[0].method, 'POST');
        assert.strictEqual(space.calls[0].path, `/api/v1/builder/spaces/${SPACE}/publish`);
    });

    await check('the preview says where the space can be seen, and the list says which spaces are theirs', async () => {
        const space = fakeSpace(({ path }, reply) => {
            if (path === `/api/v1/builder/spaces/${SPACE}/preview`) return reply(200, { url: 'https://openvibe.space/spaces/podcast/edit', files: ['index.html'], published: false });
            if (path === '/api/v1/builder/spaces') return reply(200, { spaces: [{ id: SPACE, name: 'Podcast' }] });
            return reply(404, { detail: 'no such space' });
        });
        const registry = createRegistry({ strict: true, log: { warn() {}, log() {} } });
        const preview = await registry.run('space_preview', { space_id: SPACE }, ctxFor(space.fetchImpl));
        assert.ok(preview.text.includes('openvibe.space/spaces/podcast/edit'), preview.text);
        const list = await registry.run('space_files_list', {}, ctxFor(space.fetchImpl));
        assert.ok(list.text.includes(SPACE), list.text);
    });

    done();
})().catch((e) => { console.error(e); process.exit(1); });

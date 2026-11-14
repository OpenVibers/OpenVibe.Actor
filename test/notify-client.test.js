'use strict';
// Network notifications for "hand it to me" (Desks plan D4, server/notify/client.js): the task's owner is resolved to
// Network's user id, then one notification is pushed as app actor with the link to the desk; never retried, never thrown.
const assert = require('assert');
const { createNotifier } = require('../server/notify/client');
const { check, done } = require('./helpers/boot');

const ME = 'usr_01M4W5JBFEG3QG9ER8W1A2K0RX';
const config = { networkInternalUrl: 'http://network.test', oauth: { clientId: 'actor', clientSecret: 'actor-secret' } };
const tokens = { authHeaders: async () => ({ Authorization: 'Bearer t' }) };
const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

(async () => {
    await check('resolve, then one push as app actor with the desk link; a person Network does not know is not told', async () => {
        const calls = [];
        const fetchImpl = async (url, init = {}) => {
            calls.push({ url: String(url), method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null });
            if (String(url).includes('/internal/identity/resolve')) return String(url).includes(ME) ? reply(200, { network_user_id: 42 }) : reply(404, { code: 'identity.subject_not_found' });
            return reply(200, { ok: true });
        };
        const n = createNotifier({ config, fetchImpl, tokens, log: { warn() {} } });
        const url = 'https://openvibe.link/machines/dev_01M4W5JBFDG2TJ8C4FRDMCWBZ9/screen?desk=desk-0123456789';
        assert.deepStrictEqual(await n.needsYou({ subject: ME, what: 'Sign in to the airline.', url }), { sent: true });
        assert.strictEqual(calls[0].url, `http://network.test/internal/identity/resolve?subject_id=${ME}`);
        assert.deepStrictEqual(calls[1].body, { user_id: 42, type: 'AGENT_NEEDS_YOU', category: 'service', priority: 'high', icon: '🙋', title: 'Your agent needs you', message: 'Sign in to the airline.', url, service: 'actor', rich_content: { step: 'Sign in to the airline.' } });
        calls.length = 0;
        await n.needsYou({ subject: ME, what: 'Run "ls" on your computer', kind: 'approve', title: 'Call the computer_run tool', url });
        const asked = calls.find((c) => c.method === 'POST').body;
        assert.strictEqual(asked.message, 'Run "ls" on your computer', 'the step alone: no prefix, no task text in brackets');
        assert.deepStrictEqual(asked.rich_content, { step: 'Run "ls" on your computer', kind: 'approve', task_title: 'Call the computer_run tool' });
        calls.length = 0;
        await n.needsYou({ subject: ME, what: 'x', kind: 'shout', url });
        assert.deepStrictEqual(calls.find((c) => c.method === 'POST').body.rich_content, { step: 'x' }, 'an unknown kind is left out');
        calls.length = 0;
        assert.deepStrictEqual(await n.needsYou({ subject: 'usr_01M4W5JBFEG3QG9ER8W1A2K0RY', what: 'x', url }), { sent: false, reason: 'unknown_subject' });
        assert.strictEqual(calls.filter((c) => c.method === 'POST').length, 0, 'only the known person was told');
        assert.deepStrictEqual(await n.needsYou({ subject: ME, what: 'x', url: 'http://evil.example/' }), { sent: false, reason: 'bad_input' }, 'only an https link');
    });

    await check('a task end names the task and the outcome and links to its page', async () => {
        const calls = [];
        const fetchImpl = async (url, init = {}) => {
            calls.push({ url: String(url), method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null });
            if (String(url).includes('/internal/identity/resolve')) return reply(200, { network_user_id: 42 });
            return reply(200, { ok: true });
        };
        const n = createNotifier({ config, fetchImpl, tokens, log: { warn() {} } });
        const taskId = 'tsk_01M4W5JBFEG3QG9ER8W1A2K0RX';
        const url = `https://openvibe.actor/tasks/${taskId}`;
        assert.deepStrictEqual(await n.taskEnded({ subject: ME, state: 'succeeded', taskId, title: 'Say hello.', url }), { sent: true });
        const done = calls.find((c) => c.method === 'POST').body;
        assert.strictEqual(done.type, 'AGENT_TASK_DONE');
        assert.strictEqual(done.message, 'Say hello.', 'the task itself, no "Done:" prefix');
        assert.strictEqual(done.url, url);
        assert.deepStrictEqual(done.rich_content, { task_id: taskId, state: 'succeeded', task_title: 'Say hello.' });
        calls.length = 0;
        await n.taskEnded({ subject: ME, state: 'failed', taskId, title: 'Plan the trip', url, detail: 'It ran too long.' });
        const failed = calls.find((c) => c.method === 'POST').body;
        assert.strictEqual(failed.type, 'AGENT_TASK_FAILED');
        assert.strictEqual(failed.message, 'Plan the trip — It ran too long.');
        assert.deepStrictEqual(failed.rich_content, { task_id: taskId, state: 'failed', task_title: 'Plan the trip', detail: 'It ran too long.' });
        assert.deepStrictEqual(await n.taskEnded({ subject: ME, state: 'failed', taskId: 'nope', title: 'x', url }), { sent: false, reason: 'bad_input' });
    });

    await check('the notice wears the agent\'s face (plan §AB.31)', async () => {
        const calls = [];
        const fetchImpl = async (url, init = {}) => {
            calls.push({ url: String(url), method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null });
            if (String(url).includes('/internal/identity/resolve')) return reply(200, { network_user_id: 42 });
            return reply(200, { ok: true });
        };
        const n = createNotifier({ config, fetchImpl, tokens, log: { warn() {} } });
        const url = 'https://openvibe.actor/tasks/tsk_01M4W5JBFEG3QG9ER8W1A2K0RX';
        const taskId = 'tsk_01M4W5JBFEG3QG9ER8W1A2K0RX';
        const agent = { id: 'agt_01M4W5JBFEG3QG9ER8W1A2K0RX', name: 'Researcher', avatar_url: 'https://openvibe.media/a.png', hue: 205, glyph: 'search' };
        await n.needsYou({ subject: ME, what: 'Sign in to the airline.', url, agent });
        const asked = calls.find((c) => c.method === 'POST').body;
        assert.deepStrictEqual(asked.rich_content.agent, agent, 'the step carries the agent');
        calls.length = 0;
        await n.taskEnded({ subject: ME, state: 'succeeded', taskId, title: 'Say hello.', url, agent });
        const done = calls.find((c) => c.method === 'POST').body;
        assert.deepStrictEqual(done.rich_content.agent, agent, 'the outcome carries the agent');
        calls.length = 0;
        await n.needsYou({ subject: ME, what: 'x', url, agent: { id: 'vibe', name: 'Vibe', avatar_url: 'http://not-https.example/a.png', hue: 400, glyph: 'not a glyph' } });
        const bare = calls.find((c) => c.method === 'POST').body.rich_content.agent;
        assert.deepStrictEqual(bare, { id: 'vibe', name: 'Vibe' }, 'only what is safe to show travels');
        calls.length = 0;
        await n.needsYou({ subject: ME, what: 'x', url });
        assert.strictEqual(calls.find((c) => c.method === 'POST').body.rich_content.agent, undefined, 'no agent, no face');
    });

    await check('a failure is an answer, never a throw; off without a client secret', async () => {
        const n = createNotifier({ config, fetchImpl: async () => { throw new Error('down'); }, tokens, log: { warn() {} } });
        assert.deepStrictEqual(await n.needsYou({ subject: ME, what: 'x', url: 'https://openvibe.bot/x' }), { sent: false, reason: 'error' });
        const off = createNotifier({ config: { networkInternalUrl: 'http://network.test', oauth: { clientId: 'actor', clientSecret: '' } } });
        assert.strictEqual(off.enabled, false);
        assert.deepStrictEqual(await off.needsYou({ subject: ME, what: 'x', url: 'https://openvibe.bot/x' }), { sent: false, reason: 'off' });
    });
    done();
})();

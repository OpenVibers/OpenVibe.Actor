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
        const url = 'https://openvibe.bot/machines/dev_01M4W5JBFDG2TJ8C4FRDMCWBZ9/screen?desk=desk-0123456789';
        assert.deepStrictEqual(await n.needsYou({ subject: ME, what: 'Sign in to the airline.', url }), { sent: true });
        assert.strictEqual(calls[0].url, `http://network.test/internal/identity/resolve?subject_id=${ME}`);
        assert.deepStrictEqual(calls[1].body, { user_id: 42, type: 'AGENT_NEEDS_YOU', category: 'service', priority: 'high', icon: '🙋', title: 'Your agent needs you', message: 'Sign in to the airline.', url, service: 'actor' });
        assert.deepStrictEqual(await n.needsYou({ subject: 'usr_01M4W5JBFEG3QG9ER8W1A2K0RY', what: 'x', url }), { sent: false, reason: 'unknown_subject' });
        assert.strictEqual(calls.filter((c) => c.method === 'POST').length, 1, 'only the known person was told');
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
        assert.match(done.message, /Done: Say hello\./);
        assert.strictEqual(done.url, url);
        assert.deepStrictEqual(done.rich_content, { task_id: taskId, state: 'succeeded' });
        calls.length = 0;
        await n.taskEnded({ subject: ME, state: 'failed', taskId, title: 'Plan the trip', url, detail: 'It ran too long.' });
        const failed = calls.find((c) => c.method === 'POST').body;
        assert.strictEqual(failed.type, 'AGENT_TASK_FAILED');
        assert.match(failed.message, /Not finished: Plan the trip — It ran too long\./);
        assert.deepStrictEqual(await n.taskEnded({ subject: ME, state: 'failed', taskId: 'nope', title: 'x', url }), { sent: false, reason: 'bad_input' });
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

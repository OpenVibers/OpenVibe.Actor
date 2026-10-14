'use strict';
// The person's own robots as runtime tools (plan T15/T17, agents/robots.js): only a signed-in person's task sees
// list_my_robots and robot_steps; Actor calls OpenVibe.Bot with its own service token and X-OV-Subject naming that
// person; a robot not opened to the agent says how to open it; Bot's refusals come back to the model as errors.
const assert = require('assert');
const { createOpenVibeTools, personOf } = require('../server/agents/tools');
const { createRobots } = require('../server/agents/robots');
const { check, done } = require('./helpers/boot');


const ME = 'usr_01M4W5JBFEG3QG9ER8W1A2K0RX';
const OPEN = 'rob_01M4W5JBFDG2TJ8C4FRDMCWBZ9';
const CLOSED = 'rob_01M4W5JBFDG2TJ8C4FRDMCWBZ8';
const config = {
    networkInternalUrl: 'http://network.test', oauth: { clientId: 'actor', clientSecret: 'actor-secret' },
    services: { searchUrl: 'http://search.test', toolsUrl: 'http://tools.test', botUrl: 'http://bot.test', botPublicUrl: 'https://openvibe.bot' },
};

/** A fake OpenVibe.Bot: the owner's two robots, one opened to the agent; records every call. */
function fakeBot() {
    const calls = [];
    const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    const fetchImpl = async (url, init = {}) => {
        const u = new URL(url);
        const headers = init.headers || {};
        calls.push({ method: init.method || 'GET', path: u.pathname + u.search, subject: headers['X-OV-Subject'], auth: headers.Authorization, body: init.body ? JSON.parse(init.body) : null });
        if (u.host === 'tools.test') return reply(200, { tools: [] });
        if (u.pathname === '/api/v1/robots') return reply(200, { robots: [{ id: OPEN, name: 'Desk rover', profile_id: 'sim.rover', agent_control: true }, { id: CLOSED, name: 'Cozmo', profile_id: 'cozmo', agent_control: false }] });
        if (u.pathname === `/api/v1/robots/${OPEN}/steps` && (init.method || 'GET') === 'GET') return reply(200, { robot_id: OPEN, online: true, estop: { latched: false }, battery: 0.8, sensors: { distance_cm: 42 }, steps: ['forward 2', 'stop'], max_steps: 20, max_seconds: 30 });
        if (u.pathname === `/api/v1/robots/${OPEN}/steps`) return reply(200, { robot_id: OPEN, result: 'done', steps: 2 });
        if (u.pathname === `/api/v1/robots/${CLOSED}/steps`) return reply(403, { code: 'bot.agent_not_allowed', detail: 'the owner has not let their agent drive this robot' });
        return reply(404, { code: 'not_found' });
    };
    return { calls, fetchImpl };
}
const tokens = { authHeaders: async () => ({ Authorization: 'Bearer svc-token' }) };

(async () => {
    await check('only a signed-in person\'s task gets the robot tools', async () => {
        const bot = fakeBot();
        const t = createOpenVibeTools({ config, fetchImpl: bot.fetchImpl, robots: createRobots({ config, fetchImpl: bot.fetchImpl, tokens }) });
        const names = async (requester) => (await t.definitions({ requester })).map((d) => d.function.name);
        assert.ok((await names(`user:${ME}`)).includes('robot_steps') && (await names(`user:${ME}`)).includes('list_my_robots'));
        for (const r of ['app:app_x', 'agent:agt_x', 'service:live', null]) assert.ok(!(await names(r)).includes('robot_steps'), String(r));
        assert.strictEqual(personOf(`user:${ME}`), ME);
        assert.strictEqual(personOf('app:app_x'), null);
        const refused = JSON.parse(await t.call('robot_steps', { robot: OPEN, steps: ['forward 1'] }, { requester: 'app:app_x' }));
        assert.match(refused.error, /signed-in person/);
        assert.ok(!bot.calls.some((c) => c.path.includes('/robots')), 'nothing reached Bot for an app');
    });

    await check('list_my_robots: the person\'s robots, state and steps for the opened one, how to open the other', async () => {
        const bot = fakeBot();
        const t = createOpenVibeTools({ config, fetchImpl: bot.fetchImpl, robots: createRobots({ config, fetchImpl: bot.fetchImpl, tokens }) });
        const list = JSON.parse(await t.call('list_my_robots', {}, { requester: `user:${ME}` }));
        assert.strictEqual(list.length, 2);
        assert.deepStrictEqual([list[0].online, list[0].steps, list[0].sensors.distance_cm], [true, ['forward 2', 'stop'], 42]);
        assert.match(list[1].note, /Let my OpenVibe\.Actor agent drive this robot.*https:\/\/openvibe\.bot\/panel\/rob_\w+#agent/);
        assert.ok(bot.calls.filter((c) => c.path.startsWith('/api/v1/robots')).every((c) => c.subject === ME && c.auth === 'Bearer svc-token'), 'as the person, with Actor\'s token');
        assert.ok(bot.calls.some((c) => c.path === `/api/v1/robots?owner=${ME}`));
        assert.ok(!bot.calls.some((c) => c.path === `/api/v1/robots/${CLOSED}/steps`), 'a closed robot is not asked');
    });

    await check('robot_steps: step lines go to Bot as the person; a refusal comes back as an error; bad input never leaves', async () => {
        const bot = fakeBot();
        const t = createOpenVibeTools({ config, fetchImpl: bot.fetchImpl, robots: createRobots({ config, fetchImpl: bot.fetchImpl, tokens }) });
        const ok = JSON.parse(await t.call('robot_steps', { robot: OPEN, steps: ['forward 1', 'stop'] }, { requester: `user:${ME}` }));
        assert.deepStrictEqual(ok, { result: 'done', steps: 2 });
        const sent = bot.calls.find((c) => c.method === 'POST');
        assert.deepStrictEqual([sent.path, sent.subject, sent.body], [`/api/v1/robots/${OPEN}/steps`, ME, { steps: 'forward 1\nstop' }]);
        const no = JSON.parse(await t.call('robot_steps', { robot: CLOSED, steps: ['forward 1'] }, { requester: `user:${ME}` }));
        assert.deepStrictEqual([no.code, /not let their agent/.test(no.error)], ['bot.agent_not_allowed', true]);
        const before = bot.calls.length;
        assert.match(JSON.parse(await t.call('robot_steps', { robot: '../admin', steps: ['x'] }, { requester: `user:${ME}` })).error, /robot id/);
        assert.match(JSON.parse(await t.call('robot_steps', { robot: OPEN, steps: [] }, { requester: `user:${ME}` })).error, /one or more lines/);
        assert.strictEqual(bot.calls.length, before, 'neither reached Bot');
    });

    await check('off without a Bot URL or a client secret', async () => {
        assert.strictEqual(createRobots({ config: { ...config, services: { ...config.services, botUrl: '' } } }).enabled, false);
        assert.strictEqual(createRobots({ config: { ...config, oauth: { clientId: 'actor', clientSecret: '' } } }).enabled, false);
        const t = createOpenVibeTools({ config: { ...config, services: { ...config.services, botUrl: '' } }, fetchImpl: fakeBot().fetchImpl });
        assert.ok(!(await t.definitions({ requester: `user:${ME}` })).some((d) => d.function.name === 'robot_steps'));
    });

    done();
})();

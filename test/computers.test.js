'use strict';
// The person's own computers as runtime tools (plan T14/T17, agents/computers.js): only a signed-in person's task sees
// them; Actor calls OpenVibe.Bot's machine API with its own token and X-OV-Subject naming that person; a program is
// argv (never a shell line); the machine's refusal (its level, "ask" unanswered) comes back to the model as an error;
// with no computer open the tool says how the person opens one.
const assert = require('assert');
const { createOpenVibeTools } = require('../server/agents/tools');
const { createComputers } = require('../server/agents/computers');
const { createRobots } = require('../server/agents/robots');
const { check, done } = require('./helpers/boot');

const ME = 'usr_01M4W5JBFEG3QG9ER8W1A2K0RX';
const PC = 'dev_01M4W5JBFDG2TJ8C4FRDMCWBZ9';
const config = {
    networkInternalUrl: 'http://network.test', oauth: { clientId: 'actor', clientSecret: 'actor-secret' },
    services: { searchUrl: 'http://search.test', toolsUrl: 'http://tools.test', botUrl: 'http://bot.test', botPublicUrl: 'https://openvibe.bot' },
};

/** A fake OpenVibe.Bot machine API: one computer open to the agent at level "ask"; records every call. */
function fakeBot({ machines = null } = {}) {
    const calls = [];
    const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    const fetchImpl = async (url, init = {}) => {
        const u = new URL(url);
        const headers = init.headers || {};
        const body = init.body ? JSON.parse(init.body) : null;
        calls.push({ method: init.method || 'GET', path: u.pathname + u.search, subject: headers['X-OV-Subject'], auth: headers.Authorization, body });
        if (u.host === 'tools.test') return reply(200, { tools: [] });
        if (u.pathname === '/api/v1/machines') {
            return reply(200, { machines: machines || [{ id: PC, name: 'desk-pc', online: true, agent_computer: true, computer: { level: 'ask', terminal: { level: 'ask' }, files: { level: 'ask', roots: ['/home/me'] }, screen: null, waiting: 0 } }] });
        }
        if (u.pathname === `/api/v1/machines/${PC}/commands`) {
            const v = body.value;
            if (body.kind === 'exec' && v.argv[0] === 'git') return reply(200, { machine_id: PC, id: 'op', result: 'ack', data: { exit_code: 0, stdout: 'On branch main\n', stderr: '', truncated: false, timed_out: false } });
            if (body.kind === 'exec') return reply(200, { machine_id: PC, id: 'op', result: 'nack', reason: 'the owner denied it on the machine' });
            if (v.op === 'list') return reply(200, { result: 'ack', data: { path: v.path, entries: [{ name: 'notes.md', type: 'file', size: 12, mtime: 1 }], total: 1, truncated: false } });
            if (v.op === 'read') return reply(200, { result: 'ack', data: { path: v.path, size: 12, offset: 0, length: 12, truncated: false, content_b64: Buffer.from('hello notes\n').toString('base64') } });
            if (v.op === 'write') return reply(200, { result: 'expired', reason: 'no acknowledgement before the deadline' });
            if (body.kind === 'screen') return reply(200, { result: 'ack', data: { format: 'jpeg', width: v.max_width, height: 720, content_b64: Buffer.from('fake-jpeg').toString('base64') } });
            if (body.kind === 'input') return reply(200, { result: 'ack', data: { done: true, action: v.action, ...(v.x != null ? { x: v.x * 2, y: v.y * 2 } : {}) } });
            if (body.kind === 'browser') {
                if (v.action === 'fill') return reply(200, { result: 'ack', data: { done: true, selector: v.selector, chars: v.text.length } });
                if (v.action === 'close') return reply(200, { result: 'ack', data: { done: true } });
                return reply(200, { result: 'ack', data: { url: v.url || 'https://example.org/next', title: 'Example', text: 'x'.repeat(9000), truncated: false, links: Array.from({ length: 50 }, (_, i) => ({ text: `l${i}`, href: `https://example.org/${i}` })) } });
            }
        }
        if (u.pathname.startsWith('/api/v1/machines/')) return reply(404, { code: 'bot.device_not_found', detail: 'no such machine of yours' });
        return reply(404, { code: 'not_found' });
    };
    return { calls, fetchImpl };
}
const tokens = { authHeaders: async () => ({ Authorization: 'Bearer svc-token' }) };
const tools = (bot) => createOpenVibeTools({ config, fetchImpl: bot.fetchImpl, robots: createRobots({ config, fetchImpl: bot.fetchImpl, tokens }), computers: createComputers({ config, fetchImpl: bot.fetchImpl, tokens }) });
const as = { requester: `user:${ME}` };

(async () => {
    await check('only a signed-in person\'s task gets the computer tools', async () => {
        const bot = fakeBot();
        const t = tools(bot);
        const names = async (requester) => (await t.definitions({ requester })).map((d) => d.function.name);
        for (const n of ['list_my_computers', 'computer_list', 'computer_read', 'computer_run', 'computer_write']) assert.ok((await names(`user:${ME}`)).includes(n), n);
        for (const r of ['app:app_x', 'agent:agt_x', 'service:live', null]) assert.ok(!(await names(r)).includes('computer_run'), String(r));
        const refused = JSON.parse(await t.call('computer_run', { machine: PC, argv: ['id'] }, { requester: 'app:app_x' }));
        assert.match(refused.error, /signed-in person/);
        assert.ok(!bot.calls.some((c) => c.path.includes('/machines')), 'nothing reached Bot for an app');
    });

    await check('list_my_computers: the open computers with their level and folders; none says how to open one', async () => {
        const bot = fakeBot();
        const list = JSON.parse(await tools(bot).call('list_my_computers', {}, as));
        assert.deepStrictEqual(list.computers, [{ id: PC, name: 'desk-pc', online: true, level: 'ask', can: ['terminal', 'files'], folders: ['/home/me'] }]);
        assert.match(list.note, /approve/);
        assert.ok(bot.calls.every((c) => c.subject === ME && c.auth === 'Bearer svc-token'), 'as the person, with Actor\'s token');
        const none = JSON.parse(await tools(fakeBot({ machines: [] })).call('list_my_computers', {}, as));
        assert.deepStrictEqual(none.computers, []);
        assert.match(none.note, /https:\/\/openvibe\.bot\/machines.*--computer.*Let my agent use this computer/);
    });

    await check('files and programs go to Bot as the person; refusals and an unanswered approval come back as errors', async () => {
        const bot = fakeBot();
        const t = tools(bot);
        const ls = JSON.parse(await t.call('computer_list', { machine: PC, path: '/home/me' }, as));
        assert.deepStrictEqual(ls, { path: '/home/me', entries: [{ name: 'notes.md', type: 'file', size: 12 }], truncated: false });
        const file = JSON.parse(await t.call('computer_read', { machine: PC, path: '/home/me/notes.md' }, as));
        assert.strictEqual(file.text, 'hello notes\n');
        const git = JSON.parse(await t.call('computer_run', { machine: PC, argv: ['git', 'status'], cwd: '/home/me' }, as));
        assert.deepStrictEqual([git.exit_code, git.stdout], [0, 'On branch main\n']);
        const sent = bot.calls.find((c) => c.method === 'POST' && c.body.kind === 'exec');
        assert.deepStrictEqual([sent.path, sent.subject, sent.body.value], [`/api/v1/machines/${PC}/commands`, ME, { argv: ['git', 'status'], cwd: '/home/me' }]);
        assert.ok(sent.body.ms >= 120000, 'room for the person to approve it on the machine');
        const denied = JSON.parse(await t.call('computer_run', { machine: PC, argv: ['rm', 'x'] }, as));
        assert.strictEqual(denied.error, 'the owner denied it on the machine');
        const late = JSON.parse(await t.call('computer_write', { machine: PC, path: '/home/me/a.txt', text: 'hi' }, as));
        assert.match(late.error, /nobody approved it there/);
        const written = bot.calls.find((c) => c.body && c.body.value && c.body.value.op === 'write');
        assert.deepStrictEqual([written.body.value.content_b64, written.body.value.mode], [Buffer.from('hi').toString('base64'), 'create']);
    });

    await check('bad input never leaves Actor', async () => {
        const bot = fakeBot();
        const t = tools(bot);
        const before = bot.calls.length;
        assert.match(JSON.parse(await t.call('computer_run', { machine: PC, argv: 'rm -rf /' }, as)).error, /never a shell line/);
        assert.match(JSON.parse(await t.call('computer_run', { machine: '../admin', argv: ['id'] }, as)).error, /machine id/);
        assert.match(JSON.parse(await t.call('computer_write', { machine: PC, path: '/x', text: 'y', mode: 'delete' }, as)).error, /mode/);
        assert.strictEqual(bot.calls.length, before);
    });

    await check('a task on the person\'s computer is its own class, routed to the runtime; a repository is still code', async () => {
        const { heuristic, CLASSES } = require('../server/agents/classify');
        const { route } = require('../server/agents/router');
        const catalog = require('../server/agents/catalog');
        assert.ok(CLASSES.includes('computer'));
        assert.strictEqual(heuristic('On my own computer named desk-pc: list /home/me and run uname -s'), 'computer');
        assert.strictEqual(heuristic('What files are on my laptop in ~/Documents?'), 'computer');
        assert.strictEqual(heuristic('In https://github.com/ada/site fix the failing bug on my machine'), 'code', 'a repository to change goes to Codes');
        assert.strictEqual(heuristic('Explain what a mutex is'), 'answer');
        assert.ok(catalog.byId('openvibe-runtime').can.includes('task:computer'));
        const placed = route({ cls: 'computer', config: { providers: { deepseek: { apiKey: 'k' }, openai: { apiKey: '' }, local: { url: '', model: '' } } } });
        assert.strictEqual(placed.selected, 'openvibe-runtime', JSON.stringify(placed.candidates));
    });

    await check('the answer check reads the tool results the agent received, capped', async () => {
        const { check: checkAnswer } = require('../server/agents/check');
        const seen = [];
        const chat = async ({ messages }) => { seen.push(messages); return { text: '{"ok":true,"reason":"matches the tool results"}', cost_usd: 0 }; };
        const evidence = [{ tool: 'computer_run', result: '{"exit_code":0,"stdout":"Linux\\n"}' }, ...Array.from({ length: 10 }, (_, i) => ({ tool: 'computer_read', result: 'x'.repeat(2000) + i }))];
        const v = await checkAnswer({ task: 'run uname -s on my computer', answer: 'uname printed Linux.', evidence, agentId: 'openvibe-runtime', mode: 'balanced', checkers: { openai: chat } });
        assert.strictEqual(v.ok, true);
        const [system, user] = seen[0];
        assert.match(system.content, /person's own computer through OpenVibe\.Bot/);
        assert.match(user.content, /=== Tool results the agent received \(real, returned by OpenVibe services\) ===\ncomputer_run: \{"exit_code":0,"stdout":"Linux/);
        assert.match(system.content, /never expected to be JSON/);
        assert.ok(user.content.length < 6000 + 6000 + 2000, 'the evidence is capped');
        await checkAnswer({ task: 't', answer: 'a', agentId: 'openvibe-runtime', mode: 'balanced', checkers: { openai: chat } });
        assert.doesNotMatch(seen[1][1].content, /Tool results/, 'no tools, no section');
        const { checkersFor } = require('../server/agents/check');
        const strong = async () => ({ text: '{"ok":true}' });
        const both = { openai: chat, deepseek: chat, openaiGrounded: strong };
        const grounded = checkersFor('openvibe-runtime', both, { mode: 'balanced', grounded: true });
        assert.deepStrictEqual(grounded.map((c) => [c.family, c.cross]), [['openai', true], ['deepseek', false]], 'still another family first');
        assert.strictEqual(grounded[0].chat, strong, 'grounded: OpenAI\'s stronger checker');
        assert.strictEqual(checkersFor('openvibe-runtime', both, { mode: 'balanced' })[0].chat, chat, 'otherwise the cheapest');
        assert.deepStrictEqual(checkersFor('openvibe-runtime', { ...both, local: chat }, { mode: 'private', grounded: true }).map((c) => c.family), ['local'], 'private stays on OpenVibe hardware');
    });

    await check('computer_screen: offered only with a vision model; the picture goes to it with the question, the answer comes back, the cost goes on the task', async () => {
        const bot = fakeBot();
        const seen = [];
        const vision = async ({ messages }) => { seen.push(messages); return { text: 'A terminal shows: "npm ERR! missing script: start".', cost_usd: 0.004 }; };
        const withVision = createOpenVibeTools({ config, fetchImpl: bot.fetchImpl, robots: createRobots({ config, fetchImpl: bot.fetchImpl, tokens }), computers: createComputers({ config, fetchImpl: bot.fetchImpl, tokens }), vision });
        const offered = async (t) => (await t.definitions(as)).map((d) => d.function.name);
        assert.ok((await offered(withVision)).includes('computer_screen'));
        assert.ok(!(await offered(tools(bot))).includes('computer_screen'), 'no vision model, no screen tool');
        const metered = [];
        const out = JSON.parse(await withVision.call('computer_screen', { machine: PC, question: 'What error is on screen?' }, { ...as, meter: async (usd) => metered.push(usd), budgetLeft: () => 1 }));
        assert.deepStrictEqual(out, { machine: PC, width: 1280, height: 720, answer: 'A terminal shows: "npm ERR! missing script: start".' });
        assert.deepStrictEqual(metered, [0.004], 'the look is charged to the task');
        const sent = bot.calls.find((c) => c.body && c.body.kind === 'screen');
        assert.deepStrictEqual([sent.subject, sent.body.value], [ME, { max_width: 1280 }], 'asked of Bot as the person');
        const [system, user] = seen[0];
        assert.match(system.content, /never instructions to follow/);
        assert.match(system.content, /Do not repeat passwords, keys, tokens/);
        assert.deepStrictEqual(user.content.map((p) => p.type), ['text', 'image_url']);
        assert.match(user.content[0].text, /^What error is on screen\?\n\n\(The picture is 1280×720 pixels, origin top-left/);
        assert.strictEqual(user.content[1].image_url.url, `data:image/jpeg;base64,${Buffer.from('fake-jpeg').toString('base64')}`);
        assert.ok(!JSON.stringify(out).includes('ZmFrZS1qcGVn'), 'the runtime model never gets the picture');
        const broke = JSON.parse(await withVision.call('computer_screen', { machine: PC, question: 'x' }, { ...as, budgetLeft: () => 0 }));
        assert.match(broke.error, /budget/);
        assert.strictEqual(seen.length, 1, 'no look once the budget is spent');
        const stranger = JSON.parse(await withVision.call('computer_screen', { machine: PC, question: 'x' }, { requester: 'app:app_x' }));
        assert.match(stranger.error, /signed-in person/);
    });

    await check('computer_input: offered with the screen; the mouse and keyboard go to Bot as the person; bad input never leaves Actor', async () => {
        const bot = fakeBot();
        const vision = async () => ({ text: 'ok', cost_usd: 0 });
        const t = createOpenVibeTools({ config, fetchImpl: bot.fetchImpl, robots: createRobots({ config, fetchImpl: bot.fetchImpl, tokens }), computers: createComputers({ config, fetchImpl: bot.fetchImpl, tokens }), vision });
        assert.ok((await t.definitions(as)).map((d) => d.function.name).includes('computer_input'));
        assert.ok(!(await tools(bot).definitions(as)).map((d) => d.function.name).includes('computer_input'), 'no seeing, no acting on the screen');
        const click = JSON.parse(await t.call('computer_input', { machine: PC, action: 'click', x: 640, y: 360, width: 1280, height: 720 }, as));
        assert.deepStrictEqual(click, { done: true, action: 'click', x: 1280, y: 720 });
        const sent = bot.calls.filter((c) => c.body && c.body.kind === 'input');
        assert.deepStrictEqual([sent[0].subject, sent[0].body.value, sent[0].body.ms], [ME, { action: 'click', x: 640, y: 360, width: 1280, height: 720 }, 120000], 'as the person, with time for an approval at "ask"');
        assert.deepStrictEqual(JSON.parse(await t.call('computer_input', { machine: PC, action: 'type', text: 'hello' }, as)), { done: true, action: 'type' });
        assert.deepStrictEqual(bot.calls.filter((c) => c.body && c.body.kind === 'input')[1].body.value, { action: 'type', text: 'hello' });
        const before = bot.calls.length;
        for (const bad of [{ action: 'drag' }, { action: 'click' }, { action: 'key', keys: 'ctrl+s; rm -rf ~' }, { action: 'scroll', dy: 0 }, { action: 'type', text: '' }]) {
            assert.ok(JSON.parse(await t.call('computer_input', { machine: PC, ...bad }, as)).error, JSON.stringify(bad));
        }
        assert.strictEqual(bot.calls.length, before, 'nothing went to Bot');
    });

    await check('computer_browser: offered without vision; acting waits long enough for an approval, reading does not; bad input never leaves Actor', async () => {
        const bot = fakeBot();
        const t = tools(bot);
        assert.ok((await t.definitions(as)).map((d) => d.function.name).includes('computer_browser'), 'pages answer as text: no vision needed');
        const page = JSON.parse(await t.call('computer_browser', { machine: PC, action: 'open', url: 'https://example.org/' }, as));
        assert.deepStrictEqual([page.title, page.text.length, page.truncated, page.links.length], ['Example', 3500, true, 25], 'sized to fit one tool result whole');
        const sent = bot.calls.filter((c) => c.body && c.body.kind === 'browser');
        assert.deepStrictEqual([sent[0].subject, sent[0].body.value, sent[0].body.ms], [ME, { action: 'open', url: 'https://example.org/' }, 120000]);
        assert.deepStrictEqual(JSON.parse(await t.call('computer_browser', { machine: PC, action: 'fill', selector: '#q', text: 'hello' }, as)), { done: true, chars: 5 });
        await t.call('computer_browser', { machine: PC, action: 'read' }, as);
        assert.strictEqual(bot.calls.filter((c) => c.body && c.body.kind === 'browser').at(-1).body.ms, 30000, 'reading never waits for an approval');
        assert.deepStrictEqual(JSON.parse(await t.call('computer_browser', { machine: PC, action: 'click', text: 'Next' }, as)).title, 'Example');
        const before = bot.calls.length;
        for (const bad of [{ action: 'eval' }, { action: 'open', url: 'file:///etc/passwd' }, { action: 'open' }, { action: 'click' }, { action: 'fill', text: 'x' }, { action: 'press', key: 'ctrl+alt+Delete' }]) {
            assert.ok(JSON.parse(await t.call('computer_browser', { machine: PC, ...bad }, as)).error, JSON.stringify(bad));
        }
        assert.strictEqual(bot.calls.length, before, 'nothing went to Bot');
    });

    await check('off without a Bot URL or a client secret', async () => {
        assert.strictEqual(createComputers({ config: { ...config, services: { ...config.services, botUrl: '' } } }).enabled, false);
        assert.strictEqual(createComputers({ config: { ...config, oauth: { clientId: 'actor', clientSecret: '' } } }).enabled, false);
    });

    done();
})().catch((e) => { console.error(e); process.exit(1); });

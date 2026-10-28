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
const MAC = 'dev_01M4W5JBFDG2TJ8C4FRDMCWBZA';
const OLD = 'dev_01M4W5JBFDG2TJ8C4FRDMCWBZB';
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
            if (body.kind === 'desk') return reply(200, { result: 'ack', data: { running: v.action !== 'stop', display: ':91', width: v.width || 1280, height: v.height || 800, window_manager: 'openbox' } });
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

    await check('computer_desk and desk "private": the agent works on a desk of its own, never the person\'s screen; bad sizes never leave Actor', async () => {
        const bot = fakeBot({ machines: [{ id: PC, name: 'desk-pc', online: true, agent_computer: true, computer: { level: 'trusted', screen: { level: 'trusted' }, input: { level: 'trusted' }, browser: { level: 'trusted' }, desk: { level: 'trusted', window_manager: 'openbox', input: true, screen: true }, waiting: 0 } }] });
        const vision = async () => ({ text: 'An empty desktop.', cost_usd: 0 });
        const t = createOpenVibeTools({ config, fetchImpl: bot.fetchImpl, robots: createRobots({ config, fetchImpl: bot.fetchImpl, tokens }), computers: createComputers({ config, fetchImpl: bot.fetchImpl, tokens }), vision });
        const defs = await t.definitions(as);
        assert.ok(defs.some((d) => d.function.name === 'computer_desk'), 'offered with the computer tools');
        ['computer_screen', 'computer_input', 'computer_browser'].forEach((n) => assert.deepStrictEqual(defs.find((d) => d.function.name === n).function.parameters.properties.desk.enum, ['main', 'private'], n));
        assert.deepStrictEqual(JSON.parse(await t.call('list_my_computers', {}, as)).computers[0].can, ['screen', 'input', 'browser', 'desk'], 'the model sees the machine has a desk');
        assert.deepStrictEqual(JSON.parse(await t.call('computer_desk', { machine: PC, action: 'start', width: 1920, height: 1080 }, as)), { watch: `https://openvibe.bot/machines/${PC}/screen?desk=private`, running: true, display: ':91', width: 1920, height: 1080 }, 'with the link to watch and take it over (Desks plan D4)');
        const started = bot.calls.filter((c) => c.body && c.body.kind === 'desk').at(-1);
        assert.deepStrictEqual([started.subject, started.body.value, started.body.ms], [ME, { action: 'start', width: 1920, height: 1080 }, 120000], 'as the person, with time for an approval');
        const look = JSON.parse(await t.call('computer_screen', { machine: PC, question: 'What is open?', desk: 'private' }, as));
        assert.strictEqual(look.desk, 'private');
        assert.deepStrictEqual(bot.calls.filter((c) => c.body && c.body.kind === 'screen').at(-1).body.value, { max_width: 1280, desk: 'private' });
        await t.call('computer_input', { machine: PC, action: 'click', x: 10, y: 10, width: 1280, height: 800, desk: 'private' }, as);
        assert.strictEqual(bot.calls.filter((c) => c.body && c.body.kind === 'input').at(-1).body.value.desk, 'private');
        await t.call('computer_browser', { machine: PC, action: 'open', url: 'https://example.org/', desk: 'private' }, as);
        assert.strictEqual(bot.calls.filter((c) => c.body && c.body.kind === 'browser').at(-1).body.value.desk, 'private');
        await t.call('computer_browser', { machine: PC, action: 'read' }, as);
        assert.strictEqual(bot.calls.filter((c) => c.body && c.body.kind === 'browser').at(-1).body.value.desk, undefined, 'without desk "private", the person\'s own screen, as before');
        assert.deepStrictEqual(JSON.parse(await t.call('computer_desk', { machine: PC, action: 'stop' }, as)).running, false);
        const before = bot.calls.length;
        for (const bad of [{ action: 'reboot' }, { action: 'start', width: 100, height: 100 }, { action: 'start', width: 1280 }]) {
            assert.ok(JSON.parse(await t.call('computer_desk', { machine: PC, ...bad }, as)).error, JSON.stringify(bad));
        }
        assert.strictEqual(bot.calls.length, before, 'nothing went to Bot');
    });

    await check('each task its own desk (Desks plan D1): on a machine that runs several, desk "private" is a desk named for the run; the run stops it at the end; a model never names one', async () => {
        const many = { level: 'trusted', screen: { level: 'trusted' }, input: { level: 'trusted' }, browser: { level: 'trusted' }, desk: { level: 'trusted', window_manager: 'openbox', input: true, screen: true, named: true, max_desks: 4 } };
        const bot = fakeBot({ machines: [{ id: PC, name: 'desk-pc', online: true, agent_computer: true, computer: many }] });
        const vision = async () => ({ text: 'A page.', cost_usd: 0 });
        const t = createOpenVibeTools({ config, fetchImpl: bot.fetchImpl, robots: createRobots({ config, fetchImpl: bot.fetchImpl, tokens }), computers: createComputers({ config, fetchImpl: bot.fetchImpl, tokens }), vision });
        assert.strictEqual(JSON.parse(await t.call('list_my_computers', {}, as)).computers[0].desks_at_once, 4, 'the model sees it runs several');
        const a = t.deskRun();
        const b = t.deskRun();
        assert.match(a.name, /^desk-[0-9a-f]{10}$/);
        assert.notStrictEqual(a.name, b.name, 'two runs, two desks');
        const last = (kind) => bot.calls.filter((c) => c.body && c.body.kind === kind).at(-1).body.value;
        await t.call('computer_desk', { machine: PC, action: 'start' }, { ...as, desks: a });
        assert.deepStrictEqual(last('desk'), { action: 'start', desk: a.name }, 'run a starts its own desk');
        await t.call('computer_desk', { machine: PC, action: 'start' }, { ...as, desks: b });
        assert.strictEqual(last('desk').desk, b.name, 'run b another');
        await t.call('computer_browser', { machine: PC, action: 'open', url: 'https://example.org/', desk: 'private' }, { ...as, desks: a });
        assert.strictEqual(last('browser').desk, a.name);
        const look = JSON.parse(await t.call('computer_screen', { machine: PC, question: 'What is open?', desk: 'private' }, { ...as, desks: b }));
        assert.strictEqual(last('screen').desk, b.name);
        assert.strictEqual(look.desk, 'private', 'the model only ever sees its "private" desk');
        // A model cannot reach another task's desk by naming it.
        const before = bot.calls.length;
        const sneaky = JSON.parse(await t.call('computer_browser', { machine: PC, action: 'read', desk: a.name }, { ...as, desks: b }));
        assert.match(sneaky.error, /desk is "private"/);
        assert.strictEqual(bot.calls.length, before, 'nothing went to Bot');
        // The run's end stops its own desk only.
        await t.closeDesks(a, as.requester);
        assert.deepStrictEqual(last('desk'), { action: 'stop', desk: a.name });
        assert.strictEqual(bot.calls.filter((c) => c.body && c.body.kind === 'desk' && c.body.value.action === 'stop').length, 1, 'b keeps its desk');
        await t.closeDesks(a, as.requester);
        assert.strictEqual(bot.calls.filter((c) => c.body && c.body.kind === 'desk' && c.body.value.action === 'stop').length, 1, 'closing twice stops nothing more');
        // A machine on an older Node: the run's desk is the machine's one private desk, as before.
        const old = fakeBot({ machines: [{ id: PC, name: 'desk-pc', online: true, agent_computer: true, computer: { ...many, desk: { level: 'trusted', window_manager: 'openbox', input: true, screen: true } } }] });
        const t2 = createOpenVibeTools({ config, fetchImpl: old.fetchImpl, robots: createRobots({ config, fetchImpl: old.fetchImpl, tokens }), computers: createComputers({ config, fetchImpl: old.fetchImpl, tokens }), vision });
        await t2.call('computer_desk', { machine: PC, action: 'start' }, { ...as, desks: t2.deskRun() });
        assert.deepStrictEqual(old.calls.filter((c) => c.body && c.body.kind === 'desk').at(-1).body.value, { action: 'start' });
    });

    await check('browser desks (Desks plan D2, Node v0.23.0): a task\'s desk is a browser alone where the machine runs them, a whole desk when the model asks or the machine has no browser desks; an older Node is sent no kind', async () => {
        const desk = { level: 'trusted', window_manager: 'openbox', input: true, screen: true, named: true, max_desks: 2 };
        const machines = [
            { id: PC, name: 'desk-pc', online: true, agent_computer: true, computer: { level: 'trusted', browser: { level: 'trusted' }, desk: { ...desk, kinds: ['desktop', 'browser'] } } },
            { id: MAC, name: 'macbook', online: true, agent_computer: true, computer: { level: 'trusted', browser: { level: 'trusted' }, desk: { ...desk, window_manager: null, kinds: ['browser'] } } },
            { id: OLD, name: 'old-pc', online: true, agent_computer: true, computer: { level: 'trusted', browser: { level: 'trusted' }, desk } },
        ];
        const bot = fakeBot({ machines });
        const t = createOpenVibeTools({ config, fetchImpl: bot.fetchImpl, robots: createRobots({ config, fetchImpl: bot.fetchImpl, tokens }), computers: createComputers({ config, fetchImpl: bot.fetchImpl, tokens }), vision: async () => ({ text: 'x', cost_usd: 0 }) });
        const listed = JSON.parse(await t.call('list_my_computers', {}, as)).computers;
        assert.deepStrictEqual(listed.map((m) => m.desk_kinds), [['desktop', 'browser'], ['browser'], undefined], 'the model sees which kinds each runs');
        const last = () => bot.calls.filter((c) => c.body && c.body.kind === 'desk').at(-1).body.value;
        const run = t.deskRun();
        await t.call('computer_desk', { machine: PC, action: 'start' }, { ...as, desks: run });
        assert.deepStrictEqual(last(), { action: 'start', desk: run.name, kind: 'browser' }, 'web work: a browser desk by default');
        const whole = t.deskRun();
        await t.call('computer_desk', { machine: PC, action: 'start', kind: 'desktop' }, { ...as, desks: whole });
        assert.strictEqual(last().kind, 'desktop', 'a whole desk when the model asks');
        await t.call('computer_desk', { machine: MAC, action: 'start' }, { ...as, desks: t.deskRun() });
        assert.strictEqual(last().kind, 'browser');
        await t.call('computer_desk', { machine: OLD, action: 'start' }, { ...as, desks: t.deskRun() });
        assert.strictEqual(last().kind, undefined, 'an older Node is sent no kind');
        await t.call('computer_desk', { machine: PC, action: 'stop' }, { ...as, desks: run });
        assert.deepStrictEqual(last(), { action: 'stop', desk: run.name }, 'stop takes no kind');
        // Kept sign-ins (Node v0.24.0): a machine that keeps profiles starts every task's desk from the agent's profile.
        const keeps = fakeBot({ machines: [{ ...machines[0], computer: { ...machines[0].computer, desk: { ...machines[0].computer.desk, profiles: true } } }] });
        const t3 = createOpenVibeTools({ config, fetchImpl: keeps.fetchImpl, robots: createRobots({ config, fetchImpl: keeps.fetchImpl, tokens }), computers: createComputers({ config, fetchImpl: keeps.fetchImpl, tokens }), vision: async () => ({ text: 'x', cost_usd: 0 }) });
        assert.strictEqual(JSON.parse(await t3.call('list_my_computers', {}, as)).computers[0].keeps_sign_ins, true);
        const kept = t3.deskRun();
        await t3.call('computer_desk', { machine: PC, action: 'start', profile: 'someone-else' }, { ...as, desks: kept });
        assert.deepStrictEqual(keeps.calls.filter((c) => c.body && c.body.kind === 'desk').at(-1).body.value, { action: 'start', desk: kept.name, kind: 'browser', profile: 'agent' }, 'the agent\'s kept profile, never the model\'s choice');
        assert.strictEqual(last().profile, undefined, 'a machine that keeps none is sent none');
        // Apps on a desk (Node v0.26.0): computer_run on the task's own desk, detached; never detached on the person's screen.
        const apps = fakeBot({ machines: [{ ...machines[0], computer: { ...machines[0].computer, terminal: { level: 'trusted', desks: true }, desk: { ...machines[0].computer.desk } } }] });
        const t4 = createOpenVibeTools({ config, fetchImpl: apps.fetchImpl, robots: createRobots({ config, fetchImpl: apps.fetchImpl, tokens }), computers: createComputers({ config, fetchImpl: apps.fetchImpl, tokens }), vision: async () => ({ text: 'x', cost_usd: 0 }) });
        assert.strictEqual(JSON.parse(await t4.call('list_my_computers', {}, as)).computers[0].apps_on_desk, true);
        const office = t4.deskRun();
        await t4.call('computer_desk', { machine: PC, action: 'start', kind: 'desktop' }, { ...as, desks: office });
        await t4.call('computer_run', { machine: PC, argv: ['libreoffice', '--writer'], desk: 'private', detach: true }, { ...as, desks: office });
        const exec = apps.calls.filter((c) => c.body && c.body.kind === 'exec').at(-1).body.value;
        assert.deepStrictEqual(exec, { argv: ['libreoffice', '--writer'], desk: office.name, detach: true }, 'on the task\'s own desk, never another');
        const execs = () => apps.calls.filter((c) => c.body && c.body.kind === 'exec').length;
        const n = execs();
        assert.match(JSON.parse(await t4.call('computer_run', { machine: PC, argv: ['xterm'], detach: true }, { ...as, desks: office })).error, /desk "private"/);
        assert.strictEqual(execs(), n, 'never detached on the person\'s screen');
        // Placement (Desks plan D6): machine "any" goes to a desk host before a person's own computer, the next one when full.
        const HOST = 'dev_01M4W5JBFDG2TJ8C4FRDMCWBZC';
        const place = fakeBot({ machines: [
            { id: PC, name: 'laptop', online: true, agent_computer: true, computer: { level: 'trusted', screen: { level: 'trusted' }, browser: { level: 'trusted' }, desk: { ...desk, kinds: ['desktop', 'browser'] }, desks_running: 0 } },
            { id: HOST, name: 'old-laptop', online: true, agent_computer: true, computer: { level: 'trusted', browser: { level: 'trusted' }, desk: { ...desk, kinds: ['desktop', 'browser'] }, desks_running: 1 } },
        ] });
        const inner = place.fetchImpl;
        let hostFull = false;
        const sentTo = [];   // [machine, kind] of each command, whichever machine it went to
        place.fetchImpl = async (url, init = {}) => {
            const body = init.body ? JSON.parse(init.body) : null;
            const target = (/\/machines\/(dev_[0-9A-Z]+)\/commands/.exec(String(url)) || [])[1];
            if (target && body) sentTo.push([target, body.kind]);
            if (hostFull && body && body.kind === 'desk' && body.value.action === 'start' && target === HOST) {
                return new Response(JSON.stringify({ machine_id: HOST, id: 'op', result: 'nack', reason: 'this machine already runs desk-x (browser), its limit (max_desks 2; a browser desk counts as half): stop one first' }), { status: 200, headers: { 'content-type': 'application/json' } });
            }
            return inner(target === HOST ? String(url).replace(HOST, PC) : url, init);   // the fake answers for one machine
        };
        const t5 = createOpenVibeTools({ config, fetchImpl: place.fetchImpl, robots: createRobots({ config, fetchImpl: place.fetchImpl, tokens }), computers: createComputers({ config, fetchImpl: place.fetchImpl, tokens }), vision: async () => ({ text: 'x', cost_usd: 0 }) });
        const r1 = t5.deskRun();
        const placed = JSON.parse(await t5.call('computer_desk', { machine: 'any', action: 'start' }, { ...as, desks: r1 }));
        assert.strictEqual(placed.machine, HOST, 'a desk host first, though it runs one desk already');
        await t5.call('computer_browser', { machine: 'any', action: 'open', url: 'https://example.org/', desk: 'private' }, { ...as, desks: r1 });
        assert.deepStrictEqual(sentTo.at(-1), [HOST, 'browser'], '"any" then means the machine its desk is on');
        hostFull = true;
        const r2 = t5.deskRun();
        assert.strictEqual(JSON.parse(await t5.call('computer_desk', { machine: 'any', action: 'start' }, { ...as, desks: r2 })).machine, PC, 'the next machine when one is full');
        assert.match(JSON.parse(await t5.call('computer_screen', { machine: 'any', question: 'x', desk: 'private' }, { ...as, desks: t5.deskRun() })).error, /start one with computer_desk/);
        const deskCommands = () => bot.calls.filter((c) => c.body && c.body.kind === 'desk').length;
        const before = deskCommands();
        assert.match(JSON.parse(await t.call('computer_desk', { machine: PC, action: 'start', kind: 'vm' }, { ...as, desks: t.deskRun() })).error, /kind is browser/);
        assert.strictEqual(deskCommands(), before, 'a bad kind never reaches the machine');
    });

    await check('computer_browser with element refs and receipts (Desks plan D3, Node v0.21.0): a ref clicks exactly that element; the result says what changed and lists the page\'s elements', async () => {
        const bot = fakeBot({ machines: [{ id: PC, name: 'desk-pc', online: true, agent_computer: true, computer: { level: 'trusted', browser: { level: 'trusted' } } }] });
        const inner = bot.fetchImpl;
        const elements = Array.from({ length: 90 }, (_, i) => `e${i + 1} button "Item ${i + 1}"`);
        bot.fetchImpl = async (url, init = {}) => {
            const body = init.body ? JSON.parse(init.body) : null;
            if (body && body.kind === 'browser' && body.value.action === 'click') {
                bot.calls.push({ method: 'POST', path: new URL(url).pathname, body });
                return new Response(JSON.stringify({ result: 'ack', data: { url: 'https://example.org/app', title: 'App', text: 'y'.repeat(9000), truncated: false, links: [{ text: 'x', href: 'https://example.org/x' }], elements, receipt: { url_changed: false, appeared: ['Row added'], gone: 1 } } }), { status: 200, headers: { 'content-type': 'application/json' } });
            }
            return inner(url, init);
        };
        const t = createOpenVibeTools({ config, fetchImpl: bot.fetchImpl, robots: createRobots({ config, fetchImpl: bot.fetchImpl, tokens }), computers: createComputers({ config, fetchImpl: bot.fetchImpl, tokens }) });
        const out = await t.call('computer_browser', { machine: PC, action: 'click', ref: 'e7' }, as);
        assert.strictEqual(bot.calls.at(-1).body.value.selector, '[data-ov-ref="e7"]', 'the ref names exactly that element');
        const r = JSON.parse(out);
        assert.deepStrictEqual(r.changed, { url: false, appeared: ['Row added'], gone: 1 });
        assert.strictEqual(r.elements.length, 60, 'the first 60 elements');
        assert.strictEqual(r.elements[6], 'e7 button "Item 7"');
        assert.strictEqual(r.links, undefined, 'links are among the elements');
        assert.strictEqual(r.text.length, 2200);
        assert.ok(out.length <= 6000, `one tool result stays whole: ${out.length}`);
        const before = bot.calls.length;
        for (const bad of [{ action: 'click', ref: 'button' }, { action: 'open', url: 'https://example.org/', ref: 'e1' }, { action: 'click', ref: 'e1"]' }]) {
            assert.match(JSON.parse(await t.call('computer_browser', { machine: PC, ...bad }, as)).error, /ref is an element/, JSON.stringify(bad));
        }
        assert.strictEqual(bot.calls.length, before, 'nothing went to Bot');
    });

    await check('a desk on a desk host when none of the person\'s computers has one (Desks plan D6, OpenVibe.Run sessions)', async () => {
        const SES = 'ses_01JD2C3D4E5F6G7H8J9K0MNPQR';
        const runCalls = [];
        const bot = fakeBot({ machines: [] });   // no computer open to the agent
        const inner = bot.fetchImpl;
        bot.fetchImpl = async (url, init = {}) => {
            const u = new URL(url);
            if (u.host !== 'run.test') return inner(url, init);
            const body = init.body ? JSON.parse(init.body) : null;
            runCalls.push({ method: init.method || 'GET', path: u.pathname, subject: (init.headers || {})['X-OV-Subject'], body });
            const session = (state) => ({ id: SES, state, owner: { type: 'user', id: ME } });
            const reply = (status, b) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
            if (u.pathname === '/api/v1/sessions' && init.method === 'POST') return reply(201, session('running'));
            if (u.pathname === `/api/v1/sessions/${SES}/commands`) return reply(200, { session_id: SES, id: 'c', result: 'ack', state: 'running', data: { url: body.value.url || 'https://example.org/', title: 'Example', text: 'hello', truncated: false, links: [] } });
            if (u.pathname === `/api/v1/sessions/${SES}/end`) return reply(200, session('ended'));
            return reply(404, { code: 'run.session.not_found' });
        };
        const cfg = { ...config, services: { ...config.services, runUrl: 'http://run.test' } };
        const t = createOpenVibeTools({ config: cfg, fetchImpl: bot.fetchImpl, robots: createRobots({ config: cfg, fetchImpl: bot.fetchImpl, tokens }), computers: createComputers({ config: cfg, fetchImpl: bot.fetchImpl, tokens }), vision: async () => ({ text: 'x', cost_usd: 0 }) });
        const run = t.deskRun('tsk_1');
        const placed = JSON.parse(await t.call('computer_desk', { machine: 'any', action: 'start' }, { ...as, desks: run }));
        assert.deepStrictEqual([placed.machine, placed.running, placed.kind], [`run:${SES}`, true, 'browser'], JSON.stringify(placed));
        assert.deepStrictEqual(runCalls[0].body, { kind: 'browser', ttl_s: 3600, idle_s: 900, idempotency_key: 'actor:tsk_1' });
        assert.strictEqual(runCalls[0].subject, ME, 'as the person');
        const page = JSON.parse(await t.call('computer_browser', { machine: 'any', action: 'open', url: 'https://example.org/a', desk: 'private' }, { ...as, desks: run }));
        assert.strictEqual(page.title, 'Example');
        const sent = runCalls.find((c) => c.path.endsWith('/commands'));
        assert.deepStrictEqual(sent.body, { kind: 'browser', value: { action: 'open', url: 'https://example.org/a' } }, 'Run names the desk: Actor never does');
        assert.match(JSON.parse(await t.call('computer_run', { machine: `run:${SES}`, argv: ['id'] }, { ...as, desks: run })).error, /browser only/);
        assert.ok(!JSON.parse(await t.call('hand_to_person', { machine: 'any', what: 'Sign in.' }, { ...as, desks: run })).watch, 'no take-over link for a desk host');
        await t.closeDesks(run, as.requester);
        assert.ok(runCalls.some((c) => c.path === `/api/v1/sessions/${SES}/end`), 'the session ends with the task');
        // Without Run (no runUrl), the old answer stands.
        const off = createOpenVibeTools({ config, fetchImpl: bot.fetchImpl, robots: createRobots({ config, fetchImpl: bot.fetchImpl, tokens }), computers: createComputers({ config, fetchImpl: bot.fetchImpl, tokens }) });
        assert.match(JSON.parse(await off.call('computer_desk', { machine: 'any', action: 'start' }, { ...as, desks: off.deskRun() })).error, /none of the person's computers runs desks/);
    });

    await check('off without a Bot URL or a client secret', async () => {
        assert.strictEqual(createComputers({ config: { ...config, services: { ...config.services, botUrl: '' } } }).enabled, false);
        assert.strictEqual(createComputers({ config: { ...config, oauth: { clientId: 'actor', clientSecret: '' } } }).enabled, false);
    });

    done();
})().catch((e) => { console.error(e); process.exit(1); });

'use strict';
/**
 * computer_page_check (plan §AD.25, Design's eyes): a page drawn on the person's computer (Link's page_check) as a phone
 * and a desktop, dark and light. The computers client sends Link the page check with its defaults and checks the URL,
 * widths and themes in words; the tool answers each view's measured faults and what a vision model sees in its picture,
 * reading every picture at once, and keeps the pictures off the model's words.
 *   node test/page-check.test.js
 */
const assert = require('assert');
const { createComputers } = require('../server/agents/computers');

const ME = 'usr_01M4W5JBFEG3QG9ER8W1A2K0RX';
const PC = 'dev_01M4W5JBFDG2TJ8C4FRDMCWBZ9';
const config = { networkInternalUrl: 'http://network.test', services: { botUrl: 'http://bot.test', botPublicUrl: 'https://openvibe.bot' } };
const VIEWS = [
    { width: 390, theme: 'dark', metrics: { width: 390, scroll_width: 708, overflow: { count: 1, examples: ['div.wide ends at 708px'] }, small_targets: { count: 1, of: 2, examples: ['button#tiny 20x20'] }, small_text: { count: 0, examples: [] }, native_controls: { count: 1, examples: ['select#pick'] }, images_without_alt: { count: 1, examples: [] } }, screenshot: { format: 'jpeg', width: 390, height: 844, content_b64: Buffer.from('phone').toString('base64') } },
    { width: 1280, theme: 'dark', metrics: { width: 1280, scroll_width: 1280, overflow: { count: 0, examples: [] }, small_targets: { count: 0, of: 2, examples: [] }, small_text: { count: 0 }, native_controls: { count: 1, examples: ['select#pick'] }, images_without_alt: { count: 1 } }, screenshot: { format: 'jpeg', width: 900, height: 632, content_b64: Buffer.from('desk').toString('base64') } },
];

const results = [];
const ok = async (name, fn) => { try { await fn(); console.log(`  ✓ ${name}`); } catch (e) { results.push(e); console.log(`  ✗ ${name}\n      ${(e.stack || e).toString().split('\n').slice(0, 6).join('\n      ')}`); } };

function fakeBot() {
    const calls = [];
    const fetchImpl = async (url, init = {}) => {
        const u = new URL(url);
        const body = init.body ? JSON.parse(init.body) : null;
        calls.push({ path: u.pathname, subject: (init.headers || {})['X-OV-Subject'], body });
        const reply = (status, b) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
        if (u.pathname === '/api/v1/machines') return reply(200, { machines: [{ id: PC, name: 'desk-pc', online: true, agent_computer: true, computer: { level: 'ask' } }] });
        if (u.pathname === `/api/v1/machines/${PC}/commands` && body.kind === 'browser' && body.value.action === 'page_check') {
            return reply(200, { result: 'ack', data: { url: body.value.url, title: 'Faulty', views: VIEWS.filter((v) => body.value.widths.includes(v.width)) } });
        }
        return reply(404, { code: 'not_found' });
    };
    return { calls, fetchImpl };
}
const tokens = { authHeaders: async () => ({ Authorization: 'Bearer svc-token' }) };

(async () => {
    await ok('the client sends Link a page check with its defaults, and checks the address, widths and themes in words', async () => {
        const bot = fakeBot();
        const pcs = createComputers({ config, fetchImpl: bot.fetchImpl, tokens });
        const out = await pcs.browser(ME, PC, { action: 'check', url: 'https://shop.example/' });
        const sent = bot.calls.find((c) => c.body && c.body.kind === 'browser');
        assert.deepStrictEqual(sent.body.value, { action: 'page_check', url: 'https://shop.example/', widths: [390, 1280], themes: ['dark', 'light'], shots: true });
        assert.strictEqual(sent.subject, ME, 'as the person');
        assert.deepStrictEqual([out.title, out.views.length], ['Faulty', 2]);
        assert.match((await pcs.browser(ME, PC, { action: 'check', url: 'file:///etc/passwd' })).error, /http or https/);
        assert.match((await pcs.browser(ME, PC, { action: 'check', url: 'https://x.example/', widths: [100] })).error, /from 320 to 1920/);
        assert.match((await pcs.browser(ME, PC, { action: 'check', url: 'https://x.example/', themes: ['sepia'] })).error, /dark, light or both/);
    });

    await ok('the tool: each view\'s faults and what a vision model sees, every picture read at once, no picture in the words', async () => {
        const opened = require('../server/runtime/tools/_openvibe');
        const bot = fakeBot();
        const pcs = createComputers({ config, fetchImpl: bot.fetchImpl, tokens });
        const real = opened.serviceFor;
        opened.serviceFor = () => ({ pcs });
        delete require.cache[require.resolve('../server/runtime/tools/computer_page_check')];
        const tool = require('../server/runtime/tools/computer_page_check');
        opened.serviceFor = real;
        const asked = [];
        let open = 0, most = 0;
        const models = { chat: async (req) => { open += 1; most = Math.max(most, open); asked.push(req); await new Promise((r) => setTimeout(r, 30)); open -= 1; return { text: req.messages[1].content[0].text.includes('390') ? 'The wide grey box sticks out on the right.' : 'nothing wrong; the list reads well', cost_usd: 0.001 }; } };
        let metered = 0;
        const ctx = { requester: `user:${ME}`, config, models, meter: async (c) => { metered += c; }, signal: undefined, state: {} };
        const out = await tool.run({ machine: PC, url: 'https://shop.example/', themes: ['dark'] }, ctx);
        assert.strictEqual(out.isError, undefined, out.text);
        const v = out.data.views;
        assert.deepStrictEqual(v.map((x) => [x.width, x.theme]), [[390, 'dark'], [1280, 'dark']]);
        assert.deepStrictEqual([v[0].sticks_out.count, v[0].sticks_out.page_width, v[0].small_targets.examples[0], v[0].native_controls.count, v[0].pictures_without_alt], [1, 708, 'button#tiny 20x20', 1, 1]);
        assert.deepStrictEqual([v[1].sticks_out, v[1].small_targets], [0, 0], 'nothing measured is said as 0');
        assert.deepStrictEqual(v.map((x) => x.seen), ['The wide grey box sticks out on the right.', 'nothing wrong; the list reads well']);
        assert.strictEqual(asked.length, 2);
        assert.strictEqual(asked[0].tier, 'vision');
        assert.match(asked[0].messages[1].content[1].image_url.url, /^data:image\/jpeg;base64,/);
        assert.strictEqual(most, 2, 'the pictures were read at once');
        assert.ok(Math.abs(metered - 0.002) < 1e-9, 'each reading metered');
        assert.ok(!out.text.includes('content_b64') && !out.text.includes(Buffer.from('phone').toString('base64')), 'no picture in the words');
        assert.strictEqual(tool.acts, true, 'it opens a page: an act');
    });

    console.log(results.length ? `\n${results.length} failed` : '\nall passed');
    process.exit(results.length ? 1 : 0);
})();

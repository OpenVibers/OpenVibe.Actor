'use strict';
// Screenshots for one-agent system, stage 1 (not run by test/run.js: only *.test.js are): the empty chat, a chat with a
// running task, and Settings, at 390 and 1280, with the overflow and 44 px checks printed for the report.
// Usage: node test/one-page-shots.js <outdir>
const fs = require('fs');
const path = require('path');
const h = require('openvibe-shared/browser-harness');
const { boot } = require('./helpers/boot');
const store = require('../server/tasks/store');

(async () => {
    const out = process.argv[2] || path.join(__dirname, '..', '..', 'research-2026-11-12', 'actor-shots');
    fs.mkdirSync(out, { recursive: true });
    const t = await boot();
    const kim = t.network.addUser('kim');
    const nora = t.network.addUser('nora');
    const s = t.ctx.s;
    const runId = s.newId('tsk');
    await store.insertTask(s, { id: runId, requester: `user:${kim.subject}`, task: 'Check the certificate of example.com and tell me what expires first', mode: 'balanced', budget_task: 0.05, budget_day: 0.5, created_at: s.iso() });
    await store.updateTask(s, runId, { state: 'running' });
    await store.appendEvent(s, runId, { kind: 'output', step: 'plan', text: 'Step 1 of 3 · Read the certificate', at: s.iso() });
    await store.appendEvent(s, runId, { kind: 'output', step: 'tool_call', tool: 'read_page', input: 'https://example.com', at: s.iso() });
    await store.appendEvent(s, runId, { kind: 'output', step: 'tool_call', tool: 'web_search', input: 'example.com certificate expiry', at: s.iso() });
    await store.appendEvent(s, runId, { kind: 'output', step: 'text', text: 'The page is read; checking the certificate dates now.', at: s.iso() });

    const browser = await h.launch({});
    const pages = [['empty', '/chat', nora], ['running', `/chat/${runId}`, kim], ['settings', '/chat/settings', nora]];
    try {
        for (const [name, url, user] of pages) {
            for (const width of [390, 1280]) {
                const page = await h.openPage(browser, await browser.newContext(), { width, height: 1500 });
                await page.send('Network.setCookie', { name: 'actor_at', value: t.signIn(user).replace(/^actor_at=/, ''), url: t.base, path: '/' });
                await page.goto(t.base + url, { maxMs: 10000 });
                await new Promise((r) => setTimeout(r, 1400));
                const shot = path.join(out, `${name}-${width}.png`);
                const png = await page.send('Page.captureScreenshot', { format: 'png' });
                fs.writeFileSync(shot, Buffer.from(png.data, 'base64'));
                const read = await page.evaluate(`(() => {
                    const seen = (e) => e.closest('.cc-composer, .ct-composer-wrap, .ct-now, .ct-run, .ct-suggest, .ct-settings');
                    const small = [...document.querySelectorAll('button, a, input, select, textarea')].filter((e) => {
                        const r = e.getBoundingClientRect(), st = getComputedStyle(e);
                        return seen(e) && st.display !== 'none' && st.visibility !== 'hidden' && r.width > 0 && r.height > 0 && !e.hidden && e.type !== 'hidden' && (r.height < 44 || r.width < 44);
                    }).slice(0, 8).map((e) => { const r = e.getBoundingClientRect(); return e.tagName.toLowerCase() + '.' + String(e.className || '').split(' ')[0] + ' ' + Math.round(r.width) + 'x' + Math.round(r.height); });
                    const wide = [...document.querySelectorAll('main *')].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && (r.right > innerWidth + 1 || r.left < -1); })
                        .slice(0, 6).map((e) => e.tagName.toLowerCase() + '.' + String(e.className || '').split(' ')[0]);
                    return { sw: document.documentElement.scrollWidth, iw: innerWidth, wide, small };
                })()`);
                process.stdout.write(`${shot}  scrollWidth=${read.sw}/${read.iw}${read.wide.length ? `  WIDE ${read.wide.join(', ')}` : ''}${read.small.length ? `  SMALL ${read.small.join(', ')}` : ''}\n`);
                await page.close();
            }
        }
    } finally {
        await browser.close();
        await t.close();
    }
    process.exit(0);
})().catch((e) => { process.stderr.write(String(e && e.stack)); process.exit(1); });

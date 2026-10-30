'use strict';
// Shots for Actor v2 stage V2-10 (not run by test/run.js): the Trace fold closed and open, and the Bench offer
// confirmation, at 390 and 1280 px in dark and light. Usage: node test/shots-v2-10.js <outdir>
const fs = require('fs');
const path = require('path');
const http = require('http');
const { boot } = require('./helpers/boot');

const PLAYWRIGHT = '/home/workstation/openvibe/work/OpenVibe.Games/node_modules/playwright';
const CHROME = '/usr/bin/google-chrome';
const SAME = { 'sec-fetch-site': 'same-origin' };
const toolCall = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });

(async () => {
    const out = process.argv[2];
    if (!out) throw new Error('usage: node test/shots-v2-10.js <outdir>');
    fs.mkdirSync(out, { recursive: true });
    const t = await boot();
    const kim = t.network.addUser('kim');
    t.config.loop.selfReflections = 0;

    t.providers.state.script = [
        { content: 'Checking the fixture.', tool_calls: [toolCall('c1', 'calculate', { expression: '2+2' })] },
        { content: 'The fixture price is **4 EUR** [E1].' },
    ];
    const created = await t.get('/api/v1/tasks', { as: kim, json: { task: 'What does the fixture say the price is?' }, headers: SAME });
    const id = created.json().id;
    const row = await t.waitFor(id);
    if (row.state !== 'succeeded') throw new Error(`task did not finish: ${row.error_detail}`);
    const result = typeof row.result === 'string' ? JSON.parse(row.result) : row.result;
    result.answer = 'The fixture price is **4 EUR** [E1].\n\nIt was read from the fixture file, not from memory.';
    await t.ctx.s.db.query('UPDATE tasks SET result = $2::jsonb WHERE id = $1', [id, JSON.stringify(result)]);

    // A realistic trace: a delegate with two child calls under it, model, tool, check, and one failed call. Numbers and
    // names only, as the real writer stores them.
    const s = t.ctx.s;
    const at = (sec) => new Date(Date.now() - (60 - sec) * 1000).toISOString();
    const span = (kind, name, parent, started, ms, cost, ok = true, code = null, step = 1) => s.db.query(
        `INSERT INTO actor_spans (id, task_id, parent_id, kind, name, tier, family, started_at, ms, cost_usd, tokens_in, tokens_out, ok, error_code, step)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
        [s.newId('spn'), id, parent, kind, name, kind === 'tool' ? null : 'smart', kind === 'tool' ? null : 'deepseek', at(started), ms, cost, kind === 'tool' ? null : 1200, kind === 'tool' ? null : 180, ok, code, step],
    );
    await span('model', 'deepseek:deepseek-flash', null, 1, 1800, 0.0012);
    await span('tool', 'search_web', null, 3, 420, 0.0002);
    const delegate = s.newId('spn');
    await s.db.query(
        `INSERT INTO actor_spans (id, task_id, parent_id, kind, name, tier, family, started_at, ms, cost_usd, ok, step)
         VALUES ($1, $2, NULL, 'delegate', 'delegate', 'best', NULL, $3, 2500, 0, true, 2)`,
        [delegate, id, at(5)],
    );
    await span('model', 'deepseek:deepseek-flash', delegate, 6, 1300, 0.0008, true, null, 2);
    await span('tool', 'calculate', delegate, 8, 12, 0, true, null, 2);
    await span('tool', 'read_page', null, 10, 900, 0, false, 'actor.tool.failed', 3);
    await span('check', 'deepseek:deepseek-flash', null, 12, 700, 0.0004, true, null, null);

    const pages = {
        '/task-trace': (await t.get(`/tasks/${id}`, { as: kim })).text,
        '/offer-confirm': (await t.get(`/tasks/${id}/offer-bench`, { as: kim })).text,
    };
    const cookie = t.signIn(kim);
    const proxy = http.createServer(async (req, res) => {
        if (pages[req.url]) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(pages[req.url]); }
        // The navbar asks /auth/me who is signed in; the page itself was rendered as kim, so answer as kim.
        const r = await fetch(t.base + req.url, { headers: req.url.startsWith('/auth/') ? { cookie } : {} }).catch(() => null);
        if (!r) { res.writeHead(502); return res.end(); }
        res.writeHead(r.status, { 'content-type': r.headers.get('content-type') || 'application/octet-stream' });
        return res.end(Buffer.from(await r.arrayBuffer()));
    });
    await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${proxy.address().port}`;

    const { chromium } = require(PLAYWRIGHT);
    const browser = await chromium.launch({ executablePath: CHROME });
    const heights = {};
    for (const [width, scheme] of [[320, 'dark'], [320, 'light'], [390, 'dark'], [390, 'light'], [1280, 'dark'], [1280, 'light']]) {
        const page = await browser.newPage({ viewport: { width, height: 900 }, colorScheme: scheme, deviceScaleFactor: 2, isMobile: width < 700, hasTouch: width < 700 });
        // The default display preference is the theme someone picked (dark). Auto makes it follow the device mode this
        // shot is for, so the light shots are actually light (theme-loader.js readDisplay()).
        await page.addInitScript(() => { try { localStorage.setItem('ov_display', JSON.stringify({ scheme: 'auto' })); } catch { /* */ } });
        const errors = [];
        page.on('pageerror', (e) => errors.push(e.message));
        await page.goto(`${base}/task-trace`, { waitUntil: 'load' });
        await page.waitForTimeout(900);
        const mode = await page.evaluate(() => document.documentElement.getAttribute('data-theme-mode'));
        if (mode !== scheme) throw new Error(`theme is ${mode}, wanted ${scheme} at ${width}`);
        const docWidth = await page.evaluate(() => document.documentElement.scrollWidth);
        if (docWidth !== width) throw new Error(`sideways scroll at ${width}/${scheme}: ${docWidth}`);
        await page.screenshot({ path: path.join(out, `trace-closed-${width}-${scheme}.png`), fullPage: true });
        const closed = await page.evaluate(() => document.querySelector('#trace').open === false);
        await page.evaluate(() => { document.querySelector('#trace').open = true; });
        await page.waitForTimeout(200);
        const fold = await page.evaluate(() => {
            const d = document.querySelector('#trace');
            const r = d.getBoundingClientRect();
            return { height: Math.round(r.height), top: Math.round(r.top + window.scrollY), rows: d.querySelectorAll('.tr').length };
        });
        await page.screenshot({ path: path.join(out, `trace-open-${width}-${scheme}.png`), fullPage: true });
        const openWidth = await page.evaluate(() => document.documentElement.scrollWidth);
        if (openWidth !== width) throw new Error(`sideways scroll with the fold open at ${width}/${scheme}: ${openWidth}`);
        heights[`trace-${width}-${scheme}`] = { ...fold, closed, docWidth, openWidth };

        await page.goto(`${base}/offer-confirm`, { waitUntil: 'load' });
        await page.waitForTimeout(400);
        const offerWidth = await page.evaluate(() => document.documentElement.scrollWidth);
        if (offerWidth !== width) throw new Error(`sideways scroll on the offer at ${width}/${scheme}: ${offerWidth}`);
        await page.screenshot({ path: path.join(out, `offer-confirm-${width}-${scheme}.png`), fullPage: true });
        heights[`offer-${width}-${scheme}`] = { docWidth: offerWidth };
        if (errors.length) throw new Error(`page errors at ${width}/${scheme}: ${errors.join('; ')}`);
        await page.close();
    }
    fs.writeFileSync(path.join(out, 'heights.json'), `${JSON.stringify(heights, null, 2)}\n`);
    await browser.close();
    proxy.close();
    await t.close();
    process.stdout.write(`${JSON.stringify(heights, null, 2)}\n`);
    process.exit(0);
})().catch((e) => { process.stderr.write(String(e && e.stack || e)); process.exit(1); });

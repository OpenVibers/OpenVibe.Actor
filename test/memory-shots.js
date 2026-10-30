'use strict';
/**
 * Shots of /memory for the V2-6 design review: 320, 390 and 1280, dark and light (not run by test/run.js: only
 * *.test.js are).
 *
 *   node test/memory-shots.js [/path/to/outdir]
 *
 * Boots Actor on a temp PGlite database, seeds active, suggested and archived rows (one already used, one from a task),
 * serves the signed-in page, and drives Playwright with the Shared theme objects (Vibe / Vibe Light) so the page is
 * tested in both halves of the theme. It also fails loudly if the page scrolls sideways at any width.
 */
const fs = require('fs');
const http = require('http');
const path = require('path');
const { boot } = require('./helpers/boot');
const memory = require('../server/memory');
const taskStore = require('../server/tasks/store');
const personal = require('../server/agents/personal');
const { BUILTIN_THEMES } = require('openvibe-shared/builtin-themes');
// Playwright is not an Actor dependency: use the one this workstation keeps for design shots, or PLAYWRIGHT_MODULE.
let playwright;
try { playwright = require('playwright'); } catch { playwright = require(process.env.PLAYWRIGHT_MODULE || '/home/workstation/openvibe/work/OpenVibe.Games/node_modules/playwright'); }
const { chromium } = playwright;

const OUT = process.argv[2] || path.join(require('os').tmpdir(), 'actor-memory-shots');
// Width and a real screen height: the phone page is measured in screens (320 = iPhone SE, 390 = iPhone 12/13).
const WIDTHS = [[320, 568], [390, 844], [1280, 800]];
const THEMES = ['vibe', 'cloud'];

(async () => {
    fs.mkdirSync(OUT, { recursive: true });
    const t = await boot();
    try {
        const u = t.network.addUser('memory-shots');
        const owner = `user:${u.subject}`;
        const s = t.ctx.s;
        const taskId = s.newId('tsk');
        await taskStore.insertTask(s, { id: taskId, requester: owner, task: 'Plan the trip to Lisbon.', mode: 'balanced', budget_task: 0.05, budget_day: 0.25, created_at: s.iso() });
        const agent = (await personal.create(s, t.config, owner, {
            name: 'Trip planner', instructions: 'Plan trips.', mode: 'balanced',
            budget_per_run_usd: 0.02, daily_runs_max: 1, schedule: 'off', status: 'active',
        })).row;
        // Five active memories, the number the review measures; one suggestion and one archived row for the tabs.
        const metric = await memory.add(s, { owner, text: 'I prefer metric units and Celsius.', kind: 'preference', source: 'person', sourceTask: taskId });
        const peanuts = await memory.add(s, { owner, text: 'I am allergic to peanuts.', kind: 'fact', source: 'person', sourceTask: taskId });
        for (let i = 0; i < 3; i++) await memory.recall(s, owner, 'allergic peanuts', { now: Date.now() });
        await memory.add(s, { owner, text: 'Ask before spending more than $20 on one booking.', kind: 'instruction', source: 'person' });
        const dark = await memory.add(s, { owner, text: 'I use dark mode on my laptop.', kind: 'fact', source: 'person' });
        const birthday = await memory.add(s, { owner, text: 'My birthday is in May.', kind: 'fact', source: 'person' });
        await memory.add(s, { owner, agentId: agent.id, text: 'The user wakes at 06:00 and likes a quiet morning.', kind: 'fact', source: 'agent', sourceTask: taskId });
        const old = await memory.add(s, { owner, text: 'I used to fly from Heathrow.', kind: 'fact', source: 'person' });
        await memory.decide(s, owner, old.row.id, 'archive');
        // A date that says yesterday and one from earlier this month, so the date format is visible in the shots.
        const day = 86_400_000;
        await s.db.query('UPDATE actor_agent_memory SET created_at = $1, updated_at = $1 WHERE id = $2', [new Date(Date.now() - day).toISOString(), dark.row.id]);
        await s.db.query('UPDATE actor_agent_memory SET created_at = $1, updated_at = $1 WHERE id = $2', [new Date(Date.now() - 5 * day).toISOString(), birthday.row.id]);
        void metric; void peanuts;

        const pages = {
            '/memory?tab=active': (await t.get('/memory?tab=active', { as: u })).text,
            '/memory?tab=suggested': (await t.get('/memory?tab=suggested', { as: u })).text,
            '/memory?tab=archived': (await t.get('/memory?tab=archived', { as: u })).text,
            '/memory': (await t.get('/memory', { as: u })).text,
        };
        const proxy = http.createServer(async (req, res) => {
            if (pages[req.url]) { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(pages[req.url]); }
            const r = await fetch(t.base + req.url, { headers: { cookie: req.headers.cookie || '' } }).catch(() => null);
            if (!r) { res.writeHead(502); return res.end(); }
            res.writeHead(r.status, { 'content-type': r.headers.get('content-type') || 'application/octet-stream' });
            return res.end(Buffer.from(await r.arrayBuffer()));
        });
        await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
        const base = `http://127.0.0.1:${proxy.address().port}`;

        const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome' });
        const problems = [];
        const heights = [];
        try {
            for (const themeId of THEMES) {
                const theme = BUILTIN_THEMES.find((x) => x.id === themeId);
                for (const [width, height] of WIDTHS) {
                    const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2 });
                    const cookie = t.signIn(u).split('=');
                    await context.addCookies([{ name: cookie[0], value: cookie.slice(1).join('='), domain: '127.0.0.1', path: '/' }]);
                    await context.addInitScript((value) => {
                        try {
                            localStorage.setItem('ov_theme', JSON.stringify(value));
                            localStorage.setItem('ov_display', JSON.stringify({ seasonal: 'off' }));
                        } catch { /* private mode */ }
                    }, theme);
                    const page = await context.newPage();
                    const errors = [];
                    page.on('pageerror', (e) => errors.push(String(e.message || e)));
                    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
                    await page.goto(`${base}/memory?tab=active`, { waitUntil: 'load' });
                    await page.waitForTimeout(1200);
                    // The phone app bar is fixed to the viewport; in a full-page shot it would sit across the middle.
                    await page.addStyleTag({ content: '.ovnav-appbar{display:none!important} html.ov-has-appbar{--ovnav-appbar-h:0px}' });
                    await page.waitForTimeout(100);
                    const dims = await page.evaluate(() => {
                        const footer = document.querySelector('#ov-footer') || document.querySelector('footer');
                        return {
                            scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth,
                            theme: document.documentElement.getAttribute('data-theme'),
                            footerTop: footer ? Math.round(footer.getBoundingClientRect().top + window.scrollY) : null,
                            viewport: window.innerHeight, docHeight: document.documentElement.scrollHeight,
                        };
                    });
                    if (dims.scroll > dims.client + 1) problems.push(`${width}px ${themeId}: scrollWidth ${dims.scroll} > ${dims.client}`);
                    const content = dims.footerTop == null ? dims.docHeight : dims.footerTop;
                    const screens = Number((content / dims.viewport).toFixed(2));
                    heights.push({ width, theme: themeId === 'cloud' ? 'light' : 'dark', contentHeight: content, viewport: dims.viewport, screens, scrollWidth: dims.scroll, clientWidth: dims.client });
                    if (themeId === 'cloud' && width === 390 && screens > 2) problems.push(`390px light: ${content}px above the footer is ${screens} screens (target: under 2)`);
                    const shot = path.join(OUT, `memory-${width}-${themeId === 'cloud' ? 'light' : 'dark'}.png`);
                    await page.screenshot({ path: shot, fullPage: true });
                    process.stdout.write(`${shot}  ${dims.client}px  theme=${dims.theme || '(none)'}  above footer=${content}px (${screens} screens of ${dims.viewport})${errors.length ? `  errors: ${errors.slice(0, 3).join(' | ')}` : ''}\n`);
                    // The suggested tab at phone width, to show the two visible decisions on a suggestion.
                    if (width === 390) {
                        await page.goto(`${base}/memory?tab=suggested`, { waitUntil: 'load' });
                        await page.waitForTimeout(500);
                        await page.addStyleTag({ content: '.ovnav-appbar{display:none!important} html.ov-has-appbar{--ovnav-appbar-h:0px}' });
                        const suggestedShot = path.join(OUT, `memory-suggested-390-${themeId === 'cloud' ? 'light' : 'dark'}.png`);
                        await page.screenshot({ path: suggestedShot, fullPage: true });
                        process.stdout.write(`${suggestedShot}\n`);
                    }
                    await context.close();
                }
            }
        } finally { await browser.close(); proxy.close(); }
        fs.writeFileSync(path.join(OUT, 'heights.json'), `${JSON.stringify(heights, null, 2)}\n`);
        if (problems.length) { process.stderr.write(`\n${problems.join('\n')}\n`); process.exit(1); }
    } finally { await t.close(); }
})().catch((e) => { process.stderr.write(String(e && e.stack)); process.exit(1); });

'use strict';
/**
 * Shots of the V2-8 brain on the task page: the one question, the plan's editable assumptions and ledgers, the answer's
 * confidence chips with their Challenge link, the Challenge estimate, and an escalation event. 390 and 1280, dark and
 * light (not run by test/run.js: only *.test.js are). It also checks 320 px for sideways scroll, and fails loudly.
 *
 *   node test/brain-shots.js [/path/to/outdir]
 */
const fs = require('fs');
const http = require('http');
const path = require('path');
const { boot } = require('./helpers/boot');
const taskStore = require('../server/tasks/store');
const { BUILTIN_THEMES } = require('openvibe-shared/builtin-themes');
let playwright;
try { playwright = require('playwright'); } catch { playwright = require(process.env.PLAYWRIGHT_MODULE || '/home/workstation/openvibe/work/OpenVibe.Games/node_modules/playwright'); }
const { chromium } = playwright;

const OUT = process.argv[2] || path.join(require('os').tmpdir(), 'actor-brain-shots');
// 320 is a check only (iPhone SE); the design shots are 390 (iPhone 12/13) and 1280 (desktop).
const WIDTHS = [[320, 568], [390, 844], [1280, 800]];
const THEMES = ['vibe', 'cloud'];

const iso = () => new Date().toISOString();

(async () => {
    fs.mkdirSync(OUT, { recursive: true });
    process.stdout.write('boot…\n');
    const t = await boot();
    process.stdout.write('booted\n');
    try {
        const u = t.network.addUser('brain-shots');
        const owner = `user:${u.subject}`;
        const s = t.ctx.s;
        const base = { requester: owner, mode: 'balanced', budget_task: 0.05, budget_day: 0.25, cost_usd: 0.0031, created_at: iso() };

        const questionTask = s.newId('tsk');
        await taskStore.insertTask(s, { ...base, id: questionTask, task: 'Book the team dinner for Friday and pay the deposit from the company card.', state: 'needs_you' });
        await taskStore.updateTask(s, questionTask, { state: 'needs_you', cost_usd: 0.0004 });
        await taskStore.appendEvent(s, questionTask, { at: iso(), kind: 'output', step: 'plan', agent: 'openvibe-runtime', text: 'Assumptions: dinner for the team\n→ 1. Ask which booking\n· 2. Book it\nTask ledger: given the team dinner on Friday · find the place and time · derive the deposit\nProgress: not done; not looping; moving; next Ask which booking' });
        await taskStore.appendEvent(s, questionTask, { at: iso(), kind: 'output', step: 'question', agent: 'openvibe-runtime', text: 'Which booking should I hold for the team dinner?', options: ['Friday 19:00 · Riverside Grill · 8 people · $200 deposit', 'Friday 20:00 · Oceanview Bistro · 10 people · $150 deposit'] });
        await taskStore.appendEvent(s, questionTask, { at: iso(), kind: 'state', state: 'needs_you' });

        const planTask = s.newId('tsk');
        await taskStore.insertTask(s, { ...base, id: planTask, task: 'Plan a two-day trip to Lisbon for a family of four, under €600.' });
        await taskStore.updateTask(s, planTask, { state: 'running', cost_usd: 0.0021 });
        await taskStore.appendEvent(s, planTask, { at: iso(), kind: 'output', step: 'plan', agent: 'openvibe-runtime', text: 'Assumptions: the family includes two children under 12; travel is from Madrid; the €600 covers the hotel and food, not the train\n✓ 1. Find the train times\n→ 2. Find a family room under €160 a night\n· 3. Build the two-day plan\nTask ledger: given Lisbon, two days, family of four, €600 · find the train, a family room, three restaurants · derive the total and the walking route\nProgress: not done; not looping; moving; next Find a family room under €160 a night' });
        await taskStore.appendEvent(s, planTask, { at: iso(), kind: 'output', step: 'tool_call', agent: 'openvibe-runtime', tool: 'search_web', input: 'family hotel Lisbon under 160' });
        await taskStore.appendEvent(s, planTask, { at: iso(), kind: 'output', step: 'tool_result', agent: 'openvibe-runtime', tool: 'search_web', text: 'A family room at the Hotel Baixa is €148 a night, breakfast included.' });

        const doneTask = s.newId('tsk');
        await taskStore.insertTask(s, { ...base, id: doneTask, task: 'What does ChatGPT Plus cost, and what does the annual plan save?' });
        const evidence = [
            { id: 'E1', tool: 'search_web', input: { query: 'ChatGPT Plus price' }, text: 'ChatGPT Plus is $20 per month in the US.', sources: [{ url: 'https://openai.com/chatgpt/pricing', title: 'ChatGPT pricing' }], at: iso() },
            { id: 'E2', tool: 'market_quote', input: { symbol: 'openai' }, text: 'The annual plan is $200.', sources: [{ url: 'https://openai.com/chatgpt/pricing', title: 'ChatGPT pricing' }], at: iso() },
        ];
        const result = {
            answer: 'ChatGPT Plus costs **$20 a month** [E1]. The annual plan is **$200** [E2], so paying yearly saves about **$40** over twelve months.',
            sources: ['https://openai.com/chatgpt/pricing'], agent: 'openvibe-runtime', model: 'gpt-5.1', class: 'answer', tier: 'smart',
            checked: {
                by: 'deepseek', cross_family: true, reason: 'all claims grounded', claims: 2, grounded: 2,
                confidence: { sure: 1, likely: 1, unverified: 0, unsure: 0 },
                claims_detail: [
                    { claim: 'ChatGPT Plus costs $20 a month.', kind: 'live', evidence: ['E1'], confidence: 'likely', high_stakes: true },
                    { claim: 'The annual plan is $200.', kind: 'live', evidence: ['E2'], confidence: 'sure', high_stakes: true },
                ],
            },
            evidence, citations: ['E1', 'E2'], artifacts: [],
            plan: { assumptions: ['The price is the US list price, before tax'], steps: [{ goal: 'Find the current price', state: 'done' }, { goal: 'Answer the person', state: 'done' }] },
            turns: 3,
            brain: { kind: 'answer', understanding: { risk: 'low', ambiguity: 0.2, deliverable: 'The current price and the annual saving' }, tiers: ['fast', 'smart'], tools: ['search_web'], demoted: [], questions: 0, replans: 0, escalations: 1, steps: [] },
        };
        await taskStore.updateTask(s, doneTask, { state: 'succeeded', cost_usd: 0.0062, finished_at: iso(), result });
        for (const e of [
            { at: iso(), kind: 'output', step: 'plan', agent: 'openvibe-runtime', text: 'Assumptions: the US list price\n→ 1. Find the current price\n· 2. Answer the person\nTask ledger: given the two plans · find the current US price · derive the yearly saving\nProgress: not done; not looping; moving; next Find the current price' },
            { at: iso(), kind: 'output', step: 'tool_call', agent: 'openvibe-runtime', tool: 'search_web', input: 'ChatGPT Plus price' },
            { at: iso(), kind: 'output', step: 'tool_result', agent: 'openvibe-runtime', tool: 'search_web', text: 'ChatGPT Plus is $20 per month in the US.' },
            { at: iso(), kind: 'output', step: 'tool_call', agent: 'openvibe-runtime', tool: 'market_quote', input: 'openai annual' },
            { at: iso(), kind: 'output', step: 'tool_result', agent: 'openvibe-runtime', tool: 'market_quote', text: 'The annual plan is $200.' },
            { at: iso(), kind: 'output', step: 'check', agent: 'openvibe-runtime', text: 'Check failed by deepseek: a live price has no evidence', is_error: true },
            { at: iso(), kind: 'output', step: 'escalation', agent: 'openvibe-runtime', text: 'Tried a stronger model for this step (fast → smart).' },
            { at: iso(), kind: 'output', step: 'check', agent: 'openvibe-runtime', text: 'Checked by deepseek: all claims grounded' },
        ]) await taskStore.appendEvent(s, doneTask, e);

        process.stdout.write('seeded\n');
        const pages = {
            question: (await t.get(`/tasks/${questionTask}`, { as: u })).text,
            plan: (await t.get(`/tasks/${planTask}`, { as: u })).text,
            answer: (await t.get(`/tasks/${doneTask}`, { as: u })).text,
            challenge: (await t.get(`/tasks/${doneTask}/challenge?ev=E1`, { as: u })).text,
        };
        for (const [name, html] of Object.entries(pages)) {
            if (!html || html.length < 200) throw new Error(`${name}: page did not render`);
        }
        if (!/Before Actor starts, one question/.test(pages.question)) throw new Error('question card missing');
        if (!/name="answer" value="Friday 19:00/.test(pages.question)) throw new Error('question options missing');
        if (!/assume-text/.test(pages.plan)) throw new Error('assumptions form missing');
        if (!/Task ledger/.test(pages.plan)) throw new Error('ledger missing');
        if (!/ev-conf is-likely/.test(pages.answer)) throw new Error('confidence badge missing');
        if (!/Challenge this claim/.test(pages.answer)) throw new Error('Challenge link missing');
        if (!/Tried a stronger model/.test(pages.answer)) throw new Error('escalation event missing');
        if (!/Estimate:/.test(pages.challenge)) throw new Error('Challenge estimate missing');

        process.stdout.write('pages rendered\n');
        const proxy = http.createServer(async (req, res) => {
            const to = req.url.startsWith('/tasks/') ? req.url.split('?')[0] : null;
            const hit = to && pages[to === `/tasks/${questionTask}` ? 'question' : to === `/tasks/${planTask}` ? 'plan' : to === `/tasks/${doneTask}` ? 'answer' : ''];
            if (hit) { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(hit); }
            const r = await fetch(t.base + req.url, { headers: { cookie: req.headers.cookie || '' } }).catch(() => null);
            if (!r) { res.writeHead(502); return res.end(); }
            res.writeHead(r.status, { 'content-type': r.headers.get('content-type') || 'application/octet-stream' });
            return res.end(Buffer.from(await r.arrayBuffer()));
        });
        await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
        const origin = `http://127.0.0.1:${proxy.address().port}`;

        process.stdout.write('proxy up\n');
        const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome' });
        const problems = [];
        const heights = [];
        try {
            for (const themeId of THEMES) {
                const theme = BUILTIN_THEMES.find((x) => x.id === themeId);
                for (const [width, height] of WIDTHS) {
                    for (const [name, url] of [['question', `/tasks/${questionTask}`], ['plan-assumptions', `/tasks/${planTask}`], ['answer-confidence', `/tasks/${doneTask}`]]) {
                        if (width === 320 && name !== 'question') continue;   // 320 is the overflow check, not a design shot
                        const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2 });
                        const cookie = t.signIn(u).split('=');
                        await context.addCookies([{ name: cookie[0], value: cookie.slice(1).join('='), domain: '127.0.0.1', path: '/' }]);
                        await context.addInitScript((value) => {
                            try { localStorage.setItem('ov_theme', JSON.stringify(value)); localStorage.setItem('ov_display', JSON.stringify({ seasonal: 'off' })); } catch { /* private mode */ }
                        }, theme);
                        const page = await context.newPage();
                        const errors = [];
                        page.on('pageerror', (e) => errors.push(String(e.message || e)));
                        page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
                        await page.goto(`${origin}${url}`, { waitUntil: 'load' });
                        await page.waitForTimeout(800);
                        await page.addStyleTag({ content: '#navbar-mount, .openvibe-navbar, .ovnav-appbar{display:none!important} html.ov-has-appbar{--ovnav-appbar-h:0px;--ovnav-real-h:0px}' });
                        if (name === 'answer-confidence') await page.evaluate(() => { const d = document.getElementById('evidence'); if (d) d.open = true; });
                        await page.waitForTimeout(150);
                        const dims = await page.evaluate(() => ({
                            scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth,
                            theme: document.documentElement.getAttribute('data-theme'), docHeight: document.documentElement.scrollHeight,
                        }));
                        if (dims.scroll > dims.client + 1) problems.push(`${name} ${width}px ${themeId}: scrollWidth ${dims.scroll} > ${dims.client}`);
                        heights.push({ page: name, width, theme: themeId === 'cloud' ? 'light' : 'dark', docHeight: dims.docHeight, scrollWidth: dims.scroll, clientWidth: dims.client });
                        const shot = path.join(OUT, `${name}-${width}-${themeId === 'cloud' ? 'light' : 'dark'}.png`);
                        await page.screenshot({ path: shot, fullPage: true });
                        process.stdout.write(`${shot}  ${dims.client}px  theme=${dims.theme || '(none)'}  height=${dims.docHeight}px${errors.length ? `  errors: ${errors.slice(0, 3).join(' | ')}` : ''}\n`);
                        if (name === 'answer-confidence' && (width === 390 || width === 1280)) {
                            await page.goto(`${origin}/tasks/${doneTask}/challenge?ev=E1`, { waitUntil: 'load' });
                            await page.waitForTimeout(400);
                            const cshot = path.join(OUT, `challenge-estimate-${width}-${themeId === 'cloud' ? 'light' : 'dark'}.png`);
                            await page.screenshot({ path: cshot, fullPage: true });
                            process.stdout.write(`${cshot}\n`);
                        }
                        await context.close();
                    }
                }
            }
        } finally { await browser.close(); proxy.close(); }
        fs.writeFileSync(path.join(OUT, 'heights.json'), `${JSON.stringify(heights, null, 2)}\n`);
        if (problems.length) { process.stderr.write(`\n${problems.join('\n')}\n`); process.exit(1); }
        // The shots are done; the app's shutdown can wait on a closing socket, so end the process now.
        process.exit(0);
    } finally { await t.close(); }
})().catch((e) => { process.stderr.write(String(e && e.stack)); process.exit(1); });

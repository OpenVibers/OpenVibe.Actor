'use strict';
/**
 * Shots for Actor v2 stage V2-9 (not run by test/run.js): the fork dialog, the resumed-task event on the page, and the
 * two-run compare at 390 and 1280 px in dark and light, with the compare chips (Answer, Steps, Cost) picked on a
 * phone. Also checks 320 px for sideways scroll and fails loudly.
 *
 *   node test/durable-shots.js [/path/to/outdir]
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { boot } = require('./helpers/boot');
const store = require('../server/tasks/store');
const trace = require('../server/runtime/trace');

let playwright;
try { playwright = require('playwright'); } catch { playwright = require(process.env.PLAYWRIGHT_MODULE || '/home/workstation/openvibe/work/OpenVibe.Games/node_modules/playwright'); }
const { chromium } = playwright;

const OUT = process.argv[2] || path.join('/home/workstation/openvibe/research-2026-10-30', 'actor-v2-9-shots');
const KEY = crypto.randomBytes(32).toString('hex');
const SAME = { 'sec-fetch-site': 'same-origin' };
const WIDTHS = [[320, 568], [390, 844], [1280, 800]];
const THEMES = ['dark', 'light'];

(async () => {
    fs.mkdirSync(OUT, { recursive: true });
    const t = await boot({ env: { ACTOR_CHECKPOINT_KEY: KEY } });
    const u = t.network.addUser('durable-shots');
    const s = t.ctx.s;
    const quiet = { log() {}, info() {}, warn() {}, error() {} };
    try {
        t.config.loop.selfReflections = 0;
        t.providers.reset();
        const create = async (task) => {
            const r = await t.get('/api/v1/tasks', { as: u, json: { task, mode: 'balanced' }, headers: SAME });
            if (r.status !== 201) throw new Error(`create: ${r.text}`);
            const id = r.json().id;
            const row = await t.waitFor(id);
            if (row.state !== 'succeeded') throw new Error(`task ${id} ended ${row.state}: ${row.error_detail}`);
            return row;
        };

        // Run A: a calculator result, and a claim that the tool supports (graded sure).
        t.providers.state.smart = 'tool';
        t.providers.state.loopTool = { name: 'calculate', arguments: JSON.stringify({ expression: '6*7' }) };
        t.providers.state.checkOk = true;
        t.providers.state.checkClaims = () => [{ claim: 'The fixture calculation says 42.', kind: 'derived', evidence: ['E1'], supported: true }];
        const a = await create('What does the fixture calculation say?');

        // Run B: a search result, and the same claim graded likely plus one claim only B has.
        t.providers.state.loopTool = { name: 'search_web', arguments: JSON.stringify({ query: 'fixture calculation' }) };
        t.providers.state.checkClaims = () => [
            { claim: 'The fixture calculation says 42.', kind: 'derived', evidence: ['E1'], supported: true },
            { claim: 'The sea is deep.', kind: 'general', evidence: [], supported: true },
        ];
        const b = await create('Search the fixture for the calculation, then say what it found and whether the sea is deep.');

        // The resumed-task event belongs on A's timeline; its span belongs in the Trace fold.
        const at = s.iso();
        await store.appendEvent(s, a.id, { at, kind: 'output', step: 'resume', agent: 'openvibe-runtime', text: 'Picked up after a restart at step 1.' });
        await trace.createTracer({ store: s, taskId: a.id, log: quiet, now: () => s.now() }).record({ kind: 'tool', name: 'resume', startedAt: s.now(), ms: 0, ok: true, step: 1 });

        const pages = {
            resume: (await t.get(`/tasks/${a.id}`, { as: u })).text,
            fork: (await t.get(`/tasks/${a.id}/fork?step=1`, { as: u })).text,
            compare: (await t.get(`/tasks/${a.id}/compare/${b.id}`, { as: u })).text,
        };
        if (!/Fork from step 1/.test(pages.fork)) throw new Error('fork dialog missing');
        if (!/Estimate:/.test(pages.fork)) throw new Error('fork estimate missing');
        if (!/Picked up after a restart at step 1/.test(pages.resume)) throw new Error('resume event missing');
        if (!/Compare two runs/.test(pages.compare)) throw new Error('compare page missing');
        if (!/The fixture calculation says 42/.test(pages.compare)) throw new Error('compare answers missing');
        process.stdout.write(`pages rendered for ${a.id} and ${b.id}\n`);

        const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome' });
        const heights = {};
        const problems = [];
        try {
            for (const theme of THEMES) {
                for (const [width] of WIDTHS) {
                    const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: theme, deviceScaleFactor: 2, isMobile: width < 700, hasTouch: width < 700 });
                    const cookie = t.signIn(u).split('=');
                    await context.addCookies([{ name: cookie[0], value: cookie.slice(1).join('='), domain: '127.0.0.1', path: '/' }]);
                    await context.addInitScript(() => { try { localStorage.setItem('ov_display', JSON.stringify({ scheme: 'auto' })); } catch { /* private */ } });
                    const page = await context.newPage();
                    const errors = [];
                    page.on('pageerror', (e) => errors.push(String(e.message || e)));
                    const open = async (url, name, prepare) => {
                        await page.goto(`${t.base}${url}`, { waitUntil: 'load' });
                        await page.waitForTimeout(700);
                        await page.addStyleTag({ content: '#navbar-mount, .openvibe-navbar, .ovnav-appbar{display:none!important} html.ov-has-appbar{--ovnav-appbar-h:0px;--ovnav-real-h:0px}' });
                        if (prepare) await prepare();
                        await page.waitForTimeout(150);
                        const dims = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth, height: document.documentElement.scrollHeight, mode: document.documentElement.getAttribute('data-theme-mode') }));
                        if (dims.mode !== theme) throw new Error(`${name}: theme is ${dims.mode}, wanted ${theme}`);
                        if (dims.scroll > dims.client + 1) problems.push(`${name} ${width}px ${theme}: scrollWidth ${dims.scroll} > ${dims.client}`);
                        heights[`${name}-${width}-${theme}`] = dims;
                        if (width !== 320) {
                            await page.screenshot({ path: path.join(OUT, `${name}-${width}-${theme}.png`), fullPage: true });
                            process.stdout.write(`${path.join(OUT, `${name}-${width}-${theme}.png`)}  ${dims.client}px  height=${dims.height}px\n`);
                        }
                    };
                    await open(`/tasks/${a.id}`, 'resume-event');
                    await open(`/tasks/${a.id}/fork?step=1`, 'fork-dialog');
                    await open(`/tasks/${a.id}/compare/${b.id}`, 'compare-answer');
                    if (width === 390) {
                        await page.click('label[for="cmp-steps"]');
                        await page.waitForTimeout(200);
                        await page.screenshot({ path: path.join(OUT, `compare-steps-${width}-${theme}.png`), fullPage: true });
                        process.stdout.write(`${path.join(OUT, `compare-steps-${width}-${theme}.png`)}\n`);
                        await page.click('label[for="cmp-cost"]');
                        await page.waitForTimeout(200);
                        await page.screenshot({ path: path.join(OUT, `compare-cost-${width}-${theme}.png`), fullPage: true });
                        process.stdout.write(`${path.join(OUT, `compare-cost-${width}-${theme}.png`)}\n`);
                    }
                    if (errors.length) problems.push(`${width}px ${theme}: page errors: ${errors.slice(0, 3).join(' | ')}`);
                    await context.close();
                }
            }
        } finally {
            await browser.close();
        }
        fs.writeFileSync(path.join(OUT, 'heights.json'), `${JSON.stringify(heights, null, 2)}\n`);
        if (problems.length) throw new Error(`shots failed:\n${problems.join('\n')}`);
        process.stdout.write(`${JSON.stringify(heights, null, 2)}\n`);
        process.exit(0);
    } finally {
        await t.close();
    }
})().catch((e) => { process.stderr.write(String(e && e.stack || e)); process.exit(1); });

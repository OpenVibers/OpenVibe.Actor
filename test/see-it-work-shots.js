'use strict';
// Screenshots for See it work (W1), not run by test/run.js: a task with a live desk tile, the viewer in control, and a
// finished run's replay, at 390 and 1280. The Live embed is a local stand-in (the test page never calls openvibe.live).
// Usage: node test/see-it-work-shots.js <outdir>
const fs = require('fs');
const http = require('http');
const path = require('path');
const h = require('openvibe-shared/browser-harness');
const { boot } = require('./helpers/boot');
const store = require('../server/tasks/store');
const stills = require('../server/tasks/stills');

const MACHINE = 'dev_01JZ0000000000000000000000';
const STREAM = 'ags_01JZ0000000000000000000000';
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

(async () => {
    const out = process.argv[2] || path.join(__dirname, '..', '..', 'research-2026-11-12', 'actor-shots', 'see-it-work');
    fs.mkdirSync(out, { recursive: true });
    // A stand-in Live embed: what a viewer sees on openvibe.live, without leaving this machine.
    const live = http.createServer((req, res) => {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><meta charset="utf-8"><style>html,body{margin:0;height:100%;background:#05070d;color:#e6edf7;font:14px system-ui;overflow:hidden}
.window{position:absolute;inset:10px;border-radius:10px;background:#0f1729;border:1px solid #334155;overflow:hidden}
.bar{height:34px;display:flex;align-items:center;gap:6px;padding:0 10px;background:#1e293b;border-bottom:1px solid #334155}
.dot{width:7px;height:7px;border-radius:50%;background:#64748b}.url{flex:1;height:20px;border-radius:6px;background:#0b1220;border:1px solid #334155;color:#94a3b8;font-size:11px;line-height:20px;padding:0 8px}
.page{padding:22px}.page h1{margin:0 0 8px;font-size:22px}.page p{color:#94a3b8;margin:0 0 18px}.card{height:86px;border-radius:10px;background:#162033;border:1px solid #334155;margin:8px 0}
.tag{position:absolute;left:18px;bottom:16px;display:inline-flex;align-items:center;gap:7px;padding:3px 10px;border-radius:999px;background:#0b1220cc;border:1px solid #334155;font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase}
.tag::before{content:"";width:7px;height:7px;border-radius:50%;background:#ef4444;box-shadow:0 0 0 3px #ef444455}</style>
<div class="window"><div class="bar"><span class="dot"></span><span class="dot"></span><span class="dot"></span><span class="url">example.com/trains</span></div>
<div class="page"><h1>Trains to Porto</h1><p>Tuesday, 14:10 · from Lisbon</p><div class="card"></div><div class="card"></div><div class="card"></div></div></div><span class="tag">AI agent · live</span>`);
    });
    await new Promise((r) => live.listen(0, '127.0.0.1', r));
    const liveBase = `http://127.0.0.1:${live.address().port}`;
    const t = await boot({ env: { ACTOR_LIVE_URL: '', ACTOR_LIVE_PUBLIC_URL: liveBase } });
    // The page's own view ticket call: the same shape Live answers, pointing at the stand-in embed.
    t.ctx.live.enabled = true;
    t.ctx.live.viewTicket = async (token, id) => ({ stream_id: id, view_ticket: 'wvt_test', expires_at: new Date(Date.now() + 600e3).toISOString(), page_url: `${liveBase}/embed/agent/${id}?vt=wvt_test` });
    const kim = t.network.addUser('kim');
    const s = t.ctx.s;
    const owner = `user:${kim.subject}`;
    const event = (id, body) => store.appendEvent(s, id, { kind: 'output', at: s.iso(), ...body });
    const make = async (state) => {
        const id = s.newId('tsk');
        await store.insertTask(s, { id, requester: owner, task: 'Book the cheapest train to Porto', mode: 'balanced', budget_task: 0.05, budget_day: 0.5, created_at: s.iso() });
        await store.updateTask(s, id, { state });
        return id;
    };
    const makeLive = async () => {
        const id = await make('running');
        await event(id, { step: 'tool_result', tool: 'computer_desk', text: JSON.stringify({ watch: `https://openvibe.link/machines/${MACHINE}/screen?desk=desk-trains`, running: true, kind: 'browser', stream: { id: STREAM, page_url: `${liveBase}/embed/agent/${STREAM}`, visibility: 'private' } }) });
        await event(id, { step: 'tool_call', tool: 'computer_input', call_id: 'c1', args: { action: 'click', x: 470, y: 250, width: 1280, height: 800 }, input: 'click' });
        await event(id, { step: 'tool_result', tool: 'computer_input', call_id: 'c1', text: '{"done":true}' });
        await event(id, { step: 'tool_call', tool: 'computer_browser', call_id: 'c2', args: { action: 'open', url: 'https://example.com/trains' }, input: 'open' });
        await event(id, { step: 'tool_result', tool: 'computer_browser', call_id: 'c2', text: '{"url":"https://example.com/trains","title":"Trains"}' });
        return id;
    };

    const replayId = await make('succeeded');
    await store.updateTask(s, replayId, { finished_at: s.iso(), result: { answer: 'The 14:10 from Lisbon is the cheapest: €29.50.' } });
    const type = await event(replayId, { step: 'tool_call', tool: 'computer_input', call_id: 'r1', args: { action: 'type', text: 'Porto', desk: 'private' }, input: 'type' });
    await stills.save(s, replayId, type.seq + 1, { format: 'png', data: Buffer.from(PNG, 'base64'), width: 1280, height: 800 });
    await event(replayId, { step: 'tool_result', tool: 'computer_input', call_id: 'r1', text: '{"done":true}' });
    const click = await event(replayId, { step: 'tool_call', tool: 'computer_input', call_id: 'r2', args: { action: 'click', x: 320, y: 180, width: 1280, height: 800 }, input: 'click' });
    await stills.save(s, replayId, click.seq + 1, { format: 'png', data: Buffer.from(PNG, 'base64'), width: 1280, height: 800 });
    await event(replayId, { step: 'tool_result', tool: 'computer_input', call_id: 'r2', text: '{"done":true}' });

    const browser = await h.launch({});
    try {
        for (const width of [390, 1280]) {
            const liveId = await makeLive();
            const cases = [
                ['tile', false, async () => {}, liveId],
                ['viewer', true, async (page) => {
                    await page.evaluate(`document.querySelector('[data-ct-desk-open]').click()`);
                    await new Promise((r) => setTimeout(r, 800));
                    await page.evaluate(`document.querySelector('[data-ct-viewer-take]').click()`);
                    await new Promise((r) => setTimeout(r, 1000));
                }, liveId],
                ['replay', false, async (page) => {
                    await page.evaluate(`(() => { const d = document.querySelector('[data-ct-replay]'); if (d) { d.open = true; const b = d.querySelector('[data-ct-replay-step="1"]'); if (b) b.click(); } })()`);
                    await new Promise((r) => setTimeout(r, 700));
                }, replayId],
            ];
            for (const [name, viewer, act, id] of cases) {
                const page = await h.openPage(browser, await browser.newContext(), { width, height: 1500 });
                await page.send('Network.setCookie', { name: 'actor_at', value: t.signIn(kim).replace(/^actor_at=/, ''), url: t.base, path: '/' });
                await page.send('Network.setExtraHTTPHeaders', { headers: { Authorization: `Bearer ${t.network.userToken(kim)}` } });
                await page.goto(`${t.base}/chat/${id}`, { maxMs: 10000 });
                await new Promise((r) => setTimeout(r, 900));
                await act(page);
                const shot = path.join(out, `${name}-${width}.png`);
                const png = await page.send('Page.captureScreenshot', { format: 'png' });
                fs.writeFileSync(shot, Buffer.from(png.data, 'base64'));
                const read = await page.evaluate(`(() => {
                    const wide = [...document.querySelectorAll('main *')].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && (r.right > innerWidth + 1 || r.left < -1); }).slice(0, 5).map((e) => e.tagName.toLowerCase());
                    const small = [...document.querySelectorAll('.ct-desk-tile button, .ct-viewer button, .ct-viewer input, .ct-replay button, .ct-replay input')].filter((e) => { const r = e.getBoundingClientRect(); return !e.hidden && r.width > 0 && r.height > 0 && (r.width < 44 || r.height < 44); }).map((e) => e.tagName.toLowerCase());
                    return { sw: document.documentElement.scrollWidth, iw: innerWidth, wide, small, live: !!document.querySelector('[data-ct-desk-frame] iframe'), viewer: !!document.querySelector('.ct-viewer:not([hidden])'), replay: !!document.querySelector('[data-ct-replay][open]') };
                })()`);
                process.stdout.write(`${shot}  scrollWidth=${read.sw}/${read.iw} live=${read.live} viewer=${read.viewer} replay=${read.replay}${read.wide.length ? ` WIDE ${read.wide.join(',')}` : ''}${read.small.length ? ` SMALL ${read.small.join(',')}` : ''}\n`);
                await page.close();
            }
            await store.updateTask(s, liveId, { state: 'cancelled', finished_at: s.iso() }).catch(() => null);
        }
    } finally {
        await browser.close();
        live.close();
        await t.close();
    }
    process.exit(0);
})().catch((e) => { process.stderr.write(String(e && e.stack)); process.exit(1); });

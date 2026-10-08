'use strict';
// Screenshots of a finished and a failed task page, signed in (not run by test/run.js: only *.test.js are).
// Usage: node test/shots.js <outdir>
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { boot } = require('./helpers/boot');

(async () => {
    const out = process.argv[2];
    const t = await boot();
    const kim = t.network.addUser('kim');
    const SAME = { 'sec-fetch-site': 'same-origin' };
    t.providers.state.cls = 'lookup';
    const ok = (await t.get('/api/v1/tasks', { as: kim, json: { task: 'Who handles the mail for openvibe.network?' }, headers: SAME })).json().id;
    await t.waitFor(ok);
    t.providers.reset();
    t.providers.state.cls = 'research';
    t.providers.state.checkOk = false;
    const bad = (await t.get('/api/v1/tasks', { as: kim, json: { task: 'test' }, headers: SAME })).json().id;
    await t.waitFor(bad);

    // The pages as kim sees them, served next to the app's own assets (a proxy for everything else).
    const pages = {};
    pages['/task-ok'] = (await t.get(`/tasks/${ok}`, { as: kim })).text;
    pages['/task-failed'] = (await t.get(`/tasks/${bad}`, { as: kim })).text;
    const proxy = http.createServer(async (req, res) => {
        if (pages[req.url]) { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(pages[req.url]); }
        const r = await fetch(t.base + req.url).catch(() => null);
        if (!r) { res.writeHead(502); return res.end(); }
        res.writeHead(r.status, { 'content-type': r.headers.get('content-type') || 'application/octet-stream' });
        return res.end(Buffer.from(await r.arrayBuffer()));
    });
    await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${proxy.address().port}`;
    const jobs = [];
    Object.keys(pages).forEach((name) => [1280, 390].forEach((w) => jobs.push([name, w])));
    await jobs.reduce((p, [name, w]) => p.then(() => new Promise((resolve) => {
        const shot = path.join(out, `${name.slice(1)}-${w}.png`);
        const c = spawn('google-chrome', ['--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars', `--window-size=${w},1500`, '--virtual-time-budget=3000', `--screenshot=${shot}`, base + name], { stdio: 'ignore' });
        const kill = setTimeout(() => c.kill('SIGKILL'), 45000);
        c.on('exit', () => { clearTimeout(kill); resolve(); });
    })), Promise.resolve());
    proxy.close();
    await t.close();
    process.exit(0);
})().catch((e) => { process.stderr.write(String(e && e.stack)); process.exit(1); });

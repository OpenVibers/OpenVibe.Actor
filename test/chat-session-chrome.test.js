'use strict';
// Actor's chat on the one session surface (openvibe-shared 4.266.0 ov-session.js, plan §AD.8): messenger.js mounts
// OpenVibeSession over the server-rendered page with your Actor heading the sessions, the Action Center's work in them,
// Actor's starters and ?ask= in the box; ?run= opens that session and the address follows the open one (/chat?run=)
// and a new one (/chat). Where /shared/ov-session.js is not served yet, the messenger (ov-run.js) still takes over.
// Real Chrome at 390 px, with stand-ins for the shared files (what they are given is what this checks); skipped
// without Chrome.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const h = require('openvibe-shared/browser-harness');
if (process.env.OV_SKIP_BROWSER === '1' || !h.findChrome()) { console.log('chat-session-chrome: skipped (no Chrome; set CHROME_BIN)'); process.exit(0); }
const SITE = path.join(__dirname, '..');

let serveSession = true;
const page = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Actor</title><link rel="icon" href="data:,"></head><body>
<main data-chat=""><p id="ssr">The server-rendered page</p></main>
<script>window.OpenVibeNavbar = { token: () => 'signed-in-test' };</script>
<script src="/js/messenger.js"></script></body></html>`;
// A stand-in OpenVibeSession: it keeps what it was given and lets the test play the events a session sends.
const sessionStub = `window.OpenVibeSession = { mount(host, o) {
  window.__mounted = { actor: o.actor, actions: o.actions, base: o.base, starters: o.starters.length, open: o.open, sibling: o.sibling('ov-picker.js'), token: o.token(), title: o.title };
  window.__onEvent = o.onEvent;
  host.innerHTML = '<div class="stub-session">session</div>';
  return { prefill(t) { window.__prefill = t; } };
} };`;
const runStub = `window.OpenVibeRun = { page(host, o) { window.__messenger = { agent: o.agent, open: o.open }; host.innerHTML = '<div class="stub-run">run</div>'; return { main: { prefill() {} } }; } };`;
const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/chat') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(page); }
    if (u.pathname === '/js/messenger.js') { res.writeHead(200, { 'content-type': 'application/javascript' }); return res.end(fs.readFileSync(path.join(SITE, 'public/js/messenger.js'))); }
    if (u.pathname === '/shared/ov-session.js' && serveSession) { res.writeHead(200, { 'content-type': 'application/javascript' }); return res.end(sessionStub); }
    if (u.pathname === '/shared/ov-run.js') { res.writeHead(200, { 'content-type': 'application/javascript' }); return res.end(runStub); }
    res.writeHead(404); res.end();
});
(async () => {
    await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
    const base = `http://127.0.0.1:${server.address().port}`;
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'actor-chat-session-'));
    const browser = await h.launch({ tmpDir });
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const until = async (p, expr) => { for (let i = 0; i < 150; i++) { const v = await p.evaluate(expr); if (v) return v; await wait(40); } throw new Error(`Timed out: ${expr}`); };
    try {
        const p = await h.openPage(browser, await browser.newContext(), { width: 390, height: 844 });
        await p.goto(`${base}/chat?ask=${encodeURIComponent('Find me a desk')}`, { maxMs: 6000 });
        assert.deepStrictEqual(await until(p, 'window.__mounted'), {
            actor: true, actions: { base: 'https://openvibe.network' }, base: 'https://openvibe.network/api/frame', starters: 4, open: null, sibling: '/shared/ov-picker.js', token: 'signed-in-test', title: 'Actor',
        }, 'the session surface, your Actor and the Action Center in it');
        assert.strictEqual(await p.evaluate('window.__prefill'), 'Find me a desk', '?ask= in the box');
        assert.deepStrictEqual(await p.evaluate("[!!document.querySelector('.ac-messenger.ac-session .stub-session'), !document.getElementById('ssr'), !window.__messenger]"), [true, true, true], 'it takes over the page; no messenger');
        await p.evaluate("window.__onEvent('session.opened', { ref: 'actor:run_9' })");
        assert.strictEqual(await p.evaluate('location.pathname + location.search'), '/chat?run=actor%3Arun_9', 'the address follows the open session');
        await p.evaluate("window.__onEvent('session.blank', {})");
        assert.strictEqual(await p.evaluate('location.pathname + location.search'), '/chat', 'and a new one');
        assert.strictEqual(await p.evaluate('document.documentElement.scrollWidth'), 390);

        const q = await h.openPage(browser, await browser.newContext(), { width: 390, height: 844 });
        await q.goto(`${base}/chat?run=actor:run_7`, { maxMs: 6000 });
        assert.strictEqual((await until(q, 'window.__mounted')).open, 'actor:run_7', '?run= opens that session');

        serveSession = false;
        const r = await h.openPage(browser, await browser.newContext(), { width: 390, height: 844 });
        await r.goto(`${base}/chat?run=actor:run_5`, { maxMs: 6000 });
        assert.deepStrictEqual(await until(r, 'window.__messenger'), { agent: true, open: 'actor:run_5' }, 'without ov-session.js, the messenger');
        console.log('chat-session-chrome: Actor\'s chat is the one session surface (your Actor, the Action Center, ?ask=, ?run=, the address); the messenger until Shared serves it');
    } finally {
        await browser.close();
        server.close();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
})().catch((e) => { console.error(e); process.exit(1); });

'use strict';
// A signed-in Actor with a three-turn chat, for looking at /chat in a browser (not run by test/run.js: only *.test.js
// are). Usage: node test/chat-shots.js [port]  → prints the address; the proxy signs every request in as kim.
const http = require('http');
const { boot } = require('./helpers/boot');

(async () => {
    const port = Number(process.argv[2]) || 0;
    const t = await boot();
    const kim = t.network.addUser('kim');
    const SAME = { 'sec-fetch-site': 'same-origin' };
    t.providers.state.cls = 'lookup';
    const one = (await t.get('/api/v1/tasks', { as: kim, json: { task: 'Who handles the mail for openvibe.network, and is DMARC set up?' }, headers: SAME })).json().id;
    await t.waitFor(one);
    const two = (await t.get(`/tasks/${one}/follow-up`, { as: kim, form: { task: 'And what about openvibe.live?' }, headers: SAME }));
    if (!/\/chat\//.test(two.headers.get('location') || '')) throw new Error('follow-up: ' + two.status + ' ' + two.headers.get('location'));
    const twoId = /\/chat\/(tsk_[0-9A-Z]+)/.exec(two.headers.get('location') || '')[1];
    await t.waitFor(twoId);
    t.providers.reset();
    t.providers.state.cls = 'research';
    t.providers.state.checkOk = false;
    const third = await t.get('/chat', { as: kim, form: { task: 'Summarise the news about OpenVibe this week', parent: twoId }, headers: SAME });
    const bad = (/\/chat\/(tsk_[0-9A-Z]+)/.exec(third.headers.get('location') || '') || [])[1];
    if (!bad) throw new Error('chat post: ' + third.status + ' ' + third.headers.get('location'));
    await t.waitFor(bad);
    t.providers.reset();
    t.providers.state.cls = 'lookup';
    const cookie = t.signIn(kim);
    const proxy = http.createServer((req, res) => {
        const headers = { ...req.headers, cookie: [cookie, req.headers.cookie].filter(Boolean).join('; '), host: new URL(t.base).host, origin: t.base };
        const up = http.request(t.base + req.url, { method: req.method, headers }, (r) => {
            const h = { ...r.headers };
            if (h.location && h.location.startsWith(t.base)) h.location = h.location.slice(t.base.length);
            res.writeHead(r.statusCode, h);
            r.pipe(res);
        });
        up.on('error', () => { res.writeHead(502); res.end(); });
        req.pipe(up);
    });
    await new Promise((r) => proxy.listen(port, '127.0.0.1', r));
    process.stdout.write(`chat ready http://127.0.0.1:${proxy.address().port}/chat/${one} first=${one} failed=${bad}\n`);
})().catch((e) => { process.stderr.write(String(e && e.stack)); process.exit(1); });

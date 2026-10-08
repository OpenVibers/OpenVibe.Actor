'use strict';
/**
 * Every page carries the openvibe-shared boost marker and self-starting script (plan T11), so a
 * same-site click swaps <main> in place without a reload. The marker names the layout's release,
 * which the app sets from openvibe-shared/release (a swap only happens between pages of the same
 * release; across a deploy it is a normal load), the boost tag names #main in data-main, and the
 * shared navbar's sign-in follows the current page through the {path} template.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

const MARKER = /<meta name="ov-boost" content="(actor@[0-9A-Za-z._+-]{1,64})">/;
const BOOST = /<script src="\/shared\/boost\.js\?v=[0-9a-f]{12}" data-main="#main" defer><\/script>/;

(async () => {
    const t = await boot();
    const user = t.network.addUser('kim');
    const release = (await t.get('/release.json')).json().release;

    await check('every rendered page carries the ov-boost marker (the app\'s release) and the data-main boost script', async () => {
        for (const p of ['/', '/agents', '/docs', '/updates']) {
            const r = await t.get(p);
            assert.strictEqual(r.status, 200, p);
            const m = r.text.match(MARKER);
            assert.ok(m, `${p}: no ov-boost marker`);
            assert.strictEqual(m[1], `actor@${release}`, `${p}: the marker is not the app's release`);
            assert.match(r.text, BOOST, `${p}: no boost script with data-main`);
            assert.match(r.text, /<main id="main"/, `${p}: the page's main is not #main`);
        }
        const signedIn = await t.get('/tasks', { as: user });
        assert.strictEqual(signedIn.status, 200);
        assert.match(signedIn.text, MARKER, '/tasks signed in: no ov-boost marker');
        assert.match(signedIn.text, BOOST, '/tasks signed in: no boost script');
    });

    await check('the home page head comes from openvibe-shared/shell with the same title, canonical, robots and JSON-LD', async () => {
        const r = await t.get('/');
        assert.strictEqual(r.status, 200);
        const head = r.text.slice(0, r.text.indexOf('</head>'));
        assert.strictEqual((r.text.match(/<title>/g) || []).length, 1, 'exactly one <title>');
        assert.ok(head.includes('<title>OpenVibe.Actor: your agent for everything</title>'), 'home title');
        assert.ok(head.includes('<link rel="canonical" href="https://openvibe.actor/">'), 'canonical');
        assert.ok(head.includes('<meta name="robots" content="index, follow">'), 'robots');
        const ld = [...head.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1])['@type']);
        assert.deepStrictEqual(ld, ['WebSite', 'WebApplication', 'WebPage'], 'the home JSON-LD');
        for (const tag of ['<meta property="og:title"', 'data-ov-icon="actor"', '/css/actor.css?v=', '/shared/theme-loader.js', '/shared/navbar.js', '/shared/footer.js', '<meta name="referrer"']) {
            assert.ok(head.includes(tag), `head has ${tag}`);
        }
        assert.ok(r.text.includes('id="ov-footer"'), 'the server-rendered footer');
        assert.ok(r.text.includes('OpenVibeFooter.init(window.__OV_PAGE.footer)'), 'the footer is initialised');
    });

    await check('the navbar config uses the {path} login template, not the path baked in', async () => {
        const r = await t.get('/agents');
        assert.match(r.text, /"loginUrl":"\/auth\/login\?next=\{path\}"/);
        assert.ok(!/"loginUrl":"\/auth\/login\?next=%2F/.test(r.text), 'loginUrl still has the current path baked in');
    });

    await check('the agents page lists every catalog agent server-side, with no local path', async () => {
        const r = await t.get('/agents');
        assert.strictEqual(r.status, 200, r.text.slice(0, 300));
        assert.match(r.headers.get('content-type'), /^text\/html/);
        const agents = (await t.get('/api/v1/agents')).json().agents;
        assert.ok(agents.length > 0, 'the catalog has agents');
        for (const a of agents) {
            assert.ok(r.text.includes(`<code>${a.id}</code>`), `${a.id} listed`);
            assert.ok(r.text.includes(`id="${a.id}"`), `${a.id} has its anchor`);
        }
        assert.ok(!r.text.includes('/home/') && !r.text.includes('/mnt/'), 'no local filesystem path on the page');
    });

    await t.close();
    done();
})().catch((e) => { console.error(e); process.exit(1); });

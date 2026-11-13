'use strict';
// Screenshots of the two connector pages (plan §Z.6): the person's own section on their Settings page and the
// owner's own page, at 390 and 1280, in dark. The overflow and the tap-target sizes are printed for the report.
// Usage: node test/connectors-shots.js <outdir>
const fs = require('fs');
const path = require('path');
const h = require('openvibe-shared/browser-harness');
const { boot } = require('./helpers/boot');

const SAME_SITE = { 'sec-fetch-site': 'same-origin' };

(async () => {
    const out = process.argv[2] || path.join(__dirname, '..', '..', 'actor-connectors-shots');
    fs.mkdirSync(out, { recursive: true });
    const t = await boot();
    const owner = t.network.addUser('owner', { isOwner: true });
    const kim = t.network.addUser('kim');
    // The owner turns one connector off for everyone and sets a limit of calls a day; the person turns one on and
    // one off, so the pages show every state.
    await t.get('/api/v1/admin/connectors', {
        as: owner, method: 'PUT',
        json: { connectors: [{ id: 'email', enabled: false }, { id: 'openvibe', enabled: true, daily_cap: 50 }] },
        headers: SAME_SITE,
    });
    await t.get('/api/v1/me/connectors', {
        as: kim, method: 'PUT',
        json: { connectors: [{ id: 'money', enabled: true }, { id: 'space', enabled: false }] },
        headers: SAME_SITE,
    });

    const browser = await h.launch({});
    const pages = [['settings', '/chat/settings', kim], ['owner', '/owner/connectors', owner]];
    try {
        for (const [name, url, user] of pages) {
            for (const width of [390, 1280]) {
                const page = await h.openPage(browser, await browser.newContext(), { width, height: 1400 });
                await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
                await page.send('Network.setCookie', { name: 'actor_at', value: t.signIn(user).replace(/^actor_at=/, ''), url: t.base, path: '/' });
                await page.goto(t.base + url, { maxMs: 10000 });
                await new Promise((r) => setTimeout(r, 1500));
                const shot = path.join(out, `connectors-${name}-${width}-dark.png`);
                const png = await page.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
                fs.writeFileSync(shot, Buffer.from(png.data, 'base64'));
                const read = await page.evaluate(`(() => {
                    const seen = (e) => e.closest('.cn-conn, .ct-settings, .ovk-set-row, .cn-card');
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

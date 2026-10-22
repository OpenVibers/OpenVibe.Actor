'use strict';
/**
 * The home page's data sections (server/http/pages.js): the numbers come from the catalog, the running config and
 * OpenVibe.Tools' catalog; a template fills the task box (signed out, it waits for sign-in); the tools Actor can run
 * are only the callable ones; the FAQPage JSON-LD holds exactly the questions the page shows.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

(async () => {
    const t = await boot();
    const user = t.network.addUser('kim');
    const section = (html, id) => (new RegExp(`<section class="sc-sec[^"]*"[^>]*aria-labelledby="${id}"[\\s\\S]*?</section>`).exec(html) || [''])[0];

    await check('the stat row: agents working, tools it can run, modes, the free tier', async () => {
        const r = await t.get('/');
        assert.strictEqual(r.status, 200);
        assert.match(r.text, /<b>1<\/b><span>tools it can run<\/span>/, 'only the callable tool (mx), not the job tool');
        assert.match(r.text, /<b>5<\/b><span>ways to choose<\/span>/);
        assert.match(r.text, /<b>\d+<\/b><span>free tasks a day<\/span>/);
        assert.match(r.text, /<b>\d+<\/b><span>agents? working now<\/span>/);
        const tools = section(r.text, 'h-tools');
        assert.match(tools, />MX Lookup</);
        assert.ok(!tools.includes('Video download'), 'a job tool is not offered');
        assert.match(r.text, /<link rel="stylesheet" href="\/css\/home\.css\?v=[0-9a-f]{10}">/);
    });

    await check('templates fill the task box; signed out, the chosen task waits for sign-in', async () => {
        const home = await t.get('/');
        const templates = section(home.text, 'h-templates');
        const links = [...templates.matchAll(/class="hm-template" href="([^"]+)"/g)].map((m) => m[1].replace(/&amp;/g, '&'));
        assert.ok(links.length >= 8, 'one link per template');
        const privateOne = links.find((l) => l.includes('mode=private'));
        assert.ok(privateOne, 'the private template names its mode');
        const signedIn = await t.get(privateOne.replace(/#.*$/, ''), { as: user });
        assert.match(signedIn.text, /<textarea id="task"[^>]*>Summarize the following note in three bullet points, without it leaving OpenVibe:<\/textarea>/);
        assert.match(signedIn.text, /<input type="radio" name="mode" value="private" checked>/);
        const guest = await t.get('/?task=Explain%20DNS&mode=nope');
        assert.match(guest.text, /<blockquote class="hm-chosen">Explain DNS<\/blockquote>/);
        assert.match(guest.text, /href="\/auth\/login\?next=%2F%3Ftask%3DExplain%2BDNS%26mode%3Dbalanced">Sign in to run it</);
        assert.match(guest.text, /<link rel="canonical" href="https:\/\/openvibe\.actor\/">/, 'a template link is still the home page');
        assert.match(guest.headers.get('cache-control') || '', /private/, 'a prefilled page is never kept by a shared cache');
    });

    await check('JSON-LD: the agents as an ItemList and exactly the questions shown as a FAQPage', async () => {
        const r = await t.get('/');
        const ld = [...r.text.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));
        const list = ld.find((x) => x['@type'] === 'ItemList');
        const agents = (await t.get('/api/v1/agents')).json().agents;
        assert.strictEqual(list.numberOfItems, agents.length);
        const faq = section(r.text, 'h-faq');
        const shown = [...faq.matchAll(/<h3>([^<]+)<\/h3>/g)].map((m) => m[1].replace(/&#39;/g, "'"));
        assert.ok(shown.length >= 6);
        assert.deepStrictEqual(ld.find((x) => x['@type'] === 'FAQPage').mainEntity.map((q) => q.name), shown);
        assert.strictEqual((r.text.match(/<h1[ >]/g) || []).length, 1, 'one h1');
    });

    await t.close();
    done();
})();

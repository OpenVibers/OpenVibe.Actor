'use strict';
/**
 * The home page (server/http/pages.js) is a taste and a door: the numbers as one kit.stats strip, the task box with the
 * tasks to start from as a rail of kit cards, the agents as rows, the parts read once as folds, the questions and the
 * rest of OpenVibe as a launcher. The numbers come from the catalog, the running config and OpenVibe.Tools' catalog; a
 * template fills the task box (signed out, it waits for sign-in) with what it needs said there; the tools Actor can run
 * are only the callable ones; the FAQPage JSON-LD holds exactly the questions the page shows.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

(async () => {
    const t = await boot();
    const user = t.network.addUser('kim');
    const section = (html, id) => (new RegExp(`<section class="sc-sec[^"]*"[^>]*aria-labelledby="${id}"[\\s\\S]*?</section>`).exec(html) || [''])[0];
    // A fold's body: its anchor (id) sits inside it, so a link to the anchor opens the fold.
    const foldOf = (html, id) => (new RegExp(`<details class="ovk-fold"><summary>[\\s\\S]*?</summary><div class="ovk-fold-body"><div id="${id}">[\\s\\S]*?</details>`).exec(html) || [''])[0];
    const stat = (label, value = '\\d+') => new RegExp(`<dt><a href="[^"]+">${label}</a></dt><dd>${value}</dd>`);

    await check('one strip of numbers: agents working, tools it can run, modes, the free tier', async () => {
        const r = await t.get('/');
        assert.strictEqual(r.status, 200);
        assert.strictEqual((r.text.match(/<dl class="ovk-stats"/g) || []).length, 1, 'the numbers are one kit.stats strip');
        assert.match(r.text, stat('tools it can run', '1'), 'only the callable tool (mx), not the job tool');
        assert.match(r.text, /<dt><a href="#tools">tools it can run<\/a><\/dt>/, 'the tools number opens the tools fold');
        assert.match(r.text, stat('ways to choose', '5'));
        assert.match(r.text, stat('free tasks a day'));
        assert.match(r.text, stat('agents? to choose from'));
        const tools = foldOf(r.text, 'tools');
        assert.match(tools, />MX Lookup</);
        assert.ok(!tools.includes('Video download'), 'a job tool is not offered');
        assert.match(r.text, /<link rel="stylesheet" href="\/css\/home\.css\?v=[0-9a-f]{10}">/);
        // The shared kit draws it: kit.css (numbers, rows, folds) and room.css (cards, the rail), and no kit-web.js.
        assert.match(r.text, /<link rel="stylesheet" href="\/shared\/kit\.css\?v=/);
        assert.match(r.text, /<link rel="stylesheet" href="\/shared\/room\.css\?v=/);
        assert.ok(!/\/shared\/kit-web\.js/.test(r.text), 'no kit-web.js: no card menus, and the rail wraps on wide screens');
    });

    await check('the parts read once are folds; the agents are rows that open /agents; the rest of OpenVibe is a launcher', async () => {
        const r = await t.get('/');
        // The folds hold showcase sections of their own, so the part runs from its heading to the questions.
        const more = r.text.slice(r.text.indexOf('<h2 id="h-how">'), r.text.indexOf('<section class="sc-sec" id="faq"'));
        for (const id of ['route', 'why', 'status', 'tools', 'api']) assert.ok(foldOf(more, id), `the ${id} part is a fold`);
        assert.ok(!/<details class="ovk-fold" open/.test(more), 'every fold starts closed');
        assert.match(foldOf(more, 'status'), /OpenAI&#39;s web agent as one of the routed agents|OpenAI's web agent as one of the routed agents/, 'what works today is all still there');
        assert.match(foldOf(more, 'api'), /\/api\/v1\/route/, 'the API sample');
        const agents = section(r.text, 'h-agents');
        const listed = (await t.get('/api/v1/agents')).json().agents;
        for (const a of listed) assert.ok(agents.includes(`<a href="/agents#${a.id}">`), `${a.id} is a row that opens its place on /agents`);
        const page = await t.get('/agents');
        assert.match(page.text, /<p class="agent-blurb">/, 'what each agent is now lives on /agents');
        const launcher = (/<section class="sc-sec sc-apps-sec" id="network"[\s\S]*?<\/section>/.exec(r.text) || [''])[0];
        for (const host of ['openvibe.tools', 'openvibe.watch', 'openvibe.bot', 'openvibe.codes']) assert.ok(launcher.includes(`<a href="https://${host}/?ov_from=actor">`), `the launcher links ${host}`);
        assert.ok(!/class="(hm-template|hm-tgroup|agent-card|hm-qa)\b/.test(r.text), 'no hand-built card stacks are left');
    });

    await check('templates fill the task box; signed out, the chosen task waits for sign-in', async () => {
        const home = await t.get('/');
        const templates = (/<section class="ovk-rail[^"]*" id="templates"[\s\S]*?<\/section>/.exec(home.text) || [''])[0];
        const links = [...templates.matchAll(/class="ovk-card-link" href="([^"]+)"/g)].map((m) => m[1].replace(/&amp;/g, '&'));
        assert.ok(links.length >= 8 && links.length <= 12, `the tasks to start from are a rail of 8 to 12 cards (${links.length})`);
        assert.ok(!home.text.includes('task-box-guest'), 'signed out with nothing chosen, the hero\'s Sign in is the door (no second box)');
        assert.match(section(home.text, 'h-task'), /<a href="\/auth\/login\?next=%2F%23task">Sign in<\/a>/);
        const privateOne = links.find((l) => l.includes('mode=private'));
        assert.ok(privateOne, 'the private template names its mode');
        const signedIn = await t.get(privateOne.replace(/#.*$/, ''), { as: user });
        assert.match(signedIn.text, /<textarea id="task"[^>]*>Summarize the following note in three bullet points, without it leaving OpenVibe:<\/textarea>/);
        assert.match(signedIn.text, /<input type="radio" name="mode" value="private" checked>/);
        assert.match(signedIn.text, /<p class="hm-needs">Answered on OpenVibe&#39;s own model; nothing leaves OpenVibe\.<\/p>/, 'what the chosen task needs is said in the box');
        const guest = await t.get('/?task=Explain%20DNS&mode=nope');
        assert.match(guest.text, /<blockquote class="hm-chosen">Explain DNS<\/blockquote>/);
        assert.match(guest.text, /href="\/auth\/login\?next=%2F%3Ftask%3DExplain%2BDNS%26mode%3Dbalanced">Sign in to run it</);
        assert.ok(!guest.text.includes('class="hm-needs"'), 'a task that is not a template needs nothing said');
        assert.match(guest.text, /<link rel="canonical" href="https:\/\/openvibe\.actor\/">/, 'a template link is still the home page');
        assert.match(guest.headers.get('cache-control') || '', /private/, 'a prefilled page is never kept by a shared cache');
    });

    await check('JSON-LD: the agents as an ItemList and exactly the questions shown as a FAQPage', async () => {
        const r = await t.get('/');
        const ld = [...r.text.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));
        const list = ld.find((x) => x['@type'] === 'ItemList');
        const agents = (await t.get('/api/v1/agents')).json().agents;
        assert.strictEqual(list.numberOfItems, agents.length);
        const faq = (/<section class="sc-sec" id="faq"[\s\S]*?<\/section>/.exec(r.text) || [''])[0];
        const shown = [...faq.matchAll(/<summary>([^<]+)<\/summary>/g)].map((m) => m[1].replace(/&#39;/g, "'"));
        assert.ok(shown.length >= 6);
        assert.deepStrictEqual(ld.find((x) => x['@type'] === 'FAQPage').mainEntity.map((q) => q.name), shown);
        assert.strictEqual((r.text.match(/<h1[ >]/g) || []).length, 1, 'one h1');
        const description = /<meta name="description" content="([^"]*)"/.exec(r.text)[1].replace(/&#39;/g, "'");
        assert.ok(description.length <= 160, `the description fits a search result (${description.length} characters)`);
    });

    await t.close();
    done();
})();

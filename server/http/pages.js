'use strict';

/**
 * Public pages: the home page (give Actor a task), your tasks and one task (live progress, the answer, its cost and why
 * that agent), the agents (Actor as "OpenRouter for agents": every agent system with its rate card), the API reference
 * and the update log. Crawl artifacts (robots.txt, sitemap.xml, llms.txt, llms-full.txt, JSON-LD) are http/discovery.js.
 *
 * Every page works without JavaScript: the task form is a plain POST, a running task's page refreshes itself, and
 * public/js/task.js only adds the live stream on top. What is shown is read, never restated: the agents and their
 * prices are server/agents/catalog.js, the free tier is the running config.
 */
const ovServe = require('openvibe-shared/serve');
const frame = require('openvibe-shared/frame');
const showcase = require('openvibe-shared/showcase');
const kit = require('openvibe-shared/kit');
const cache = require('openvibe-shared/cache-policy');
const { asyncRouter } = require('./router');
const { createDiscoveryRoutes, homeJsonLd } = require('./discovery');
const { sameOrigin } = require('./principal');
const { html, raw, table, notice, time, badge } = require('../render/html');
const { send } = require('../render/layout');
const { markdown } = require('../render/markdown');
const store = require('../tasks/store');
const { createTask } = require('../tasks/create');
const catalog = require('../agents/catalog');
const looks = require('../agents/looks');
const { MODES } = require('../agents/router');
const seo = require('openvibe-shared/seo');
const { findArtifact, sendArtifact } = require('../runtime/artifacts');
const taskEvents = require('../../public/js/task-events');

const TASK_ID = /^tsk_[0-9A-HJKMNP-TV-Z]{26}$/;


const MODE_TEXT = {
    cheapest: 'The lowest cost that can do the task.',
    balanced: 'Cost and speed weighed together. The default.',
    best: 'The highest-quality agents first, then the best of the rest.',
    fastest: 'The quickest typical finish.',
    private: 'Only OpenVibe\'s own hardware: nothing leaves OpenVibe.',
};
const MODE_LABEL = { cheapest: 'Cheapest', balanced: 'Balanced', best: 'Best', fastest: 'Fastest', private: 'Private' };
const STATE_KIND = { queued: '', running: 'info', verifying: 'info', succeeded: 'ok', failed: 'bad', cancelled: '' };
const EXAMPLES = [
    'Who handles the mail for openvibe.network, and are its SPF and DMARC records set up properly?',
    'What changed in the latest Node.js LTS release? Give me the three changes that matter most, with sources.',
    'Explain the difference between a mutex and a semaphore with a short example.',
    'Is the TLS certificate of example.com valid, and when does it expire?',
];

// Tasks to start from, by what they need. Each one works today. On the home they are a rail of cards (kit.card): a short
// title, the kind as the badge and the card type's icon; the card's link puts the whole task in the task box, ready to run
// or change. What a robot, computer, desk or private task needs is said in the box once that task is chosen (NEEDS).
const TEMPLATES = [
    { group: 'Look it up', badge: 'Lookup', type: 'domain', items: [
        { title: 'Check a domain\'s mail setup', text: EXAMPLES[0] },
        { title: 'Is a site\'s certificate valid?', text: EXAMPLES[3] },
    ] },
    { group: 'Research with sources', badge: 'Research', type: 'report', items: [
        { title: 'What changed in the latest Node.js LTS', text: EXAMPLES[1] },
        { title: 'Which licences let you sell hosted copies', text: 'Which open-source licences let me sell hosted copies of the software? Compare MIT, Apache-2.0, GPL-3.0 and AGPL-3.0, with sources.' },
    ] },
    { group: 'Write and explain', badge: 'Write', type: 'post', items: [
        { title: 'A mutex and a semaphore, explained', text: EXAMPLES[2] },
        { title: 'A note telling viewers the stream moves', text: 'Write a short, friendly note telling my viewers the stream starts an hour later on Friday.', mode: 'cheapest' },
    ] },
    { group: 'Across OpenVibe', badge: 'OpenVibe', type: 'stream', items: [
        { title: 'The best posts and clips on Pi robots', text: 'Find recent posts and clips on OpenVibe about Raspberry Pi robots, and link the best three.' },
    ] },
    { group: 'Your robot', badge: 'Robot', type: 'toy', needs: 'Turn on Your agent on the robot\'s panel first.', items: [
        { title: 'Drive your rover and say hello', text: 'Drive my rover forward for two seconds, turn on its headlights, then say hello.' },
    ] },
    { group: 'Your computer', badge: 'Computer', type: 'site', needs: 'Needs the OpenVibe Node\'s computer plugin on that machine.', items: [
        { title: 'The ten largest files in your Downloads', text: 'On my computer, list the ten largest files in my Downloads folder.' },
    ] },
    { group: 'On a desk of its own', badge: 'Desk', type: 'cam', needs: 'Needs a computer or desk host with the OpenVibe Node\'s computer plugin. Watch the desk and take it over from the task.', items: [
        { title: 'Who is live on OpenVibe, and about what', text: 'On my computer, open openvibe.live in your own browser on a desk of your own, and tell me who is live right now and what each stream is about.' },
        { title: 'Sign in on its desk, then read your account', text: 'On my computer, open the sign-in page of <a site I use> on your desk and hand it to me to sign in; then tell me what my account page shows.' },
    ] },
    { group: 'Private', badge: 'Private', type: 'person', needs: 'Answered on OpenVibe\'s own model; nothing leaves OpenVibe.', items: [
        { title: 'Summarize a note without it leaving OpenVibe', text: 'Summarize the following note in three bullet points, without it leaving OpenVibe:', mode: 'private' },
    ] },
];
const templateHref = (t) => `/?${new URLSearchParams({ task: t.text, ...(t.mode ? { mode: t.mode } : {}) })}#task`;
const NEEDS = new Map(TEMPLATES.flatMap((g) => (g.needs ? g.items.map((t) => [t.text, g.needs]) : [])));

const usd = (n) => (n == null ? '—' : n === 0 ? '$0' : n < 0.01 ? `$${Number(n).toFixed(4)}` : `$${Number(n).toFixed(2)}`);

// ── The task page v2 (Actor v2, stage V2-5): the plan, the evidence behind each claim, the files, the check, honestly ──
// What a tool is called on the page; an unknown one reads as its own name with spaces.
const TOOL_LABEL = {
    search_web: 'Web search', read_page: 'Read a page', search_openvibe: 'OpenVibe search', wikipedia: 'Wikipedia',
    weather_now: 'Weather', market_quote: 'Market price', currency_convert: 'Currency', time_in: 'Local time',
    convert_time: 'Time zones', geocode: 'Place lookup', place_info: 'Place', sports_scores: 'Sports scores',
    calculate: 'Calculator', make_file: 'File', make_chart: 'Chart', run_tool: 'OpenVibe tool', find_tools: 'Find a tool',
    codes_task: 'Coding task', robot_steps: 'Robot', list_my_robots: 'Your robots', list_my_computers: 'Your computers',
};
const toolLabel = (name) => TOOL_LABEL[name] || String(name || 'tool').replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
// A model id as people say it: "deepseek:deepseek-flash" → "DeepSeek Flash", "openai:gpt-5.1" → "GPT-5.1".
const BRANDS = { deepseek: 'DeepSeek', gpt: 'GPT', openai: 'OpenAI', minimax: 'MiniMax', claude: 'Claude', gemini: 'Gemini', qwen: 'Qwen', glm: 'GLM', kimi: 'Kimi' };
function modelName(id) {
    const m = String(id || '').split(':').pop();
    if (!m) return 'another model';
    if (/^gpt-/i.test(m)) return `GPT-${m.slice(4)}`;
    return m.split('-').map((w) => BRANDS[w.toLowerCase()] || (w ? w[0].toUpperCase() + w.slice(1) : w)).join(' ');
}
const ago = (ms) => {
    const s = Math.max(0, Math.round(ms / 1000));
    return s < 60 ? `${s} s` : s < 3600 ? `${Math.floor(s / 60)} min${s % 60 ? ` ${s % 60} s` : ''}` : `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min`;
};
/** What a tool was asked, in a few words: its query, address or need, else its input as JSON. */
function inputText(input) {
    if (input == null) return '';
    if (typeof input !== 'object') return String(input).slice(0, 160);
    const v = input.query || input.url || input.need || input.place || input.symbol || input.expression || input.name || input.title;
    if (v != null) return String(v).slice(0, 160);
    // Otherwise its plain fields, as words: "to USD · from EUR · amount 7.6".
    const plain = Object.entries(input).filter(([, x]) => x != null && typeof x !== 'object').map(([k, x]) => `${k.replace(/_/g, ' ')} ${x}`);
    return (plain.length ? plain.join(' · ') : JSON.stringify(input)).slice(0, 160);
}
/**
 * The answer's citations as chips: "[E3]" (or "[E3, E5]") becomes a numbered chip that opens what that tool returned,
 * for the ids the ledger has; nothing inside code changes, and an id the ledger does not have stays as written.
 */
function chipify(htmlText, evidence) {
    const known = new Map((evidence || []).map((e) => [String(e.id), e]));
    if (!known.size) return htmlText;
    const chip = (id) => {
        const e = known.get(id);
        const n = id.slice(1);
        const label = `Evidence ${n}: ${toolLabel(e.tool)}${inputText(e.input) ? `, ${inputText(e.input)}` : ''}`.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
        return `<a class="ev" href="#ev-${id}" data-ev="${id}" aria-label="${label}" title="${label}">${n}</a>`;
    };
    return String(htmlText).split(/(<pre[\s\S]*?<\/pre>|<code[\s\S]*?<\/code>)/).map((part, i) => (i % 2 ? part : part.replace(/\[(E\d{1,3}(?:\s*,\s*E\d{1,3})*)\]/g, (all, ids) => {
        const list = ids.split(/\s*,\s*/);
        return list.every((id) => known.has(id)) ? `<span class="evs">${list.map(chip).join('')}</span>` : all;
    }))).join('');
}
const perM = (n) => (n === 0 ? 'free' : `$${Number(n).toFixed(2)}`);
const priceText = (rc) => (rc.input_usd_per_mtok === 0 && rc.output_usd_per_mtok === 0 ? 'Free (OpenVibe hardware)' : `${perM(rc.input_usd_per_mtok)} in · ${perM(rc.output_usd_per_mtok)} out per 1M tokens${rc.per_call_usd ? ` · ${usd(rc.per_call_usd)} a search` : ''}`);

function createPageRoutes(ctx) {
    const { config, s, engine } = ctx;
    const r = asyncRouter();
    const PUBLIC_CACHE = cache.htmlHeaders({ maxAge: 300 });
    const page = (req, res, o, status = 200) => send(res, status, { viewer: req.viewer, config, path: req.originalUrl, ...o });
    const signedIn = (req) => req.viewer && req.viewer.kind === 'user' && req.viewer.subject;
    const requesterOf = (req) => `user:${req.viewer.subject}`;
    const tier = config.allowance;

    // ── The task box ─────────────────────────────────────────
    function taskForm(viewer, { text = '', mode = 'balanced', problem = null } = {}) {
        // What a chosen template needs (a robot, a computer, a desk, private mode) is said where it is about to run.
        const needs = NEEDS.has(text) ? html`<p class="hm-needs">${NEEDS.get(text)}</p>` : '';
        if (!(viewer.kind === 'user' && viewer.subject)) {
            // A template picked while signed out waits in the box and comes back after sign-in.
            const next = text ? `/?${new URLSearchParams({ task: text, mode })}` : '/#task';
            return html`<div class="task-box task-box-guest">
${text ? html`<p class="task-box-lead">Your task, ready to run once you sign in:</p><blockquote class="hm-chosen">${text}</blockquote>${needs}`
        : html`<p class="task-box-lead">Sign in with your OpenVibe account and ask in plain words. Not sure what to ask? Start from one of the tasks below.</p>`}
<div class="task-actions"><a class="sc-btn sc-primary" href="/auth/login?next=${encodeURIComponent(next)}">${text ? 'Sign in to run it' : 'Sign in to start'}</a><span class="muted small">Free: ${tier.tasksPerDay} tasks a day, no card.</span></div></div>`;
        }
        return html`<form class="task-box" method="post" action="/tasks">
${problem ? notice(problem, 'warn') : ''}
<label class="task-label" for="task">What should Actor do?</label>
<textarea id="task" name="task" rows="4" maxlength="20000" required placeholder="${EXAMPLES[0]}">${text}</textarea>${needs}
<fieldset class="modes"><legend>Mode</legend>
${MODES.map((m) => html`<label class="mode"><input type="radio" name="mode" value="${m}"${m === mode ? raw(' checked') : ''}><span><b>${MODE_LABEL[m]}</b><small>${MODE_TEXT[m]}</small></span></label>`)}
</fieldset>
<div class="task-actions"><button class="sc-btn sc-primary" type="submit">Run it</button><span class="muted small">Up to ${usd(tier.perTaskUsd)} a task on the free tier; you see the real cost to a fraction of a cent.</span></div>
</form>`;
    }

    // ── Home ─────────────────────────────────────────────────
    // The OpenVibe.Tools tools the runtime can call (the adapters' own cached catalog), waited for at most a second.
    async function callableTools() {
        const ov = ctx.adapters && ctx.adapters.tools;
        if (!ov || typeof ov.tools !== 'function') return [];
        const list = await Promise.race([ov.tools().catch(() => []), new Promise((resolve) => setTimeout(() => resolve([]), 1000).unref())]);
        return (Array.isArray(list) ? list : []).filter((t) => t && t.id && t.name);
    }

    // The front page is a taste and a door, not the manual (owner 2026-10-28: "act more like an app, not a huge long web
    // page"): the hero with one sample decision, the numbers as one strip, the task box with tasks to start from as a
    // rail, the agents as rows, and the parts read once (how routing works, the comparison, what works today, the tools,
    // the API) as folds. Everything stays on the page, so search engines, the Markdown twin and find-in-page still see it.
    async function homePage({ viewer = { kind: 'anonymous' }, query = {}, form = {} } = {}) {
        const agents = catalog.list(config);
        const tools = await callableTools();
        const signed = viewer.kind === 'user' && viewer.subject;
        // A template link (/?task=…&mode=…#task) fills the task box; the page itself stays the canonical /.
        if (!form.text && typeof query.task === 'string') form = { text: query.task.slice(0, 2000), mode: MODES.includes(query.mode) ? query.mode : 'balanced' };
        const working = agents.filter((a) => a.available).length;
        const faq = faqItems(agents);
        const hero = showcase.hero({
            eyebrow: 'OpenVibe.Actor · your agent for everything · alpha',
            title: 'Ask once.', accent: 'The right agent does it.',
            lede: 'Give Actor a task in plain words. It picks the agent that fits, OpenVibe\'s own or another platform\'s, has a second model check the answer, and shows you what it cost and why. Like OpenRouter, for agents.',
            actions: signed ? [{ label: 'Give it a task', href: '#task', primary: true }, { label: 'Your tasks', href: '/tasks' }] : [{ label: 'Sign in to start', href: '/auth/login?next=%2F', primary: true }, { label: 'See the agents', href: '/agents' }],
            note: `Open source (AGPL-3.0). Free: ${tier.tasksPerDay} tasks a day, up to ${usd(tier.perTaskUsd)} each, no card.`,
            aside: { html: String(routerCard(agents)) },
        });
        // One strip of numbers (it scrolls sideways on a phone instead of stacking four tiles); zero is left out.
        const stats = kit.stats([
            [working, working === 1 ? 'agent working now' : 'agents working now', '#agents'],
            [tools.length, 'tools it can run', '#tools'],
            [MODES.length, 'ways to choose', '/agents#modes'],
            [tier.tasksPerDay, 'free tasks a day', '#faq'],
        ], { label: 'OpenVibe.Actor in numbers' });
        // Tasks to start from: one card each, the kind as its badge and a non-default mode in its corner.
        const starts = kit.rail({
            id: 'templates', title: 'Start from one of these',
            items: TEMPLATES.flatMap((g) => g.items.map((t) => kit.card({ href: templateHref(t), title: t.title, type: g.type, ratio: '3/1', badge: g.badge, corner: t.mode && MODE_LABEL[t.mode] !== g.badge ? MODE_LABEL[t.mode] : '', peek: t.text, share: false }))),
        });
        // Signed out and nothing chosen yet, the hero's Sign in is the door: the box would only repeat it.
        const box = signed || form.text ? taskForm(viewer, form)
            : html`<p class="sc-lede"><a href="/auth/login?next=%2F%23task">Sign in</a> with your OpenVibe account and ask in plain words, or pick a task below: it waits in the box while you sign in.</p>`;
        // A part read once folds (kit.fold). Its anchor sits inside the fold, so a link to it (#tools, #api) opens it.
        const fold = ({ id, body, ...o }) => raw(kit.fold({ ...o, body: `<div id="${id}">${body}</div>` }));
        const status = [
            ['The task router: modes, budgets, the explanation, live progress, cancel', 'Live.'],
            ['OpenVibe runtime acting through OpenVibe.Search and OpenVibe.Tools', 'Live.'],
            ['OpenAI\'s web agent as one of the routed agents', 'Live.'],
            ['Private mode on an open model on OpenVibe\'s server', 'Live: short answers that never leave OpenVibe; tasks that need search or tools go to the other agents.'],
            ['A second-family check on every answer, and hand-off on failure', 'Live.'],
            [html`The API (<a href="/docs">docs</a>): tasks, the live stream, <a href="/docs#webhooks">signed webhooks</a>, the agents and a dry-run router`, 'Live, for people and for apps with actor.task.* grants from OpenVibe.Services.'],
            [html`Tasks a watch hands over when its condition fires (<a href="https://openvibe.watch">OpenVibe.Watch</a>)`, 'Live: the task is yours, with your allowance; Watch sees only the tasks it started.'],
            [html`Your own agents (<a href="/me/agents">Your agents</a>): instructions, memory you can read and edit, a schedule (hourly, daily or weekly), a budget per run and a daily cap`, 'Live.'],
            [html`Your own robots on <a href="https://openvibe.bot">OpenVibe.Bot</a>: see them and drive the ones you opened to your agent, through Bot's limits and e-stop`, 'Live: turn on "Let my OpenVibe.Actor agent drive this robot" on the robot\'s panel.'],
            [html`Coding tasks on your own machine, through <a href="https://openvibe.codes/run">OpenVibe.Codes</a>: name the repository and what to change, and get the summary, the files and the patch`, html`Live: add the machine on <a href="https://openvibe.bot/machines">openvibe.bot/machines</a> and start one task on openvibe.codes/run first. The model use is on your machine's own keys.`],
            [html`Your own computers, through <a href="https://openvibe.bot/docs/computers">OpenVibe.Bot</a>: list and read files, run programs and write files there, as you, at the level you set on the computer`, html`Live: install OpenVibe Node with <code>--computer ask</code> and turn on "Let my agent use this computer" on <a href="https://openvibe.bot/machines">openvibe.bot/machines</a>. At <code>ask</code>, you approve each run or write on the computer.`],
            [html`<a href="/console">The Console</a>: what runs now, what waits for you, today's spend, your agents, computers and robots, and one box to start a task`, 'Live, for signed-in people.'],
            [html`Ask in chat: write <code>@actor</code> and your question in OpenVibe's global chat or your own channel, and the answer comes back in the room`, 'Live: public tools only (never your computers, robots or code), 5 an hour, on your free tier.'],
            [html`Run your own: Actor on your server with your own model (<a href="https://github.com/OpenVibers/OpenVibe.Actor/blob/main/docs/self-host.md">how</a>), signed in with your password, data on your disk`, 'Live: Docker or plain Node, Ollama or any OpenAI-compatible model.'],
        ];
        // The rest of OpenVibe as a launcher (four icons in a row on a phone), with the referral tag showcase.network adds.
        const related = (showcase.RELATED.actor || []).map(([to, what, href]) => ({ icon: `ov:${to}`, name: to.charAt(0).toUpperCase() + to.slice(1), text: what, href: `${href}?ov_from=actor` }));
        return {
            agent: true, index: true, cache: signed && !query.task ? null : query.task ? cache.htmlHeaders({ private: true }) : PUBLIC_CACHE,
            jsonLd: [...homeJsonLd(config),
                seo.jsonLd.itemList('Agents OpenVibe.Actor routes tasks to', agents.map((a) => ({ name: a.name, url: `${config.baseUrl}/agents#${a.id}`, description: (catalog.byId(a.id) || {}).blurb }))),
                seo.jsonLd.faq(faq.map(([q, a]) => ({ q, a })))],
            // kit.css: the numbers, rows, badges and folds; room.css: the cards and the rail. No kit-web.js: no card has a
            // menu, and from 760 px the rail wraps instead of scrolling, so it needs no arrow buttons.
            styles: [showcase.STYLESHEET, 'kit.css', 'room.css'],
            css: ['css/home.css'],
            body: html`${raw(hero)}
<div class="hm-stats-sec">${raw(stats)}</div>
<section class="sc-sec hm-task" id="task" aria-labelledby="h-task"><h2 id="h-task">Give Actor a task</h2>
${box}
${raw(starts)}</section>
<section class="sc-sec" id="agents" aria-labelledby="h-agents"><h2 id="h-agents">The agents</h2>
<p class="sc-lede">Every agent Actor can route to, what it charges and whether it is working right now. <a href="/agents">What each one is, its modes and details</a>.</p>
${raw(kit.list(agents.map((a) => kit.row({ href: `/agents#${a.id}`, title: a.name, badge: a.available ? kit.badge('working', 'ok') : kit.badge('not here yet'), sub: `${priceText(a.rate_card)}${a.model ? ` · ${a.model}` : ''}` }))))}</section>
<section class="sc-sec hm-more" aria-labelledby="h-how"><h2 id="h-how">How it works</h2>
${fold({ id: 'route', title: 'How a task finds its agent', meta: '5 steps', body: showcase.steps({
                items: [
                    { title: 'Sort the task', text: 'An answer, a lookup, research, a live web search, code, your own robot or your own computer: that decides what an agent must be able to do.' },
                    { title: 'Hard limits first', text: 'An agent that cannot do it, that private mode does not trust, that is down or that would cost more than your budget is out, and the task says why.' },
                    { title: 'Then your mode', text: 'Cheapest, Balanced, Best, Fastest or Private picks among the rest, through the same placement engine every OpenVibe service uses.' },
                    { title: 'Run, check, deliver', text: 'The agent works while you watch its steps; another model checks the answer, from another model family where one is available; you get the answer, its sources, the cost and the explanation.' },
                    { title: 'Or hand it on', text: 'An agent that fails, or an answer that fails its check, goes to the next agent that can do it, within your budget.' },
                ],
            }) })}
${fold({ id: 'why', title: 'Why a router, not one agent', meta: 'compared', body: showcase.compare({
                lede: 'One company\'s agent is as good as that company\'s models and tools. Actor picks per task, and can use theirs too.',
                columns: ['OpenVibe.Actor', 'A single-vendor agent'],
                rows: [
                    { label: 'Picks the best agent for each task', values: [true, false] },
                    { label: 'Can hand a task to another platform\'s agent', values: [true, false] },
                    { label: 'Shows the cost and why, per task', values: [true, false] },
                    { label: 'A second model family checks the answer', values: [true, false] },
                    { label: 'A private mode on its own hardware', values: [true, false] },
                    { label: 'Open source, self-hostable', values: [true, false] },
                    { label: 'Free tier', values: [true, null] },
                ],
            }) })}
${fold({ id: 'status', title: 'What works today', meta: `${status.length} pieces, all live`, body: String(table(['Piece', 'State'], status)) })}
${tools.length ? fold({ id: 'tools', title: 'Tools it can run', meta: `${tools.length} from OpenVibe.Tools`, body: String(html`<p class="muted">For exact answers, OpenVibe's own agent runs these ${tools.length} OpenVibe.Tools tools itself instead of guessing: the same public tools anyone can use on openvibe.tools.</p>
<ul class="hm-chips hm-tools">${tools.map((t) => html`<li>${/^https:\/\//.test(t.docs || '') ? html`<a href="${t.docs}">${t.name}</a>` : t.name}</li>`)}</ul>`) }) : ''}
${fold({ id: 'api', title: 'Hand it tasks from your own code', meta: 'curl, JavaScript', body: showcase.code({
                lede: 'Every task, its live stream and its webhooks are an API, and the router answers a dry run with no account at all. Apps get actor.task.* grants on OpenVibe.Services.',
                samples: [
                    { label: 'Which agent, what cost (curl, no token)', lang: 'sh', code: `curl -X POST ${config.baseUrl}/api/v1/route \\\n  -H 'Content-Type: application/json' \\\n  -d '{"task": "Is the certificate of example.com valid?",\n       "mode": "cheapest"}'` },
                    { label: 'JavaScript (openvibe-sdk)', lang: 'js', code: "import { createClient } from 'openvibe-sdk/core';\nimport { createActorClient } from 'openvibe-sdk/actor';\n\nconst actor = createActorClient(\n    createClient({ credentials: 'include' }));\nconst task = await actor.tasks.create({\n    task: 'Summarize the latest Node.js release',\n});\nfor await (const e of actor.tasks.events(task.id)) {\n    console.log(e.event, e.data);\n}" },
                ],
            }) + String(html`<p class="hm-api-more"><a class="sc-btn sc-primary" href="/docs">Read the API</a></p>`) })}
</section>
${raw(showcase.faq({ id: 'faq', items: faq }))}
<div class="hm-net">${raw(showcase.apps({ id: 'network', title: 'Part of OpenVibe', lede: 'One account across every OpenVibe site. Related places to go next:', items: related }))}</div>`,
        };
    }

    /** Render the home page through the route's own response shape (the POST failure path reuses it). */
    async function home(req, res, { status = 200, form = {} } = {}) {
        return page(req, res, await homePage({ viewer: req.viewer, query: req.query, form }), status);
    }

    /** Questions people ask first, answered from the running config and the catalog. */
    function faqItems(agents) {
        const names = agents.filter((a) => a.available).map((a) => a.name);
        const list = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0] || '';
        return [
            ['What does OpenVibe.Actor do?', 'You describe a task in plain words. Actor sorts it, picks the agent that can do it best within your budget and mode, runs it while you watch its steps, has a second model check the answer, and shows you the answer with its sources, what it cost and why that agent.'],
            ['What does it cost?', `The free tier gives ${tier.tasksPerDay} tasks a day, up to ${usd(tier.perTaskUsd)} each, with no card. Every task shows its real cost to a fraction of a cent.`],
            list ? ['Which agents does it use?', `${list} are working now. The agents page lists each one with its price per million tokens and what it can do.`] : null,
            ['Is the answer checked?', 'Yes. A second model reads every answer before you see it, from another model family where one is available. An answer that fails its check goes to the next agent that can do the task.'],
            ['What is private mode?', 'Private mode uses only an open model on OpenVibe\'s own server, so the task never leaves OpenVibe. It is for short answers; tasks that need search or tools go to the other agents in the other modes.'],
            ['Can it use my computer or my robot?', 'Only if you turn it on. On openvibe.bot you let your agent use a computer or drive a robot, one at a time. On a computer at the ask level, each program or write waits for your approval on that computer.'],
            ['Can I run it myself?', 'Yes. Actor is open source under the AGPL-3.0 and runs on your own server with Docker or plain Node and your own model, such as Ollama or any OpenAI-compatible one.'],
            ['Can my app use it?', 'Yes. Apps get actor.task.* grants on OpenVibe.Services and use the same API: create a task, follow its live stream, and receive signed webhooks when it ends.'],
        ].filter(Boolean);
    }

    function routerCard(agents) {
        const shown = agents.filter((a) => a.id !== 'codes');
        return html`<figure class="router-card" aria-label="How Actor picked an agent for a sample task">
<figcaption><span class="muted small">Sample task · Balanced</span><b>“Who handles the mail for openvibe.network, and is DMARC set up?”</b></figcaption>
<ol>${shown.map((a, i) => html`<li class="${i === 0 ? 'pick' : ''}"><span class="rc-name">${a.name}</span><span class="rc-cost">~${usd(catalog.typicalCost(a.id, config))}</span><span class="rc-why">${i === 0 ? 'can run the DNS tools; cheapest that can' : a.can.includes('task:lookup') ? 'can do it, costs more' : 'cannot run lookups'}</span></li>`)}</ol>
<p class="rc-foot">Checked by a second model before you see it.</p></figure>`;
    }

    r.get('/', (req, res) => home(req, res));

    // ── Create from the form (POST /tasks) ───────────────────
    r.post('/tasks', require('express').urlencoded({ extended: false, limit: '64kb' }), async (req, res) => {
        res.set('Cache-Control', cache.htmlHeaders({ private: true }));
        if (!signedIn(req)) return res.redirect(303, '/auth/login?next=%2F');
        if (!sameOrigin(req, config.baseUrl)) return res.status(403).type('text/plain').send('A task must be sent from openvibe.actor itself.');
        const text = String((req.body && req.body.task) || '').slice(0, 20000);
        const mode = MODES.includes(req.body && req.body.mode) ? req.body.mode : 'balanced';
        const out = await createTask({ s, config, engine, principal: { requester: requesterOf(req), project: null }, body: { task: text, mode } });
        if (out.code) return home(req, res, { status: out.status === 503 || out.status === 429 ? out.status : 422, form: { text, mode, problem: out.detail } });
        return res.redirect(303, `/tasks/${out.task.id}`);
    });

    // ── Your tasks ───────────────────────────────────────────
    r.get('/tasks', async (req, res) => {
        if (!signedIn(req)) {
            return page(req, res, { title: 'Your tasks', crumbs: [{ label: 'Your tasks' }], body: html`<h1>Your tasks</h1><p>Sign in to see the tasks you gave Actor.</p><p><a class="sc-btn sc-primary" href="/auth/login?next=%2Ftasks">Sign in</a></p>` });
        }
        const before = typeof req.query.before === 'string' && TASK_ID.test(req.query.before) ? req.query.before : null;
        const pageRows = await store.listTasks(s, requesterOf(req), { limit: 30, before });
        const today = await store.spendToday(s, requesterOf(req));
        page(req, res, {
            title: 'Your tasks', crumbs: [{ label: 'Your tasks' }], styles: [showcase.STYLESHEET],
            body: html`<h1>Your tasks</h1>
<p class="muted">Today: ${today.tasks} of ${tier.tasksPerDay} free tasks, ${usd(today.usd)} of ${usd(tier.perDayUsd)}. Tasks are kept ${store.RETENTION_DAYS} days.</p>
${taskForm(req.viewer)}
${table(['Task', 'State', 'Agent', 'Cost', 'Started'], pageRows.rows.map((t) => {
                const result = t.result ? (typeof t.result === 'string' ? JSON.parse(t.result) : t.result) : null;
                return [html`<a href="/tasks/${t.id}">${t.task.length > 90 ? `${t.task.slice(0, 89)}…` : t.task}</a>`, badge(t.state, STATE_KIND[t.state]), result ? (catalog.byId(result.agent) || {}).name || result.agent : '—', usd(t.cost_usd == null ? null : Number(t.cost_usd)), time(t.created_at)];
            }), { empty: 'No tasks yet.' })}
${pageRows.next ? html`<p><a href="/tasks?before=${pageRows.next}">Older tasks</a></p>` : ''}`,
        });
    });

    // ── One task ─────────────────────────────────────────────
    // Read top to bottom: what was asked and where it stands, the outcome (the answer, why it did not finish, or the
    // live progress), then how it went — one block per agent that tried, its steps, its check, and a refused answer
    // folded away — and why that agent, folded.
    const STATE_TEXT = { queued: 'Waiting to start', running: 'Working', verifying: 'Checking the answer', succeeded: 'Done', failed: 'Didn\'t finish', cancelled: 'Cancelled' };
    const CLASS_TEXT = { answer: 'Answer', lookup: 'Lookup', research: 'Research', web: 'Web search', code: 'Code', robot: 'Your robot', computer: 'Your computer' };

    // What the agent last saw (agents/looks.js): its task's owner only, never cached.
    r.get('/tasks/:id/look', async (req, res) => {
        const row = TASK_ID.test(req.params.id) && signedIn(req) ? await store.getTask(s, req.params.id) : null;
        const look = row && row.requester === requesterOf(req) ? looks.get(row.id) : null;
        if (!look) return res.status(404).type('text').send('No picture');
        res.setHeader('Cache-Control', 'private, no-store');
        res.type(look.format === 'png' ? 'image/png' : 'image/jpeg').send(look.data);
    });

    // A file or chart the task made (Actor v2, stage V2-4): the owner's own bytes, out of Actor's own database. The
    // task's own auth decides who may open it: another person gets the same 404 as a task that does not exist.
    //
    // The bytes are served as they are — an SVG as image/svg+xml, an HTML page as text/html — but always in a
    // sandbox with nothing allowed to load, and never sniffed (nosniff). Only a raster image is shown in place;
    // an SVG or an HTML page is a download unless it is shown with <img>.
    r.get('/tasks/:id/files/:artifact', async (req, res) => {
        const row = TASK_ID.test(req.params.id) && signedIn(req) ? await store.getTask(s, req.params.id) : null;
        if (!row || row.requester !== requesterOf(req)) return res.status(404).type('text').send('No such file');
        const found = await findArtifact(s.db, row.id, req.params.artifact);
        if (!found) return res.status(404).type('text').send('No such file');
        return sendArtifact(res, found);
    });

    r.get('/tasks/:id', async (req, res) => {
        const row = TASK_ID.test(req.params.id) && signedIn(req) ? await store.getTask(s, req.params.id) : null;
        if (!row || row.requester !== requesterOf(req)) {
            return page(req, res, { title: 'Task not found', body: html`<h1>Task not found</h1><p>${signedIn(req) ? 'There is no task here that belongs to you.' : html`<a href="/auth/login?next=${encodeURIComponent(req.originalUrl)}">Sign in</a> to see your task.`}</p>` }, 404);
        }
        const t = store.toWire(row, { baseUrl: config.baseUrl });
        const events = await store.eventsAfter(s, row.id, 0);
        const deliveries = row.webhooks ? await ctx.webhooks.forTask(row.id) : [];
        const open = store.OPEN.includes(row.state);
        const cls = (events.find((e) => e.step === 'plan' && !e.agent && /"(\w+)" task/.test(e.text || '')) || { text: '' }).text.match(/"(\w+)"/);
        const kind = cls ? CLASS_TEXT[cls[1]] || cls[1] : null;
        const desk = open ? store.deskFrom(events) : null;
        const look = looks.get(row.id);
        const planEvent = [...events].reverse().find((e) => e.kind === 'output' && e.step === 'plan' && taskEvents.plan(e.text));
        const plan = (t.result && t.result.plan && Array.isArray(t.result.plan.steps) && t.result.plan.steps.length ? t.result.plan : null)
            || (planEvent ? taskEvents.plan(planEvent.text) : null);
        page(req, res, {
            title: row.task.length > 60 ? `${row.task.slice(0, 59)}…` : row.task,
            crumbs: [{ label: 'Your tasks', href: '/tasks' }, { label: 'Task' }],
            // How it went is the agents' session (openvibe-shared/agent-session.js, js/task.js mounts it from the events
            // below and, while the task runs, from its live stream); the attempts drawn here stay for a page without scripts.
            scripts: ['js/task-events.js', 'js/task.js'],
            sharedScripts: ['agent-session.js'],
            styles: [showcase.STYLESHEET],
            css: ['css/task.css'],
            noReferrer: true,
            body: html`${open ? raw('<noscript><meta http-equiv="refresh" content="4"></noscript>') : ''}
<article class="task state-${t.state}" data-task="${row.id}" data-last="${row.last_seq}" data-open="${open ? '1' : ''}" data-bot="${botPages}">
<header class="task-head">
<p class="task-status"><span class="pill pill-${t.state}">${STATE_TEXT[t.state]}</span>${kind ? html`<span class="chip">${kind}</span>` : ''}<span class="chip">${MODE_LABEL[t.mode]}</span><span class="chip" id="task-cost">${t.cost ? usd(t.cost.usd) : '$0'} of ${usd(t.budget.per_task_usd)}</span>${time(t.created_at)}</p>
<h1 class="task-text">${row.task}</h1>
</header>
${outcome(t, row)}
${open ? planCard(plan) : ''}
${open ? html`<section class="desk-card" id="desk-card" aria-live="polite"${desk ? '' : raw(' hidden')}>
<p><strong>Your agent is working on a desk of its own</strong><span id="desk-kind">${desk && desk.kind === 'browser' ? ' (a browser)' : ''}</span>. Watch it live, and take it over whenever you like: while you use it, the agent waits; when you stop, it goes on.</p>
<a class="sc-btn sc-primary" id="desk-link" href="${desk ? desk.url : botPages}" rel="noopener" target="_blank">Watch and take over</a>
</section>` : ''}
${open || look ? html`<figure class="last-look" id="last-look"${look ? '' : raw(' hidden')}>
<a id="last-look-link" href="${look ? `/tasks/${row.id}/look?at=${look.at}` : '#'}" target="_blank" rel="noopener" title="Open it full size"><img id="last-look-img" src="${look ? `/tasks/${row.id}/look?at=${look.at}` : ''}" alt="The screen your agent last looked at"${look && look.width ? raw(` width="${Number(look.width)}" height="${Number(look.height)}"`) : ''} loading="lazy"></a>
<figcaption class="muted small">What your agent last saw on the screen${look ? html` · ${time(new Date(look.at).toISOString())}` : ''}</figcaption>
</figure>` : ''}
<section class="how" aria-labelledby="h-how"><h2 id="h-how">How it went</h2>
${!open && plan ? planCard(plan) : ''}
<div class="attempts" id="attempts">${attemptsOf(events).map(attemptBlock)}</div>
<script type="application/json" id="task-events">${raw(JSON.stringify(events.slice(-3000)).replace(/</g, '\\u003c'))}</script>
${open ? html`<p class="muted small live-note" id="live-note"><span class="dot-pulse" aria-hidden="true"></span> Updating as the agent works.</p>` : ''}
</section>
${t.explanation ? explanationBlock(t.explanation) : ''}
${deliveries.length ? deliveriesBlock(deliveries) : ''}
<p class="muted small api-hint">In code: <code>GET /api/v1/tasks/${row.id}</code> · <a href="/docs">API</a></p>
</article>`,
        });
    });

    /** The task's webhook deliveries: where, which state, and how it went (the receiver's answer code only). */
    const DELIVERY_TEXT = { pending: 'Waiting to retry', sending: 'Sending', delivered: 'Delivered', failed: 'Not delivered' };
    function deliveriesBlock(rows) {
        return html`<details class="deliveries"><summary>Webhooks (${rows.length})</summary>
${table(['State', 'Endpoint', 'Delivery', 'Attempts'], rows.map((d) => [
            html`<code>${d.state}</code>`, html`<code class="small">${d.url}</code>`,
            html`${DELIVERY_TEXT[d.status] || d.status}${d.last_status ? html` <span class="muted small">(${d.last_status})</span>` : ''}`, String(d.attempts),
        ]))}</details>`;
    }

    /**
     * The plan the agent works through: each sub-goal done, in hand or next, and what it assumed. A live task's card is
     * there before the first plan (hidden), so js/task.js can fill it as the plan arrives and changes.
     */
    function planCard(plan) {
        const STATE = { done: 'done', active: 'working on it', todo: 'next' };
        const steps = plan ? plan.steps : [];
        return html`<section class="plan-card" id="plan-card" aria-labelledby="h-plan"${steps.length ? '' : raw(' hidden')}>
<h2 id="h-plan">The plan</h2>
<ol class="plan" id="plan-steps">${steps.map((st) => html`<li class="ps is-${STATE[st.state] ? st.state : 'todo'}"><span class="ps-mark" aria-hidden="true"></span><span class="ps-goal">${st.goal}</span><span class="sr-only"> (${STATE[st.state] || 'next'})</span></li>`)}</ol>
<p class="plan-assume" id="plan-assume"${plan && plan.assumptions.length ? '' : raw(' hidden')}>Assuming ${plan ? plan.assumptions.join(' · ') : ''}</p>
</section>`;
    }

    /** The outcome card: the first thing under the task. */
    function outcome(t, row) {
        if (t.state === 'succeeded') return resultBlock(t.result, t);
        const again = html`<form method="post" action="/tasks" class="inline"><input type="hidden" name="task" value="${row.task}"><input type="hidden" name="mode" value="best"><button class="sc-btn sc-primary" type="submit">Try again in Best mode</button></form> <a class="sc-btn" href="/#task">New task</a>`;
        if (t.state === 'failed') {
            return html`<section class="outcome outcome-bad" role="status"><h2>Actor couldn't finish this</h2><p>${friendlyError(t.error)}</p><div class="outcome-actions">${again}</div>${t.error ? html`<p class="muted small">Code <code>${t.error.code}</code></p>` : ''}</section>`;
        }
        if (t.state === 'cancelled') return html`<section class="outcome" role="status"><h2>Cancelled</h2><p>What was spent before the cancel stays spent.</p><div class="outcome-actions">${again}</div></section>`;
        return html`<section class="outcome outcome-live" role="status" aria-live="polite"><h2><span class="dot-pulse" aria-hidden="true"></span> <span id="live-state">${STATE_TEXT[t.state]}…</span></h2><p class="muted">This page fills in as the agent works. You can leave and come back: the task keeps running.</p><form method="post" action="/tasks/${row.id}/cancel" class="inline"><button class="sc-btn" type="submit">Cancel</button></form></section>`;
    }

    /** What went wrong, for a person; the code stays visible underneath for anyone who needs it. */
    function friendlyError(err) {
        if (!err) return 'It stopped without saying why.';
        const plain = {
            'actor.agents.exhausted': 'No agent gave an answer that passed its check, so nothing unchecked was shown to you. Trying again in Best mode starts with the strongest agent.',
            'actor.check.unavailable': 'The answer could not be checked, so it was not delivered. Try again in a minute.',
            'actor.task.timeout': 'It ran too long and was stopped.',
            'actor.task.interrupted': 'Actor restarted while this was running. Nothing more was charged; ask again.',
        };
        return plain[err.code] || err.detail;
    }

    function resultBlock(result, t) {
        const agent = catalog.byId(result.agent);
        const checked = result.checked || {};
        const bytes = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${Number(n) || 0} B`);
        const artifacts = Array.isArray(result.artifacts) ? result.artifacts : [];
        const evidence = Array.isArray(result.evidence) ? result.evidence.filter((e) => e && /^E\d{1,3}$/.test(String(e.id))) : [];
        const cited = new Set(Array.isArray(result.citations) ? result.citations.map(String) : []);
        const took = t.finished_at && t.created_at ? Date.parse(t.finished_at) - Date.parse(t.created_at) : NaN;
        const claims = Number(checked.claims) || 0;
        const grounded = Math.min(claims, Number(checked.grounded) || 0);
        const by = `${modelName(checked.by)}${checked.cross_family ? ', another model family' : ', the same family'}`;
        const ext = (a) => (String(a.name || '').split('.').pop() || a.kind || 'file').slice(0, 5).toUpperCase();
        return html`<section class="outcome outcome-ok answer" aria-labelledby="h-answer"><h2 id="h-answer" class="sr-only">Answer</h2>
<div class="prose">${raw(chipify(markdown(result.answer, { headingOffset: 2 }), evidence))}</div>
<p class="checked-line"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg><span>${claims ? `Checked: ${claims} claim${claims === 1 ? '' : 's'}, ${grounded} grounded` : 'Checked'} · by ${by}</span></p>
${artifacts.length ? html`<div class="files"><h3>Files</h3><ul class="file-grid">${artifacts.map((a) => html`<li class="file-card">
<a class="fc-preview" href="${a.url}" rel="nofollow noopener" tabindex="-1" aria-hidden="true">${/^image\/(svg\+xml|png|jpe?g|gif|webp)$/.test(a.mime) ? html`<img src="${a.url}" alt="" loading="lazy">` : html`<span class="fc-ext">${ext(a)}</span>`}</a>
<span class="fc-meta"><a class="fc-name" href="${a.url}" rel="nofollow noopener">${a.name}</a><span class="muted">${a.kind === 'chart' ? 'Chart' : 'File'} · ${bytes(a.size)}</span></span></li>`)}</ul></div>` : ''}
${result.sources && result.sources.length ? html`<div class="sources"><h3>Sources</h3><ul>${result.sources.map((u) => html`<li><a href="${u}" rel="nofollow ugc noopener" target="_blank">${u.replace(/^https?:\/\//, '').slice(0, 90)}</a></li>`)}</ul></div>` : ''}
${evidence.length ? html`<details class="evidence" id="evidence"><summary><span>Evidence</span><span class="muted">${evidence.length} item${evidence.length === 1 ? '' : 's'}: what the tools returned${cited.size ? `, ${cited.size} cited` : ''}</span></summary>
<ol class="ev-list">${evidence.map((e) => html`<li class="ev-item${cited.has(String(e.id)) ? ' is-cited' : ''}" id="ev-${e.id}">
<p class="ev-head"><b class="ev-n">${String(e.id).slice(1)}</b><span class="ev-tool">${toolLabel(e.tool)}</span>${inputText(e.input) ? html`<span class="ev-input">${inputText(e.input)}</span>` : ''}${e.at ? html`<time class="ev-at" datetime="${e.at}">${String(e.at).slice(11, 16)} UTC</time>` : ''}</p>
${e.text ? html`<p class="ev-text">${String(e.text).slice(0, 700)}${String(e.text).length > 700 ? '…' : ''}</p>` : ''}
${Array.isArray(e.sources) && e.sources.length ? html`<ul class="ev-src">${e.sources.slice(0, 6).map((src) => html`<li><a href="${src.url}" rel="nofollow ugc noopener" target="_blank">${src.title || String(src.url).replace(/^https?:\/\//, '').slice(0, 80)}</a></li>`)}</ul>` : ''}</li>`)}</ol></details>` : ''}
<p class="answer-foot"><span>${agent ? agent.name : result.agent}${result.model ? html` · ${modelName(result.model)}` : ''}</span><span>${t.cost ? usd(t.cost.usd) : '$0'} of ${usd(t.budget.per_task_usd)}</span>${Number.isFinite(took) && took > 0 ? html`<span>took ${ago(took)}</span>` : ''}</p>
</section>`;
    }

    /**
     * The events grouped by agent: an attempt starts with the plan or hand-off event that names its agent. A text event
     * marked as an error right after a failed check is the answer that check refused; any other error text is the agent
     * stopping.
     */
    function attemptsOf(events) {
        const out = [];
        let cur = null;
        let lastCheckFailed = false;
        for (const e of events) {
            if (e.kind !== 'output') continue;
            if ((e.step === 'plan' || e.step === 'handoff') && e.agent && !(e.step === 'plan' && taskEvents.plan(e.text))) {
                cur = { agent: e.agent, why: e.text, steps: [], refused: null, check: null, stopped: null };
                out.push(cur);
                lastCheckFailed = false;
                continue;
            }
            if (!cur) continue;
            if (e.step === 'check') { cur.check = e; lastCheckFailed = !!e.is_error; continue; }
            if (e.step === 'text' && e.is_error && lastCheckFailed) { cur.refused = e.text; continue; }
            if (e.step === 'text' && e.is_error) { cur.stopped = e.text; continue; }
            cur.steps.push(e);
        }
        return out;
    }

    function attemptBlock(a, i) {
        const agent = catalog.byId(a.agent);
        const outcomeBadge = a.check ? (a.check.is_error ? badge('answer refused', 'bad') : badge('passed', 'ok')) : a.stopped ? badge('stopped', 'warn') : '';
        return html`<section class="attempt" data-agent="${a.agent}">
<header class="attempt-head"><span class="attempt-n">${i + 1}</span><b>${agent ? agent.name : a.agent}</b>${outcomeBadge}</header>
<ol class="tl">${a.steps.map(stepItem)}
${a.stopped ? html`<li class="tl-item tl-err"><span class="tl-k">Stopped</span><span class="tl-v">${a.stopped}</span></li>` : ''}
${a.check ? html`<li class="tl-item ${a.check.is_error ? 'tl-err' : 'tl-ok'}"><span class="tl-k">Check</span><span class="tl-v">${String(a.check.text || '').replace(/^(Checked|Check failed)( by \w+( \(same family\))?)?: ?/, '')}</span></li>` : ''}
</ol>
${a.refused ? html`<details class="refused"><summary>See the answer that didn't pass</summary><div class="prose">${raw(markdown(a.refused, { headingOffset: 3 }))}</div></details>` : ''}
</section>`;
    }

    // A step's links to the person's own desk on OpenVibe.Bot (Desks plan D4: Watch, Take over) are made clickable;
    // every other address in a step stays text (a model writes steps too, and its links are never vouched for).
    const botPages = String((config.services && config.services.botPublicUrl) || 'https://openvibe.bot').replace(/\/+$/, '');
    const deskLink = new RegExp(`${botPages.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/machines/dev_[0-9A-HJKMNP-TV-Z]{26}/screen(?:\\?desk=[a-z0-9-]{1,40})?`, 'g');
    function withDeskLinks(text) {
        const t = String(text || '');
        const parts = [];
        let last = 0;
        for (const m of t.matchAll(deskLink)) {
            parts.push(t.slice(last, m.index), html`<a href="${m[0]}" rel="noopener">${/[?]desk=/.test(m[0]) ? 'your agent\'s desk' : 'the screen'}</a>`);
            last = m.index + m[0].length;
        }
        parts.push(t.slice(last));
        return parts;
    }

    function stepItem(e) {
        if (e.step === 'plan') { const p = taskEvents.plan(e.text); return html`<li class="tl-item tl-plan"><span class="tl-k">Plan</span><span class="tl-v">${p ? taskEvents.planLine(p) : e.text}</span></li>`; }
        if (e.step === 'tool_call') return html`<li class="tl-item tl-tool"><span class="tl-k">Used</span><span class="tl-v"><code>${e.tool}</code> ${e.input || ''}</span></li>`;
        if (e.step === 'tool_result') return html`<li class="tl-item tl-result${e.is_error ? ' tl-err' : ''}"><span class="tl-k">Got</span><span class="tl-v"><span class="muted">${(e.text || '').slice(0, 220)}</span></span></li>`;
        if (/^Needs you: /.test(e.text || '')) return html`<li class="tl-item tl-needs"><span class="tl-k">Needs you</span><span class="tl-v">${withDeskLinks(String(e.text).replace(/^Needs you: /, ''))}</span></li>`;
        return html`<li class="tl-item tl-say"><span class="tl-k">Note</span><span class="tl-v">${withDeskLinks(e.text)}</span></li>`;
    }

    function explanationBlock(explanation) {
        return html`<details class="why"><summary>Why this agent</summary>
${explanation.map((p, i) => html`<h3>${i ? `Hand-off ${i}` : 'First choice'}: ${p.selected ? (catalog.byId(p.selected) || {}).name || p.selected : 'no agent'} <span class="muted small">(${p.objective})</span></h3>
${table(['Agent', 'Could take it', 'Estimated cost', 'Why not'], (p.candidates || []).map((c) => [(catalog.byId(c.id) || {}).name || c.id, c.eligible ? 'yes' : 'no', c.estimated_cost_usd != null ? `~${usd(c.estimated_cost_usd)}` : '—', c.excluded_because || (c.id === p.selected ? 'picked' : '')]))}`)}
</details>`;
    }

    r.post('/tasks/:id/cancel', async (req, res) => {
        res.set('Cache-Control', cache.htmlHeaders({ private: true }));
        if (!signedIn(req) || !TASK_ID.test(req.params.id)) return res.redirect(303, '/tasks');
        if (!sameOrigin(req, config.baseUrl)) return res.status(403).type('text/plain').send('A cancel must come from openvibe.actor itself.');
        const row = await store.getTask(s, req.params.id);
        if (row && row.requester === requesterOf(req)) await engine.cancel(row.id, requesterOf(req));
        return res.redirect(303, `/tasks/${req.params.id}`);
    });

    // ── The agents ───────────────────────────────────────────
    function agentsPage() {
        const agents = catalog.list(config);
        return {
            agent: true, index: true, cache: PUBLIC_CACHE,
            title: 'The agents',
            description: 'Every agent system OpenVibe.Actor routes a task to — OpenVibe\'s own runtime, OpenAI\'s web agent, an open model on OpenVibe hardware, OpenVibe.Codes — with what each can do, its trust class and its price per million tokens.',
            crumbs: [{ label: 'Agents' }],
            body: html`<h1>The agents</h1>
<p>Actor is a router for agents, the way OpenRouter is one for models: each task goes to the agent system that can do it, then by your mode. Prices are typed in from each provider's own price page by a person, with the day it was checked; Actor charges the real usage of each call at these prices. Machine-readable: <a href="/api/v1/agents"><code>GET /api/v1/agents</code></a>.</p>
${table(['Agent', 'Kind', 'Can do', 'Trust', 'Price', 'Typical time', 'Now'], agents.map((a) => [
                // What each one is (the home lists the agents as rows that link here).
                html`<strong id="${a.id}">${a.name}</strong><br><code>${a.id}</code>${a.model ? html`<br><span class="muted small">${a.model}</span>` : ''}${(catalog.byId(a.id) || {}).blurb ? html`<p class="agent-blurb">${catalog.byId(a.id).blurb}</p>` : ''}`,
                a.kind,
                a.can.filter((c) => c.startsWith('task:')).map((c) => c.slice(5)).join(', '),
                a.trust,
                html`${priceText(a.rate_card)}<br><a class="muted small" href="${a.rate_card.source}" rel="noopener">source</a> <span class="muted small">checked ${a.rate_card.verified_at}</span>`,
                `~${Math.round(a.typical_latency_ms / 1000)} s`,
                a.available ? badge('working', 'ok') : html`${badge('not here')}<br><span class="muted small">${a.reason}</span>`,
            ]))}
<h2 id="modes">Modes</h2>
${table(['Mode', 'What it picks'], MODES.map((m) => [html`<strong>${MODE_LABEL[m]}</strong> <code>${m}</code>`, MODE_TEXT[m]]))}
<h2 id="classes">What a task needs</h2>
<p>Actor sorts each task first, and only agents that can do that kind of task are considered:</p>
<ul><li><strong>answer</strong>: writing, explaining, planning, anything a capable model knows.</li>
<li><strong>lookup</strong>: facts about a domain, address or site (DNS, mail records, certificates, headers, WHOIS), from OpenVibe.Tools.</li>
<li><strong>research</strong>: reading the pages a task names, or OpenVibe's own content.</li>
<li><strong>web</strong>: a live web search, for anything recent.</li>
<li><strong>code</strong>: writing or changing code, through OpenVibe.Codes.</li></ul>
<h2 id="check">The check</h2>
<p>Before you see an answer, a model of another family reads it: DeepSeek's answers are checked by OpenAI's smallest model and OpenAI's by DeepSeek. In private mode only OpenVibe's own model may read the task, so it checks its own answer and the task says so. A failed check sends the task to the next agent that can do it.</p>
<h2 id="trust">Trust</h2>
<p><strong>first-party</strong> runs on OpenVibe's own hardware; <strong>external</strong> means the task's text goes to that provider (the OpenVibe runtime is OpenVibe's code, but its model runs at DeepSeek). Private mode takes only first-party agents.</p>`,
        };
    }
    r.get('/agents', (req, res) => page(req, res, agentsPage()));

    // ── The API reference ────────────────────────────────────
    function docsPage() {
        const b = config.baseUrl;
        const create = `curl -s ${b}/api/v1/tasks \\
  -H "authorization: Bearer $TOKEN" \\
  -H 'content-type: application/json' \\
  -d '{"task":"Is the TLS certificate of example.com valid, and when does it expire?","mode":"cheapest"}'

# → 201 { "id": "tsk_…", "state": "queued", "progress": { "stream_url": "…/events" }, … }`;
        const watch = `curl -N ${b}/api/v1/tasks/tsk_…/events -H "authorization: Bearer $TOKEN"

id: 3
event: output
data: {"task_id":"tsk_…","seq":3,"kind":"output","agent":"openvibe-runtime","step":"tool_call","tool":"run_tool","input":"ssl {\\"target\\":\\"example.com\\"}"}`;
        return {
            agent: true, index: true, cache: PUBLIC_CACHE,
            title: 'API',
            description: 'The OpenVibe.Actor API: create a task, watch it live over server-sent events, read the result with its cost and explanation, cancel it; list the agents and dry-run the router.',
            crumbs: [{ label: 'API' }],
            body: html`<h1>The API</h1>
<p>Everything the site does is this API. Tasks are <a href="https://openvibe.services/docs/contracts/platform.task@1"><code>platform.task@1</code></a>; the contracts and capabilities are in <a href="https://github.com/OpenVibers/OpenVibe.Contracts">OpenVibe.Contracts</a>.</p>
<h2 id="auth">Who can call it</h2>
<ul><li><strong>A person</strong>: their OpenVibe Network token as <code>Authorization: Bearer</code> (or this site's sign-in). Tasks are theirs and use their free tier.</li>
<li><strong>An app or agent</strong>: a Network token for audience <code>openvibe.actor</code> with the <code>actor.task.*</code> capability the route needs, granted on <a href="https://openvibe.services">OpenVibe.Services</a>. Tasks belong to the app's project.</li>
<li><strong>Anyone</strong>: <code>GET /api/v1/agents</code> and <code>POST /api/v1/route</code> need no token.</li></ul>
${table(['Route', 'Capability', 'What it does'], [
                [html`<code>POST /api/v1/tasks</code>`, html`<code>actor.task.create</code>`, html`Create a task: <code>{ task, mode?, budget?: { per_task_usd, per_day_usd }, agent?, idempotency_key?, webhooks?: [{ url, events, secret_ref? }] }</code>. Answers 201 with the task (queued); with webhooks, also its <code>webhook_secret</code>, this once, unless every webhook names a project secret (<a href="#webhooks">webhooks</a>).`],
                [html`<code>GET /api/v1/tasks/:id</code>`, html`<code>actor.task.read</code>`, html`The task: state, result, cost, explanation, error. While it runs on a desk of its own, <code>desk</code> (<code>url</code>: the person's page to watch it live and take it over; <code>kind</code>: <code>browser</code> or <code>desktop</code>); while it waits for its person to do a step there, <code>needs_you</code> (<code>what</code>, <code>url</code>).`],
                [html`<code>GET /api/v1/tasks/:id/events</code>`, html`<code>actor.task.read</code>`, html`Server-sent events (<code>actor.task-event@2</code>): <code>state</code>, <code>output</code> (each step; a tool result that made a file or chart carries <code>artifacts</code>), <code>end</code>. Resumes with <code>Last-Event-ID</code>.`],
                [html`<code>GET /tasks/:id/files/:artifact</code>`, html`<code>the task's own page</code>`, html`A file or chart the task made, out of Actor's own database and private to the person who asked: their own page opens it, another person gets the same 404 as a task that does not exist.`],
                [html`<code>POST /api/v1/tasks/:id/cancel</code>`, html`<code>actor.task.create</code>`, 'Stop it. What was spent stays spent.'],
                [html`<code>GET /api/v1/tasks</code>`, html`<code>actor.task.list</code>`, html`Your tasks, newest first; <code>?limit=</code>, <code>?before=</code> (the <code>next</code> cursor).`],
                [html`<code>GET /api/v1/agents</code>`, 'public', 'The agent systems, what each can do, its price and whether it works now.'],
                [html`<code>POST /api/v1/route</code>`, 'public', html`<code>{ task, mode? }</code> → which agent would take it and why, for every candidate. Nothing runs and nothing is charged.`],
            ])}
${raw(showcase.code({ title: 'Create a task, then watch it', samples: [{ label: 'Create', lang: 'bash', code: create }, { label: 'Watch', lang: 'bash', code: watch }] }))}
<h2 id="webhooks">Webhooks</h2>
<p>Give a task up to 8 HTTPS endpoints and the state changes each wants (<code>queued</code>, <code>running</code>, <code>verifying</code>, <code>succeeded</code>, <code>failed</code>, <code>cancelled</code>). Actor POSTs <a href="https://openvibe.services/docs/contracts/actor.task-webhook@1"><code>actor.task-webhook@1</code></a> to each: <code>{ type: "actor.task.state", delivery_id, state, task }</code>, with the task as it was at that moment.</p>
<ul><li><strong>Signed per task.</strong> The answer that creates the task carries <code>webhook_secret</code>, and nothing else ever shows it. Each delivery has <code>X-OpenVibe-Timestamp</code> and <code>X-OpenVibe-Signature-V2</code>, exactly like an OpenVibe.Events delivery, so <code>verifyDeliveryV2(rawBody, headers, secret)</code> from <code>openvibe-sdk/events</code> checks it (and the five-minute window).</li>
<li><strong>Or with your project's secret.</strong> A project's app or agent may name a project secret instead (<code>secret_ref</code>): grant it to <code>actor</code> for signing on <a href="https://openvibe.services/projects">openvibe.services</a>, and OpenVibe.Network signs each delivery with it in the same headers. Actor never sees the value, and you verify with your own secret.</li>
<li><strong>Retried.</strong> A 2xx answer is delivered. 410 Gone ends it. Anything else is retried after 10 s, 1 min, 5 min, 30 min, 2 h, 6 h and 12 h. <code>delivery_id</code> (also <code>X-OpenVibe-Delivery-Id</code>) is the same on every attempt: dedupe on it.</li>
<li><strong>Public endpoints only.</strong> HTTPS on port 443 or 8443, no credentials in the URL, and only public addresses, checked when the task is created and again when each delivery is sent. Redirects are not followed.</li></ul>
<h2 id="limits">Limits and money</h2>
<p>The free tier: ${tier.tasksPerDay} tasks a day, up to ${usd(tier.perTaskUsd)} a task and ${usd(tier.perDayUsd)} a day (<a href="/limits.json">limits.json</a>). A budget above the tier is refused (<code>actor.budget.over_tier</code>), never lowered. A task whose cheapest capable agent would cost more than its budget fails before running (<code>actor.budget.exceeded</code>). <code>cost.usd</code> is what each model call and web search really cost at the <a href="/agents">published prices</a>.</p>
<h2 id="errors">Errors</h2>
<p>Every refusal is RFC 9457 <code>application/problem+json</code> with a stable <code>code</code>. A task that fails says why in <code>error</code>:</p>
${table(['Code', 'Meaning'], [
                [html`<code>actor.task.invalid</code>`, 'The request does not match actor.task-create-request@1.'],
                [html`<code>actor.webhook.refused</code>`, 'A webhook URL Actor will not deliver to: not HTTPS on 443/8443, credentials in it, or not a public address.'],
                [html`<code>actor.budget.over_tier</code>`, 'The budget is above what the free tier allows.'],
                [html`<code>actor.allowance.exhausted</code> / <code>actor.budget.day_spent</code>`, 'Today\'s free tasks or budget are used; Retry-After says when it resets.'],
                [html`<code>actor.capacity.spent</code>`, 'Actor\'s free capacity for everyone is used up for today.'],
                [html`<code>actor.budget.exceeded</code>`, 'The task could not be done within its budget.'],
                [html`<code>actor.no_agent</code>`, 'No agent that can do this kind of task is available (the detail says which and why).'],
                [html`<code>actor.agents.exhausted</code>`, 'Every agent that could do it failed or gave an answer that failed its check.'],
                [html`<code>actor.check.unavailable</code>`, 'The answer could not be checked, so it was not delivered.'],
                [html`<code>actor.task.timeout</code> / <code>actor.task.interrupted</code>`, 'It ran too long, or Actor restarted while it ran.'],
            ])}`,
        };
    }
    r.get('/docs', (req, res) => page(req, res, docsPage()));

    // ── Limits and the update log ────────────────────────────
    r.get('/limits.json', (req, res) => {
        res.set('Cache-Control', cache.htmlHeaders({ maxAge: 300 }));
        res.json({ service: 'actor', free_tier: { tasks_per_day: tier.tasksPerDay, per_task_usd: tier.perTaskUsd, per_day_usd: tier.perDayUsd }, task_timeout_seconds: Math.round(config.taskTimeoutMs / 1000), retention_days: store.RETENTION_DAYS });
    });
    const updatesPage = () => ({ agent: true, index: true, cache: PUBLIC_CACHE, title: 'What shipped on OpenVibe.Actor', body: raw(frame.updatesBody({ service: 'actor', siteName: 'OpenVibe.Actor' }) + `<script src="${ovServe.url('shipped.js')}" defer></script>`) });
    r.get('/updates', (req, res) => page(req, res, updatesPage()));

    // ── Discovery: robots.txt, sitemap.xml, llms.txt, llms-full.txt ──
    r.use(createDiscoveryRoutes(ctx));

    // The public pages the agent layer's Markdown twins (server/agent-pages.js) render with the same builders.
    // A task page is behind a person's token and is deliberately absent.
    r.publicViews = { home: homePage, agents: agentsPage, docs: docsPage, updates: updatesPage };

    return r;
}

module.exports = { createPageRoutes, MODE_TEXT };

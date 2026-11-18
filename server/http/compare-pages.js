'use strict';

/**
 * /compare (the owner, 11-16: "use an agent or harness or model system or a decisions API or swap between and benchmark
 * the different ways our shit works"): one task, worked up to six ways side by side, each answer graded on the same
 * rubric by OpenVibe.AI's Decisions API, and a leaderboard of the ways over every comparison.
 *
 *   GET  /compare        the form (the task, and each way: its engine and its model or harness), your comparisons, the
 *                        leaderboard
 *   POST /compare        start one (a person, from openvibe.actor itself) → 303 /compare/:id
 *   GET  /compare/:id    the sides: each way's state, answer, time, cost, model and score; the best one marked. While a
 *                        side runs, js/compare.js refreshes the page.
 */
const express = require('express');
const { asyncRouter } = require('./router');
const { sameOrigin } = require('./principal');
const { html, raw } = require('../render/html');
const { send } = require('../render/layout');
const { markdown } = require('../render/markdown');
const { ENGINES, HARNESSES, label } = require('../engines');

const ROWS = 6;
const DEFAULT_ROWS = [{ kind: 'agent' }, { kind: 'model' }];

function createComparePages(ctx) {
    const { config, s, engine, models, log } = ctx;
    const comparisons = ctx.comparisons || require('../compare').createComparisons({ s, config, engine, models, log });
    ctx.comparisons = comparisons;
    const r = asyncRouter();
    r.use(express.urlencoded({ extended: false, limit: '64kb' }));
    const signed = (req) => req.viewer && req.viewer.kind === 'user' && req.viewer.subject;
    const requesterOf = (req) => `user:${req.viewer.subject}`;
    const page = (req, res, body, { status = 200, title = 'Compare the ways' } = {}) => send(res, status, {
        viewer: req.viewer, config, path: req.originalUrl, title, body, styles: ['kit.css'], css: ['css/compare.css'], scripts: ['js/compare.js'],
    });
    const usd = (n) => (n == null ? '—' : n === 0 ? 'free' : n < 0.001 ? 'under $0.001' : `$${Number(n).toFixed(n < 0.1 ? 4 : 2)}`);
    const secs = (n) => (n == null ? '—' : n < 60 ? `${n} s` : `${Math.floor(n / 60)} min ${Math.round(n % 60)} s`);

    const wayRow = (i, v = {}) => html`<div class="cmp-way" data-cmp-way="${i}">
<label class="cmp-field"><span>Way ${i + 1}</span><select name="kind${i}" aria-label="Way ${i + 1}"><option value="">${i < 2 ? 'Choose a way' : 'None'}</option>${ENGINES.map((e) => html`<option value="${e.kind}"${v.kind === e.kind ? raw(' selected') : ''}>${e.name}</option>`)}</select></label>
<label class="cmp-field"><span>Model or harness <small>(optional)</small></span><input name="opt${i}" value="${v.model || v.harness || ''}" maxlength="256" autocomplete="off" spellcheck="false" placeholder="auto · openai/gpt-5.2 · claude-code" list="cmp-opts"></label>
</div>`;

    const board = (rows) => (rows.length ? html`<div class="cmp-board-wrap"><table class="cmp-board"><thead><tr><th scope="col">Way</th><th scope="col">Runs</th><th scope="col">Best</th><th scope="col">Score</th><th scope="col">Time</th><th scope="col">Cost</th></tr></thead><tbody>
${rows.map((x) => html`<tr><th scope="row">${x.label}</th><td>${x.runs}</td><td>${x.wins}</td><td>${x.mean_score == null ? '—' : html`<span class="cmp-score"><span class="cmp-bar" style="--v:${Math.round((x.mean_score / x.out_of) * 100)}%"></span>${x.mean_score.toFixed(2)}</span>`}</td><td>${secs(x.median_seconds)}</td><td>${usd(x.mean_cost_usd)}</td></tr>`)}
</tbody></table></div>` : html`<p class="cmp-empty">No graded comparisons yet. Start one above: the scores build up here.</p>`);

    r.get('/compare', async (req, res) => {
        res.set('Cache-Control', signed(req) ? 'private, no-store' : 'public, max-age=60');
        const mine = signed(req) ? await comparisons.list(requesterOf(req), { limit: 10 }) : [];
        const leaderboard = await comparisons.leaderboard({}).catch(() => []);
        const problem = typeof req.query.problem === 'string' ? req.query.problem.slice(0, 300) : null;
        page(req, res, html`<header class="cmp-head"><p class="cmp-kicker">Compare</p><h1>One task, several ways</h1>
<p class="cmp-lede">Run the same task through Actor's agent on any model, one model on its own, the Decisions API, a coding harness, OpenAI's agent or the open model, side by side. Each answer is graded on the same rubric, and the leaderboard shows which way wins, how fast and for how much.</p></header>
${problem ? html`<p class="cmp-problem" role="alert">${problem}</p>` : ''}
${signed(req) ? html`<form class="cmp-form" method="post" action="/compare">
<label class="cmp-field cmp-task"><span>The task</span><textarea name="task" rows="3" maxlength="16000" required placeholder="Which is better for a home robot's app: Flutter, React Native or Kotlin Multiplatform? Answer in a paragraph.">${typeof req.query.task === 'string' ? req.query.task.slice(0, 4000) : ''}</textarea></label>
<fieldset class="cmp-ways"><legend>The ways (2 to 6)</legend>
${Array.from({ length: ROWS }, (_, i) => wayRow(i, DEFAULT_ROWS[i] || {}))}
<p class="cmp-add-row"><button class="ovk-btn ovk-btn--quiet cmp-add" type="button" hidden>Add a way</button></p>
<datalist id="cmp-opts">${['auto', 'deepseek/deepseek-flash', 'openai/gpt-5.2', 'anthropic/claude-sonnet-5-5', 'google/gemini-3-pro', ...HARNESSES].map((x) => html`<option value="${x}"></option>`)}</datalist>
</fieldset>
<ul class="cmp-kinds">${ENGINES.map((e) => html`<li><b>${e.name}</b> ${e.blurb}</li>`)}</ul>
<p class="cmp-go"><button class="ovk-btn ovk-btn--primary" type="submit">Compare them</button><small>Each way is one of your tasks, paid from your allowance like any other.</small></p>
</form>` : html`<p class="cmp-sign"><a class="ovk-btn ovk-btn--primary" href="/auth/login?next=%2Fcompare">Sign in to compare</a></p>`}
${mine.length ? html`<section class="cmp-sec" aria-labelledby="cmp-mine-h"><h2 id="cmp-mine-h">Your comparisons</h2><ul class="cmp-mine">${mine.map((c) => html`<li><a href="/compare/${c.id}">${c.task}</a><small>${c.engines.join(' · ')}${c.judged === 'judged' ? ' · graded' : ''}</small></li>`)}</ul></section>` : ''}
<section class="cmp-sec" aria-labelledby="cmp-board-h"><h2 id="cmp-board-h">Leaderboard</h2><p class="cmp-fine">Over every graded comparison on Actor. Score: 0 (wrong) to 4 (excellent), graded by the Decisions API.</p>${board(leaderboard)}</section>`);
    });

    r.post('/compare', async (req, res) => {
        if (!signed(req)) return res.redirect(303, '/auth/login?next=%2Fcompare');
        if (!sameOrigin(req, config.baseUrl)) return res.status(403).type('text/plain').send('A comparison must start from openvibe.actor itself.');
        const b = req.body || {};
        const engines = [];
        for (let i = 0; i < ROWS; i++) {
            const kind = String(b[`kind${i}`] || '').trim();
            if (!kind) continue;
            const opt = String(b[`opt${i}`] || '').trim();
            engines.push({ kind, ...(opt && opt !== 'auto' ? (kind === 'harness' ? { harness: opt } : ['agent', 'model', 'decisions'].includes(kind) ? { model: opt } : {}) : {}) });
        }
        const out = await comparisons.create({ principal: { kind: 'user', requester: requesterOf(req), project: null }, task: b.task, engines,
            timezone: req.cookies && req.cookies.ov_tz ? String(req.cookies.ov_tz).slice(0, 64) : null });
        if (out.code) return res.redirect(303, `/compare?problem=${encodeURIComponent(String(out.detail || 'That did not start.').slice(0, 300))}&task=${encodeURIComponent(String(b.task || '').slice(0, 2000))}`);
        res.redirect(303, `/compare/${out.comparison.id}`);
    });

    r.get('/compare/:id', async (req, res) => {
        if (!signed(req)) return res.redirect(303, `/auth/login?next=${encodeURIComponent(req.originalUrl)}`);
        res.set('Cache-Control', 'private, no-store');
        const c = await comparisons.get(String(req.params.id), requesterOf(req));
        if (!c) return page(req, res, html`<p class="cmp-empty">You have no comparison with that id. <a href="/compare">Start one</a>.</p>`, { status: 404, title: 'Not found' });
        const j = c.judged || {};
        const state = c.done ? (j.state === 'judging' ? 'judging' : 'done') : 'running';
        const card = (x) => html`<article class="cmp-side${x.won ? ' is-best' : ''} is-${x.state}">
<header><b>${x.label}</b>${x.won ? html`<span class="cmp-best">Best</span>` : ''}<span class="cmp-state">${({ queued: 'Waiting', running: 'Working', verifying: 'Checking', needs_you: 'Needs you', succeeded: 'Done', failed: 'Did not finish', cancelled: 'Stopped' })[x.state] || x.state}</span></header>
${x.score != null ? html`<p class="cmp-score cmp-score--big"><span class="cmp-bar" style="--v:${Math.round((x.score / (j.out_of || 4)) * 100)}%"></span>${x.score.toFixed(2)} <small>of ${j.out_of || 4}</small></p>` : ''}
<div class="cmp-answer">${x.answer ? raw(markdown(String(x.answer).slice(0, 12000))) : x.error ? html`<p class="cmp-err">${x.error.detail || x.error.code}</p>` : html`<p class="cmp-wait">${x.state === 'succeeded' ? 'No answer.' : 'Working on it…'}</p>`}</div>
<footer><span>${secs(x.seconds)}</span><span>${usd(x.cost_usd)}</span>${x.model ? html`<span>${x.model}</span>` : ''}<a href="/chat/${x.task_id}">Its steps</a></footer>
</article>`;
        page(req, res, html`<header class="cmp-head"><p class="cmp-kicker"><a href="/compare">Compare</a></p><h1>${c.task.length > 140 ? `${c.task.slice(0, 140)}…` : c.task}</h1>
<p class="cmp-lede" data-cmp-state="${state}">${state === 'running' ? `${c.sides.filter((x) => ['succeeded', 'failed', 'cancelled'].includes(x.state)).length} of ${c.sides.length} ways finished. This page updates by itself.`
        : j.state === 'judged' ? html`Graded by ${j.by}${j.calibrated ? ' (calibrated)' : ''}: 0 is wrong, ${j.out_of} is excellent.${j.tie ? ' The top two are too close to call.' : ''}`
            : j.state === 'judging' ? 'Grading the answers…' : (j.reason || 'Finished.')}</p></header>
<div class="cmp-sides">${c.sides.map(card)}</div>
<p class="cmp-go"><a class="ovk-btn" href="/compare?task=${encodeURIComponent(c.task.slice(0, 2000))}">Compare it other ways</a></p>`, { title: `Compare: ${c.task.slice(0, 60)}` });
    });

    return r;
}

module.exports = { createComparePages, label };

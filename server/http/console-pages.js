'use strict';

/**
 * The old Console page, folded into the chat (one-agent system, stage 1: the owner, 11-12, "having this thing on the
 * console doesn't make any sense … you should just chat with it"). /console now answers 301 to the chat: what runs now
 * is the "Now" strip at the top of /chat, and the command box is the chat's composer. Its "Ask Actor" prefill (?ask= and
 * ?from=, put on it by the OpenVibe Frame) is carried into the chat's composer, so a link from any site still lands
 * with the words in the box and nothing running.
 *
 * /me/spend stays here: it is the console's one page that is not a conversation, and it is still linked from the chat's
 * Settings and the home page.
 */
const cache = require('openvibe-shared/cache-policy');
const { asyncRouter } = require('./router');
const { html } = require('../render/html');
const { send } = require('../render/layout');
const store = require('../tasks/store');

const usd = (n) => (n == null ? '—' : n === 0 ? '$0' : n < 0.01 ? `$${Number(n).toFixed(4)}` : `$${Number(n).toFixed(2)}`);

function createConsolePages(ctx) {
    const { config, s } = ctx;
    const r = asyncRouter();
    const tier = config.allowance;
    const page = (req, res, o, status = 200) => send(res, status, { viewer: req.viewer, config, path: req.originalUrl, styles: ['kit.css'], css: ['css/console.css'], ...o });

    /**
     * What the old command box started with: ?ask= (the OpenVibe Frame's "Ask Actor", any site: the text the person had
     * selected), at most 2000 characters, and ?from= (the page they were on: an https address on an OpenVibe site) as a
     * line after it. Only ever text in the composer: nothing runs until they send it.
     */
    function prefill(req) {
        const ask = typeof req.query.ask === 'string' ? req.query.ask.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim().slice(0, 2000) : '';
        let from = '';
        if (typeof req.query.from === 'string' && req.query.from.length <= 500) {
            try {
                const u = new URL(req.query.from);
                if (u.protocol === 'https:' && /(^|\.)(openvibe\.[a-z]+|openre\.stream)$/.test(u.hostname)) from = u.href;
            } catch { from = ''; }
        }
        if (!ask && !from) return '';
        return from ? `${ask}${ask ? '\n\n' : ''}(On this page: ${from})` : ask;
    }

    // 301, not a page: the Console is gone and every link, bookmark and the Frame's "Ask Actor" land in the chat.
    r.get('/console', (req, res) => {
        res.set('Cache-Control', cache.htmlHeaders({ private: true }));
        const ask = prefill(req);
        return res.redirect(301, `/chat${ask ? `?ask=${encodeURIComponent(ask)}` : ''}`);
    });

    /**
     * Days of spend as bars (a table for screen readers), tallest day = full height. A week labels each day; a month
     * labels every fifth day by its date.
     */
    function spendChart(days, { caption, month = false } = {}) {
        const top = Math.max(...days.map((d) => d.usd), 0);
        const total = days.reduce((n, d) => n + d.usd, 0);
        const date = (d) => new Date(`${d.day}T00:00:00Z`);
        const label = (d, i) => (month
            ? (i % 5 === (days.length - 1) % 5 ? String(date(d).getUTCDate()) : '')
            : date(d).toLocaleDateString('en', { weekday: 'short', timeZone: 'UTC' }).slice(0, 2));
        const name = (d) => date(d).toLocaleDateString('en', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
        return html`<figure class="cn-week${month ? ' cn-month' : ''}"><figcaption>${caption}: <b>${usd(total)}</b>, ${String(days.reduce((n, d) => n + d.tasks, 0))} tasks</figcaption>
<div class="cn-bars" aria-hidden="true"${month ? html` style="grid-template-columns:repeat(${days.length},1fr)"` : ''}>${days.map((d, i) => html`<span class="cn-bar" title="${name(d)}: ${usd(d.usd)}, ${String(d.tasks)} tasks"><i style="height:${String(top > 0 ? Math.max(4, Math.round((d.usd / top) * 100)) : 4)}%"></i><small>${label(d, i)}</small></span>`)}</div>
<table class="cn-sr"><caption>Spend by day</caption><tbody>${days.map((d) => html`<tr><th scope="row">${d.day}</th><td>${usd(d.usd)}</td><td>${String(d.tasks)} tasks</td></tr>`)}</tbody></table></figure>`;
    }

    // ── Costs over time: the last 30 days (what Actor keeps) ──
    r.get('/me/spend', async (req, res) => {
        res.set('Cache-Control', cache.htmlHeaders({ private: true }));
        if (!req.viewer || req.viewer.kind !== 'user' || !req.viewer.subject) return res.redirect(302, '/auth/login?next=%2Fme%2Fspend');
        const requester = `user:${req.viewer.subject}`;
        const days = await store.spendDays(s, requester, store.RETENTION_DAYS);
        const used = days.filter((d) => d.tasks > 0 || d.usd > 0);
        const total = days.reduce((n, d) => n + d.usd, 0);
        const busiest = used.reduce((b, d) => (!b || d.usd > b.usd ? d : b), null);
        page(req, res, {
            title: 'Spend', crumbs: [{ label: 'Chat', href: '/chat' }, { label: 'Spend' }],
            body: html`<header class="cn-head"><h1>Spend</h1>
<p class="cn-lede">What your tasks and agents cost, day by day, over the last ${String(store.RETENTION_DAYS)} days (Actor keeps no more).</p></header>
<section class="cn-card" aria-labelledby="cn-spend-h"><h2 id="cn-spend-h">Last ${String(store.RETENTION_DAYS)} days</h2>
${spendChart(days, { caption: `Last ${String(store.RETENTION_DAYS)} days`, month: true })}
<p class="cn-stat">${used.length ? html`<b>${usd(total / used.length)}</b> on an average day with tasks · busiest ${busiest.day}, <b>${usd(busiest.usd)}</b>` : 'Nothing has run in this time.'}</p>
<p class="cn-note">Today's limit is ${usd(tier.perDayUsd)} and ${String(tier.tasksPerDay)} tasks on the free tier.</p>
<p class="cn-more"><a href="/chat">Back to the chat</a> · <a href="/tasks">Your tasks</a></p></section>`,
        });
    });

    return r;
}

module.exports = { createConsolePages };

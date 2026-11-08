'use strict';
const express = require('express');
const tasks = require('../tasks/store');
const tickets = require('./tickets');
const { createFrames } = require('./frames');
const { html, render } = require('../render/html');

function createTaskView(ctx, { fetchImpl } = {}) {
    const { s, principal, config, stream, computers, log } = ctx;
    const origins = createFrames({ fetchImpl, networkUrl: config.networkInternalUrl });
    const api = express.Router(), embed = express.Router();
    // Only the person's own Bearer may mint; delegated apps and sessions cannot.
    api.post('/tasks/:id/view-ticket', principal.middleware, async (req, res) => {
        res.set('Cache-Control', 'no-store');
        const p = req.principal;
        if (!p || p.kind !== 'user' || p.viaSession || !req.get('authorization')?.startsWith('Bearer ')) return res.sendStatus(403);
        try {
            const row = await tasks.getTask(s, req.params.id);
            if (!row || row.requester !== p.requester) return res.sendStatus(404);
            const issued = await tickets.issue(s, row);
            res.json({ url: `${config.baseUrl}/embed/task/${encodeURIComponent(row.id)}?t=${issued.ticket}`, expires_at: issued.expires_at });
        } catch { log.warn('[Actor] task view issue failed', req.params.id); res.sendStatus(503); }
    });
    embed.use('/embed/task', (_req, res, next) => {
        res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex' });
        next();
    });
    embed.use('/embed/task', require('express-rate-limit')({ windowMs: 60_000, limit: 240, standardHeaders: true, legacyHeaders: false }));
    embed.use('/embed/task/:id', async (req, res, next) => {
        res.removeHeader('X-Frame-Options');
        res.set('Content-Security-Policy', `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'self' ${(await origins()).join(' ')}`);
        try {
            const ticket = await tickets.find(s, req.query.t, req.params.id);
            const row = ticket && await tasks.getTask(s, req.params.id);
            if (!row || row.requester !== ticket.requester) return res.status(403).type('html').send('<!doctype html><html lang="en"><title>Expired view</title><main><p>This view has expired</p></main></html>');
            req.taskView = { row, ticket };
            next();
        } catch { log.warn('[Actor] task view read failed', req.params.id); res.sendStatus(503); }
    });
    embed.get('/embed/task/:id', (req, res) => {
        const { row, ticket } = req.taskView;
        res.type('html').send(render(html`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Task in Actor</title><link rel="stylesheet" href="/css/task-view.css"><script src="/js/task-view.js" defer></script></head><body data-expires="${new Date(ticket.expires_at).toISOString()}"><main><header><h1>${row.task}</h1><p id="state">${row.state}</p></header><img id="desk" hidden alt="The task's live computer screen"><ol id="steps" aria-live="polite"></ol><a href="/tasks/${row.id}" target="_top">Open in Actor</a></main></body></html>`));
    });
    embed.get('/embed/task/:id/events', async (req, res) => {
        const { row, ticket } = req.taskView;
        const timer = setTimeout(() => res.end(), Math.max(1, new Date(ticket.expires_at).getTime() - s.now()));
        timer.unref();
        res.on('close', () => clearTimeout(timer));
        const after = Math.max(0, parseInt(req.get('last-event-id') || req.query.after, 10) || 0);
        try {
            await stream.serve(req, res, { taskId: row.id, after,
                readBacklog: () => tasks.eventsAfter(s, row.id, after),
                isEnded: async () => { const cur = await tasks.getTask(s, row.id); return !cur || !tasks.OPEN.includes(cur.state); },
            });
        } catch { log.warn('[Actor] task view stream failed', row.id); res.end(); }
    });
    embed.get('/embed/task/:id/still', async (req, res) => {
        const { row, ticket } = req.taskView;
        try {
            const computer = await tasks.taskComputer(s, row);
            const subject = row.requester.slice(5);
            let shot;
            if (computer?.session_id) shot = await computers.still(subject, computer.session_id, { signal: AbortSignal.timeout(5000) });
            else {
                const desk = await tasks.taskDesk(s, row);
                const place = desk && tasks.deskPlace(desk.url);
                if (!place) return res.sendStatus(404);
                const screen = await computers.screen(subject, place.machine, { desk: place.desk, signal: AbortSignal.timeout(5000) });
                if (screen && !screen.error && ['jpeg', 'png'].includes(screen.format)) shot = { type: `image/${screen.format}`, bytes: Buffer.from(screen.content_b64, 'base64') };
            }
            if (new Date(ticket.expires_at).getTime() <= s.now()) return res.sendStatus(403);
            if (!shot || shot.error || !['image/jpeg', 'image/png', 'image/webp'].includes(shot.type)) return res.sendStatus(502);
            res.type(shot.type).end(shot.bytes);
        } catch { log.warn('[Actor] task view still failed', row.id); res.sendStatus(503); }
    });
    // No request under this prefix reaches session-authenticated pages or write routes.
    embed.all('/embed/task/:id*', (_req, res) => res.sendStatus(405));
    return { api, embed };
}
module.exports = { createTaskView };

'use strict';

const { asyncRouter } = require('../http/router');
const { http } = require('openvibe-contracts');
function router(ctx) {
    const r = asyncRouter();
    const { day, principal } = ctx;
    // Only the person's own credential may turn on their all-day Actor or answer its asks.
    r.use((req, res, next) => {
        if (req.principal.kind !== 'dock') return principal.requireCapability('actor.agent.manage')(req, res, next);
        const scope = ['GET', 'HEAD'].includes(req.method) ? 'actor.me.read' : 'actor.me.write';
        if (!String(req.principal.claims.scope || '').split(/\s+/).includes(scope)) return http.sendProblem(res, 403, 'scope.denied', { detail: `${scope} is required.`, ctx: req.ov });
        next();
    });
    r.use((req, res, next) => {
        if (!['user', 'dock'].includes(req.principal.kind)) return http.sendProblem(res, 403, 'capability.denied', { detail: 'Use your own account to manage your Actor.', ctx: req.ov });
        next();
    });
    const route = (fn, status = 200) => async (req, res) => {
        try { res.status(status).json(await fn(req.principal.requester, req)); }
        catch (err) {
            if (!err.status) throw err;
            http.sendProblem(res, err.status, err.code || 'actor.day.invalid', { detail: err.message, ctx: req.ov });
        }
    };
    r.get('/', route((owner) => day.now(owner)));
    r.patch('/', route((owner, req) => day.update(owner, req.body)));
    r.get('/page', route(owner => day.pageData(owner)));
    r.post('/do-now', route((owner, req) => day.doNow(owner, req.body.goal)));
    r.post('/earnings', route((owner, req) => day.earn(owner, req.body), 201));
    r.get('/sites', route(owner => day.sites(owner)));
    r.delete('/sites/:site', route((owner, req) => day.sites(owner, req.params.site)));
    r.post('/computer/:action', route((owner, req) => day.computerCall(owner, req.params.action, req.body)));
    r.get('/computer/history', route(owner => day.computerCall(owner, 'history')));
    r.get('/computer/still', async (req, res) => {
        const id = await day.session(req.principal.requester);
        if (!id) return res.sendStatus(404);
        const shot = await ctx.computers.still(req.principal.requester.slice(5), id);
        if (!shot || shot.error) return res.sendStatus(502);
        res.type(shot.type).end(shot.bytes);
    });
    r.get('/lanes', route(() => day.lanes));
    r.get('/models', route(async owner => { const a = await day.ensure(owner); const entries = ctx.models.aiCatalog ? await ctx.models.aiCatalog() || [] : []; return { models: [{ id: 'auto', name: 'Auto' }, ...entries.filter(m => a.adult_opt_in || !/uncensored|18\+/i.test(JSON.stringify(m)))] }; }));
    r.post('/pause', route((owner) => day.setEnabled(owner, false)));
    r.post('/resume', route((owner) => day.setEnabled(owner, true)));
    r.get('/goals', route((owner) => day.goals(owner)));
    r.post('/goals', route((owner, req) => day.saveGoal(owner, req.body), 201));
    r.patch('/goals/:id', route((owner, req) => day.saveGoal(owner, req.body, req.params.id)));
    r.delete('/goals/:id', route((owner, req) => day.removeGoal(owner, req.params.id)));
    r.get('/asks', route((owner, req) => day.asks(owner, req.query.all === 'true')));
    r.post('/asks/:id/answer', route((owner, req) => day.answer(owner, req.params.id, req.body)));
    r.post('/asks/:id/decline', route((owner, req) => day.answer(owner, req.params.id, req.body, true)));
    r.get('/journal', route(async (owner, req) => {
        const items = await day.journalPage(owner, String(req.query.before || ''), req.query.limit);
        return { items, next_cursor: items.length ? items[items.length - 1].id : null };
    }));
    r.post('/tell', route((owner, req) => day.tell(owner, req.body && req.body.text, req.body && req.body.attachments), 201));
    return r;
}
module.exports = { router };

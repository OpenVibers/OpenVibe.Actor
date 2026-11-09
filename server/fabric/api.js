'use strict';
const express = require('express');
const { asyncRouter } = require('../http/router');
const contracts = require('openvibe-contracts');
function createRoutes(ctx) {
    const r = asyncRouter();
    r.use(express.json({ limit: '64kb' }));
    r.use(ctx.principal.middleware);
    r.use(ctx.principal.requireCapability('actor.agent.manage'));
    r.use((req, res, next) => {
        if (!ctx.fabric.enabled) return res.sendStatus(404);
        if (req.principal?.kind !== 'user') return res.sendStatus(403);
        res.set('Cache-Control', 'no-store'); next();
    });
    const run = fn => async (req, res, next) => {
        try { res.json(await fn(req)); }
        catch (err) { if (err.status) return contracts.http.sendProblem(res, err.status, 'actor.fabric.refused', { detail: err.message, ctx: req.ov }); next(err); }
    };
    r.get('/:agent', run(req => ctx.fabric.snapshot(req.principal.requester, req.params.agent)));
    r.post('/:agent/commands/:command', run(req => ctx.fabric.command(req.principal.requester, req.params.agent, req.params.command, req.body)));
    return r;
}
module.exports = { createRoutes };

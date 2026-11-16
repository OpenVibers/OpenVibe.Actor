'use strict';

/**
 * The engines and comparisons API (server/engines, server/compare; the owner, 11-16: "swap between and benchmark"):
 *
 *   GET  /api/v1/engines                    the ways a task can be worked (kinds, what each takes, the harnesses); anyone
 *   GET  /api/v1/engines/leaderboard        per engine: runs, wins, mean score, median seconds, mean cost (?mine=1: yours)
 *   POST /api/v1/comparisons                { task, engines: [{ kind, model?, harness? }, …] } (2 to 6) → 201 the comparison
 *   GET  /api/v1/comparisons                your recent comparisons
 *   GET  /api/v1/comparisons/:id            one comparison: each side's state, answer, time, cost, model and score
 *
 * A comparison's sides are the person's own tasks, so the same rules hold: a person or an app acting for them
 * (actor.task.create), their budget, their limits. One task with one engine is POST /api/v1/tasks { engine }.
 */
const contracts = require('openvibe-contracts');
const { asyncRouter } = require('../http/router');
const { ENGINES, HARNESSES } = require('../engines');

function createCompareApi(ctx) {
    const { config, s, engine, principal, limits, models, log } = ctx;
    const comparisons = ctx.comparisons || require('./index').createComparisons({ s, config, engine, models, log });
    ctx.comparisons = comparisons;
    const r = asyncRouter();
    const problem = (req, res, status, code, detail) => contracts.http.sendProblem(res, status, code, { detail, ctx: req.ov });
    const person = (req, res, next) => {
        const p = req.principal;
        if (!p || p.kind === 'anonymous' || !p.requester) return problem(req, res, 401, 'token.required', 'Sign in to compare the ways a task can be worked.');
        return next();
    };

    r.get('/engines', async (req, res) => {
        res.set('Cache-Control', 'public, max-age=300');
        // The models a way can take: OpenVibe.AI's catalog as Actor reads it (aliases and exact ids that run now).
        const catalog = models && typeof models.aiCatalog === 'function' ? await models.aiCatalog().catch(() => null) : null;
        const list = (catalog || []).filter((m) => m && m.availability !== 'unavailable').slice(0, 600).map((m) => ({ id: m.id, ...(m.name ? { name: m.name } : {}) }));
        res.json({ engines: ENGINES, harnesses: HARNESSES, models: list,
            note: 'POST /api/v1/tasks { task, engine: { kind, model?, harness? } } runs one task one way; POST /api/v1/comparisons runs it several ways side by side.' });
    });

    r.get('/engines/leaderboard', async (req, res) => {
        const mine = req.query.mine && req.principal && req.principal.requester ? req.principal.requester : null;
        res.set('Cache-Control', mine ? 'private, no-store' : 'public, max-age=60');
        res.json({ engines: await comparisons.leaderboard({ requester: mine }), scope: mine ? 'yours' : 'everyone' });
    });

    r.post('/comparisons', principal.requireCapability('actor.task.create'), limits.budget('actor.task.create'), person, async (req, res) => {
        const b = req.body || {};
        const out = await comparisons.create({ principal: req.principal, task: b.task, engines: b.engines,
            timezone: req.cookies && req.cookies.ov_tz ? String(req.cookies.ov_tz).slice(0, 64) : null });
        if (out.code) {
            if (out.retryAfter) res.set('Retry-After', String(out.retryAfter));
            return problem(req, res, out.status || 422, out.code, out.detail);
        }
        res.status(201).set('Location', `/api/v1/comparisons/${out.comparison.id}`).json(out.comparison);
    });

    r.get('/comparisons', person, async (req, res) => {
        res.set('Cache-Control', 'private, no-store');
        res.json({ comparisons: await comparisons.list(req.principal.requester, { limit: req.query.limit }) });
    });

    r.get('/comparisons/:id', person, async (req, res) => {
        res.set('Cache-Control', 'private, no-store');
        const c = await comparisons.get(String(req.params.id), req.principal.requester);
        if (!c) return problem(req, res, 404, 'actor.compare.not_found', 'You have no comparison with that id.');
        res.json(c);
    });

    return r;
}

module.exports = { createCompareApi };

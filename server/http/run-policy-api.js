'use strict';

/**
 * Run settings and permission rules (plan 11c): what an agent's runs may touch, and which calls go ahead, ask first
 * or never run.
 *
 *   GET  /api/v1/me/run-policy      the person's defaults ({ files, network }), their rules, the site's rules (read
 *                                   only: they come first and are final), and the starter presets.
 *   PUT  /api/v1/me/run-policy      { files?, network?, rules? } or { preset: careful | balanced | hands-off } — a
 *                                   preset writes the rule list. files/network null means: the default.
 *   GET  /api/v1/admin/run-policy   the site's rules (the owner only).
 *   PUT  /api/v1/admin/run-policy   { rules } — the owner only. A matching site rule wins over anybody's own.
 *
 * Rules are { match: { tool?, connector?, risk?, args? }, decision: allow | ask | deny, why }; the last matching rule
 * wins (server/runtime/run-policy.js). A run reads them when it starts, so a change is seen by the next run.
 */
const express = require('express');
const contracts = require('openvibe-contracts');
const { asyncRouter } = require('./router');
const runPolicy = require('../runtime/run-policy');
const siteOwner = require('../auth/site-owner');

function createRunPolicyApi(ctx) {
    const { config, s, principal, limits } = ctx;
    const r = asyncRouter();
    const problem = (req, res, status, code, detail) => contracts.http.sendProblem(res, status, code, { detail, ctx: req.ov });

    const personOnly = (req, res, next) => {
        const p = req.principal;
        if (!p || p.kind === 'anonymous') return problem(req, res, 401, 'token.required', 'Sign in to see your run settings.');
        if (p.kind !== 'user' || !p.requester || !p.requester.startsWith('user:')) {
            return problem(req, res, 403, 'actor.policy.forbidden', 'Only a person may change their own run settings.');
        }
        return next();
    };
    const ownerOnly = (req, res, next) => {
        const p = req.principal;
        if (!p || p.kind === 'anonymous') return problem(req, res, 401, 'token.required', 'Sign in as the owner of this Actor.');
        if (!siteOwner.isOwner({ principal: p, viewer: req.viewer, config })) {
            return problem(req, res, 403, 'actor.policy.forbidden', "Only the owner may change this site's rules.");
        }
        return next();
    };

    const presets = () => Object.entries(runPolicy.PRESETS).map(([id, rules]) => ({ id, rules }));
    const personView = async (requester) => {
        const mine = await runPolicy.read(s, requester);
        const site = await runPolicy.read(s, runPolicy.SITE);
        return {
            files: mine.files,
            network: mine.network,
            defaults: runPolicy.DEFAULTS,
            rules: mine.rules,
            site_rules: site.rules,
            presets: presets(),
            updated_at: mine.updated_at,
        };
    };

    r.use(express.json({ limit: '64kb' }));

    r.get('/me/run-policy', principal.requireCapability('actor.agent.manage'), personOnly, limits.reads('actor.agent.manage'), async (req, res) => {
        res.json(await personView(req.principal.requester));
    });
    r.put('/me/run-policy', principal.requireCapability('actor.agent.manage'), personOnly, limits.budget('actor.agent.manage'), async (req, res) => {
        const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
        for (const k of Object.keys(body)) {
            if (!['files', 'network', 'rules', 'preset'].includes(k)) return problem(req, res, 422, 'actor.policy.invalid', `${k.slice(0, 32)} is not a field (files, network, rules, preset).`);
        }
        if (body.preset !== undefined && body.rules !== undefined) return problem(req, res, 422, 'actor.policy.invalid', 'Send rules or a preset, not both.');
        const patch = {};
        const settings = runPolicy.validateSettings({ ...(body.files !== undefined ? { files: body.files } : {}), ...(body.network !== undefined ? { network: body.network } : {}) });
        if (settings.error) return problem(req, res, 422, 'actor.policy.invalid', settings.error);
        Object.assign(patch, settings.value);
        if (body.preset !== undefined) {
            if (!Object.prototype.hasOwnProperty.call(runPolicy.PRESETS, body.preset)) {
                return problem(req, res, 422, 'actor.policy.invalid', `preset is one of ${Object.keys(runPolicy.PRESETS).join(', ')}.`);
            }
            patch.rules = runPolicy.PRESETS[body.preset].map((x) => ({ ...x, match: { ...x.match } }));
        } else if (body.rules !== undefined) {
            const rules = runPolicy.validateRules(body.rules);
            if (rules.error) return problem(req, res, 422, 'actor.policy.invalid', rules.error);
            patch.rules = rules.value;
        }
        await runPolicy.save(s, req.principal.requester, patch, req.principal.requester);
        res.json(await personView(req.principal.requester));
    });

    r.get('/admin/run-policy', principal.requireCapability('actor.agent.manage'), ownerOnly, limits.reads('actor.agent.manage'), async (_req, res) => {
        const site = await runPolicy.read(s, runPolicy.SITE);
        res.json({ rules: site.rules, updated_at: site.updated_at });
    });
    r.put('/admin/run-policy', principal.requireCapability('actor.agent.manage'), ownerOnly, limits.budget('actor.agent.manage'), async (req, res) => {
        const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
        const rules = runPolicy.validateRules(body.rules);
        if (rules.error) return problem(req, res, 422, 'actor.policy.invalid', rules.error);
        const site = await runPolicy.save(s, runPolicy.SITE, { rules: rules.value }, req.principal.requester);
        res.json({ rules: site.rules, updated_at: site.updated_at });
    });

    return r;
}

module.exports = { createRunPolicyApi };

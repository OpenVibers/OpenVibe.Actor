'use strict';

/**
 * The connectors (plan §Z.6): the groups of tools a person — and the owner — can switch off.
 *
 *   GET  /api/v1/me/connectors      the person's own list: every connector, what it does, whether it is on for
 *                                   them, and how many calls they have made of it today.
 *   PUT  /api/v1/me/connectors      { connectors: [{ id, enabled }] } — enabled null means: the connector's
 *                                   default. Only this person's own rows are read or written.
 *   GET  /api/v1/admin/connectors   the owner's list: the same connectors with the site's own switch, the daily
 *                                   cap and the tools of each one.
 *   PUT  /api/v1/admin/connectors   { connectors: [{ id, enabled, daily_cap }] } — the owner only. The owner's
 *                                   switch wins over anybody's own.
 *
 * The switches are stored in Actor's own database (migrations/0073_connectors.sql) and read per request: one
 * person's change is seen by the next run of theirs and by nobody else's.
 */
const express = require('express');
const contracts = require('openvibe-contracts');
const { asyncRouter } = require('./router');
const connectors = require('../runtime/connectors');
const siteOwner = require('../auth/site-owner');

function createConnectorApi(ctx) {
    const { config, s, principal, limits } = ctx;
    const r = asyncRouter();
    const problem = (req, res, status, code, detail, extra) => contracts.http.sendProblem(res, status, code, { detail, ctx: req.ov, extra });

    /** The tools of every connector, from the live registry. */
    const toolsOf = () => {
        const out = {};
        for (const c of connectors.manifest()) out[c.id] = [];
        for (const t of (ctx.registry && ctx.registry.tools) || []) {
            if (t.connector && out[t.connector]) out[t.connector].push(t.name);
        }
        for (const id of Object.keys(out)) out[id].sort();
        return out;
    };

    /** One connector as a person reads it. */
    const wire = (row, tools) => ({
        id: row.id,
        name: row.name,
        service: row.service,
        what: row.what,
        risk: row.risk,
        risk_text: connectors.RISK_WORDS[row.risk] || row.risk,
        default: row.default,
        enabled: row.enabled,
        owner_enabled: row.ownerEnabled,
        person_enabled: row.personEnabled,
        off_for_everyone: row.offForEveryone,
        cap: row.cap,
        calls_today: row.calls,
        tools: tools[row.id] || [],
    });

    /** The person's own list. */
    const personList = async (requester) => {
        const state = await connectors.load(s, { requester });
        const tools = toolsOf();
        return connectors.manifest().map((c) => wire(state.connectors[c.id], tools));
    };

    /** The owner's list: the site's switch, the cap and the tools. */
    const ownerList = async () => {
        const tools = toolsOf();
        const out = [];
        for (const c of connectors.manifest()) {
            const row = await connectors.ownerSwitch(s, c.id);
            out.push({
                id: row.id,
                name: row.name,
                service: row.service,
                what: row.what,
                risk: row.risk,
                risk_text: connectors.RISK_WORDS[row.risk] || row.risk,
                default: row.default,
                enabled: row.enabled,
                daily_cap: row.daily_cap,
                tools: tools[row.id] || [],
            });
        }
        return out;
    };

    /** A person's request: a signed-in person, not an app or a service. */
    const personOnly = (req, res, next) => {
        const p = req.principal;
        if (!p || p.kind === 'anonymous') return problem(req, res, 401, 'token.required', 'Sign in to see your connectors.');
        if (p.kind !== 'user' || !p.requester || !p.requester.startsWith('user:')) {
            return problem(req, res, 403, 'actor.connector.forbidden', 'Only a person may change their own connectors.');
        }
        return next();
    };

    /** The owner's request: the owner of this site, and nobody else. */
    const ownerOnly = (req, res, next) => {
        const p = req.principal;
        if (!p || p.kind === 'anonymous') return problem(req, res, 401, 'token.required', 'Sign in as the owner of this Actor.');
        if (!siteOwner.isOwner({ principal: p, viewer: req.viewer, config })) {
            return problem(req, res, 403, 'actor.connector.forbidden', 'Only the owner may change the connectors of this Actor.');
        }
        return next();
    };

    r.use(express.json({ limit: '64kb' }));

    // ── The person's own switches ──────────────────────────────────────────────────────────────────────────
    r.get('/me/connectors', principal.requireCapability('actor.agent.manage'), personOnly, limits.reads('actor.agent.manage'), async (req, res) => {
        res.json({ connectors: await personList(req.principal.requester) });
    });
    r.put('/me/connectors', principal.requireCapability('actor.agent.manage'), personOnly, limits.budget('actor.agent.manage'), async (req, res) => {
        const body = req.body || {};
        const list = body.connectors;
        if (!Array.isArray(list) || !list.length) return problem(req, res, 422, 'actor.connector.invalid', 'connectors must be a list of { id, enabled }.');
        for (const item of list) {
            if (!item || typeof item !== 'object' || Array.isArray(item)) return problem(req, res, 422, 'actor.connector.invalid', 'every connector is an object with an id and enabled.');
            if (!connectors.isConnectorId(item.id)) return problem(req, res, 422, 'actor.connector.invalid', `${String(item.id)} is not a connector.`);
            if (item.enabled !== true && item.enabled !== false && item.enabled !== null) {
                return problem(req, res, 422, 'actor.connector.invalid', 'enabled is true, false, or null for the default.');
            }
        }
        for (const item of list) {
            await connectors.setPersonSwitch(s, req.principal.requester, item.id, item.enabled);
        }
        res.json({ connectors: await personList(req.principal.requester) });
    });

    // ── The owner's switches: for everyone ─────────────────────────────────────────────────────────────────
    r.get('/admin/connectors', principal.requireCapability('actor.agent.manage'), ownerOnly, limits.reads('actor.agent.manage'), async (_req, res) => {
        res.json({ connectors: await ownerList() });
    });
    r.put('/admin/connectors', principal.requireCapability('actor.agent.manage'), ownerOnly, limits.budget('actor.agent.manage'), async (req, res) => {
        const body = req.body || {};
        const list = body.connectors;
        if (!Array.isArray(list) || !list.length) return problem(req, res, 422, 'actor.connector.invalid', 'connectors must be a list of { id, enabled, daily_cap }.');
        for (const item of list) {
            if (!item || typeof item !== 'object' || Array.isArray(item)) return problem(req, res, 422, 'actor.connector.invalid', 'every connector is an object with an id.');
            if (!connectors.isConnectorId(item.id)) return problem(req, res, 422, 'actor.connector.invalid', `${String(item.id)} is not a connector.`);
            if (item.enabled !== undefined && item.enabled !== null && typeof item.enabled !== 'boolean') {
                return problem(req, res, 422, 'actor.connector.invalid', 'enabled is true or false.');
            }
            if (item.daily_cap !== undefined && item.daily_cap !== null) {
                const cap = Number(item.daily_cap);
                if (!Number.isInteger(cap) || cap < 0 || cap > 100000) {
                    return problem(req, res, 422, 'actor.connector.invalid', 'daily_cap is a whole number of calls a day, or null for no limit.');
                }
            }
        }
        for (const item of list) {
            await connectors.setOwnerSwitch(s, item.id, {
                enabled: item.enabled === undefined ? null : item.enabled,
                dailyCap: item.daily_cap === undefined ? undefined : (item.daily_cap === null ? null : Number(item.daily_cap)),
                who: req.principal.requester,
            });
        }
        res.json({ connectors: await ownerList() });
    });

    return r;
}

module.exports = { createConnectorApi };

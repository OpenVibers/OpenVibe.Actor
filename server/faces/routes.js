'use strict';

/**
 * Faces over HTTP (server/faces; the owner, 11-16: an avatar system for your Actor and your agents):
 *
 *   GET  /faces/:id                      the picture: public by its unguessable id, a year's cache, never sniffed
 *   GET  /api/v1/me/faces                your last 24 pictures, and the styles
 *   POST /api/v1/me/faces/generate       { name?, description?, style?, n? } → { faces: [{ id, url }], cost_usd } (as you,
 *                                        on the image models OpenVibe.AI routes to: your allowance)
 *   POST /api/v1/me/faces                an upload (Content-Type image/png, image/jpeg or image/webp; at most 2 MB) → { id, url }
 *   PUT  /api/v1/agents/:id/face         { face: 'fac_…' | null } → the agent's face (:id `actor` is your Actor, your first agent)
 *
 * The writes are a person's (or an app acting for them, actor.agent.manage) and count against their budget.
 */
const express = require('express');
const contracts = require('openvibe-contracts');
const { asyncRouter } = require('../http/router');
const { createFaces, FaceError, STYLES, MAX_BYTES } = require('./index');

function facesOf(ctx) {
    if (!ctx.faces) ctx.faces = createFaces({ s: ctx.s, models: ctx.models });
    return ctx.faces;
}

function createFacesApi(ctx) {
    const { config, principal, limits } = ctx;
    const faces = facesOf(ctx);
    const base = String((config && config.baseUrl) || '').replace(/\/+$/, '');
    const abs = (u) => (u && u.startsWith('/') ? `${base}${u}` : u);
    const r = asyncRouter();
    const problem = (req, res, status, code, detail) => contracts.http.sendProblem(res, status, code, { detail, ctx: req.ov });
    const person = (req, res, next) => {
        const p = req.principal;
        if (!p || p.kind === 'anonymous' || !p.requester) return problem(req, res, 401, 'token.required', 'Sign in to make pictures for your agents.');
        return next();
    };
    const guard = [principal.requireCapability('actor.agent.manage'), person, limits.budget('actor.agent.manage')];
    const fail = (req, res, err) => {
        if (err instanceof FaceError) return problem(req, res, err.status, err.code, err.message);
        if (err && err.code && /^actor\.(provider|model)\./.test(String(err.code))) return problem(req, res, 503, 'actor.face.unavailable', 'The picture service did not answer. Try again in a moment.');
        throw err;
    };

    r.get('/me/faces', person, async (req, res) => {
        res.set('Cache-Control', 'private, no-store');
        res.json({ faces: (await faces.list(req.principal.requester)).map((f) => ({ ...f, url: abs(f.url) })),
            styles: Object.entries(STYLES).map(([id, v]) => ({ id, name: v.name })) });
    });

    r.post('/me/faces/generate', ...guard, async (req, res) => {
        const b = req.body || {};
        try {
            const out = await faces.generate(req.principal.requester, { name: b.name, description: b.description, style: b.style || 'openvibe', n: b.n });
            res.status(201).json({ faces: out.faces.map((f) => ({ id: f.id, url: abs(f.url) })), cost_usd: out.cost_usd });
        } catch (err) { return fail(req, res, err); }
    });

    r.post('/me/faces', ...guard, express.raw({ type: ['image/png', 'image/jpeg', 'image/webp'], limit: MAX_BYTES }), async (req, res) => {
        if (!Buffer.isBuffer(req.body) || !req.body.length) return problem(req, res, 415, 'actor.face.invalid', 'Send the picture itself: image/png, image/jpeg or image/webp');
        try {
            const f = await faces.store(req.principal.requester, req.body, { style: 'upload' });
            res.status(201).json({ id: f.id, url: abs(f.url) });
        } catch (err) { return fail(req, res, err); }
    });

    r.put('/agents/:id/face', ...guard, async (req, res) => {
        const id = String(req.params.id || '');
        const face = (req.body || {}).face;
        if (face != null && !/^fac_[0-9A-Za-z]{10,40}$/.test(String(face))) return problem(req, res, 422, 'actor.face.invalid', 'face: one of your pictures (fac_…), or null for its preset');
        try {
            const out = await faces.use(req.principal.requester, id === 'actor' ? 'actor' : id, face || null);
            res.json({ ...out, face_url: abs(out.face_url) });
        } catch (err) { return fail(req, res, err); }
    });
    return r;
}

/** GET /faces/:id — the picture itself. */
function createFacesPages(ctx) {
    const faces = facesOf(ctx);
    const r = asyncRouter();
    r.get('/faces/:id', async (req, res) => {
        const f = await faces.get(req.params.id);
        if (!f) return res.status(404).type('text/plain').send('No such picture.');
        res.set({
            'Content-Type': f.mime, 'Cache-Control': 'public, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff',
            'Cross-Origin-Resource-Policy': 'cross-origin', 'Content-Security-Policy': "default-src 'none'; sandbox",
        });
        res.send(Buffer.from(f.bytes));
    });
    return r;
}

module.exports = { createFacesApi, createFacesPages };

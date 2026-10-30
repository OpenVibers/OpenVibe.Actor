'use strict';

/**
 * A2A (Actor v2, stage V2-11): the tasks another agent may hand Actor, and the state of those tasks.
 *
 * Accepting a task needs a Network service token with the capability actor.a2a.task acting for a person
 * (X-OV-Subject: their subject id). An anonymous caller is refused (401), a token without the capability is
 * refused (403), and a token that acts for nobody is refused (403). The task then runs under that person's
 * allowance, budget and allow-list, exactly like a task they started themselves.
 *
 * The person is in the token when the token names one: a token with on_behalf_of acts for that person only (a header
 * naming somebody else is refused), and a token that names nobody may act for a person only when its grant lists
 * them (on_behalf_of_any) or when it is a first-party service token (server/http/subject.js).
 */
const express = require('express');
const contracts = require('openvibe-contracts');
const { createTask } = require('../tasks/create');
const { messageText } = require('../connections/a2a');
const { personFor } = require('./subject');

const DONE = ['succeeded', 'failed', 'cancelled'];

function createA2APages(ctx) {
    const { config, s, engine, principal } = ctx;
    const r = express.Router();
    r.use(express.json({ limit: '64kb' }));
    r.use(principal.middleware);

    r.post('/a2a/v1/tasks', principal.requireCapability('actor.a2a.task'), async (req, res) => {
        const p = req.principal;
        // The person is in the token (on_behalf_of) or in the header, and the token must be allowed to act for them.
        const who = personFor(p, req.get('x-ov-subject'));
        if (who.error) return contracts.http.sendProblem(res, who.error[0], who.error[1], { detail: who.error[2], ctx: req.ov });
        const subject = who.subject;
        const v = contracts.validate('actor.a2a-task-request@1', req.body || {});
        if (!v.valid) {
            const detail = (v.errors || []).map((e) => ((e.path || e.instancePath || '') + ' ' + e.message).trim()).join('; ').slice(0, 400);
            return contracts.http.sendProblem(res, 422, 'actor.a2a.invalid', { detail: detail || 'invalid request', ctx: req.ov });
        }
        const text = messageText(req.body.message);
        if (!text) return contracts.http.sendProblem(res, 422, 'actor.a2a.empty', { detail: 'the task has no text', ctx: req.ov });
        const out = await createTask({ s, config, engine, principal: { ...p, requester: 'user:' + subject }, body: { task: text, mode: 'balanced' } });
        if (!out || !out.task) {
            return contracts.http.sendProblem(res, (out && out.status) || 500, (out && out.code) || 'actor.task.failed', { detail: (out && out.detail) || 'the task could not be started', ctx: req.ov });
        }
        return res.status(201).json({ id: 'a2a_' + out.task.id, state: 'submitted', taskId: out.task.id });
    });

    r.get('/a2a/v1/tasks/:id', principal.requireCapability('actor.a2a.task'), async (req, res) => {
        const p = req.principal;
        const who = personFor(p, req.get('x-ov-subject'));
        if (who.error) return contracts.http.sendProblem(res, who.error[0], who.error[1], { detail: who.error[2], ctx: req.ov });
        const id = String(req.params.id || '').replace(/^a2a_/, '');
        const row = await s.db.maybe('SELECT id, requester, state, result, error_detail FROM tasks WHERE id = $1', [id]);
        if (!row || row.requester !== 'user:' + who.subject) {
            return contracts.http.sendProblem(res, 404, 'actor.task.not_found', { detail: 'no such task', ctx: req.ov });
        }
        const done = DONE.includes(row.state);
        const state = !done ? 'working' : (row.state === 'succeeded' ? 'completed' : 'failed');
        return res.json({
            id: 'a2a_' + row.id, state, taskId: row.id,
            answer: row.state === 'succeeded' ? row.result || '' : undefined,
            error: row.error_detail ? String(row.error_detail).slice(0, 400) : undefined,
        });
    });

    return r;
}

module.exports = { createA2APages };

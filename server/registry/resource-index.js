'use strict';

/**
 * Actor's authority resource index (ADR-048, plan T13 step 8 phase 2). OpenVibe.Services reads
 * actor.task summaries here with a first-party service token carrying actor.resource.read.
 * GET /?project=&kind=&owner=&cursor=&limit=: `owner` (usr_…/agt_…) answers only that subject's tasks, the ones whose
 * summary names them (requester user:usr_…; a task an agent or a service asked for names no owner, so an agt_ owner
 * matches nothing). A malformed filter is a 400.
 */
const contracts = require('openvibe-contracts');
const { asyncRouter } = require('../http/router');

const SERVICE = 'actor';
const TASK_KIND = 'actor.task';
const PROJECT_ID_RE = /^prj_[0-9A-HJKMNP-TV-Z]{26}$/;
const USER_REQUESTER_RE = /^user:(usr_[0-9A-HJKMNP-TV-Z]{26})$/;
const SUBJECT_RE = /^(usr|agt)_[0-9A-HJKMNP-TV-Z]{26}$/;
const TASK_ID_RE = /^tsk_[0-9A-HJKMNP-TV-Z]{26}$/;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

/** Only the public summary fields of a task row; its text is reduced to a one-line name. */
function taskSummary(row) {
    const owner = USER_REQUESTER_RE.exec(String(row.requester || ''));
    const summary = {
        id: row.id,
        kind: TASK_KIND,
        service: SERVICE,
        ...(PROJECT_ID_RE.test(String(row.project_id || '')) ? { project_id: row.project_id } : {}),
        ...(owner ? { owner: { type: 'user', id: owner[1] } } : {}),
        name: String(row.task || '').replace(/\s+/g, ' ').trim().slice(0, 80),
        state: row.state,
        created_at: new Date(row.created_at).toISOString(),
    };
    const ovrn = contracts.resources.nameOf(summary);
    return ovrn ? { ...summary, ovrn } : summary;
}

/** An opaque base64url [kind, id] position, matching the other authority indexes. */
const encodeCursor = (summary) => Buffer.from(JSON.stringify([summary.kind, summary.id])).toString('base64url');
function decodeCursor(raw) {
    let value;
    try { value = JSON.parse(Buffer.from(String(raw), 'base64url').toString('utf8')); } catch { return null; }
    return Array.isArray(value) && value.length === 2 && value[0] === TASK_KIND &&
        typeof value[1] === 'string' && TASK_ID_RE.test(value[1]) ? value : null;
}

function filtersOf(query) {
    const project = query.project === undefined ? null : query.project;
    if (project !== null && (typeof project !== 'string' || !PROJECT_ID_RE.test(project))) return { error: 'project must be a prj_ id' };
    const kind = typeof query.kind === 'string' && query.kind !== '' ? query.kind : null;
    const owner = query.owner === undefined || query.owner === '' ? null : query.owner;
    if (owner !== null && (typeof owner !== 'string' || !SUBJECT_RE.test(owner))) return { error: 'owner must be a usr_ or agt_ subject id' };
    let limit = DEFAULT_LIMIT;
    if (typeof query.limit === 'string' && query.limit !== '') {
        if (!/^\d+$/.test(query.limit) || Number(query.limit) < 1 || Number(query.limit) > MAX_LIMIT) return { error: `limit must be an integer 1-${MAX_LIMIT}` };
        limit = Number(query.limit);
    }
    let cursor = null;
    if (typeof query.cursor === 'string' && query.cursor !== '') {
        cursor = decodeCursor(query.cursor);
        if (!cursor) return { error: 'cursor is not one this index issued' };
    }
    return { project, kind, owner, limit, cursor };
}

const COLUMNS = 'id, requester, project_id, task, state, created_at';

function router({ s, principal }) {
    const r = asyncRouter();
    const problem = (req, res, status, code, detail) => contracts.http.sendProblem(res, status, code, { detail, ctx: req.ov });

    r.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
    r.use(principal.middleware);

    /** The existing capability guard checks the token; this also excludes people and app or agent tokens. */
    function firstParty(req, res, next) {
        if (req.principal.kind === 'app' && req.principal.requester.startsWith('service:')) return next();
        return problem(req, res, 403, 'capability.denied', 'actor.resource.read is first-party and requires a service token');
    }

    r.get('/', principal.requireCapability('actor.resource.read'), firstParty, async (req, res) => {
        const f = filtersOf(req.query);
        if (f.error) return problem(req, res, 400, 'resources.bad_query', f.error);
        if (f.kind && f.kind !== TASK_KIND) return res.json({ resources: [], next_cursor: null });
        if (f.owner && !f.owner.startsWith('usr_')) return res.json({ resources: [], next_cursor: null });

        const where = [];
        const args = [];
        if (f.project) { args.push(f.project); where.push(`project_id = $${args.length}`); }
        if (f.owner) { args.push(`user:${f.owner}`); where.push(`requester = $${args.length}`); }
        if (f.cursor) { args.push(f.cursor[1]); where.push(`id > $${args.length}`); }
        args.push(f.limit + 1);
        const sql = `SELECT ${COLUMNS} FROM tasks ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id ASC LIMIT $${args.length}`;
        const rows = await s.db.many(sql, args);
        const resources = rows.slice(0, f.limit).map(taskSummary);
        const next_cursor = rows.length > f.limit ? encodeCursor(resources[resources.length - 1]) : null;
        return res.json({ resources, next_cursor });
    });

    r.get('/:ovrn', principal.requireCapability('actor.resource.read'), firstParty, async (req, res) => {
        const name = String(req.params.ovrn);
        const parsed = contracts.resources.parse(name);
        let summary = null;
        if (parsed && parsed.service === SERVICE && parsed.type === 'task' && TASK_ID_RE.test(parsed.id)) {
            const row = await s.db.maybe(`SELECT ${COLUMNS} FROM tasks WHERE id = $1`, [parsed.id]);
            if (row) summary = taskSummary(row);
        }
        if (!summary || summary.ovrn !== name) return problem(req, res, 404, 'resources.unknown_resource', `no resource named ${name}`);
        return res.json(summary);
    });

    return r;
}

module.exports = { router, taskSummary, SERVICE, TASK_KIND, DEFAULT_LIMIT, MAX_LIMIT, encodeCursor, filtersOf };

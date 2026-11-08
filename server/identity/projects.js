'use strict';

/**
 * Project delegation (ADR-003 amendment 2026-10-12): whether a person is an admin or owner of an unarchived project,
 * asked of Network (GET /internal/projects/:project/members/:subject, capability network.project.member.read) with
 * Actor's own client-credentials token. The control API (server/registry/resource-control.js) uses it so a project's
 * admins can stop the tasks its apps started.
 *
 *   const projects = createProjects({ config });
 *   await projects.isAdmin(projectId, subjectId)   → true | false; throws when Network cannot answer
 *   await projects.forSubject(subjectId)           → the unarchived projects the person administers
 */
const { serviceAuth } = require('openvibe-contracts');

const ADMIN_ROLES = new Set(['admin', 'owner']);

function createProjects({ config, fetchImpl = globalThis.fetch, tokens: tokensOverride = null }) {
    const enabled = !!(tokensOverride || config.oauth.clientSecret);
    const tokens = !enabled ? null : tokensOverride || serviceAuth.createTokenClient({
        tokenUrl: `${config.networkInternalUrl}/oauth/token`, clientId: config.oauth.clientId, clientSecret: config.oauth.clientSecret,
        audience: 'openvibe.network', scope: 'network.project.member.read', fetchImpl,
    });

    async function isAdmin(projectId, subjectId) {
        if (!tokens) throw new Error('Actor has no Network client secret: project roles cannot be read');
        const res = await fetchImpl(`${config.networkInternalUrl}/internal/projects/${encodeURIComponent(projectId)}/members/${encodeURIComponent(subjectId)}`, {
            headers: { Accept: 'application/json', ...(await tokens.authHeaders()) }, signal: AbortSignal.timeout(10_000),
        });
        if (res.status === 404) return false;
        if (!res.ok) throw new Error(`Network answered ${res.status} for a project membership`);
        const out = await res.json().catch(() => null);
        return !!out && out.project_id === projectId && out.subject === subjectId && ADMIN_ROLES.has(out.role) && out.archived === false;
    }

    /**
     * The projects one person may act in (GET /internal/projects?subject=usr_…, the same capability): the ones they
     * own or administer and that are not archived. A service acting for them (a skill run, Billing) picks one to bill.
     */
    async function forSubject(subjectId) {
        if (!tokens) throw new Error('Actor has no Network client secret: project roles cannot be read');
        if (!/^usr_[0-9A-HJKMNP-TV-Z]{26}$/.test(String(subjectId || ''))) return [];
        const res = await fetchImpl(`${config.networkInternalUrl}/internal/projects?subject=${encodeURIComponent(subjectId)}`, {
            headers: { Accept: 'application/json', ...(await tokens.authHeaders()) }, signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) throw new Error(`Network answered ${res.status} for the person's projects`);
        const out = await res.json().catch(() => null);
        const list = out && Array.isArray(out.projects) ? out.projects : [];
        return list.filter((p) => p && typeof p.project_id === 'string' && ADMIN_ROLES.has(p.role) && p.archived === false);
    }

    return { isAdmin, forSubject, enabled };
}

module.exports = { createProjects, ADMIN_ROLES };

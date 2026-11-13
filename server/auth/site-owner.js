'use strict';

/**
 * Who is the owner of this Actor (plan §Z.6).
 *
 * Actor's own console was folded into the chat, so there is no owner account of Actor's own: the owner of the site
 * is the person whose OpenVibe account is the owner (Network says so itself with its is_owner claim, on the session
 * and on their own token), plus the subjects this deployment names (ACTOR_OWNER_SUBJECTS — a usr_… id; a
 * self-hosted Actor's one owner is among them).
 *
 * The same check guards the owner's Connectors page, the owner's API and the links that lead to them. A person who
 * is not the owner sees nothing of it: their own switches are the only ones they may change.
 */

/** The person behind a request, if there is one. */
function subjectOf(principal, viewer) {
    const fromPrincipal = principal && typeof principal.requester === 'string' && principal.requester.startsWith('user:')
        ? principal.requester.slice(5)
        : null;
    if (fromPrincipal) return fromPrincipal;
    return viewer && typeof viewer.subject === 'string' && viewer.subject ? viewer.subject : null;
}

/** Is this request the owner of this site? */
function isOwner({ principal = null, viewer = null, config = null } = {}) {
    const claims = principal && principal.claims;
    if (claims && claims.is_owner === true) return true;
    if (viewer && viewer.isOwner === true) return true;
    const subject = subjectOf(principal, viewer);
    if (!subject) return false;
    const list = config && config.owner && Array.isArray(config.owner.subjects) ? config.owner.subjects : [];
    return list.includes(subject);
}

module.exports = { isOwner, subjectOf };

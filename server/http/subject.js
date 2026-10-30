'use strict';

/**
 * The person a service token acts for (Actor v2, stage V2-11).
 *
 * A task handed to Actor by another agent must belong to a person, and the person must be in the token, not only
 * in a header:
 *
 *   - a token that names a person (on_behalf_of) may act for that person only. The header, if it is there at all,
 *     must name the same person; a header naming somebody else is refused (403).
 *   - a token that names nobody may act for a person only when its grant lists them (on_behalf_of_any), or when
 *     it is a first-party service token (svc:…, actor_type service) - the pattern the Watch, Chat and Work
 *     services already use for a task they start for a person.
 *
 * A token that is none of those may not name a person at all (403).
 */

const USER_ID = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;

/** The person a token names in on_behalf_of: a usr_ id, or a SubjectRef { type: 'user', id }. */
function claimPerson(claims) {
    const obo = claims && claims.on_behalf_of;
    if (typeof obo === 'string') return USER_ID.test(obo) ? obo : null;
    if (obo && typeof obo === 'object' && obo.type === 'user' && typeof obo.id === 'string' && USER_ID.test(obo.id)) return obo.id;
    return null;
}

/** The people a token may act for when it names nobody: on_behalf_of_any (one id or a list). */
function grantPeople(claims) {
    const any = claims && claims.on_behalf_of_any;
    const list = Array.isArray(any) ? any : (typeof any === 'string' ? [any] : []);
    return list.filter((x) => typeof x === 'string' && USER_ID.test(x));
}

/** A first-party service token: the pattern this repo already uses for a service acting for a person. */
function isFirstPartyService(claims) {
    return Boolean(claims && String(claims.sub || '').startsWith('svc:') && claims.actor_type === 'service');
}

/**
 * The person a request acts for, or why it may not. The header is X-OV-Subject (the person); the token is the
 * principal with its claims.
 */
function personFor(principal, header) {
    const claims = (principal && principal.claims) || null;
    const named = String(header || '').trim();
    const obo = claimPerson(claims);
    if (obo) {
        if (named && named !== obo) return { error: [403, 'subject.mismatch', 'this token acts for another person'] };
        return { subject: obo };
    }
    if (!named) return { error: [403, 'subject.required', 'the task must run for a person: send X-OV-Subject with their subject id'] };
    if (!USER_ID.test(named)) return { error: [400, 'subject.invalid', 'X-OV-Subject must be a usr_… subject id'] };
    if (grantPeople(claims).includes(named)) return { subject: named };
    if (isFirstPartyService(claims)) return { subject: named };
    return { error: [403, 'subject.not_granted', 'this token may not act for that person'] };
}

module.exports = { personFor, claimPerson, grantPeople, isFirstPartyService, USER_ID };

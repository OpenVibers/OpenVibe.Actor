'use strict';

const DAY = 86_400_000;
const MAX_DAYS = 90;
const normalize = (value) => String(value || '').normalize('NFKC').toLocaleLowerCase('und').replace(/\s+/gu, ' ').trim();
const word = /[\p{L}\p{N}\p{M}_]/u;

function hasPhrase(message, phrase) {
    const text = normalize(message);
    const needle = normalize(phrase);
    if (!needle) return false;
    let at = -1;
    while ((at = text.indexOf(needle, at + 1)) >= 0) {
        const before = at ? text[at - 1] : '';
        const after = text[at + needle.length] || '';
        if ((!before || !word.test(before)) && (!after || !word.test(after))) return true;
    }
    return false;
}

function matches(message, mention) {
    if (!mention || !Array.isArray(mention.phrases) || !mention.phrases.length) return false;
    return mention.match === 'all'
        ? mention.phrases.every((p) => hasPhrase(message, p))
        : mention.phrases.some((p) => hasPhrase(message, p));
}

function validate(mention, fires, expiresAt, now, createdAt = now) {
    if (!mention || !Array.isArray(mention.phrases) || mention.phrases.length < 1 || mention.phrases.length > 5 ||
        !mention.phrases.every((p) => typeof p === 'string' && p === p.trim() && p.length >= 2 && p.length <= 80)) return 'Give one to five trimmed phrases, each 2 to 80 characters.';
    if (!['any', 'all'].includes(mention.match)) return 'Match must be any or all.';
    if (fires !== 'once_per_conversation') return 'Mention triggers fire once per conversation.';
    if (!Number.isFinite(expiresAt) || expiresAt <= now || expiresAt > createdAt + MAX_DAYS * DAY) return 'Expiry must be within 90 days of creation and still in the future.';
    return null;
}

module.exports = { matches, hasPhrase, validate, DAY, MAX_DAYS };

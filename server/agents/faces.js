'use strict';
/**
 * An agent's face: the picture, the glyph and the hue the menu draws (actor-characters.md §6) and the notification
 * wears (plan §AB.31, "Actor rows show the agent's face"). A face is an avatar ref on an agent row: an https picture,
 * or a preset name ("preset:vibe"). The presets carry their own mark; any other face gets the glyph of its preset (or
 * "user") on a hue taken from the agent's name, so two agents never wear the same colour by accident.
 *
 *   faceOf(row, base?) → { avatar_url, glyph, hue }   (avatar_url: an https picture, or a face kept here
 *                                                      (face:fac_…) at <base>/faces/<id>; null for a preset)
 */
const FACE_MARKS = { 'preset:vibe': ['spark', 258], 'preset:researcher': ['search', 205], 'preset:inbox': ['inbox', 152], 'preset:studio': ['film', 24], 'preset:party': ['spark', 320] };
const HUE = (s) => { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };

const KEPT = /^face:(fac_[0-9A-Za-z]{10,40})$/;
function faceOf(row, base) {
    const face = String((row && row.face) || 'preset:agent');
    // A face kept here (server/faces, 11-16) is a picture too: the menu and the notices show it from this host.
    const kept = KEPT.exec(face);
    const home = String(base || process.env.BASE_URL || 'https://openvibe.actor').replace(/\/+$/, '');
    const avatar = /^https:\/\/[^\s]+$/.test(face) ? face : kept ? `${home}/faces/${kept[1]}` : null;
    if (FACE_MARKS[face]) return { avatar_url: avatar, glyph: FACE_MARKS[face][0], hue: FACE_MARKS[face][1] };
    const preset = /^preset:([a-z][a-z0-9-]{0,40})$/.exec(face);
    return { avatar_url: avatar, glyph: preset && preset[1] !== 'agent' ? preset[1] : 'user', hue: HUE((row && row.name) || 'Agent') };
}

module.exports = { FACE_MARKS, HUE, faceOf };

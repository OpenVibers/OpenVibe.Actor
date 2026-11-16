'use strict';

/**
 * Faces: the pictures of a person's Actor and of the agents they make (the owner, 11-16: "you never added the image
 * generator, like avatar system … the image models … configurable in the admin panel … usable through the exchange").
 *
 *   createFaces({ s, models, fetchImpl }) → {
 *     generate(owner, { name, description, style, n })   n pictures (1–4) from OpenVibe.AI's image route, as the person
 *                                                       (their allowance; the models the admin's setup routes to)
 *     store(owner, bytes, { prompt, style })             an upload or a generated picture → { id, url }
 *     get(id)                                            { mime, bytes } for GET /faces/:id
 *     use(owner, target, faceId)                         target 'actor' (their first agent, the Actor) or an agent id:
 *                                                       its face ref becomes 'face:<id>' (null: back to its preset)
 *     list(owner)                                        their last 24 faces, newest first
 *   }
 *
 * A face is checked by its first bytes (PNG, JPEG or WebP; never a declared type), at most 2 MB. The prompt asks for a
 * square portrait with no text; the person's description is theirs to write (AI's content rules apply to it). A picture
 * the provider gives as a link is fetched once over https and kept here, so the face never depends on a provider's URL.
 */
const STYLES = Object.freeze({
    openvibe: { name: 'OpenVibe', line: 'a clean modern illustration, soft light, a deep blue backdrop with a gentle glow' },
    anime: { name: 'Anime', line: 'an anime character portrait, crisp line work, bright eyes' },
    line: { name: 'Line art', line: 'minimal line art in two colours on a plain background' },
    pixel: { name: 'Pixel', line: '16-bit pixel art, a limited palette' },
    oil: { name: 'Oil painting', line: 'an oil painting with visible brush strokes' },
    clay: { name: '3D clay', line: 'a soft 3D clay render, studio light' },
    photo: { name: 'Photo', line: 'a realistic studio portrait photograph' },
});
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_FETCH = 8 * 1024 * 1024;

class FaceError extends Error {
    constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

/** PNG, JPEG or WebP by the first bytes; anything else is null. */
function sniff(buf) {
    if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
    if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
    return null;
}

let sharpCache;
function sharpLib() {
    if (sharpCache !== undefined) return sharpCache;
    try { sharpCache = require('sharp'); } catch { sharpCache = null; }
    return sharpCache;
}

const clean = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

/** The image prompt: a square portrait for an assistant, the style, the person's own words, and no text. */
function promptOf({ name, description, style }) {
    const st = STYLES[style] || STYLES.openvibe;
    const who = clean(name, 60) || 'a friendly AI assistant';
    const about = clean(description, 400);
    return `A square profile picture for an AI assistant called "${who}". ${about ? `${about}. ` : ''}Style: ${st.line}. `
        + 'One subject, centred, head and shoulders, facing the viewer, a simple background, no text, no letters, no logo, no watermark.';
}

function createFaces({ s, models, fetchImpl = globalThis.fetch } = {}) {
    async function store(owner, input, { prompt = null, style = null } = {}) {
        let buf = input;
        let mime = sniff(buf);
        if (!mime) throw new FaceError(422, 'actor.face.invalid', 'A picture is a PNG, JPEG or WebP image');
        if (buf.length > MAX_FETCH) throw new FaceError(413, 'actor.face.too_large', 'A picture is at most 2 MB');
        // One shape for every face: 512 px square WebP, turned upright, with its metadata (an upload's EXIF, a place)
        // left behind. Without sharp the checked bytes are kept as they are.
        const sh = sharpLib();
        if (sh) {
            try { buf = await sh(buf, { limitInputPixels: 40_000_000 }).rotate().resize(512, 512, { fit: 'cover', position: 'attention' }).webp({ quality: 86 }).toBuffer(); mime = 'image/webp'; }
            catch { throw new FaceError(422, 'actor.face.invalid', 'That picture could not be read'); }
        }
        if (buf.length > MAX_BYTES) throw new FaceError(413, 'actor.face.too_large', 'A picture is at most 2 MB');
        const id = s.newId('fac');
        await s.db.query('INSERT INTO actor_faces (id, owner, mime, bytes, prompt, style, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)',
            [id, owner, mime, buf, prompt ? String(prompt).slice(0, 2000) : null, style, s.iso()]);
        return { id, url: `/faces/${id}`, mime };
    }

    async function fetchBytes(url) {
        if (!/^https:\/\//.test(String(url || ''))) throw new FaceError(502, 'actor.face.unreachable', 'The picture came back without a usable link');
        const res = await fetchImpl(url, { redirect: 'follow', signal: AbortSignal.timeout(30_000) });
        if (!res.ok) throw new FaceError(502, 'actor.face.unreachable', `The picture could not be fetched (HTTP ${res.status})`);
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length > MAX_FETCH) throw new FaceError(502, 'actor.face.too_large', 'The picture was too large');
        return buf;
    }

    async function generate(owner, { name, description, style = 'openvibe', n = 3 } = {}) {
        if (!models || typeof models.image !== 'function') throw new FaceError(503, 'actor.face.unavailable', 'Pictures are not set up on this server');
        if (style && !STYLES[style]) throw new FaceError(422, 'actor.face.invalid', `style: one of ${Object.keys(STYLES).join(', ')}`);
        const count = Math.max(1, Math.min(4, Number(n) || 3));
        const prompt = promptOf({ name, description, style });
        const subject = String(owner || '').replace(/^user:/, '') || null;
        const out = await models.image({ prompt, n: count, size: '1024x1024', subject });
        const faces = [];
        for (const img of (out && out.images) || []) {
            const buf = img && img.b64 ? Buffer.from(String(img.b64), 'base64') : await fetchBytes(img && img.url);
            faces.push(await store(owner, buf, { prompt, style: style || 'openvibe' }));
        }
        if (!faces.length) throw new FaceError(502, 'actor.face.empty', 'The picture service answered without a picture');
        return { faces, cost_usd: Number(out.cost_usd) || 0 };
    }

    async function get(id) {
        if (!/^fac_[0-9A-Za-z]{10,40}$/.test(String(id || ''))) return null;
        return s.db.maybe('SELECT id, owner, mime, bytes FROM actor_faces WHERE id = $1', [id]);
    }

    async function use(owner, target, faceId) {
        let ref = null;
        if (faceId) {
            const f = await s.db.maybe('SELECT id FROM actor_faces WHERE id = $1 AND owner = $2', [faceId, owner]);
            if (!f) throw new FaceError(404, 'actor.face.not_found', 'No such picture of yours');
            ref = `face:${f.id}`;
        }
        const agent = target === 'actor'
            ? await s.db.maybe('SELECT id, is_vibe, preset FROM actor_agents WHERE owner = $1 AND is_vibe = true ORDER BY created_at LIMIT 1', [owner])
            : await s.db.maybe('SELECT id, is_vibe, preset FROM actor_agents WHERE id = $1 AND owner = $2', [target, owner]);
        if (!agent) throw new FaceError(404, 'actor.agent.not_found', target === 'actor' ? 'You have no Actor yet' : 'No such agent of yours');
        const face = ref || (agent.preset ? `preset:${agent.preset}` : 'preset:agent');
        await s.db.query('UPDATE actor_agents SET face = $3, updated_at = $4 WHERE id = $1 AND owner = $2', [agent.id, owner, face, s.iso()]);
        // Your first agent is your Actor: its picture is the Actor's too.
        if (agent.is_vibe) await s.db.query('UPDATE actors SET avatar = $2::jsonb, updated_at = $3 WHERE owner = $1', [owner, ref ? JSON.stringify({ face: faceId, url: `/faces/${faceId}` }) : null, s.iso()]);
        return { agent: agent.id, face, face_url: ref ? `/faces/${faceId}` : null };
    }

    async function list(owner) {
        const rows = await s.db.many('SELECT id, style, created_at FROM actor_faces WHERE owner = $1 ORDER BY created_at DESC LIMIT 24', [owner]);
        return rows.map((r) => ({ id: r.id, url: `/faces/${r.id}`, style: r.style, created_at: r.created_at }));
    }

    return { generate, store, get, use, list, STYLES };
}

module.exports = { createFaces, sniff, promptOf, STYLES, FaceError, MAX_BYTES };

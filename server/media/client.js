'use strict';

/**
 * OpenVibe.Media for Actor (plan HO8, ADR-060): where a sandbox skill's code bytes live. Each code resource is one
 * PRIVATE object under Actor's own tenant (`config.skills.mediaTenant`, normally Actor's client id). The registry
 * hashes the exact bytes it scans and uploads those bytes with that hash; the listing then pins `{ media_id, sha256 }`,
 * so a Run job names the object and the digest and the Link refuses anything that changed.
 *
 * There is no public URL here: a skill's code is not served to anybody. `put()` answers `{ id, sha256 }` or
 * `{ error }`; `enabled` is false without Media's URL or Actor's client secret, and publishing a sandbox skill then
 * says so plainly instead of listing code it cannot store.
 *
 *   createMedia({ config, fetchImpl, tokens? }) → { enabled, tenant, put(text, { name, mimeType? }) }
 */
const crypto = require('crypto');
const sharp = require('sharp');
const { serviceAuth } = require('openvibe-contracts');
const { createObjectsClient } = require('openvibe-sdk/media');

const MEDIA_ID = /^med_[0-9A-HJKMNP-TV-Z]{26}$/;

/** Validate real image bytes and strip metadata while respecting orientation. */
async function sanitizePhoto(input, mimeType) {
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(mimeType) || !Buffer.isBuffer(input) || !input.length || input.length > 10 * 1024 * 1024) {
        return { error: 'Choose one JPEG, PNG or WebP photo of at most 10 MB.' };
    }
    try {
        const meta = await sharp(input, { limitInputPixels: 50_000_000 }).metadata();
        if (!['jpeg', 'png', 'webp'].includes(meta.format) || `image/${meta.format}` !== mimeType) return { error: 'The file is not the image type it claims.' };
        const bytes = await sharp(input, { limitInputPixels: 50_000_000 }).rotate().jpeg({ quality: 85 }).toBuffer();
        if (bytes.length > 10 * 1024 * 1024) return { error: 'The photo is too large after processing.' };
        return { bytes };
    } catch { return { error: 'The photo could not be processed or stored.' }; }
}

function createMedia({ config, fetchImpl = globalThis.fetch, tokens: tokensOverride = null } = {}) {
    const services = (config && config.services) || {};
    const skills = (config && config.skills) || {};
    const base = services.mediaUrl || '';
    const tenant = skills.mediaTenant || 'actor';
    const enabled = !!(base && (tokensOverride || (config.oauth && config.oauth.clientSecret)));
    const tokens = !enabled ? null : tokensOverride || serviceAuth.createTokenClient({
        tokenUrl: `${config.networkInternalUrl}/oauth/token`,
        clientId: config.oauth.clientId, clientSecret: config.oauth.clientSecret,
        audience: 'openvibe.media', scope: 'media.object.upload media.object.read', fetchImpl,
    });
    const objects = !enabled ? null : createObjectsClient({ app: tenant, baseUrl: base, tokenClient: tokens, fetch: fetchImpl });

    /**
     * Store one code resource, private, and answer the Media object id and the sha256 of the exact bytes stored.
     * The caller has already scanned this same string; nothing is transformed on the way in.
     */
    async function put(text, { name = 'code.js', mimeType = 'text/javascript' } = {}) {
        if (!enabled) return { error: 'OpenVibe.Media is not connected on this server, so the code cannot be stored.' };
        const bytes = Buffer.from(String(text == null ? '' : text), 'utf8');
        if (!bytes.length) return { error: 'A code resource is empty, so there is nothing to store.' };
        const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
        try {
            const object = await objects.upload(bytes, {
                kind: 'file', visibility: 'private', mimeType, contentHash: sha256,
                filename: String(name || 'code.js').split('/').pop(),
            });
            const id = object && object.id;
            if (!MEDIA_ID.test(String(id || ''))) return { error: 'OpenVibe.Media answered without an object id, so the code was not stored.' };
            return { id, sha256 };
        } catch (err) {
            const why = (err && (err.message || err.code)) || String(err);
            return { error: `OpenVibe.Media could not store the code: ${String(why).slice(0, 240)}` };
        }
    }

    /** Re-encode a person's one photo so EXIF and other metadata never leave Actor. */
    async function putPhoto(input, { mimeType = '' } = {}) {
        if (!enabled) return { error: 'OpenVibe.Media is unavailable, so the photo was not stored.' };
        const cleaned = await sanitizePhoto(input, mimeType);
        if (cleaned.error) return cleaned;
        try {
            const bytes = cleaned.bytes;
            const object = await objects.upload(bytes, { kind: 'file', visibility: 'private', mimeType: 'image/jpeg',
                contentHash: crypto.createHash('sha256').update(bytes).digest('hex'), filename: 'photo.jpg' });
            if (!MEDIA_ID.test(String(object && object.id || ''))) return { error: 'Media did not return a photo id.' };
            return { id: object.id };
        } catch {
            return { error: 'The photo could not be processed or stored.' };
        }
    }

    async function photoUrl(id) {
        if (!enabled || !MEDIA_ID.test(String(id || ''))) return null;
        try {
            const signed = await objects.signedUrl(id, { ttl: 300 });
            return signed && /^https:\/\//.test(String(signed.url || '')) ? signed.url : null;
        } catch { return null; }
    }

    return { enabled, tenant, put, putPhoto, photoUrl };
}

module.exports = { createMedia, sanitizePhoto, MEDIA_ID };

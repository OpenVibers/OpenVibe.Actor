'use strict';

/**
 * OpenVibe.Download — the person's own drive — from the tool modules (not a module itself: the registry skips
 * files starting with "_").
 *
 * The drive is reached through the SDK (openvibe-sdk/download), with the person's OWN Network token as the
 * credential: never a sync key (ovdl_…, the backup key of the openvibe-download command) and never a service
 * secret of Actor's own. A sync key would outlive the session and would act on the drive with nobody watching;
 * the person's token says who is asking, so the drive answers for that person alone.
 *
 *   downloadFor(ctx, person) → { enabled, base, listFolder, fileMeta, readBytes, ensurePath, filesIn, upload }
 *
 * The SDK client is built per (config, fetch, token): one client per person and per fetch, so a test's fetch and
 * a run's fetch never share a token.
 */

const { createClient } = require('openvibe-sdk/core');
const { createDownloadClient } = require('openvibe-sdk/download');

const USER_SUBJECT = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;
/** The types a text file may have: everything else is binary and is never read as text. */
const TEXTUAL = /^(?:text\/[^;]+|application\/(?:json|ld\+json|xml|xhtml\+xml|javascript|x-yaml|yaml|toml|csv|x-sh)|image\/svg\+xml)/i;
/** The most a read may bring back: a bigger file is described, not read. */
const MAX_READ_BYTES = 200 * 1024;
/** The most files one folder answers with. */
const MAX_FILES = 200;

const CACHE = new WeakMap();

/** The person a task is for ('user:usr_…' → 'usr_…'), or null when the task has no person. */
function personOf(requester) {
    if (typeof requester !== 'string' || !requester.startsWith('user:')) return null;
    const id = requester.slice(5);
    return USER_SUBJECT.test(id) ? id : null;
}

/** The folder id at a path ('Agent/notes'), or null when the path is not there. Folders are never made here. */
function folderAt(folders, path) {
    const parts = String(path || '').split('/').map((p) => p.trim()).filter(Boolean);
    let parent = null;
    for (const name of parts) {
        const found = (folders || []).find((f) => (f.parent_id || null) === parent && String(f.name || '').toLowerCase() === name.toLowerCase());
        if (!found) return null;
        parent = found.id;
    }
    return parent;
}

/**
 * The download client for one person, or a client that is off. `ctx.personToken` is the person's own Network
 * token (the one the run carries); without it the drive is not reachable and the tools say so in one line.
 */
function downloadFor(ctx, person) {
    const config = ctx.config;
    const base = String((config && config.services && config.services.downloadUrl) || '').replace(/\/+$/, '');
    const token = ctx.personToken || null;
    const enabled = Boolean(base && token && person);
    if (!enabled) {
        return { enabled: false, base, reason: base ? 'this run has no OpenVibe session of its own' : 'OpenVibe.Download is not connected to this server' };
    }

    const fetchImpl = ctx.fetch || globalThis.fetch;
    let byFetch = CACHE.get(config);
    if (!byFetch) { byFetch = new WeakMap(); CACHE.set(config, byFetch); }
    let byToken = byFetch.get(fetchImpl);
    if (!byToken) { byToken = new Map(); byFetch.set(fetchImpl, byToken); }
    if (byToken.has(token)) return byToken.get(token);

    const client = createClient({ token, baseUrls: { download: base }, fetch: fetchImpl, retries: 2 });
    // The client is ours (so a test's fetch and the person's token are used); the token is passed as well because
    // the SDK's own guard asks for it.
    const dl = createDownloadClient({ client, baseUrl: base, token });

    /** One folder's files and subfolders. */
    async function listFolder(path) {
        const folders = await dl.folders.list();
        const wanted = String(path || '').trim();
        const folderId = wanted ? folderAt(folders, wanted) : null;
        if (wanted && !folderId) return { error: 'there is no folder "' + wanted + '" in your drive' };
        const page = await dl.files.list({ folderId, limit: MAX_FILES });
        return {
            folder_id: folderId,
            folders: (page.folders || []).map((f) => ({ id: f.id, name: f.name, created_at: f.created_at || null })),
            files: (page.files || []).map((f) => ({
                id: f.id, name: f.name, size: Number(f.size) || 0,
                content_type: f.content_type || null, created_at: f.created_at || null, folder_id: f.folder_id || null,
            })),
            usage: page.usage || null,
        };
    }

    /** One file's own row, or null when it is not theirs. */
    async function fileMeta(id) {
        const out = await dl.files.get(id);
        return (out && out.file) || null;
    }

    /** The bytes of one file, as they are on the drive. */
    async function readBytes(id) {
        const res = await fetchImpl(base + '/files/' + encodeURIComponent(id) + '/download', {
            headers: { Accept: '*/*', Authorization: 'Bearer ' + token },
            signal: AbortSignal.timeout(30_000),
        });
        if (!res.ok) {
            let detail = 'OpenVibe.Download answered ' + res.status;
            try { const body = await res.json(); detail = String((body && (body.detail || body.title || body.code)) || detail); } catch { /* not JSON */ }
            return { error: detail };
        }
        return { bytes: Buffer.from(await res.arrayBuffer()) };
    }

    /** The folder at a path, made when it is not there yet (the write path only). */
    async function ensurePath(path) {
        return await dl.folders.ensurePath(path);
    }

    /** The files of one folder, by name, so a clash can be seen before a name is used. */
    async function filesIn(folderId) {
        const page = await dl.files.list({ folderId, limit: MAX_FILES });
        return page.files || [];
    }

    /** One file, uploaded under a name that is not taken. */
    async function upload({ name, data, folderId, contentType = null }) {
        return await dl.upload({ name, data, folderId, contentType });
    }

    const out = { enabled: true, base, dl, token, listFolder, fileMeta, readBytes, ensurePath, filesIn, upload };
    byToken.set(token, out);
    return out;
}

/** The name to write under: the one asked for, or the next free "name (2)", "name (3)" … */
function freeName(taken, name) {
    const used = new Set((taken || []).map((f) => String(f.name || '').toLowerCase()));
    const wanted = String(name || 'file');
    if (!used.has(wanted.toLowerCase())) return wanted;
    const dot = wanted.lastIndexOf('.');
    const stem = dot > 0 ? wanted.slice(0, dot) : wanted;
    const ext = dot > 0 ? wanted.slice(dot) : '';
    for (let n = 2; n < 100; n++) {
        const candidate = stem + ' (' + n + ')' + ext;
        if (!used.has(candidate.toLowerCase())) return candidate;
    }
    return wanted;
}

module.exports = { downloadFor, personOf, folderAt, freeName, TEXTUAL, MAX_READ_BYTES, MAX_FILES, USER_SUBJECT };

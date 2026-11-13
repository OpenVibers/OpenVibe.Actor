'use strict';

/**
 * A file of the person's own drive (OpenVibe.Download), written by the agent: through the SDK with the person's own
 * token, into the folder path under "Agent/", with the folders made as they are needed.
 *
 * Nothing the person made is ever overwritten. The drive's upload always makes a new file, and a name that is
 * already taken gets the next free one ("notes.txt" → "notes (2).txt"), so a file the agent did not make keeps
 * its name and its content.
 *
 * This writes, so it acts: the loop checkpoints the intent before it runs, and a restart asks again.
 */

const { downloadFor, personOf, freeName } = require('./_download');

/** The folder path a save goes to: 'Agent' plus the path the person gave. */
const folderFor = (path) => {
    const wanted = String(path || '').split('/').map((p) => p.trim()).filter(Boolean);
    return ['Agent'].concat(wanted).join('/');
};

module.exports = {
    name: 'files_save',
    description: 'Save a file in your OpenVibe.Download drive, under the folder path you name inside "Agent". Give the text to save, or the id of a file this task already made (artifact_id) to save that one. A name that is taken gets the next free one, so nothing you made is overwritten. Answers the file\'s id, name, size and link.',
    input: {
        type: 'object',
        properties: {
            path: { type: 'string', description: 'the folder path inside "Agent" (for example "notes/2026"); leave it out for "Agent" itself' },
            name: { type: 'string', description: 'the name of the file (for example "notes.txt")' },
            text: { type: 'string', description: 'the content to save, as text' },
            artifact_id: { type: 'string', description: 'the id (art_…) of a file this task already made, to save that one instead of text' },
        },
        required: ['name'],
    },
    scope: 'person',
    needs: { files: 'write', network: true },   // plan 11c: the run's files and network settings gate it
    connector: 'files',
    acts: true,
    costUsd: 0,
    timeoutMs: 120_000,
    available: (ctx) => Boolean(ctx.config && ctx.config.services && ctx.config.services.downloadUrl && personOf(ctx.requester)),
    async run(input, ctx) {
        const person = personOf(ctx.requester);
        const drive = downloadFor(ctx, person);
        if (!drive.enabled) return { text: JSON.stringify({ error: drive.reason }), isError: true };
        const name = String((input && input.name) || '').trim();
        if (!name) return { text: JSON.stringify({ error: 'name the file to save' }), isError: true };

        // The bytes: the text of the call, or a file this task already made.
        let bytes = null;
        let contentType = 'text/plain; charset=utf-8';
        let wanted = name;
        const artifactId = String((input && input.artifact_id) || '').trim();
        if (artifactId) {
            const store = ctx.artifacts;
            const row = store && typeof store.find === 'function' ? await store.find(artifactId).catch(() => null) : null;
            if (!row) return { text: JSON.stringify({ error: 'there is no file ' + artifactId + ' in this task' }), isError: true };
            bytes = Buffer.isBuffer(row.bytes) ? row.bytes : Buffer.from(row.bytes || []);
            contentType = String(row.mime || 'application/octet-stream');
            if (!input.name) wanted = String(row.name || name);
        } else {
            const text = input && typeof input.text === 'string' ? input.text : null;
            if (text == null) return { text: JSON.stringify({ error: 'give the text to save, or the id of a file this task already made' }), isError: true };
            bytes = Buffer.from(text, 'utf8');
        }
        if (!bytes.length) return { text: JSON.stringify({ error: 'the drive keeps files of at least one byte' }), isError: true };

        try {
            const folder = folderFor(input && input.path);
            const folderId = await drive.ensurePath(folder);
            const taken = await drive.filesIn(folderId);
            const finalName = freeName(taken, wanted);
            const file = await drive.upload({ name: finalName, data: bytes, folderId, contentType });
            const publicBase = String((ctx.config && ctx.config.services && ctx.config.services.downloadPublicUrl) || drive.base).replace(/\/+$/, '');
            const out = {
                id: file && file.id, name: (file && file.name) || finalName, size: Number((file && file.size) || bytes.length),
                folder, renamed: finalName !== wanted ? { wanted, saved_as: finalName } : null,
                url: publicBase + '/files/' + encodeURIComponent(String((file && file.id) || '')),
            };
            return { text: JSON.stringify(out), data: out };
        } catch (err) {
            return { text: JSON.stringify({ error: 'OpenVibe.Download did not answer: ' + String((err && err.message) || err).slice(0, 200) }), isError: true };
        }
    },
};

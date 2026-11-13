'use strict';

/**
 * The content of one text file of the person's own drive (OpenVibe.Download), through the SDK with the person's
 * own token. A read is a read: it changes nothing, so a resume may run it again.
 *
 * Only a text file of at most 200 KB is read as text. A bigger file, or one that is not text (a picture, a PDF, an
 * archive), is described instead: its name, size, type, date and the link to open it. The bytes of a binary file
 * are never guessed at.
 */

const { downloadFor, personOf, TEXTUAL, MAX_READ_BYTES } = require('./_download');

module.exports = {
    name: 'files_read',
    description: 'Read one file of your OpenVibe.Download drive and answer its text. Give the file id (from files_list). A text file of at most 200 KB is answered in full; a bigger file or one that is not text is described instead (its size, type and the link to open it).',
    input: {
        type: 'object',
        properties: {
            id: { type: 'string', description: 'the file id (from files_list)' },
        },
        required: ['id'],
    },
    scope: 'person',
    needs: { files: 'read', network: false },   // plan 11c: OpenVibe's own service, not the open web
    connector: 'files',
    costUsd: 0,
    timeoutMs: 45_000,
    available: (ctx) => Boolean(ctx.config && ctx.config.services && ctx.config.services.downloadUrl && personOf(ctx.requester)),
    async run(input, ctx) {
        const person = personOf(ctx.requester);
        const drive = downloadFor(ctx, person);
        if (!drive.enabled) return { text: JSON.stringify({ error: drive.reason }), isError: true };
        const id = String((input && input.id) || '').trim();
        if (!id) return { text: JSON.stringify({ error: 'name the file id to read' }), isError: true };
        let meta = null;
        try {
            meta = await drive.fileMeta(id);
        } catch (err) {
            return { text: JSON.stringify({ error: 'OpenVibe.Download did not answer: ' + String((err && err.message) || err).slice(0, 200) }), isError: true };
        }
        if (!meta) return { text: JSON.stringify({ error: 'there is no file ' + id + ' in your drive' }), isError: true };
        const publicBase = String((ctx.config && ctx.config.services && ctx.config.services.downloadPublicUrl) || drive.base).replace(/\/+$/, '');
        const described = {
            id: meta.id, name: meta.name, size: Number(meta.size) || 0,
            content_type: meta.content_type || null, created_at: meta.created_at || null,
            url: publicBase + '/files/' + encodeURIComponent(meta.id),
        };
        const size = described.size;
        const type = String(described.content_type || '');
        if (size > MAX_READ_BYTES) {
            return {
                text: JSON.stringify(Object.assign({}, described, { note: 'the file is ' + size + ' bytes, over the ' + MAX_READ_BYTES + ' bytes read as text; here is its link instead' })),
                data: described,
            };
        }
        if (type && !TEXTUAL.test(type)) {
            return {
                text: JSON.stringify(Object.assign({}, described, { note: 'the file is not text (' + type + '); here is its link instead' })),
                data: described,
            };
        }
        const got = await drive.readBytes(meta.id);
        if (got.error) return { text: JSON.stringify({ error: got.error }), isError: true };
        const text = got.bytes.toString('utf8');
        if (text.includes('\uFFFD')) {
            return {
                text: JSON.stringify(Object.assign({}, described, { note: 'the file is not text; here is its link instead' })),
                data: described,
            };
        }
        return {
            text: JSON.stringify(Object.assign({}, described, { text })),
            data: Object.assign({}, described, { text }),
        };
    },
};

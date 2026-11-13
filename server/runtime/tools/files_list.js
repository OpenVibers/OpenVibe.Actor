'use strict';

/**
 * The files in one folder of the person's own drive (OpenVibe.Download), through the SDK with the person's own
 * token. A list is a read: it changes nothing, so a resume may run it again.
 */

const { downloadFor, personOf, MAX_FILES } = require('./_download');

module.exports = {
    name: 'files_list',
    description: 'List the files and the folders in one folder of your OpenVibe.Download drive. The folder is a path (for example "Agent/notes"); leave it out for the root of your drive. Answers each file\'s name, size, type, date and id, and each folder\'s name and id. At most 200 files a folder.',
    input: {
        type: 'object',
        properties: {
            folder: { type: 'string', description: 'the folder as a path in the drive (for example "Agent/notes"); leave it out for the root' },
        },
    },
    scope: 'person',
    needs: { files: 'read', network: false },   // plan 11c: OpenVibe's own service, not the open web
    connector: 'files',
    costUsd: 0,
    timeoutMs: 30_000,
    available: (ctx) => Boolean(ctx.config && ctx.config.services && ctx.config.services.downloadUrl && personOf(ctx.requester)),
    async run(input, ctx) {
        const person = personOf(ctx.requester);
        const drive = downloadFor(ctx, person);
        if (!drive.enabled) return { text: JSON.stringify({ error: drive.reason }), isError: true };
        try {
            const out = await drive.listFolder(input && input.folder);
            if (out.error) return { text: JSON.stringify({ error: out.error }), isError: true };
            return {
                text: JSON.stringify({
                    folder: String((input && input.folder) || ''),
                    files: out.files.slice(0, MAX_FILES),
                    folders: out.folders,
                    usage: out.usage,
                }),
                data: { files: out.files, folders: out.folders },
            };
        } catch (err) {
            return { text: JSON.stringify({ error: 'OpenVibe.Download did not answer: ' + String((err && err.message) || err).slice(0, 200) }), isError: true };
        }
    },
};

'use strict';

/**
 * make_file (Actor v2, stage V2-4): write a Markdown, CSV, JSON, HTML or SVG file the model supplies, and keep it in
 * Actor's own database, private to the person the task is for. The file becomes an artifact on the task (its result
 * and its events), and the owner opens it from their own task page.
 *
 * Scope `person`: making a file needs a signed-in requester to own it, so a public-chat task (via: chat) is never
 * offered this tool. `available()` also needs an artifact store for this run.
 */

const { NAME, personOf } = require('../artifacts');

const FORMATS = {
    markdown: { ext: 'md', mime: 'text/markdown', label: 'Markdown' },
    csv: { ext: 'csv', mime: 'text/csv', label: 'CSV' },
    json: { ext: 'json', mime: 'application/json', label: 'JSON' },
    html: { ext: 'html', mime: 'text/html', label: 'HTML' },
    svg: { ext: 'svg', mime: 'image/svg+xml', label: 'SVG' },
};
const BY_EXT = { md: 'markdown', markdown: 'markdown', csv: 'csv', json: 'json', html: 'html', htm: 'html', svg: 'svg' };

function slugName(raw, ext) {
    const base = String(raw || '')
        .replace(/[\\/]+/g, '-')
        .replace(/[^A-Za-z0-9._-]+/g, '-')
        .replace(/^[-.]+|[-.]+$/g, '')
        .replace(/\.[A-Za-z0-9]{1,8}$/, '')
        .slice(0, 100);
    return `${base || 'file'}.${ext}`;
}

module.exports = {
    name: 'make_file',
    description: 'Write a file for the person and attach it to the answer: Markdown, CSV, JSON, HTML or SVG. Pass the whole content; the file is stored privately for them and shown on the task page. Use make_chart for a chart drawn from data.',
    input: {
        type: 'object',
        properties: {
            format: { type: 'string', enum: Object.keys(FORMATS), description: 'The file format; inferred from name when omitted.' },
            name: { type: 'string', description: 'The file name, e.g. report.md (no folders). The extension is set from the format.' },
            content: { type: 'string', description: 'The complete file content.' },
        },
        required: ['content'],
    },
    scope: 'person',
    costUsd: 0,
    timeoutMs: 30_000,
    available: (ctx) => Boolean(ctx && ctx.artifacts && ctx.artifacts.available),

    async run(input, ctx) {
        const person = personOf(ctx && ctx.requester);
        if (!ctx || !ctx.artifacts || !ctx.artifacts.available || !person) {
            return { error: 'files need a signed-in person, which this task does not have', isError: true };
        }
        const content = typeof input.content === 'string' ? input.content : '';
        if (!content.trim()) return { error: 'content: the complete file content is required', isError: true };
        const wanted = input.format == null ? '' : String(input.format).toLowerCase();
        const extOfName = (/\.([A-Za-z0-9]{1,8})$/.exec(String(input.name || '')) || [])[1];
        const format = FORMATS[wanted] ? wanted : (extOfName && BY_EXT[extOfName.toLowerCase()]) || 'markdown';
        const info = FORMATS[format];
        if (input.format != null && !FORMATS[wanted]) return { error: `format must be one of ${Object.keys(FORMATS).join(', ')}`, isError: true };
        const name = slugName(input.name, info.ext);
        if (!NAME.test(name)) return { error: 'name must be 1–128 letters, digits, dots, dashes or underscores', isError: true };
        if (format === 'json') {
            try { JSON.parse(content); } catch (err) { return { error: `content is not valid JSON: ${(err && err.message) || 'parse failed'}`, isError: true }; }
        }
        if (format === 'svg' && !/<svg[\s>]/i.test(content)) return { error: 'content must be an SVG document (it needs an <svg> element)', isError: true };
        if (format === 'csv' && !content.includes('\n')) return { error: 'content must be CSV with a header line and at least one row', isError: true };
        const bytes = Buffer.from(content, 'utf8');
        if (bytes.length > ctx.artifacts.maxFileBytes) return { error: `content is ${bytes.length} bytes; this server's file limit is ${ctx.artifacts.maxFileBytes} bytes`, isError: true };

        const artifact = await ctx.artifacts.save({ kind: 'file', name, mime: info.mime, bytes });
        return {
            text: `Wrote ${artifact.name} (${info.label}, ${artifact.size} bytes) and attached it to the answer.`,
            data: { name: artifact.name, format, mime: artifact.mime, size: artifact.size },
            artifacts: [artifact],
        };
    },
};

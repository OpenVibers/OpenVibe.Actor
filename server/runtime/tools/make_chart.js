'use strict';

/**
 * make_chart (Actor v2, stage V2-4): draw a bar, line, scatter or pie chart from data, server-side, with
 * deterministic code (tools/lib/chart.js), and keep the SVG in Actor's own database as a private artifact. The model
 * chooses the data and the spec; it never draws pixels.
 *
 * Scope `person`: the chart belongs to the signed-in requester, so a public-chat task is never offered this tool.
 */

const { renderChart, MAX_POINTS, TYPES } = require('./lib/chart');
const { NAME, personOf } = require('../artifacts');

function slugName(raw) {
    const base = String(raw || 'chart')
        .replace(/[\\/]+/g, '-')
        .replace(/[^A-Za-z0-9._-]+/g, '-')
        .replace(/^[-.]+|[-.]+$/g, '')
        .replace(/\.[A-Za-z0-9]{1,8}$/, '')
        .slice(0, 100);
    return `${base || 'chart'}.svg`;
}

module.exports = {
    name: 'make_chart',
    description: 'Draw a chart from data and attach it to the answer as an SVG: bar, line, scatter or pie. The data is the chart: bar/line/pie take [{label, value}], scatter takes [{x, y, label?}]. The server draws it deterministically; never describe pixels yourself.',
    input: {
        type: 'object',
        properties: {
            type: { type: 'string', enum: TYPES, description: 'The chart form.' },
            title: { type: 'string', description: 'A short title.' },
            data: {
                type: 'array',
                description: 'The values: [{label, value}] for bar, line and pie; [{x, y, label?}] for scatter.',
                items: {
                    type: 'object',
                    properties: {
                        label: { type: 'string' },
                        value: { type: 'number' },
                        x: { type: 'number' },
                        y: { type: 'number' },
                    },
                },
            },
            x_label: { type: 'string', description: 'The x axis label.' },
            y_label: { type: 'string', description: 'The y axis label.' },
            name: { type: 'string', description: 'The SVG file name; derived from the title otherwise.' },
        },
        required: ['type', 'data'],
    },
    scope: 'person',
    costUsd: 0,
    timeoutMs: 30_000,
    available: (ctx) => Boolean(ctx && ctx.artifacts && ctx.artifacts.available),

    async run(input, ctx) {
        const person = personOf(ctx && ctx.requester);
        if (!ctx || !ctx.artifacts || !ctx.artifacts.available || !person) {
            return { error: 'charts need a signed-in person, which this task does not have', isError: true };
        }
        const type = String(input.type || '').toLowerCase();
        if (!TYPES.includes(type)) return { error: `type must be one of ${TYPES.join(', ')}`, isError: true };
        if (!Array.isArray(input.data) || !input.data.length) return { error: 'data: a non-empty array is required', isError: true };
        if (input.data.length > MAX_POINTS) return { error: `data has ${input.data.length} points; the limit is ${MAX_POINTS}`, isError: true };

        let svg;
        try {
            svg = renderChart({
                type, title: input.title, data: input.data,
                x_label: input.x_label, y_label: input.y_label,
            });
        } catch (err) {
            return { error: `the chart cannot be drawn: ${(err && err.message) || err}`, isError: true };
        }
        const bytes = Buffer.from(svg, 'utf8');
        if (bytes.length > ctx.artifacts.maxFileBytes) return { error: `the chart is ${bytes.length} bytes; this server's file limit is ${ctx.artifacts.maxFileBytes} bytes`, isError: true };
        const name = slugName(input.name || input.title || `${type}-chart`);
        if (!NAME.test(name)) return { error: 'name must be 1–128 letters, digits, dots, dashes or underscores', isError: true };

        const artifact = await ctx.artifacts.save({ kind: 'chart', name, mime: 'image/svg+xml', bytes });
        return {
            text: `Drew a ${type} chart${input.title ? ` titled "${String(input.title).slice(0, 120)}"` : ''} with ${input.data.length} point${input.data.length === 1 ? '' : 's'} and attached it as ${artifact.name} (${artifact.size} bytes).`,
            data: { chart_type: type, points: input.data.length, name: artifact.name, mime: artifact.mime, size: artifact.size },
            artifacts: [artifact],
        };
    },
};

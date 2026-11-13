'use strict';

/**
 * canvas_set: draw the agent's live panel beside this conversation (plan HO9, actor.canvas@1, ADR-059).
 *
 * The whole document is replaced and its version grows; the released contract validates it, and a document it does
 * not know is refused with the plain reason (never half-written). A canvas only draws: a button asks the person's
 * agent for them and a checklist tick is the person's own (server/canvases.js). One run may make at most 20 calls.
 *
 * Blocks (every one needs "type"; an "id" is a stable slug, a-z0-9_- up to 40 characters):
 *   {type:"heading", text, level?:1|2}          {type:"text", text}          {type:"list", items:[string], ordered?}
 *   {type:"checklist", id, items:[{id, text, done}]}
 *   {type:"table", columns:[string], rows:[[string|number]]}         {type:"metric", label, value, note?}
 *   {type:"chart", kind:"bar"|"line", unit?, series:[{name, points:[{x, y}]}]}
 *   {type:"image", src:"https://openvibe.media/…", alt}             {type:"link", href:"https://…", text}
 *   {type:"button", label, action:"ask"}
 */
const canvases = require('../../canvases');

module.exports = {
    name: 'canvas_set',
    description: 'Draw the live panel beside this conversation for the person: replace its whole document with a new '
        + 'title and blocks, and the version grows. Use it when the work has a shape worth keeping beside the chat (a '
        + 'trip plan, a price table, a checklist, a small chart), and update it as the work moves. Blocks are data, '
        + 'never HTML: heading {text, level?}, text {text}, list {items, ordered?}, checklist {id, items:[{id, text, done}]}, '
        + 'table {columns, rows}, metric {label, value, note?}, chart {kind:"bar"|"line", unit?, series:[{name, points:[{x, y}]}]}, '
        + 'image {src (openvibe.media only), alt}, link {href (https), text}, button {label, action:"ask"}. A button '
        + 'only sends its label as the person\'s own message; a checklist tick is theirs. Give stable ids to a checklist '
        + 'and its items so a tick still means the same item after an update. At most 60 blocks, 8 table columns and '
        + '100 rows; use at most 20 canvas_set calls in one run.',
    input: {
        type: 'object',
        properties: {
            title: { type: 'string', minLength: 1, maxLength: 120, description: 'The panel\'s title, e.g. "Lisbon, 12–14 March".' },
            blocks: {
                type: 'array',
                maxItems: 60,
                description: 'The whole document, in order. Each block is an object with a "type" (see the tool description).',
                items: { type: 'object', additionalProperties: true },
            },
        },
        required: ['title', 'blocks'],
        additionalProperties: false,
    },
    scope: 'person',
    needs: { files: 'write', network: false },   // plan 11c: the run's files and network settings gate it
    connector: 'space',
    acts: false,
    costUsd: 0,
    timeoutMs: 5000,
    available: (ctx) => Boolean(ctx && ctx.store && ctx.taskId),

    async run(input, ctx) {
        if (!ctx.requester || !String(ctx.requester).startsWith('user:')) {
            return { text: JSON.stringify({ error: 'a canvas belongs to a signed-in person; this task has none' }), isError: true };
        }
        if (!ctx.taskId) {
            return { text: JSON.stringify({ error: 'a canvas sits beside a conversation; this run has none' }), isError: true };
        }
        const used = Number(ctx.canvasWrites) || 0;
        if (used >= canvases.MAX_SETS_PER_RUN) {
            return { text: JSON.stringify({ error: `at most ${canvases.MAX_SETS_PER_RUN} canvas_set calls in one run; say what is already there instead` }), isError: true };
        }
        ctx.canvasWrites = used + 1;
        const thread = await canvases.threadForTask(ctx.store, ctx.taskId);
        if (!thread) return { text: JSON.stringify({ error: 'that conversation is not stored, so there is nowhere to draw' }), isError: true };
        const out = await canvases.put(ctx.store, {
            owner: ctx.requester,
            agentId: ctx.agentId,
            thread,
            title: input && input.title,
            blocks: input && input.blocks,
        });
        if (out.error) return { text: JSON.stringify({ error: out.error }), isError: true };
        const doc = out.doc;
        return {
            text: `Canvas "${doc.title}" is now version ${doc.version} with ${doc.blocks.length} block${doc.blocks.length === 1 ? '' : 's'}; it is drawn beside this conversation.`,
            data: { canvas: doc },
        };
    },
};

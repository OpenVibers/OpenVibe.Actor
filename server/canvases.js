'use strict';

/**
 * An agent's live panel beside the conversation (plan HO9, actor.canvas@1, ADR-059).
 *
 * The document is DATA: a title and a list of blocks (heading, text, list, checklist, table, metric, chart, image,
 * link, button), drawn by openvibe-shared's ov-canvas.js wherever it is shown. Actor stores one per thread (the
 * conversation's first turn), validates every write against the released actor.canvas@1 schema, and refuses a
 * document the schema does not know with the schema's plain reason. The agent replaces the whole document; the
 * version only grows.
 *
 * A canvas never acts. A button's label is posted by the API as the person's own message (a normal turn), and a
 * checklist tick changes the document here and is left in NOTICES for the next turn to read as context. Another
 * person's canvas is the same 404 as one that does not exist.
 */
const contracts = require('openvibe-contracts');

const CNV_ID = /^cnv_[0-9A-HJKMNP-TV-Z]{26}$/;
const BLOCK_ID = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const AGENT_ID = /^agt_[0-9A-HJKMNP-TV-Z]{26}$/;
const MAX_BLOCKS = 60;
const MAX_TITLE = 120;
// One run may call canvas_set at most this many times (the tool counts on its run's context).
const MAX_SETS_PER_RUN = 20;

const TYPES = ['heading', 'text', 'list', 'checklist', 'table', 'metric', 'chart', 'image', 'link', 'button'];
const TYPE_NAMES = `${TYPES.slice(0, -1).join(', ')} or ${TYPES[TYPES.length - 1]}`;

const parse = (v) => (v == null ? null : typeof v === 'string' ? JSON.parse(v) : v);
const itemsOf = (doc) => (doc && Array.isArray(doc.blocks) ? doc.blocks : []);

/** The document a row holds, as data (the schema's own shape). */
const docOf = (row) => (row ? parse(row.document) : null);

/** How many items the page's fold says the canvas holds. */
const countOf = (doc) => itemsOf(doc).length;

function cleanTitle(value) {
    const title = typeof value === 'string' ? value.trim() : '';
    if (!title) return { error: 'title: a canvas needs a title.' };
    if (title.length > MAX_TITLE) return { error: `title: at most ${MAX_TITLE} characters.` };
    return { title };
}

/**
 * The schema's first plain reason for a document we built. The oneOf over the block kinds makes a raw AJV error
 * list unreadable ("must match exactly one schema in oneOf" ten times); the block's own type is enough to say
 * what is wrong, so the messages are chosen from the error at or under that block.
 */
// The fields each block kind really needs, so the oneOf's other branches ("a heading needs text" on an image
// missing its alt) do not become the reason the agent reads.
const REQUIRED = {
    heading: ['text'], text: ['text'], list: ['items'], checklist: ['items'], table: ['columns', 'rows'],
    metric: ['label', 'value'], chart: ['kind', 'series'], image: ['src', 'alt'], link: ['href', 'text'], button: ['label', 'action'],
};
function reasonFor(errors, blocks) {
    const list = Array.isArray(errors) ? errors : [];
    const blockAt = (at) => {
        const m = /^\/blocks\/(\d+)/.exec(String(at || ''));
        return m ? blocks[Number(m[1])] : null;
    };
    const useful = list
        .map((e) => ({ e, at: String(e.path || ''), message: String(e.message || '') }))
        .filter((x) => !/^must be equal to constant$/.test(x.message) && !/^must match exactly one schema in oneOf$/.test(x.message))
        .filter((x) => {
            const required = /required property '([^']+)'/.exec(x.message);
            if (!required) return true;
            const block = blockAt(x.at);
            return !block || !block.type || !REQUIRED[block.type] || REQUIRED[block.type].includes(required[1]);
        });
    const inBlock = useful.filter((x) => /^\/blocks\/\d+/.test(x.at));
    // A required field the block kind really has is the reason; a branch-kind's leftover "additional property" is not.
    const requiredPick = inBlock.find((x) => {
        const m = /required property '([^']+)'/.exec(x.message);
        const b = blockAt(x.at);
        return Boolean(m && b && b.type && REQUIRED[b.type] && REQUIRED[b.type].includes(m[1]));
    });
    const error = requiredPick || inBlock.find((x) => !/additional propert/.test(x.message)) || inBlock[0] || useful[0] || list[0] || null;
    if (!error) return 'the canvas does not match actor.canvas@1.';
    const at = error.at;
    const blockIndex = /^\/blocks\/(\d+)/.exec(at);
    const block = blockIndex ? blocks[Number(blockIndex[1])] : null;
    const where = blockIndex ? `block ${Number(blockIndex[1]) + 1}${block && block.type ? ` (${block.type})` : ''}: ` : '';
    const message = error.message;
    if (/additional property/.test(message)) return `${where}a canvas block has no such field.`;
    const required = /required property '([^']+)'/.exec(message);
    if (required) return `${where}${block && block.type ? block.type : 'the block'} needs "${required[1]}".`;
    if (/must match pattern/.test(at) && /\/src$/.test(at)) return `${where}a picture must be on openvibe.media, and nowhere else.`;
    if (/must match pattern/.test(at) && /\/href$/.test(at)) return `${where}a link must be https.`;
    if (/must match pattern/.test(message) || /must match format/.test(message)) return `${where}${message.replace(/^must /, 'it must ')}.`;
    if (/must NOT have more than|must NOT have fewer than|must NOT have more|must NOT have less/.test(message)) return `${where}${message.replace(/^must NOT /, 'it must not ')}.`;
    if (/must be integer|must be number|must be string|must be boolean/.test(message)) return `${where}${message.replace(/^must be /, 'it must be ')}.`;
    return `${where}${message}.`;
}

/** Every problem with a title and blocks, before the released schema sees them. */
function precheck(title, blocks) {
    if (!Array.isArray(blocks)) return 'blocks must be a list of canvas blocks.';
    if (blocks.length > MAX_BLOCKS) return `blocks: at most ${MAX_BLOCKS} blocks in one canvas.`;
    for (let i = 0; i < blocks.length; i++) {
        const b = blocks[i];
        const where = `block ${i + 1}`;
        if (!b || typeof b !== 'object' || Array.isArray(b)) return `${where} is not a canvas block.`;
        if (!TYPES.includes(b.type)) return `${where}: "${String(b.type || '')}" is not a canvas block (${TYPE_NAMES}).`;
        if (b.type === 'image' && !/^https:\/\/openvibe\.media\//.test(String(b.src || ''))) return `${where} (image): a picture must be on openvibe.media, and nowhere else.`;
        if (b.type === 'link' && !/^https:\/\//.test(String(b.href || ''))) return `${where} (link): a link must be https.`;
        if (b.type === 'button' && b.action !== 'ask') return `${where} (button): a button can only ask ("action": "ask"); it never acts.`;
    }
    const t = cleanTitle(title);
    if (t.error) return t.error;
    return null;
}

/** Build the actor.canvas@1 document from a stored row and the new title/blocks. */
function build({ id, title, blocks, version, agentId, thread, updatedAt }) {
    const doc = { canvas: 'actor.canvas@1', id, title, version };
    if (agentId && AGENT_ID.test(String(agentId))) doc.agent_id = String(agentId);
    doc.thread = String(thread);
    doc.updated_at = updatedAt;
    doc.blocks = blocks;
    return doc;
}

/**
 * Write the whole document for a thread (canvas_set). A new thread gets version 1; an existing one gets its
 * version + 1, its id and its agent when this run did not name one. → { row, doc } or { error }.
 */
async function put(s, { owner, agentId, thread, title, blocks }) {
    if (!thread || !/^tsk_[0-9A-HJKMNP-TV-Z]{26}$/.test(String(thread))) return { error: 'a canvas sits beside a conversation, and this run has none.' };
    const bad = precheck(title, blocks);
    if (bad) return { error: bad };
    const clean = cleanTitle(title);
    return s.tx(async () => {
        // Two canvas_set calls in one turn run in parallel: serialize the first write of a thread, so one makes the
        // row and the other updates it (the unique thread would otherwise turn the second into an error).
        await s.db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [String(thread)]);
        const existing = await s.db.maybe('SELECT * FROM actor_canvases WHERE thread = $1 FOR UPDATE', [thread]);
        if (existing && existing.owner !== owner) return { error: 'that conversation is not yours.' };
        const id = existing ? existing.id : s.newId('cnv');
        const version = existing ? Number(existing.version) + 1 : 1;
        const updatedAt = s.iso();
        const doc = build({ id, title: clean.title, blocks, version, agentId: agentId || (existing && existing.agent_id), thread, updatedAt });
        const v = contracts.validate('actor.canvas@1', doc);
        if (!v.valid) return { error: reasonFor(v.errors, blocks) };
        if (existing) {
            await s.db.query('UPDATE actor_canvases SET document = $2::jsonb, version = $3, agent_id = $4, updated_at = $5 WHERE id = $1',
                [id, JSON.stringify(doc), version, doc.agent_id || null, updatedAt]);
        } else {
            await s.db.query('INSERT INTO actor_canvases (id, owner, agent_id, thread, document, version, notices, updated_at) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7::jsonb, $8)',
                [id, owner, doc.agent_id || null, thread, JSON.stringify(doc), version, '[]', updatedAt]);
        }
        return { row: await s.db.maybe('SELECT * FROM actor_canvases WHERE id = $1', [id]), doc };
    });
}

/** The canvas of one thread, if there is one. */
const forThread = (s, thread) => s.db.maybe('SELECT * FROM actor_canvases WHERE thread = $1', [String(thread)]);

/** One person's canvas by id; another person's is null (the caller answers 404). */
const get = (s, owner, id) => (CNV_ID.test(String(id)) ? s.db.maybe('SELECT * FROM actor_canvases WHERE id = $1 AND owner = $2', [String(id), owner]) : null);

/** A person's canvases, newest first (the API list and the account export). */
const list = (s, owner, limit = 50) => s.db.many('SELECT * FROM actor_canvases WHERE owner = $1 ORDER BY updated_at DESC LIMIT $2', [owner, limit]);

/** The first turn of the conversation a task belongs to (a fork starts its own). */
async function threadForTask(s, taskId) {
    let cur = taskId ? await s.db.maybe('SELECT id, parent_id, fork_of_step FROM tasks WHERE id = $1', [String(taskId)]) : null;
    const seen = new Set();
    while (cur && cur.parent_id && cur.fork_of_step == null && seen.size < 200 && !seen.has(cur.id)) {
        seen.add(cur.id);
        cur = await s.db.maybe('SELECT id, parent_id, fork_of_step FROM tasks WHERE id = $1', [cur.parent_id]);
    }
    return cur ? cur.id : null;
}

/** The newest turn of a conversation (the parent of a message typed into it today). */
async function latestForThread(s, thread) {
    let cur = thread ? await s.db.maybe('SELECT * FROM tasks WHERE id = $1', [String(thread)]) : null;
    for (let i = 0; cur && i < 200; i++) {
        const next = await s.db.maybe('SELECT * FROM tasks WHERE parent_id = $1 AND fork_of_step IS NULL ORDER BY id DESC LIMIT 1', [cur.id]);
        if (!next) return cur;
        cur = next;
    }
    return cur;
}

/**
 * The ticks the agent has not been told about yet, as conversation context, and clear them. The next run of the
 * conversation reads them once. → [{ task, answer }] (empty when there is nothing).
 */
async function takeNoticesForTask(s, task) {
    if (!task || !task.id) return [];
    const thread = await threadForTask(s, task.id);
    if (!thread) return [];
    return s.tx(async () => {
        const row = await s.db.maybe('SELECT * FROM actor_canvases WHERE thread = $1 FOR UPDATE', [thread]);
        if (!row) return [];
        const notices = parse(row.notices) || [];
        if (!Array.isArray(notices) || !notices.length) return [];
        await s.db.query("UPDATE actor_canvases SET notices = '[]'::jsonb WHERE id = $1", [row.id]);
        const title = (docOf(row) || {}).title || 'the canvas';
        return notices.slice(0, 50).map((n) => ({
            task: `Canvas "${title}"`,
            answer: `The person ${n.done ? 'ticked' : 'unticked'} "${n.text}" (block ${n.block_id}, item ${n.item_id}).`,
        }));
    });
}

/**
 * Tick or untick one checklist item (POST /api/v1/me/canvases/:id/events, kind "check"). The whole document is
 * rewritten with the item's done flag changed and its version + 1; the tick waits in NOTICES for the next turn.
 * → { row, doc } or { error: { status, detail } }.
 */
async function check(s, owner, id, { blockId, itemId, done }) {
    if (!BLOCK_ID.test(String(blockId || '')) || !BLOCK_ID.test(String(itemId || ''))) {
        return { error: { status: 422, detail: 'block_id and item_id are the ids the canvas document names.' } };
    }
    return s.tx(async () => {
        const row = await s.db.maybe('SELECT * FROM actor_canvases WHERE id = $1 AND owner = $2 FOR UPDATE', [String(id), owner]);
        if (!row) return { error: { status: 404, detail: 'No such canvas.' } };
        const doc = docOf(row);
        const block = itemsOf(doc).find((b) => b && b.type === 'checklist' && b.id === blockId);
        const item = block && Array.isArray(block.items) ? block.items.find((it) => it && it.id === itemId) : null;
        if (!item) return { error: { status: 422, detail: 'That checklist item is not on the canvas any more.' } };
        const value = done === true;
        item.done = value;
        const version = Number(row.version) + 1;
        doc.version = version;
        doc.updated_at = s.iso();
        const notices = parse(row.notices) || [];
        notices.push({ block_id: blockId, item_id: itemId, text: String(item.text || ''), done: value, at: s.iso() });
        await s.db.query('UPDATE actor_canvases SET document = $2::jsonb, version = $3, notices = $4::jsonb, updated_at = $5 WHERE id = $1',
            [row.id, JSON.stringify(doc), version, JSON.stringify(notices.slice(-50)), doc.updated_at]);
        return { doc, row: { ...row, version, document: doc, updated_at: doc.updated_at } };
    });
}

module.exports = {
    CNV_ID, BLOCK_ID, TYPES, MAX_BLOCKS, MAX_SETS_PER_RUN,
    put, get, list, forThread, threadForTask, latestForThread, takeNoticesForTask, check, docOf, countOf, reasonFor, build,
};

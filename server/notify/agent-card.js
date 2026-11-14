'use strict';
/**
 * The agent a notification is about, as Network draws it (plan §AB.31, "Actor rows show the agent's face"; openvibe-shared
 * 4.251.0 reads rich_content.agent): { id, name, avatar_url?, hue?, glyph? }.
 *
 * A task belongs to an agent: the one it was started for (tasks.agent_id, or the "agent:agt_…" it came through). A
 * person's task with no agent of its own is their Vibe, the first agent every person has (agents/contacts.js); without
 * a Vibe row yet it is still a Vibe, only without a face.
 *
 * Nothing here is a secret: a name, a picture, a hue and a glyph. Read only, never a write.
 */
const { faceOf } = require('../agents/faces');

const AGENT_ID = /^agt_[0-9A-HJKMNP-TV-Z]{26}$/;

/** The face of one agent row, in the shape a notification carries it. */
function cardOf(row) {
    if (!row) return null;
    const name = String(row.name || '').trim().slice(0, 60);
    if (!name) return null;
    const face = faceOf(row);
    const card = { id: row.is_vibe ? 'vibe' : String(row.id || ''), name };
    if (face.avatar_url) card.avatar_url = face.avatar_url;
    if (Number.isInteger(face.hue)) card.hue = face.hue;
    if (face.glyph) card.glyph = face.glyph;
    return card;
}

/** The agent of a task row, and the face it wears. */
async function cardForTask(s, task) {
    if (!s || !task) return null;
    const owner = String(task.requester || '');
    if (!owner) return null;
    let row = null;
    if (AGENT_ID.test(String(task.agent_id || ''))) {
        row = await s.db.maybe('SELECT * FROM actor_agents WHERE id = $1 AND owner = $2', [task.agent_id, owner]).catch(() => null);
    }
    if (!row && /^agent:agt_/.test(String(task.via || ''))) {
        row = await s.db.maybe('SELECT * FROM actor_agents WHERE id = $1 AND owner = $2', [String(task.via).slice(6), owner]).catch(() => null);
    }
    if (!row && owner.startsWith('user:')) row = await s.db.maybe('SELECT * FROM actor_agents WHERE owner = $1 AND is_vibe ORDER BY created_at, id LIMIT 1', [owner]).catch(() => null);
    if (!row) return owner.startsWith('user:') ? { id: 'vibe', name: 'Vibe' } : null;   // a person's task is their Vibe, even before it has a row
    return cardOf(row);
}

/** The same, for a task that is only known by its id. */
async function cardForTaskId(s, taskId) {
    if (!s || !taskId) return null;
    const row = await s.db.maybe('SELECT * FROM tasks WHERE id = $1', [taskId]).catch(() => null);
    return row ? cardForTask(s, row) : null;
}

module.exports = { cardOf, cardForTask, cardForTaskId };

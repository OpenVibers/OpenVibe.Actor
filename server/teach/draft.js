'use strict';

/**
 * From what a person showed to a skill (Teach a task, plan §AD.33), and from a run that went wrong to the skill's next
 * version (the agent improving its own skills).
 *
 * One vision call each. The model reads the steps in words and the pictures the person clicked on, each with a red ring
 * where they clicked, and answers { name, description, instructions } (a skill draft) or { instructions, change } (an
 * improvement). What a person typed reaches the model only where it was kept (recorder.js: never private text), and the
 * model is told to turn it into a placeholder, never to copy a password or a code into a skill.
 */
const MAX_PICTURES = 12;
const scan = require('../skills/scan');
const HOST_IN_TEXT = /https?:\/\/([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+)/gi;
const MAX_STEPS = 150;

const sharp = (() => { try { return require('sharp'); } catch { return null; } })();

const TOOLS_HINT = `The agent works on its own desk with these tools: computer_desk (start a browser or desktop desk), computer_browser (open a url; click, fill or press on an element by its visible label; read the page), computer_input (click, type and press keys on a desktop), computer_screen (ask what is on the screen), hand_to_person (the person does one step: a sign-in, a code, a payment).`;

const WRITE_SYSTEM = `You turn a person's demonstration on a computer into a skill: the how-to an AI agent follows to do the same task again on its own, on another day, with other details.
${TOOLS_HINT}
Reply with JSON only: {"name":"…","description":"…","instructions":"…"}
- name: 2 to 6 words naming the task, like "Post a clip to X".
- description: one sentence saying when the skill fits a job.
- instructions: Markdown, at most 3500 characters:
  1. "You need:" the details that change each time (what the person typed that will differ: a message, a name, a search, a date), as {placeholders}. Write "Nothing" when nothing changes.
  2. Numbered steps. Start each with the page address to open when it is known, then name every element by what it shows (its label, its icon, its place: "the blue Post button at the top right"), never by pixel position alone. Say what the screen should show after a step when that tells the agent it worked.
  3. "Done when:" how the agent checks the task worked.
- Read the pictures: the red ring is where the person clicked. Name what is under the ring.
- Leave out steps that were mistakes the person undid, and repeated scrolling.
- Never write a password, a code, a card number or any private text into the skill. Where the person typed private text or signed in, write a step "Ask the person to sign in (hand_to_person)" instead.
- Where a step is not clear from the pictures, say what to look for instead of guessing.`;

const IMPROVE_SYSTEM = `An AI agent followed one of its skills (a how-to) and it did not go well: the run failed, or the person had to take over the desk and do part of it themselves. Write the skill's next version so it goes right next time.
${TOOLS_HINT}
Reply with JSON only: {"instructions":"…","change":"…"}
- instructions: the whole skill again, Markdown, at most 3500 characters, in the same shape (You need, numbered steps, Done when). Keep what worked; fix the steps that went wrong; add what the person did when they took over, as steps the agent can do itself next time (naming each element by what it shows; the pictures have a red ring where the person clicked).
- change: one sentence, at most 200 characters, saying what you changed and why ("Opens the Upload tab first: the old step 3 looked for the button on the wrong page.").
- Never write a password, a code, a card number or any private text into the skill. Where the person signed in, write "Ask the person to sign in (hand_to_person)".
- If nothing can be learned from this run, answer {"instructions":"","change":""}.`;

/** The first JSON object in a model's answer, or null. */
function parseJson(text) {
    const t = String(text || '').trim();
    const start = t.indexOf('{');
    const end = t.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try { return JSON.parse(t.slice(start, end + 1)); } catch { return null; }
}

const oneLine = (v, max) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);

/** A draft from the model's answer: { name, description, instructions } or null. */
function draftOf(answer, what) {
    const j = parseJson(answer);
    if (!j || typeof j !== 'object') return null;
    const name = oneLine(j.name || what, 80);
    const description = oneLine(j.description || `Do this the way the person showed: ${what}`, 280);
    const instructions = String(j.instructions || '').trim().slice(0, 4000);
    return name && description && instructions.length >= 20 ? { name, description, instructions } : null;
}

/** One step as a line the model reads. */
function stepLine(step, i) {
    const a = step.args || {};
    if (a.action === 'type') {
        if (a.private) return `${i + 1}. Typed ${a.chars} private characters (a password, a code or an address: never copy them).`;
        if (typeof a.text === 'string' && a.text) return `${i + 1}. Typed "${a.text.slice(0, 300).replace(/"/g, '\'')}"`;
        return `${i + 1}. Typed ${a.chars || 'some'} characters.`;
    }
    if (/click/.test(a.action || '')) {
        const where = a.width && a.height ? ` at ${Math.round((a.x / a.width) * 100)}% across, ${Math.round((a.y / a.height) * 100)}% down` : '';
        return `${i + 1}. ${step.text}${where}${step.picture ? ` (picture ${step.pictureNo})` : ''}.`;
    }
    return `${i + 1}. ${step.text}.`;
}

/** The picture a person clicked on, with a red ring where they clicked, as a data URL the model reads. */
async function ringed(shot, args) {
    const bytes = Buffer.isBuffer(shot.bytes) ? shot.bytes : Buffer.from(shot.bytes || []);
    if (!bytes.length) return null;
    const plain = `data:${shot.mime || 'image/jpeg'};base64,${bytes.toString('base64')}`;
    if (!sharp || !args || !args.width || !args.height) return plain;
    try {
        const meta = await sharp(bytes).metadata();
        const w = meta.width || shot.width || 640;
        const h = meta.height || shot.height || 400;
        const cx = Math.round((args.x / args.width) * w);
        const cy = Math.round((args.y / args.height) * h);
        const r = Math.max(10, Math.round(w / 40));
        const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#ff1f3d" stroke-width="${Math.max(3, Math.round(r / 4))}"/></svg>`);
        const out = await sharp(bytes).composite([{ input: svg, top: 0, left: 0 }]).jpeg({ quality: 80 }).toBuffer();
        return `data:image/jpeg;base64,${out.toString('base64')}`;
    } catch { return plain; }
}

/**
 * The steps and up to MAX_PICTURES of their pictures (evenly spread when there are more), as message parts.
 *   steps: recorder.steps(); picture(seq) → the still row ({ mime, bytes, width, height }) or null
 */
async function demonstration(steps, picture) {
    const list = steps.slice(-MAX_STEPS);
    const withPictures = list.filter((x) => x.picture);
    const every = Math.max(1, Math.ceil(withPictures.length / MAX_PICTURES));
    const chosen = new Set(withPictures.filter((_, i) => i % every === 0).slice(0, MAX_PICTURES).map((x) => x.seq));
    let n = 0;
    const numbered = list.map((x) => (chosen.has(x.seq) ? { ...x, picture: true, pictureNo: ++n } : { ...x, picture: false }));
    const parts = [];
    for (const x of numbered) {
        if (!x.picture) continue;
        const shot = await picture(x.seq).catch(() => null);
        const url = shot ? await ringed(shot, x.args) : null;
        if (!url) continue;
        parts.push({ type: 'text', text: `Picture ${x.pictureNo}: what the screen showed when they clicked (the red ring).` });
        parts.push({ type: 'image_url', image_url: { url, detail: 'auto' } });
    }
    return { lines: numbered.map(stepLine).join('\n'), parts, pictures: n };
}

/**
 * Write a skill from a demonstration.
 * → { draft: { name, description, instructions }, cost_usd, model } or { error }
 */
async function write({ models, subject = null, what, startUrl = null, steps, picture, signal = null }) {
    if (!models || typeof models.chat !== 'function') return { error: 'No model is set up to read what you showed.' };
    if (!steps || !steps.length) return { error: 'Nothing was done on the desk, so there is nothing to learn.' };
    const demo = await demonstration(steps, picture);
    const intro = `The task the person showed: ${oneLine(what, 300)}${startUrl ? `\nThe desk started at: ${startUrl}` : ''}\n\nWhat they did, in order:\n${demo.lines}`;
    const r = await models.chat({
        tier: 'vision', maxTokens: 3000, signal, subject,
        messages: [{ role: 'system', content: WRITE_SYSTEM }, { role: 'user', content: [{ type: 'text', text: intro }, ...demo.parts] }],
    });
    const draft = draftOf(r && r.text, what);
    if (!draft) return { error: 'The model did not write a usable skill from what you showed.', cost_usd: Number(r && r.cost_usd) || 0 };
    return { draft, cost_usd: Number(r.cost_usd) || 0, model: r.model || null, pictures: demo.pictures };
}

/**
 * The next version of a skill after a run that went wrong.
 *   skill      { name, instructions }
 *   run        { state, error, calls: [lines] } what the agent did
 *   steps      what the person did when they took over (recorder.steps)
 * → { instructions, change, cost_usd } ({ instructions: '' } when nothing can be learned) or { error }
 */
async function improve({ models, subject = null, skill, run, steps = [], picture = async () => null, signal = null }) {
    if (!models || typeof models.chat !== 'function') return { error: 'No model is set up.' };
    const demo = await demonstration(steps, picture);
    const text = [
        `The skill "${oneLine(skill.name, 80)}" as it is now:\n${String(skill.instructions || '').slice(0, 4000)}`,
        `How the run ended: ${run.state}${run.error ? ` (${oneLine(run.error, 400)})` : ''}`,
        `What the agent did, in order:\n${(run.calls || []).slice(-60).join('\n') || '(nothing recorded)'}`,
        steps.length ? `What the person did when they took over the desk, in order:\n${demo.lines}` : 'The person did not take over the desk.',
    ].join('\n\n');
    const r = await models.chat({
        tier: 'vision', maxTokens: 3000, signal, subject,
        messages: [{ role: 'system', content: IMPROVE_SYSTEM }, { role: 'user', content: demo.parts.length ? [{ type: 'text', text }, ...demo.parts] : text }],
    });
    const j = parseJson(r && r.text);
    const cost = Number(r && r.cost_usd) || 0;
    if (!j) return { error: 'The model did not answer with a skill.', cost_usd: cost };
    const instructions = String(j.instructions || '').trim().slice(0, 4000);
    return { instructions: instructions.length >= 20 ? instructions : '', change: oneLine(j.change, 200), cost_usd: cost, model: r.model || null };
}

/**
 * What a skill the person taught (or reviewed) declares: the hosts its words open and the kinds of step they ask for,
 * on top of what it declared before. A declaration grants nothing (the level and the approvals decide each step); it
 * says what the person saw it do, so the scan flags only what is new. The agent's own improvement never calls this: a
 * new host or kind in its version is flagged and waits for the person.
 */
function deriveRequires(fields, base = null) {
    const text = `${fields.description || ''}\n${fields.instructions || ''}`;
    const hosts = new Set(base && Array.isArray(base.hosts) ? base.hosts : []);
    for (const m of text.matchAll(HOST_IN_TEXT)) {
        const host = m[1].toLowerCase();
        if (hosts.size < 20 && host.length <= 253 && /\.[a-z]{2,63}$/.test(host)) hosts.add(host);   // a web host: never an address
    }
    const kinds = new Set(base && Array.isArray(base.kinds) ? base.kinds : []);
    for (const act of scan.ACTS) if (act.re.test(text)) kinds.add(act.kind);
    const out = { ...(base && typeof base === 'object' ? base : {}) };
    if (kinds.size) out.kinds = [...kinds].sort();
    if (hosts.size) out.hosts = [...hosts].sort();
    return Object.keys(out).length ? out : undefined;
}

module.exports = { deriveRequires, write, improve, demonstration, draftOf, parseJson, stepLine, MAX_PICTURES, WRITE_SYSTEM, IMPROVE_SYSTEM };

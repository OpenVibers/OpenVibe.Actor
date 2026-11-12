'use strict';

/**
 * A finished run's replay (See it work, W1): every computer step, the action it took and the still it saw. Built from
 * the task's own events and the pictures kept by tasks/stills; the model never supplies an action or a picture.
 *
 * Typed text is never returned: a step may say that something was typed or filled, never what. A click keeps its x,y in
 * the picture's pixels so a page can put a ring where it happened.
 */
const store = require('./store');
const stills = require('./stills');

const COMPUTER = /^computer_(input|browser|screen|desk)$/;

async function steps(s, row, { baseUrl = '' } = {}) {
    const events = await store.eventsDetailed(s, row.id, 0);
    const pictures = await stills.list(s, row.id);
    const bySeq = new Map(pictures.map((p) => [p.seq, p]));
    const results = new Map();
    for (const e of events) if (e && e.kind === 'output' && e.step === 'tool_result' && e.call_id) results.set(e.call_id, e);
    const out = [];
    for (const e of events) {
        if (!e || e.kind !== 'output' || e.step !== 'tool_call' || !COMPUTER.test(String(e.tool || ''))) continue;
        const result = results.get(e.call_id) || null;
        const args = e.args && typeof e.args === 'object' ? e.args : {};
        let action = args.action || null, x = null, y = null, width = null, height = null, url = null, secret = false;
        if (e.tool === 'computer_input') {
            action = String(args.action || 'input');
            for (const [k, v] of [['x', args.x], ['y', args.y], ['width', args.width], ['height', args.height]]) {
                if (Number.isFinite(v)) { if (k === 'x') x = Number(v); else if (k === 'y') y = Number(v); else if (k === 'width') width = Number(v); else height = Number(v); }
            }
            if (action === 'type') secret = true;
        } else if (e.tool === 'computer_browser') {
            action = String(args.action || 'browser');
            if (action === 'open' && typeof args.url === 'string') url = args.url.slice(0, 400);
            if (action === 'fill') secret = true;
        } else if (e.tool === 'computer_screen') action = 'look';
        else action = String(args.action || 'desk');
        if (result) {
            try { const d = JSON.parse(result.text || '{}'); if (d && typeof d.url === 'string' && /^https?:\/\//.test(d.url)) url = d.url.slice(0, 400); } catch { /* not JSON */ }
        }
        const seq = result ? result.seq : e.seq;
        let picture = bySeq.get(seq);
        for (let p = seq; p >= 1 && !picture; p--) picture = bySeq.get(p);
        out.push({
            seq, at: result && result.at ? result.at : e.at || null, tool: e.tool, action: secret ? 'secret' : action,
            x, y, width, height, url, secret,
            text: result ? String(result.text || '').slice(0, 400) : null,
            error: !!(result && result.is_error),
            still: picture ? { seq: picture.seq, url: `${baseUrl}/api/v1/tasks/${row.id}/replay/${picture.seq}/still`, width: picture.width, height: picture.height, mime: picture.mime } : null,
        });
    }
    return out.slice(-200);
}

/** One line for the replay's caption, in plain words. */
function caption(step) {
    if (!step) return '';
    if (step.tool === 'computer_input') {
        if (step.action === 'click' || step.action === 'double_click' || step.action === 'right_click') return `Clicked at ${Math.round(step.x || 0)}, ${Math.round(step.y || 0)}`;
        if (step.action === 'move') return `Moved to ${Math.round(step.x || 0)}, ${Math.round(step.y || 0)}`;
        if (step.action === 'scroll') return 'Scrolled';
        if (step.action === 'key') return 'Pressed a key';
        return 'Typed';
    }
    if (step.tool === 'computer_browser') {
        if (step.action === 'open') return 'Opened a page';
        if (step.action === 'read') return 'Read the page';
        if (step.action === 'click') return 'Clicked on the page';
        if (step.action === 'fill') return 'Filled a field';
        if (step.action === 'press') return 'Pressed a key';
        if (step.action === 'back') return 'Went back';
        return 'Used the browser';
    }
    if (step.tool === 'computer_screen') return 'Looked at the screen';
    return step.action === 'start' ? 'Started the desk' : step.action === 'stop' ? 'Stopped the desk' : 'Checked the desk';
}

module.exports = { steps, caption, COMPUTER };

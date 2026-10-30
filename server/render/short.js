'use strict';
/**
 * The home on a phone (the owner's short-pages rule, 2026-10-30): one or two screens, app-like.
 *
 *   foldBlock()  a part a reader rarely needs: closed on a phone, where the title row opens it, and open where there
 *                is room, where it looks like the section it replaces. A checkbox and a label, no script: the part
 *                stays in the page for the crawlers, and a browser without CSS shows it as it was.
 *   pickBlock()  several blocks of the same kind, one at a time on a phone, picked with a row of chips. Radio inputs
 *                and :has(), no script: every block stays in the page, and a wider screen (or a browser without
 *                :has()) shows them all and no chips.
 *
 * The CSS for both lives in the site's own stylesheet; the rule that shows the picked block is written for the page,
 * because there is one per block.
 */
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** A piece of markup as a string: a plain string, or the raw html a template returned. */
const str = (v) => (v && typeof v === 'object' && typeof v.s === 'string') ? v.s : String(v == null ? '' : v);

/**
 * A fold. The head is the heading the block had (an <h2>, so it stays a heading on a phone too); the html is what it
 * holds. `bare` is for a part that keeps its own heading in the body: where there is room the title row gives way to
 * it, so the part looks exactly as it did.
 *
 *   foldBlock({ id, head, html, bare })
 */
function foldBlock({ id, head, html, bare = false }) {
    const key = `fold-${esc(id)}`;
    return `<div class="fold${bare ? ' fold-bare' : ''}" id="${key}">`
        + `<input class="fold-toggle" type="checkbox" id="${key}-open">`
        + `<label class="fold-h" for="${key}-open">${str(head)}<span class="fold-mark" aria-hidden="true"></span></label>`
        + `<div class="fold-body">${str(html)}</div></div>`;
}

/**
 * A pick block. The panes are the page's own blocks; each one keeps its heading on a wide screen, and on a phone the
 * heading gives way to the chip that names it.
 *
 *   pickBlock({ key, label, head, panes, checked })   panes: [{ id, label, html }]; checked: the pane the first
 *                chip picks (the first one by default)
 */
function pickBlock({ key, label, head = '', panes, checked = '' }) {
    if (!panes.length) return '';
    const first = panes.find((p) => p.id === checked) ? checked : panes[0].id;
    const chips = panes.map((p) => `<input type="radio" name="pick-${esc(key)}" id="pk-${esc(key)}-${esc(p.id)}" value="${esc(p.id)}"${p.id === first ? ' checked' : ''}><label for="pk-${esc(key)}-${esc(p.id)}">${esc(p.label)}</label>`).join('');
    const body = panes.map((p) => `<div class="pick-pane" id="pp-${esc(key)}-${esc(p.id)}">${str(p.html)}</div>`).join('');
    return `<div class="pick" id="pick-${esc(key)}"><div class="pick-bar"><div class="pick-head"><h2>${esc(head || label)}</h2></div><div class="pick-row" role="radiogroup" aria-label="${esc(label)}">${chips}</div></div><div class="pick-body">${body}</div></div>`;
}

/** The rule that shows the picked block of a pick block: one per block, so the CSS is written for the page. */
function pickRule(key, id) {
    return `.pick:has(#pk-${key}-${id}:checked) #pp-${key}-${id}{display:block}`;
}

/** The rules for every block of a pick block, in the order they appear. */
function pickRules(key, ids) {
    return ids.map((id) => pickRule(key, id)).join('');
}

module.exports = { foldBlock, pickBlock, pickRule, pickRules };

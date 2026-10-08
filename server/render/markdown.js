'use strict';

/**
 * A deliberately small Markdown renderer for agents' answers. Everything is escaped first; only headings, paragraphs,
 * lists, fenced code, tables, bold, italics, inline code and links are recognised. Links are kept only when http(s) or
 * relative, and a model's link is never vouched for: rel="nofollow ugc noopener", opened in a new tab.
 */
const { esc } = require('./html');

function inline(s) {
    let out = esc(s);
    out = out.replace(/`([^`]+)`/g, '<code>$1</code>');
    out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    out = out.replace(/(^|[\s(])\*([^*\s][^*]*)\*(?=[\s).,;:!?]|$)/g, '$1<em>$2</em>');
    out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, text, href) => {
        const h = href.replace(/&amp;/g, '&');
        if (/^https?:\/\//.test(h)) return `<a href="${esc(h)}" rel="nofollow ugc noopener" target="_blank">${text}</a>`;
        if (/^[#./a-zA-Z0-9]/.test(h) && !/^[a-z]+:/i.test(h)) return `<a href="${esc(h)}">${text}</a>`;
        return text;
    });
    // Bare links the model wrote out, outside an <a> already made above.
    out = out.replace(/(^|[\s(])(https?:\/\/[^\s<)"']+[^\s<)"'.,;:!?])/g, (m, pre, url) => `${pre}<a href="${url}" rel="nofollow ugc noopener" target="_blank">${url}</a>`);
    return out;
}

const cells = (line) => line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
const isSeparator = (line) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);

function markdown(src, { headingOffset = 1 } = {}) {
    const lines = String(src || '').replace(/\r\n/g, '\n').split('\n');
    const out = [];
    let para = [];
    let list = null;   // { type: 'ul' | 'ol', items: [] }
    let fence = null;
    const flushPara = () => { if (para.length) { out.push(`<p>${inline(para.join(' '))}</p>`); para = []; } };
    const flushList = () => { if (list) { out.push(`<${list.type}>${list.items.map((i) => `<li>${inline(i)}</li>`).join('')}</${list.type}>`); list = null; } };
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (fence) {
            if (/^```/.test(line)) { out.push(`<pre><code>${esc(fence.join('\n'))}</code></pre>`); fence = null; } else fence.push(line);
            continue;
        }
        if (/^```/.test(line)) { flushPara(); flushList(); fence = []; continue; }
        // A table: a header row, a separator row, then rows while lines start with |.
        if (/^\s*\|/.test(line) && i + 1 < lines.length && isSeparator(lines[i + 1])) {
            flushPara(); flushList();
            const head = cells(line);
            const rows = [];
            i += 2;
            while (i < lines.length && /^\s*\|/.test(lines[i])) { rows.push(cells(lines[i])); i++; }
            i--;
            out.push(`<div class="table-wrap"><table><thead><tr>${head.map((h) => `<th scope="col">${inline(h)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
            continue;
        }
        const h = line.match(/^(#{1,6})\s+(.*)$/);
        if (h) {
            flushPara(); flushList();
            const level = Math.min(6, h[1].length + headingOffset);
            out.push(`<h${level}>${inline(h[2])}</h${level}>`);
            continue;
        }
        const li = line.match(/^\s*(?:[-*]|(\d+)\.)\s+(.*)$/);
        if (li) {
            flushPara();
            const type = li[1] ? 'ol' : 'ul';
            if (!list || list.type !== type) { flushList(); list = { type, items: [] }; }
            list.items.push(li[2]);
            continue;
        }
        if (!line.trim()) { flushPara(); flushList(); continue; }
        if (list && /^\s{2,}\S/.test(line)) { list.items[list.items.length - 1] += ` ${line.trim()}`; continue; }
        flushList();
        para.push(line.trim());
    }
    if (fence) out.push(`<pre><code>${esc(fence.join('\n'))}</code></pre>`);
    flushPara(); flushList();
    return out.join('\n');
}

module.exports = { markdown, inline };

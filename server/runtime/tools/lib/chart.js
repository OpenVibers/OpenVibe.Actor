'use strict';

/**
 * Deterministic chart → SVG (Actor v2, stage V2-4). The model supplies data and a chart spec; this code, not the
 * model, draws the pixels. No DOM, no headless browser, no randomness: the same input always gives the same bytes.
 *
 * The look follows the house data-viz rules: a thin 24px bar cap with a 4px rounded data end and a square baseline,
 * 2px lines, 8px markers with a 2px surface ring, solid hairline gridlines, text in ink tokens (never a series hue),
 * a legend for two or more series, and a single validated categorical order (blue, orange, aqua, yellow, magenta,
 * green). A pie folds past six slices into "Other".
 *
 *   renderChart({ type, title, data, x_label, y_label, width, height }) → '<svg …>'
 *
 * `type`: bar | line | scatter | pie.
 *   bar, line, pie: data = [{ label, value }]
 *   scatter:        data = [{ x, y, label? }]
 * Throws on input it cannot draw truthfully (no data, a non-number, a negative pie slice, too many points).
 */

const SLOTS = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'];
const INK = { primary: '#0b0b0b', secondary: '#52514e', muted: '#898781', grid: '#e1e0d9', axis: '#c3c2b7', surface: '#fcfcfb' };
const FONT = 'system-ui, -apple-system, "Segoe UI", sans-serif';
const MAX_POINTS = 200;
const BAR_CAP = 24;
const BAR_RADIUS = 4;
const LINE_WIDTH = 2;
const DOT_R = 4;
const TYPES = ['bar', 'line', 'scatter', 'pie'];

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
const textWidth = (s, size) => String(s).length * size * 0.58;

function tidy(v) {
    const n = Math.round(v * 100) / 100;
    return String(Object.is(n, -0) ? 0 : n);
}

/** An axis tick: full under 10,000, compact above it. One style per axis. */
function tickLabel(v) {
    const a = Math.abs(v);
    if (a >= 1e9) return `${tidy(v / 1e9)}B`;
    if (a >= 1e6) return `${tidy(v / 1e6)}M`;
    if (a >= 1e4) return `${tidy(v / 1e3)}K`;
    return tidy(v);
}

function valueLabel(v) {
    const a = Math.abs(v);
    if (a >= 1e9) return `${tidy(v / 1e9)}B`;
    if (a >= 1e6) return `${tidy(v / 1e6)}M`;
    if (a >= 1e4) return `${tidy(v / 1e3)}K`;
    return tidy(v);
}

/** Clean tick values covering [lo, hi], with 1/2/2.5/5/10 steps. */
function niceTicks(lo, hi, target = 5) {
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [0, 1];
    if (hi <= lo) { const pad = Math.abs(lo) * 0.1 || 1; lo -= pad; hi += pad; }
    const span = hi - lo;
    const raw = span / Math.max(1, target);
    const mag = 10 ** Math.floor(Math.log10(raw));
    const norm = raw / mag;
    const step = (norm >= 5 ? 10 : norm >= 2.5 ? 5 : norm >= 2 ? 2.5 : norm >= 1 ? 2 : 1) * mag;
    const start = Math.floor(lo / step + 1e-9) * step;
    const end = Math.ceil(hi / step - 1e-9) * step;
    const out = [];
    for (let v = start; v <= end + step * 1e-9; v += step) out.push(Math.round(v * 1e6) / 1e6);
    return out.length ? out : [lo, hi];
}

/** The domain padded around a numeric series, then its ticks (a flat series gets a readable band). */
function domainOf(values, { zero = false, pad = 0.05 } = {}) {
    let lo = Math.min(...values);
    let hi = Math.max(...values);
    if (zero) { lo = Math.min(0, lo); hi = Math.max(0, hi); }
    if (hi === lo) { const p = Math.abs(lo) * 0.1 || 1; lo -= p; hi += p; }
    if (!zero && pad) { const p = (hi - lo) * pad; lo -= p; hi += p; }
    if (zero) { const ticks = niceTicks(lo, hi); return { min: Math.min(0, ticks[0]), max: Math.max(0, ticks[ticks.length - 1]), ticks }; }
    const ticks = niceTicks(lo, hi);
    return { min: ticks[0], max: ticks[ticks.length - 1], ticks };
}

function truncate(s, chars) {
    const t = String(s == null ? '' : s);
    if (chars <= 1) return '';
    return t.length > chars ? `${t.slice(0, Math.max(1, chars - 1))}…` : t;
}

function isLight(hex) {
    const h = String(hex || '').replace('#', '');
    if (h.length !== 6) return false;
    const c = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2] > 0.6;
}

function text(x, y, s, { size = 12, fill = INK.secondary, anchor = 'start', weight = 400, rotate = null } = {}) {
    const transform = rotate == null ? '' : ` transform="rotate(${rotate} ${tidy(x)} ${tidy(y)})"`;
    return `<text x="${tidy(x)}" y="${tidy(y)}" font-family='${FONT}' font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}"${transform}>${esc(s)}</text>`;
}

function line(x1, y1, x2, y2, stroke, width = 1) {
    return `<line x1="${tidy(x1)}" y1="${tidy(y1)}" x2="${tidy(x2)}" y2="${tidy(y2)}" stroke="${stroke}" stroke-width="${width}"/>`;
}

function gridAndYAxis(ticks, scaleY, plot, fmt = tickLabel) {
    const out = [];
    for (const t of ticks) {
        const y = scaleY(t);
        out.push(line(plot.x, y, plot.x + plot.w, y, INK.grid, 1));
        out.push(text(plot.x - 8, y + 4, fmt(t), { size: 11, fill: INK.muted, anchor: 'end' }));
    }
    // The baseline (zero, or the axis foot) is one step darker than the grid.
    out.push(line(plot.x, plot.y + plot.h, plot.x + plot.w, plot.y + plot.h, INK.axis, 1));
    return out.join('\n');
}

function xLabels(labels, centers, plot, { size = 12 } = {}) {
    if (!labels.length) return '';
    const band = centers.length > 1 ? centers[1] - centers[0] : plot.w;
    const every = Math.max(1, Math.ceil((size * 4.5) / Math.max(1, band)));
    const maxChars = Math.max(3, Math.floor(band / (size * 0.58)) * every);
    const out = [];
    labels.forEach((label, i) => {
        if (i % every) return;
        out.push(text(centers[i], plot.y + plot.h + 20, truncate(label, maxChars), { size, fill: INK.secondary, anchor: 'middle' }));
    });
    return out.join('\n');
}

function frame(plot, xLabel, yLabel, { axis = true } = {}) {
    const out = [];
    if (axis) out.push(line(plot.x, plot.y, plot.x, plot.y + plot.h, INK.axis, 1));
    if (xLabel) out.push(text(plot.x + plot.w / 2, plot.y + plot.h + 44, truncate(xLabel, 60), { size: 12, fill: INK.muted, anchor: 'middle' }));
    if (yLabel) out.push(text(16, plot.y + plot.h / 2, truncate(yLabel, 40), { size: 12, fill: INK.muted, anchor: 'middle', rotate: -90 }));
    return out.join('\n');
}

function normalizeSeries(data, type) {
    if (!Array.isArray(data) || !data.length) throw new Error('data must be a non-empty array');
    if (data.length > MAX_POINTS) throw new Error(`too many points (${data.length}); the limit is ${MAX_POINTS}`);
    if (type === 'scatter') {
        return data.map((d, i) => {
            const x = Number(d && d.x);
            const y = Number(d && d.y);
            if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error(`data[${i}] needs a numeric x and y`);
            return { x, y, label: d && d.label != null ? String(d.label) : null };
        });
    }
    return data.map((d, i) => {
        const value = Number(d && d.value);
        if (!Number.isFinite(value)) throw new Error(`data[${i}] needs a numeric value`);
        const label = d && (d.label != null ? d.label : d.name != null ? d.name : i + 1);
        return { label: String(label), value };
    });
}

function renderBar(series, spec) {
    const { x = 68, y = spec.title ? 52 : 28, w = 660, h = 350 } = spec.plot;
    const plot = { x, y, w, h };
    const values = series.map((d) => d.value);
    const { min, max, ticks } = domainOf(values, { zero: true });
    const span = max - min || 1;
    const sy = (v) => plot.y + plot.h - ((v - min) / span) * plot.h;
    const band = plot.w / series.length;
    const bw = Math.min(BAR_CAP, band * 0.72);
    const y0 = sy(0);
    const parts = [gridAndYAxis(ticks, sy, plot)];
    const centers = [];
    const every = Math.max(1, Math.ceil((12 * 4.5) / Math.max(1, band)));
    const maxChars = Math.max(3, Math.floor(band / (12 * 0.58)) * every);
    series.forEach((d, i) => {
        const cx = plot.x + band * (i + 0.5);
        centers.push(cx);
        const xb = cx - bw / 2;
        const yv = sy(d.value);
        if (d.value !== 0) {
            const up = d.value > 0;
            const r = Math.min(BAR_RADIUS, bw / 2, Math.abs(y0 - yv));
            const path = up
                ? `M${tidy(xb)},${tidy(y0)} L${tidy(xb)},${tidy(yv + r)} Q${tidy(xb)},${tidy(yv)} ${tidy(xb + r)},${tidy(yv)} L${tidy(xb + bw - r)},${tidy(yv)} Q${tidy(xb + bw)},${tidy(yv)} ${tidy(xb + bw)},${tidy(yv + r)} L${tidy(xb + bw)},${tidy(y0)} Z`
                : `M${tidy(xb)},${tidy(y0)} L${tidy(xb)},${tidy(yv - r)} Q${tidy(xb)},${tidy(yv)} ${tidy(xb + r)},${tidy(yv)} L${tidy(xb + bw - r)},${tidy(yv)} Q${tidy(xb + bw)},${tidy(yv)} ${tidy(xb + bw)},${tidy(yv - r)} L${tidy(xb + bw)},${tidy(y0)} Z`;
            parts.push(`<path d="${path}" fill="${SLOTS[0]}"><title>${esc(`${d.label}: ${valueLabel(d.value)}`)}</title></path>`);
        }
        if (series.length <= 12) {
            const outside = d.value >= 0 ? yv - 6 : yv + 14;
            const inside = d.value >= 0 ? yv + 15 : yv - 7;
            const useOutside = d.value >= 0 ? outside > plot.y + 10 : outside < plot.y + plot.h - 4;
            parts.push(text(cx, useOutside ? outside : inside, valueLabel(d.value), { size: 11, fill: useOutside ? INK.secondary : '#ffffff', anchor: 'middle' }));
        }
        if (i % every === 0) parts.push(text(cx, plot.y + plot.h + 20, truncate(d.label, maxChars), { size: 12, fill: INK.secondary, anchor: 'middle' }));
    });
    if (min < 0 && max > 0) parts.push(line(plot.x, y0, plot.x + plot.w, y0, INK.axis, 1));
    return `${parts.join('\n')}\n${frame(plot, spec.x_label, spec.y_label)}`;
}

function renderLine(series, spec) {
    const { x = 68, y = spec.title ? 52 : 28, w = 660, h = 350 } = spec.plot;
    const plot = { x, y, w, h };
    const { min, max, ticks } = domainOf(series.map((d) => d.value));
    const span = max - min || 1;
    const sy = (v) => plot.y + plot.h - ((v - min) / span) * plot.h;
    const band = plot.w / Math.max(1, series.length);
    const sx = (i) => plot.x + band * (i + (series.length === 1 ? 0.5 : 0.5));
    const points = series.map((d, i) => [sx(i), sy(d.value)]);
    const parts = [gridAndYAxis(ticks, sy, plot)];
    if (points.length > 1) {
        parts.push(`<polyline points="${points.map(([px, py]) => `${tidy(px)},${tidy(py)}`).join(' ')}" fill="none" stroke="${SLOTS[0]}" stroke-width="${LINE_WIDTH}" stroke-linejoin="round" stroke-linecap="round"/>`);
    }
    points.forEach(([px, py], i) => {
        parts.push(`<circle cx="${tidy(px)}" cy="${tidy(py)}" r="${DOT_R}" fill="${SLOTS[0]}" stroke="${INK.surface}" stroke-width="2"><title>${esc(`${series[i].label}: ${valueLabel(series[i].value)}`)}</title></circle>`);
    });
    const [ex, ey] = points[points.length - 1];
    const end = valueLabel(series[series.length - 1].value);
    const anchor = ex + 8 + textWidth(end, 12) < plot.x + plot.w ? 'start' : 'end';
    parts.push(text(ex + (anchor === 'start' ? 8 : -8), ey - 10, end, { size: 12, fill: INK.primary, weight: 600, anchor }));
    parts.push(xLabels(series.map((d) => d.label), points.map((p) => p[0]), plot));
    return `${parts.join('\n')}\n${frame(plot, spec.x_label, spec.y_label)}`;
}

function renderScatter(series, spec) {
    const { x = 68, y = spec.title ? 52 : 28, w = 660, h = 350 } = spec.plot;
    const plot = { x, y, w, h };
    const dx = domainOf(series.map((d) => d.x));
    const dy = domainOf(series.map((d) => d.y));
    const sx = (v) => plot.x + ((v - dx.min) / (dx.max - dx.min || 1)) * plot.w;
    const sy = (v) => plot.y + plot.h - ((v - dy.min) / (dy.max - dy.min || 1)) * plot.h;
    const parts = [gridAndYAxis(dy.ticks, sy, plot)];
    for (const t of dx.ticks) parts.push(text(sx(t), plot.y + plot.h + 20, tickLabel(t), { size: 11, fill: INK.muted, anchor: 'middle' }));
    series.forEach((d) => {
        parts.push(`<circle cx="${tidy(sx(d.x))}" cy="${tidy(sy(d.y))}" r="${DOT_R + 0.5}" fill="${SLOTS[0]}" stroke="${INK.surface}" stroke-width="2"><title>${esc(d.label ? `${d.label}: (${tidy(d.x)}, ${valueLabel(d.y)})` : `(${tidy(d.x)}, ${valueLabel(d.y)})`)}</title></circle>`);
    });
    // One direct label, the highest point, and only when it has a name: not a number on every dot.
    const top = series.reduce((best, d) => (best == null || d.y > best.y ? d : best), null);
    if (top && top.label) {
        const anchor = sx(top.x) + 12 + textWidth(top.label, 12) < plot.x + plot.w ? 'start' : 'end';
        parts.push(text(sx(top.x) + (anchor === 'start' ? 11 : -11), sy(top.y) - 10, top.label, { size: 12, fill: INK.primary, anchor }));
    }
    return `${parts.join('\n')}\n${frame(plot, spec.x_label, spec.y_label)}`;
}

function renderPie(series, spec) {
    const { x = 68, y = spec.title ? 52 : 28, w = 660, h = 350 } = spec.plot;
    const plot = { x, y, w, h };
    // Part-to-whole at a glance is honest up to six slices; the rest folds into one "Other" slice.
    let slices = series.filter((d) => d.value !== 0);
    if (slices.some((d) => d.value < 0)) throw new Error('a pie chart needs non-negative values');
    if (slices.length > 6) {
        const ranked = slices.map((d, i) => ({ d, i })).sort((a, b) => (b.d.value - a.d.value) || (a.i - b.i));
        const kept = ranked.slice(0, 5).map((r) => r.d);
        const other = ranked.slice(5).reduce((sum, r) => sum + r.d.value, 0);
        slices = [...kept, { label: 'Other', value: other }];
    }
    const total = slices.reduce((sum, d) => sum + d.value, 0);
    if (!(total > 0)) throw new Error('a pie chart needs at least one positive value');
    const legendW = Math.min(220, plot.w * 0.42);
    const pieW = plot.w - legendW - 16;
    const r = Math.max(20, Math.min(pieW, plot.h) / 2 - 10);
    const cx = plot.x + pieW / 2;
    const cy = plot.y + plot.h / 2;
    const parts = [];
    let angle = -Math.PI / 2;
    slices.forEach((d, i) => {
        const sweep = (d.value / total) * Math.PI * 2;
        const color = SLOTS[i % SLOTS.length];
        const x1 = cx + r * Math.cos(angle);
        const y1 = cy + r * Math.sin(angle);
        const x2 = cx + r * Math.cos(angle + sweep);
        const y2 = cy + r * Math.sin(angle + sweep);
        const large = sweep > Math.PI ? 1 : 0;
        if (sweep >= Math.PI * 2 - 1e-6) {
            parts.push(`<circle cx="${tidy(cx)}" cy="${tidy(cy)}" r="${tidy(r)}" fill="${color}" stroke="${INK.surface}" stroke-width="2"><title>${esc(`${d.label}: ${valueLabel(d.value)} (100%)`)}</title></circle>`);
        } else {
            parts.push(`<path d="M${tidy(cx)},${tidy(cy)} L${tidy(x1)},${tidy(y1)} A${tidy(r)},${tidy(r)} 0 ${large} 1 ${tidy(x2)},${tidy(y2)} Z" fill="${color}" stroke="${INK.surface}" stroke-width="2"><title>${esc(`${d.label}: ${valueLabel(d.value)} (${tidy((d.value / total) * 100)}%)`)}</title></path>`);
        }
        const pct = (d.value / total) * 100;
        if (pct >= 8) {
            const mid = angle + sweep / 2;
            const lx = cx + r * 0.62 * Math.cos(mid);
            const ly = cy + r * 0.62 * Math.sin(mid) + 4;
            parts.push(text(lx, ly, `${tidy(pct)}%`, { size: 12, fill: isLight(color) ? INK.primary : '#ffffff', anchor: 'middle', weight: 600 }));
        }
        angle += sweep;
    });
    const lx = plot.x + pieW + 16;
    const rowH = Math.min(24, plot.h / Math.max(1, slices.length));
    slices.forEach((d, i) => {
        const ly = plot.y + rowH * (i + 0.5);
        parts.push(`<rect x="${tidy(lx)}" y="${tidy(ly - 5)}" width="10" height="10" rx="2" fill="${SLOTS[i % SLOTS.length]}"/>`);
        parts.push(text(lx + 16, ly + 4, truncate(d.label, 18), { size: 12, fill: INK.primary }));
        parts.push(text(plot.x + plot.w, ly + 4, `${valueLabel(d.value)} · ${tidy((d.value / total) * 100)}%`, { size: 11, fill: INK.muted, anchor: 'end' }));
    });
    return `${parts.join('\n')}\n${frame(plot, spec.x_label, spec.y_label, { axis: false })}`;
}

function renderChart(spec = {}) {
    const type = String(spec.type || '').toLowerCase();
    if (!TYPES.includes(type)) throw new Error(`type must be one of ${TYPES.join(', ')}`);
    const width = clamp(Math.round(Number(spec.width) || 760), 480, 1200);
    const height = clamp(Math.round(Number(spec.height) || 460), 320, 900);
    const title = spec.title == null ? '' : String(spec.title).slice(0, 160);
    const plot = { x: 68, y: title ? 52 : 28, w: width - 68 - 24, h: height - (title ? 52 : 28) - 64 };
    const series = normalizeSeries(spec.data, type);
    const normalized = { plot, title, x_label: spec.x_label == null ? '' : String(spec.x_label).slice(0, 80), y_label: spec.y_label == null ? '' : String(spec.y_label).slice(0, 80) };
    const body = type === 'bar' ? renderBar(series, normalized)
        : type === 'line' ? renderLine(series, normalized)
            : type === 'scatter' ? renderScatter(series, normalized)
                : renderPie(series, normalized);
    const desc = `${title ? `“${title}”. ` : ''}A ${type} chart with ${series.length} ${type === 'scatter' ? 'points' : 'values'}.`;
    const heading = title ? text(24, 32, title, { size: 17, fill: INK.primary, weight: 600 }) : '';
    return [
        '<?xml version="1.0" encoding="UTF-8"?>',
        `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="chart-title chart-desc">`,
        `<title id="chart-title">${esc(title || `${type} chart`)}</title>`,
        `<desc id="chart-desc">${esc(desc)}</desc>`,
        `<rect width="${width}" height="${height}" fill="${INK.surface}"/>`,
        heading,
        body,
        '</svg>',
        '',
    ].filter((l) => l !== '').join('\n');
}

module.exports = { renderChart, niceTicks, tickLabel, SLOTS, INK, MAX_POINTS, TYPES };

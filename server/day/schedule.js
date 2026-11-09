'use strict';
function valid(s) {
    if (s == null) return true;
    if (!s || !Array.isArray(s.days) || !s.days.length || s.days.some(d => !Number.isInteger(d) || d < 0 || d > 6) || !Number.isInteger(s.start) || !Number.isInteger(s.end) || s.start < 0 || s.end > 24 || s.start >= s.end || typeof s.zone !== 'string') return false;
    try { new Intl.DateTimeFormat('en', { timeZone: s.zone }).format(); return true; } catch { return false; }
}
function open(s, ms) {
    if (!s) return true;
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: s.zone, weekday: 'short', hour: 'numeric', hourCycle: 'h23' }).formatToParts(new Date(ms)).map(p => [p.type, p.value]));
    return s.days.includes(['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday)) && Number(parts.hour) >= s.start && Number(parts.hour) < s.end;
}
module.exports = { valid, open };

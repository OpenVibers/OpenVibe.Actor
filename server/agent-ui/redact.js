'use strict';
const { TOKEN_PATTERNS, SECRET_KEY } = require('../runtime/checkpoints');
// Checkpoints bound text for model context; a transcript must retain the whole redacted output.
function clean(value) {
    if (typeof value === 'string') {
        let text = value;
        for (const re of TOKEN_PATTERNS) text = text.replace(re, '[redacted]');
        text = text.replace(/(https?:\/\/)[^@/\s]+@/g, '$1[redacted]@')
            .replace(/\b((?:api[_-]?key|access[_-]?token|secret|password|client[_-]?secret)["']?\s*[:=]\s*["']?)[^\s"']{8,}/gi, '$1[redacted]');
        if (/^[\s]*[\[{]/.test(text)) { try { return JSON.stringify(clean(JSON.parse(text))); } catch { /* prose */ } }
        return text;
    }
    if (Array.isArray(value)) return value.map(clean);
    if (value && typeof value === 'object') {
        if (value.secret === true || value.sensitive === true) return { redacted: true, note: '[redacted]' };
        return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, SECRET_KEY.test(k) && !(k === 'session_id' && /^ses_[0-9A-HJKMNP-TV-Z]{26}$/.test(String(v))) ? '[redacted]' : clean(v)]));
    }
    return value;
}
module.exports = { clean };

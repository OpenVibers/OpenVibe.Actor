'use strict';
/**
 * "Every weekday at 9, summarise my inbox" → a schedule and the task. "When a new issue lands in my
 * repo, triage it" → a Watch event source and the task. This is the deterministic part of
 * schedule_trigger: the same sentence always parses the same way, and anything it cannot pin down
 * comes back as a question instead of a trigger. The model may ask the person and call again with
 * the explicit fields (`cron`, `timezone`, `task`, `agent_id`, `event`).
 *
 * A missing timezone is the person's own zone when the caller knows it (`timezone`), never a guess;
 * a missing time is a question, not a default. The five-field cron is the machine form, and
 * `words` is the sentence the card shows.
 */
const cron = require('./cron');

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAY_INDEX = { sunday: 0, sun: 0, monday: 1, mon: 1, tuesday: 2, tue: 2, tues: 2, wednesday: 3, wed: 3, thursday: 4, thu: 4, thur: 4, thurs: 4, friday: 5, fri: 5, saturday: 6, sat: 6 };
const ZONE_CITIES = {
    berlin: 'Europe/Berlin', london: 'Europe/London', paris: 'Europe/Paris', madrid: 'Europe/Madrid', rome: 'Europe/Rome',
    amsterdam: 'Europe/Amsterdam', brussels: 'Europe/Brussels', vienna: 'Europe/Vienna', zurich: 'Europe/Zurich',
    stockholm: 'Europe/Stockholm', oslo: 'Europe/Oslo', copenhagen: 'Europe/Copenhagen', helsinki: 'Europe/Helsinki',
    warsaw: 'Europe/Warsaw', prague: 'Europe/Prague', lisbon: 'Europe/Lisbon', dublin: 'Europe/Dublin', athens: 'Europe/Athens',
    moscow: 'Europe/Moscow', istanbul: 'Europe/Istanbul', dubai: 'Asia/Dubai', mumbai: 'Asia/Kolkata', delhi: 'Asia/Kolkata',
    singapore: 'Asia/Singapore', tokyo: 'Asia/Tokyo', seoul: 'Asia/Seoul', shanghai: 'Asia/Shanghai', beijing: 'Asia/Shanghai',
    hongkong: 'Asia/Hong_Kong', sydney: 'Australia/Sydney', melbourne: 'Australia/Melbourne', auckland: 'Pacific/Auckland',
    'new york': 'America/New_York', nyc: 'America/New_York', boston: 'America/New_York', washington: 'America/New_York',
    chicago: 'America/Chicago', denver: 'America/Denver', 'los angeles': 'America/Los_Angeles', 'san francisco': 'America/Los_Angeles',
    seattle: 'America/Los_Angeles', toronto: 'America/Toronto', vancouver: 'America/Vancouver', mexico: 'America/Mexico_City',
    'sao paulo': 'America/Sao_Paulo', 'buenos aires': 'America/Argentina/Buenos_Aires', honolulu: 'Pacific/Honolulu',
    utc: 'UTC', gmt: 'UTC',
};
const DAYPART = { morning: [9, 0], afternoon: [14, 0], evening: [19, 0], night: [21, 0] };
const AMBIGUOUS = /\b(sometimes|occasionally|every so often|from time to time|regularly|whenever i|when i ask|at some point|soon|sometime)\b/i;
const TIME = String.raw`(\d{1,2})(?::(\d{2}))?\s*(am|pm)?`;
const WEEKDAY = String.raw`(weekday|weekdays|day|every day|morning|afternoon|evening|night|weekend|weekends|sun(?:day)?|mon(?:day)?|tue(?:sday|s)?|wed(?:nesday)?|thu(?:rsday|rs)?|fri(?:day)?|sat(?:urday)?)`;

const pad = (n) => String(n).padStart(2, '0');
const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();

/** A wall-clock hour/minute as cron's two fields. 12am is 0, 12pm is 12. */
function clock(hourText, minuteText, ampm) {
    let hour = Number(hourText);
    const minute = minuteText == null ? 0 : Number(minuteText);
    if (!Number.isInteger(hour) || hour > 23 || !Number.isInteger(minute) || minute > 59) return null;
    if (ampm) {
        if (hour < 1 || hour > 12) return null;
        hour = hour % 12 + (ampm.toLowerCase() === 'pm' ? 12 : 0);
    }
    return { hour, minute };
}

function zoneFromText(text) {
    const source = String(text || '');
    const explicit = source.match(/\b([A-Z][A-Za-z_+-]+(?:\/[A-Z][A-Za-z_+-]+)+)\b/);
    if (explicit && cron.isZone(explicit[1])) return explicit[1];
    const inCity = source.match(/\bin\s+([A-Za-z][A-Za-z ]{1,30}?)(?:\s+time)?\b/i) || source.match(/\b([A-Za-z ]{2,30})\s+time\b/i);
    if (inCity) {
        const key = inCity[1].trim().toLowerCase();
        if (ZONE_CITIES[key]) return ZONE_CITIES[key];
    }
    const lower = source.toLowerCase();
    for (const [city, zone] of Object.entries(ZONE_CITIES)) {
        if (new RegExp(`\\b${city.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(lower)) return zone;
    }
    return null;
}

function wordsFor(cronExpr, timezone) {
    try {
        const rule = cron.parse(cronExpr);
        const minutes = [...rule.minutes].sort((a, b) => a - b);
        const hours = [...rule.hours].sort((a, b) => a - b);
        const one = (set) => set.size === 1;
        if (one(rule.minutes) && one(rule.hours) && rule.days.size === 1 && rule.months.size === 1 && rule.weekdays.size === 1 && rule.dayAny === false && rule.weekdayAny === false) {
            return `On day ${[...rule.days][0]} of month ${[...rule.months][0]} at ${pad([...hours][0])}:${pad([...minutes][0])} (${timezone})`;
        }
        if (one(rule.minutes) && one(rule.hours) && rule.months.size === 12) {
            const time = `${pad([...hours][0])}:${pad([...minutes][0])}`;
            if (rule.weekdayAny && rule.dayAny) return `Every day at ${time} (${timezone})`;
            if (rule.dayAny && !rule.weekdayAny) {
                const days = [...rule.weekdays].sort((a, b) => a - b);
                if (days.join(',') === '1,2,3,4,5') return `Every weekday at ${time} (${timezone})`;
                if (days.join(',') === '0,6') return `Every weekend at ${time} (${timezone})`;
                if (days.length === 1) return `Every ${DAY_NAMES[days[0]]} at ${time} (${timezone})`;
                return `Every ${days.map((d) => DAY_NAMES[d]).join(', ')} at ${time} (${timezone})`;
            }
        }
        // Every day, all year: steps through the hour or the day, said the way a person says them.
        if (rule.months.size === 12 && rule.dayAny && rule.weekdayAny) {
            if (hours.length === 24) {
                if (minutes.length === 1) return minutes[0] === 0 ? `Every hour (${timezone})` : `Every hour at :${pad(minutes[0])} (${timezone})`;
                const step = minutes[1] - minutes[0];
                if (minutes[0] === 0 && step > 0 && 60 % step === 0 && minutes.length === 60 / step && minutes.every((m, i) => m === i * step)) return `Every ${step} minutes (${timezone})`;
            } else if (minutes.length === 1 && hours.length > 1) {
                const times = hours.map((h) => `${pad(h)}:${pad(minutes[0])}`);
                if (hours.length <= 3) return `Every day at ${times.slice(0, -1).join(', ')} and ${times[times.length - 1]} (${timezone})`;
                const step = hours[1] - hours[0];
                const at = minutes[0] ? ` at :${pad(minutes[0])}` : '';
                if (step > 0 && 24 % step === 0 && hours.length === 24 / step && hours.every((h, i) => h === hours[0] + i * step)) return `Every ${step} hours${at} (${timezone})`;
            }
        }
        // Once a year, on one date.
        if (one(rule.minutes) && one(rule.hours) && rule.months.size === 1 && !rule.dayAny && rule.weekdayAny && rule.days.size === 1) {
            const month = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][[...rule.months][0] - 1];
            if (month) return `Every year on ${[...rule.days][0]} ${month} at ${pad(hours[0])}:${pad(minutes[0])} (${timezone})`;
        }
        // Once a month, on one day of it.
        if (one(rule.minutes) && one(rule.hours) && rule.months.size === 12 && !rule.dayAny && rule.weekdayAny && rule.days.size === 1) {
            const d = [...rule.days][0];
            const nth = (d % 100 >= 11 && d % 100 <= 13) ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[d % 10] || 'th');
            return `Every month on the ${d}${nth} at ${pad(hours[0])}:${pad(minutes[0])} (${timezone})`;
        }
    } catch { /* fall through */ }
    return `On a custom schedule, ${cronExpr} (${timezone})`;
}

/** The schedule phrase and its cron, or null. Longest match wins so "every weekday at 9" beats "every day". */
function scheduleIn(text) {
    const source = clean(text);
    const lower = source.toLowerCase();
    const patterns = [];

    // every weekday at 9 / every weekday at 9:30 pm
    patterns.push({ re: new RegExp(String.raw`\bevery\s+(weekdays?|weekends?)\s+at\s+${TIME}\b`, 'i'), build: (m) => {
        const c = clock(m[2], m[3], m[4]); if (!c) return null;
        return { cron: `${c.minute} ${c.hour} * * ${/weekend/i.test(m[1]) ? '0,6' : '1-5'}` };
    } });
    // every Monday at 10 / every Sunday evening
    patterns.push({ re: new RegExp(String.raw`\bevery\s+(${Object.keys(DAY_INDEX).join('|')})\b(?:\s+(?:at\s+${TIME}|(morning|afternoon|evening|night)))?`, 'i'), build: (m) => {
        let c = m[2] != null ? clock(m[2], m[3], m[4]) : (m[5] ? { hour: DAYPART[m[5].toLowerCase()][0], minute: 0 } : null);
        if (!c) return null;
        return { cron: `${c.minute} ${c.hour} * * ${DAY_INDEX[m[1].toLowerCase()]}` };
    } });
    // every day at 8 / daily at 8 / every morning
    patterns.push({ re: new RegExp(String.raw`\b(?:every\s+day|daily)\s+at\s+${TIME}\b`, 'i'), build: (m) => {
        const c = clock(m[1], m[2], m[3]); if (!c) return null;
        return { cron: `${c.minute} ${c.hour} * * *` };
    } });
    patterns.push({ re: new RegExp(String.raw`\bevery\s+(morning|afternoon|evening|night)\b`, 'i'), build: (m) => {
        const [hour, minute] = DAYPART[m[1].toLowerCase()];
        return { cron: `${minute} ${hour} * * *` };
    } });
    // every 15 minutes / every 2 hours / every hour
    patterns.push({ re: /\bevery\s+(\d{1,3})\s*(minutes?|mins?|hours?|hrs?)\b/i, build: (m) => {
        const n = Number(m[1]);
        if (/^h/i.test(m[2])) return { cron: `0 */${n} * * *` };
        return { cron: `*/${n} * * * *` };
    } });
    patterns.push({ re: /\bevery\s+hour\b/i, build: () => ({ cron: '0 * * * *' }) });
    // weekdays at 9 (without "every")
    patterns.push({ re: new RegExp(String.raw`\b(weekdays?)\s+at\s+${TIME}\b`, 'i'), build: (m) => {
        const c = clock(m[2], m[3], m[4]); if (!c) return null;
        return { cron: `${c.minute} ${c.hour} * * 1-5` };
    } });

    let best = null;
    for (const p of patterns) {
        const m = lower.match(p.re);
        if (!m) continue;
        const built = p.build(m);
        if (!built) continue;
        if (!best || m[0].length > best.matchLength) best = { ...built, matchStart: m.index, matchLength: m[0].length, phrase: source.slice(m.index, m.index + m[0].length) };
    }
    return best;
}

/** A Watch event source from "when …", or null. */
function eventIn(text) {
    const source = clean(text);
    const m = source.match(/\bwhen\s+(.+?)(?:,|$)/i);
    if (!m) return null;
    const what = m[1].trim();
    const lower = what.toLowerCase();
    let pattern = null;
    let words = what;
    if (/\b(issue|ticket)\b/.test(lower)) pattern = 'github.issue.opened';
    else if (/\b(pull request|merge request|pr)\b/.test(lower)) pattern = 'github.pull_request.opened';
    else if (/\b(comment|reply)\b/.test(lower)) pattern = 'github.comment.created';
    else if (/\b(goes live|went live|stream|broadcast)\b/.test(lower)) pattern = 'live.stream.started';
    else if (/\b(blog|article|post)\b/.test(lower) && /\b(new|publish|posted)\b/.test(lower)) pattern = 'blog.post.published';
    else if (/\b(wiki|page)\b/.test(lower) && /\b(publish|published|new)\b/.test(lower)) pattern = 'wiki.page.published';
    else if (/\b(release|deploy)\b/.test(lower)) pattern = 'host.release.published';
    else if (/\b(email|mail|message)\b/.test(lower)) pattern = 'mail.message.received';
    else if (/\b(source|feed)\b/.test(lower)) pattern = 'sources.item.created';
    if (!pattern) return { ambiguous: true, what, reason: 'I can watch a new issue or pull request, a blog post, a wiki page, a live stream, a release, mail or a source, but I could not tell which of those this is.' };
    const repo = what.match(/\b([a-z0-9_.-]+\/[a-z0-9_.-]+)\b/i);
    const filter = repo ? { repo: repo[1] } : null;
    // Drop the trailing location ("in my repo") from the sentence the card shows.
    words = what.replace(/\s+in\s+my\s+repo(?:sitory)?\b/i, '').replace(/\s+in\s+.+$/i, '').trim() || what;
    return { pattern, filter, words: `When ${words}`, matchStart: m.index, matchLength: m[0].length, phrase: m[0] };
}

/** The task after (or before) the matched clause, with the clause taken out. */
function taskIn(text, match) {
    const source = clean(text);
    if (!match) return '';
    const before = clean(source.slice(0, match.matchStart).replace(/[,;:.\s]+$/, ''));
    const after = clean(source.slice(match.matchStart + match.matchLength).replace(/^[,;:.\s]+/, ''));
    const pick = after || before;
    return pick.replace(/^(?:then|and|please|to)\s+/i, '').trim();
}

/**
 * The person's sentence → { status: 'ok', kind, cron/timezone or event, task, words } or
 * { status: 'ask', question }. `timezone` is the person's zone when the caller knows it.
 */
function parseRequest(text, { timezone: knownZone = null, task: givenTask = null } = {}) {
    const source = clean(text);
    if (!source) return { status: 'ask', question: 'What should run, and when?' };
    if (AMBIGUOUS.test(source)) {
        return { status: 'ask', question: 'How often should this run, exactly? For example: every weekday at 9, or every hour.' };
    }
    const schedule = scheduleIn(source);
    const event = eventIn(source);
    if (schedule && event) {
        return { status: 'ask', question: 'Should this run on a schedule or when an OpenVibe event arrives? You said both.' };
    }
    if (event && event.ambiguous) {
        return { status: 'ask', question: `${event.reason} What exactly should wake it?` };
    }
    if (!schedule && !event) {
        if (/\bevery\b|\bdaily\b|\bweekly\b|\bwhen\b/i.test(source)) {
            return { status: 'ask', question: 'When exactly should this run? For example: every weekday at 9 in your timezone, or when a new issue lands in your repo.' };
        }
        return { status: 'ask', question: 'Should this run on a schedule (every weekday at 9) or when something happens (a new issue, a blog post, a release)?' };
    }
    const task = clean(givenTask || taskIn(source, schedule || event)).slice(0, 8000);
    if (!task) return { status: 'ask', question: 'What should I do each time this runs?' };
    if (/\b(at\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\b.*\bor\b.*\bat\s+\d{1,2}/i.test(source)) {
        return { status: 'ask', question: 'Which of those times should it run? Give me one time and the timezone.' };
    }
    if (schedule) {
        const zone = knownZone || zoneFromText(source);
        if (!zone) return { status: 'ask', question: `Every ${schedule.phrase.replace(/^every\s+/i, '')} in which timezone?` };
        const verdict = cron.validate(schedule.cron, zone);
        if (!verdict.valid) return { status: 'ask', question: `That schedule cannot run: ${verdict.error}. What time should it run?` };
        return {
            status: 'ok', kind: 'schedule', cron: schedule.cron, timezone: zone, task,
            words: wordsFor(schedule.cron, zone),
        };
    }
    return {
        status: 'ok', kind: 'event', task,
        event: { pattern: event.pattern, filter: event.filter },
        words: event.words,
    };
}

module.exports = { parseRequest, scheduleIn, eventIn, zoneFromText, wordsFor, AMBIGUOUS };

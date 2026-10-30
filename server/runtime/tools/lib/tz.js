'use strict';
/**
 * IANA time zones through Node's own Intl: no network, no table of ours, and daylight saving
 * handled by the platform (a zone's offset depends on the date, so every offset here is read for
 * the instant it belongs to).
 */

const PARTS = { timeZone: 'UTC', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' };

/** True when Node knows the zone. */
function isZone(zone) {
    if (typeof zone !== 'string' || !zone.trim()) return false;
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: zone.trim() });
        return true;
    } catch {
        return false;
    }
}

/** The wall-clock parts of an instant in a zone. */
function partsInZone(date, zone) {
    const out = {};
    for (const part of new Intl.DateTimeFormat('en-US', { ...PARTS, timeZone: zone }).formatToParts(date)) {
        if (part.type !== 'literal') out[part.type] = part.value;
    }
    return {
        year: Number(out.year),
        month: Number(out.month),
        day: Number(out.day),
        hour: Number(out.hour) % 24,
        minute: Number(out.minute),
        second: Number(out.second),
    };
}

/** The zone's offset from UTC at an instant, in milliseconds. */
function offsetMs(date, zone) {
    const p = partsInZone(date, zone);
    const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** The offset in minutes, with the sign a person expects (+120 for UTC+2). */
function offsetMinutes(date, zone) {
    return Math.round(offsetMs(date, zone) / 60000);
}

/** "UTC+02:00" (or "UTC" for no offset). */
function offsetLabel(date, zone) {
    const mins = offsetMinutes(date, zone);
    if (mins === 0) return 'UTC';
    const sign = mins < 0 ? '-' : '+';
    const abs = Math.abs(mins);
    return 'UTC' + sign + String(Math.floor(abs / 60)).padStart(2, '0') + ':' + String(abs % 60).padStart(2, '0');
}

/** The zone's short name at an instant ("CET", "PDT", "GMT+1"). */
function zoneAbbreviation(date, zone) {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'short' }).formatToParts(date);
    const found = parts.find((p) => p.type === 'timeZoneName');
    return found ? found.value : '';
}

/** The wall-clock time in a zone as "YYYY-MM-DD HH:MM:SS". */
function formatInZone(date, zone) {
    const p = partsInZone(date, zone);
    const pad = (n) => String(n).padStart(2, '0');
    return p.year + '-' + pad(p.month) + '-' + pad(p.day) + ' ' + pad(p.hour) + ':' + pad(p.minute) + ':' + pad(p.second);
}

/** The wall-clock time in a zone without the seconds: "2026-10-30 14:36". */
function formatInZoneShort(date, zone) {
    return formatInZone(date, zone).slice(0, 16);
}

/** The UTC instant of a wall-clock time in a zone (two passes settle the offset, DST included). */
function zonedToUtc({ year, month, day, hour = 0, minute = 0, second = 0 }, zone) {
    const wall = Date.UTC(year, month - 1, day, hour, minute, second);
    let ts = wall - offsetMs(new Date(wall), zone);
    ts = wall - offsetMs(new Date(ts), zone);
    return new Date(ts);
}

/**
 * Every offset change of a zone in a year: when the clocks go forward or back, and by how much.
 * Read from the platform day by day, so a zone that does not use daylight saving simply has none.
 */
function yearTransitions(year, zone) {
    const out = [];
    let previous = offsetMs(new Date(Date.UTC(year, 0, 1)), zone);
    for (let day = 1; day < 366; day += 1) {
        const at = Date.UTC(year, 0, 1) + day * 86400000;
        const d = new Date(at);
        if (d.getUTCFullYear() !== year) break;
        const now = offsetMs(d, zone);
        if (now !== previous) {
            out.push({ at: new Date(at), before: previous, after: now });
            previous = now;
        }
    }
    return out;
}

/** Whether daylight saving is in force right now, and when it next changes. */
function daylightSaving(now, zone) {
    const year = now.getUTCFullYear();
    const transitions = yearTransitions(year, zone);
    const current = offsetMs(now, zone);
    const standard = transitions.length ? Math.min(...transitions.map((t) => Math.min(t.before, t.after))) : current;
    const next = transitions.find((t) => t.at.getTime() > now.getTime()) || null;
    const last = [...transitions].reverse().find((t) => t.at.getTime() <= now.getTime()) || null;
    return {
        inEffect: current !== standard,
        standardOffsetMs: standard,
        currentOffsetMs: current,
        transitions,
        next,
        last,
    };
}

/** The difference between two zones right now, in minutes (the second minus the first). */
function differenceMinutes(now, fromZone, toZone) {
    return offsetMinutes(now, toZone) - offsetMinutes(now, fromZone);
}

/** "6 hours ahead", "30 minutes behind", "the same time". */
function describeDifference(minutes) {
    if (minutes === 0) return 'the same time';
    const abs = Math.abs(minutes);
    const hours = Math.floor(abs / 60);
    const mins = abs % 60;
    const span = [
        hours ? hours + (hours === 1 ? ' hour' : ' hours') : null,
        mins ? mins + (mins === 1 ? ' minute' : ' minutes') : null,
    ].filter(Boolean).join(' ');
    return span + (minutes > 0 ? ' ahead' : ' behind');
}

module.exports = {
    isZone,
    partsInZone,
    offsetMs,
    offsetMinutes,
    offsetLabel,
    zoneAbbreviation,
    formatInZone,
    formatInZoneShort,
    zonedToUtc,
    yearTransitions,
    daylightSaving,
    differenceMinutes,
    describeDifference,
};

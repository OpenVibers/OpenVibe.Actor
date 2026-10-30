'use strict';
/**
 * time_in: the time in a place, right now, with the daylight saving rules of that place.
 *
 * Everything comes from Node's own IANA time zone database through Intl, so no network call is
 * made and the offset that comes back is the one in force on that date - a zone that shifts its
 * clocks twice a year gets the right offset in summer and in winter.
 */
const { ToolError, source, fail } = require('./lib/util');
const tz = require('./lib/tz');

/** The cities a person is most likely to ask about, so "New York" works as well as the zone name. */
const CITIES = {
    'new york': 'America/New_York', 'los angeles': 'America/Los_angeles', 'san francisco': 'America/Los_angeles',
    'chicago': 'America/Chicago', 'denver': 'America/Denver', 'toronto': 'America/Toronto', 'vancouver': 'America/Vancouver',
    'mexico city': 'America/Mexico_City', 'sao paulo': 'America/Sao_Paulo', 'buenos aires': 'America/Argentina/Buenos_Aires',
    'london': 'Europe/London', 'dublin': 'Europe/Dublin', 'lisbon': 'Europe/Lisbon', 'madrid': 'Europe/Madrid',
    'barcelona': 'Europe/Madrid', 'paris': 'Europe/Paris', 'brussels': 'Europe/Brussels', 'amsterdam': 'Europe/Amsterdam',
    'berlin': 'Europe/Berlin', 'munich': 'Europe/Berlin', 'vienna': 'Europe/Vienna', 'zurich': 'Europe/Zurich',
    'milan': 'Europe/Rome', 'rome': 'Europe/Rome', 'copenhagen': 'Europe/Copenhagen', 'stockholm': 'Europe/Stockholm',
    'oslo': 'Europe/Oslo', 'helsinki': 'Europe/Helsinki', 'warsaw': 'Europe/Warsaw', 'prague': 'Europe/Prague',
    'athens': 'Europe/Athens', 'istanbul': 'Europe/Istanbul', 'moscow': 'Europe/Moscow', 'kyiv': 'Europe/Kyiv',
    'jerusalem': 'Asia/Jerusalem', 'dubai': 'Asia/Dubai', 'mumbai': 'Asia/Kolkata', 'delhi': 'Asia/Kolkata',
    'bangalore': 'Asia/Kolkata', 'singapore': 'Asia/Singapore', 'bangkok': 'Asia/Bangkok', 'jakarta': 'Asia/Jakarta',
    'hong kong': 'Asia/Hong_Kong', 'shanghai': 'Asia/Shanghai', 'beijing': 'Asia/Shanghai', 'taipei': 'Asia/Taipei',
    'seoul': 'Asia/Seoul', 'tokyo': 'Asia/Tokyo', 'osaka': 'Asia/Tokyo', 'perth': 'Australia/Perth',
    'sydney': 'Australia/Sydney', 'melbourne': 'Australia/Melbourne', 'brisbane': 'Australia/Brisbane',
    'auckland': 'Pacific/Auckland', 'honolulu': 'Pacific/Honolulu',
    'utc': 'UTC', 'gmt': 'UTC',
};

/** The zone behind a name: an IANA zone as it is, or one of the cities above. */
function resolveZone(name) {
    const wanted = String(name || '').trim();
    if (!wanted) return null;
    if (tz.isZone(wanted)) return wanted;
    const key = wanted.toLowerCase();
    if (CITIES[key]) return CITIES[key];
    return null;
}

module.exports = {
    name: 'time_in',
    description: 'The local time in a place right now, with its UTC offset, its time zone abbreviation and whether '
        + 'daylight saving is in force (and when it next changes). Give an IANA zone ("Europe/Berlin", "America/New_York") '
        + 'or a city name ("Tokyo", "Sao Paulo"). No network call: the answer comes from the platform time zone database.',
    input: {
        type: 'object',
        properties: {
            zone: { type: 'string', description: 'The place to give the time for: an IANA zone ("Europe/Berlin") or a city ("Tokyo").' },
        },
        required: ['zone'],
    },
    scope: 'public',
    costUsd: 0,
    timeoutMs: 5000,
    sources: [source('https://www.iana.org/time-zones', 'IANA: the time zone database')],

    async run(input = {}, ctx = {}) {
        const wanted = String(input.zone || '').trim();
        if (!wanted) return fail('time_in needs a place, for example "Europe/Berlin" or "Tokyo".');
        const zone = resolveZone(wanted);
        if (!zone) {
            return fail('"' + wanted + '" is not a time zone this tool knows. Give an IANA zone ("Europe/Berlin", "America/New_York") or a city ("Tokyo", "Sao Paulo").');
        }
        try {
            const now = new Date();
            const dst = tz.daylightSaving(now, zone);
            const offset = tz.offsetLabel(now, zone);
            const abbreviation = tz.zoneAbbreviation(now, zone);
            const local = tz.formatInZone(now, zone);
            const lines = [
                zone + ' is ' + local + ' (' + (abbreviation || 'local time') + ', ' + offset + ').',
                'It is ' + (dst.inEffect ? 'daylight saving time' : 'standard time') + ' there'
                    + (dst.next ? '; the clocks change on ' + dst.next.at.toISOString().slice(0, 10) + ' (to ' + tz.offsetLabel(dst.next.at, zone) + ')' : '') + '.',
                'That is ' + local.slice(11) + ' in UTC (' + now.toISOString() + ').',
            ];
            return {
                text: lines.join(' '),
                data: {
                    zone,
                    zone_name: zone.split('/').pop().replace(/_/g, ' '),
                    local_time: local,
                    utc_offset: offset,
                    utc_offset_minutes: tz.offsetMinutes(now, zone),
                    abbreviation,
                    dst: dst.inEffect,
                    dst_next_transition: dst.next
                        ? {
                            date: dst.next.at.toISOString().slice(0, 10),
                            offset_before: tz.offsetLabel(dst.next.at, zone),
                            offset_after: tz.offsetLabel(new Date(dst.next.at.getTime() + 86400000), zone),
                        }
                        : null,
                    utc_time: now.toISOString(),
                    fetched_at: now.toISOString(),
                },
                sources: [source('https://www.iana.org/time-zones', 'IANA: the time zone database')],
                artifacts: [],
            };
        } catch (err) {
            return fail((err && err.message) || 'the time could not be read');
        }
    },
};

module.exports.CITIES = CITIES;
module.exports.resolveZone = resolveZone;

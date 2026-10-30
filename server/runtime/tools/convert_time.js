'use strict';
/**
 * convert_time: one moment, seen from two places.
 *
 * Everything comes from Node's own IANA time zone database through Intl: no network call, and the
 * offsets are the ones in force on that date, so a conversion across a daylight saving change is
 * right. A wall-clock time without a zone is read in the "from" zone; a time with an offset (or
 * with Z) is that absolute moment.
 */
const { ToolError, source, fail } = require('./lib/util');
const tz = require('./lib/tz');
const timeIn = require('./time_in');

/** "now", "2026-10-30", "2026-10-30 14:00", "2026-10-30T14:00:00Z" and "2026-10-30T14:00+02:00". */
function parseMoment(input, fromZone) {
    const text = String(input || '').trim();
    if (!text || text.toLowerCase() === 'now') return { date: new Date(), given: 'now' };
    const hasZone = /(Z|[+-]\d{2}:?\d{2})$/i.test(text);
    const wall = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(text);
    if (wall) {
        const date = tz.zonedToUtc({
            year: Number(wall[1]),
            month: Number(wall[2]),
            day: Number(wall[3]),
            hour: Number(wall[4] || 0),
            minute: Number(wall[5] || 0),
            second: Number(wall[6] || 0),
        }, fromZone);
        return { date, given: text };
    }
    const parsed = new Date(text);
    if (Number.isNaN(parsed.getTime())) {
        throw new ToolError('"' + text + '" is not a date this tool can read. Use "now", "2026-10-30 14:00" or "2026-10-30T14:00:00Z".');
    }
    return { date: parsed, given: hasZone ? text : text };
}

module.exports = {
    name: 'convert_time',
    description: 'Convert one moment between two places, with each place\'s offset and daylight saving. Give the zone '
        + 'to convert to and, if the time is a wall-clock time, the zone it is written in. Works out of the platform '
        + 'time zone database, with no network call.',
    input: {
        type: 'object',
        properties: {
            to: { type: 'string', description: 'The place to convert to: an IANA zone ("Europe/Berlin") or a city ("Tokyo").' },
            from: { type: 'string', description: 'The place the time is written in. Defaults to UTC.' },
            datetime: { type: 'string', description: 'The moment to convert: "now" (the default), "2026-10-30 14:00" or "2026-10-30T14:00:00Z".' },
        },
        required: ['to'],
    },
    scope: 'public',
    costUsd: 0,
    timeoutMs: 5000,
    sources: [source('https://www.iana.org/time-zones', 'IANA: the time zone database')],

    async run(input = {}, ctx = {}) {
        const toName = String(input.to || '').trim();
        const fromName = String(input.from || 'UTC').trim() || 'UTC';
        if (!toName) return fail('convert_time needs the place to convert to, for example "Europe/Berlin".');
        const toZone = timeIn.resolveZone(toName);
        const fromZone = timeIn.resolveZone(fromName);
        if (!toZone) return fail('"' + toName + '" is not a time zone this tool knows. Give an IANA zone ("Europe/Berlin") or a city ("Tokyo").');
        if (!fromZone) return fail('"' + fromName + '" is not a time zone this tool knows. Give an IANA zone ("America/New_York") or a city ("New York").');

        try {
            const moment = parseMoment(input.datetime, fromZone);
            const date = moment.date;
            const difference = tz.differenceMinutes(date, fromZone, toZone);
            const fromDst = tz.daylightSaving(date, fromZone);
            const toDst = tz.daylightSaving(date, toZone);
            const lines = [
                tz.formatInZone(date, fromZone) + ' in ' + fromZone + ' is ' + tz.formatInZone(date, toZone) + ' in ' + toZone + '.',
                toZone + ' is ' + tz.describeDifference(difference) + ' ' + fromZone
                    + ' (' + tz.offsetLabel(date, toZone) + ' against ' + tz.offsetLabel(date, fromZone) + ').',
                'The same moment in UTC is ' + date.toISOString() + '.',
            ];
            return {
                text: lines.join(' '),
                data: {
                    given: moment.given,
                    from: {
                        zone: fromZone,
                        local_time: tz.formatInZone(date, fromZone),
                        utc_offset: tz.offsetLabel(date, fromZone),
                        utc_offset_minutes: tz.offsetMinutes(date, fromZone),
                        abbreviation: tz.zoneAbbreviation(date, fromZone),
                        dst: fromDst.inEffect,
                    },
                    to: {
                        zone: toZone,
                        local_time: tz.formatInZone(date, toZone),
                        utc_offset: tz.offsetLabel(date, toZone),
                        utc_offset_minutes: tz.offsetMinutes(date, toZone),
                        abbreviation: tz.zoneAbbreviation(date, toZone),
                        dst: toDst.inEffect,
                    },
                    utc_time: date.toISOString(),
                    difference_minutes: difference,
                    difference: tz.describeDifference(difference),
                },
                sources: [source('https://www.iana.org/time-zones', 'IANA: the time zone database')],
                artifacts: [],
            };
        } catch (err) {
            return fail((err && err.message) || 'the time could not be converted');
        }
    },
};

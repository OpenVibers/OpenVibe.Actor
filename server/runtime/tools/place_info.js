'use strict';
/**
 * place_info: what a place is, in a sentence a person can use.
 *
 * Source: OpenStreetMap's Nominatim (https://nominatim.org) for the name, the kind of place and
 * the address, and Open-Meteo's geocoding for the time zone, the population and the elevation.
 * Nominatim's usage policy is kept in lib/nominatim.js: a real User-Agent, one call a second, and
 * an hour of caching.
 */
const { Cache, ToolError, memo, requestJson, round, source, fail } = require('./lib/util');
const nominatim = require('./lib/nominatim');

const GEOCODE = 'https://geocoding-api.open-meteo.com/v1/search';
const TTL_MS = 60 * 60 * 1000;
const CACHE = new Cache();

/** The name, the kind of place and the address, from OpenStreetMap. */
async function osm(ctx, place, signal) {
    const hits = await nominatim.search(ctx, place, { limit: 1, signal });
    const hit = hits[0];
    if (!hit) throw new ToolError('no place called "' + place + '" was found', 'tool.not_found');
    return hit;
}

/** The time zone, the population and the elevation, from Open-Meteo (best effort). */
async function extras(ctx, place, signal) {
    try {
        const url = GEOCODE + '?name=' + encodeURIComponent(place) + '&count=1&language=en&format=json';
        const { data } = await requestJson(ctx, url, { signal, label: 'Open-Meteo geocoding' });
        const hit = data && Array.isArray(data.results) ? data.results[0] : null;
        if (!hit) return null;
        return {
            timezone: hit.timezone || null,
            population: hit.population || null,
            elevation_m: hit.elevation == null ? null : round(hit.elevation),
            region: hit.admin1 || null,
            country: hit.country || null,
            country_code: hit.country_code || null,
        };
    } catch {
        return null;
    }
}

module.exports = {
    name: 'place_info',
    description: 'Describe a place: its name, the kind of place it is (a tower, a city, a park), its address, its '
        + 'coordinates, its time zone and its population. Uses OpenStreetMap Nominatim and Open-Meteo geocoding; no key, '
        + 'no sign-in.',
    input: {
        type: 'object',
        properties: {
            place: { type: 'string', description: 'The place to describe, for example "Eiffel Tower", "Sagrada Familia" or "Reykjavik".' },
        },
        required: ['place'],
    },
    scope: 'public',
    costUsd: 0,
    timeoutMs: 15000,
    sources: [
        source('https://www.openstreetmap.org/copyright', 'OpenStreetMap contributors (ODbL)'),
        source('https://open-meteo.com/en/docs/geocoding-api', 'Open-Meteo: geocoding API'),
    ],

    async run(input = {}, ctx = {}) {
        const place = String(input.place || '').trim();
        if (!place) return fail('place_info needs a place to describe, for example "Eiffel Tower".');
        const key = 'place:' + place.toLowerCase();

        try {
            const result = await memo(CACHE, key, TTL_MS, async () => {
                const hit = await osm(ctx, place, ctx.signal);
                const more = await extras(ctx, place, ctx.signal);
                return build(hit, more);
            });
            return result;
        } catch (err) {
            return fail((err && err.message) || 'the place could not be looked up');
        }
    },
};

function build(hit, more) {
    const address = hit.address || {};
    const parts = [address.road, address.suburb, address.city || address.town || address.village, address.state, address.country].filter(Boolean);
    const kind = [hit.category, hit.type].filter(Boolean).join('/');
    const lines = [];
    lines.push((hit.name || hit.display_name) + ' is a ' + (kind || 'place') + (parts.length ? ' in ' + parts.join(', ') : '') + '.');
    lines.push('Coordinates: ' + round(Number(hit.lat), 6) + ', ' + round(Number(hit.lon), 6) + '.');
    if (more && more.timezone) lines.push('Time zone: ' + more.timezone + '.');
    if (more && more.population) lines.push('Population: ' + more.population.toLocaleString('en-US') + '.');
    if (more && more.elevation_m != null) lines.push('Elevation: ' + more.elevation_m + ' m.');
    if (hit.display_name) lines.push('OpenStreetMap says: ' + hit.display_name + '.');
    return {
        text: lines.join('\n'),
        data: {
            name: hit.name || null,
            display_name: hit.display_name || null,
            kind: hit.category || null,
            type: hit.type || null,
            address: {
                road: address.road || null,
                suburb: address.suburb || null,
                city: address.city || address.town || address.village || null,
                state: address.state || null,
                country: address.country || null,
                country_code: address.country_code || null,
                postcode: address.postcode || null,
            },
            latitude: round(Number(hit.lat), 6),
            longitude: round(Number(hit.lon), 6),
            timezone: more ? more.timezone : null,
            population: more ? more.population : null,
            elevation_m: more ? more.elevation_m : null,
            place_id: hit.place_id || null,
            osm_type: hit.osm_type || null,
            osm_id: hit.osm_id || null,
            provider: 'OpenStreetMap Nominatim',
            fetched_at: new Date().toISOString(),
        },
        sources: [
            source('https://www.openstreetmap.org/copyright', 'OpenStreetMap contributors (ODbL)'),
            source('https://open-meteo.com/en/docs/geocoding-api', 'Open-Meteo: geocoding API'),
        ],
        artifacts: [],
    };
}

'use strict';
/**
 * geocode: a place name in coordinates, and what goes with them (the country, the time zone, the
 * population, the elevation).
 *
 * Source: Open-Meteo's geocoding API (https://open-meteo.com/en/docs/geocoding-api), free and
 * keyless. When Open-Meteo does not know the name, OpenStreetMap's Nominatim is asked instead
 * (see lib/nominatim.js for its usage policy).
 */
const { Cache, ToolError, memo, requestJson, round, source, fail } = require('./lib/util');
const nominatim = require('./lib/nominatim');

const ENDPOINT = 'https://geocoding-api.open-meteo.com/v1/search';
const TTL_MS = 10 * 60 * 1000;
const CACHE = new Cache();

/** The place, as Open-Meteo knows it. */
async function openMeteo(ctx, place, signal) {
    const url = ENDPOINT + '?name=' + encodeURIComponent(place) + '&count=5&language=en&format=json';
    const { data } = await requestJson(ctx, url, { signal, label: 'Open-Meteo geocoding' });
    return (data && Array.isArray(data.results)) ? data.results : [];
}

/** The same place, as Nominatim knows it. */
async function osm(ctx, place, signal) {
    const hits = await nominatim.search(ctx, place, { limit: 1, signal });
    const hit = hits[0];
    if (!hit) return null;
    return {
        name: hit.name || String(place).split(',')[0].trim(),
        admin1: (hit.address && (hit.address.state || hit.address.county)) || null,
        country: (hit.address && hit.address.country) || null,
        country_code: (hit.address && hit.address.country_code) || null,
        latitude: Number(hit.lat),
        longitude: Number(hit.lon),
        elevation_m: null,
        population: null,
        timezone: null,
        feature_code: hit.type || null,
        display_name: hit.display_name || null,
    };
}

module.exports = {
    name: 'geocode',
    description: 'Turn a place name into coordinates and what goes with them: the country, the region, the time zone, '
        + 'the population and the elevation. Uses Open-Meteo geocoding (free, no key), with OpenStreetMap Nominatim as '
        + 'the second opinion. Good for "where is X", for a timezone and for checking a location before a lookup.',
    input: {
        type: 'object',
        properties: {
            place: { type: 'string', description: 'The place to look up, for example "Lisbon", "Mount Fuji" or "1600 Pennsylvania Avenue".' },
        },
        required: ['place'],
    },
    scope: 'public',
    costUsd: 0,
    timeoutMs: 15000,
    sources: [
        source('https://open-meteo.com/en/docs/geocoding-api', 'Open-Meteo: geocoding API'),
        source('https://www.openstreetmap.org/copyright', 'OpenStreetMap contributors (ODbL)'),
    ],

    async run(input = {}, ctx = {}) {
        const place = String(input.place || '').trim();
        if (!place) return fail('geocode needs a place to look up, for example "Lisbon".');
        const key = 'geocode:' + place.toLowerCase();

        try {
            const result = await memo(CACHE, key, TTL_MS, async () => {
                let hits = [];
                try {
                    hits = await openMeteo(ctx, place, ctx.signal);
                } catch (err) {
                    if (err && err.code === 'tool.http') throw err;
                }
                if (!hits.length) {
                    const fallback = await osm(ctx, place, ctx.signal);
                    if (!fallback) throw new ToolError('no place called "' + place + '" was found', 'tool.not_found');
                    return build(fallback, [], 'OpenStreetMap Nominatim');
                }
                const best = hits[0];
                const normalised = {
                    name: best.name,
                    admin1: best.admin1 || null,
                    country: best.country || null,
                    country_code: best.country_code || null,
                    latitude: best.latitude,
                    longitude: best.longitude,
                    elevation_m: best.elevation == null ? null : round(best.elevation),
                    population: best.population || null,
                    timezone: best.timezone || null,
                    feature_code: best.feature_code || null,
                    display_name: null,
                };
                return build(normalised, hits.slice(1), 'Open-Meteo geocoding');
            });
            return result;
        } catch (err) {
            return fail((err && err.message) || 'the place could not be looked up');
        }
    },
};

function build(place, alternatives, provider) {
    const where = [place.name, place.admin1, place.country].filter(Boolean).join(', ');
    const coords = round(place.latitude, 5) + ', ' + round(place.longitude, 5);
    const lines = [where + ' is at ' + coords + '.'];
    if (place.timezone) lines.push('Time zone: ' + place.timezone + '.');
    if (place.population) lines.push('Population: ' + place.population.toLocaleString('en-US') + '.');
    if (place.elevation_m != null) lines.push('Elevation: ' + place.elevation_m + ' m.');
    if (place.display_name) lines.push(place.display_name + '.');
    if (alternatives.length) {
        lines.push('Other places with that name:');
        for (const alt of alternatives) {
            lines.push('- ' + [alt.name, alt.admin1, alt.country].filter(Boolean).join(', ') + ' (' + round(alt.latitude, 4) + ', ' + round(alt.longitude, 4) + ')');
        }
    }
    return {
        text: lines.join('\n'),
        data: {
            place: {
                name: place.name,
                admin1: place.admin1,
                country: place.country,
                country_code: place.country_code,
                latitude: round(place.latitude, 6),
                longitude: round(place.longitude, 6),
                elevation_m: place.elevation_m,
                population: place.population,
                timezone: place.timezone,
                feature_code: place.feature_code,
                display_name: place.display_name,
            },
            alternatives: alternatives.map((alt) => ({
                name: alt.name,
                admin1: alt.admin1 || null,
                country: alt.country || null,
                latitude: round(alt.latitude, 6),
                longitude: round(alt.longitude, 6),
            })),
            provider,
            fetched_at: new Date().toISOString(),
        },
        sources: [
            source('https://open-meteo.com/en/docs/geocoding-api', 'Open-Meteo: geocoding API'),
            source('https://www.openstreetmap.org/copyright', 'OpenStreetMap contributors (ODbL)'),
        ],
        artifacts: [],
    };
}

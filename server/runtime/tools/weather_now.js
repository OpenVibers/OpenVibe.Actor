'use strict';
/**
 * weather_now: the weather now and the next three days for a place.
 *
 * Source: Open-Meteo (https://open-meteo.com). Its geocoding API finds the place (a name, in any
 * language), its forecast API gives the current conditions and the daily forecast. Both are free
 * and keyless; Open-Meteo asks for fair use, which the ten-minute cache and the timeout respect.
 * The API is documented at https://open-meteo.com/en/docs.
 *
 * Units: the place's own units come first (places that use the US system show Fahrenheit, every
 * other place Celsius) and the other one follows, so no one has to convert.
 */
const { Cache, memo, requestJson, ToolError, round, group, source, fail } = require('./lib/util');

const TTL_MS = 10 * 60_000;
const CACHE = new Cache();

const GEOCODE = 'https://geocoding-api.open-meteo.com/v1/search';
const FORECAST = 'https://api.open-meteo.com/v1/forecast';

/** The WMO weather codes Open-Meteo answers with, in words. */
const WEATHER = {
    0: 'clear sky', 1: 'mainly clear', 2: 'partly cloudy', 3: 'overcast',
    45: 'fog', 48: 'rime fog',
    51: 'light drizzle', 53: 'drizzle', 55: 'heavy drizzle', 56: 'freezing drizzle', 57: 'freezing drizzle',
    61: 'light rain', 63: 'rain', 65: 'heavy rain', 66: 'freezing rain', 67: 'freezing rain',
    71: 'light snow', 73: 'snow', 75: 'heavy snow', 77: 'snow grains',
    80: 'light showers', 81: 'showers', 82: 'violent showers', 85: 'snow showers', 86: 'heavy snow showers',
    95: 'thunderstorm', 96: 'thunderstorm with hail', 99: 'thunderstorm with heavy hail',
};

/** The places that use the US system. */
const US_FIRST = new Set(['US', 'LR', 'MM']);

const cToF = (c) => (c * 9) / 5 + 32;
const kmhToMph = (k) => k * 0.621371;
const mmToIn = (m) => m / 25.4;

const describe = (code) => WEATHER[code] || 'unknown conditions';

const dayName = (iso) => {
    const d = new Date(iso + 'T12:00:00Z');
    return d.toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' });
};

async function geocode(ctx, place, signal) {
    const url = GEOCODE + '?name=' + encodeURIComponent(place) + '&count=1&language=en&format=json';
    const { data } = await requestJson(ctx, url, { signal, label: 'Open-Meteo geocoding' });
    const hit = data && Array.isArray(data.results) && data.results[0];
    if (!hit) throw new ToolError('no place called "' + place + '" was found', 'tool.not_found');
    return hit;
}

async function forecast(ctx, hit, days, signal) {
    const url = FORECAST
        + '?latitude=' + hit.latitude + '&longitude=' + hit.longitude
        + '&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m,precipitation'
        + '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max'
        + '&timezone=auto&forecast_days=' + days;
    const { data } = await requestJson(ctx, url, { signal, label: 'Open-Meteo forecast' });
    if (!data || !data.current) throw new ToolError('Open-Meteo answered without current conditions', 'tool.bad_answer');
    return data;
}

module.exports = {
    name: 'weather_now',
    description: 'Current weather and the next three days for a place (a city, a town, a landmark). '
        + 'Uses Open-Meteo: no key, no sign-in. Gives the temperature now in both Celsius and Fahrenheit, '
        + 'the wind, the humidity and a three-day forecast.',
    input: {
        type: 'object',
        properties: {
            place: { type: 'string', description: 'The place to report on, for example "Berlin", "Kyoto, Japan" or "Eiffel Tower".' },
            days: { type: 'integer', description: 'How many days of forecast to include, 1 to 3.', minimum: 1, maximum: 3 },
        },
        required: ['place'],
    },
    scope: 'public',
    costUsd: 0,
    timeoutMs: 15000,
    sources: [
        source('https://open-meteo.com/', 'Open-Meteo: free weather forecast API'),
        source('https://open-meteo.com/en/docs/geocoding-api', 'Open-Meteo: geocoding API'),
    ],

    async run(input = {}, ctx = {}) {
        const place = String(input.place || '').trim();
        if (!place) return fail('weather_now needs a place, for example "Berlin" or "Kyoto, Japan".');
        const days = Math.min(3, Math.max(1, parseInt(input.days, 10) || 3));
        const key = 'weather:' + place.toLowerCase() + ':' + days;

        try {
            const result = await memo(CACHE, key, TTL_MS, async () => {
                const hit = await geocode(ctx, place, ctx.signal);
                const data = await forecast(ctx, hit, days, ctx.signal);
                return build(hit, data, days);
            });
            return result;
        } catch (err) {
            return fail((err && err.message) || 'the weather could not be fetched');
        }
    },
};

/** The place, the current conditions and the forecast, as text for the model and as data. */
function build(hit, data, days) {
    const c = data.current || {};
    const daily = data.daily || {};
    const usFirst = US_FIRST.has(String(hit.country_code || '').toUpperCase());
    const temp = (celsius) => {
        const f = cToF(celsius);
        return usFirst ? round(f) + ' °F (' + round(celsius) + ' °C)' : round(celsius) + ' °C (' + round(f) + ' °F)';
    };
    const wind = (kmh) => usFirst ? round(kmhToMph(kmh)) + ' mph (' + round(kmh) + ' km/h)' : round(kmh) + ' km/h (' + round(kmhToMph(kmh)) + ' mph)';
    const rain = (mm) => usFirst ? round(mmToIn(mm)) + ' in (' + round(mm) + ' mm)' : round(mm) + ' mm (' + round(mmToIn(mm)) + ' in)';

    const where = [hit.name, hit.admin1 && hit.admin1 !== hit.name ? hit.admin1 : null, hit.country].filter(Boolean).join(', ');
    const lines = [];
    lines.push(where + ' — now ' + temp(c.temperature_2m) + ', ' + describe(c.weather_code) + '.');
    const details = [];
    if (c.apparent_temperature != null) details.push('feels like ' + temp(c.apparent_temperature));
    if (c.relative_humidity_2m != null) details.push('humidity ' + c.relative_humidity_2m + '%');
    if (c.wind_speed_10m != null) details.push('wind ' + wind(c.wind_speed_10m));
    if (c.precipitation != null) details.push('precipitation ' + rain(c.precipitation));
    if (details.length) lines.push(details.join(', ') + '.');
    lines.push('Local time in ' + (data.timezone || 'the place') + ': ' + (c.time || 'unknown') + '.');

    const forecast = [];
    const times = daily.time || [];
    for (let i = 0; i < times.length && i < days; i += 1) {
        const code = (daily.weather_code || [])[i];
        const max = (daily.temperature_2m_max || [])[i];
        const min = (daily.temperature_2m_min || [])[i];
        const amount = (daily.precipitation_sum || [])[i];
        const chance = (daily.precipitation_probability_max || [])[i];
        forecast.push({
            date: times[i],
            code: code == null ? null : code,
            description: describe(code),
            temp_max_c: max == null ? null : round(max),
            temp_max_f: max == null ? null : round(cToF(max)),
            temp_min_c: min == null ? null : round(min),
            temp_min_f: min == null ? null : round(cToF(min)),
            precipitation_mm: amount == null ? null : round(amount),
            precipitation_in: amount == null ? null : round(mmToIn(amount)),
            precipitation_probability: chance == null ? null : chance,
        });
        const bits = [describe(code), round(min) + ' to ' + round(max) + ' °C (' + round(cToF(min)) + ' to ' + round(cToF(max)) + ' °F)'];
        if (amount != null) bits.push(rain(amount) + ' of rain');
        if (chance != null) bits.push(chance + '% chance of rain');
        lines.push('- ' + dayName(times[i]) + ' ' + times[i] + ': ' + bits.join(', ') + '.');
    }

    const place = {
        name: hit.name,
        admin1: hit.admin1 || null,
        country: hit.country || null,
        country_code: hit.country_code || null,
        latitude: hit.latitude,
        longitude: hit.longitude,
        elevation_m: hit.elevation == null ? null : round(hit.elevation),
        population: hit.population || null,
        timezone: data.timezone || hit.timezone || null,
    };

    return {
        text: lines.join('\n'),
        data: {
            place,
            current: {
                time: c.time || null,
                temperature_c: c.temperature_2m == null ? null : round(c.temperature_2m),
                temperature_f: c.temperature_2m == null ? null : round(cToF(c.temperature_2m)),
                apparent_c: c.apparent_temperature == null ? null : round(c.apparent_temperature),
                apparent_f: c.apparent_temperature == null ? null : round(cToF(c.apparent_temperature)),
                humidity_percent: c.relative_humidity_2m == null ? null : c.relative_humidity_2m,
                wind_kmh: c.wind_speed_10m == null ? null : round(c.wind_speed_10m),
                wind_mph: c.wind_speed_10m == null ? null : round(kmhToMph(c.wind_speed_10m)),
                precipitation_mm: c.precipitation == null ? null : round(c.precipitation),
                precipitation_in: c.precipitation == null ? null : round(mmToIn(c.precipitation)),
                code: c.weather_code == null ? null : c.weather_code,
                description: describe(c.weather_code),
            },
            forecast,
            units: {
                temperature: 'Celsius and Fahrenheit',
                wind: 'km/h and mph',
                precipitation: 'mm and inches',
                order: usFirst ? 'Fahrenheit first (the place uses the US system)' : 'Celsius first',
            },
            fetched_at: new Date().toISOString(),
        },
        sources: [
            source('https://open-meteo.com/', 'Open-Meteo: free weather forecast API'),
            source('https://open-meteo.com/en/docs/geocoding-api', 'Open-Meteo: geocoding API'),
        ],
        artifacts: [],
    };
}

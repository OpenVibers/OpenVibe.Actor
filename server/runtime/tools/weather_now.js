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
// When Open-Meteo's forecast does not answer (11-18: down for hours while its geocoding worked, and an agent asked it for
// five cities in a row), MET Norway's free, keyless locationforecast answers instead, read into Open-Meteo's shape.
const MET_NO = 'https://api.met.no/weatherapi/locationforecast/2.0/compact';

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

/** One decimal for people to read (util's round keeps ten digits: "4.2253228 mph"). */
const shown = (v) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : v);
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

/** MET Norway's symbol (clearsky_day, lightrainshowers_night …) as the nearest WMO weather code describe() knows. */
function wmoOf(symbol) {
    const k = String(symbol || '').replace(/_(day|night|polartwilight)$/, '');
    if (!k) return null;
    if (k.includes('thunder')) return 95;
    if (k.includes('heavysnow')) return 75;
    if (k.includes('lightsnow')) return 71;
    if (k.includes('snow')) return 73;
    if (k.includes('sleet')) return 66;
    if (k.includes('heavyrain')) return 65;
    if (k.includes('rainshowers')) return 80;
    if (k.includes('lightrain')) return 61;
    if (k.includes('rain')) return 63;
    if (k === 'fog') return 45;
    if (k === 'cloudy') return 3;
    if (k === 'partlycloudy') return 2;
    if (k === 'fair') return 1;
    if (k === 'clearsky') return 0;
    return null;
}

/** The forecast from MET Norway, in the shape build() reads (Open-Meteo's): current conditions and days by UTC date. */
async function metNoForecast(ctx, hit, days, signal) {
    const url = MET_NO + '?lat=' + Number(hit.latitude).toFixed(4) + '&lon=' + Number(hit.longitude).toFixed(4);
    const { data } = await requestJson(ctx, url, { signal, label: 'MET Norway forecast' });
    const series = data && data.properties && Array.isArray(data.properties.timeseries) ? data.properties.timeseries : [];
    if (!series.length) throw new ToolError('MET Norway answered without a forecast', 'tool.bad_answer');
    const first = series[0];
    const now = (first.data && first.data.instant && first.data.instant.details) || {};
    const next = (first.data && (first.data.next_1_hours || first.data.next_6_hours)) || {};
    const byDay = new Map();
    for (const t of series) {
        const day = String(t.time || '').slice(0, 10);
        if (!day) continue;
        if (!byDay.has(day)) { if (byDay.size >= days) break; byDay.set(day, { max: -Infinity, min: Infinity, rain: 0, codes: [] }); }
        const d = byDay.get(day);
        const temp = t.data && t.data.instant && t.data.instant.details && t.data.instant.details.air_temperature;
        if (Number.isFinite(temp)) { d.max = Math.max(d.max, temp); d.min = Math.min(d.min, temp); }
        const one = t.data && t.data.next_1_hours;
        if (one && one.details && Number.isFinite(one.details.precipitation_amount)) d.rain += one.details.precipitation_amount;
        const code = wmoOf(one && one.summary && one.summary.symbol_code);
        if (code != null) d.codes.push(code);
    }
    const dates = [...byDay.keys()];
    const fin = (v) => (Number.isFinite(v) ? v : null);
    return {
        timezone: hit.timezone || 'UTC',
        current: {
            time: String(first.time || '').replace(/:00Z$/, '').replace('Z', ''),
            temperature_2m: fin(now.air_temperature),
            relative_humidity_2m: fin(now.relative_humidity),
            apparent_temperature: null,
            weather_code: wmoOf(next.summary && next.summary.symbol_code),
            wind_speed_10m: Number.isFinite(now.wind_speed) ? now.wind_speed * 3.6 : null,
            precipitation: next.details && Number.isFinite(next.details.precipitation_amount) ? next.details.precipitation_amount : null,
        },
        daily: {
            time: dates,
            weather_code: dates.map((d) => { const c = byDay.get(d).codes; return c.length ? Math.max(...c) : null; }),
            temperature_2m_max: dates.map((d) => fin(byDay.get(d).max)),
            temperature_2m_min: dates.map((d) => fin(byDay.get(d).min)),
            precipitation_sum: dates.map((d) => Math.round(byDay.get(d).rain * 10) / 10),
            precipitation_probability_max: dates.map(() => null),
        },
        source: 'met.no',
    };
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
    needs: { files: 'none', network: true },   // plan 11c: the run's files and network settings gate it
    connector: 'openvibe',
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
                let data;
                try { data = await forecast(ctx, hit, days, ctx.signal); }
                catch (err) {
                    if (ctx.signal && ctx.signal.aborted) throw err;
                    data = await metNoForecast(ctx, hit, days, ctx.signal);
                }
                const out = build(hit, data, days);
                if (data.source === 'met.no' && out && typeof out === 'object') {
                    if (typeof out.text === 'string') out.text += ' (Forecast from MET Norway: Open-Meteo did not answer.)';
                    out.sources = [...(Array.isArray(out.sources) ? out.sources : []), source('https://api.met.no/weatherapi/locationforecast/2.0/documentation', 'MET Norway: locationforecast')];
                }
                return out;
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
        return usFirst ? shown(f) + ' °F (' + shown(celsius) + ' °C)' : shown(celsius) + ' °C (' + shown(f) + ' °F)';
    };
    const wind = (kmh) => usFirst ? shown(kmhToMph(kmh)) + ' mph (' + shown(kmh) + ' km/h)' : shown(kmh) + ' km/h (' + shown(kmhToMph(kmh)) + ' mph)';
    const rain = (mm) => usFirst ? shown(mmToIn(mm)) + ' in (' + shown(mm) + ' mm)' : shown(mm) + ' mm (' + shown(mmToIn(mm)) + ' in)';

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
        const bits = [describe(code), shown(min) + ' to ' + shown(max) + ' °C (' + shown(cToF(min)) + ' to ' + shown(cToF(max)) + ' °F)'];
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

'use strict';
// weather_now: the place is found, the forecast is read, the units are given both ways and the
// source is carried with the answer. The answers come from the recorded fixtures, not the network.
const assert = require('assert');
const weather = require('../server/runtime/tools/weather_now');
const { fixtureFetch, ctxOf } = require('./helpers/tool-fixtures');
const { check, done } = require('./helpers/boot');

const routes = {
    'geocoding-api.open-meteo.com/v1/search': (url) => (url.includes('Nowhere') ? 'open-meteo-geocode-eiffel.json' : 'open-meteo-geocode-berlin.json'),
    'api.open-meteo.com/v1/forecast': 'open-meteo-forecast-berlin.json',
};

(async () => {
    await check('weather_now gives the conditions now, in Celsius and Fahrenheit', async () => {
        const f = fixtureFetch(routes);
        const out = await weather.run({ place: 'Berlin' }, ctxOf(f.fetchImpl));
        assert.ok(!out.error, out.error);
        assert.ok(out.text.includes('Berlin'), out.text);
        assert.ok(out.text.includes('°C'), out.text);
        assert.ok(out.text.includes('°F'), out.text);
        assert.strictEqual(out.data.current.temperature_c, 7.4);
        assert.strictEqual(out.data.current.temperature_f, 45.32);
        assert.strictEqual(out.data.current.description, 'fog');
        assert.strictEqual(out.data.current.wind_kmh, 3.3);
        assert.ok(out.data.current.wind_mph > 2 && out.data.current.wind_mph < 2.1, 'the wind in mph too');
        assert.strictEqual(out.data.place.timezone, 'Europe/Berlin');
        assert.strictEqual(out.data.place.country, 'Germany');
    });

    await check('weather_now gives three days of forecast', async () => {
        const f = fixtureFetch(routes);
        const out = await weather.run({ place: 'Berlin, Germany' }, ctxOf(f.fetchImpl));
        assert.ok(!out.error, out.error);
        assert.strictEqual(out.data.forecast.length, 3);
        assert.strictEqual(out.data.forecast[0].date, '2026-10-30');
        assert.strictEqual(out.data.forecast[0].temp_max_c, 10.7);
        assert.strictEqual(out.data.forecast[0].temp_max_f, 51.26);
        assert.strictEqual(out.data.forecast[0].description, 'light drizzle');
        assert.ok(out.text.includes('light drizzle'), out.text);
    });

    await check('weather_now carries the provider as its source', async () => {
        const f = fixtureFetch(routes);
        const out = await weather.run({ place: 'Hamburg' }, ctxOf(f.fetchImpl));
        assert.ok(!out.error, out.error);
        assert.ok(out.sources.length >= 1);
        assert.ok(out.sources.some((s) => s.url.startsWith('https://open-meteo.com')), 'the source is the provider page');
        assert.ok(out.sources.every((s) => s.title && s.url), 'every source has a title and a url');
    });

    await check('weather_now asks the geocoding API for the place first', async () => {
        const f = fixtureFetch(routes);
        await weather.run({ place: 'Lisbon' }, ctxOf(f.fetchImpl));
        assert.ok(f.calls.some((c) => c.url.includes('geocoding-api.open-meteo.com')), 'the place is geocoded');
        assert.ok(f.calls.some((c) => c.url.includes('api.open-meteo.com/v1/forecast')), 'then the forecast is fetched');
    });

    await check('a place that does not exist is an error the model can act on', async () => {
        const f = fixtureFetch(routes);
        const out = await weather.run({ place: 'Nowhere' }, ctxOf(f.fetchImpl));
        assert.ok(out.error, 'there is an error');
        assert.ok(out.error.includes('Nowhere'), out.error);
    });

    await check('no place at all is an error, not a crash', async () => {
        const f = fixtureFetch(routes);
        const out = await weather.run({}, ctxOf(f.fetchImpl));
        assert.ok(out.error && out.error.includes('place'), out.error);
    });

    done();
})();

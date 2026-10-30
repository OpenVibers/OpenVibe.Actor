'use strict';
// geocode and place_info: a name becomes a place, with the facts that belong to it. Each case
// uses a name of its own, so the tools' own cache never answers a later question.
const assert = require('assert');
const geocode = require('../server/runtime/tools/geocode');
const placeInfo = require('../server/runtime/tools/place_info');
const { fixtureFetch, ctxOf } = require('./helpers/tool-fixtures');
const { check, done } = require('./helpers/boot');

const nominatim = (url) => (url.includes('Atlantis') ? 'nominatim-empty.json' : 'nominatim-eiffel-tower.json');
const openMeteo = (url) => (url.includes('Berlin') ? 'open-meteo-geocode-berlin.json' : 'open-meteo-geocode-eiffel.json');

(async () => {
    await check('geocode turns a name into coordinates and what goes with them', async () => {
        const f = fixtureFetch({
            'geocoding-api.open-meteo.com/v1/search': openMeteo,
            'nominatim.openstreetmap.org/search': nominatim,
        });
        const out = await geocode.run({ place: 'Berlin' }, ctxOf(f.fetchImpl));
        assert.ok(!out.error, out.error);
        assert.strictEqual(out.data.place.name, 'Berlin');
        assert.strictEqual(out.data.place.country, 'Germany');
        assert.ok(out.data.place.latitude > 52 && out.data.place.latitude < 53, 'the latitude');
        assert.strictEqual(out.data.place.timezone, 'Europe/Berlin');
        assert.ok(out.data.place.population > 1000000, 'the population');
        assert.ok(out.text.includes('Berlin'), out.text);
        assert.ok(out.sources.some((s) => s.url.includes('open-meteo')), 'the source is Open-Meteo');
    });

    await check('geocode falls back to OpenStreetMap when Open-Meteo does not know the name', async () => {
        const f = fixtureFetch({
            'geocoding-api.open-meteo.com/v1/search': openMeteo,
            'nominatim.openstreetmap.org/search': nominatim,
        });
        const out = await geocode.run({ place: 'Eiffel Tower' }, ctxOf(f.fetchImpl));
        assert.ok(!out.error, out.error);
        assert.ok(f.calls.some((c) => c.url.includes('nominatim')), 'Nominatim was asked');
        assert.ok(out.data.place.latitude > 48 && out.data.place.latitude < 49, 'the latitude');
        assert.ok(out.text.includes('Eiffel'), out.text);
    });

    await check('geocode asks Nominatim with a User-Agent that names Actor', async () => {
        const f = fixtureFetch({
            'geocoding-api.open-meteo.com/v1/search': openMeteo,
            'nominatim.openstreetmap.org/search': nominatim,
        });
        const out = await geocode.run({ place: 'Brandenburg Gate' }, ctxOf(f.fetchImpl));
        assert.ok(!out.error, out.error);
        const call = f.calls.find((c) => c.url.includes('nominatim'));
        assert.ok(call, 'Nominatim was called');
        const agent = call.headers['user-agent'] || '';
        assert.ok(agent.includes('OpenVibe.Actor'), 'the User-Agent names the application: ' + agent);
        assert.ok(agent.includes('https://openvibe.actor'), 'the User-Agent has a way to reach us: ' + agent);
    });

    await check('a place nobody knows is an error the model can act on', async () => {
        const f = fixtureFetch({
            'geocoding-api.open-meteo.com/v1/search': openMeteo,
            'nominatim.openstreetmap.org/search': nominatim,
        });
        const out = await geocode.run({ place: 'Atlantis' }, ctxOf(f.fetchImpl));
        assert.ok(out.error && out.error.includes('Atlantis'), out.error);
    });

    await check('place_info describes the place, its kind and its address', async () => {
        const f = fixtureFetch({
            'nominatim.openstreetmap.org/search': nominatim,
            'geocoding-api.open-meteo.com/v1/search': openMeteo,
        });
        const out = await placeInfo.run({ place: 'Eiffel Tower' }, ctxOf(f.fetchImpl));
        assert.ok(!out.error, out.error);
        assert.strictEqual(out.data.kind, 'man_made');
        assert.strictEqual(out.data.type, 'tower');
        assert.ok(out.data.address.country, 'the country');
        assert.ok(out.data.latitude > 48 && out.data.latitude < 49);
        assert.ok(out.text.includes('tower'), out.text);
        assert.ok(out.sources.some((s) => s.url.includes('openstreetmap')), 'the source is OpenStreetMap');
    });

    await check('place_info asks Nominatim with the application User-Agent', async () => {
        const f = fixtureFetch({
            'nominatim.openstreetmap.org/search': nominatim,
            'geocoding-api.open-meteo.com/v1/search': openMeteo,
        });
        await placeInfo.run({ place: 'Colosseum' }, ctxOf(f.fetchImpl));
        const call = f.calls.find((c) => c.url.includes('nominatim'));
        assert.ok(call, 'Nominatim was called');
        assert.ok((call.headers['user-agent'] || '').includes('OpenVibe.Actor'), 'the User-Agent names the application');
    });

    await check('place_info needs a place', async () => {
        const out = await placeInfo.run({}, ctxOf(fixtureFetch({}).fetchImpl));
        assert.ok(out.error && out.error.includes('place'), out.error);
    });

    done();
})();

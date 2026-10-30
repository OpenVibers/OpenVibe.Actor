'use strict';
// time_in and convert_time: the platform time zone database, with daylight saving on the right
// side of the change. No network call is made.
const assert = require('assert');
const timeIn = require('../server/runtime/tools/time_in');
const convertTime = require('../server/runtime/tools/convert_time');
const { check, done } = require('./helpers/boot');

const noNetwork = { fetch: async () => { throw new Error('these tools must not touch the network'); } };

(async () => {
    await check('time_in gives the local time, the offset and the zone name', async () => {
        const out = await timeIn.run({ zone: 'Europe/Berlin' }, noNetwork);
        assert.ok(!out.error, out.error);
        assert.strictEqual(out.data.zone, 'Europe/Berlin');
        assert.ok(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(out.data.local_time), out.data.local_time);
        assert.ok(/^UTC([+-]\d{2}:\d{2})?$/.test(out.data.utc_offset), out.data.utc_offset);
        assert.ok(out.data.abbreviation.length > 0);
        assert.strictEqual(typeof out.data.dst, 'boolean');
        assert.ok(out.text.includes('Europe/Berlin'), out.text);
    });

    await check('time_in takes a city as well as a zone', async () => {
        const out = await timeIn.run({ zone: 'Tokyo' }, noNetwork);
        assert.ok(!out.error, out.error);
        assert.strictEqual(out.data.zone, 'Asia/Tokyo');
        assert.strictEqual(out.data.utc_offset, 'UTC+09:00');
    });

    await check('a place that is not a zone is an error the model can act on', async () => {
        const out = await timeIn.run({ zone: 'Middle Earth' }, noNetwork);
        assert.ok(out.error && out.error.includes('Middle Earth'), out.error);
    });

    await check('convert_time reads a summer moment with the summer offsets', async () => {
        const out = await convertTime.run({ from: 'Australia/Sydney', to: 'Europe/Berlin', datetime: '2026-07-01T00:00:00Z' }, noNetwork);
        assert.ok(!out.error, out.error);
        assert.strictEqual(out.data.from.utc_offset, 'UTC+10:00');
        assert.strictEqual(out.data.to.utc_offset, 'UTC+02:00');
        assert.strictEqual(out.data.difference_minutes, -480);
        assert.strictEqual(out.data.from.local_time, '2026-07-01 10:00:00');
        assert.strictEqual(out.data.to.local_time, '2026-07-01 02:00:00');
        assert.strictEqual(out.data.from.dst, false);
        assert.strictEqual(out.data.to.dst, true);
    });

    await check('convert_time reads a winter moment with the winter offsets', async () => {
        const out = await convertTime.run({ from: 'Australia/Sydney', to: 'Europe/Berlin', datetime: '2026-01-15T00:00:00Z' }, noNetwork);
        assert.ok(!out.error, out.error);
        assert.strictEqual(out.data.from.utc_offset, 'UTC+11:00');
        assert.strictEqual(out.data.to.utc_offset, 'UTC+01:00');
        assert.strictEqual(out.data.difference_minutes, -600);
        assert.strictEqual(out.data.from.dst, true);
        assert.strictEqual(out.data.to.dst, false);
    });

    await check('convert_time reads a wall-clock time in the zone it was written in', async () => {
        const out = await convertTime.run({ from: 'America/New_York', to: 'UTC', datetime: '2026-07-01 08:00' }, noNetwork);
        assert.ok(!out.error, out.error);
        assert.strictEqual(out.data.utc_time, '2026-07-01T12:00:00.000Z');
        assert.strictEqual(out.data.from.utc_offset, 'UTC-04:00');
        assert.strictEqual(out.data.from.local_time, '2026-07-01 08:00:00');
    });

    await check('convert_time says how far ahead the other place is', async () => {
        const out = await convertTime.run({ from: 'America/New_York', to: 'Europe/Berlin', datetime: '2026-07-01T12:00:00Z' }, noNetwork);
        assert.ok(!out.error, out.error);
        assert.strictEqual(out.data.difference_minutes, 360);
        assert.ok(out.data.difference.includes('ahead'), out.data.difference);
        assert.ok(out.text.includes('Europe/Berlin'), out.text);
    });

    await check('a moment nobody can read is an error the model can act on', async () => {
        const out = await convertTime.run({ to: 'UTC', datetime: 'the day before yesterday-ish' }, noNetwork);
        assert.ok(out.error && out.error.length > 10, out.error);
    });

    done();
})();

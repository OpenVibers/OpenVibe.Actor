'use strict';
// make_chart (Actor v2, stage V2-4): the data and the type go in, a deterministic SVG comes out and is stored as a
// private artifact. The rendering lib is snapshotted against test/fixtures/charts/*.svg; the tool itself is tested
// through the artifact store it is given.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const makeChart = require('../server/runtime/tools/make_chart');
const { renderChart, MAX_POINTS, TYPES } = require('../server/runtime/tools/lib/chart');
const { check, done } = require('./helpers/boot');

const PERSON = 'user:usr_01JAB2C3D4E5F6G7H8J9K0MNPT';
const FIXTURES = path.join(__dirname, 'fixtures', 'charts');

function fixture(name) {
    return fs.readFileSync(path.join(FIXTURES, name), 'utf8');
}

function fakeStore({ maxFileBytes = 1024 * 1024 } = {}) {
    const saved = [];
    return {
        saved,
        available: true,
        maxFileBytes,
        async save({ kind, name, mime, bytes }) {
            const artifact = { kind, name, mime, url: 'https://openvibe.actor/tasks/tsk_TEST/files/art_TEST', size: bytes.length };
            saved.push({ artifact, svg: bytes.toString('utf8') });
            return artifact;
        },
    };
}

const ctx = (store = fakeStore()) => ({ requester: PERSON, artifacts: store });

(async () => {
    await check('the bar snapshot is unchanged', async () => {
        const svg = renderChart({
            type: 'bar', title: 'Quarterly revenue', width: 640, height: 400, y_label: 'USD',
            data: [{ label: 'Q1', value: 120 }, { label: 'Q2', value: 180 }, { label: 'Q3', value: 150 }],
        });
        assert.strictEqual(svg, fixture('bar.svg'));
    });

    await check('the line snapshot is unchanged', async () => {
        const svg = renderChart({
            type: 'line', title: 'Signups', width: 640, height: 400,
            data: [{ label: 'Mon', value: 3 }, { label: 'Tue', value: 7 }, { label: 'Wed', value: 5 }],
        });
        assert.strictEqual(svg, fixture('line.svg'));
    });

    await check('the scatter snapshot is unchanged', async () => {
        const svg = renderChart({
            type: 'scatter', title: 'Height vs weight', width: 640, height: 400, x_label: 'Height', y_label: 'Weight',
            data: [{ label: 'A', x: 1, y: 2 }, { x: 2, y: 4 }, { label: 'C', x: 3, y: 3 }],
        });
        assert.strictEqual(svg, fixture('scatter.svg'));
    });

    await check('the pie snapshot is unchanged', async () => {
        const svg = renderChart({
            type: 'pie', title: 'Traffic', width: 640, height: 400,
            data: [{ label: 'Search', value: 60 }, { label: 'Direct', value: 30 }, { label: 'Social', value: 10 }],
        });
        assert.strictEqual(svg, fixture('pie.svg'));
    });

    await check('the same spec always draws the same bytes', async () => {
        const spec = { type: 'bar', title: 'T', data: [{ label: 'a', value: 1 }, { label: 'b', value: 2 }] };
        assert.strictEqual(renderChart(spec), renderChart(spec));
    });

    await check('every chart is inert SVG: no script, no event handlers, no external references', async () => {
        const specs = [
            { type: 'bar', title: 'B', data: [{ label: 'a', value: 1 }] },
            { type: 'line', title: 'L', data: [{ label: 'a', value: 1 }] },
            { type: 'scatter', title: 'S', data: [{ x: 1, y: 1 }] },
            { type: 'pie', title: 'P', data: [{ label: 'a', value: 1 }] },
        ];
        for (const spec of specs) {
            const svg = renderChart(spec);
            assert.ok(!/<script/i.test(svg), spec.type + ' has no script');
            assert.ok(!/\son[a-z]+\s*=/i.test(svg), spec.type + ' has no event handler');
            assert.ok(!/href|src=|url\(/i.test(svg.replace(/xmlns="[^"]*"/, '')), spec.type + ' loads nothing');
        }
    });

    await check('labels are escaped, not injected', async () => {
        const svg = renderChart({ type: 'bar', title: '<img src=x onerror=alert(1)>', data: [{ label: '<b>&"', value: 1 }] });
        assert.ok(!svg.includes('<img'), 'the title is escaped');
        assert.ok(svg.includes('&lt;img'), 'the title is text');
        assert.ok(!svg.includes('<b>'), 'the label is escaped');
    });

    await check('a pie with more than six slices folds the rest into Other', async () => {
        const data = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((label, i) => ({ label, value: 100 - i * 5 }));
        const svg = renderChart({ type: 'pie', title: 'Many', data });
        assert.match(svg, />Other</);
        const slices = (svg.match(/<(path|circle) /g) || []).length;
        assert.strictEqual(slices, 6, 'five kept slices plus Other');
        // the four smallest are folded, and the total is preserved
        for (const label of ['a', 'b', 'c', 'd', 'e']) assert.ok(svg.includes(`>${label}<`), label + ' is kept');
        for (const label of ['f', 'g', 'h']) assert.ok(!svg.includes(`>${label}<`), label + ' is folded');
    });

    await check('make_chart stores an SVG artifact owned by the person', async () => {
        const store = fakeStore();
        const out = await makeChart.run({ type: 'bar', title: 'Revenue', data: [{ label: 'Q1', value: 1 }, { label: 'Q2', value: 2 }] }, ctx(store));
        assert.ok(!out.error, out.error);
        assert.strictEqual(out.artifacts.length, 1);
        const a = out.artifacts[0];
        assert.strictEqual(a.kind, 'chart');
        assert.strictEqual(a.mime, 'image/svg+xml');
        assert.strictEqual(a.name, 'Revenue.svg');
        assert.strictEqual(a.size, Buffer.byteLength(store.saved[0].svg));
        assert.strictEqual(out.data.chart_type, 'bar');
        assert.match(out.text, /Revenue\.svg/);
        assert.strictEqual(out.data.points, 2);
        assert.ok(store.saved[0].svg.startsWith('<?xml'));
    });

    await check('make_chart refuses input it cannot draw, and stores nothing', async () => {
        const store = fakeStore();
        const cases = [
            [{ type: 'radar', data: [{ label: 'a', value: 1 }] }, /type must be one of/],
            [{ type: 'bar', data: [] }, /non-empty/],
            [{ type: 'bar' }, /non-empty/],
            [{ type: 'bar', data: Array.from({ length: MAX_POINTS + 1 }, (_, i) => ({ label: String(i), value: i })) }, /limit is/],
            [{ type: 'bar', data: [{ label: 'a', value: 'x' }] }, /cannot be drawn/],
            [{ type: 'pie', data: [{ label: 'a', value: -1 }] }, /cannot be drawn/],
        ];
        for (const [input, re] of cases) {
            const out = await makeChart.run(input, ctx(store));
            assert.strictEqual(out.isError, true, JSON.stringify(input).slice(0, 80));
            assert.match(out.error, re);
        }
        assert.strictEqual(store.saved.length, 0);
    });

    await check('no signed-in person or no artifact store means no chart', async () => {
        const anon = await makeChart.run({ type: 'bar', data: [{ label: 'a', value: 1 }] }, { requester: null, artifacts: fakeStore() });
        assert.strictEqual(anon.isError, true);
        assert.match(anon.error, /signed-in person/);
        const closed = await makeChart.run({ type: 'bar', data: [{ label: 'a', value: 1 }] }, { requester: PERSON, artifacts: { available: false, maxFileBytes: 100 } });
        assert.strictEqual(closed.isError, true);
        assert.strictEqual(makeChart.available({ artifacts: { available: false } }), false);
        assert.strictEqual(makeChart.available({ artifacts: { available: true } }), true);
        assert.deepStrictEqual(TYPES, ['bar', 'line', 'scatter', 'pie']);
    });

    done();
})();

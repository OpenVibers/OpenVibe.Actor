'use strict';
// make_file (Actor v2, stage V2-4): Markdown, CSV, JSON, HTML or SVG, stored as an artifact owned by the requester.
// The tool validates what it can, never guesses a format, and refuses without a signed-in person and an artifact store.
const assert = require('assert');
const makeFile = require('../server/runtime/tools/make_file');
const { check, done } = require('./helpers/boot');

const PERSON = 'user:usr_01JAB2C3D4E5F6G7H8J9K0MNPT';
const TASK = 'tsk_01JAB2C3D4E5F6G7H8J9K0MNPQ';

function fakeStore({ maxFileBytes = 4096 } = {}) {
    const saved = [];
    let n = 0;
    return {
        saved,
        available: true,
        maxFileBytes,
        async save({ kind, name, mime, bytes }) {
            n += 1;
            const artifact = { kind, name, mime, url: `https://openvibe.actor/tasks/${TASK}/files/art_TEST${String(n).padStart(22, '0')}`, size: bytes.length };
            saved.push({ artifact, bytes: bytes.toString('utf8') });
            return artifact;
        },
    };
}

const ctx = (store = fakeStore()) => ({ requester: PERSON, artifacts: store });

(async () => {
    await check('Markdown is the default and the extension follows the format', async () => {
        const store = fakeStore();
        const out = await makeFile.run({ content: '# Hello\n\nA note.' }, ctx(store));
        assert.ok(!out.error, out.error);
        assert.strictEqual(out.artifacts.length, 1);
        const a = out.artifacts[0];
        assert.strictEqual(a.kind, 'file');
        assert.strictEqual(a.name, 'file.md');
        assert.strictEqual(a.mime, 'text/markdown');
        assert.strictEqual(a.size, Buffer.byteLength('# Hello\n\nA note.'));
        assert.match(a.url, /^https:\/\/openvibe\.actor\/tasks\/tsk_.*\/files\/art_/);
        assert.strictEqual(out.data.format, 'markdown');
        assert.match(out.text, /file\.md/);
    });

    await check('the format is taken from the name when it is not given, and the name is made safe', async () => {
        const store = fakeStore();
        const out = await makeFile.run({ name: '../../etc/passwd.csv', content: 'name,score\nAda,9\n' }, ctx(store));
        assert.ok(!out.error, out.error);
        assert.strictEqual(out.artifacts[0].name, 'etc-passwd.csv');
        assert.strictEqual(out.artifacts[0].mime, 'text/csv');
        assert.ok(!out.artifacts[0].name.includes('/'));
    });

    await check('JSON, HTML and SVG are stored with their own MIME types', async () => {
        const json = await makeFile.run({ format: 'json', name: 'data.json', content: '{"ok":true}' }, ctx());
        assert.ok(!json.error, json.error);
        assert.strictEqual(json.artifacts[0].mime, 'application/json');
        const html = await makeFile.run({ format: 'html', name: 'page', content: '<!doctype html><title>x</title>' }, ctx());
        assert.ok(!html.error, html.error);
        assert.strictEqual(html.artifacts[0].name, 'page.html');
        assert.strictEqual(html.artifacts[0].mime, 'text/html');
        const svg = await makeFile.run({ format: 'svg', name: 'mark', content: '<svg xmlns="http://www.w3.org/2000/svg"><circle r="4"/></svg>' }, ctx());
        assert.ok(!svg.error, svg.error);
        assert.strictEqual(svg.artifacts[0].mime, 'image/svg+xml');
    });

    await check('invalid content is refused with the reason, never stored', async () => {
        const store = fakeStore();
        const badJson = await makeFile.run({ format: 'json', content: '{not json' }, ctx(store));
        assert.strictEqual(badJson.isError, true);
        assert.match(badJson.error, /valid JSON/);
        const badSvg = await makeFile.run({ format: 'svg', content: '<div>not svg</div>' }, ctx(store));
        assert.strictEqual(badSvg.isError, true);
        assert.match(badSvg.error, /SVG/);
        const badCsv = await makeFile.run({ format: 'csv', content: 'only,a,header' }, ctx(store));
        assert.strictEqual(badCsv.isError, true);
        assert.match(badCsv.error, /header line/);
        const empty = await makeFile.run({ content: '   ' }, ctx(store));
        assert.strictEqual(empty.isError, true);
        assert.match(empty.error, /content/);
        assert.strictEqual(store.saved.length, 0, 'nothing was stored');
    });

    await check('the size limit is enforced before anything is stored', async () => {
        const store = fakeStore({ maxFileBytes: 8 });
        const out = await makeFile.run({ content: 'more than eight bytes' }, ctx(store));
        assert.strictEqual(out.isError, true);
        assert.match(out.error, /limit is 8 bytes/);
        assert.strictEqual(store.saved.length, 0);
    });

    await check('no signed-in person or no artifact store means no file', async () => {
        const anon = await makeFile.run({ content: 'x' }, { requester: null, artifacts: fakeStore() });
        assert.strictEqual(anon.isError, true);
        assert.match(anon.error, /signed-in person/);
        const closed = await makeFile.run({ content: 'x' }, { requester: PERSON, artifacts: { available: false, maxFileBytes: 100 } });
        assert.strictEqual(closed.isError, true);
    });

    done();
})();

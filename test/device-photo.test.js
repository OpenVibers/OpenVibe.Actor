'use strict';

const assert = require('assert');
const sharp = require('sharp');
const { sanitizePhoto } = require('../server/media/client');

(async () => {
    const source = await sharp({ create: { width: 8, height: 5, channels: 3, background: '#b25d27' } })
        .jpeg().withMetadata({ orientation: 6 }).toBuffer();
    assert.ok((await sharp(source).metadata()).exif, 'the source carries EXIF');
    const cleaned = await sanitizePhoto(source, 'image/jpeg');
    assert.ok(cleaned.bytes && cleaned.bytes.length);
    const meta = await sharp(cleaned.bytes).metadata();
    assert.strictEqual(meta.format, 'jpeg');
    assert.strictEqual(meta.exif, undefined, 'EXIF never leaves Actor');
    assert.deepStrictEqual([meta.width, meta.height], [5, 8], 'orientation is preserved in pixels');
    assert.ok((await sanitizePhoto(source, 'image/png')).error, 'claimed MIME must match bytes');
    assert.ok((await sanitizePhoto(Buffer.from('not an image'), 'image/jpeg')).error);
    process.stdout.write('  ✓ one photo is re-encoded without EXIF, with orientation preserved\n\nall passed\n');
})().catch((e) => { console.error(e); process.exit(1); });

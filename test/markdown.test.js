'use strict';
// An answer's render leaves no empty bullet: a model that ends on a bare list marker ("-" or "1.") or writes a blank
// item ("- ") must not draw a lone "•" after the answer (the owner's screenshot, 2026-10-30). The rest of the render
// is unchanged: real lists still render, an item's text still inline.
const assert = require('assert');
const { markdown, inline } = require('../server/render/markdown');

assert.strictEqual(markdown('The answer.\n- '), '<p>The answer.</p>', 'a trailing empty item draws nothing');
assert.strictEqual(markdown('The answer.\n-'), '<p>The answer.</p>', 'a trailing bare marker draws nothing');
assert.strictEqual(markdown('The answer.\n1. '), '<p>The answer.</p>', 'a trailing empty ordered item draws nothing');
assert.strictEqual(markdown('- '), '', 'an all-empty list is not a list');
assert.strictEqual(markdown('- \n* \n1. '), '', 'empty items and bare markers leave nothing');
assert.strictEqual(markdown('- \n- second'), '<ul><li>second</li></ul>', 'a blank first item does not hide the next');
assert.strictEqual(markdown('- one\n-\n- two'), '<ul><li>one</li><li>two</li></ul>', 'a bare marker inside a list is skipped');
assert.strictEqual(markdown('- one\n- \n- two'), '<ul><li>one</li><li>two</li></ul>', 'a blank item inside a list is skipped');
assert.strictEqual(markdown('1. one\n2. two'), '<ol><li>one</li><li>two</li></ol>', 'a real ordered list renders');
assert.strictEqual(markdown('- **bold** item'), '<ul><li><strong>bold</strong> item</li></ul>', 'items keep their inline Markdown');
assert.strictEqual(markdown('Step one\n\n- step\n\nDone.'), '<p>Step one</p>\n<ul><li>step</li></ul>\n<p>Done.</p>', 'the render around lists is unchanged');
assert.strictEqual(inline('- not a list'), '- not a list');

console.log('markdown: all checks passed');

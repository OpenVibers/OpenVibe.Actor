'use strict';
// The home on a phone (the owner's rule, 2026-10-31): the parts a reader rarely needs — the agents, how it works, the
// questions and what shipped — are folds that start open, with a checkbox and a label and no script. Nothing is hidden
// on a phone, and everything stays in the page for the crawlers.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { boot, check, done } = require('./helpers/boot');

(async () => {
    const t = await boot();

    await check('the home folds the agents, how it works, the questions and what shipped, and keeps them in the page', async () => {
        const r = await t.get('/');
        assert.strictEqual(r.status, 200, r.text.slice(0, 300));
        const home = r.text;
        for (const [id, title] of [['agents', 'The agents'], ['how', 'How it works'], ['faq', 'Questions'], ['shipped', 'Recently shipped on OpenVibe.Actor']]) {
            const re = new RegExp(`<div class="fold[^"]*" id="fold-${id}"><input class="fold-toggle" type="checkbox" id="fold-${id}-open" checked>`
                + `<label class="fold-h" for="fold-${id}-open"><h2[^>]*>[^<]*${title}[^<]*</h2>.*?<div class="fold-body">`);
            assert.ok(re.test(home), `the ${title} fold is on the home`);
        }
        // The parts themselves are in the page, not removed: the questions, the agents and what shipped.
        const faq = (/<section class="sc-sec" id="faq"[\s\S]*?<\/section>/.exec(home) || [''])[0];
        assert.ok((faq.match(/<summary>[^<]+<\/summary>/g) || []).length >= 6, 'the questions are in the page');
        assert.match(home, /id="h-agents"/, 'the agents keep their heading');
        assert.match(home, /data-ov-shipped="list"/, 'what shipped is in the page');
        // What the home keeps: the task box and the tasks to start from come first.
        assert.ok(home.indexOf('id="task"') < home.indexOf('id="fold-agents"'), 'the task box stays first');
        assert.match(home, /id="templates"/, 'the tasks to start from stay on the home');
    });

    await check('the fold starts open on every screen and a reader may close it', async () => {
        const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'home.css'), 'utf8');
        const fold = css.slice(css.indexOf('/* The fold (the owner'));
        assert.ok(fold.length > 0, 'the fold rules are in home.css');
        assert.match(fold, /\.fold-toggle:checked ~ \.fold-body \{ display: block; \}/, 'the open fold shows its body');
        assert.match(fold, /\.fold-toggle \{ display: none; \}/, 'the toggle is hidden where there is room');
        assert.match(fold, /\.fold-body \{ display: block; \}/, 'the body is open where there is room');
        assert.match(fold, /\.fold-bare > \.fold-h \{ display: none; \}/, 'a part with its own heading looks as it did');
        assert.match(fold, /\.fold-h > h2 \{[^}]*min-height:44px|min-height: 44px/, 'the title row is a 44 px target');
    });

    await t.close();
    done();
})().catch((e) => { console.error(e); process.exit(1); });

'use strict';
// Size budgets for openvibe.actor's home page (roadmap WS-T task 1, openvibe-shared/perf-budget): the
// server as it runs (a fresh database), measured without a browser. Budgets sit about 10% above the
// 2026-10-08 measurement (see below); raising one is a decision to state in the commit.
//   node test/perf-budget.test.js
const assert = require('assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { measure, check, format } = require('openvibe-shared/perf-budget');

// Budgets are set from the numbers measured on 2026-10-08 (the real ones, fresh database), rounded up with about 10%
// headroom; file counts are the measured counts and external files stay at 0.
const BUDGETS = {
    htmlRawKB: 75, // 75 openvibe-shared v4.201.0 (2026-11-11: measured 74.6, raised by pin-bump from 74.5); 74.5: measured 74.3 with 2026-11-11: openvibe-shared 4.190.0 (the site name's dropdown, the footer's online strip, the balances pill); 72.9: measured 70.9 with openvibe-shared 4.163.0, plus room for 4.162.0–4.163.0, 2026-11-09
                       // 53.2 with the rich home (10-22): numbers, task templates, the 34 Tools chips, the API samples, the questions
    htmlBrotliKB: 15.8, // 15.8: CI Node 22.22.1 measures 15.7 with Shared 4.202.0 (2026-11-11); 15.6: measured 15.1 with openvibe-shared 4.163.0, plus room for 4.162.0–4.163.0, 2026-11-09
    jsFiles: 5,   // 5 (theme-loader, web-runtime, navbar, footer, boost: openvibe-shared/shell)
    jsRawKB: 394.5, // 394.5: measured 394.1 with openvibe-shared 4.197.0 (2026-11-10: the menu's row of places, the You tab's row, the Sign in mark, the tooltip); 393: measured 392.5 with 2026-11-11: openvibe-shared 4.190.0 (the site name's dropdown, the footer's online strip, the balances pill); 376.7: measured 368.7 with openvibe-shared 4.163.0, plus room for 4.162.0–4.163.0, 2026-11-09
    jsBrotliKB: 94, // 94: measured 93.7 with 2026-11-11: openvibe-shared 4.190.0 (the site name's dropdown, the footer's online strip, the balances pill); 89.8: measured 89.7 KB brotli with openvibe-shared 4.186.0 (the mark's Working and Thinking states, the Dock and the menu as one sheet, bare controls), 2026-11-10; 89.5: measured 87.5 with openvibe-shared 4.163.0, plus room for 4.162.0–4.163.0, 2026-11-09
    cssFiles: 5,   // 5 with the shared kit.css and room.css (2026-10-29: the home as a taste and a door, 17 → 5.1 phone screens); 2 (actor.css + the cached /shared/showcase.css); 3 with home.css, the home's own sections (10-22)
    cssRawKB: 128.7, // 128.7: measured 123.7 with openvibe-shared 4.163.0, plus room for 4.162.0–4.163.0, 2026-11-09
    cssBrotliKB: 28.3, // 28.3: measured 27.1 with openvibe-shared 4.163.0, plus room for 4.162.0–4.163.0, 2026-11-09
    externalFiles: 0,   // 0
};

const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

(async () => {
    // A database of its own (not the shared dev PGlite in data/pglite, and not whatever the caller's
    // DATABASE_URL names), so the measurement is the server on a fresh database and the run leaves nothing.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-budget-'));
    const pgliteDir = path.join(dir, 'pglite');
    const port = await freePort();
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
        cwd: path.join(__dirname, '..'),
        env: {
            ...process.env, PORT: String(port), HOST: '127.0.0.1', NODE_ENV: 'test',
            DATABASE_URL: '', DATABASE_DIRECT_URL: '', VALKEY_URL: '', ACTOR_PGLITE_DIR: pgliteDir,
        },
        stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-2000); });
    const base = `http://127.0.0.1:${port}`;
    try {
        let up = false;
        for (let i = 0; i < 600 && !up; i++) {
            up = await fetch(`${base}/api/health`).then((r) => r.ok).catch(() => false);
            if (!up) await new Promise((r) => setTimeout(r, 100));
        }
        assert.ok(up, `the server did not start:\n${stderr}`);
        assert.ok(fs.existsSync(pgliteDir), 'the server did not use the isolated database (ACTOR_PGLITE_DIR)');
        const m = await measure({ base });
        const over = check(m, BUDGETS);
        assert.deepStrictEqual(over, [], format(m, over));
        console.log(format(m));
        console.log('perf budget: all checks passed');
    } finally {
        child.kill();
        fs.rmSync(dir, { recursive: true, force: true });
    }
})().catch((err) => { console.error(err); process.exitCode = 1; });

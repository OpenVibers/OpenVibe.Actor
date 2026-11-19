'use strict';

/**
 * Packages for script_run (plan §AD.26 item 6, heavy scripts on Run). A script that needs npm packages gets them as one
 * pinned job input, never from the network: the job runs with none.
 *
 *   parse(list)   ["lodash@4.17.21", "@scope/pkg@1.2.3"] → { specs, key } or { error }: exact versions only, ten at most
 *   bundle(list)  → { media_id, sha256, specs } or { error }
 *
 * bundle() installs the list once with npm (--ignore-scripts: no package's install script ever runs here; the public
 * registry only; no lockfile, no audit), packs node_modules as a gzipped ustar of files and folders only (links such as
 * .bin are left out), stores it in Media, unlisted, under Actor's tenant (11-19: it is public npm code, so any Link reads
 * it at Media's public address with no key, Link v0.83; as a private object no Link could), and keeps { media_id, sha256 } for that exact
 * list for a week, so the next script with the same packages starts at once. Link's skill runner 1.2.0 unpacks it
 * beside the code (it refuses links, climbing paths and other entries itself). Native addons will not load there.
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { spawn } = require('child_process');

const MAX_PACKAGES = 10;
const MAX_UNPACKED = 200 * 1024 * 1024;
const MAX_PACKED = 64 * 1024 * 1024;
const MAX_ENTRIES = 50_000;
const KEEP_MS = 7 * 24 * 3600_000;
const INSTALL_MS = 120_000;
// npm's own name rules (lowercase, URL-safe, an optional scope), and an exact MAJOR.MINOR.PATCH with an optional
// pre-release: never a range, a tag, a URL, a path or a git address.
const NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
const VERSION = /^\d{1,6}\.\d{1,6}\.\d{1,6}(?:-[0-9A-Za-z.-]{1,40})?$/;
const REGISTRY = 'https://registry.npmjs.org/';

function parse(list) {
    if (list == null) return { specs: [], key: null };
    if (!Array.isArray(list)) return { error: 'packages is a list like ["lodash@4.17.21"]' };
    if (list.length > MAX_PACKAGES) return { error: `at most ${MAX_PACKAGES} packages` };
    const specs = [];
    for (const raw of list) {
        const s = String(raw == null ? '' : raw).trim();
        const at = s.lastIndexOf('@');
        const name = at > 0 ? s.slice(0, at) : '';
        const version = at > 0 ? s.slice(at + 1) : '';
        if (!name || name.length > 214 || !NAME.test(name)) return { error: `"${s.slice(0, 80)}" is not an npm package name with its version` };
        if (!VERSION.test(version)) return { error: `${name} needs an exact version, like ${name}@1.2.3 (no ranges or tags)` };
        if (specs.some((x) => x.startsWith(`${name}@`))) return { error: `${name} is listed twice` };
        specs.push(`${name}@${version}`);
    }
    specs.sort();
    return { specs, key: specs.length ? crypto.createHash('sha256').update(specs.join('\n')).digest('hex') : null };
}

/** One ustar header: files ('0') and folders ('5'), mtime 0, owner 0, mode 0644/0755; null when the path cannot fit. */
function header(name, size, type) {
    let base = name;
    let prefix = '';
    if (Buffer.byteLength(name) > 100) {
        const cut = name.lastIndexOf('/', name.length - 2);
        if (cut < 0) return null;
        prefix = name.slice(0, cut);
        base = name.slice(cut + 1);
        if (Buffer.byteLength(prefix) > 155 || Buffer.byteLength(base) > 100) return null;
    }
    const h = Buffer.alloc(512);
    h.write(base, 0, 100, 'utf8');
    h.write(`${type === '5' ? '0000755' : '0000644'}\0`, 100, 8, 'ascii');
    h.write('0000000\0', 108, 8, 'ascii');
    h.write('0000000\0', 116, 8, 'ascii');
    h.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii');
    h.write('00000000000\0', 136, 12, 'ascii');
    h.write(type, 156, 1, 'ascii');
    h.write('ustar\0', 257, 6, 'ascii');
    h.write('00', 263, 2, 'ascii');
    if (prefix) h.write(prefix, 345, 155, 'utf8');
    h.fill(' ', 148, 156);
    let sum = 0;
    for (const b of h) sum += b;
    h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
    return h;
}

/** A folder as a gzipped ustar of its files and folders (sorted, so the same folder packs the same), or { error }. */
function pack(dir) {
    const blocks = [];
    let total = 0;
    let entries = 0;
    const walk = (rel) => {
        const names = fs.readdirSync(path.join(dir, rel)).sort();
        for (const n of names) {
            const r = rel ? `${rel}/${n}` : n;
            const st = fs.lstatSync(path.join(dir, r));
            if (st.isSymbolicLink() || (!st.isFile() && !st.isDirectory())) continue;
            if (++entries > MAX_ENTRIES) throw new Error(`the packages hold more than ${MAX_ENTRIES} files`);
            if (st.isDirectory()) {
                const h = header(`${r}/`, 0, '5');
                if (!h) throw new Error(`a package path is too long to pack: ${r.slice(0, 120)}`);
                blocks.push(h);
                walk(r);
                continue;
            }
            total += st.size;
            if (total > MAX_UNPACKED) throw new Error('the packages are larger than 200 MB unpacked');
            const h = header(r, st.size, '0');
            if (!h) throw new Error(`a package path is too long to pack: ${r.slice(0, 120)}`);
            const body = fs.readFileSync(path.join(dir, r));
            blocks.push(h, body, Buffer.alloc((512 - (body.length % 512)) % 512));
        }
    };
    walk('');
    blocks.push(Buffer.alloc(1024));
    const gz = zlib.gzipSync(Buffer.concat(blocks), { level: 9 });
    if (gz.length > MAX_PACKED) throw new Error('the packages are larger than 64 MB packed');
    return gz;
}

/** npm install of exact specs into dir: the public registry, no install scripts, no lockfile, no audit. */
function npmInstall(dir, specs, { npm = 'npm', timeoutMs = INSTALL_MS } = {}) {
    return new Promise((resolve) => {
        fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'ov-script', private: true }));
        const args = ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--no-package-lock', '--omit=dev', '--no-save',
            `--registry=${REGISTRY}`, '--loglevel=error', ...specs];
        const env = { PATH: process.env.PATH || '/usr/bin:/bin', HOME: dir, npm_config_cache: path.join(dir, '.npm-cache'), npm_config_userconfig: path.join(dir, '.npmrc-none') };
        let err = '';
        let done = false;
        const child = spawn(npm, args, { cwd: dir, env, stdio: ['ignore', 'ignore', 'pipe'] });
        const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } finish(false, 'npm took longer than two minutes'); }, timeoutMs);
        function finish(ok, why) {
            if (done) return;
            done = true;
            clearTimeout(timer);
            resolve(ok ? { ok: true } : { ok: false, error: why });
        }
        child.stderr.on('data', (c) => { if (err.length < 4000) err += c; });
        child.on('error', (e) => finish(false, `npm could not start: ${e.message}`));
        child.on('close', (code) => {
            if (code === 0) return finish(true);
            const line = err.split('\n').map((l) => l.replace(/^npm (ERR!|error) ?/, '').trim()).filter(Boolean).find((l) => /404|ETARGET|not found|No matching version|E\d{3}/i.test(l)) || err.trim().split('\n').pop() || `exit ${code}`;
            finish(false, `npm could not install them: ${line.slice(0, 240)}`);
        });
    });
}

function createScriptPackages({ media, npm = 'npm', now = () => Date.now(), install = npmInstall, log = console } = {}) {
    const kept = new Map();      // key → { media_id, sha256, at }
    const building = new Map();  // key → Promise

    async function build(specs, key) {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-script-pkgs-'));
        try {
            const done = await install(dir, specs, { npm });
            if (!done.ok) return { error: done.error };
            const modules = path.join(dir, 'node_modules');
            if (!fs.existsSync(modules)) return { error: 'npm installed nothing' };
            let gz;
            try { gz = pack(modules); } catch (e) { return { error: e.message }; }
            const stored = await media.putBytes(gz, { name: `packages-${key.slice(0, 12)}.tgz`, mimeType: 'application/gzip', visibility: 'unlisted' });
            if (!stored || stored.error) return { error: (stored && stored.error) || 'OpenVibe.Media did not store the packages' };
            const out = { media_id: stored.id, sha256: stored.sha256, at: now() };
            kept.set(key, out);
            if (kept.size > 200) kept.delete(kept.keys().next().value);
            return out;
        } finally {
            fs.rm(dir, { recursive: true, force: true }, () => {});
        }
    }

    async function bundle(list) {
        const p = parse(list);
        if (p.error) return { error: p.error };
        if (!p.key) return { error: 'no packages' };
        if (!media || !media.enabled || typeof media.putBytes !== 'function') return { error: 'OpenVibe.Media is not connected on this server, so packages cannot be passed to a script' };
        const had = kept.get(p.key);
        if (had && now() - had.at < KEEP_MS) return { media_id: had.media_id, sha256: had.sha256, specs: p.specs };
        if (!building.has(p.key)) {
            building.set(p.key, build(p.specs, p.key).catch((e) => ({ error: `the packages could not be prepared: ${e && e.message}` })).finally(() => building.delete(p.key)));
        }
        const out = await building.get(p.key);
        if (out.error) {
            if (log.warn) log.warn(`[script_run] packages ${p.specs.join(' ')}: ${out.error}`);
            return { error: out.error };
        }
        return { media_id: out.media_id, sha256: out.sha256, specs: p.specs };
    }

    return { parse, bundle };
}

module.exports = { createScriptPackages, parse, pack, header, npmInstall, MAX_PACKAGES };

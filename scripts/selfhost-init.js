#!/usr/bin/env node
'use strict';
/**
 * Set up a self-hosted Actor (docs/self-host.md): writes .env.selfhost (mode 600) with the owner, their password's
 * hash, their API token, the session secret and the model settings, and prints the password and the token once.
 * It never overwrites an existing file.
 *
 *   npm run selfhost:init -- [--name alex] [--url http://localhost:4950] [--runtime-url http://ollama:11434/v1]
 *                            [--model qwen2.5:7b-instruct] [--out .env.selfhost]
 *
 * ACTOR_INIT_PASSWORD in the environment sets the password instead of a generated one (it is then not printed).
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { ids } = require('openvibe-contracts');
const { hashPassword } = require('../server/auth/local');

function args(argv) {
    const out = {};
    for (let i = 0; i < argv.length; i++) {
        const m = /^--([a-z-]+)$/.exec(argv[i]);
        if (!m) throw new Error(`unknown argument ${argv[i]}`);
        out[m[1]] = argv[++i];
        if (out[m[1]] === undefined) throw new Error(`--${m[1]} needs a value`);
    }
    return out;
}

function main() {
    const a = args(process.argv.slice(2));
    const file = path.resolve(a.out || '.env.selfhost');
    if (fs.existsSync(file)) throw new Error(`${file} exists: nothing written (delete it first to start over)`);
    const name = String(a.name || 'owner').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 64) || 'owner';
    const url = String(a.url || 'http://localhost:4950').replace(/\/+$/, '');
    if (!/^https?:\/\/[^/\s]+$/.test(url)) throw new Error('--url is the address people open, like https://actor.example.org');
    const given = process.env.ACTOR_INIT_PASSWORD || '';
    const password = given || crypto.randomBytes(15).toString('base64url');
    const token = `act_${crypto.randomBytes(32).toString('base64url')}`;
    const lines = [
        '# A self-hosted OpenVibe.Actor (docs/self-host.md). Keep this file private: it holds the owner\'s secrets.',
        'ACTOR_SELF_HOSTED=1',
        'NODE_ENV=production',
        'HOST=0.0.0.0',
        'PORT=4950',
        `BASE_URL=${url}`,
        `COOKIE_SECURE=${url.startsWith('https://') ? 'true' : 'false'}`,
        'TRUST_PROXY=1',
        'DATA_DIR=/data',
        `ACTOR_OWNER_NAME=${name}`,
        `ACTOR_OWNER_SUBJECT=usr_${ids.ulid(Date.now())}`,
        `ACTOR_OWNER_PASSWORD_HASH=${hashPassword(password)}`,
        `ACTOR_OWNER_TOKEN=${token}`,
        `ACTOR_SESSION_SECRET=${crypto.randomBytes(32).toString('base64url')}`,
        '# The runtime\'s model: any OpenAI-compatible endpoint (Ollama, llama.cpp, vLLM, a provider). Prices are per',
        '# million tokens, 0 for your own hardware.',
        `ACTOR_RUNTIME_URL=${String(a['runtime-url'] || 'http://ollama:11434/v1').replace(/\/+$/, '')}`,
        `ACTOR_RUNTIME_MODEL=${a.model || 'qwen2.5:7b-instruct'}`,
        'ACTOR_RUNTIME_API_KEY=',
        'ACTOR_RUNTIME_INPUT_USD_PER_MTOK=0',
        'ACTOR_RUNTIME_OUTPUT_USD_PER_MTOK=0',
        '# OpenVibe\'s public Search and Tools APIs, used anonymously; leave both empty to stay fully offline.',
        'ACTOR_SEARCH_URL=https://search.openvibe.network',
        'ACTOR_TOOLS_URL=https://openvibe.tools',
        '# Optional: other agents (their keys are yours; each adds its own family to check answers with).',
        'ACTOR_DEEPSEEK_API_KEY=',
        'ACTOR_OPENAI_API_KEY=',
        '# The free tier and the daily ceiling still apply to the owner (USD; 0-cost models never reach them).',
        'ACTOR_FREE_TASKS_PER_DAY=500',
        'ACTOR_FREE_PER_TASK_USD=0.5',
        'ACTOR_FREE_PER_DAY_USD=5',
        'ACTOR_MAX_COST_USD_PER_DAY=5',
        '',
    ];
    fs.writeFileSync(file, lines.join('\n'), { mode: 0o600, flag: 'wx' });
    console.log(`Wrote ${file} (mode 600).`);
    console.log(`Sign in at ${url}/auth/login as ${name}.`);
    if (!given) console.log(`Password (shown once): ${password}`);
    console.log(`API token (shown once; Authorization: Bearer …): ${token}`);
}

try { main(); } catch (err) { console.error(err.message); process.exitCode = 1; }

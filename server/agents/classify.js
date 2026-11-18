'use strict';

/**
 * What kind of task this is, so the router knows what an agent must be able to do (a hard requirement, ADR-044 §4):
 *
 *   code      write, fix or review code                         → task:code
 *   web       needs a live web search (recent, prices, news)    → task:web
 *   lookup    facts about a domain, address or site             → task:lookup
 *   research  read the pages it names, or OpenVibe's content    → task:research
 *   answer    write or explain from what a model knows          → task:answer
 *   robot     make the person's own OpenVibe.Bot robot act       → task:robot
 *   computer  use the person's own computer (files, programs)   → task:computer
 *
 * heuristic(task) is free and is what private mode and the public dry run use. classify() asks, in order:
 *   1. OpenVibe.AI's Decisions API (plan §AD.27 item 6, "Decisions where they help"): one closed question, "which of
 *      these seven", answered with probabilities; its pick stands when it is at least 45% sure;
 *   2. a cheap model, when the Decisions API is unsure, down or not configured;
 *   3. the heuristic, on any failure.
 * An answer is kept a day per task text (only its hash and the class: the same words are the same kind of task), so a
 * retried or repeated ask costs nothing to sort. What it cost is part of the task's.
 */
const crypto = require('crypto');

const CLASSES = ['answer', 'lookup', 'research', 'web', 'code', 'robot', 'computer'];
// The seven, as the Decisions API reads them: what each class means, in one line.
const MEANINGS = {
    answer: 'Writing, explaining, advice, maths: anything a capable model can do from what it knows.',
    lookup: 'Facts about a specific domain, website, IP address or server (DNS, mail records, certificates, headers, ownership, robots.txt).',
    research: 'Read the specific web pages it links to, or OpenVibe\'s own content, and report.',
    web: 'Needs searching the live web: anything recent or changing (news, prices, releases, schedules, people\'s current roles).',
    code: 'Write, change, debug or review source code.',
    robot: 'Make the person\'s own robot on OpenVibe.Bot do something or report on it. Commanding a robot is never code.',
    computer: 'Use the person\'s own computer through OpenVibe.Bot: its files or programs. Never code unless a repository is named.',
};
const SURE = 0.45;
const KEEP_MS = 24 * 3600e3;
const KEEP_MAX = 5000;
const kept = new Map();   // sha256(task) → { class, at }
const keyOf = (task) => crypto.createHash('sha256').update(String(task || '').trim().replace(/\s+/g, ' ').toLowerCase().slice(0, 4000)).digest('hex');
function remember(key, cls) {
    kept.delete(key);
    kept.set(key, { class: cls, at: Date.now() });
    if (kept.size > KEEP_MAX) kept.delete(kept.keys().next().value);
}

const CODE = /\b(code|function|bug|stack ?trace|refactor|unit tests?|pull request|repo(sitory)?|compile|typescript|javascript|python|golang|rust|java|sql query|regex|script|api endpoint|implement)\b|```/i;
const LOOKUP = /\b(dns|mx|spf|dkim|dmarc|whois|rdap|nameservers?|ssl|tls|certificate|headers?|redirects?|ip address|asn|geoip|reverse dns|ptr|ttl|robots\.txt|sitemap|uptime|ping|traceroute|port \d+|hosting provider|registrar)\b/i;
const DOMAINISH = /\b(?:[a-z0-9-]+\.)+[a-z]{2,}\b|\b\d{1,3}(?:\.\d{1,3}){3}\b/i;
const WEB = /\b(latest|today|tonight|yesterday|this week|this month|current(ly)?|right now|news|price of|stock|weather|score|election|released?|recent(ly)?|202\d|trending|search the web|look up online|compare prices)\b/i;
const URL = /https?:\/\/\S+/i;
const ROBOT = /\b(my robots?|the robot|robot_steps|rob_[0-9A-HJKMNP-TV-Z]{26}|openvibe\.bot|rover|cozmo)\b/i;
// The person's own computer through OpenVibe.Bot (agents/computers.js). A task that names a repository to change is
// coding (OpenVibe.Codes runs it on the person's machine), not this.
const COMPUTER = /\b(my (own )?(computers?|laptop|desktop|pc|workstation|server|machine)|on my (computer|laptop|desktop|pc|machine)|list_my_computers|computer_(run|read|list|write)|dev_[0-9A-HJKMNP-TV-Z]{26})\b/i;
const REPO = /github\.com|gitlab\.com|codeberg\.org|\brepo(sitory)?\b|pull request/i;
const RESEARCH = /\b(summari[sz]e|read|according to|sources?|cite|citations?|brief|report on|research)\b/i;

function heuristic(task) {
    const t = String(task || '');
    if (ROBOT.test(t) && !/```/.test(t)) return 'robot';
    if (COMPUTER.test(t) && !REPO.test(t) && !/```/.test(t)) return 'computer';
    if (CODE.test(t)) return 'code';
    if (LOOKUP.test(t) && DOMAINISH.test(t)) return 'lookup';
    if (URL.test(t)) return 'research';
    if (WEB.test(t)) return 'web';
    if (RESEARCH.test(t)) return 'web';
    return 'answer';
}

const SYSTEM = `You sort one task for an agent router. Reply with JSON only: {"class": "<one of answer|lookup|research|web|code|robot|computer>"}.
answer: writing, explaining, advice, maths, anything a capable model can do from what it knows.
lookup: facts about a specific domain, website, IP address or server (DNS, mail records, certificates, headers, ownership, robots.txt).
research: read the specific web pages it links to, or OpenVibe's own content, and report.
web: needs searching the live web: anything recent or changing (news, prices, releases, schedules, people's current roles).
code: write, change, debug or review source code.
robot: make the person's own robot on OpenVibe.Bot do something or report on it (drive, turn, speak, lights, show a face, its sensors or battery). Commanding a robot is never code.
computer: use the person's own computer through OpenVibe.Bot: list or read its files, run a program there, write a file there, or report what is on it. Using their computer is never code, unless the task names a repository to change.`;

/**
 * classify(task, { decide, chat }) → { class, cost_usd, by, sure? }. `decide` is the models layer's Decisions call
 * (runtime/models.js decide) or null; `chat` a provider client (server/agents/providers.js) or null. `by` is
 * decisions, model, cache or heuristic.
 */
async function classify(task, { chat = null, decide = null, signal } = {}) {
    const guess = heuristic(task);
    const key = keyOf(task);
    const hit = kept.get(key);
    if (hit && Date.now() - hit.at < KEEP_MS) return { class: hit.class, cost_usd: 0, by: 'cache' };
    let spent = 0;
    if (decide) {
        try {
            const d = await decide({
                input: String(task).slice(0, 4000), model: 'auto', kind: 'other',
                questions: { class: { type: 'choice', instructions: 'Which kind of task is this, for an agent router? Pick the one that fits best.', criteria: MEANINGS } },
            }, { signal });
            spent += Number(d && d.receipt && d.receipt.cost_usd) || 0;
            const a = d && d.answers && d.answers.class;
            const sure = a && a.probabilities ? Number(a.probabilities[a.choice]) : NaN;
            if (a && CLASSES.includes(a.choice) && (!Number.isFinite(sure) || sure >= SURE)) {
                remember(key, a.choice);
                return { class: a.choice, cost_usd: spent, by: 'decisions', ...(Number.isFinite(sure) ? { sure } : {}) };
            }
        } catch { /* unsure or down: the model decides */ }
    }
    if (!chat) return { class: guess, cost_usd: spent, by: 'heuristic' };
    try {
        const r = await chat({
            messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: String(task).slice(0, 4000) }],
            json: true, maxTokens: 60, signal,
        });
        const m = String(r.text || '').match(/\{[\s\S]*\}/);
        const parsed = JSON.parse(m ? m[0] : '');
        const cls = CLASSES.includes(parsed.class) ? parsed.class : guess;
        if (CLASSES.includes(parsed.class)) remember(key, cls);
        return { class: cls, cost_usd: spent + (r.cost_usd || 0), by: 'model' };
    } catch {
        return { class: guess, cost_usd: spent, by: 'heuristic' };
    }
}

/** Forget what was kept (tests). */
const forget = () => kept.clear();

const requirementFor = (cls) => `task:${CLASSES.includes(cls) ? cls : 'answer'}`;

module.exports = { classify, heuristic, requirementFor, forget, CLASSES, MEANINGS };

'use strict';

/**
 * The registry's scan (plan HO2, ADR-058): what the registry found in a skill before anybody installs it.
 *
 * The scan is DETERMINISTIC and reads no model: five rules over the document's own words. It is not a judgement of
 * whether a skill is any good; it is a check of the trust surface — what the skill asks an agent to do, what it asks
 * the person for, where it would send things, and whether a resource is really text.
 *
 *   asks.undeclared_kind   the words ask for an act whose HO1 kind (agents/kinds.js) is not in requires.kinds.
 *                          A skill DECLARES what it may ask for; a step of an undeclared kind is a finding.
 *   text.secret_request    the words ask the person for a password, a key, a token or a seed phrase. Block.
 *   text.exfil             the words ask for files, notes or credentials to be sent to an address or a URL. Block.
 *   resource.code          a resource reads as a script. A v1 skill is a prompt and nothing else. Block.
 *   hosts.undeclared       a URL outside requires.hosts.
 *
 * A block finding fails the skill (it never installs); a warning flags it (the person reads the findings and
 * confirms); no finding passes it (it installs in one tap).
 *
 * Two things the scan is careful about:
 *   - a BLOCK rule reads no negation at all: a sentence that pairs a secret with asking, or a payload with sending
 *     and a destination, is a finding whatever else it says ("Do not hesitate to send your passwords to …" asks
 *     for them); the asks rule skips only an act negated right before it ("never send"), never a negation
 *     elsewhere in the sentence; the hosts rule skips a sentence that names a host to keep away from it;
 *   - `requires` declares and grants nothing. A skill that declares the kind publish still asks the person for
 *     every publish (HO1); the scan only says whether the words and the declaration agree.
 */
// The acts a skill's words may ask for, and the HO1 kind each one is. A deletion is a change on the person's
// machine, so it is checked against computer.write: HO1 has no delete kind, and a deletion is an always-ask floor
// (levels.js) whatever the skill declares.
const ACTS = [
    { kind: 'send', what: 'send something to someone', re: /\b(send|sends|sending|email|emails|forward|forwards|dm|dms)\b/i },
    { kind: 'post', what: 'post on an OpenVibe site', re: /\b(post|posts|posting|reply|replies|comment|comments)\b/i },
    { kind: 'publish', what: 'publish for others to see', re: /\b(publish|publishes|publishing|publication)\b/i },
    { kind: 'money', what: 'spend money', re: /\b(pay|pays|paying|payment|payments|purchase|purchases|buy|buys|buying|checkout|charge|charges|refund|spend|spends|spending)\b/i },
    { kind: 'computer.write', what: 'delete or change a file', re: /\b(delete|deletes|deleting|erase|erases|wipe|wipes)\b/i },
    { kind: 'computer.run', what: 'run a program', re: /\b(run|runs|running|execute|executes)\b[^.\n]{0,40}\b(command|commands|script|scripts|program|programs|shell|terminal)\b/i },
    { kind: 'install', what: 'install something', re: /\b(install|installs|installing)\b/i },
    { kind: 'routine', what: 'set up a task that keeps running', re: /\b(schedule|schedules|scheduling|recurring|repeats|daily|weekly|every day|every week|each day|each week|every morning)\b/i },
    { kind: 'space', what: "change the person's own Space", re: /\b(your space|your spaces|openvibe\.space)\b/i },
    { kind: 'codes.task', what: "start a coding task on the person's machine", re: /\b(coding task|code task|refactor|refactors|debug|debugs)\b/i },
    { kind: 'robot.move', what: "move the person's robot", re: /\b(your robot|the robot|robot steps)\b/i },
];

// The words that mean the skill is asking for something.
const ASK = /\b(ask|asks|asking|request|requests|requesting|require|requires|requiring|need|needs|needing|insist|insists|demand|demands|prompt|prompts|provide|provides|supply|supplies|enter|enters|give|gives)\b/i;
// The words that name a secret.
const SECRET = /\b(password|passwords|passcode|passphrase|seed phrase|recovery phrase|private key|api[ _-]?key|secret key|access token|refresh token|auth token|bearer token|session token|credentials|credential|2fa code|one-time code)\b/i;
// The words that move something out of the person.
const SEND = /\b(send|sends|sending|email|emails|forward|forwards|upload|uploads|transmit|transmits|paste|pastes|mail|mails|exfiltrate|leak|leaks)\b/i;
// What would be moved.
const PAYLOAD = /\b(file|files|note|notes|document|documents|record|records|recording|recordings|transcript|history|contacts|password|passwords|credentials|credential|secret|secrets|api key|api keys|token|tokens|seed phrase|data)\b/i;
// Where it would go.
const DESTINATION = /(https?:\/\/[^\s)]+)|(\b[\w.+-]+@[\w-]+\.[a-z]{2,}\b)|\b(your email|your email address|your inbox|an email address|the recipient|a webhook|an external (site|server|service)|a third party|a paste site|somebody else|another server)\b/i;
// An act is negated only by a negation RIGHT BEFORE it: "never send", "do not post", "without publishing". The
// negation may itself be two words ("do not"); another word between it and the act means the act is still asked for.
const NEGATED_BEFORE = /\b(?:never|not|none|without|refuse|refuses|refusing|do not|does not|don'?t|cannot|can'?t|instead of|rather than)\s+$/i;
// A URL is named to keep away from it only when a negation stands right before it, or one word before it ("never
// open https://x").
const NEGATED_NEAR = /\b(?:never|not|without|do not|does not|don'?t|cannot|can'?t|instead of|rather than)\s+(?:[a-z]+\s+)?$/i;

// A URL in the text, and the host it points at.
const URL = /https?:\/\/([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+)/gi;

// A resource that reads as a script. A v1 skill carries text, never code to run.
const SCRIPT = [
    /^#!\s*(python|node|bash|sh|zsh|perl|ruby|php|pwsh)/m,
    /\b(eval|exec)\s*\(/,
    /\bos\.system\b|\bsubprocess\.\w+|\bchild_process\b/,
    /\bimport\s+(os|sys|subprocess|socket|requests)\b/,
    /\b(curl|wget)\b[^\n]{0,80}\|\s*(sh|bash|zsh)/,
    /\brm\s+-rf\b|\bchmod\s+\+x\b/,
    /\b(npm|pip|gem)\s+(install|run)\b/,
    /```\s*(bash|sh|shell|zsh|python|py|js|javascript|node|ruby|perl|php|powershell|ps1)\b/i,
    /\bconsole\.log\s*\(|\bfunction\s+\w+\s*\(/,
];

const SCANNER = 'actor-skill-scan/1';
const SEVERITY = { block: 'failed', warn: 'flagged' };

/** The sentences of a text: a rule reads a sentence, never the whole document at once. */
function sentences(text) {
    return String(text || '')
        .split(/(?<=[.!?])\s+|\n+/)
        .map((s) => s.trim())
        .filter(Boolean);
}

/** Is the act at `at` negated right before it? "never send" yes; "not hard to send" no. */
function negatedBefore(sentence, at) {
    return NEGATED_BEFORE.test(String(sentence).slice(0, at));
}

/** Does the sentence ask for this act, not counting only the occurrences negated right before them? */
function asksAct(act, sentence) {
    const re = new RegExp(act.re.source, act.re.flags.includes('g') ? act.re.flags : act.re.flags + 'g');
    for (const match of sentence.matchAll(re)) {
        if (!negatedBefore(sentence, match.index)) return true;
    }
    return false;
}

/** A host is declared when it is one of the hosts the skill says, or a subdomain of one of them. */
function declared(host, hosts) {
    const h = String(host || '').toLowerCase();
    return hosts.some((x) => {
        const d = String(x || '').toLowerCase();
        return d === h || h.endsWith('.' + d);
    });
}

const finding = (rule, severity, where, note) => ({ rule, severity, where, note: String(note).slice(0, 280) });

/**
 * The scan of one document: its state and its findings. The findings are what the listing carries to every site
 * (actor.skill-listing@1): the state is the answer, the findings are the reason.
 */
function scan(doc) {
    const findings = [];
    const skill = doc || {};
    const requires = skill.requires || {};
    const declaredKinds = Array.isArray(requires.kinds) ? requires.kinds : [];
    const declaredHosts = Array.isArray(requires.hosts) ? requires.hosts : [];
    const description = String(skill.description || '');
    const instructions = String(skill.instructions || '');
    const resources = Array.isArray(skill.resources) ? skill.resources : [];

    // ── asks.undeclared_kind ──────────────────────────────────────────────────────────────────────────────
    // The words ask for an act; every act has a kind; a kind the skill did not declare is a finding.
    const texts = [['description', description], ['instructions', instructions]];
    for (const [where, text] of texts) {
        for (const sentence of sentences(text)) {
            for (const act of ACTS) {
                if (!asksAct(act, sentence)) continue;
                if (declaredKinds.includes(act.kind)) continue;
                findings.push(finding('asks.undeclared_kind', 'warn', where,
                    `It asks to ${act.what} (the kind ${act.kind}), which its requires does not declare.`));
            }
        }
    }

    // ── text.secret_request and text.exfil ─────────────────────────────────────────────────────────────────
    // A block rule takes no negation: "do not hesitate to send your passwords" is still asking for them.
    for (const [where, text] of texts) {
        for (const sentence of sentences(text)) {
            if (ASK.test(sentence) && SECRET.test(sentence)) {
                findings.push(finding('text.secret_request', 'block', where,
                    'It asks the person for a secret: a password, a key, a token or a seed phrase.'));
            }
            if (SEND.test(sentence) && PAYLOAD.test(sentence)) {
                const credential = /\b(password|passwords|credentials|credential|secret|secrets|api key|api keys|token|tokens|seed phrase)\b/i.test(sentence);
                if (credential || DESTINATION.test(sentence)) {
                    findings.push(finding('text.exfil', 'block', where,
                        credential
                            ? 'It asks for credentials to be sent somewhere.'
                            : 'It asks for the person\'s files, notes or data to be sent to an address or a URL.'));
                }
            }
        }
    }

    // ── resource.code ─────────────────────────────────────────────────────────────────────────────────────
    for (const resource of resources) {
        const text = String((resource && resource.text) || '');
        if (!SCRIPT.some((re) => re.test(text))) continue;
        findings.push(finding('resource.code', 'block', String(resource.path || 'a resource'),
            'This resource reads as a script. A v1 skill is instructions and text only: it runs nothing.'));
    }

    // ── hosts.undeclared ───────────────────────────────────────────────────────────────────────────────────
    const seen = new Set();
    for (const [where, text] of [...texts, ...resources.map((r) => [String(r.path || 'a resource'), String(r.text || '')])]) {
        for (const sentence of sentences(text)) {
            for (const match of sentence.matchAll(URL)) {
                // A host named to keep away from it ("never open https://x", "instead of https://x") is not reached.
                // Only a negation right before it counts, with at most one word between: "Do not wait: fetch
                // https://x" still reaches x (a negation elsewhere in the sentence used to hide the host).
                if (NEGATED_NEAR.test(sentence.slice(0, match.index))) continue;
                const host = String(match[1] || '').toLowerCase();
                if (!host || seen.has(host)) continue;
                if (declared(host, declaredHosts)) continue;
                seen.add(host);
                findings.push(finding('hosts.undeclared', 'warn', where,
                    `It reaches ${host}, which its requires does not declare.`));
            }
        }
    }

    const blocked = findings.some((f) => f.severity === 'block');
    const warned = findings.some((f) => f.severity === 'warn');
    return {
        state: blocked ? SEVERITY.block : warned ? SEVERITY.warn : 'passed',
        scanner: SCANNER,
        findings: findings.slice(0, 50),
    };
}

/** The scan as the listing carries it: the state, the scanner, when it ran and what it found. */
const report = (doc, at) => {
    const out = scan(doc);
    return { state: out.state, scanner: out.scanner, scanned_at: at || new Date().toISOString(), findings: out.findings };
};

module.exports = { ACTS, RULES: ['asks.undeclared_kind', 'text.secret_request', 'text.exfil', 'resource.code', 'hosts.undeclared'], SCANNER, scan, report, declared, sentences };

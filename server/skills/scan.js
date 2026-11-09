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

const SCANNER = 'actor-skill-scan/2';
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

// ── Code rules (ADR-060) ─────────────────────────────────────────────────────────────────────────────────
// A sandbox tool's code is read, never run. A block finding fails the skill; a warn flags it, and a flagged code
// skill installs only after the person reads the findings. Every code finding names the tool it is about.
const CODE_RULES = ['code.env', 'code.process', 'code.dynamic', 'code.vm', 'code.worker', 'code.fs_write',
    'code.network', 'code.encoded', 'code.minified', 'code.require', 'code.timer', 'code.loop'];

// The only modules a v1 tool may require: Node's own, with no process, no child, no worker and no raw socket. `fs`
// is here because reading the job directory is allowed by the Link sandbox; the scan blocks every write below.
const SAFE_REQUIRE = new Set(['assert', 'buffer', 'crypto', 'events', 'fs', 'path', 'punycode', 'querystring', 'stream', 'string_decoder', 'url', 'util', 'zlib']);
const REQUIRE = /\brequire\s*\(\s*(['"])([^'"]+)\1\s*\)/g;
const REQUIRE_COMPUTED = /\brequire\s*\(\s*(?!['"])|\bmodule\s*\.\s*require\s*\(|\bcreateRequire\s*\(/;
const CHILD_PROCESS = /\brequire\s*\(\s*['"](?:node:)?child_process['"]\s*\)|\b(?:spawn|spawnSync|execFile|execFileSync|fork)\s*\(|\bprocess\s*\.\s*(?:binding|dlopen|kill|getBuiltinModule)\s*\(/;
const DYNAMIC_CODE = /\beval\s*\(|\bnew\s+Function\s*\(|\bFunction\s*\(\s*['"`]|\bimport\s*\(/;
const VM = /\brequire\s*\(\s*['"](?:node:)?vm['"]\s*\)|\b(?:runInContext|runInNewContext|runInThisContext|createContext)\s*\(/;
const WORKER = /\brequire\s*\(\s*['"](?:node:)?worker_threads['"]\s*\)|\bnew\s+Worker\s*\(/;
const FS_WRITE = /\bfs\s*\.\s*(?:promises\s*\.\s*)?(?:writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream|mkdir|mkdirSync|mkdtemp|mkdtempSync|rm|rmSync|unlink|unlinkSync|rename|renameSync|copyFile|copyFileSync|truncate|truncateSync|chmod|chmodSync|chown|chownSync|symlink|symlinkSync|link|linkSync|open|openSync|write|writeSync|writev|writevSync)\s*\(|\b(?:writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream|mkdirSync|mkdtempSync|rmSync|unlinkSync|renameSync|copyFileSync|truncateSync|chmodSync)\s*\(/;
const NETWORK_USE = /\bfetch\s*\(|\bXMLHttpRequest\b|\bWebSocket\b|\bnavigator\s*\.\s*sendBeacon\b|\brequire\s*\(\s*['"](?:node:)?(?:http|https|net|tls|dns|dgram)['"]\s*\)|\bhttps?\s*\.\s*(?:get|request)\s*\(/;
const TIMER = /\bset(?:Timeout|Interval)\s*\([^,]+,\s*([0-9][0-9_]*)\s*[,)]/g;
const LOOP_OVER_INPUT = /\b(?:for|while)\s*\([^)]*\b(?:input|args|raw)\b[^)]*\)|\.(?:forEach|map|filter|reduce)\s*\(\s*(?:input|args|raw)\b/;
const OPENVIBE_HOST = /^([a-z0-9-]+\.)*openvibe\.[a-z]{2,}$/;
const CODE_MARKERS = /\b(?:eval|Function|require|process\s*\.|child_process|import\s|atob|fromCharCode)\b|#!|<script/i;

/** Is this host one of OpenVibe's own? A tool that says openvibe-only may reach only these. */
const openvibeHost = (host) => OPENVIBE_HOST.test(String(host || '').toLowerCase());

/** Every host a piece of code names: a literal URL, or a host/hostname option. */
function hostsIn(code) {
    const hosts = new Set();
    for (const m of String(code).matchAll(/https?:\/\/([^/\s'"`)\\]{1,253})/g)) {
        const host = String(m[1] || '').split('@').pop().split(':')[0].split(/[?#]/)[0].replace(/[.,;]+$/, '').toLowerCase();
        if (host) hosts.add(host);
    }
    for (const m of String(code).matchAll(/\bhost(?:name)?\s*:\s*['"]([^'"]{1,253})['"]/g)) {
        const host = String(m[1] || '').split(':')[0].toLowerCase();
        if (host) hosts.add(host);
    }
    return [...hosts];
}

/** A long base64 or hex blob, and whether it decodes to something that looks like code. */
function encodedBlob(code) {
    const text = String(code || '');
    for (const m of text.matchAll(/['"`]([A-Za-z0-9+/=]{200,})['"`]/g)) {
        const blob = m[1];
        let decoded = '';
        try { decoded = Buffer.from(blob, 'base64').toString('utf8'); } catch { decoded = ''; }
        return { kind: CODE_MARKERS.test(decoded) ? 'code' : 'blob', encoding: 'base64', length: blob.length };
    }
    for (const m of text.matchAll(/\b[0-9a-fA-F]{200,}\b/g)) {
        const blob = m[0];
        let decoded = '';
        try { decoded = Buffer.from(blob, 'hex').toString('utf8'); } catch { decoded = ''; }
        return { kind: CODE_MARKERS.test(decoded) ? 'code' : 'blob', encoding: 'hex', length: blob.length };
    }
    return null;
}

/** The findings for one code resource, as the tool that runs it. */
function scanCode(resource, tool) {
    const code = String((resource && resource.text) || '');
    const where = String((resource && resource.path) || 'a resource');
    const toolName = tool && tool.name ? String(tool.name) : null;
    const net = (tool && tool.net) || 'deny';
    const out = [];
    const add = (rule, severity, note) => out.push({ rule, severity, ...(where ? { where } : {}), ...(toolName ? { tool: toolName } : {}), note: String(note).slice(0, 280) });

    if (/process\s*\.\s*env\b/.test(code) || /process\s*\[\s*['"]env['"]\s*\]/.test(code)) {
        add('code.env', 'block', 'It reads process.env. A skill tool never sees a secret or the environment it runs in.');
    }
    if (CHILD_PROCESS.test(code)) {
        add('code.process', 'block', 'It starts another process (child_process). A tool runs one process in its sandbox, never a child.');
    }
    if (DYNAMIC_CODE.test(code)) {
        add('code.dynamic', 'block', 'It builds code at run time (eval, Function or a dynamic import). The sandbox forbids it, and the registry will not list it.');
    }
    if (VM.test(code)) {
        add('code.vm', 'block', 'It loads Node\'s vm module, which runs code outside the permission model.');
    }
    if (WORKER.test(code)) {
        add('code.worker', 'block', 'It starts a worker thread. A tool gets one process and no worker.');
    }
    if (FS_WRITE.test(code)) {
        add('code.fs_write', 'block', 'It writes a file. A skill\'s code never writes to the machine: it takes JSON in and answers JSON out.');
    }
    const badModules = new Set();
    for (const m of code.matchAll(REQUIRE)) {
        const name = String(m[2] || '').replace(/^link:/, '');
        if (!SAFE_REQUIRE.has(name)) badModules.add(name);
    }
    if (badModules.size) {
        add('code.require', 'block', `It requires ${[...badModules].slice(0, 3).map((x) => JSON.stringify(x)).join(', ')}, which is not one of Node's safe modules (${[...SAFE_REQUIRE].join(', ')}).`);
    } else if (REQUIRE_COMPUTED.test(code)) {
        add('code.require', 'block', 'It requires a module whose name is computed, so the registry cannot tell what it loads.');
    }
    const blob = encodedBlob(code);
    if (blob) {
        add('code.encoded', 'block', blob.kind === 'code'
            ? `It carries a long ${blob.encoding} blob (${blob.length} characters) that decodes to code.`
            : `It carries a long ${blob.encoding} blob (${blob.length} characters). Code must be readable: the scan reads it, never runs it.`);
    }
    if (code.split(/\r?\n/).some((line) => line.length > 2048)) {
        add('code.minified', 'block', 'It has a line longer than 2 KB (minified code). The registry cannot read and scan minified code, so it will not list it.');
    }
    const network = NETWORK_USE.test(code);
    if (network) {
        const hosts = hostsIn(code);
        if (net === 'deny') {
            add('code.network', 'block', 'It uses the network, but its tool declares no internet access (net: deny).');
        } else if (net === 'openvibe-only') {
            const foreign = hosts.filter((h) => !openvibeHost(h));
            if (foreign.length) {
                add('code.network', 'block', `It reaches ${foreign.slice(0, 3).join(', ')}, which is not an OpenVibe site, but its tool says OpenVibe sites only.`);
            } else if (!hosts.length) {
                add('code.network', 'block', 'It uses the network but names no OpenVibe host, so the registry cannot tell where it goes; its tool says OpenVibe sites only.');
            } else {
                add('code.network', 'warn', `It uses the network (${hosts.slice(0, 3).join(', ')}); its tool says OpenVibe sites only. Read this before you install it.`);
            }
        } else if (net === 'public') {
            add('code.network', 'warn', 'It asks for the internet. Read this before you install it: its tool runs with the network its document declares.');
        }
    }
    for (const m of code.matchAll(TIMER)) {
        const ms = Number(String(m[1] || '').replace(/_/g, ''));
        if (Number.isFinite(ms) && ms > 5000) {
            add('code.timer', 'warn', `It sets a timer for ${ms} ms, longer than 5 s; a tool should not hold its sandbox that long.`);
            break;
        }
    }
    if (LOOP_OVER_INPUT.test(code)) {
        add('code.loop', 'warn', 'It loops over its input, which a caller can make large. Read this before you install it.');
    }
    return out;
}


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
    // A sandbox skill's .js resource is code on purpose: the code rules below read it. Every other resource is text,
    // and an @1 document carries no code at all.
    const sandbox = skill.runs === 'sandbox';
    for (const resource of resources) {
        if (sandbox && resource && resource.media_type === 'text/javascript') continue;
        const text = String((resource && resource.text) || '');
        if (!SCRIPT.some((re) => re.test(text))) continue;
        findings.push(finding('resource.code', 'block', String(resource.path || 'a resource'),
            'This resource reads as a script. A prompt skill is instructions and text only: it runs nothing.'));
    }

    // ── code.* ────────────────────────────────────────────────────────────────────────────────────────────
    // The registry reads the code, never runs it. Each finding names the tool whose entry runs that resource.
    if (sandbox) {
        const tools = Array.isArray(skill.tools) ? skill.tools : [];
        for (const resource of resources) {
            if (!resource || resource.media_type !== 'text/javascript') continue;
            const owners = tools.filter((t) => t && t.entry === resource.path);
            for (const tool of owners) findings.push(...scanCode(resource, tool));
        }
    }

    // ── hosts.undeclared ───────────────────────────────────────────────────────────────────────────────────
    // A sandbox skill declares its network per tool, so its code's hosts are the code.network rule's business. A
    // markdown resource is still read as words, and an @1 skill is all words.
    const seen = new Set();
    const wordResources = sandbox ? resources.filter((r) => !r || r.media_type !== 'text/javascript') : resources;
    for (const [where, text] of [...texts, ...wordResources.map((r) => [String(r.path || 'a resource'), String(r.text || '')])]) {
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

module.exports = { ACTS, RULES: ['asks.undeclared_kind', 'text.secret_request', 'text.exfil', 'resource.code', 'hosts.undeclared', ...CODE_RULES], CODE_RULES, SAFE_REQUIRE, SCANNER, scan, report, declared, sentences, scanCode, hostsIn, openvibeHost };

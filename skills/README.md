# OpenVibe's own skills

The skills the registry publishes for everybody (plan HO2, ADR-058; HO8, ADR-060). Each file is one **document**:
`actor.skill@1` for a prompt skill (a slug, a name, a one-line description, a version, Markdown instructions, up to ten
text resources, and what it may ask an agent to do), or `actor.skill@2` for a skill that also brings code. A @2 sandbox
skill adds tools and `.js` resources; its code runs in a sandbox on a person's machine or OpenVibe's, never on an
OpenVibe server, and the registry stores the bytes it scanned in private Media and pins their ids and hashes on the
listing.

A skill grants nothing: the agent's level and its approvals still decide every step. The `requires` block only says
what the skill may ask for; a step of a kind the skill did not declare is a finding of the scan.

## The integrity hash

Every document carries an `integrity` block: a sha256 over its canonical JSON (the fields the contract names, in the
order it names them; empty optional fields left out). It shows the file was not edited after it was written. It is
**not a signature** — anyone can write a file that names an author and compute its hash — so the author in a document
is only a claim. The registry's listing is the only place a publisher is vouched for.

Editing a file therefore breaks its hash, and the registry will not publish it. Recompute the hash after an edit:

```sh
node -e "
const fs = require('fs'), path = require('path');
const doc = require('./server/skills/document');
for (const f of fs.readdirSync('skills').filter((x) => x.endsWith('.json'))) {
  const p = path.join('skills', f);
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  raw.integrity = { alg: 'sha256', hash: doc.hashOf(raw) };
  fs.writeFileSync(p, JSON.stringify(raw, null, 2) + '\n');
}"
```

## The scan

The registry scans every document before it offers it (`server/skills/scan.js`): deterministic, no model, five rules
over the words of the document.

| Rule | What it finds | What it means |
| --- | --- | --- |
| `asks.undeclared_kind` | an act whose HO1 kind is not in `requires.kinds` | flagged: the person reads it and confirms |
| `text.secret_request` | a request for a password, a key, a token or a seed phrase | failed: it never installs |
| `text.exfil` | files, notes or credentials sent to an address or a URL | failed: it never installs |
| `resource.code` | a resource that reads as a script | failed: it never installs |
| `hosts.undeclared` | a URL outside `requires.hosts` | flagged: the person reads it and confirms |

A sandbox skill's `.js` resources are read by the code rules instead (`code.env`, `code.process`, `code.dynamic`,
`code.vm`, `code.worker`, `code.fs_write`, `code.network`, `code.encoded`, `code.minified`, `code.require`,
`code.timer`, `code.loop`): the registry reads the code, never runs it, and every finding names the tool whose entry
runs that code. The scan fails a tool that reads the environment, starts a process or worker, loads `vm`, writes a
file, builds code at run time, requires anything but Link's safe modules, carries an encoded blob or minified code, or
reaches the network outside what its `net` declares; it flags any network use, timers over 5 s and loops over input.

A sentence that says "never", "not" or "without" says the opposite, so no rule fires on it: the scan reads what a
skill asks to be **done**, not what it warns against.

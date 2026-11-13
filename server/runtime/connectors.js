'use strict';

/**
 * The connectors (plan §Z.6): the groups of tools a person — and the owner — can switch off.
 *
 * A connector is one OpenVibe service a person can reach: OpenVibe.Tools, Link (their computers), Bot (their
 * robots), Codes (coding tasks), Space (their pages), Watch (their schedules), Tips (spending), Locker (their saved
 * logins), and — from the next job — Download (their files), Mail (their email) and Run (the shared nodes).
 *
 * The manifest below is the one list every surface reads: the registry (which tools a run may call), the person's
 * Settings page (a switch per connector), the owner's page (a switch and a daily cap per connector) and the API.
 *
 * Two switches are stored, both in Actor's own database:
 *   - the owner's (actor_connector_settings): per connector `enabled` (true unless the owner says otherwise) and
 *     `daily_cap` (null = no cap): how many calls one person may make to that connector in one UTC day;
 *   - the person's (actor_person_connector_settings): per connector `enabled`, null = the connector's default.
 *
 * The owner's switch wins: a connector the owner turned off is off for everyone, and the person's own row for it is
 * never read. A tool with no connector is a core tool — always on. A connector whose risk is `sends` or `spends`
 * is off until the person turns it on.
 *
 * The state is read per request (never cached in the process for a person's rows) and travels in the run's context,
 * so one person's change is seen by the next run of theirs and by nobody else's.
 */

// ── The manifest ───────────────────────────────────────────────────────────────────────────────────────────────────
// id: the stable name of the group · name: the plain words a person reads · service: the domain it reaches
// what: one sentence about it · risk: what it does (reads | writes | sends | spends) · default: on or off at first.
const CONNECTORS = [
    {
        id: 'openvibe',
        name: 'OpenVibe search',
        service: 'openvibe.network',
        what: 'Search OpenVibe and the web, read a page, and look up places, weather, sports and prices.',
        risk: 'reads',
        default: true,
    },
    {
        id: 'tools',
        name: 'OpenVibe.Tools',
        service: 'openvibe.tools',
        what: 'Run the small apps on OpenVibe.Tools, and make charts and files with them.',
        risk: 'writes',
        default: true,
    },
    {
        id: 'computers',
        name: 'Your computers',
        service: 'openvibe.link',
        what: 'Use the computers and desks on your own Link machines: run programs, read the screen, click and type.',
        risk: 'writes',
        default: true,
    },
    {
        id: 'robots',
        name: 'Your robots',
        service: 'openvibe.bot',
        what: 'Let the agent move your robots and see what they are doing.',
        risk: 'writes',
        default: true,
    },
    {
        id: 'codes',
        name: 'Coding tasks',
        service: 'openvibe.codes',
        what: 'Run a coding task on your own machine with OpenVibe.Codes.',
        risk: 'writes',
        default: true,
    },
    {
        id: 'space',
        name: 'Your spaces',
        service: 'openvibe.space',
        what: 'Build pages and files in your OpenVibe spaces, and publish them.',
        risk: 'writes',
        default: true,
    },
    {
        id: 'phone',
        name: 'Your phone',
        service: 'openvibe.link',
        what: 'Ask your phone for a photo or your location, and send yourself a message.',
        risk: 'reads',
        default: true,
    },
    {
        id: 'schedules',
        name: 'Your schedules',
        service: 'openvibe.watch',
        what: 'Run your agent on a schedule, and keep a routine going.',
        risk: 'writes',
        default: true,
    },
    {
        id: 'money',
        name: 'Spending',
        service: 'openvibe.tips',
        what: 'Let the agent tip a creator with your Vibes, once you approve it.',
        risk: 'spends',
        default: false,
    },
    {
        id: 'logins',
        name: 'Your saved logins',
        service: 'openvibe.locker',
        what: 'Fill in a login for a site with the credentials you saved in Locker.',
        // It uses the person's own passwords: off until they turn it on, like spending (11-13, main review).
        risk: 'secrets',
        default: false,
    },
    {
        id: 'files',
        name: 'Files',
        service: 'openvibe.download',
        what: 'Read and write the files in your OpenVibe.Download space.',
        risk: 'reads',
        default: true,
    },
    {
        id: 'email',
        name: 'Email',
        service: 'openvibe.mail',
        what: 'Read the mail at your OpenVibe.Mail address and answer it.',
        risk: 'sends',
        default: false,
    },
    {
        id: 'shared_nodes',
        name: 'Shared nodes',
        service: 'openvibe.run',
        what: 'Run steps on the shared nodes you can reach.',
        risk: 'writes',
        default: true,
    },
];

const BY_ID = new Map(CONNECTORS.map((c) => [c.id, c]));
const CONNECTOR_IDS = CONNECTORS.map((c) => c.id);

// The core tools: a tool with no connector. They are always on — they are the agent itself (thinking, time, memory,
// the people it talks to, the skills it loads and the list of tools it may use).
const CORE_TOOLS = [
    'calculate',
    'convert_time',
    'time_in',
    'wait_for',
    'recall',
    'remember',
    'ask_person',
    'hand_to_person',
    'load_skill',
    'find_tools',
];

// What a risk means in words a person reads.
const RISK_WORDS = {
    reads: 'reads your things',
    writes: 'changes things',
    sends: 'sends things out',
    spends: 'spends your money',
    secrets: 'uses your saved passwords',
};

/** Is this one of the manifest's ids? */
function isConnectorId(id) {
    return typeof id === 'string' && BY_ID.has(id);
}

/** The manifest, one plain copy per caller (nobody may change it in place). */
function manifest() {
    return CONNECTORS.map((c) => ({ ...c }));
}

/** One connector of the manifest, or null. */
function get(id) {
    return BY_ID.get(id) || null;
}

/** The line the loop shows when a tool's connector is off. */
function offMessage(id) {
    const c = BY_ID.get(id);
    const name = c ? c.name : 'That connector';
    return `${name} is off for your agent: turn it on in Settings → Connectors`;
}

/** The line the loop shows when a person used up the day's calls of a connector. */
function capMessage(id, cap) {
    const c = BY_ID.get(id);
    const name = c ? c.name : 'That connector';
    return `${name} has had all ${cap} calls of today. Ask the owner to raise the limit, or wait for tomorrow.`;
}

const dayOf = (now) => new Date(now).toISOString().slice(0, 10);

/**
 * The switches as they are for one requester right now.
 *
 * The owner's rows are read once for the site; the person's rows are read for that person only. A connector the
 * owner turned off is off for everyone and the person's own row for it is left alone.
 *
 * Returns { requester, connectors, off, take }:
 *   connectors[id] = { id, name, service, what, risk, default, ownerEnabled, personEnabled, enabled, cap, calls }
 *   off            = the ids that are off for this requester (the registry leaves their tools out)
 *   take(id, cap)  = count one call and say whether it may run (the daily cap)
 */
async function load(s, { requester = null, now = null } = {}) {
    const clock = now != null ? now : (typeof s.now === 'function' ? s.now() : Date.now());
    const ownerRows = await s.db.many('SELECT connector_id, enabled, daily_cap FROM actor_connector_settings');
    const ownerById = new Map(ownerRows.map((r) => [r.connector_id, r]));
    const personRows = requester
        ? await s.db.many('SELECT connector_id, enabled FROM actor_person_connector_settings WHERE requester = $1', [requester])
        : [];
    const personById = new Map(personRows.map((r) => [r.connector_id, r]));
    const day = dayOf(clock);
    const callRows = requester
        ? await s.db.many('SELECT connector_id, calls FROM actor_connector_calls WHERE requester = $1 AND day = $2', [requester, day])
        : [];
    const callsById = new Map(callRows.map((r) => [r.connector_id, Number(r.calls) || 0]));

    const connectors = {};
    const off = new Set();
    for (const c of CONNECTORS) {
        const own = ownerById.get(c.id) || null;
        const ownerEnabled = own ? own.enabled !== false : true;
        const own2 = personById.get(c.id) || null;
        const personEnabled = own2 && own2.enabled != null ? own2.enabled === true : null;
        const cap = own && own.daily_cap != null ? Number(own.daily_cap) : null;
        // The owner's switch wins; the person's own switch is read only while the owner left the connector on.
        const enabled = ownerEnabled && (personEnabled == null ? c.default : personEnabled);
        connectors[c.id] = {
            id: c.id,
            name: c.name,
            service: c.service,
            what: c.what,
            risk: c.risk,
            default: c.default,
            ownerEnabled,
            personEnabled,
            enabled,
            offForEveryone: !ownerEnabled,
            cap: Number.isFinite(cap) && cap > 0 ? cap : null,
            calls: callsById.get(c.id) || 0,
            tools: [],
        };
        if (!enabled) off.add(c.id);
    }

    /** Count one call of a connector for this person and say whether it may run. */
    async function take(id, cap) {
        if (!requester) return { ok: true, used: 0 };
        const limit = cap == null ? null : Number(cap);
        return await s.tx(async () => {
            const row = await s.db.maybe(
                'SELECT calls FROM actor_connector_calls WHERE requester = $1 AND connector_id = $2 AND day = $3 FOR UPDATE',
                [requester, id, day],
            );
            const used = row ? Number(row.calls) || 0 : 0;
            if (limit != null && used >= limit) return { ok: false, used };
            await s.db.query(
                `INSERT INTO actor_connector_calls (requester, connector_id, day, calls) VALUES ($1, $2, $3, 1)
                 ON CONFLICT (requester, connector_id, day) DO UPDATE SET calls = actor_connector_calls.calls + 1`,
                [requester, id, day],
            );
            return { ok: true, used: used + 1 };
        });
    }

    return { requester, connectors, off, take };
}

/** The owner's switch for one connector (its row, or the default). */
async function ownerSwitch(s, id, { now = Date.now() } = {}) {
    const row = await s.db.maybe('SELECT connector_id, enabled, daily_cap FROM actor_connector_settings WHERE connector_id = $1', [id]);
    const c = get(id);
    return {
        id,
        name: c ? c.name : id,
        service: c ? c.service : '',
        what: c ? c.what : '',
        risk: c ? c.risk : 'reads',
        default: c ? c.default : true,
        enabled: row ? row.enabled !== false : true,
        daily_cap: row && row.daily_cap != null ? Number(row.daily_cap) : null,
        updated_at: row ? row.updated_at || null : null,
    };
}

/** The owner's switch, saved. `dailyCap` null means no cap. */
async function setOwnerSwitch(s, id, { enabled = null, dailyCap = undefined, who = null, now = Date.now() } = {}) {
    const at = new Date(now).toISOString();
    const row = await s.db.maybe('SELECT connector_id FROM actor_connector_settings WHERE connector_id = $1', [id]);
    if (!row) {
        await s.db.query(
            'INSERT INTO actor_connector_settings (connector_id, enabled, daily_cap, updated_by, updated_at) VALUES ($1, $2, $3, $4, $5)',
            [id, enabled === null ? true : enabled === true, dailyCap === undefined ? null : dailyCap, who, at],
        );
        return await ownerSwitch(s, id, { now });
    }
    const set = ['updated_at = $2', 'updated_by = $3'];
    const values = [id, at, who];
    if (enabled !== null && enabled !== undefined) { values.push(enabled === true); set.push(`enabled = $${values.length}`); }
    if (dailyCap !== undefined) { values.push(dailyCap == null ? null : Number(dailyCap)); set.push(`daily_cap = $${values.length}`); }
    await s.db.query(`UPDATE actor_connector_settings SET ${set.join(', ')} WHERE connector_id = $1`, values);
    return await ownerSwitch(s, id, { now });
}

/** The person's own switch for one connector. `enabled` null means: the connector's default. */
async function setPersonSwitch(s, requester, id, enabled, { now = Date.now() } = {}) {
    const at = new Date(now).toISOString();
    if (enabled == null) {
        await s.db.query('DELETE FROM actor_person_connector_settings WHERE requester = $1 AND connector_id = $2', [requester, id]);
        return null;
    }
    await s.db.query(
        `INSERT INTO actor_person_connector_settings (requester, connector_id, enabled, updated_at) VALUES ($1, $2, $3, $4)
         ON CONFLICT (requester, connector_id) DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = EXCLUDED.updated_at`,
        [requester, id, enabled === true, at],
    );
    const row = await s.db.maybe('SELECT enabled FROM actor_person_connector_settings WHERE requester = $1 AND connector_id = $2', [requester, id]);
    return row ? row.enabled === true : null;
}

module.exports = {
    CONNECTORS,
    CONNECTOR_IDS,
    CORE_TOOLS,
    RISK_WORDS,
    isConnectorId,
    manifest,
    get,
    offMessage,
    capMessage,
    load,
    ownerSwitch,
    setOwnerSwitch,
    setPersonSwitch,
    dayOf,
};

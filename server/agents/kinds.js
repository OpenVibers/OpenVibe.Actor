'use strict';

/**
 * The kinds of act an approval can be about (plan HO1, "universal approvals": the trust spine). One list,
 * so every acting tool says which kind it is (agents/actions.js) and the person reads one plain phrase for
 * it — on the approval page, in the Action Center and in the agent's own page.
 *
 * The always-ask floor (money, a password, a deletion, a new recipient) is a different thing and lives in
 * levels.js: it is a property of what the step says, not of its kind. A kind is what the act IS; a floor
 * category is what the act would TOUCH. A floor step can never be always-allowed, whatever its kind.
 */

const KINDS = [
    'codes.task',      // a coding task on the person's own machine
    'actor.action',    // a connected tool (an MCP server or another agent) that acts
    'computer.run',    // run a program on the person's computer
    'computer.write',  // write a file on the person's computer
    'computer.input',  // use the mouse or the keyboard on the person's computer
    'computer.browser',// open, fill or click in the person's browser
    'computer.desk',   // start or stop the agent's desk on a machine
    'robot.move',      // move the person's robot
    'space',           // change the person's own OpenVibe.Space (make one, write its files)
    'publish',         // publish something for the public to see
    'post',            // post on an OpenVibe site
    'send',            // send an email, a message or a file to someone
    'install',         // install a skill or connect a connector
    'routine',         // set up a task that keeps running
    'money',           // spend the person's money
    'skill.run',       // run a skill's code in a sandbox on a Node (ADR-060)
    'device.camera',   // ask the person to take one photo
    'device.location', // ask the person to share one location
    'device.notify',   // tell the person something on their phone
];

// The plain words a person reads for each kind. Never an id, never a code: this is the sentence on the card.
const LABELS = {
    'codes.task': 'a coding task on your machine',
    'actor.action': 'an action by a connected tool',
    'computer.run': 'running a program on your computer',
    'computer.write': 'writing a file on your computer',
    'computer.input': 'using your mouse or keyboard',
    'computer.browser': 'acting in your browser',
    'computer.desk': "starting or stopping your agent's desk",
    'robot.move': 'moving your robot',
    'space': 'changing your own OpenVibe.Space',
    'publish': 'publishing for others to see',
    'post': 'posting on an OpenVibe site',
    'send': 'sending something to someone',
    'install': 'installing a skill or connecting a connector',
    'routine': 'setting up a task that keeps running',
    'money': 'spending your money',
    'skill.run': 'running a skill\'s code in a sandbox',
    'device.camera': 'taking one photo yourself',
    'device.location': 'sharing your location once',
    'device.notify': 'notifying your phone',
};

// Kinds a person can never "always allow", whatever the target: spending money is the floor itself; typing reaches
// anything a terminal can run (so one rule would cover every command); a send's recipient and an install's code are
// not in the step's name, so no target can say exactly what was allowed.
const NEVER_ALWAYS = ['money', 'computer.input', 'send', 'install', 'device.camera', 'device.location'];

const isKind = (kind) => KINDS.includes(String(kind || ''));
const allowable = (kind) => isKind(kind) && !NEVER_ALWAYS.includes(String(kind));

/** The plain phrase for a kind; an unknown kind reads as an action, never as an empty card. */
const label = (kind) => LABELS[String(kind || '')] || 'an action';

/** The phrase with the step's own target: "publishing for others to see · openvibe.blog". */
const phrase = (kind, target) => {
    const what = label(kind);
    const where = String(target || '').trim();
    return where ? `${what} · ${where}` : what;
};

module.exports = { KINDS, LABELS, NEVER_ALWAYS, isKind, allowable, label, phrase };

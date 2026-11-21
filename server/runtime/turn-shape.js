'use strict';
/**
 * The shape of a turn (the owner's phone, 11-21: "Test" and "Search Google" took two to three minutes and showed one
 * reply three times, with a plan card and a "Checked by …" Thought). One place says how much machinery a turn gets:
 *
 *   quick(understanding, task, attachments)  an answer, low risk, at most one thing to look up or work out, a short
 *                                            message and no files: no planner, no plan card, no review of a short answer
 *   asksPerson(text)                         a reply that asks the person for something: nothing in it to check, and the
 *                                            turn is theirs (no review, no claim check)
 *   worthChecking({ understanding, task, attachments, text, evidence })   whether an answer gets a review or a claim
 *                                            check: not a quick ask's short answer; yes when the run gathered evidence;
 *                                            else not when it only asks the person something
 */
const SHORT = 700;

function quick(u, task, attachments) {
    if (!u || !u.known || u.kind !== 'answer' || u.risk !== 'low') return false;
    const f = u.facts || {};
    const work = (Array.isArray(f.lookup) ? f.lookup.length : 0) + (Array.isArray(f.derive) ? f.derive.length : 0);
    return work <= 1 && String(task || '').trim().length <= 240 && !(attachments && attachments.length);
}

function asksPerson(text) {
    const s = String(text || '').trim();
    if (!s || s.length > 1200) return false;
    // An answer that cites evidence states facts, even when it ends offering more ("… 12 °C [E1]. Want the week?").
    if (/\[E\d+\]/.test(s)) return false;
    // It ends on a question, or a paragraph opens with one ("What should I search for? … give me the words").
    if (/\?\s*[*_)\]]*\s*$/.test(s)) return true;
    return s.split(/\n{2,}/).some((para) => /^[^.!?\n]{3,140}\?(\s|$)/.test(para.trim()));
}

function worthChecking({ understanding, task, attachments, text, evidence = [] }) {
    if (quick(understanding, task, attachments) && String(text || '').length < SHORT) return false;
    // A run that looked something up answers from it: checked, whatever the reply ends on.
    if (Array.isArray(evidence) && evidence.length) return true;
    return !asksPerson(text);
}

module.exports = { quick, asksPerson, worthChecking };

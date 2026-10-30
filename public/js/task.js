/* A task's page. With openvibe-shared/agent-session.js on the page, How it went is the agents' session: every step (its
 * call and its result), each agent that tried, its checks and hand-offs, from the events the page carries and, while the
 * task runs, from its live stream (GET /api/v1/tasks/:id/events, actor.task-event@1). Without it, a running task's steps
 * are drawn the way the server renders a finished one. When the task ends the page reloads to show the outcome. Without
 * this script the page refreshes itself every few seconds (<noscript>).
 * The task page v2 (stage V2-5): the plan card follows the plan as the agent states and revises it, and a citation chip
 * in the answer opens the evidence behind it (without this script the chip is a link to the same place). */
(function () {
  'use strict';
  var LABEL = { tool_call: 'Used', tool_result: 'Got', text: 'Note' };
  var STATE = { queued: 'Waiting to start', running: 'Working', verifying: 'Checking the answer' };

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  // The session view over How it went: the events the page carries, then (while open) the live ones.
  function session(art) {
    var data = document.getElementById('task-events');
    var box = document.getElementById('attempts');
    if (!window.OpenVibeAgentSession || !data || !box || art.dataset.session) return null;
    var events;
    try { events = JSON.parse(data.textContent); } catch (err) { return null; }
    art.dataset.session = '1';
    var host = el('div', 'task-session');
    box.parentNode.insertBefore(host, box);
    box.hidden = true; box.style.display = 'none';   // .attempts sets a display of its own, which [hidden] alone does not beat
    // Only the person's own desk becomes a link (Desks plan D4): an agent reads untrusted pages, so any other address stays text.
    var botRe = (art.getAttribute('data-bot') || 'https://openvibe.bot').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    var ownDesk = new RegExp('^' + botRe + '/machines/dev_[0-9A-HJKMNP-TV-Z]{26}/screen(?:\\?desk=[a-z0-9-]{1,40})?$');
    var open = art.getAttribute('data-open') === '1';
    var state = (art.className.match(/state-([a-z_]+)/) || [])[1] || (open ? 'running' : 'succeeded');
    if (state === 'done') state = 'succeeded';
    // A finished task mounts finished: mounting it as queued started a clock at page load, which read "0 s". Its run
    // time comes from the events (task-events.js done line); a live one clocks from when its run really started.
    var lines = window.OpenVibeTaskEvents ? window.OpenVibeTaskEvents.lines(events, { final: !open, state: state }) : events;
    var startedAt = open && window.OpenVibeTaskEvents ? window.OpenVibeTaskEvents.firstAt(events) : 0;
    var view = window.OpenVibeAgentSession.mount(host, { title: (document.querySelector('.task-text') || {}).textContent || 'Task', status: open ? 'running' : state, startedAt: startedAt || undefined, follow: open, empty: 'Waiting for an agent to start…', link: function (u) { return ownDesk.test(u); } });
    view.pushAll(lines);
    return view;
  }

  // The plan card: drawn again from each plan the agent states (task-events.js reads it back), DOM nodes only.
  var PLAN_STATE = { done: 'done', active: 'working on it', todo: 'next' };
  function paintPlan(text) {
    var card = document.getElementById('plan-card');
    var p = card && window.OpenVibeTaskEvents ? window.OpenVibeTaskEvents.plan(text) : null;
    if (!p) return;
    var list = document.getElementById('plan-steps');
    while (list.firstChild) list.removeChild(list.firstChild);
    p.steps.forEach(function (st) {
      var li = el('li', 'ps is-' + (PLAN_STATE[st.state] ? st.state : 'todo'));
      var mark = el('span', 'ps-mark'); mark.setAttribute('aria-hidden', 'true');
      li.appendChild(mark);
      li.appendChild(el('span', 'ps-goal', st.goal));
      li.appendChild(el('span', 'sr-only', ' (' + (PLAN_STATE[st.state] || 'next') + ')'));
      list.appendChild(li);
    });
    var assume = document.getElementById('plan-assume');
    if (assume) { assume.textContent = p.assumptions.length ? 'Assuming ' + p.assumptions.join(' \u00b7 ') : ''; assume.hidden = !p.assumptions.length; }
    // A live plan's assumptions are an editable form; do not overwrite what the person is typing.
    var box = document.getElementById('assume-text');
    if (box && document.activeElement !== box) box.value = p.assumptions.join('\n');
    // The brain's ledgers ride in the plan event too (stage V2-8), so the live card keeps them current.
    var ledger = document.getElementById('plan-ledger');
    if (ledger) {
      while (ledger.firstChild) ledger.removeChild(ledger.firstChild);
      if (p.ledger) {
        var row = el('p');
        row.appendChild(el('b', '', 'Task ledger'));
        var l = p.ledger;
        [['given', l.given], ['find', l.lookup], ['derive', l.derive]].forEach(function (pair) {
          if (!pair[1].length) return;
          var span = el('span');
          span.appendChild(el('span', 'muted', pair[0]));
          span.appendChild(document.createTextNode(' ' + pair[1].join('; ')));
          row.appendChild(document.createTextNode(' '));
          row.appendChild(span);
        });
        ledger.appendChild(row);
      }
      if (p.progress) {
        var line = el('p', 'plan-progress');
        line.appendChild(el('b', '', 'Progress'));
        line.appendChild(document.createTextNode(' ' + (p.progress.done ? 'done' : 'not done') + ' \u00b7 ' + (p.progress.looping ? 'looping' : 'not looping') + ' \u00b7 ' + (p.progress.progressing ? 'moving' : 'no progress') + (p.progress.next ? ' \u00b7 next: ' + p.progress.next : '')));
        ledger.appendChild(line);
      }
      ledger.hidden = !p.ledger && !p.progress;
    }
    card.hidden = false;
  }

  // A citation chip opens the Evidence fold at its item, scrolls to it and marks it a moment; the URL keeps the item.
  function evidence() {
    if (document.documentElement.dataset.evBound) return;
    document.documentElement.dataset.evBound = '1';
    document.addEventListener('click', function (e) {
      var chip = e.target.closest ? e.target.closest('a.ev[data-ev]') : null;
      if (!chip) return;
      var item = document.getElementById('ev-' + chip.getAttribute('data-ev'));
      var fold = document.getElementById('evidence');
      if (!item || !fold) return;
      e.preventDefault();
      fold.open = true;
      document.querySelectorAll('.ev-item.is-flash').forEach(function (n) { n.classList.remove('is-flash'); });
      document.querySelectorAll('a.ev.is-on').forEach(function (n) { n.classList.remove('is-on'); });
      item.classList.add('is-flash', 'is-open');
      chip.classList.add('is-on');
      try { history.replaceState(null, '', '#ev-' + chip.getAttribute('data-ev')); } catch (err) { /* a sandboxed frame */ }
      var still = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      item.scrollIntoView({ behavior: still ? 'auto' : 'smooth', block: 'center' });
      setTimeout(function () { item.classList.remove('is-flash'); chip.classList.remove('is-on'); }, 2400);
    });
    // Opened at an item (a shared link, or the back button): the fold opens there too.
    var at = /^#ev-E\d{1,3}$/.test(location.hash) ? document.getElementById(location.hash.slice(1)) : null;
    if (at && document.getElementById('evidence')) { document.getElementById('evidence').open = true; at.classList.add('is-open'); }
  }

  // The follow-up box grows with what is typed (up to 40% of the screen), and Ctrl/Cmd+Enter sends it.
  function followBox() {
    var box = document.getElementById('follow-text');
    if (!box || box.dataset.bound) return;
    box.dataset.bound = '1';
    var fit = function () { box.style.height = 'auto'; box.style.height = Math.min(box.scrollHeight, Math.round(window.innerHeight * 0.4)) + 'px'; };
    box.addEventListener('input', fit);
    box.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && box.value.trim() && box.form) { e.preventDefault(); if (box.form.requestSubmit) box.form.requestSubmit(); else box.form.submit(); }
    });
    if (location.hash === '#follow-up') { try { box.focus({ preventScroll: true }); } catch (err) { box.focus(); } }
  }

  function start() {
    evidence();
    followBox();
    var art0 = document.querySelector('article.task');
    var view = art0 ? session(art0) : null;
    var art = document.querySelector('article.task[data-open="1"]');
    if (!art || !window.EventSource || art.dataset.live) return;
    art.dataset.live = '1';
    var id = art.getAttribute('data-task');
    var box = document.getElementById('attempts');
    var liveState = document.getElementById('live-state');
    var cost = document.getElementById('task-cost');
    var current = box.lastElementChild ? box.lastElementChild.querySelector('.tl') : null;
    var lastCheckFailed = false;

    function attempt(name) {
      var sec = el('section', 'attempt');
      var head = el('header', 'attempt-head');
      head.appendChild(el('span', 'attempt-n', String(box.children.length + 1)));
      head.appendChild(el('b', null, name));
      sec.appendChild(head);
      current = el('ol', 'tl');
      sec.appendChild(current);
      box.appendChild(sec);
      lastCheckFailed = false;
    }
    // Links to the person's own desk on OpenVibe.Bot become clickable (Desks plan D4); any other address stays text.
    var bot = (art.getAttribute('data-bot') || 'https://openvibe.bot').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    var deskLink = new RegExp(bot + '/machines/dev_[0-9A-HJKMNP-TV-Z]{26}/screen(?:\\?desk=[a-z0-9-]{1,40})?', 'g');
    function withLinks(node, text) {
      var t = String(text || ''), last = 0, m;
      deskLink.lastIndex = 0;
      while ((m = deskLink.exec(t))) {
        node.appendChild(document.createTextNode(t.slice(last, m.index)));
        var a = el('a', null, /[?]desk=/.test(m[0]) ? 'your agent\u2019s desk' : 'the screen');
        a.href = m[0]; a.rel = 'noopener';
        node.appendChild(a);
        last = m.index + m[0].length;
      }
      node.appendChild(document.createTextNode(t.slice(last)));
    }
    function item(kind, cls, value, code) {
      if (!current) attempt('Agent');
      var li = el('li', 'tl-item ' + cls);
      li.appendChild(el('span', 'tl-k', kind));
      var v = el('span', 'tl-v');
      if (code) { v.appendChild(el('code', null, code)); v.appendChild(document.createTextNode(' ')); }
      withLinks(v, value);
      li.appendChild(v);
      current.appendChild(li);
    }
    // The desk it works on (Desks plan): a computer_desk start shows "Watch and take over", its stop hides it.
    var deskCard = document.getElementById('desk-card');
    var deskWatch = new RegExp('^\\{"watch":"(' + bot + '/machines/dev_[0-9A-HJKMNP-TV-Z]{26}/screen(?:\\?desk=[a-z0-9-]{1,40})?)"');
    function onDesk(e) {
      if (!deskCard || e.step !== 'tool_result' || e.tool !== 'computer_desk' || e.is_error) return;
      var t = String(e.text || '');
      var m = deskWatch.exec(t);
      if (m && /"running":true/.test(t)) {
        document.getElementById('desk-link').setAttribute('href', m[1]);
        document.getElementById('desk-kind').textContent = /"kind":"browser"/.test(t) ? ' (a browser)' : '';
        deskCard.hidden = false;
      } else if (/"running":false/.test(t)) deskCard.hidden = true;
    }
    // What the agent last saw: a new look at its screen refreshes the picture.
    var lastLook = document.getElementById('last-look');
    function onLook(e) {
      if (!lastLook || e.step !== 'tool_result' || e.tool !== 'computer_screen' || e.is_error) return;
      var img = document.getElementById('last-look-img');
      img.removeAttribute('width');
      img.removeAttribute('height');
      var src = '/tasks/' + encodeURIComponent(id) + '/look?at=' + Date.now();
      img.setAttribute('src', src);
      document.getElementById('last-look-link').setAttribute('href', src);
      lastLook.hidden = false;
    }
    // The files and charts a tool made, as the attachments the shared session draws (openvibe-shared 4.50.0). The
    // event itself keeps the contract's shape (actor.task-event@2, additionalProperties false), so the mapping is here.
    function attach(e) {
      if (!e || !Array.isArray(e.artifacts) || !e.artifacts.length) return e;
      var atts = window.OpenVibeTaskEvents ? window.OpenVibeTaskEvents.attachments(e.artifacts) : null;
      if (!atts) return e;
      var copy = {};
      for (var k in e) if (Object.prototype.hasOwnProperty.call(e, k)) copy[k] = e[k];
      copy.attachments = atts;
      return copy;
    }
    function onOutput(e) {
      onDesk(e);
      onLook(e);
      if (e.step === 'plan') paintPlan(e.text);
      if (view) { view.push(attach(e)); return undefined; }
      if ((e.step === 'plan' || e.step === 'handoff') && e.agent) return attempt((e.text || e.agent).replace(/ takes it.*$/, ''));
      if (e.step === 'plan') return undefined;
      if (e.step === 'check') {
        lastCheckFailed = !!e.is_error;
        return item('Check', e.is_error ? 'tl-err' : 'tl-ok', String(e.text || '').replace(/^(Checked|Check failed)( by \w+( \(same family\))?)?: ?/, ''));
      }
      if (e.step === 'text' && e.is_error && lastCheckFailed) return item('Refused', 'tl-err', 'The answer did not pass its check; trying a stronger agent.');
      if (e.step === 'text' && e.is_error) return item('Stopped', 'tl-err', e.text);
      if (e.step === 'tool_call') return item(LABEL.tool_call, 'tl-tool', e.input, e.tool);
      if (e.step === 'tool_result') return item(LABEL.tool_result, 'tl-result' + (e.is_error ? ' tl-err' : ''), String(e.text || '').slice(0, 220), e.tool);
      if (/^Needs you: /.test(e.text || '')) return item('Needs you', 'tl-needs', String(e.text).replace(/^Needs you: /, ''));
      return item(LABEL.text, 'tl-say', e.text);
    }

    var src = new EventSource('/api/v1/tasks/' + encodeURIComponent(id) + '/events?after=' + encodeURIComponent(art.getAttribute('data-last') || '0'));
    src.addEventListener('output', function (m) { try { onOutput(JSON.parse(m.data)); } catch (err) { /* a malformed event is skipped */ } });
    src.addEventListener('state', function (m) {
      try { var ev = JSON.parse(m.data), s = ev.state; if (liveState && STATE[s]) liveState.textContent = STATE[s] + '…'; if (view) view.push(ev); } catch (err) { /* ignore */ }
      fetch('/api/v1/tasks/' + encodeURIComponent(id), { credentials: 'same-origin' }).then(function (r) { return r.ok ? r.json() : null; }).then(function (t) {
        if (t && t.cost && cost) cost.textContent = cost.textContent.replace(/^\$[0-9.]+/, '$' + (t.cost.usd < 0.01 ? t.cost.usd.toFixed(4) : t.cost.usd.toFixed(2)));
      }).catch(function () {});
    });
    src.addEventListener('end', function () { src.close(); window.location.reload(); });
    src.onerror = function () { if (src.readyState === 2) setTimeout(function () { window.location.reload(); }, 4000); };
    window.addEventListener('pagehide', function () { src.close(); }, { once: true });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
  document.addEventListener('ov:boost:load', start);
})();

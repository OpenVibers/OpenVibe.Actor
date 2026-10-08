/* A running task's page: follows its live stream (GET /api/v1/tasks/:id/events, actor.task-event@1) and draws each step
 * the way the server renders a finished task (one block per agent that tries, its steps, its check); when the task ends
 * the page reloads to show the outcome. Without this script the page refreshes itself every few seconds (<noscript>). */
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

  function start() {
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
    function item(kind, cls, value, code) {
      if (!current) attempt('Agent');
      var li = el('li', 'tl-item ' + cls);
      li.appendChild(el('span', 'tl-k', kind));
      var v = el('span', 'tl-v');
      if (code) { v.appendChild(el('code', null, code)); v.appendChild(document.createTextNode(' ')); }
      v.appendChild(document.createTextNode(value || ''));
      li.appendChild(v);
      current.appendChild(li);
    }
    function onOutput(e) {
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
      return item(LABEL.text, 'tl-say', e.text);
    }

    var src = new EventSource('/api/v1/tasks/' + encodeURIComponent(id) + '/events?after=' + encodeURIComponent(art.getAttribute('data-last') || '0'));
    src.addEventListener('output', function (m) { try { onOutput(JSON.parse(m.data)); } catch (err) { /* a malformed event is skipped */ } });
    src.addEventListener('state', function (m) {
      try { var s = JSON.parse(m.data).state; if (liveState && STATE[s]) liveState.textContent = STATE[s] + '…'; } catch (err) { /* ignore */ }
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

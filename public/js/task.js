/* A running task's page: follows its live stream (GET /api/v1/tasks/:id/events, actor.task-event@1) and adds each step
 * as it happens; when the task ends the page reloads to show the answer as the server renders it. Without this script
 * the page refreshes itself every few seconds (a <noscript> refresh), so nothing depends on it. */
(function () {
  'use strict';
  function start() {
    var el = document.querySelector('article.task[data-open="1"]');
    if (!el || !window.EventSource || el.dataset.live) return;
    el.dataset.live = '1';
    var id = el.getAttribute('data-task');
    var after = el.getAttribute('data-last') || '0';
    var log = document.getElementById('steps-log');
    var cost = document.getElementById('task-cost');
    var LABEL = { plan: 'Plan', text: 'Says', tool_call: 'Uses', tool_result: 'Got', check: 'Check', handoff: 'Hands on' };

    function step(e) {
      var li = document.createElement('li');
      li.className = 'step step-' + e.step + (e.is_error ? ' err' : '');
      var k = document.createElement('span');
      k.className = 'step-k';
      k.textContent = LABEL[e.step] || e.step;
      var v = document.createElement('span');
      v.className = 'step-v';
      if (e.tool) {
        var c = document.createElement('code');
        c.textContent = e.tool;
        v.appendChild(c);
        v.appendChild(document.createTextNode(' ' + (e.step === 'tool_result' ? String(e.text || '').slice(0, 240) : (e.input || ''))));
      } else {
        v.textContent = e.text || '';
      }
      li.appendChild(k);
      li.appendChild(v);
      log.appendChild(li);
    }

    var src = new EventSource('/api/v1/tasks/' + encodeURIComponent(id) + '/events?after=' + encodeURIComponent(after));
    src.addEventListener('output', function (m) { try { step(JSON.parse(m.data)); } catch (err) { /* a malformed event is skipped */ } });
    src.addEventListener('state', function () {
      fetch('/api/v1/tasks/' + encodeURIComponent(id), { credentials: 'same-origin' }).then(function (r) { return r.ok ? r.json() : null; }).then(function (t) {
        if (t && t.cost && cost) cost.textContent = '$' + (t.cost.usd < 0.01 ? t.cost.usd.toFixed(4) : t.cost.usd.toFixed(2));
      }).catch(function () {});
    });
    src.addEventListener('end', function () { src.close(); window.location.reload(); });
    // The page's own refresh is the fallback when the stream cannot stay open.
    src.onerror = function () { if (src.readyState === 2) setTimeout(function () { window.location.reload(); }, 4000); };
    window.addEventListener('pagehide', function () { src.close(); }, { once: true });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
  document.addEventListener('ov:boost:load', start);
})();

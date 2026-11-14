/* openvibe.actor, signed in: a new chat is the network's messenger full-page (openvibe-shared ov-run.js
   OpenVibeRun.page, 4.250.0; plan §AB.8/47, the owner: "Combine, remake entire system … the same conversation system
   everywhere"). Your agents and conversations on the left, the open one on the right; one box for everything, and one
   engine (the Frame's Run API) decides per message whether it is code, a chat, a task or a computer's work, so a coding
   task started here is the same run in the menu's Vibe on every site.
   It takes over only once ov-run.js has `page` and the navbar has the person's token: until then, and when either never
   comes, the server-rendered page (public/js/chat.js) stays and works. ?ask= (Ask Actor from any site) fills the box. */
(function () {
  'use strict';
  var app = document.querySelector('[data-chat=""]');
  if (!app) return;
  var STARTERS = [
    ['bell', 'Remind me to stretch every 2 hours'],
    ['calendar', 'Plan my week around my streams'],
    ['search', 'Find me three cheap GPU rentals'],
    ['code', 'Make me a one-page site for my stream'],
  ];
  function loadRun() {
    if (window.OpenVibeRun && window.OpenVibeRun.page) return Promise.resolve(window.OpenVibeRun);
    return new Promise(function (resolve, reject) {
      var sc = document.createElement('script'); sc.src = '/shared/ov-run.js'; sc.async = true;
      sc.onload = function () { return window.OpenVibeRun && window.OpenVibeRun.page ? resolve(window.OpenVibeRun) : reject(new Error('ov-run.js has no page')); };
      sc.onerror = function () { reject(new Error('ov-run.js')); };
      document.head.appendChild(sc);
    });
  }
  function tokenSoon() {
    return new Promise(function (resolve) {
      var start = Date.now();
      (function look() {
        var N = window.OpenVibeNavbar; var t = N && typeof N.token === 'function' ? N.token() : null;
        if (t) return resolve(t);
        if (Date.now() - start > 8000) return resolve(null);
        setTimeout(look, 150);
      })();
    });
  }
  var q = null; try { q = new URLSearchParams(location.search); } catch (e) { q = null; }
  var prompt = q ? String(q.get('ask') || q.get('prompt') || '').slice(0, 4000) : '';
  var open = q ? String(q.get('run') || '') : '';
  Promise.all([loadRun(), tokenSoon()]).then(function (got) {
    var R = got[0], token = got[1];
    if (!token) return;
    var host = document.createElement('div'); host.className = 'ac-messenger';
    app.replaceWith(host);
    document.documentElement.classList.add('ac-has-messenger');
    var page = R.page(host, {
      base: 'https://openvibe.network/api/frame',
      token: function () { var N = window.OpenVibeNavbar; return (N && N.token && N.token()) || token; },
      agent: true, starters: STARTERS,
      actions: { base: 'https://openvibe.network' },
      sibling: function (file) { return '/shared/' + file; },
      open: /^[a-z][a-z0-9-]{0,30}:[A-Za-z0-9._~-]{1,160}$/.test(open) ? open : null,
      onPlace: function (p) {
        try { if (p && p.ref) history.replaceState(null, '', '/chat?run=' + encodeURIComponent(p.ref)); else if (p && p.blank) history.replaceState(null, '', '/chat'); } catch (e) { /* the address stays */ }
      },
    });
    if (prompt && page.main && page.main.prefill) page.main.prefill(prompt);
  }, function () { /* ov-run.js did not load: the server-rendered page stays */ });
})();

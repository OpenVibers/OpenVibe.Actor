/* openvibe.actor, signed in: a new chat is the network's messenger full-page (openvibe-shared ov-run.js
   OpenVibeRun.page, 4.250.0; plan §AB.8/47, the owner: "Combine, remake entire system … the same conversation system
   everywhere"). Your agents and conversations on the left, the open one on the right; one box for everything, and one
   engine (the Frame's Run API) decides per message whether it is code, a chat, a task or a computer's work, so a coding
   task started here is the same run in the menu's Vibe on every site.
   It takes over only once ov-run.js has `page` and the navbar has the person's token: until then, and when either never
   comes, the server-rendered page (public/js/chat.js) stays and works. ?ask= (Ask Actor from any site) fills the box.
   11-15 night (plan §AD.8; the owner: "a complete rethink and redesign … way smarter, intelligent type system sessions,
   kind of like Claude Code … but make it way better"): once Actor serves openvibe-shared 4.266.0's ov-session.js, the
   page is the one session surface (the menu's Vibe and Codes' home are the same): your Actor heads the sessions and
   greets a new one, the Action Center's work is answered there, one box with one context chip. Until then, the
   messenger above. */
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
  function loadSession() {
    if (window.OpenVibeSession && window.OpenVibeSession.mount) return Promise.resolve(window.OpenVibeSession);
    return new Promise(function (resolve) {
      var sc = document.createElement('script'); sc.src = '/shared/ov-session.js'; sc.async = true;
      sc.onload = function () { resolve(window.OpenVibeSession && window.OpenVibeSession.mount ? window.OpenVibeSession : null); };
      sc.onerror = function () { resolve(null); };
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
  var opened = /^[a-z][a-z0-9-]{0,30}:[A-Za-z0-9._~-]{1,160}$/.test(open) ? open : null;
  var place = function (p) {
    try { if (p && p.ref) history.replaceState(null, '', '/chat?run=' + encodeURIComponent(p.ref)); else if (p && p.blank) history.replaceState(null, '', '/chat'); } catch (e) { /* the address stays */ }
  };
  var tokenOf = function (token) { return function () { var N = window.OpenVibeNavbar; return (N && N.token && N.token()) || token; }; };
  tokenSoon().then(function (token) {
    if (!token) return null;
    return loadSession().then(function (S) {
      if (!S) return showMessenger(token);
      var host = document.createElement('div'); host.className = 'ac-messenger ac-session';
      app.replaceWith(host);
      document.documentElement.classList.add('ac-has-messenger');
      var s = S.mount(host, {
        base: 'https://openvibe.network/api/frame',
        token: tokenOf(token),
        sibling: function (file) { return '/shared/' + file; },
        actor: true, actions: { base: 'https://openvibe.network' }, starters: STARTERS,
        title: 'Actor', open: opened,
        onEvent: function (type, d) { if (type === 'session.opened' && d && d.ref) place({ ref: d.ref }); else if (type === 'session.blank') place({ blank: true }); },
      });
      if (prompt && s && typeof s.prefill === 'function') s.prefill(prompt);
      return null;
    });
  }).catch(function () { /* nothing loaded: the server-rendered page stays */ });

  function showMessenger(token) {
    return loadRun().then(function (R) {
    var host = document.createElement('div'); host.className = 'ac-messenger';
    app.replaceWith(host);
    document.documentElement.classList.add('ac-has-messenger');
    var page = R.page(host, {
      base: 'https://openvibe.network/api/frame',
      token: tokenOf(token),
      agent: true, starters: STARTERS,
      actions: { base: 'https://openvibe.network' },
      sibling: function (file) { return '/shared/' + file; },
      open: opened,
      onPlace: place,
    });
    if (prompt && page.main && page.main.prefill) page.main.prefill(prompt);
    }, function () { /* ov-run.js did not load: the server-rendered page stays */ });
  }
})();

/* Actor's chat in the browser (plan L55 C1). The page works without this file; with it:
 *   - a message sends without a reload, its turn appears at once, and the thread stays at the bottom;
 *   - a turn that is working follows its event stream: the live line says what it is doing now, the work list fills in
 *     (the server renders it: GET /chat/turn/:id), and the answer fades in when it is done;
 *   - Send turns into Stop while Actor works; Enter sends on a keyboard, Shift+Enter is a new line;
 *   - the chats open as a drawer on phones, and the search box filters them;
 *   - Copy on each answer and on each code block.
 * Booted on load and after an in-place page swap (openvibe-shared/boost's ov:boost:load).
 */
(function () {
    'use strict';
    var streams = [];

    function start() {
        var chat = document.querySelector('.chat');
        if (!chat || chat.dataset.ready) return;
        chat.dataset.ready = '1';
        var form = chat.querySelector('[data-composer]');
        var text = chat.querySelector('[data-cc-text]');
        var send = chat.querySelector('[data-cc-send]');
        var note = chat.querySelector('[data-cc-note]');
        var head = chat.querySelector('.ct-head');
        var fine = window.matchMedia && window.matchMedia('(hover: hover) and (pointer: fine)').matches;
        var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

        // ── Where the navbar ends: the sticky header and the chats column sit under it, and follow it when it steps away.
        var nav = document.querySelector('.openvibe-navbar') || document.getElementById('navbar-mount');
        var topWas = -1, ticking = false;
        function measure() {
            ticking = false;
            var b = nav ? Math.max(0, Math.round(nav.getBoundingClientRect().bottom)) : 0;
            if (b !== topWas) { topWas = b; chat.style.setProperty('--chat-top', b + 'px'); }
            if (head) head.classList.toggle('is-stuck', window.scrollY > 8);
        }
        function onScroll() { if (!ticking) { ticking = true; requestAnimationFrame(measure); } }
        measure();
        window.addEventListener('scroll', onScroll, { passive: true });
        window.addEventListener('resize', onScroll);
        setTimeout(measure, 400);

        // ── The thread stays at the bottom while you are there.
        function nearBottom() { return window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 220; }
        function toBottom(smooth) { window.scrollTo({ top: document.documentElement.scrollHeight, behavior: smooth && !reduce ? 'smooth' : 'auto' }); }
        if (!location.hash && chat.querySelector('[data-thread]')) toBottom(false);

        // ── The chats: a drawer on phones, filtered by the search box.
        var opener = chat.querySelector('[data-cs-open]');
        var scrim = chat.querySelector('.cs-scrim');
        var closeBtn = chat.querySelector('.cs-close');
        function drawer(on) {
            chat.classList.toggle('is-drawer', on);
            if (scrim) scrim.hidden = !on;
            if (closeBtn) closeBtn.hidden = !on;
            if (opener) opener.setAttribute('aria-expanded', on ? 'true' : 'false');
            if (on) { var f = chat.querySelector('[data-cs-find]'); if (f && fine) f.focus(); }
        }
        if (opener) opener.addEventListener('click', function () { drawer(true); });
        chat.querySelectorAll('[data-cs-close]').forEach(function (el) { el.addEventListener('click', function () { drawer(false); }); });
        document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && chat.classList.contains('is-drawer')) drawer(false); });
        var find = chat.querySelector('[data-cs-find]');
        if (find) find.addEventListener('input', function () {
            var q = find.value.trim().toLowerCase();
            chat.querySelectorAll('.cs-list li').forEach(function (li) { var a = li.querySelector('a'); li.hidden = !!q && (!a || (a.getAttribute('data-title') || '').indexOf(q) === -1); });
            chat.querySelectorAll('.cs-group').forEach(function (g) { var ul = g.nextElementSibling; g.hidden = !!ul && !ul.querySelector('li:not([hidden])'); });
        });

        // ── The composer.
        function grow() { if (!text) return; text.style.height = 'auto'; text.style.height = Math.min(text.scrollHeight, window.innerHeight * 0.4) + 'px'; }
        if (text) {
            text.addEventListener('input', function () { grow(); syncSend(); });
            text.addEventListener('keydown', function (e) {
                if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && fine) { e.preventDefault(); if (form.requestSubmit) form.requestSubmit(); else form.submit(); }
            });
            grow();
        }
        chat.querySelectorAll('[data-starter]').forEach(function (b) {
            b.addEventListener('click', function () { text.value = b.getAttribute('data-starter'); grow(); syncSend(); text.focus(); });
        });
        function openTurn() { var t = chat.querySelectorAll('.ct-turn'); var last = t[t.length - 1]; return last && (last.hasAttribute('data-open') || last.getAttribute('data-state') === 'needs_you') ? last : null; }
        var STOP = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" stroke="none"/></svg>';
        var SEND = send ? send.innerHTML : '';
        function syncSend() {
            if (!send) return;
            var busy = openTurn();
            send.classList.toggle('is-stop', !!busy && busy.hasAttribute('data-open'));
            send.innerHTML = busy && busy.hasAttribute('data-open') ? STOP : SEND;
            send.setAttribute('aria-label', busy && busy.hasAttribute('data-open') ? 'Stop' : 'Send');
            send.disabled = !(busy && busy.hasAttribute('data-open')) && !(text && text.value.trim());
        }
        syncSend();

        function problem(msg) {
            var p = form.querySelector('.cc-problem');
            if (!msg) { if (p) p.remove(); return; }
            if (!p) { p = document.createElement('p'); p.className = 'cc-problem'; p.setAttribute('role', 'alert'); form.insertBefore(p, form.firstChild); }
            p.textContent = msg;
        }
        function setParent(id) {
            var input = form.querySelector('input[name=parent]');
            if (!input) { input = document.createElement('input'); input.type = 'hidden'; input.name = 'parent'; form.appendChild(input); }
            input.value = id;
            if (text) text.placeholder = 'Reply to Actor';
        }

        if (form) form.addEventListener('submit', function (e) {
            var busy = openTurn();
            if (busy && busy.hasAttribute('data-open')) {      // Stop
                e.preventDefault();
                send.disabled = true;
                if (note) note.textContent = 'Stopping…';
                fetch('/tasks/' + encodeURIComponent(busy.getAttribute('data-task')) + '/cancel', { method: 'POST', credentials: 'same-origin', redirect: 'manual' }).catch(function () {});
                return;
            }
            if (!window.fetch || !text || !text.value.trim()) return;
            e.preventDefault();
            problem(null);
            send.disabled = true;
            var body = new URLSearchParams(new FormData(form));
            fetch('/chat', { method: 'POST', credentials: 'same-origin', headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' }, body: body.toString() })
                .then(function (r) { return r.json().catch(function () { return { error: 'That could not be sent. Try again.' }; }).then(function (j) { return { ok: r.ok, j: j }; }); })
                .then(function (res) {
                    if (!res.ok || !res.j.turn) { problem(res.j.error || 'That could not be sent. Try again.'); syncSend(); return; }
                    var thread = chat.querySelector('[data-thread]');
                    if (!thread) {
                        var hello = chat.querySelector('.ct-hello');
                        thread = document.createElement('ol'); thread.className = 'ct-thread'; thread.setAttribute('data-thread', '');
                        if (hello) hello.replaceWith(thread); else chat.querySelector('[data-scroll]').appendChild(thread);
                        var title = chat.querySelector('.ct-title'); if (title) title.textContent = text.value.trim().slice(0, 60);
                        try { history.pushState({}, '', res.j.url); } catch (err) { /* */ }
                        addChat(res.j.id, text.value.trim());
                    }
                    var box = document.createElement('div'); box.innerHTML = res.j.turn;
                    var turn = box.firstElementChild;
                    turn.classList.add('is-new');
                    thread.appendChild(turn);
                    text.value = ''; grow();
                    setParent(res.j.id);
                    follow(turn);
                    syncSend();
                    toBottom(true);
                })
                .catch(function () { problem('No connection. Your message is still in the box.'); syncSend(); });
        });

        // A new chat joins the top of the list.
        function addChat(id, title) {
            var list = chat.querySelector('.cs-list');
            if (!list) return;
            var empty = list.querySelector('.cs-empty'); if (empty) empty.remove();
            chat.querySelectorAll('.cs-list a[aria-current]').forEach(function (a) { a.removeAttribute('aria-current'); });
            var ul = list.querySelector('ul');
            if (!ul || !list.querySelector('.cs-group') || list.querySelector('.cs-group').textContent !== 'Today') {
                var g = document.createElement('p'); g.className = 'cs-group'; g.textContent = 'Today';
                ul = document.createElement('ul'); list.insertBefore(ul, list.firstChild); list.insertBefore(g, ul);
            }
            var li = document.createElement('li'), a = document.createElement('a'), dot = document.createElement('i'), span = document.createElement('span');
            a.href = '/chat/' + id; a.setAttribute('aria-current', 'page'); a.setAttribute('data-title', title.toLowerCase());
            dot.className = 'cs-dot'; span.textContent = title.slice(0, 80);
            a.appendChild(dot); a.appendChild(span); li.appendChild(a); ul.insertBefore(li, ul.firstChild);
        }

        // ── A turn at work: its stream, its live line, and the answer when it lands.
        function liveLine(turn) {
            var line = turn.querySelector('[data-live-line]');
            if (!line) return;
            var run = turn.querySelectorAll('.cw-tool.is-run b');
            var steps = turn.querySelectorAll('.cw-step span, .cw-note p');
            var txt = run.length ? 'Using ' + run[run.length - 1].textContent + '…'
                : steps.length ? steps[steps.length - 1].textContent : '';
            if (txt) line.textContent = txt.length > 90 ? txt.slice(0, 89) + '…' : txt;
        }
        function refresh(turn, done) {
            var id = turn.getAttribute('data-task');
            return fetch('/chat/turn/' + encodeURIComponent(id), { credentials: 'same-origin' })
                .then(function (r) { return r.ok ? r.text() : null; })
                .then(function (h) {
                    if (!h) return;
                    var stay = nearBottom();
                    var box = document.createElement('div'); box.innerHTML = h;
                    var next = box.firstElementChild;
                    if (!next) return;
                    var finished = !next.hasAttribute('data-open');
                    if (!finished) {
                        // Only the work list changes while it works: the fold keeps its open or closed state.
                        var list = turn.querySelector('[data-work]'), fresh = next.querySelector('[data-work]');
                        if (list && fresh) list.innerHTML = fresh.innerHTML;
                        else if (fresh) turn.querySelector('.ct-reply').innerHTML = next.querySelector('.ct-reply').innerHTML;
                        liveLine(turn);
                    } else {
                        turn.replaceWith(next);
                        var ans = next.querySelector('[data-answer]');
                        if (ans && !reduce) { ans.classList.add('is-reveal'); Array.prototype.forEach.call(ans.children, function (c, i) { c.style.animationDelay = Math.min(i, 14) * 55 + 'ms'; }); }
                        decorate(next);
                        var dot = chat.querySelector('.cs-list a[aria-current] .cs-dot'); if (dot) dot.remove();
                        if (note) note.textContent = '';
                        syncSend();
                        if (text && fine) text.focus();
                    }
                    if (stay) toBottom(true);
                    if (done && finished) done();
                })
                .catch(function () {});
        }
        function follow(turn) {
            if (!window.EventSource || !turn || !turn.hasAttribute('data-open') || turn.dataset.following) return;
            turn.dataset.following = '1';
            liveLine(turn);
            var id = turn.getAttribute('data-task');
            var src = new EventSource('/api/v1/tasks/' + encodeURIComponent(id) + '/events?after=' + encodeURIComponent(turn.getAttribute('data-last') || '0'));
            streams.push(src);
            var timer = 0;
            function soon() { if (timer) return; timer = setTimeout(function () { timer = 0; refresh(turn); }, 450); }
            src.addEventListener('output', function (m) {
                try {
                    var e = JSON.parse(m.data);
                    var line = turn.querySelector('[data-live-line]');
                    if (line && e.step === 'tool_call' && e.tool) line.textContent = 'Using ' + String(e.tool).replace(/_/g, ' ') + '…';
                } catch (err) { /* a malformed event is skipped */ }
                soon();
            });
            src.addEventListener('state', soon);
            src.addEventListener('end', function () { src.close(); clearTimeout(timer); timer = 0; refresh(turn); });
            src.onerror = function () { if (src.readyState === 2) setTimeout(function () { refresh(turn); }, 3000); };
        }
        chat.querySelectorAll('.ct-turn[data-open]').forEach(function (t) { follow(t); });

        // ── Copy: an answer, and each code block in it.
        function decorate(rootEl) {
            (rootEl || chat).querySelectorAll('[data-copy]').forEach(function (b) {
                if (b.dataset.wired) return; b.dataset.wired = '1'; b.hidden = false;
                b.addEventListener('click', function () {
                    var ans = b.closest('.ct-reply').querySelector('[data-answer]');
                    copy(ans ? ans.innerText : '', b);
                });
            });
            (rootEl || chat).querySelectorAll('.ct-answer pre').forEach(function (pre) {
                if (pre.querySelector('.ct-copy-code')) return;
                var b = document.createElement('button'); b.type = 'button'; b.className = 'ct-copy-code'; b.textContent = 'Copy';
                b.addEventListener('click', function () { var code = pre.querySelector('code') || pre; copy(code.innerText, b); });
                pre.appendChild(b);
            });
        }
        function copy(str, btn) {
            var label = btn.querySelector('span') || btn;
            var was = label.textContent;
            function ok() { label.textContent = 'Copied'; btn.classList.add('is-done'); setTimeout(function () { label.textContent = was; btn.classList.remove('is-done'); }, 1600); }
            if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(str).then(ok, function () {});
        }
        decorate(chat);
    }

    function stop() { streams.forEach(function (s) { try { s.close(); } catch (e) { /* */ } }); streams = []; }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
    document.addEventListener('ov:boost:load', start);
    window.addEventListener('pagehide', stop);
})();

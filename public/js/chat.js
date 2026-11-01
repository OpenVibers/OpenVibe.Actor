/* Actor's chat in the browser (plan L55 C1). The page works without this file; with it:
 *   - a message sends without a reload, its turn appears at once, and the thread stays at the bottom;
 *   - a turn that is working follows its event stream: the live line says what it is doing now, the work list fills in
 *     (the server renders it: GET /chat/turn/:id), and the answer fades in when it is done;
 *   - while Actor works, what you write steers that turn (it hears it at its next step) and Stop is its own button;
 *     Enter sends on a keyboard, Shift+Enter is a new line;
 *   - a turn working on a screen shows what Actor sees, refreshed every two seconds, with Bot's live view one tap away;
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
        // ── Files: the paperclip opens the picker; each file is a chip until it is sent (at most 4, 6 MB each).
        var attachBtn = chat.querySelector('[data-cc-attach]');
        var fileInput = chat.querySelector('[data-cc-files]');
        var chips = chat.querySelector('[data-cc-chips]');
        var picked = [];
        function drawChips() {
            if (!chips) return;
            chips.textContent = '';
            chips.hidden = !picked.length;
            picked.forEach(function (f, i) {
                var li = document.createElement('li');
                if (/^image\//.test(f.type)) {   // a data: URL: the page's CSP allows data: images, not blob:
                    var im = document.createElement('img'); im.alt = ''; li.appendChild(im);
                    var rd = new FileReader(); rd.onload = function () { im.src = String(rd.result); }; rd.readAsDataURL(f);
                }
                var name = document.createElement('span'); name.textContent = f.name; li.appendChild(name);
                var x = document.createElement('button'); x.type = 'button'; x.setAttribute('aria-label', 'Remove ' + f.name); x.textContent = '\u00d7';
                x.addEventListener('click', function () { picked.splice(i, 1); drawChips(); syncSend(); });
                li.appendChild(x); chips.appendChild(li);
            });
        }
        if (attachBtn && fileInput && window.FileReader) {
            attachBtn.hidden = false;
            attachBtn.addEventListener('click', function () { fileInput.click(); });
            fileInput.addEventListener('change', function () {
                Array.prototype.forEach.call(fileInput.files || [], function (f) {
                    if (picked.length >= 4) { problem('Attach at most 4 files to one message.'); return; }
                    if (f.size > 6 * 1048576) { problem(f.name + ' is over 6 MB.'); return; }
                    picked.push(f);
                });
                fileInput.value = '';
                drawChips(); syncSend();
            });
        }
        function readAll(files) {
            return Promise.all(files.map(function (f) {
                return new Promise(function (ok, no) {
                    var rd = new FileReader();
                    rd.onload = function () { ok({ name: f.name, type: f.type || '', data: String(rd.result).split(',')[1] || '' }); };
                    rd.onerror = function () { no(new Error('read')); };
                    rd.readAsDataURL(f);
                });
            }));
        }

        function openTurn() { var t = chat.querySelectorAll('.ct-turn'); var last = t[t.length - 1]; return last && (last.hasAttribute('data-open') || last.getAttribute('data-state') === 'needs_you') ? last : null; }
        var stopBtn = chat.querySelector('[data-cc-stop]');
        function working() { var t = openTurn(); return t && t.hasAttribute('data-open') ? t : null; }
        function syncSend() {
            if (!send) return;
            var w = working();
            if (stopBtn) { stopBtn.hidden = !w; stopBtn.type = 'button'; stopBtn.removeAttribute('formaction'); }
            form.setAttribute('action', w ? '/chat/' + w.getAttribute('data-task') + '/steer' : '/chat');
            if (text) text.placeholder = w ? 'Tell Actor something while it works' : (form.querySelector('input[name=parent]') ? 'Reply to Actor' : 'Ask Actor to do something');
            send.disabled = !(text && text.value.trim());
            if (attachBtn) attachBtn.disabled = !!w;
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

        if (stopBtn) stopBtn.addEventListener('click', function () {
            var w = working();
            if (!w) return;
            stopBtn.disabled = true;
            if (note) note.textContent = 'Stopping…';
            fetch('/tasks/' + encodeURIComponent(w.getAttribute('data-task')) + '/cancel', { method: 'POST', credentials: 'same-origin', redirect: 'manual' })
                .catch(function () {}).then(function () { stopBtn.disabled = false; });
        });
        // Steering: the words join the working turn's list at once, and the run hears them at its next step.
        function steer(w) {
            var said = text.value.trim();
            var row = document.createElement('li'); row.className = 'cw-you is-sending';
            row.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5.5h14v10H10l-5 4Z"/></svg><p></p>';
            row.querySelector('p').textContent = said;
            var list = w.querySelector('[data-work]');
            if (list) { var fold = list.closest('details'); if (fold) fold.open = true; list.appendChild(row); }
            text.value = ''; grow(); syncSend();
            var body = new URLSearchParams({ task: said });
            fetch('/chat/' + encodeURIComponent(w.getAttribute('data-task')) + '/steer', { method: 'POST', credentials: 'same-origin', headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' }, body: body.toString() })
                .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { return { ok: r.ok, j: j }; }); })
                .then(function (res) {
                    row.classList.remove('is-sending');
                    if (!res.ok) { row.remove(); text.value = said; grow(); syncSend(); problem(res.j.error || 'Actor could not take that just now.'); }
                })
                .catch(function () { row.remove(); text.value = said; grow(); syncSend(); problem('No connection. Your message is still in the box.'); });
        }

        if (form) form.addEventListener('submit', function (e) {
            if (!window.fetch || !text || !text.value.trim()) return;
            var w = working();
            if (w) { e.preventDefault(); problem(null); steer(w); return; }
            e.preventDefault();
            problem(null);
            send.disabled = true;
            var fields = {};
            new FormData(form).forEach(function (v, k) { if (typeof v === 'string') fields[k] = v; });
            (picked.length ? readAll(picked) : Promise.resolve([]))
                .then(function (files) {
                    if (files.length) fields.files = files;
                    return fetch('/chat', { method: 'POST', credentials: 'same-origin', headers: { accept: 'application/json', 'content-type': 'application/json' }, body: JSON.stringify(fields) });
                })
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
                    picked = []; drawChips();
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
                        if (list && fresh) {
                            // Keep a line the person just sent until the server's list has it too.
                            var sending = Array.prototype.slice.call(list.querySelectorAll('.cw-you.is-sending'));
                            list.innerHTML = fresh.innerHTML;
                            sending.forEach(function (r) { list.appendChild(r); });
                        } else if (fresh) turn.querySelector('.ct-reply').innerHTML = next.querySelector('.ct-reply').innerHTML;
                        // The screen appears (or its live link changes) when the run opens a desk.
                        var scr = turn.querySelector('[data-screen]'), scr2 = next.querySelector('[data-screen]');
                        if (scr && scr2 && (scr.hidden !== scr2.hidden || scr.getAttribute('data-desk') !== scr2.getAttribute('data-desk'))) { scr.replaceWith(scr2); screen(turn); }
                        liveLine(turn);
                    } else {
                        stopScreen(turn);
                        turn.replaceWith(next);
                        var ans = next.querySelector('[data-answer]');
                        if (ans && !reduce && !document.documentElement.hasAttribute('data-ov-motion')) streamIn(ans);
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
        // What Actor sees: the last picture, fetched every two seconds while the turn works (only when it changed).
        var screens = {};
        function screen(turn) {
            var id = turn.getAttribute('data-task');
            if (screens[id] || !turn.hasAttribute('data-open')) return;
            var fig = turn.querySelector('[data-screen]');
            if (!fig) return;
            var busyLoad = false;
            screens[id] = setInterval(function () {
                if (busyLoad || document.hidden) return;
                busyLoad = true;
                var img = new Image();
                img.onload = function () {
                    busyLoad = false;
                    var f = turn.querySelector('[data-screen]');
                    if (!f) return;
                    var shown = f.querySelector('img[data-look]');
                    if (!shown) {
                        var frame = f.querySelector('.ct-screen-frame');
                        if (!frame) { frame = document.createElement('div'); frame.className = 'ct-screen-frame'; f.insertBefore(frame, f.firstChild); }
                        var wait = frame.querySelector('.ct-screen-wait'); if (wait) wait.remove();
                        shown = document.createElement('img'); shown.setAttribute('data-look', ''); shown.alt = 'What Actor sees now';
                        frame.insertBefore(shown, frame.firstChild);
                    }
                    shown.src = img.src;
                    f.hidden = false;
                };
                img.onerror = function () { busyLoad = false; };
                img.src = '/tasks/' + encodeURIComponent(id) + '/look?at=' + Date.now();
            }, 2000);
        }
        function stopScreen(turn) { var id = turn.getAttribute('data-task'); if (screens[id]) { clearInterval(screens[id]); delete screens[id]; } }

        function follow(turn) {
            if (!window.EventSource || !turn || !turn.hasAttribute('data-open') || turn.dataset.following) return;
            turn.dataset.following = '1';
            screen(turn);
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

        // ── The answer streams in (the owner, 2026-11-01: "text streams in, with nice effects"). Actor shows an answer
        // only once a second model has checked it, so the words arrive together; they are revealed word by word, fast
        // (about a second for a long answer), the way a chat app types. Code blocks and tables come in whole. Nothing
        // is hidden from a screen reader: only opacity changes.
        function streamIn(ans) {
            var words = [];
            var walker = document.createTreeWalker(ans, NodeFilter.SHOW_TEXT, { acceptNode: function (n) { return n.parentNode.closest('pre, table, .evs') ? NodeFilter.FILTER_REJECT : (/\S/.test(n.nodeValue) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT); } });
            var nodes = [];
            while (walker.nextNode()) nodes.push(walker.currentNode);
            nodes.forEach(function (n) {
                var frag = document.createDocumentFragment();
                n.nodeValue.split(/(\s+)/).forEach(function (part) {
                    if (!part) return;
                    if (/^\s+$/.test(part)) { frag.appendChild(document.createTextNode(part)); return; }
                    var w = document.createElement('span'); w.className = 'sw'; w.textContent = part; frag.appendChild(w); words.push(w);
                });
                n.parentNode.replaceChild(frag, n);
            });
            var blocks = Array.prototype.slice.call(ans.querySelectorAll('pre, table, .evs, img'));
            blocks.forEach(function (b) { b.classList.add('sw'); });
            var all = words.concat(blocks);
            if (!all.length) return;
            ans.classList.add('is-streaming');
            var per = Math.max(2, Math.ceil(words.length / 45)), i = 0;   // about 45 frames, whatever the length
            (function step() {
                for (var k = 0; k < per && i < words.length; k++, i++) words[i].classList.add('on');
                blocks.forEach(function (b) { if (!b.classList.contains('on') && (b.compareDocumentPosition(words[Math.max(0, i - 1)]) & Node.DOCUMENT_POSITION_FOLLOWING)) b.classList.add('on'); });
                if (i < words.length) requestAnimationFrame(step);
                else { all.forEach(function (w) { w.classList.add('on'); }); setTimeout(function () { ans.classList.remove('is-streaming'); }, 300); }
            })();
        }

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

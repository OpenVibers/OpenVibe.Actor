/* Actor's chat in the browser (plan L55 C1), on the network's conversation UI (openvibe-shared/thread, ov-thread.js,
 * L55 C4). The page works without this file. ov-thread.js does what every chat does: the drawer and Find a chat, the
 * growing composer and Enter to send, starters, Copy, staying at the bottom, and the answer typing in. This file adds
 * Actor's own parts:
 *   - a message sends without a reload (files ride along), and its turn appears at once;
 *   - a turn that is working follows its event stream: the live line says what it is doing now, the work list fills
 *     in (the server renders it: GET /chat/turn/:id), and the finished turn is swapped in;
 *   - while Actor works, what you write steers that turn (it hears it at its next step) and Stop is its own button;
 *   - a turn working on a screen shows what Actor sees, refreshed every two seconds, with Bot's live view one tap away;
 *   - the model chip.
 * Booted on load and after an in-place page swap (openvibe-shared/boost's ov:boost:load).
 */
(function () {
    'use strict';
    var streams = [];

    // The person's own timezone, for a trigger made in the chat: the browser knows it, the server should not guess.
    // A cookie, not a token or a task field; the parser still refuses a zone Node does not know and asks instead.
    try {
        var zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
        if (zone) document.cookie = 'ov_tz=' + encodeURIComponent(zone) + '; Path=/; Max-Age=31536000; SameSite=Lax' + (location.protocol === 'https:' ? '; Secure' : '');
    } catch (e) { /* no Intl: the tool asks for the timezone */ }

    function start() {
        var chat = document.querySelector('.chat');
        if (!chat || chat.dataset.ready) return;
        chat.dataset.ready = '1';
        var form = chat.querySelector('[data-ovt-composer]');
        var text = chat.querySelector('[data-ovt-text]');
        var send = chat.querySelector('[data-ovt-send]');
        var note = chat.querySelector('[data-cc-note]');
        var fine = window.matchMedia && window.matchMedia('(hover: hover) and (pointer: fine)').matches;
        var reduce = document.documentElement.getAttribute('data-ov-motion') === 'off';

        // ── The canvas (plan HO9). The document rides in an inert template; openvibe-shared's ov-canvas.js draws it
        // into the wide panel and the phone fold from the same data. A button's label goes to the agent as the
        // person's own message (POST .../events, kind ask); a tick is theirs too (kind check), and the redraw is the
        // returned document. A canvas_set on the working turn's stream asks for the newest document.
        var canvasThread = chat.getAttribute('data-chat') || '';
        var canvasTimer = 0;
        var canvasVersion = 0;
        var canvasUpdatedTimer = 0;
        function canvasDocOf(box) {
            var tpl = box.querySelector('template[data-cc-canvas-doc]');
            if (!tpl) return null;
            try { return JSON.parse(tpl.content ? tpl.content.textContent : tpl.textContent); } catch (e) { return null; }
        }
        function canvasCount(n) {
            var word = n + (n === 1 ? ' item' : ' items');
            chat.querySelectorAll('[data-cc-canvas-count]').forEach(function (el) { el.textContent = word; });
        }
        function paintCanvas(doc) {
            if (!doc || !window.OVCanvas) return;
            chat.querySelectorAll('[data-cc-canvas]').forEach(function (box) {
                var host = box.querySelector('[data-cc-canvas-host]');
                if (host) window.OVCanvas.render(host, doc, {
                    onAsk: function (label) { canvasAsk(doc, label); },
                    onCheck: function (blockId, itemId, done) { canvasCheck(doc, blockId, itemId, done); },
                });
            });
            canvasCount(Array.isArray(doc.blocks) ? doc.blocks.length : 0);
            canvasVersion = Number(doc.version) || canvasVersion;
        }
        // A closed fold still says something changed: "updated" beside the count for a few seconds, text only.
        function canvasUpdated() {
            var el = chat.querySelector('.cc-canvas-phone [data-cc-canvas-updated]');
            if (!el) return;
            el.hidden = false;
            if (canvasUpdatedTimer) clearTimeout(canvasUpdatedTimer);
            canvasUpdatedTimer = setTimeout(function () { el.hidden = true; canvasUpdatedTimer = 0; }, 4000);
        }
        function canvasPost(doc, body) {
            return fetch('/api/v1/me/canvases/' + encodeURIComponent(doc.id) + '/events', {
                method: 'POST', credentials: 'same-origin',
                headers: { accept: 'application/json', 'content-type': 'application/json' },
                body: JSON.stringify(body),
            }).then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { return { ok: r.ok, j: j }; }); });
        }
        function canvasAsk(doc, label) {
            if (!doc || !doc.id) return;
            canvasPost(doc, { kind: 'ask', label: String(label == null ? '' : label) })
                .then(function (res) {
                    if (!res.ok) { problem(res.j.detail || res.j.error || 'Actor could not take that just now.'); return; }
                    var task = res.j.task || {};
                    location.assign(task.url || ('/chat/' + (task.id || '')));
                })
                .catch(function () { problem('No connection. The message was not sent.'); });
        }
        function canvasCheck(doc, blockId, itemId, done) {
            if (!doc || !doc.id) return;
            canvasPost(doc, { kind: 'check', block_id: blockId, item_id: itemId, done: !!done })
                .then(function (res) {
                    if (!res.ok) { problem(res.j.detail || res.j.error || 'That tick did not save.'); paintCanvas(doc); return; }
                    if (res.j.canvas) paintCanvas(res.j.canvas);
                })
                .catch(function () { problem('No connection. That tick did not save.'); paintCanvas(doc); });
        }
        function refreshCanvas() {
            if (!canvasThread) return;
            fetch('/api/v1/me/canvases?thread=' + encodeURIComponent(canvasThread), { credentials: 'same-origin', headers: { accept: 'application/json' } })
                .then(function (r) { return r.ok ? r.json() : null; })
                .then(function (j) {
                    var doc = j && Array.isArray(j.canvases) ? j.canvases[0] : null;
                    if (!doc) return;
                    // The first canvas was made while this page was open: the server renders the panel on a reload.
                    if (!chat.querySelector('[data-cc-canvas]')) { location.reload(); return; }
                    if (canvasVersion && Number(doc.version) > canvasVersion) canvasUpdated();
                    paintCanvas(doc);
                })
                .catch(function () {});
        }
        function canvasSoon() {
            if (canvasTimer) return;
            canvasTimer = setTimeout(function () { canvasTimer = 0; refreshCanvas(); }, 400);
        }
        (function () {
            var first = null;
            chat.querySelectorAll('[data-cc-canvas]').forEach(function (box) { if (!first) first = canvasDocOf(box); });
            if (first) paintCanvas(first);
            // Closed first (the bar is one 44 px line); the person's choice is kept per thread for this visit, so
            // a reload does not reopen what they closed or close what they opened.
            var folds = chat.querySelectorAll('.cc-canvas-phone');
            folds.forEach(function (box) {
                var key = 'ov-canvas-open:' + (box.getAttribute('data-thread') || canvasThread);
                try { if (window.sessionStorage && sessionStorage.getItem(key) === '1') box.open = true; } catch (e) { /* private mode */ }
                box.addEventListener('toggle', function () {
                    try { if (window.sessionStorage) sessionStorage.setItem(key, box.open ? '1' : '0'); } catch (e) { /* private mode */ }
                });
            });
        })();

        // ── The thread stays at the bottom while you are there.
        function nearBottom() { return window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 220; }
        function toBottom(smooth) { window.scrollTo({ top: document.documentElement.scrollHeight, behavior: smooth && !reduce ? 'smooth' : 'auto' }); }

        // ── The composer: ov-thread.js grows it, sends on Enter and fills starters. An input event lets it re-measure after
        // this file changes the words.
        function grow() { if (text) text.dispatchEvent(new Event('input')); }
        if (text) text.addEventListener('input', function () { syncSend(); });
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

        function openTurn() { var t = chat.querySelectorAll('.ovt-turn'); var last = t[t.length - 1]; return last && (last.hasAttribute('data-open') || last.getAttribute('data-state') === 'needs_you') ? last : null; }
        var stopBtn = chat.querySelector('[data-ovt-stop]');
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
            var row = document.createElement('li'); row.className = 'ovt-w-you is-sending';
            row.innerHTML = '<svg class="ovt-ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 20a8 8 0 0 1 16 0"/></svg><p></p>';
            row.querySelector('p').textContent = said;
            var list = w.querySelector('[data-ovt-work]');
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
                    var thread = chat.querySelector('[data-ovt-thread]');
                    if (thread && !thread.querySelector(':scope > li')) {
                        var title = chat.querySelector('.ovt-title'); if (title) title.textContent = text.value.trim().slice(0, 60);
                        try { history.pushState({}, '', res.j.url); } catch (err) { /* */ }
                        addChat(res.j.id, text.value.trim());
                    }
                    var turn = window.OVThread ? window.OVThread.add(res.j.turn) : null;
                    text.value = ''; grow();
                    picked = []; drawChips();
                    setParent(res.j.id);
                    if (turn) follow(turn);
                    syncSend();
                })
                .catch(function () { problem('No connection. Your message is still in the box.'); syncSend(); });
        });

        // A new chat joins the top of the list.
        function addChat(id, title) {
            var list = chat.querySelector('.ovt-list');
            if (!list) return;
            var empty = list.querySelector('.ovt-empty'); if (empty) empty.remove();
            chat.querySelectorAll('.ovt-list a[aria-current]').forEach(function (a) { a.removeAttribute('aria-current'); });
            var ul = list.querySelector('ul');
            if (!ul || !list.querySelector('.ovt-group') || list.querySelector('.ovt-group').textContent !== 'Today') {
                var g = document.createElement('p'); g.className = 'ovt-group'; g.textContent = 'Today';
                ul = document.createElement('ul'); list.insertBefore(ul, list.firstChild); list.insertBefore(g, ul);
            }
            var li = document.createElement('li'), a = document.createElement('a'), dot = document.createElement('span'), span = document.createElement('span');
            a.href = '/chat/' + id; a.setAttribute('aria-current', 'page'); a.setAttribute('data-title', title.toLowerCase());
            dot.className = 'ovt-dot'; dot.setAttribute('aria-hidden', 'true'); span.textContent = title.slice(0, 80);
            a.appendChild(dot); a.appendChild(span); li.appendChild(a); ul.insertBefore(li, ul.firstChild);
        }

        // ── A turn at work: its stream, its live line, and the answer when it lands.
        function liveLine(turn) {
            var line = turn.querySelector('[data-ovt-live]');
            if (!line) return;
            var run = turn.querySelectorAll('.ovt-w-tool.is-run b');
            var steps = turn.querySelectorAll('.ovt-w-step span, .ovt-w-note p');
            var txt = run.length ? 'Using ' + run[run.length - 1].textContent + '…'
                : steps.length ? steps[steps.length - 1].textContent : '';
            if (txt) line.textContent = txt.length > 90 ? txt.slice(0, 89) + '…' : txt;
        }
        // The answer as it is written (plan L55 C2): the stream's delta events ({ text, n }) build a draft under the work
        // fold, drawn from the text with a few Markdown marks (paragraphs, lists, headings, bold, code) as DOM nodes,
        // never as HTML. A new model call (n) starts a new draft; a draft the run then keeps as a note in the work list,
        // or that ended in tool calls, goes away. The finished turn replaces it with the stored, rendered answer.
        function drawInline(el, text) {
            String(text).split(/(\*\*[^*\n]+\*\*|`[^`\n]+`|\[E\d{1,3}\])/).forEach(function (part) {
                if (!part) return;
                var node;
                if (/^\*\*[^*]+\*\*$/.test(part)) { node = document.createElement('b'); node.textContent = part.slice(2, -2); }
                else if (/^\[E\d{1,3}\]$/.test(part)) { node = document.createElement('span'); node.className = 'ev'; node.textContent = part.slice(2, -1); }
                else if (/^`[^`]+`$/.test(part)) { node = document.createElement('code'); node.textContent = part.slice(1, -1); }
                else node = document.createTextNode(part);
                el.appendChild(node);
            });
        }
        function drawDraft(box, text) {
            box.textContent = '';
            var para = null, list = null, fence = null;
            String(text).split('\n').forEach(function (line) {
                if (/^\s*```/.test(line)) {
                    if (fence) { fence = null; return; }
                    var pre = document.createElement('pre'); fence = document.createElement('code'); pre.appendChild(fence); box.appendChild(pre);
                    para = list = null;
                    return;
                }
                if (fence) { fence.textContent += (fence.textContent ? '\n' : '') + line; return; }
                if (!line.trim()) { para = list = null; return; }
                var item = /^\s*(?:[-*•]|\d+[.)])\s+(.*)$/.exec(line);
                if (item) {
                    var kind = /^\s*\d/.test(line) ? 'OL' : 'UL';
                    if (!list || list.tagName !== kind) { list = document.createElement(kind.toLowerCase()); box.appendChild(list); }
                    var li = document.createElement('li'); drawInline(li, item[1]); list.appendChild(li);
                    para = null;
                    return;
                }
                var head = /^\s*#{1,6}\s+(.*)$/.exec(line);
                if (head) {
                    var h = document.createElement('p'); var b = document.createElement('b'); b.textContent = head[1].replace(/\*\*/g, ''); h.appendChild(b); box.appendChild(h);
                    para = list = null;
                    return;
                }
                list = null;
                if (!para) { para = document.createElement('p'); box.appendChild(para); } else para.appendChild(document.createTextNode(' '));
                drawInline(para, line);
            });
        }
        function draft(turn) {
            var d = turn._draft;
            var box = turn.querySelector('[data-ovt-draft]');
            if (!d || !d.text.trim()) { if (box) box.remove(); return; }
            if (!box) {
                var reply = turn.querySelector('.ovt-reply');
                if (!reply) return;
                box = document.createElement('div');
                box.className = 'ovt-answer ct-draft';
                box.setAttribute('data-ovt-draft', '');
                box.setAttribute('aria-busy', 'true');
                reply.appendChild(box);
            }
            var stay = nearBottom();
            drawDraft(box, d.text);
            if (stay) toBottom(false);
        }
        function addDelta(turn, e) {
            if (!e || typeof e.text !== 'string') return;
            var d = turn._draft;
            if (!d || d.n !== e.n) d = turn._draft = { n: e.n, text: '' };
            d.text += e.text;
            if (turn._drawing) return;
            turn._drawing = true;
            (window.requestAnimationFrame || function (fn) { return setTimeout(fn, 16); })(function () { turn._drawing = false; draft(turn); });
        }
        // A stored step that holds the draft's own text (the run kept it as a note), or a tool call: the draft is done.
        function settleDraft(turn, e) {
            var d = turn._draft;
            if (!d || !e) return;
            var said = typeof e.text === 'string' ? e.text.replace(/…$/, '').trim() : '';
            if (e.step === 'tool_call' || (e.step === 'text' && said && d.text.trim().indexOf(said) === 0)) { turn._draft = null; draft(turn); }
        }
        // A wait's deadline in the reader's own zone ("at 18:40", or with the day when it is not today).
        function localTimes(root) {
            (root || document).querySelectorAll('time[data-ct-local]').forEach(function (t) {
                var d = new Date(t.getAttribute('datetime'));
                if (isNaN(d)) return;
                var today = d.toDateString() === new Date().toDateString();
                t.textContent = 'at ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + (today ? '' : ' on ' + d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' }));
            });
        }
        localTimes(chat);
        // A parked turn's card (plan A2) comes and goes with the wait: it is outside the work list the refresh keeps.
        function syncWait(turn, next) {
            var cur = turn.querySelector('[data-ct-wait]'), fresh = next.querySelector('[data-ct-wait]');
            if (cur && !fresh) cur.remove();
            else if (fresh && !cur) { var reply = turn.querySelector('.ovt-reply'); if (reply) reply.appendChild(fresh); }
            else if (fresh && cur && cur.outerHTML !== fresh.outerHTML) cur.replaceWith(fresh);
            localTimes(turn);
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
                        var list = turn.querySelector('[data-ovt-work]'), fresh = next.querySelector('[data-ovt-work]');
                        if (list && fresh) {
                            // Keep a line the person just sent until the server's list has it too.
                            var sending = Array.prototype.slice.call(list.querySelectorAll('.ovt-w-you.is-sending'));
                            list.innerHTML = fresh.innerHTML;
                            sending.forEach(function (r) { list.appendChild(r); });
                        } else if (fresh) turn.querySelector('.ovt-reply').innerHTML = next.querySelector('.ovt-reply').innerHTML;
                        // The screen appears (or its live link changes) when the run opens a desk.
                        var scr = turn.querySelector('[data-screen]'), scr2 = next.querySelector('[data-screen]');
                        if (scr && scr2 && (scr.hidden !== scr2.hidden || scr.getAttribute('data-desk') !== scr2.getAttribute('data-desk'))) { scr.replaceWith(scr2); screen(turn); }
                        liveLine(turn);
                        draft(turn);
                        syncWait(turn, next);
                    } else {
                        stopScreen(turn);
                        // An answer the person already watched being written is not typed in again: it only takes its
                        // finished form (OVThread types in a turn that was open and is not any more).
                        if (turn.querySelector('[data-ovt-draft]')) turn.removeAttribute('data-open');
                        turn._draft = null;
                        if (window.OVThread) window.OVThread.replace(id, h); else turn.replaceWith(next);
                        var dot = chat.querySelector('.ovt-list a[aria-current] .ovt-dot'); if (dot) dot.remove();
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
        // The live desk (plan L55 C1b): when the turn works on one of the person's own desks, the server asks Bot for a
        // short-lived page that shows it moving and takes the mouse, and the turn frames it in place of the picture.
        // If Bot cannot, the picture keeps refreshing as before.
        function live(turn) {
            var fig = turn.querySelector('[data-screen][data-watch]');
            if (!fig || fig.hasAttribute('data-framed') || !turn.hasAttribute('data-open')) return;
            fig.setAttribute('data-framed', 'asking');
            fetch(fig.getAttribute('data-watch'), { method: 'POST', credentials: 'same-origin', headers: { Accept: 'application/json' } })
                .then(function (r) { return r.ok ? r.json() : null; })
                .catch(function () { return null; })
                .then(function (j) {
                    if (!j || !/^https:\/\//.test(j.url || '') || !fig.isConnected) { fig.setAttribute('data-framed', 'no'); return; }
                    var frame = fig.querySelector('.ct-screen-frame');
                    if (!frame) { frame = document.createElement('div'); frame.className = 'ct-screen-frame'; fig.insertBefore(frame, fig.firstChild); }
                    var f = document.createElement('iframe');
                    f.src = j.url;
                    f.title = 'Actor\'s desk, live. Click into it to take over.';
                    f.setAttribute('allow', 'fullscreen; clipboard-write');
                    f.setAttribute('referrerpolicy', 'no-referrer');
                    f.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-pointer-lock');
                    f.className = 'ct-desk';
                    frame.appendChild(f);
                    fig.classList.add('is-framed');
                    fig.hidden = false;
                    fig.setAttribute('data-framed', 'yes');
                    stopScreen(turn);   // the frame moves by itself: no more pictures to fetch
                    var a = fig.querySelector('.ct-watch');
                    if (a) { a.href = j.url; a.lastChild.textContent = 'Open it big'; }
                    var cap = fig.querySelector('figcaption > span');
                    if (cap) cap.textContent = j.control ? 'Actor\'s desk, live: click into it to take over' : 'Actor\'s desk, live';
                });
        }
        function screen(turn) {
            var id = turn.getAttribute('data-task');
            live(turn);
            if (screens[id] || !turn.hasAttribute('data-open')) return;
            var framed = turn.querySelector('[data-screen][data-framed="yes"]');
            if (framed) return;
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
            var src = new EventSource('/api/v1/tasks/' + encodeURIComponent(id) + '/events?deltas=1&after=' + encodeURIComponent(turn.getAttribute('data-last') || '0'));
            streams.push(src);
            var timer = 0;
            function soon() { if (timer) return; timer = setTimeout(function () { timer = 0; refresh(turn); }, 450); }
            src.addEventListener('output', function (m) {
                try {
                    var e = JSON.parse(m.data);
                    var line = turn.querySelector('[data-ovt-live]');
                    if (line && e.step === 'tool_call' && e.tool) line.textContent = 'Using ' + String(e.tool).replace(/_/g, ' ') + '…';
                    if (e.tool === 'canvas_set') canvasSoon();
                    settleDraft(turn, e);
                } catch (err) { /* a malformed event is skipped */ }
                soon();
            });
            src.addEventListener('delta', function (m) {
                try { addDelta(turn, JSON.parse(m.data)); } catch (err) { /* a malformed piece is skipped */ }
            });
            src.addEventListener('state', soon);
            src.addEventListener('end', function () { src.close(); clearTimeout(timer); timer = 0; canvasSoon(); refresh(turn); });
            src.onerror = function () { if (src.readyState === 2) setTimeout(function () { refresh(turn); }, 3000); };
        }
        chat.querySelectorAll('.ovt-turn[data-open]').forEach(function (t) { follow(t); });

        modelChip();
    }

    // ── The model chip (plan L55 C3): what this person's tasks run on. Opening it asks which of their own keys Actor
    // may use (names only, from OpenVibe.AI); a choice saves at once. Escape or a click elsewhere closes it.
    function modelChip() {
        var box = document.querySelector('[data-cc-model]');
        if (!box || box.dataset.wired) return;
        box.dataset.wired = '1';
        var label = box.querySelector('[data-ccm-label]');
        var fine = box.querySelector('[data-ccm-fine]');
        var ready = null;
        function mark() {
            box.querySelectorAll('[data-ccm-provider]').forEach(function (li) {
                var ok = !!(ready && ready.indexOf(li.getAttribute('data-ccm-provider')) !== -1);
                li.classList.toggle('is-ready', ok);
                var setup = li.querySelector('[data-ccm-setup]');
                if (setup) setup.hidden = ok;
            });
        }
        box.addEventListener('toggle', function () {
            if (!box.open) return;
            fetch('/api/v1/me/model', { credentials: 'same-origin', headers: { Accept: 'application/json' } })
                .then(function (r) { return r.ok ? r.json() : null; })
                .then(function (j) { if (j) { ready = Array.isArray(j.keys) ? j.keys : []; mark(); } })
                .catch(function () {});
        });
        box.addEventListener('click', function (e) {
            var b = e.target.closest('[data-ccm-choice]');
            if (!b) return;
            var choice = b.getAttribute('data-ccm-choice');
            b.disabled = true;
            fetch('/api/v1/me/model', { method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ choice: choice }) })
                .then(function (r) { return r.ok ? r.json() : r.json().then(function (j) { throw new Error((j && j.detail) || 'not saved'); }, function () { throw new Error('not saved'); }); })
                .then(function (j) {
                    box.querySelectorAll('[data-ccm-choice]').forEach(function (x) {
                        var on = x.getAttribute('data-ccm-choice') === choice;
                        x.classList.toggle('is-on', on);
                        x.setAttribute('aria-pressed', on ? 'true' : 'false');
                    });
                    var p = j && j.provider;
                    var name = p ? (b.querySelector('b') || {}).textContent : '';
                    if (label) label.textContent = p === 'node' ? 'Your computer' : p ? 'Your ' + name + ' key' : 'Auto';
                    // Chosen but not allowed yet: say what is left to do instead of letting the next task fail.
                    if (p && ready && ready.indexOf(p) === -1 && fine) {
                        fine.textContent = '';
                        fine.append(p === 'node' ? 'Your next task runs on your computer once you add its model and allow Actor: ' : 'Your next task runs on your ' + name + ' key once you allow Actor to use it: ');
                        var a = document.createElement('a');
                        a.href = 'https://ai.openvibe.services/you?allow=actor&provider=' + encodeURIComponent(p);
                        a.target = '_blank'; a.rel = 'noopener'; a.textContent = 'allow it at OpenVibe.AI';
                        fine.append(a, '.');
                    } else {
                        box.open = false;
                    }
                })
                .catch(function (err) { if (fine) fine.textContent = 'That did not save: ' + err.message; })
                .then(function () { b.disabled = false; });
        });
        document.addEventListener('click', function (e) { if (box.open && !box.contains(e.target)) box.open = false; });
        document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && box.open) { box.open = false; box.querySelector('summary').focus(); } });
    }

    function stop() { streams.forEach(function (s) { try { s.close(); } catch (e) { /* */ } }); streams = []; }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
    document.addEventListener('ov:boost:load', start);
    window.addEventListener('pagehide', stop);
})();

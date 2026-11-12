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
        // Composer v2 (openvibe-shared 4.215.0, the agent preset): the server renders a plain form for a browser without
        // script; with script it is replaced by the mounted composer, whose chips show each file's progress as Actor's
        // own file path reads it. The mount happens here, before ov-thread.js's DOMContentLoaded start, so the shared
        // thread binds to it too.
        var host = chat.querySelector('[data-cc-composer]');
        var form = null, text = null, send = null, note = null, composer = null;
        var uploaded = new Map();
        var uploadSeq = 0;
        var fine = window.matchMedia && window.matchMedia('(hover: hover) and (pointer: fine)').matches;
        var reduce = document.documentElement.getAttribute('data-ov-motion') === 'off';
        if (host) mountComposer();
        else {
            form = chat.querySelector('[data-ovt-composer]');
            text = chat.querySelector('[data-ovt-text]');
            send = chat.querySelector('[data-ovt-send]');
        }

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
        function toBottom(smooth) {
            // A short chat has nothing to scroll: don't hide the Now strip (or the start of the thread) for no reason.
            if (document.documentElement.scrollHeight <= window.innerHeight + 2) return;
            window.scrollTo({ top: document.documentElement.scrollHeight, behavior: smooth && !reduce ? 'smooth' : 'auto' });
        }

        // ── The composer: ov-thread.js grows it, sends on Enter and fills starters. An input event lets it re-measure after
        // this file changes the words.
        function grow() { if (text) text.dispatchEvent(new Event('input')); }
        if (text) text.addEventListener('input', function () { syncSend(); });
        // ── Composer v2: mount the agent preset (Attach, Speak, the mode chip, the round send) and wire it to Actor's
        // own send: JSON with the files as data URLs (server/tasks/inputs.js), and while Actor works, its steer route.
        function mountComposer() {
            if (!window.OpenVibeComposer) return;
            host.replaceChildren();
            var parent = host.getAttribute('data-parent') || '';
            var workingId = host.getAttribute('data-working') || '';
            var mode = host.getAttribute('data-mode') || 'balanced';
            composer = window.OpenVibeComposer.mount(host, {
                preset: 'agent', id: 'cc-composer',
                placeholder: workingId ? 'Tell Actor something while it works' : parent ? 'Reply to Actor' : 'Ask Actor to do something',
                label: 'Message Actor', maxLength: 20000,
                maxFiles: Number(host.getAttribute('data-max-files')) || 4,
                maxMb: Number(host.getAttribute('data-max-mb')) || 6,
                accept: host.getAttribute('data-accept') || '',
                mode: { name: 'mode', label: 'How Actor works', value: mode,
                    options: [['fastest', 'Fast'], ['balanced', 'Balanced'], ['best', 'Best'], ['cheapest', 'Cheapest'], ['private', 'Private']] },
                upload: function (file, onProgress) {
                    return new Promise(function (ok, no) {
                        var rd = new FileReader();
                        rd.onprogress = function (e) { if (e.lengthComputable) onProgress(e.total ? e.loaded / e.total : 0); };
                        rd.onload = function () {
                            var data = String(rd.result || '').split(',')[1] || '';
                            if (!data) { no(new Error('Could not read ' + file.name)); return; }
                            uploaded.set(file, { name: file.name, type: file.type || '', data: data });
                            ok({ id: 'up_' + (++uploadSeq) });
                        };
                        rd.onerror = function () { no(new Error('Could not read ' + file.name)); };
                        rd.readAsDataURL(file);
                    });
                },
                beforeSend: function (ctx) {
                    var bad = (ctx.files() || []).find(function (f) { return !allowedFile(f); });
                    if (bad) { problem('Actor reads text, code, CSV, JSON, PDFs and PNG, JPEG, WebP or GIF images.'); return false; }
                    return true;
                },
                onSubmit: function (v) { return submit(v); },
            });
            form = composer.form; text = composer.text; send = composer.send; note = composer.note;
            // The mode select lives under the chip's own look: keep the browser's select (hidden behind the chip), never
            // ov-forms' box, which would draw a second pill inside it.
            var modeSelect = form.querySelector('select[name="mode"]');
            if (modeSelect) modeSelect.setAttribute('data-ov-native', '');
            var parentInput = document.createElement('input');
            parentInput.type = 'hidden'; parentInput.name = 'parent'; parentInput.value = parent;
            form.appendChild(parentInput);
            if (host.getAttribute('data-text')) {
                text.value = host.getAttribute('data-text');
                text.dispatchEvent(new Event('input'));
            }
            if (host.getAttribute('data-busy')) text.placeholder = 'Tell Actor something while it works';
            // A starter chip fills the mounted box (ov-thread.js bound the plain one before this existed).
            chat.querySelectorAll('[data-ovt-starter]').forEach(function (b) {
                b.addEventListener('click', function () {
                    text.value = b.getAttribute('data-ovt-starter') || '';
                    text.dispatchEvent(new Event('input'));
                    text.focus();
                });
            });
        }
        function allowedFile(file) {
            return /^text\//.test(file.type) || /^application\/(pdf|json|xml|x-yaml|yaml|javascript|sql)$/.test(file.type) ||
                /^image\/(png|jpeg|webp|gif)$/.test(file.type) ||
                /\.(txt|md|markdown|csv|tsv|json|jsonl|ya?ml|toml|xml|html?|css|js|mjs|cjs|ts|tsx|jsx|py|rb|go|rs|java|kt|c|h|cpp|hpp|cs|php|sh|sql|log|ini|env\.example|srt|vtt|pdf)$/i.test(file.name);
        }
        // The file's data, read once by the composer's upload (for its progress chip) or here when a browser had none.
        function filePayload(file) {
            var ready = uploaded.get(file);
            if (ready) return Promise.resolve(ready);
            return new Promise(function (ok, no) {
                var rd = new FileReader();
                rd.onload = function () { ok({ name: file.name, type: file.type || '', data: String(rd.result || '').split(',')[1] || '' }); };
                rd.onerror = function () { no(new Error('Could not read ' + file.name)); };
                rd.readAsDataURL(file);
            });
        }
        function openTurn() { var t = chat.querySelectorAll('.ovt-turn'); var last = t[t.length - 1]; return last && (last.hasAttribute('data-open') || last.getAttribute('data-state') === 'needs_you') ? last : null; }
        var stopBtn = chat.querySelector('[data-ovt-stop]');
        function working() { var t = openTurn(); return t && t.hasAttribute('data-open') ? t : null; }
        function syncSend() {
            if (!send || !text) return;
            var w = working();
            if (stopBtn) { stopBtn.hidden = !w; stopBtn.type = 'button'; stopBtn.removeAttribute('formaction'); }
            text.placeholder = w ? 'Tell Actor something while it works' : (host && host.getAttribute('data-parent') ? 'Reply to Actor' : 'Ask Actor to do something');
        }
        syncSend();

        function problem(msg) {
            var root = form || host;
            if (!root) return;
            var p = root.querySelector('.cc-problem');
            if (!msg) { if (p) p.remove(); return; }
            if (!p) { p = document.createElement('p'); p.className = 'cc-problem'; p.setAttribute('role', 'alert'); root.insertBefore(p, root.firstChild); }
            p.textContent = msg;
        }
        function setParent(id) {
            if (host) host.setAttribute('data-parent', id);
            var input = form && form.querySelector('input[name=parent]');
            if (!input && form) { input = document.createElement('input'); input.type = 'hidden'; input.name = 'parent'; form.appendChild(input); }
            if (input) input.value = id;
            if (text) text.placeholder = 'Reply to Actor';
        }

        function sendChat(fields) {
            return new Promise(function (resolve, reject) {
                var xhr = new XMLHttpRequest();
                xhr.open('POST', '/chat');
                xhr.setRequestHeader('accept', 'application/json');
                xhr.setRequestHeader('content-type', 'application/json');
                xhr.upload.onprogress = function (event) {
                    if (!event.lengthComputable || !note) return;
                    note.textContent = 'Sending… ' + Math.round((event.total ? event.loaded / event.total : 0) * 100) + '%';
                };
                xhr.upload.onload = function () { if (note) note.textContent = 'Actor is reading the file…'; };
                xhr.onload = function () {
                    var data;
                    try { data = JSON.parse(xhr.responseText); } catch (e) { data = { error: 'That could not be sent. Try again.' }; }
                    resolve({ ok: xhr.status >= 200 && xhr.status < 300, j: data });
                };
                xhr.onerror = function () { reject(new Error('No connection')); };
                xhr.send(JSON.stringify(fields));
            });
        }

        // What composer v2's submit calls: steer the open turn, or send a new message (files and all) and draw its turn.
        function submit(v) {
            problem(null);
            if (!v.text) return false;
            var w = working();
            if (w) {
                return steer(w, v.text).then(function () { return undefined; }, function () { return false; });
            }
            var fields = { task: v.text, mode: v.mode || 'balanced' };
            var parent = host && host.getAttribute('data-parent');
            if (parent) fields.parent = parent;
            return Promise.all((v.files || []).map(filePayload))
                .then(function (files) {
                    if (files.length) fields.files = files;
                    return sendChat(fields);
                })
                .then(function (res) {
                    if (!res.ok || !res.j.turn) {
                        problem(res.j.error || 'That could not be sent. Try again.');
                        if (note) note.textContent = '';
                        return false;
                    }
                    if (note) note.textContent = '';
                    uploaded.clear();
                    var thread = chat.querySelector('[data-ovt-thread]');
                    if (thread && !thread.querySelector(':scope > li')) {
                        var title = chat.querySelector('.ovt-title'); if (title) title.textContent = v.text.slice(0, 60);
                        try { history.pushState({}, '', res.j.url); } catch (err) { /* */ }
                        addChat(res.j.id, v.text);
                    }
                    var turn = window.OVThread ? window.OVThread.add(res.j.turn) : null;
                    setParent(res.j.id);
                    if (turn) follow(turn);
                    syncSend();
                    refreshNow();
                    return undefined;
                })
                .catch(function () {
                    problem('No connection. Your message is still in the box.');
                    if (note) note.textContent = '';
                    return false;
                });
        }

        if (stopBtn) stopBtn.addEventListener('click', function () {
            var w = working();
            if (!w) return;
            stopBtn.disabled = true;
            if (note) note.textContent = 'Stopping…';
            fetch('/tasks/' + encodeURIComponent(w.getAttribute('data-task')) + '/cancel', { method: 'POST', credentials: 'same-origin', redirect: 'manual' })
                .catch(function () {}).then(function () { stopBtn.disabled = false; });
        });
        // Steering: the words join the working card at once, and the run hears them at its next step.
        function steer(w, said) {
            var row = document.createElement('li'); row.className = 'ovt-w-you is-sending';
            row.innerHTML = '<svg class="ovt-ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 20a8 8 0 0 1 16 0"/></svg><p></p>';
            row.querySelector('p').textContent = said;
            var list = w.querySelector('[data-ovt-work]');
            if (list) { var fold = list.closest('details'); if (fold) fold.open = true; list.appendChild(row); }
            return fetch('/chat/' + encodeURIComponent(w.getAttribute('data-task')) + '/steer', {
                method: 'POST', credentials: 'same-origin',
                headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({ task: said }).toString(),
            })
                .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { return { ok: r.ok, j: j }; }); })
                .then(function (res) {
                    row.classList.remove('is-sending');
                    if (!res.ok) { row.remove(); problem(res.j.error || 'Actor could not take that just now.'); throw new Error('steer'); }
                })
                .catch(function () { row.remove(); problem('No connection. Your message is still in the box.'); throw new Error('steer'); });
        }

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
                        // The card's state (Starting → Working → Checking) updates in place too.
                        var stateNow = turn.querySelector('[data-ct-run-state]'), stateFresh = next.querySelector('[data-ct-run-state]');
                        if (stateNow && stateFresh && stateNow.outerHTML !== stateFresh.outerHTML) stateNow.replaceWith(stateFresh);
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
                        refreshNow();
                        if (text && fine) text.focus();
                    }
                    if (stay) toBottom(true);
                    if (done && finished) done();
                })
                .catch(function () {});
        }
        // The "Now" strip (the Console's Now card, in the chat): refreshed from GET /chat/now while something runs.
        var nowTimer = 0;
        function paintNow() {
            return fetch('/chat/now', { credentials: 'same-origin' })
                .then(function (r) { return r.ok ? r.text() : null; })
                .then(function (h) {
                    if (h == null) return;
                    var box = chat.querySelector('[data-ct-now]');
                    if (!box) return;
                    var tmp = document.createElement('div'); tmp.innerHTML = h;
                    var fresh = tmp.firstElementChild;
                    if (fresh) box.replaceWith(fresh);
                })
                .catch(function () {});
        }
        function refreshNow() { if (nowTimer) return; nowTimer = setTimeout(function () { nowTimer = 0; paintNow(); }, 350); }
        setInterval(function () {
            if (document.hidden) return;
            if (chat.querySelector('[data-ct-run]') || chat.querySelector('[data-ct-now]:not([hidden])')) paintNow();
        }, 5000);

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
            // Nothing to look at yet: the hidden placeholder is filled by a later turn refresh, and only then is there a
            // picture to fetch (no request every two seconds for a run that never shows a screen).
            if (!fig || fig.hidden) return;
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

    }

    function stop() { streams.forEach(function (s) { try { s.close(); } catch (e) { /* */ } }); streams = []; }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
    document.addEventListener('ov:boost:load', start);
    window.addEventListener('pagehide', stop);
})();

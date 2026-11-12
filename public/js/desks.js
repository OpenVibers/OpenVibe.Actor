/* See it work (W1): the desk tile in a running task's card, the viewer with Take over / Pause / Stop, and a finished
 * run's replay. The calls are the SDK's names (desks, takeOver, handBack, replay) over Actor's own routes until
 * openvibe-sdk/agents carries them; a page can do what a script can.
 */
(function () {
    'use strict';
    var api = {
        async json(url, opts) {
            var r = await fetch(url, Object.assign({ credentials: 'same-origin', headers: { Accept: 'application/json' } }, opts || {}));
            var data = await r.json().catch(function () { return {}; });
            if (!r.ok) throw new Error((data && (data.detail || data.error)) || 'That did not work.');
            return data;
        },
        desks(run) { return this.json('/api/v1/tasks/' + encodeURIComponent(run) + '/desks'); },
        takeOver(run, desk) { return this.json('/api/v1/tasks/' + encodeURIComponent(run) + '/desks/' + encodeURIComponent(desk) + '/take-over', { method: 'POST' }); },
        handBack(run, desk, note) { return this.json('/api/v1/tasks/' + encodeURIComponent(run) + '/desks/' + encodeURIComponent(desk) + '/hand-back', { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify({ note: note || '' }) }); },
        input(run, desk, value) { return this.json('/api/v1/tasks/' + encodeURIComponent(run) + '/desks/' + encodeURIComponent(desk) + '/input', { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify(value) }); },
        replay(run) { return this.json('/api/v1/tasks/' + encodeURIComponent(run) + '/replay'); },
    };
    window.OVAgents = api;

    var seen = new WeakSet();
    var streams = new WeakMap();   // tile → { live, frame, timer, visible, paused, blob }
    var viewer = null;

    function taskOf(el) { return el.getAttribute('data-task'); }
    function deskIdOf(el) { return el.getAttribute('data-desk'); }

    function stopTimer(st) { if (st && st.timer) { clearInterval(st.timer); st.timer = 0; } }
    function stopBlob(st) { if (st && st.blob) { URL.revokeObjectURL(st.blob); st.blob = null; } }

    /** The stream is loaded only while its tile is on screen; Live's encoder stops when nobody watches. */
    function visible(el) {
        var r = el.getBoundingClientRect();
        return r.bottom > 0 && r.top < (window.innerHeight || 0) && r.right > 0 && r.left < (window.innerWidth || 0);
    }

    function show(img, src) {
        var st = streams.get(img);
        if (!st) return;
        fetch(src, { credentials: 'same-origin', cache: 'no-store' })
            .then(function (r) { return r.ok ? r.blob() : null; })
            .then(function (blob) {
                if (!blob || !st.visible || st.live || st.paused) return;
                stopBlob(st);
                st.blob = URL.createObjectURL(blob);
                img.src = st.blob;
                img.hidden = false;
            })
            .catch(function () {});
    }

    function startStill(tile, st) {
        stopTimer(st);
        var img = tile.querySelector('[data-ct-desk-still]');
        var src = tile.getAttribute('data-still');
        if (!img || !src) return;
        if (!st.visible || st.live || st.paused) return;
        show(img, src);
        st.timer = setInterval(function () { show(img, tile.getAttribute('data-still')); }, 1000);
    }

    /** Load the Live player while the tile is visible, and remove it when the tile leaves the screen. */
    function startStream(tile, st) {
        if (st.frame || !st.live || !st.live.embed_url || !st.visible || st.paused) return;
        var box = tile.querySelector('[data-ct-desk-frame]');
        if (!box) return;
        var frame = document.createElement('iframe');
        frame.src = st.live.embed_url;
        frame.title = 'The desk Actor works on, live';
        frame.setAttribute('allow', 'autoplay; fullscreen; clipboard-write');
        frame.setAttribute('referrerpolicy', 'no-referrer');
        frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-pointer-lock');
        box.appendChild(frame);
        st.frame = frame;
        var img = tile.querySelector('[data-ct-desk-still]');
        if (img) img.hidden = true;
        var badge = tile.querySelector('[data-ct-desk-live]');
        if (badge) badge.hidden = false;
        stopTimer(st);
    }
    function stopStream(st) {
        if (st.frame) { st.frame.remove(); st.frame = null; }
        var tile = st.tile;
        if (tile) {
            var badge = tile.querySelector('[data-ct-desk-live]');
            if (badge) badge.hidden = true;
            var img = tile.querySelector('[data-ct-desk-still]');
            if (img) img.hidden = false;
        }
    }

    function syncMeta(tile, fresh) {
        if (!tile || !fresh) return;
        for (var key of ['data-desk', 'data-where', 'data-kind', 'data-label', 'data-still']) {
            if (fresh.hasAttribute(key)) tile.setAttribute(key, fresh.getAttribute(key));
        }
        var cap = tile.querySelector('[data-ct-desk-caption]'), freshCap = fresh.querySelector('[data-ct-desk-caption]');
        if (cap && freshCap) cap.textContent = freshCap.textContent;
        var place = tile.querySelector('[data-ct-desk-place]'), freshPlace = fresh.querySelector('[data-ct-desk-place]');
        if (place && freshPlace) place.textContent = freshPlace.textContent;
        var ring = tile.querySelector('[data-ct-desk-ring]'), freshRing = fresh.querySelector('[data-ct-desk-ring]');
        if (ring && freshRing) ring.outerHTML = freshRing.outerHTML;
        else if (ring) ring.remove();
        else if (freshRing) tile.querySelector('[data-ct-desk-frame]').appendChild(freshRing);
        var url = tile.querySelector('[data-ct-desk-url]'), freshUrl = fresh.querySelector('[data-ct-desk-url]');
        if (url && freshUrl) { url.href = freshUrl.href; url.textContent = freshUrl.textContent; url.hidden = false; }
        else if (url) url.hidden = true;
        else if (freshUrl) tile.querySelector('figcaption').appendChild(freshUrl);
        var ask = tile.querySelector('[data-ct-desk-ask]'), freshAsk = fresh.querySelector('[data-ct-desk-ask]');
        if (ask && freshAsk) ask.outerHTML = freshAsk.outerHTML;
        else if (ask) ask.remove();
        else if (freshAsk) tile.appendChild(freshAsk);
    }

    function scan() {
        document.querySelectorAll('[data-ct-desk]').forEach(function (tile) {
            if (seen.has(tile)) return;
            seen.add(tile);
            var st = { tile: tile, live: null, frame: null, timer: 0, visible: false, paused: false, blob: null };
            streams.set(tile, st);
            var task = taskOf(tile);
            if (task) {
                api.desks(task).then(function (j) {
                    var found = (j.desks || []).find(function (d) { return d.id === deskIdOf(tile); }) || (j.desks || [])[0];
                    if (!found) return;
                    st.live = found.live || null;
                    st.width = found.width || 1280; st.height = found.height || 800;
                    tile.setAttribute('data-width', String(st.width)); tile.setAttribute('data-height', String(st.height));
                    if (found.label) tile.setAttribute('data-label', found.label);
                    if (found.browser_url) {
                        var a = tile.querySelector('[data-ct-desk-url]');
                        if (a) { a.href = found.browser_url; a.textContent = found.browser_url.replace(/^https?:\/\//, ''); a.hidden = false; }
                    }
                    paint(tile, st);
                }).catch(function () {});
            }
            paint(tile, st);
            var io = typeof IntersectionObserver === 'function' ? new IntersectionObserver(function (entries) {
                entries.forEach(function (entry) {
                    st.visible = entry.isIntersecting;
                    if (st.visible) { startStream(tile, st); startStill(tile, st); }
                    else { stopStream(st); stopTimer(st); }
                });
            }, { rootMargin: '80px' }) : null;
            if (io) io.observe(tile); else { st.visible = true; paint(tile, st); }
        });
        scanReplays();
    }

    function paint(tile, st) {
        st.visible = st.visible || visible(tile);
        if (st.live && st.live.embed_url) startStream(tile, st);
        else startStill(tile, st);
    }

    function openTile(tile, control) {
        var task = taskOf(tile);
        var desk = deskIdOf(tile);
        if (!task || !desk) return;
        var v = ensureViewer();
        v.hidden = false;
        v.dataset.task = task; v.dataset.desk = desk;
        v.dataset.control = '0'; v.dataset.state = 'watch';
        v._size = { width: Number(tile.getAttribute('data-width')) || 1280, height: Number(tile.getAttribute('data-height')) || 800 };
        v.querySelector('[data-ct-viewer-badge]').textContent = 'Watching';
        var badge = v.querySelector('[data-ct-viewer-badge]');
        badge.textContent = tile.getAttribute('data-label') || 'The desk';
        v.querySelector('[data-ct-viewer-caption-text]').textContent = (tile.querySelector('[data-ct-desk-caption]') || {}).textContent || '';
        var page = tile.querySelector('[data-ct-desk-url]');
        var capLink = v.querySelector('[data-ct-viewer-page]');
        if (page && page.href) { capLink.href = page.href; capLink.textContent = page.textContent; capLink.hidden = false; } else capLink.hidden = true;
        var stage = v.querySelector('[data-ct-viewer-stage]');
        stage.querySelectorAll('iframe,img').forEach(function (n) { n.remove(); });
        stage.querySelector('[data-ct-viewer-input]').hidden = false;
        var img = document.createElement('img');
        img.alt = 'The desk Actor works on';
        img.hidden = false;
        stage.insertBefore(img, stage.firstChild);
        var same = streams.get(tile);
        if (same) { stopStream(same); stopTimer(same); }
        v._live = same && same.live && same.live.embed_url ? same.live : null;
        v._img = img;
        if (v._live) {
            var frame = document.createElement('iframe');
            frame.src = v._live.embed_url;
            frame.title = 'The desk Actor works on, live';
            frame.setAttribute('allow', 'autoplay; fullscreen; clipboard-write');
            frame.setAttribute('referrerpolicy', 'no-referrer');
            frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-pointer-lock');
            stage.insertBefore(frame, stage.firstChild);
            img.hidden = true;
        }
        // The picture polls at 1/s only when there is no stream (or the stream is paused).
        v._still = function () {
            if (v.hidden || v.dataset.paused === '1') return;
            var src = tile.getAttribute('data-still');
            if (!src || (same && same.live && !v.dataset.paused)) return;
            fetch(src, { credentials: 'same-origin', cache: 'no-store' }).then(function (r) { return r.ok ? r.blob() : null; }).then(function (b) {
                if (b && !v.hidden && v.dataset.paused !== '1') img.src = URL.createObjectURL(b);
            }).catch(function () {});
        };
        v._still();
        clearInterval(v._timer);
        v._timer = setInterval(v._still, 1000);
        var side = v.querySelector('[data-ct-viewer-steps]');
        side.replaceChildren();
        var turn = document.querySelector('.ovt-turn[data-task="' + task + '"]');
        var list = turn && turn.querySelector('[data-ovt-work]');
        if (list) side.appendChild(list.cloneNode(true));
        var hint = v.querySelector('[data-ct-viewer-hint]');
        hint.textContent = 'Watch Actor work, or take over to use the mouse and keyboard yourself.';
        v.querySelector('[data-ct-viewer-take]').hidden = false;
        v.querySelector('[data-ct-viewer-hand]').hidden = true;
        v.querySelector('[data-ct-viewer-note]').hidden = true;
        v.querySelector('[data-ct-viewer-pause]').textContent = 'Pause';
        v.dataset.paused = '0';
        v.querySelector('[data-ct-viewer-input]').focus();
        if (control) takeOver(v);
        else v.querySelector('[data-ct-viewer-take]').focus();
    }

    function ensureViewer() {
        if (viewer) return viewer;
        viewer = document.createElement('div');
        viewer.className = 'ct-viewer';
        viewer.setAttribute('role', 'dialog');
        viewer.setAttribute('aria-modal', 'true');
        viewer.setAttribute('aria-label', 'The desk Actor works on');
        viewer.hidden = true;
        viewer.innerHTML = '<div class="ct-viewer-stage" data-ct-viewer-stage><span class="ct-viewer-badge" data-ct-viewer-badge>Watching</span><div class="ct-viewer-input" data-ct-viewer-input tabindex="0" aria-label="Use the desk"></div><div class="ct-viewer-caption"><span data-ct-viewer-caption-text></span><a data-ct-viewer-page hidden></a></div></div>'
            + '<aside class="ct-viewer-side"><h2>What Actor is doing</h2><div data-ct-viewer-steps></div></aside>'
            + '<div class="ct-viewer-bar"><p class="ct-viewer-hint" data-ct-viewer-hint></p><button type="button" class="is-primary" data-ct-viewer-take>Take over</button><button type="button" data-ct-viewer-pause>Pause</button><button type="button" data-ct-viewer-hand hidden>Hand back</button><button type="button" data-ct-viewer-stop>Stop</button><button type="button" data-ct-viewer-close>Close</button><div class="ct-viewer-note" data-ct-viewer-note hidden><input type="text" maxlength="1000" placeholder="A note for Actor, optional" data-ct-viewer-note-input aria-label="A note for Actor"><button type="button" data-ct-viewer-note-send>Hand back with note</button></div></div>';
        document.body.appendChild(viewer);
        viewer.querySelector('[data-ct-viewer-close]').addEventListener('click', closeViewer);
        viewer.querySelector('[data-ct-viewer-take]').addEventListener('click', function () { takeOver(viewer); });
        viewer.querySelector('[data-ct-viewer-pause]').addEventListener('click', function () { pauseViewer(viewer); });
        viewer.querySelector('[data-ct-viewer-stop]').addEventListener('click', function () { stopViewer(viewer); });
        viewer.querySelector('[data-ct-viewer-hand]').addEventListener('click', function () { handBack(viewer); });
        viewer.querySelector('[data-ct-viewer-note-send]').addEventListener('click', function () { handBack(viewer); });
        viewer.querySelector('[data-ct-viewer-input]').addEventListener('pointerdown', onPointer);
        viewer.querySelector('[data-ct-viewer-input]').addEventListener('wheel', onWheel, { passive: false });
        viewer.querySelector('[data-ct-viewer-input]').addEventListener('keydown', onKey);
        document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && viewer && !viewer.hidden) closeViewer(); });
        return viewer;
    }

    function closeViewer() {
        if (!viewer) return;
        viewer.hidden = true;
        clearInterval(viewer._timer);
        viewer.querySelectorAll('iframe').forEach(function (f) { f.remove(); });
        document.querySelectorAll('[data-ct-desk]').forEach(function (tile) { var st = streams.get(tile); if (st) paint(tile, st); });
    }

    function stageSize(v) {
        var stage = v.querySelector('[data-ct-viewer-stage]');
        var img = stage.querySelector('img');
        var size = v._size || {};
        return { width: (img && img.naturalWidth) || size.width || 1280, height: (img && img.naturalHeight) || size.height || 800, rect: stage.getBoundingClientRect() };
    }

    function sendInput(v, value) {
        var task = v.dataset.task, desk = v.dataset.desk;
        if (!task || !desk) return;
        api.input(task, desk, value).catch(function (err) {
            var hint = v.querySelector('[data-ct-viewer-hint]');
            if (hint) hint.textContent = err.message || 'The desk did not take that.';
        });
    }

    function point(v, e) {
        var s = stageSize(v);
        var x = Math.round((e.clientX - s.rect.left) / Math.max(1, s.rect.width) * s.width);
        var y = Math.round((e.clientY - s.rect.top) / Math.max(1, s.rect.height) * s.height);
        var ring = v.querySelector('.ct-viewer-ring');
        if (!ring) { ring = document.createElement('span'); ring.className = 'ct-viewer-ring'; v.querySelector('[data-ct-viewer-stage]').appendChild(ring); }
        ring.style.left = ((x / Math.max(1, s.width)) * 100).toFixed(2) + '%';
        ring.style.top = ((y / Math.max(1, s.height)) * 100).toFixed(2) + '%';
        return { x: x, y: y, width: s.width, height: s.height };
    }
    function onPointer(e) {
        if (!viewer || viewer.dataset.control !== '1') return;
        e.preventDefault();
        var p = point(viewer, e);
        sendInput(viewer, { action: e.button === 2 ? 'right_click' : 'click', x: p.x, y: p.y, width: p.width, height: p.height });
        viewer.querySelector('[data-ct-viewer-input]').focus();
    }
    function onWheel(e) {
        if (!viewer || viewer.dataset.control !== '1') return;
        e.preventDefault();
        var p = point(viewer, e);
        sendInput(viewer, { action: 'scroll', x: p.x, y: p.y, width: p.width, height: p.height, dy: e.deltaY > 0 ? 3 : -3 });
    }
    function onKey(e) {
        if (!viewer || viewer.dataset.control !== '1') return;
        var keys = { Enter: 'Return', Backspace: 'BackSpace', Tab: 'Tab', Escape: 'Escape', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Delete: 'Delete', ' ': 'space' };
        if (keys[e.key]) { e.preventDefault(); sendInput(viewer, { action: 'key', keys: keys[e.key] }); return; }
        if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); sendInput(viewer, { action: 'type', text: e.key }); }
    }

    async function takeOver(v) {
        var hint = v.querySelector('[data-ct-viewer-hint]');
        try {
            await api.takeOver(v.dataset.task, v.dataset.desk);
            v.dataset.control = '1';
            v.dataset.state = 'control';
            v.querySelector('[data-ct-viewer-badge]').textContent = 'You are driving';
            v.querySelector('[data-ct-viewer-take]').hidden = true;
            v.querySelector('[data-ct-viewer-hand]').hidden = false;
            v.querySelector('[data-ct-viewer-note]').hidden = false;
            hint.textContent = 'You are driving. Actor waits; click and type on the picture.';
            v.querySelector('[data-ct-viewer-input]').focus();
        } catch (err) {
            hint.textContent = err.message || 'Actor could not hand over the desk.';
        }
    }
    async function handBack(v) {
        var note = (v.querySelector('[data-ct-viewer-note-input]') || {}).value || '';
        try {
            await api.handBack(v.dataset.task, v.dataset.desk, note);
            v.dataset.control = '0';
            v.dataset.state = 'watch';
            v.querySelector('[data-ct-viewer-badge]').textContent = 'Actor is working';
            v.querySelector('[data-ct-viewer-take]').hidden = false;
            v.querySelector('[data-ct-viewer-hand]').hidden = true;
            v.querySelector('[data-ct-viewer-note]').hidden = true;
            v.querySelector('[data-ct-viewer-note-input]').value = '';
            v.querySelector('[data-ct-viewer-hint]').textContent = note.trim() ? 'Handed back with your note. Actor goes on.' : 'Handed back. Actor goes on.';
        } catch (err) {
            v.querySelector('[data-ct-viewer-hint]').textContent = err.message || 'Actor could not take the desk back.';
        }
    }
    function pauseViewer(v) {
        var paused = v.dataset.paused === '1';
        v.dataset.paused = paused ? '0' : '1';
        v.querySelector('[data-ct-viewer-pause]').textContent = paused ? 'Pause' : 'Resume';
        var stage = v.querySelector('[data-ct-viewer-stage]');
        if (!paused) {
            // Pause the picture: the Live player leaves, so the desk's encoder stops when nobody else watches.
            stage.querySelectorAll('iframe').forEach(function (f) { f.remove(); });
            if (v._img) v._img.hidden = false;
            v._still();
        } else if (v._live) {
            var frame = document.createElement('iframe');
            frame.src = v._live.embed_url;
            frame.title = 'The desk Actor works on, live';
            frame.setAttribute('allow', 'autoplay; fullscreen; clipboard-write');
            frame.setAttribute('referrerpolicy', 'no-referrer');
            frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-pointer-lock');
            stage.insertBefore(frame, stage.firstChild);
            if (v._img) v._img.hidden = true;
        }
    }
    function stopViewer(v) {
        fetch('/tasks/' + encodeURIComponent(v.dataset.task) + '/cancel', { method: 'POST', credentials: 'same-origin', redirect: 'manual' })
            .catch(function () {}).then(function () { closeViewer(); });
    }

    // ── Replay ──────────────────────────────────────────────────────────────────────────────────────────────────────
    function scanReplays() {
        document.querySelectorAll('[data-ct-replay]').forEach(function (box) {
            if (seen.has(box)) return;
            seen.add(box);
            var data = null;
            try { data = JSON.parse((box.querySelector('[data-ct-replay-data]') || {}).textContent || '[]'); } catch { data = []; }
            var range = box.querySelector('[data-ct-replay-range]');
            var img = box.querySelector('[data-ct-replay-img]');
            var caption = box.querySelector('[data-ct-replay-caption]');
            var link = box.querySelector('[data-ct-replay-link]');
            function show(i) {
                var st = data[i] || null;
                if (!st) return;
                range.value = String(i);
                caption.textContent = captionOf(st);
                if (st.still && img) { img.src = st.still.url; img.hidden = false; if (link) { link.href = st.still.url; link.hidden = false; } }
                else if (img) { img.hidden = true; if (link) link.hidden = true; }
                box.querySelectorAll('[data-ct-replay-step]').forEach(function (b) { b.classList.toggle('is-on', Number(b.getAttribute('data-ct-replay-step')) === i); });
            }
            function captionOf(st) {
                if (!st) return '';
                if (st.tool === 'computer_input') {
                    if (st.action === 'click' || st.action === 'double_click' || st.action === 'right_click') return 'Clicked at ' + Math.round(st.x || 0) + ', ' + Math.round(st.y || 0);
                    if (st.action === 'scroll') return 'Scrolled';
                    if (st.action === 'key') return 'Pressed a key';
                    if (st.action === 'move') return 'Moved the mouse';
                    return 'Typed';
                }
                if (st.tool === 'computer_browser') {
                    if (st.action === 'open') return 'Opened a page' + (st.url ? ': ' + st.url : '');
                    if (st.action === 'read') return 'Read the page';
                    if (st.action === 'click') return 'Clicked on the page';
                    if (st.action === 'fill') return 'Filled a field';
                    if (st.action === 'press') return 'Pressed a key';
                    if (st.action === 'back') return 'Went back';
                    return 'Used the browser';
                }
                if (st.tool === 'computer_screen') return 'Looked at the screen';
                return st.action === 'start' ? 'Started the desk' : st.action === 'stop' ? 'Stopped the desk' : 'Checked the desk';
            }
            if (range) range.addEventListener('input', function () { show(Number(range.value) || 0); });
            box.querySelectorAll('[data-ct-replay-step]').forEach(function (b) {
                b.addEventListener('click', function () { show(Number(b.getAttribute('data-ct-replay-step')) || 0); });
            });
            if (data.length) show(0);
        });
    }

    function syncDesk(turn, next) {
        var now = turn.querySelector('[data-ct-desk]'), fresh = next.querySelector('[data-ct-desk]');
        if (now && fresh) syncMeta(now, fresh);
        else if (now && !fresh) now.remove();
        else if (!now && fresh) {
            var reply = turn.querySelector('.ovt-reply');
            if (reply) reply.insertBefore(fresh, reply.firstChild);
            scan();
        }
    }

    document.addEventListener('click', function (e) {
        var take = e.target.closest && e.target.closest('[data-ct-takeover]');
        if (take) { var t = take.closest('[data-ct-desk]'); if (t) openTile(t, true); return; }
        var open = e.target.closest && e.target.closest('[data-ct-desk-open]');
        if (open) { var tile = open.closest('[data-ct-desk]'); if (tile) openTile(tile, false); }
    });
    window.OVDesks = { scan: scan, sync: syncDesk, open: openTile };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', scan); else scan();
    document.addEventListener('ov:boost:load', scan);
})();

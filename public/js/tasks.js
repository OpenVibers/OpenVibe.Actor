// Your tasks (/tasks, 2026-11-19): the task box grows as you type, and older tasks load as the list's end comes into
// view (the "Older tasks" link is the same page for a reader without scripts).
(function () {
    'use strict';
    var box = document.querySelector('[data-task-box] textarea');
    if (box) {
        var grow = function () { box.style.height = 'auto'; box.style.height = Math.min(box.scrollHeight + 2, window.innerHeight * 0.5) + 'px'; };
        box.addEventListener('input', grow);
    }
    var list = document.querySelector('[data-tk-list]');
    var more = document.querySelector('[data-tk-more]');
    if (!list || !more || !('IntersectionObserver' in window) || !window.fetch || !window.DOMParser) return;
    var loading = false;
    var io = new IntersectionObserver(function (entries) {
        if (!entries.some(function (e) { return e.isIntersecting; }) || loading || !more) return;
        loading = true;
        fetch(more.href, { credentials: 'same-origin', headers: { accept: 'text/html' } })
            .then(function (r) { return r.ok ? r.text() : null; })
            .then(function (text) {
                if (!text) return;
                var doc = new DOMParser().parseFromString(text, 'text/html');
                var rows = doc.querySelectorAll('[data-tk-list] > li');
                Array.prototype.forEach.call(rows, function (li) { list.appendChild(document.importNode(li, true)); });
                var next = doc.querySelector('[data-tk-more]');
                if (next) { more.href = next.getAttribute('href'); } else { io.disconnect(); more.parentNode.remove(); more = null; }
            })
            .catch(function () { /* the link still works */ })
            .then(function () { loading = false; });
    }, { rootMargin: '0px 0px 600px 0px' });
    io.observe(more);
})();

/* /compare/:id (11-16): while a way is still working, the page asks for itself every few seconds and swaps the sides in
 * place when something changed (a side finished, the grading came in). Stops when everything is graded or the tab is
 * hidden for long. No framework; text arrives as the server rendered it. */
(function () {
    'use strict';
    // The form (/compare): two ways show, "Add a way" shows the next one, up to six. Without script all six show.
    var add = document.querySelector('.cmp-add');
    if (add) {
        var rows = Array.prototype.slice.call(document.querySelectorAll('[data-cmp-way]'));
        var shown = 0;
        rows.forEach(function (row, i) {
            var sel = row.querySelector('select');
            var keep = i < 2 || (sel && sel.value);
            row.hidden = !keep;
            if (keep) shown = i + 1;
        });
        add.hidden = shown >= rows.length;
        add.addEventListener('click', function () {
            var next = rows.filter(function (r) { return r.hidden; })[0];
            if (!next) return;
            next.hidden = false;
            var sel = next.querySelector('select');
            if (sel) sel.focus();
            add.hidden = !rows.some(function (r) { return r.hidden; });
        });
    }
    var lede = document.querySelector('[data-cmp-state]');
    if (!lede || lede.getAttribute('data-cmp-state') === 'done') return;
    var tries = 0;
    function tick() {
        if (document.hidden) { setTimeout(tick, 5000); return; }
        if (++tries > 400) return;
        fetch(location.href, { credentials: 'same-origin', headers: { Accept: 'text/html' }, cache: 'no-store' })
            .then(function (r) { return r.ok ? r.text() : null; })
            .then(function (text) {
                if (!text) { setTimeout(tick, 6000); return; }
                var doc = new DOMParser().parseFromString(text, 'text/html');
                var nextSides = doc.querySelector('.cmp-sides');
                var nextLede = doc.querySelector('[data-cmp-state]');
                var sides = document.querySelector('.cmp-sides');
                if (nextSides && sides && nextSides.innerHTML !== sides.innerHTML) sides.innerHTML = nextSides.innerHTML;
                if (nextLede) { lede.innerHTML = nextLede.innerHTML; lede.setAttribute('data-cmp-state', nextLede.getAttribute('data-cmp-state')); }
                if (lede.getAttribute('data-cmp-state') !== 'done') setTimeout(tick, 3000);
            })
            .catch(function () { setTimeout(tick, 6000); });
    }
    setTimeout(tick, 2500);
})();

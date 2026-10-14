// The Console refreshes itself while a task runs (server/http/console-pages.js), but never under a person who is typing
// a task: it waits until the command box is empty and not focused.
(function () {
    'use strict';
    var head = document.querySelector('[data-live]');
    if (!head) return;
    var every = Math.max(5, Number(head.getAttribute('data-live')) || 10) * 1000;
    var box = document.getElementById('cn-task');
    function busy() { return box && (document.activeElement === box || box.value.trim() !== ''); }
    setInterval(function () { if (!busy() && document.visibilityState === 'visible') location.reload(); }, every);
})();

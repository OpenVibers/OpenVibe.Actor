'use strict';
(() => {
    const base = location.pathname, ticket = new URL(location.href).searchParams.get('t');
    const url = (part) => `${base}/${part}?t=${encodeURIComponent(ticket || '')}`;
    const state = document.getElementById('state'), steps = document.getElementById('steps'), desk = document.getElementById('desk');
    let stopped = false, picture;
    const events = new EventSource(url('events'), { withCredentials: false });
    function stop(expired) {
        stopped = true;
        events.close();
        clearInterval(poll);
        if (picture) URL.revokeObjectURL(picture);
        desk.hidden = true;
        if (expired) { state.textContent = 'This view has expired'; steps.replaceChildren(); }
    }
    function append(e) {
        const data = JSON.parse(e.data);
        const li = document.createElement('li');
        li.textContent = data.text || data.title || data.step || data.kind;
        steps.append(li);
        if (data.state) state.textContent = data.state;
        if (data.kind === 'end') { state.textContent = data.state || 'Finished'; events.close(); }
    }
    for (const kind of ['state', 'step', 'output', 'error', 'end']) events.addEventListener(kind, append);
    async function still() {
        if (stopped) return;
        try {
            const r = await fetch(url('still'), { credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store' });
            if (r.status === 403) return stop(true);
            if (!r.ok) { desk.hidden = true; return; }
            const blob = await r.blob();
            if (stopped) return;
            if (picture) URL.revokeObjectURL(picture);
            picture = URL.createObjectURL(blob); desk.src = picture; desk.hidden = false;
        } catch { /* the next frame can recover */ }
    }
    const poll = setInterval(still, 3000);
    still();
    setTimeout(() => stop(true), Math.max(0, Date.parse(document.body.dataset.expires) - Date.now()));
    window.addEventListener('pagehide', () => stop(false));
})();

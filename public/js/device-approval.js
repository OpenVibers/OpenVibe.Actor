'use strict';

// One tap, one answer. The server checks ownership, kind and the fresh approval again.
(() => {
    const root = document.querySelector('[data-device-approval]');
    if (!root) return;
    const id = root.dataset.deviceApproval;
    const status = root.querySelector('[data-status]');
    const base = `/api/v1/me/approvals/${encodeURIComponent(id)}`;
    let busy = false;
    const say = (message) => { status.textContent = message; };
    const send = async (path, body, type) => {
        const response = await fetch(`${base}${path}`, { method: 'POST', credentials: 'same-origin',
            headers: { 'Content-Type': type }, body });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.detail || 'The request could not be answered.');
        return data;
    };
    const finish = async (answer) => {
        await send('/answer', JSON.stringify(answer), 'application/json');
        location.reload();
    };
    const work = async (action) => {
        if (busy) return;
        busy = true;
        try { await action(); } catch (error) { say(error.message || 'The answer could not be sent.'); }
        finally { busy = false; }
    };
    root.querySelector('[data-decline]').addEventListener('click', () => work(() => finish({ decision: 'decline' })));
    const photo = root.querySelector('[data-photo]');
    if (photo) photo.addEventListener('change', () => work(async () => {
        const file = photo.files && photo.files[0];
        if (!file) return;
        if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 10 * 1024 * 1024) {
            throw new Error('Choose one JPEG, PNG or WebP photo of at most 10 MB.');
        }
        say('Sending your photo…');
        const uploaded = await send('/photo', file, file.type);
        await finish({ decision: 'answer', photo: { media_id: uploaded.media_id } });
    }));
    root.querySelectorAll('[data-location]').forEach((button) => button.addEventListener('click', () => work(async () => {
        if (!navigator.geolocation) throw new Error('This browser cannot read your location.');
        const precise = button.dataset.location === 'precise';
        say('Waiting for your location permission…');
        const position = await new Promise((resolve, reject) => navigator.geolocation.getCurrentPosition(resolve, reject,
            { enableHighAccuracy: precise, maximumAge: 0, timeout: 15000 }));
        const coords = position.coords;
        await finish({ decision: 'answer', location: {
            lat: precise ? coords.latitude : Math.round(coords.latitude * 100) / 100,
            lng: precise ? coords.longitude : Math.round(coords.longitude * 100) / 100,
            accuracy_m: precise ? coords.accuracy : Math.max(coords.accuracy, 1000), precise,
        } });
    })));
})();

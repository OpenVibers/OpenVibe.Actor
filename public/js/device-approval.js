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
    const photo = root.querySelector('[data-photo-picker]');
    if (photo && window.OVUpload) {
        const queue = OVUpload.queue(photo, {
            label: 'Take or choose a photo', accept: 'image/jpeg,image/png,image/webp', multiple: false,
            upload: (file, { onProgress, signal }) => new Promise((resolve, reject) => {
                if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 10 * 1024 * 1024) {
                    reject(new Error('Choose one JPEG, PNG or WebP photo of at most 10 MB.'));
                    return;
                }
                const xhr = new XMLHttpRequest();
                xhr.open('POST', `${base}/photo`);
                xhr.setRequestHeader('Content-Type', file.type);
                xhr.upload.onprogress = (event) => { if (event.lengthComputable) onProgress({ uploadedBytes: event.loaded }); };
                xhr.onload = () => {
                    let data;
                    try { data = JSON.parse(xhr.responseText); } catch (_) { data = {}; }
                    if (xhr.status >= 200 && xhr.status < 300) resolve(data);
                    else reject(new Error(data.detail || 'The photo could not be sent. Try again.'));
                };
                xhr.onerror = () => reject(new Error('The connection stopped. Try again.'));
                signal.addEventListener('abort', () => xhr.abort(), { once: true });
                xhr.send(file);
            }),
            onDone: (_file, uploaded) => work(() => finish({ decision: 'answer', photo: { media_id: uploaded.media_id } })),
        });
        queue.picker.input.setAttribute('capture', 'environment');
    }
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

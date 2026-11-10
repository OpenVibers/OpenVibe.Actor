(function () {
    'use strict';
    if (!document.querySelector('[data-actor-page]')) return;
    const $ = s => document.querySelector(s);
    const api = '/api/v1/me/actor';
    let controlling = false, refreshing = false, oldFrame = null, cursor = null;
    function notice(text, error) { const n = $('#ay-notice'); if (n) { n.textContent = text; n.classList.toggle('ay-error', !!error); } }
    async function request(path, body, method) {
        const r = await fetch(api + path, { method: method || (body === undefined ? 'GET' : 'POST'), credentials: 'same-origin', headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
        const value = await r.json();
        if (!r.ok) throw new Error(value.detail || 'That step could not be completed. Please try again.');
        return value;
    }
    async function refresh() {
        if (refreshing || document.querySelector('dialog[open]') || controlling || !document.querySelector('[data-actor-page]')) return;
        refreshing = true;
        try {
            const r = await fetch('/you?fragment=1', { credentials: 'same-origin' });
            if (!r.ok) return;
            const doc = new DOMParser().parseFromString(await r.text(), 'text/html');
            for (const id of ['ay-header','ay-now','ay-asks','ay-today','ay-goals','ay-replies','ay-brain']) {
                const current = document.getElementById(id), next = doc.getElementById(id);
                if (current && next) current.replaceWith(next);
            }
            window.OpenVibeKitWeb?.enhance(document);
        } finally { refreshing = false; }
    }
    const handle = fn => async ev => { try { await fn(ev); } catch (err) { notice(err.message, true); } };
    async function take() {
        await request('/computer/take', {});
        controlling = true;
        const stage = $('.ay-screen');
        if (stage) { stage.dataset.control = 'true'; stage.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
        if ($('#ay-type')) $('#ay-type').hidden = false;
        if ($('[data-back]')) $('[data-back]').hidden = false;
        notice('The screen is yours. Sign in there, then choose Done.');
    }
    async function input(value) { const result=await request('/computer/input', { kind: 'input', value }); if(result.result==='refused') throw new Error('Take over the screen before using it.'); return result; }
    async function showSites() {
        const result = await request('/sites');
        const list = document.createElement('ul');
        for (const site of result.sites) {
            const li = document.createElement('li'), span = document.createElement('span'), b = document.createElement('button');
            span.textContent = site; b.textContent = 'Sign it out'; b.className = 'ovk-btn ovk-btn--quiet'; b.type = 'button'; b.dataset.signOut = site;
            li.append(span,b); list.append(li);
        }
        $('#ay-sites').replaceChildren(list);
        if (!result.sites.length) $('#ay-sites').textContent = 'No saved sign-ins yet.';
    }
    async function edit(goal, lane) {
        const f = $('#ay-goal-form'); f.reset();
        const defaults = await request('/lanes');
        const g = goal || { lane: lane || 'custom', text: '', budget: defaults[lane || 'custom'].budget, asks_before: defaults[lane || 'custom'].asks_before, every_minutes: 1440 };
        for (const k of ['id','text','lane']) f.elements[k].value = g[k] || '';
        f.elements.usd.value = g.budget.usd; f.elements.minutes.value = g.budget.minutes;
        f.elements.hours.value = g.every_minutes / 60; f.elements.asks_before.value = g.asks_before.join('\n');
        f.elements.zone.value = g.schedule?.zone || Intl.DateTimeFormat().resolvedOptions().timeZone;
        f.elements.start.value = g.schedule?.start ?? 9; f.elements.end.value = g.schedule?.end ?? 18;
        f.querySelectorAll('[name=day]').forEach(n => { n.checked = !g.schedule || g.schedule.days.includes(Number(n.value)); });
        $('[data-delete-goal]').hidden = !g.id;
        $('#ay-lanes').close(); $('#ay-goal-editor').showModal();
    }
    document.addEventListener('click', handle(async ev => {
        const b = ev.target.closest('button'); if (!b || !b.closest('[data-actor-page]')) return;
        if (b.dataset.action) { await request('/' + b.dataset.action, {}); await refresh(); }
        else if (b.hasAttribute('data-rename')) { const name = window.prompt('Your Actor’s name', $('.ay-name-button').textContent); if (name) { await request('', { name }, 'PATCH'); await refresh(); } }
        else if (b.dataset.jump) document.getElementById(b.dataset.jump)?.scrollIntoView({ behavior:'smooth' });
        else if (b.dataset.answer || b.dataset.decline) { controlling = false; await request('/asks/' + (b.dataset.answer || b.dataset.decline) + (b.dataset.decline ? '/decline' : '/answer'), { text: b.dataset.text || '' }); await refresh(); }
        else if (b.hasAttribute('data-sign-in') || b.hasAttribute('data-take')) await take();
        else if (b.hasAttribute('data-back')) { await request('/computer/back', {}); controlling = false; notice('Your Actor has the screen again.'); await refresh(); }
        else if (b.hasAttribute('data-fullscreen')) await $('.ay-screen')?.requestFullscreen();
        else if (b.dataset.key && controlling) await input({ action:'key', keys:b.dataset.key });
        else if (b.dataset.lane) await edit(null,b.dataset.lane);
        else if (b.dataset.editGoal) await edit(JSON.parse(b.dataset.goal));
        else if (b.hasAttribute('data-delete-goal')) { if (window.confirm('Delete this goal?')) { await request('/goals/' + $('#ay-goal-form').elements.id.value, undefined, 'DELETE'); $('#ay-goal-editor').close(); await refresh(); } }
        else if (b.dataset.brain) { const id = $('#ay-brain-goal').value; await request(id ? '/goals/' + id : '', id ? { brain_override:b.dataset.brain } : { brain:b.dataset.brain }, 'PATCH'); $('#ay-brain').close(); notice('From the next step.'); await refresh(); }
        else if (b.hasAttribute('data-sites')) await showSites();
        else if (b.dataset.signOut) { await request('/sites/' + encodeURIComponent(b.dataset.signOut),undefined,'DELETE'); await showSites(); }
        else if (b.hasAttribute('data-computer-time')) { const h=await request('/computer-log'); const list=document.createElement('ul'); for(const row of h.sessions) { const li=document.createElement('li'); li.textContent=new Date(row.timings.created_at).toLocaleDateString()+' · '+Math.ceil(row.usage.desk_seconds/60)+' minutes'; list.append(li); } $('#ay-computer-time').replaceChildren(list); if(!h.sessions.length) $('#ay-computer-time').textContent='No computer time yet.'; }
        else if (b.hasAttribute('data-history')) { const h = await request('/computer-log'); $('#ay-history').textContent = h.actions.map(x => new Date(x.at).toLocaleTimeString() + ' · ' + (x.actor.kind === 'person' ? 'You took over' : x.actor.kind === 'ai' ? 'Handed back to your Actor' : 'Control ended')).join('\n') || 'No take-overs yet.'; }
        else if (b.hasAttribute('data-earlier')) { const before=cursor || b.dataset.before; const result = await request('/journal?limit=100' + (before ? '&before=' + encodeURIComponent(before) : '')); cursor = result.next_cursor; const list = document.createElement('ul'); for (const j of result.items) { const li = document.createElement('li'); li.textContent = new Date(j.created_at).toLocaleString() + ' · ' + j.text; list.append(li); } b.before(list); b.hidden = !result.next_cursor || !result.items.length; }
    }));
    document.addEventListener('change', handle(async ev => {
        const n = ev.target;
        if (n.dataset.goalToggle) { await request('/goals/' + n.dataset.goalToggle, { enabled:n.checked }, 'PATCH'); await refresh(); }
        if (n.hasAttribute('data-adult')) { await request('', { adult_opt_in:n.checked }, 'PATCH'); $('#ay-brain').close(); await refresh(); }
    }));
    document.addEventListener('submit', handle(async ev => {
        const f = ev.target; if (!f.closest('[data-actor-page]')) return; ev.preventDefault();
        const fields = new FormData(f);
        if (f.getAttribute('id') === 'ay-tell-form') {
            const attachments = [];
            for (const file of fields.getAll('files')) if (file.size) { if (file.size > 8000 || attachments.length >= 5) throw new Error('Attach up to five text files, each under 8 KB.'); attachments.push({ name:file.name,text:await file.text() }); }
            await request('/tell', { text:fields.get('text'), attachments }); f.reset(); notice('Your Actor will read this on its next step.'); await refresh();
        } else if (f.getAttribute('id') === 'ay-goal-form') {
            const id = fields.get('id'), body = { text:fields.get('text'),lane:fields.get('lane'),every_minutes:Math.round(Number(fields.get('hours'))*60),budget:{usd:Number(fields.get('usd')),minutes:Number(fields.get('minutes'))},asks_before:String(fields.get('asks_before')).split('\n').map(x=>x.trim()).filter(Boolean),schedule:{days:fields.getAll('day').map(Number),start:Number(fields.get('start')),end:Number(fields.get('end')),zone:fields.get('zone')} };
            await request('/goals' + (id ? '/' + id : ''),body,id?'PATCH':'POST'); $('#ay-goal-editor').close(); await refresh();
        } else if (f.getAttribute('id') === 'ay-run-model') { await request('/runs/' + encodeURIComponent(f.dataset.task) + '/model',{model:fields.get('model')}); notice('The next step will use that model.'); await refresh(); }
        else if (f.getAttribute('id') === 'ay-earn') { await request('/earnings',{text:fields.get('text'),usd:Number(fields.get('usd')),confirmed:fields.get('confirmed')==='on'}); f.reset(); notice('Earnings added.'); location.reload(); }
        else if (f.getAttribute('id') === 'ay-computer-form') { const kind=fields.get('kind'); await request('',{computer:{kind,...(kind==='link'?{machine_id:fields.get('machine_id')}:{})}},'PATCH'); notice('Computer saved.'); await refresh(); }
        else if (f.getAttribute('id') === 'ay-type' && controlling) { const text=fields.get('text'); f.reset(); await input({action:'type',text}); }
        else if (f.dataset.answerForm) { await request('/asks/' + f.dataset.answerForm + '/answer',{text:fields.get('text')}); await refresh(); }
    }));
    document.addEventListener('click', handle(async ev => {
        if (ev.target.id !== 'ay-screen' || !controlling) return;
        const img=ev.target, r=img.getBoundingClientRect(), width=img.naturalWidth, height=img.naturalHeight;
        if (!width || !height) return;
        const scale=Math.min(r.width/width,r.height/height), left=r.left+(r.width-width*scale)/2, top=r.top+(r.height-height*scale)/2;
        const x=Math.round((ev.clientX-left)/scale), y=Math.round((ev.clientY-top)/scale);
        if(x>=0 && x<width && y>=0 && y<height) await input({action:'click',x,y,width,height});
    }));
    document.addEventListener('wheel', ev => {
        if(ev.target.id!=='ay-screen' || !controlling) return;
        ev.preventDefault();
        input({action:'scroll',dy:Math.sign(ev.deltaY)*3}).catch(err=>notice(err.message,true));
    },{passive:false});
    const poll=setInterval(() => { if (!document.querySelector('[data-actor-page]')) return clearInterval(poll); if (!document.hidden) refresh().catch(()=>{}); },15000);
    const frames=setInterval(async () => {
        const img=$('#ay-screen'); if (!document.querySelector('[data-actor-page]')) return clearInterval(frames); if (!img || document.hidden) return;
        try { const r=await fetch(api+'/computer/still',{credentials:'same-origin'}); if(!r.ok)return; const next=URL.createObjectURL(await r.blob()); img.src=next; if(oldFrame)URL.revokeObjectURL(oldFrame); oldFrame=next; } catch {}
    },2000);
})();
// More (the status bar): it closes when one of its items is chosen, or on a press anywhere else.
document.addEventListener('click', (e) => { const m = document.querySelector('.ay-more[open]'); if (m && (!m.contains(e.target) || (e.target.closest && e.target.closest('.ay-more-item')))) m.open = false; });

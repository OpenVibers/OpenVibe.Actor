'use strict';
const assert = require('assert');
const crypto = require('crypto');
const { boot, done } = require('./helpers/boot');
const { render } = require('../server/day/page');
const SAME = { 'sec-fetch-site':'same-origin' };
(async()=>{
    const t = await boot({env:{ACTOR_CHECKPOINT_KEY:crypto.randomBytes(32).toString('hex')}});
    try {
        const user=t.network.addUser('you'), other=t.network.addUser('other');
        const api=(path='',json,method)=>t.get('/api/v1/me/actor'+path,{as:user,json,method,headers:SAME});
        const a=(await api()).json();
        const base={actor:a,models:[{id:'test/uncensored@1',name:'Uncensored model'}]};
        assert.match(render(base),/data-state="Paused"/);
        for(const status of ['working','resting']){
            const actor={...a,enabled:true,status,now:{...a.now,current_step:'Reading the page',next:{goal:'goal',text:'Find a useful opening',at:new Date().toISOString()}}};
            assert.match(render({...base,actor}),new RegExp('data-state="'+(status==='working'?'Working':'Resting')+'"'));
            if(status==='resting')assert.match(render({...base,actor}),/Do it now/);
            else {assert.doesNotMatch(render({...base,actor}),/id="ay-screen"/);assert.match(render({...base,actor,session_id:'ses_01J8Z4M2Q0R7T9YV3K6N8P1W2A'}),/id="ay-screen"/);}
        }
        assert.doesNotMatch(render(base),/Uncensored/);
        assert.match(render({...base,actor:{...a,adult_opt_in:true}}),/Uncensored/);
        assert.match(render({...base,actor:{...a,asks:[{id:'ask',kind:'sign_in',text:'Sign in to the site',options:['Sign in on its screen','Done']} ]}}),/Waiting for you/);
        const page=await t.get('/you',{as:user});assert.equal(page.status,200,page.text);assert.match(page.text,/ovt-composer/);
        assert.equal((await t.get('/you')).status,302);
        const g=(await api('/goals',{text:'Find a useful job',lane:'find_work',schedule:{days:[1,2,3,4,5],start:9,end:17,zone:'America/Los_Angeles'}})).json();
        assert.deepEqual(g.schedule.days,[1,2,3,4,5]);
        assert.equal((await api('/goals/'+g.id,{schedule:{days:[],start:9,end:17,zone:'UTC'}},'PATCH')).status,422);
        assert.equal((await api('/do-now',{})).status,409,'off remains off');
        const msg=await api('/tell',{text:'Use my notes',attachments:[{name:'notes.txt',text:'Focus on remote work.'}]});assert.equal(msg.status,201,msg.text);
        assert.equal((await api('/earnings',{text:'Paid project',usd:40,confirmed:false})).status,422);
        assert.equal((await api('/earnings',{text:'Paid project',usd:40,confirmed:true})).status,201);
        const data=(await api('/page')).json();assert.equal(data.messages[0].attachments[0].name,'notes.txt');assert.equal(data.earnings[0].usd,40);
        assert.equal((await t.get('/api/v1/me/actor/page',{as:other})).json().earnings.length,0);
        const schedule=require('../server/day/schedule');assert.equal(schedule.open(g.schedule,Date.parse('2026-11-09T18:00:00Z')),true);assert.equal(schedule.open(g.schedule,Date.parse('2026-11-08T18:00:00Z')),false);
        const calls=[];
        t.ctx.computers.personSession=async(...args)=>{calls.push(args);return{saved:true};};
        const r=await t.ctx.s.db.maybe('SELECT id FROM actors WHERE owner=$1',['user:'+user.subject]);
        // The ordinary day test covers full park/resume; sign-in also carries the screen and saves before answering.
        await api('',{computer:{kind:'openvibe'}},'PATCH');
        await api('/resume',{});
        t.providers.state.smart='tool';t.providers.state.script=[{content:'What city?',tool_calls:[{id:'ask-city',type:'function',function:{name:'hand_to_person',arguments:JSON.stringify({machine:'run:ses_01J8Z4M2Q0R7T9YV3K6N8P1W2A',what:'Sign in on this screen'})}}]}];
        const tomorrow=(new Date().getUTCDay()+1)%7;
        await t.ctx.s.db.query('UPDATE actor_day_goals SET schedule=$2::jsonb WHERE id=$1',[g.id,JSON.stringify({days:[tomorrow],start:0,end:24,zone:'UTC'})]);
        const immediate=await api('/do-now',{goal:g.id});assert.equal(immediate.status,200,immediate.text);
        const ids=[immediate.json().active_task];assert.ok(ids[0],'Do it now runs outside the usual hours');
        const until=Date.now()+15000;let q;
        while(Date.now()<until){q=(await t.ctx.day.asks('user:'+user.subject))[0];if(q)break;await new Promise(r=>setTimeout(r,25));}
        assert.ok(q);
        await api('/tell',{text:'Use the newer notes',attachments:[{name:'next.txt',text:'Only remote roles.'}]});
        const incoming=await t.ctx.day.stepMessages(ids[0]);
        assert.equal(incoming.length,1);assert.equal(incoming[0].text,'Use the newer notes');
        assert.equal((await t.ctx.day.stepMessages(ids[0])).length,1,'a crash before saving still delivers the message');
        assert.equal((await t.ctx.day.stepMessages(ids[0],incoming.map(m=>m.id))).length,0,'saved steps do not repeat messages');
        const snapshots=require('../server/runtime/checkpoint-state');
        assert.deepEqual(snapshots.restore(snapshots.snapshot({dayMessageIds:incoming.map(m=>m.id)})).dayMessageIds,incoming.map(m=>m.id));
        assert.equal(q.kind,'sign_in');assert.ok(q.options.includes('Done'));
        const parkedUntil=Date.now()+5000; let parked;
        while(Date.now()<parkedUntil){parked=await t.ctx.s.db.maybe('SELECT w.remaining_ms FROM actor_waits w JOIN actor_day_asks q ON q.wait_id=w.id WHERE q.id=$1',[q.id]);if(parked?.remaining_ms!=null)break;await new Promise(r=>setTimeout(r,20));}
        assert.ok(parked.remaining_ms>0,'sign-in parks the task and stops its clock');
        assert.equal(await t.ctx.day.retainDesk(ids[0]),true);
        const answer=await api('/asks/'+q.id+'/answer',{text:'Done'});assert.equal(answer.status,200,answer.text);
        assert.deepEqual(calls.slice(0,2).map(c=>c[2]),['save','back']);
        assert.equal(await t.ctx.day.retainDesk(ids[0]),false);
        await api('/pause',{});
    }finally{await t.close();}
})().then(()=>done()).catch(e=>{process.stderr.write((e.stack||String(e))+'\n');process.exit(1);});

'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { boot, done } = require('./helpers/boot');
let playwright;
try { playwright = require('playwright'); } catch { try { playwright = require('/home/workstation/openvibe/work/OpenVibe.Games/node_modules/playwright'); } catch {} }
if (!playwright || !fs.existsSync('/usr/bin/google-chrome') || process.env.OV_SKIP_BROWSER === '1') { process.stdout.write('Chrome not available; server state and API tests remain required.\n'); process.exit(0); }
(async()=>{
    const t=await boot();
    t.config.baseUrl=t.base;
    const user=t.network.addUser('lea');
    let browser;
    try{
        const a=await t.ctx.day.ensure('user:'+user.subject);
        await t.ctx.day.update(a.owner,{name:'Milo'});
        await t.ctx.day.saveGoal(a.owner,{text:'Find remote design roles that fit my portfolio',lane:'find_work'});
        await t.ctx.day.saveGoal(a.owner,{text:'Brief me on useful changes in design tools',lane:'brief_me'});
        await t.ctx.s.db.query("UPDATE actors SET enabled=true,status='working' WHERE id=$1",[a.id]);
        const goal=(await t.ctx.day.goals(a.owner))[0];
        await t.ctx.s.db.query("INSERT INTO actor_day_journal(id,actor_id,goal_id,owner,text,cost_usd,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)",[t.ctx.s.newId('ajr'),a.id,goal.id,a.owner,'Comparing three remote design roles with your experience.',0.04,t.ctx.s.iso()]);
        await t.ctx.s.db.query('INSERT INTO actor_day_usage(actor_id,goal_id,owner,day,usd) VALUES($1,$2,$3,$4,$5)',[a.id,goal.id,a.owner,t.ctx.s.iso().slice(0,10),0.04]);
        await t.ctx.day.tell(a.owner,'Focus on teams that offer flexible hours.');
        browser=await playwright.chromium.launch({executablePath:'/usr/bin/google-chrome',headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
        const out=process.env.ACTOR_SCREENSHOT_DIR;
        if(out)fs.mkdirSync(out,{recursive:true});
        for(const [width,scheme] of [[390,'dark'],[390,'light'],[1280,'dark'],[1280,'light']]){
            const context=await browser.newContext({viewport:{width,height:900},colorScheme:scheme,deviceScaleFactor:1,isMobile:width<700,hasTouch:width<700});
            const [name,...rest]=t.signIn(user).split('=');
            await context.addCookies([{name,value:rest.join('='),url:t.base}]);
            const page=await context.newPage(), errors=[];
            page.setDefaultTimeout(10000);
            page.on('response',async r=>{if(r.url().includes('/api/v1/me/actor') && r.status()>=400) process.stderr.write('Actor API '+r.status()+' '+await r.text()+'\n');});
            page.on('pageerror',e=>errors.push(e.message));
            page.on('console',m=>{if(m.type()==='error'&&/Content Security Policy|Refused to|Uncaught/i.test(m.text()))errors.push(m.text());});
            const response=await page.goto(t.base+'/you',{waitUntil:'load'});
            assert.equal(response.status(),200,await page.locator('body').innerText());
            assert.ok(await page.locator('#ay-now').count(),'Actor page missing: '+page.url()+' '+(await page.locator('body').innerText()).slice(0,500));
            await page.waitForFunction(()=>Boolean(window.OpenVibeThemeLoader));
            await page.evaluate(s=>window.OpenVibeThemeLoader.apply(s==='light'?'daylight':'vibe'),scheme);
            await page.waitForSelector('#ay-now');
            assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),width,'no horizontal scroll');
            assert.equal(await page.locator('.ay-state').textContent(),'Working');
            await page.locator('[data-ovk-sheet="#ay-brain"]').click();
            await page.waitForSelector('#ay-brain[open]');
            assert.ok(!(await page.locator('#ay-brain').innerText()).includes('Uncensored'));
            await page.locator('#ay-brain [data-ovk-close]').click();
            await page.locator('[data-ovk-sheet="#ay-lanes"]').click();
            await page.waitForSelector('#ay-lanes[open]');
            assert.equal(await page.locator('[data-lane]').count(),6);
            await page.locator('[data-lane="watch_deals"]').click();
            await page.waitForSelector('#ay-goal-editor[open]');
            await page.locator('#ay-goal-form [name=text]').fill('Watch the price of a desk lamp');
            await page.locator('#ay-goal-form button[type=submit], #ay-goal-form button:not([type])').first().click();
            await page.waitForFunction(()=>!document.getElementById('ay-goal-editor').open,null,{timeout:10000}).catch(async err=>{throw new Error(err.message+' Notice: '+await page.locator('#ay-notice').textContent()+' Invalid: '+await page.locator('#ay-goal-form :invalid').evaluateAll(ns=>ns.map(n=>n.name+':'+n.validationMessage).join(';')));});
            await page.waitForFunction(()=>document.getElementById('ay-goals').textContent.includes('Watch the price of a desk lamp'));
            await page.evaluate(()=>window.scrollTo(0,0));
            assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),width,'no overflow after updating goals');
            if(out)await page.screenshot({path:path.join(out,'actor-'+width+'-'+scheme+'.png'),fullPage:true});
            await page.locator('[data-ovk-sheet="#ay-brain"]').click();
            await page.waitForSelector('#ay-brain[open]');
            await page.locator('#ay-brain [data-ovk-close]').click();
            const added=(await t.ctx.day.goals(a.owner)).find(g=>g.text==='Watch the price of a desk lamp');
            await t.ctx.day.removeGoal(a.owner,added.id);
            assert.deepEqual(errors,[]);
            await context.close();
        }
        // A real pending Ask, answered by the page through the scoped API.
        const calls=[];
        t.ctx.day.asks=async()=>[];
        const actualPage=t.ctx.day.pageData;
        t.ctx.day.pageData=async owner=>{
            const d=await actualPage(owner);
            d.actor.asks=calls.length?[]:[{id:'ask_test',kind:'answer_question',text:'Which city should I use?',options:['Paris','Berlin'],evidence:{text:'These are the two cities on your shortlist.'}}];
            return d;
        };
        const actualAnswer=t.ctx.day.answer;
        t.ctx.day.answer=async(owner,id,body)=>{calls.push({owner,id,text:body.text});return{answered:true};};
        const c=await browser.newContext({viewport:{width:390,height:900}});
        const [name,...rest]=t.signIn(user).split('=');await c.addCookies([{name,value:rest.join('='),url:t.base}]);
        const pg=await c.newPage();await pg.goto(t.base+'/you');await pg.locator('[data-answer="ask_test"][data-text="Berlin"]').click();
        await pg.waitForFunction(()=>!document.querySelector('[data-answer="ask_test"]'));
        assert.deepEqual(calls,[{owner:a.owner,id:'ask_test',text:'Berlin'}]);
        t.ctx.day.answer=actualAnswer;
        await c.close();
    }finally{if(browser)await browser.close();await t.close();}
})().then(()=>done()).catch(e=>{process.stderr.write((e.stack||String(e))+'\n');process.exit(1);});

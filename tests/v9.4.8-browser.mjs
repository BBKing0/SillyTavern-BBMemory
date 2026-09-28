import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const require = createRequire(process.env.BB_PLAYWRIGHT_MODULE || import.meta.url);
const { chromium } = require('playwright');
const root = fileURLToPath(new URL('../../', import.meta.url));
const output = resolve(root, '_tmp_v948_screens');
const server = createServer(async (req,res) => {
    try {
        const path = decodeURIComponent(new URL(req.url,'http://localhost').pathname);
        if (path === '/') { res.setHeader('Content-Type','text/html; charset=utf-8');res.end('<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/BB-Memory/style.css"><style>body{background:#171923;color:#eee;font:16px system-ui}button,input,textarea,select{font:inherit}button{cursor:pointer;color:inherit;background:#303348;border:1px solid #666;padding:.4em}.bb-input{background:#242638;color:#eee;border:1px solid #666}</style><body></body></html>');return; }
        const file = resolve(root,'.'+path);
        if (!file.startsWith(root)) {res.writeHead(403).end();return;}
        res.setHeader('Content-Type',extname(file)==='.js'?'text/javascript; charset=utf-8':extname(file)==='.css'?'text/css; charset=utf-8':'text/plain; charset=utf-8');res.end(await readFile(file));
    } catch {res.writeHead(404).end();}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));await mkdir(output,{recursive:true});
let browser;
try {
    browser=await chromium.launch({headless:true,...(process.env.BB_BROWSER_CHANNEL?{channel:process.env.BB_BROWSER_CHANNEL}:{})});
    for (const width of [1280,390]) {
        const page=await browser.newPage({viewport:{width,height:650}}), errors=[];
        page.on('pageerror',e=>errors.push(e.message));
        await page.goto(`http://127.0.0.1:${server.address().port}/`);
        await page.evaluate(async()=>{
            const bank=new Map();const lf={async getItem(k){return structuredClone(bank.get(k)??null)},async setItem(k,v){bank.set(k,structuredClone(v));return v},async removeItem(k){bank.delete(k)}};
            const ctx={libs:{localforage:lf},extensionSettings:{},chatId:'ui948',characterId:0,chat:[],chatMetadata:{},saveSettingsDebounced(){},saveMetadataDebounced(){},getWorldInfoNames:()=>Array.from({length:12},(_,i)=>'世界书'+i)};
            globalThis.SillyTavern={getContext:()=>ctx};globalThis.toastr={success(){},warning(){},info(){},error(){}};
            const s=await import('/BB-Memory/memory-store.js');s.updateSettings({autoBackupEnabled:false,embeddingEnabled:false});
            const npc=await s.addNpcProfile(ctx.chatId,{name:'林澈',role:'老师',biography:'旧小传'});globalThis.npcId=npc.id;
            globalThis.ms=await s.addMilestone(ctx.chatId,{event:'北征准备',summary:'连续五天训练',storyTime:'123年1月1日10点'});
            globalThis.tl=await s.upsertTimeline(ctx.chatId,{name:'北征',summary:'训练后出征',entries:[{period:'123年1月1日10点',event:'第一天训练',status:'ended'},{period:'123年1月5日12点',event:'第五天训练',status:'ended'}]});
            const manager=await import('/BB-Memory/memory-manager.js');await manager.openMemoryManager(ctx.chatId);
            const org=await import('/BB-Memory/memory-organization.js');globalThis.opened=[];
            org.configureMemoryOrganization({curation:()=>{opened.push('curation');document.querySelector('#bb_curate_status').textContent='全库整理已启动';},undo:async()=>{const c=await import('/BB-Memory/memory-curator.js');await c.undoLastCuration(ctx.chatId);document.querySelector('#bb_curate_status').textContent='已撤销';},maintenance:()=>{opened.push('maintenance');}});
        });
        await page.locator('.bb-npc-biography').first().click();
        const body=page.locator('.bb-biography-body');
        const geometry=await body.evaluate(el=>({scroll:el.scrollHeight,client:el.clientHeight,overflow:getComputedStyle(el).overflowY}));
        assert.ok(geometry.scroll>geometry.client,JSON.stringify(geometry));assert.equal(geometry.overflow,'auto');
        await body.hover();await page.mouse.wheel(0,1600);
        await page.waitForFunction(()=>document.querySelector('.bb-biography-body').scrollTop>0);
        const save=page.locator('.bb-biography-popup [data-action="save"]');
        const rect=await save.boundingBox();assert.ok(rect.y>=0&&rect.y+rect.height<=650);
        await page.locator('.bb-biography-draft').fill('林澈撑伞送学生回家。');await save.click();
        await page.waitForFunction(()=>document.querySelector('.bb-biography-status').textContent.includes('已保存'));
        await page.screenshot({path:join(output,`biography-scroll-${width}.png`)});
        await page.locator('.bb-biography-popup [data-action="close"]').click();
        await page.getByRole('button',{name:'记忆整理',exact:true}).click();
        await page.getByRole('button',{name:'开始全库整理',exact:true}).click();
        assert.deepEqual(await page.evaluate(()=>opened),['curation']);
        await page.getByRole('tab',{name:'纠错',exact:true}).click();
        await page.getByRole('button',{name:'查看全库',exact:true}).click();
        await page.locator('.bb-correction-card').filter({hasText:'林澈'}).getByRole('button',{name:'修改此条'}).click();
        assert.equal(await page.locator('.bb-organization-overlay').count(),1);
        await page.locator('.bb-correction-form').getByLabel('身份/职业', {exact:true}).fill('历史老师');
        await page.getByRole('button',{name:'保存纠错',exact:true}).click();
        await page.waitForSelector('.bb-correction-form',{state:'detached'});
        assert.equal(await page.locator('.bb-organization-overlay').isVisible(),true);
        await page.screenshot({path:join(output,`organization-correction-${width}.png`)});
        await page.getByRole('tab',{name:'记忆维护',exact:true}).click();
        await page.getByRole('button',{name:'打开维护与体检',exact:true}).click();
        assert.deepEqual(await page.evaluate(()=>opened),['curation','maintenance']);
        await page.locator('.bb-organization-popup [data-setting="timelineSummaryTarget"]').selectOption('both');
        await page.evaluate(()=>{
            SillyTavern.getContext().generateRaw=async()=>JSON.stringify({timeline:[{id:tl.id,summary:'备战',entries:[{period:'123年1月1日-5日',event:'连续五天训练',sourceIndices:[0,1]}]}],milestones:[{id:ms.id,event:'完成备战',summary:'五天训练结束'}]});
        });
        await page.getByRole('button',{name:'生成联合总结建议',exact:true}).click();
        await page.waitForSelector('#bb_curate_review_overlay');
        assert.equal(await page.locator('.bb-curate-select').count(),2);
        assert.ok((await page.locator('#bb_curate_review_overlay').innerText()).includes('123年1月1日-5日'));
        assert.equal(await page.evaluate(async()=>{const s=await import('/BB-Memory/memory-store.js');return(await s.getTimeline('ui948'))[0].entries.length;}),2);
        // 取消不保存，重新生成后用户编辑再确认。
        await page.locator('#bb_curate_review_overlay .bb-active-review-close').click();
        await page.waitForFunction(()=>document.querySelector('.bb-organization-status').textContent.includes('已取消'));
        await page.getByRole('button',{name:'生成联合总结建议',exact:true}).click();
        await page.waitForSelector('#bb_curate_review_overlay');
        for (const select of await page.locator('.bb-curate-select').all()) await select.check();
        await page.locator('.bb-curate-editor summary').first().click();
        await page.getByRole('textbox',{name:'时间线事件 · 1 · 事件',exact:true}).fill('林澈连续五天训练队伍');
        await page.screenshot({path:join(output,`joint-summary-${width}.png`)});
        await page.locator('#bb_curate_review_overlay [data-action="apply"]').click();
        await page.waitForSelector('#bb_curate_review_overlay',{state:'detached'});
        await page.waitForFunction(()=>document.querySelector('.bb-organization-status').textContent.includes('更新 1 条时间线、1 条里程碑'));
        await page.getByRole('tab',{name:'全库整理',exact:true}).click();
        await page.getByRole('button',{name:'撤销上次整理 / 总结',exact:true}).click();
        await page.waitForFunction(()=>document.querySelector('#bb_curate_status').textContent.includes('已撤销'));
        assert.equal(await page.evaluate(async()=>{const s=await import('/BB-Memory/memory-store.js');return(await s.getTimeline('ui948'))[0].entries.length;}),2);
        await page.getByRole('button',{name:'关闭记忆整理',exact:true}).click();
        assert.equal(await page.locator('.bb-mgr-panel[data-panel="memories"]').isVisible(),true);
        await page.locator('.bb-mgr-tab[data-tab="realtime"]').click();
        assert.equal(await page.locator('.bb-rt-promote').count(),0);
        const size=await page.evaluate(()=>({scroll:document.documentElement.scrollWidth,width:innerWidth}));assert.ok(size.scroll<=size.width+1,JSON.stringify(size));
        assert.deepEqual(errors,[]);
        console.log(`PASS ${width}px x 650px: actual biography scroll and fixed buttons; organization tabs/correction/summary cancellation/edit/apply/undo; no overflow or JS errors`);
        await page.close();
    }
} finally {await browser?.close();await new Promise(r=>server.close(r));}

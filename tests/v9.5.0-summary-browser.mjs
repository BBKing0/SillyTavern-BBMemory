import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const require = createRequire(process.env.BB_PLAYWRIGHT_MODULE || import.meta.url);
const { chromium } = require('playwright');
const root = fileURLToPath(new URL('../../',import.meta.url));
const output = resolve(root,'_tmp_v950_screens');
const server = createServer(async(req,res)=>{
    try {
        const pathname = decodeURIComponent(new URL(req.url,'http://localhost').pathname);
        if (pathname === '/') { res.setHeader('Content-Type','text/html; charset=utf-8'); res.end('<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/BB-Memory/style.css"><style>body{background:#171923;color:#eee;font:16px system-ui}button,input,textarea,select{font:inherit}button{cursor:pointer;color:inherit;background:#303348;border:1px solid #666;padding:.4em}.bb-input{background:#242638;color:#eee;border:1px solid #666}</style><body></body></html>'); return; }
        const file = resolve(root,'.'+pathname);
        if (!file.startsWith(resolve(root)+'\\')) { res.writeHead(403).end(); return; }
        res.setHeader('Content-Type',extname(file)==='.js'?'text/javascript; charset=utf-8':extname(file)==='.css'?'text/css; charset=utf-8':'text/plain; charset=utf-8'); res.end(await readFile(file));
    } catch { res.writeHead(404).end(); }
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve)); await mkdir(output,{recursive:true});
let browser;
try {
    browser = await chromium.launch({headless:true,...(process.env.BB_BROWSER_CHANNEL?{channel:process.env.BB_BROWSER_CHANNEL}:{})});
    for (const width of [1280,390]) {
        const page = await browser.newPage({viewport:{width,height:650}}), errors = [];
        page.on('pageerror',error=>errors.push(error.message));
        await page.goto(`http://127.0.0.1:${server.address().port}/`);
        await page.evaluate(async()=>{
            const bank = new Map();
            const lf = {async getItem(k){return structuredClone(bank.get(k)??null)},async setItem(k,v){bank.set(k,structuredClone(v));return v},async removeItem(k){bank.delete(k)}};
            const ctx = {chatId:'summary-ui',chat:[],chatMetadata:{},extensionSettings:{},libs:{localforage:lf},saveSettingsDebounced(){},saveMetadataDebounced(){}};
            globalThis.SillyTavern = {getContext:()=>ctx}; globalThis.toastr = {info(){},warning(){},success(){},error(m){console.error(m)}};
            globalThis.fetch = async url=>{if(url==='/api/users/me')return {ok:true,json:async()=>({handle:'summary-ui',created:1})};throw new Error('Unexpected request '+url)};
            const s = await import('/BB-Memory/memory-store.js'); s.updateSettings({autoBackupEnabled:false,embeddingEnabled:false,timelineSummaryTarget:'both',timelineSummaryScope:'all_with_milestones'});
            globalThis.t1 = await s.upsertTimeline(ctx.chatId,{name:'北征主线',summary:'原文',entries:[{period:'银月历3年1月1日10点',event:'整军'}]});
            globalThis.t2 = await s.upsertTimeline(ctx.chatId,{name:'建城支线',summary:'原文',entries:[{period:'银月历3年2月1日',event:'筑城'}]});
            await s.addMilestone(ctx.chatId,{event:'北征节点',timelineId:t1.id});
            await s.addMilestone(ctx.chatId,{event:'建城节点',timelineId:t2.id});
            globalThis.requests = [];
            ctx.generateRaw = async ({prompt})=>{
                const source = JSON.parse(prompt.split('（当前片段）\n')[1].split('\n## 本次执行约束')[0]); requests.push(source);
                await new Promise(resolve=>setTimeout(resolve,15));
                const target = prompt.match(/允许修改：([^。]+)。/)[1];
                return JSON.stringify({timeline:target==='只修改里程碑'?[]:source.timeline.map(t=>({id:t.id,summary:'已总结',entries:t.entries.map((e,i)=>({period:e.period,event:e.event+' 已总结',sourceIndices:[i]}))})),milestones:target==='只修改时间线'?[]:source.milestones.map(m=>({id:m.id,event:m.event+' 已总结'}))});
            };
            const org = await import('/BB-Memory/memory-organization.js'); org.openMemoryOrganization(ctx.chatId,{initialTab:'maintenance'});
        });
        await page.waitForFunction(()=>!document.querySelector('[data-action="summary"]').disabled);
        assert.equal(await page.locator('[data-panel="maintenance"]').isVisible(),true);
        await page.getByRole('tab',{name:'全库整理',exact:true}).click();
        await page.getByRole('button',{name:'提取变更审核',exact:true}).click();
        await page.waitForFunction(()=>document.querySelector('.bb-organization-status').textContent.includes('暂无待审核变更'));
        await page.getByRole('tab',{name:'记忆维护',exact:true}).click();
        await page.waitForFunction(()=>!document.querySelector('[data-action="summary"]').disabled);
        const scope = page.locator('[data-setting="timelineSummaryScope"]'), thread = page.locator('[data-setting="timelineSummaryTimelineId"]');
        assert.equal(await scope.locator('option').count(),4);
        assert.equal(await thread.isVisible(),false);
        await scope.selectOption('selected_linked');
        await thread.selectOption(await page.evaluate(()=>t1.id));
        assert.equal(await thread.isVisible(),true);
        await page.screenshot({path:join(output,`summary-scope-${width}.png`)});
        await page.getByRole('button',{name:'生成总结建议',exact:true}).click();
        await page.waitForSelector('#bb_curate_review_overlay');
        assert.equal(await page.locator('.bb-curate-select').count(),2);
        assert.ok(await page.evaluate(()=>requests.every(source=>source.timeline.every(t=>t.id===t1.id) && source.milestones.every(m=>m.timelineId===t1.id))));
        assert.equal(await page.evaluate(async()=>{const s=await import('/BB-Memory/memory-store.js');return (await s.getTimeline('summary-ui')).find(t=>t.id===t1.id).entries[0].event;}),'整军');
        await page.locator('.bb-curate-editor summary').first().click();
        await page.getByRole('textbox',{name:'时间线事件 · 1 · 事件',exact:true}).fill('整军完毕准备北征');
        await page.locator('#bb_curate_review_overlay [data-action="save_draft"]').click();
        await page.waitForFunction(()=>document.querySelector('.bb-organization-status').textContent.includes('草稿已保存'));
        await page.getByRole('button',{name:'关闭记忆整理',exact:true}).click();
        await page.evaluate(async()=>{const org=await import('/BB-Memory/memory-organization.js');org.openMemoryOrganization('summary-ui',{initialTab:'maintenance'});});
        await page.waitForFunction(()=>!document.querySelector('[data-action="summary"]').disabled);
        assert.equal(await scope.inputValue(),'selected_linked'); assert.equal(await thread.inputValue(),await page.evaluate(()=>t1.id));
        await page.getByRole('button',{name:'继续上次总结草稿',exact:true}).click();
        await page.waitForSelector('#bb_curate_review_overlay'); await page.locator('.bb-curate-editor summary').first().click();
        assert.equal(await page.getByRole('textbox',{name:'时间线事件 · 1 · 事件',exact:true}).inputValue(),'整军完毕准备北征');
        for (const checkbox of await page.locator('.bb-curate-select').all()) await checkbox.check();
        await page.screenshot({path:join(output,`summary-review-${width}.png`)});
        await page.locator('#bb_curate_review_overlay [data-action="apply"]').click();
        await page.waitForFunction(()=>document.querySelector('.bb-organization-status').textContent.includes('更新 1 条时间线、1 条里程碑'));
        assert.equal(await page.evaluate(async()=>{const s=await import('/BB-Memory/memory-store.js');return (await s.getTimeline('summary-ui')).find(t=>t.id===t1.id).entries[0].event;}),'整军完毕准备北征');
        assert.equal(await page.evaluate(async()=>{const c=await import('/BB-Memory/memory-curator.js');return (await c.undoLastCuration('summary-ui')).ok;}),true);
        await scope.selectOption('all_threads');
        assert.equal(await thread.isVisible(),false);
        await page.getByRole('button',{name:'生成总结建议',exact:true}).click(); await page.waitForSelector('#bb_curate_review_overlay');
        assert.equal(await page.locator('.bb-curate-select').count(),2);
        assert.ok((await page.locator('#bb_curate_review_overlay').innerText()).includes('只修改时间线'));
        const geometry = await page.evaluate(()=>({width:innerWidth,doc:document.documentElement.scrollWidth,popup:document.querySelector('#bb_curate_review_overlay .bb-active-review-popup')?.getBoundingClientRect().toJSON(),org:document.querySelector('.bb-organization-popup').getBoundingClientRect().toJSON()}));
        assert.ok(geometry.doc<=width+1,JSON.stringify(geometry)); assert.ok(geometry.org.x>=-1 && geometry.org.right<=width+1,JSON.stringify(geometry));
        assert.deepEqual(errors,[]);
        await page.locator('#bb_curate_review_overlay .bb-active-review-close').click(); await page.close();
        console.log(`PASS summary browser ${width}px: scopes, current line, draft resume, edit/apply/undo, all threads, layout`);
    }
} finally { await browser?.close(); await new Promise(resolve=>server.close(resolve)); }

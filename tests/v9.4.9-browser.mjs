import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const require = createRequire(process.env.BB_PLAYWRIGHT_MODULE || import.meta.url);
const { chromium } = require('playwright');
const root = fileURLToPath(new URL('../../', import.meta.url));
const output = resolve(root, '_tmp_v949_screens');
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
            globalThis.fetch=async(url)=>{if(url==='/api/users/me')return {ok:true,json:async()=>({handle:'alice',created:1})};throw new Error('Unexpected network: '+url)};
            const bank=new Map();const lf={async getItem(k){return structuredClone(bank.get(k)??null)},async setItem(k,v){bank.set(k,structuredClone(v));return v},async removeItem(k){bank.delete(k)}};
            const ctx={libs:{localforage:lf},extensionSettings:{},chatId:'ui949',characterId:0,chat:[],chatMetadata:{},saveSettingsDebounced(){},saveMetadataDebounced(){},getWorldInfoNames:()=>Array.from({length:12},(_,i)=>'世界书'+i)};
            globalThis.SillyTavern={getContext:()=>ctx};globalThis.toastr={success(){},warning(){},info(){},error(){}};
            const s=await import('/BB-Memory/memory-store.js');s.updateSettings({autoBackupEnabled:false,embeddingEnabled:false});
            const npc=await s.addNpcProfile(ctx.chatId,{name:'林澈',role:'老师',biography:'旧小传'});globalThis.npcId=npc.id;
            for(const [title,memoryTier,importance] of [['零重要','stable',0],['核心八十','core',0.8],['永恒一百','eternal',1],['核心默认','core',0.5]])await s.addMemory(ctx.chatId,{title,content:'筛选样本',memoryTier,importance});
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
            SillyTavern.getContext().generateRaw=async({prompt})=>prompt.startsWith('阶段 1：') ? JSON.stringify({groups:[{key:tl.id,name:'北征',timelineIds:[tl.id],milestoneIds:[ms.id]}]}) : JSON.stringify({timeline:[{id:tl.id,summary:'备战',entries:[{period:'123年1月1日-5日',event:'连续五天训练',sourceIndices:[0,1]}]}],milestones:[{id:ms.id,event:'完成备战',summary:'五天训练结束'}]});
        });
        await page.getByRole('button',{name:'生成联合总结建议',exact:true}).click();
        await page.waitForSelector('#bb_curate_review_overlay');
        assert.equal(await page.locator('.bb-curate-select').count(),2);
        assert.ok((await page.locator('#bb_curate_review_overlay').innerText()).includes('123年1月1日-5日'));
        assert.equal(await page.evaluate(async()=>{const s=await import('/BB-Memory/memory-store.js');return(await s.getTimeline('ui949'))[0].entries.length;}),2);
        // 取消不保存，重新生成后用户编辑再确认。
        await page.locator('#bb_curate_review_overlay .bb-active-review-close').click();
        await page.waitForFunction(()=>document.querySelector('.bb-organization-status').textContent.includes('已取消'));
        await page.getByRole('button',{name:'生成联合总结建议',exact:true}).click();
        await page.waitForSelector('#bb_curate_review_overlay');
        for (const select of await page.locator('.bb-curate-select').all()) await select.check();
        await page.locator('.bb-curate-editor summary').first().click();
        await page.getByRole('textbox',{name:'时间线事件 · 1 · 事件',exact:true}).fill('林澈连续五天训练队伍');
        await page.screenshot({path:join(output,`joint-summary-${width}.png`)});
        await page.locator('#bb_curate_review_overlay [data-action="save_draft"]').click();
        await page.waitForSelector('#bb_curate_review_overlay',{state:'detached'});
        await page.waitForFunction(()=>document.querySelector('.bb-organization-status').textContent.includes('草稿已保存'));
        await page.getByRole('button',{name:'关闭记忆整理',exact:true}).click();
        await page.getByRole('button',{name:'记忆整理',exact:true}).click();
        await page.getByRole('tab',{name:'记忆维护',exact:true}).click();
        await page.getByRole('button',{name:'继续上次总结草稿',exact:true}).click();
        await page.waitForSelector('#bb_curate_review_overlay');
        await page.locator('.bb-curate-editor summary').first().click();
        assert.equal(await page.getByRole('textbox',{name:'时间线事件 · 1 · 事件',exact:true}).inputValue(),'林澈连续五天训练队伍');
        assert.equal(await page.locator('.bb-curate-select:checked').count(),2);
        await page.locator('#bb_curate_review_overlay [data-action="apply"]').click();
        await page.waitForSelector('#bb_curate_review_overlay',{state:'detached'});
        await page.waitForFunction(()=>document.querySelector('.bb-organization-status').textContent.includes('更新 1 条时间线、1 条里程碑'));
        await page.getByRole('tab',{name:'全库整理',exact:true}).click();
        await page.getByRole('button',{name:'撤销上次整理 / 总结',exact:true}).click();
        await page.waitForFunction(()=>document.querySelector('#bb_curate_status').textContent.includes('已撤销'));
        assert.equal(await page.evaluate(async()=>{const s=await import('/BB-Memory/memory-store.js');return(await s.getTimeline('ui949'))[0].entries.length;}),2);
        await page.getByRole('button',{name:'关闭记忆整理',exact:true}).click();
        assert.equal(await page.locator('.bb-mgr-panel[data-panel="memories"]').isVisible(),true);
        if (!await page.locator('#bb_mgr_tier').isVisible()) await page.locator('#bb_mgr_controls_toggle').click();
        await page.locator('#bb_mgr_tier').selectOption('core');
        await page.waitForFunction(()=>document.querySelector('.bb-mem-stats').textContent.includes('当前匹配 2'));
        await page.locator('#bb_mgr_importance').fill('80');await page.locator('#bb_mgr_importance').dispatchEvent('change');
        await page.waitForFunction(()=>document.querySelector('.bb-mem-stats').textContent.includes('当前匹配 1'));
        assert.ok((await page.locator('#bb_mgr_list').innerText()).includes('核心八十'));
        await page.locator('#bb_mgr_search').fill('永恒');
        await page.waitForFunction(()=>document.querySelector('#bb_mgr_list').textContent.includes('暂无匹配'));
        await page.locator('#bb_mgr_search').fill('');await page.locator('#bb_mgr_tier').selectOption('all');
        await page.locator('#bb_mgr_importance').fill('0');await page.locator('#bb_mgr_importance').dispatchEvent('change');
        await page.locator('.bb-mem-type-filter[data-type="mem"]').click();
        await page.locator('#bb_mgr_sort').selectOption('importance_asc');
        await page.waitForFunction(()=>document.querySelector('#bb_mgr_list').textContent.includes('零重要'));
        const order=await page.locator('#bb_mgr_list').innerText();assert.ok(order.indexOf('零重要')<order.indexOf('永恒一百'));
        await page.screenshot({path:join(output,`importance-${width}.png`)});
        await page.locator('.bb-mgr-tab[data-tab="realtime"]').click();
        assert.equal(await page.locator('.bb-rt-promote').count(),0);
        const size=await page.evaluate(()=>({scroll:document.documentElement.scrollWidth,width:innerWidth}));assert.ok(size.scroll<=size.width+1,JSON.stringify(size));
        assert.deepEqual(errors,[]);
        console.log(`PASS ${width}px x 650px: actual biography scroll and fixed buttons; organization tabs/correction/summary cancellation/edit/apply/undo; no overflow or JS errors`);
        await page.close();
    }
    // 同一 browser context / 同源持久存储，模拟真实退出登录后重新加载。
    const context=await browser.newContext();const page=await context.newPage();let account='alice';
    await context.route('**/api/users/me',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({handle:account,created:account==='alice'?1:2})}));
    const setup=async(target=page)=>target.evaluate(async()=>{
        const lf={
            async getItem(k){return JSON.parse(localStorage.getItem(k)||'null')},
            async setItem(k,v){localStorage.setItem(k,JSON.stringify(v));return v},
            async removeItem(k){localStorage.removeItem(k)},
            async keys(){return Object.keys(localStorage)},
            async iterate(fn){for(const k of Object.keys(localStorage)){const r=fn(JSON.parse(localStorage.getItem(k)),k);if(r!==undefined)return r}},
        };
        const ctx={libs:{localforage:lf},extensionSettings:{},chatId:'shared',characterId:0,characters:[{name:'同名角色',avatar:'same.png'}],chat:[],chatMetadata:{},saveSettingsDebounced(){},saveMetadataDebounced(){}};
        globalThis.SillyTavern={getContext:()=>ctx};globalThis.toastr={info(){},success(){},error(){},warning(){}};
        globalThis.storage=await import('/BB-Memory/user-storage.js');await storage.initializeUserStorage();
        globalThis.store=await import('/BB-Memory/memory-store.js');store.updateSettings({embeddingEnabled:false,autoBackupEnabled:false});
        globalThis.slots=await import('/BB-Memory/memory-slots.js');
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/`);await setup();
    await page.evaluate(async()=>{
        localStorage.setItem('bb_memory_slot_char:same.png_default',JSON.stringify({memories:[{id:'legacy-private'}]}));
        await store.addMemory('shared',{title:'Alice',content:'Alice私有'});await slots.saveToSlot('char:same.png','shared','default',{syncCloud:false});
        // 各子系统写入和读取共同使用同一个账号适配器。
        await storage.getUserLocalForage().setItem('bb_vec_bank_test',{owner:'alice'});
    });
    account='bob';await page.reload();await setup();
    const bob=await page.evaluate(async()=>{
        const before=await store.getMemories('shared');const slotsBefore=await slots.listSlots('char:same.png');
        const rescue=await import('/BB-Memory/slot-identity.js');const scan=await rescue.scanSlotNamespaces();
        const vectors=await storage.getUserLocalForage().getItem('bb_vec_bank_test');
        await store.addMemory('shared',{title:'Bob',content:'Bob私有'});await slots.saveToSlot('char:same.png','shared','default',{syncCloud:false});
        return {before,slotsBefore,scan,vectors};
    });
    assert.deepEqual(bob.before,[]);assert.equal(bob.slotsBefore[0].count,0);assert.equal(bob.scan.scanned,0);assert.equal(bob.vectors,null);
    account='alice';await page.reload();await setup();
    assert.equal(await page.evaluate(async()=>(await store.getMemories('shared'))[0].title),'Alice');
    await page.evaluate(async()=>{await slots.loadFromSlot('char:same.png','shared','default');});
    assert.equal(await page.evaluate(async()=>(await store.getMemories('shared'))[0].title),'Alice');
    // 已打开页面在服务端切号后校验失败，拒绝后续读写。
    account='bob';assert.ok(await page.evaluate(async()=>{
        try{await storage.initializeUserStorage({verify:true});return false}catch{
            try{await storage.getUserLocalForage().setItem('cross-account','bad');return false}catch{return true}
        }
    }));
    account='alice';await page.reload();await setup();
    account='bob';const second=await context.newPage();await second.goto(`http://127.0.0.1:${server.address().port}/`);await setup(second);
    await page.waitForFunction(()=>{try{storage.userStorageKey('x');return false}catch{return true}});
    await context.close();console.log('PASS same-origin reload: Alice/Bob/Alice shared chat + character + default isolated; legacy rescue hidden; old session and cross-tab broadcast locked');
} finally {await browser?.close();await new Promise(r=>server.close(r));}

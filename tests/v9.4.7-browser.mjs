import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const require = createRequire(process.env.BB_PLAYWRIGHT_MODULE || import.meta.url);
const { chromium } = require('playwright');
const root = fileURLToPath(new URL('../../', import.meta.url));
const output = resolve(root, '_tmp_v947_screens');
const server=createServer(async(req,res)=>{
    try {
        const pathname=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
        if(pathname==='/') {res.setHeader('Content-Type','text/html; charset=utf-8');res.end('<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/BB-Memory/style.css"><style>body{background:#171923;color:#eee;font:16px system-ui}button,input,textarea,select{font:inherit}button{cursor:pointer;color:inherit;background:#303348;border:1px solid #666;border-radius:5px;padding:.4em}.bb-input{background:#242638;color:#eee;border:1px solid #666}</style><body></body></html>');return;}
        const path=resolve(root,'.'+pathname);if(!path.startsWith(root.replace(/[\\/]$/, '') + (process.platform === 'win32' ? '\\' : '/'))){res.writeHead(403).end();return;}
        res.setHeader('Content-Type',extname(path)==='.js'?'text/javascript; charset=utf-8':extname(path)==='.css'?'text/css; charset=utf-8':'text/plain; charset=utf-8');res.end(await readFile(path));
    } catch {res.writeHead(404).end();}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
await mkdir(output,{recursive:true});
let browser;
try {
 browser=await chromium.launch({headless:true,...(process.env.BB_BROWSER_CHANNEL ? {channel:process.env.BB_BROWSER_CHANNEL} : {})});
 for(const width of [1280,390]) {
  const page=await browser.newPage({viewport:{width,height:900}});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.evaluate(async()=>{
   const bank=new Map();
   const lf={async getItem(k){return structuredClone(bank.get(k)??null)},async setItem(k,v){bank.set(k,structuredClone(v));return v},async removeItem(k){bank.delete(k)}};
   const ctx={libs:{localforage:lf},extensionSettings:{},chatId:'ui947',characterId:0,chat:[],chatMetadata:{},saveSettingsDebounced(){},saveMetadataDebounced(){}};
   globalThis.SillyTavern={getContext:()=>ctx};globalThis.toastr={success(){},warning(){},info(){},error(){}};
   const store=await import('/BB-Memory/memory-store.js');store.updateSettings({autoBackupEnabled:false,autoGenEndpoint:'https://mock.invalid',embeddingEnabled:true,embeddingEndpoint:'https://mock.invalid'});
   const npc=await store.addNpcProfile('ui947',{name:'林澈',role:'医生',indexCard:'林澈是医生'});
   await store.addMemory('ui947',{title:'向量正常',content:'历史书'});
   await store.addMemory('ui947',{title:'向量失败',content:'坏向量'});
   let step=0;
   globalThis.fetch=async(url,opts)=>{
    const req=JSON.parse(opts.body);
    if(req.input){if(req.input.includes('坏向量'))throw new Error('模拟断网');return{ok:true,json:async()=>({data:[{embedding:[.1,.2,.3]}]})};}
    const content=step++===0 ? '```json\nJSON_READ：\n'+JSON.stringify({tool:'detail',key:'npc:'+npc.id},null,2)+'\n```' : '职业需要更正。\nJSON_ACTION: '+JSON.stringify({action:'update_entry',key:'npc:'+npc.id,patch:{role:'老师',indexCard:'林澈是老师'},reason:'用户确认林澈在学校任教，请同步身份和索引卡。'});
    return{ok:true,json:async()=>({choices:[{message:{content}}]})};
   };
   const agent=await import('/BB-Memory/memory-agent.js');agent.openAgent('ui947');
  });
  assert.equal(await page.locator('[data-action="stop"]').isVisible(),false);
  await page.locator('.bb-agent-input-row textarea').fill('林澈是老师，看看是否写错');
  await page.locator('[data-action="send"]').click();
  await page.waitForSelector('.bb-agent-proposal');
  assert.equal(await page.evaluate(async()=>{const s=await import('/BB-Memory/memory-store.js');return(await s.getNpcProfiles('ui947'))[0].role;}),'医生');
  await page.locator('.bb-agent-proposal summary span').click();
  assert.ok((await page.locator('.bb-agent-proposal').innerText()).includes('原值：医生'));
  await page.screenshot({path:join(output,`agent-${width}.png`)});
  const layout=await page.locator('.bb-agent-panel').evaluate(el=>({width:el.getBoundingClientRect().width,scroll:el.scrollWidth,client:el.clientWidth,bottom:el.getBoundingClientRect().bottom}));
  assert.ok(layout.scroll<=layout.client+1 && layout.width<=width && layout.bottom<=900,JSON.stringify(layout));
  await page.locator('.bb-agent-proposal input').check();
  await page.getByRole('button',{name:'执行所选建议',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('.bb-agent-status').textContent.includes('执行完成'));
  assert.equal(await page.evaluate(async()=>{const s=await import('/BB-Memory/memory-store.js');return(await s.getNpcProfiles('ui947'))[0].role;}),'老师');
  assert.equal(await page.locator('.bb-agent-proposal').count(),0);
  await page.getByRole('button',{name:'重置对话',exact:true}).click();
  assert.ok((await page.locator('.bb-agent-status').innerText()).includes('已重置'));
  await page.evaluate(()=>document.querySelector('.bb-agent-overlay').hidePopover());
  assert.equal(await page.locator('.bb-agent-overlay').isVisible(),false);
  await page.evaluate(()=>document.querySelector('.bb-agent-overlay').showPopover());
  await page.locator('[data-action="close"]').click();
  assert.equal(await page.locator('.bb-agent-overlay').count(),0);
  await page.evaluate(async()=>{
   const health=await import('/BB-Memory/memory-health-check.js');
   const host=document.createElement('div');host.id='health-host';host.style.cssText='max-width:50rem;margin:auto;padding:1rem';document.body.appendChild(host);
   const refresh=async()=>{host.replaceChildren(health.buildHealthCheckPanel('ui947',await health.runHealthCheck('ui947'),{onRefresh:refresh}));};await refresh();
  });
  await page.getByRole('button',{name:'一键重新生成向量',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('.bb-maint-batch-result')?.textContent.includes('失败 1'));
  assert.ok((await page.locator('.bb-maint-batch-result').first().innerText()).includes('成功 2'));
  assert.ok((await page.locator('.bb-maint-batch-result').first().innerText()).includes('模拟断网'));
  await page.screenshot({path:join(output,`health-${width}.png`)});
  const embedding=page.locator('.bb-maint-batch-bar').filter({has:page.getByRole('button',{name:'一键重新生成向量',exact:true})});
  await embedding.getByRole('button',{name:'一键忽略',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('.bb-maint-batch-result')?.textContent.includes('一键忽略：成功 1'));
  assert.equal(await page.getByRole('button',{name:'一键重新生成向量',exact:true}).count(),0);
  await page.getByRole('button',{name:'恢复已忽略问题',exact:true}).click();
  await page.waitForSelector('.bb-maint-batch-bar');
  assert.equal(await page.getByRole('button',{name:'一键重新生成向量',exact:true}).count(),1);
  await page.evaluate(()=>{globalThis.successMessages=[];globalThis.toastr.success=message=>successMessages.push(message);});
  page.once('dialog',dialog=>dialog.dismiss());
  await page.locator('.bb-health-item').getByRole('button',{name:'删除',exact:true}).first().click();
  assert.deepEqual(await page.evaluate(()=>successMessages),[]);
  // 维护面板处于 top layer 时，AI 标签确认也应可点击，不被父弹窗遮住。
  await page.evaluate(async()=>{
   const s=await import('/BB-Memory/memory-store.js'), h=await import('/BB-Memory/memory-health-check.js');
   const {mountInTopLayer}=await import('/BB-Memory/ui-top-layer.js');
   mountInTopLayer(document.querySelector('#health-host'));
   const entry=(await s.getMemories('ui947'))[0];globalThis.taggedId=entry.id;
   SillyTavern.getContext().generateRaw=async()=> '人物,旧书';
   globalThis.tagOutcome='running';
   h.executeHealthMaintenanceAction('ai_tag',{type:'untagged',collection:'mem',id:entry.id,title:entry.title,entry},'ui947').then(()=>tagOutcome='saved',error=>tagOutcome=error.message);
  });
  await page.waitForSelector('.bb-tag-confirm-overlay:popover-open');
  await page.locator('#bb-tag-options span').filter({hasText:'旧书'}).click();
  await page.getByRole('button',{name:'确认添加',exact:true}).click();
  await page.waitForFunction(()=>tagOutcome==='saved');
  assert.ok(await page.evaluate(async()=>{const s=await import('/BB-Memory/memory-store.js');return(await s.getMemories('ui947')).find(e=>e.id===taggedId).tags.some(t=>t.name==='旧书');}));
  await page.evaluate(()=>document.querySelector('#health-host').hidePopover());
  const sizes=await page.evaluate(()=>({scroll:document.documentElement.scrollWidth,width:innerWidth}));assert.ok(sizes.scroll<=sizes.width+1,JSON.stringify(sizes));
  const indexSource = await readFile(resolve(root, 'BB-Memory/index.js'),'utf8');
  const maintenanceUI = indexSource.slice(indexSource.indexOf('function showMaintenancePopup('), indexSource.indexOf('function registerSlashCommands()'));
  await page.evaluate(async source=>{
   document.querySelector('#health-host').remove();
   const st=await import('/BB-Memory/memory-store.js');const mt=await import('/BB-Memory/memory-maintainer.js');const ht=await import('/BB-Memory/memory-health-check.js');
   await st.addItem('ui947',{name:'积灰物品一',memoryTier:'transient',status:'held'});
   await st.addItem('ui947',{name:'积灰物品二',memoryTier:'transient',status:'held'});
   const esc=s=>{const el=document.createElement('span');el.textContent=s;return el.innerHTML;};
   const notify=(msg,type)=>globalThis.toastr[type||'info'](msg);
   const feedback=async(btn,fn)=>{btn.disabled=true;try{return await fn();}finally{btn.disabled=false;}};
   const actions=await import('/BB-Memory/maintenance-actions.js');
   const args=['pendingMaintenanceButtons','performMaintenance','dismissMaintenanceRemind','getMaintenanceResolved','clearMaintenanceResolved','runHealthCheck','buildHealthCheckPanel','escapeHtml','showToast','withFeedback'];
   const make=new Function(...args,source.replaceAll("import('./","import('/BB-Memory/")+';return showMaintenancePopup;');
   const show=make(actions.pendingMaintenanceButtons,mt.performMaintenance,mt.dismissMaintenanceRemind,mt.getMaintenanceResolved,mt.clearMaintenanceResolved,ht.runHealthCheck,ht.buildHealthCheckPanel,esc,notify,feedback);
   globalThis.showMaintenanceForTest=show;
   show('ui947',await mt.checkMaintenanceNeeded('ui947'));
  }, maintenanceUI);
  const pending=page.locator('.bb-maint-category').filter({hasText:'积灰物品'});
  assert.equal(await pending.locator('.bb-maint-issue-item').count(),2);
  await pending.getByRole('button',{name:'一键升为常驻',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('.bb-maint-batch-result')?.textContent.includes('成功 2'));
  assert.equal(await page.locator('.bb-maint-issue-item').count(),0);
  await page.getByRole('button',{name:'已维护',exact:true}).click();
  assert.ok((await page.locator('.bb-maint-body').innerText()).includes('成功 2'));
  await page.getByRole('button',{name:'待维护 (0)',exact:true}).click();
  assert.equal(await page.locator('.bb-maint-issue-item').count(),0);
  await page.screenshot({path:join(output,`pending-${width}.png`)});
  await page.locator('.bb-maint-close-btn').click();

  // 人物小传通过实际 NPC 管理入口打开，草稿需保存且可再次打开编辑。
  await page.evaluate(async()=>{
   const ctx=SillyTavern.getContext();ctx.generateRaw=async()=> '窗外落雨时，林澈把唯一的伞递给学生，自己护着一册旧书走入雨中。';
   const manager=await import('/BB-Memory/memory-manager.js');await manager.openMemoryManager('ui947');
  });
  await page.locator('.bb-npc-biography').first().click();
  await page.locator('.bb-biography-instruction').fill('以借伞展现他的温柔');
  await page.locator('.bb-biography-popup [data-action="generate"]').click();
  await page.waitForFunction(()=>document.querySelector('.bb-biography-status').textContent.includes('尚未保存'));
  assert.equal(await page.evaluate(async()=>{const s=await import('/BB-Memory/memory-store.js');return(await s.getNpcProfiles('ui947'))[0].biography;}),'');
  await page.locator('.bb-biography-draft').fill('林澈把伞递给学生，自己抱着旧书走入雨中。');
  await page.screenshot({path:join(output,`biography-${width}.png`)});
  await page.locator('.bb-biography-popup [data-action="save"]').click();
  await page.waitForFunction(()=>document.querySelector('.bb-biography-status').textContent.includes('已保存'));
  assert.equal(await page.evaluate(async()=>{const s=await import('/BB-Memory/memory-store.js');return(await s.getNpcProfiles('ui947'))[0].biography;}),'林澈把伞递给学生，自己抱着旧书走入雨中。');
  await page.locator('.bb-biography-popup [data-action="close"]').click();
  await page.locator('.bb-mem-close').click();
  // 全库整理：分类筛选与切换不会丢编辑值，实际保存编辑后的文字。
  await page.evaluate(async()=>{
   const s=await import('/BB-Memory/memory-store.js'), c=await import('/BB-Memory/memory-curator.js');
   const a=await s.addMemory('ui947',{title:'时间修正',content:'第一天午后约定去城门见面'});
   const b=await s.addMemory('ui947',{title:'人物修正',content:'林澈在村里教书'});
   globalThis.editedMemoryId=a.id;
   const {ops}=c.parseCurationOps(JSON.stringify({ops:[
    {op:'rewrite',pillar:'mem',ids:[a.id],issueCategory:'时间缺失',reason:'补充时间',result:{title:a.title,content:'第二天午后约定去城门见面'}},
    {op:'rewrite',pillar:'mem',ids:[b.id],issueCategory:'人物错误',reason:'核实人物',result:{title:b.title,content:'林澈在镇上教书'}}
   ]}),{groups:[{pillar:'mem',entries:[a,b]}]});
   globalThis.reviewPromise=c.openCurationReviewPanel('ui947',ops);
  });
  await page.locator('.bb-curate-category-filter select').selectOption({label:'时间缺失'});
  await page.locator('.bb-curate-editor summary').click();
  await page.getByRole('textbox',{name:'正文',exact:true}).fill('第三天午后约定去城门见面');
  await page.locator('.bb-curate-category-filter select').selectOption({label:'人物错误'});
  await page.locator('.bb-curate-select').uncheck();
  await page.locator('.bb-curate-category-filter select').selectOption({label:'时间缺失'});
  await page.locator('.bb-curate-editor summary').click();
  assert.equal(await page.getByRole('textbox',{name:'正文',exact:true}).inputValue(),'第三天午后约定去城门见面');
  await page.locator('.bb-curate-select').check();
  await page.screenshot({path:join(output,`curation-${width}.png`)});
  await page.locator('#bb_curate_review_overlay [data-action="apply"]').click();
  await page.waitForSelector('#bb_curate_review_overlay',{state:'detached'});
  assert.equal(await page.evaluate(async()=>{const s=await import('/BB-Memory/memory-store.js');return(await s.getMemories('ui947')).find(e=>e.id===editedMemoryId).content;}),'第三天午后约定去城门见面');
  // 故事线维护 → AI建议 → 修改内部事件 → 应用 → 撤销恢复。
  await page.evaluate(async()=>{
   const s=await import('/BB-Memory/memory-store.js'), m=await import('/BB-Memory/memory-maintainer.js');
   s.updateSettings({timelineCompressionEntryThreshold:4});
   const t=await s.upsertTimeline('ui947',{name:'北征准备',summary:'准备向北方出征的全过程',entries:['招募士兵并登记姓名','安排队长管理训练','打造全军所需兵器','全军开拔向北方出征'].map(event=>({event,period:'五月初三午后',status:'ended'}))});
   globalThis.compressedThreadId=t.id;
   SillyTavern.getContext().generateRaw=async()=>JSON.stringify({summary:'筹备出征',entries:[{event:'主角统筹安排出征事宜',sourceIndices:[0,1,2]},{event:'全军北征',sourceIndices:[3]}]});
   showMaintenanceForTest('ui947',await m.checkMaintenanceNeeded('ui947'));
  });
  await page.getByRole('button',{name:'一键生成压缩建议',exact:true}).click();
  await page.waitForSelector('#bb_curate_review_overlay');
  assert.equal(await page.evaluate(async()=>{const s=await import('/BB-Memory/memory-store.js');return(await s.getTimeline('ui947')).find(e=>e.id===compressedThreadId).entries.length;}),4);
  await page.locator('.bb-curate-editor summary').click();
  await page.getByRole('textbox',{name:'时间线事件 · 1 · 事件',exact:true}).fill('林澈统筹北征准备');
  await page.locator('.bb-curate-select').check();
  await page.screenshot({path:join(output,`timeline-${width}.png`)});
  await page.locator('#bb_curate_review_overlay [data-action="apply"]').click();
  await page.waitForSelector('#bb_curate_review_overlay',{state:'detached'});
  await page.waitForFunction(()=>!document.querySelector('.bb-maint-overlay')?.dataset.busy);
  assert.equal(await page.evaluate(async()=>{const s=await import('/BB-Memory/memory-store.js');return(await s.getTimeline('ui947')).find(e=>e.id===compressedThreadId).entries[0].event;}),'林澈统筹北征准备');
  await page.evaluate(async()=>{const c=await import('/BB-Memory/memory-curator.js');await c.undoLastCuration('ui947');});
  assert.equal(await page.evaluate(async()=>{const s=await import('/BB-Memory/memory-store.js');return(await s.getTimeline('ui947')).find(e=>e.id===compressedThreadId).entries.length;}),4);
  await page.locator('.bb-maint-close-btn').click();
  // 真实注入结果在命中面板中包括永恒条目，零预算显示原因。
  // 无既有故事线时，从里程碑生成也必须预览，取消不保存。
  await page.evaluate(async()=>{
   SillyTavern.getContext().chatId='newchat947';
   const s=await import('/BB-Memory/memory-store.js'), m=await import('/BB-Memory/memory-maintainer.js');
   await s.addMilestone('newchat947',{event:'开始旅行',summary:'从村庄出发，踏上旅程'});
   SillyTavern.getContext().generateRaw=async()=>JSON.stringify({timeline:[{name:'旅途',type:'plot',status:'ongoing',priority:'medium',summary:'踏上旅途',entries:[{event:'从村庄出发',status:'ongoing'}]}]});
   globalThis.bootstrapPromise=m.regenerateThreadSummary('newchat947');
  });
  await page.waitForSelector('#bb_curate_review_overlay');
  assert.equal(await page.evaluate(async()=>{const s=await import('/BB-Memory/memory-store.js');return(await s.getTimeline('newchat947')).length;}),0);
  await page.locator('#bb_curate_review_overlay .bb-active-review-close').click();
  assert.equal(await page.evaluate(async()=>{await bootstrapPromise;const s=await import('/BB-Memory/memory-store.js');return(await s.getTimeline('newchat947')).length;}),0);
  await page.evaluate(async()=>{const m=await import('/BB-Memory/memory-maintainer.js');globalThis.bootstrapPromise=m.regenerateThreadSummary('newchat947');});
  await page.waitForSelector('#bb_curate_review_overlay');
  await page.locator('.bb-curate-select').check();
  await page.locator('#bb_curate_review_overlay [data-action="apply"]').click();
  await page.waitForSelector('#bb_curate_review_overlay',{state:'detached'});
  assert.equal(await page.evaluate(async()=>{await bootstrapPromise;const s=await import('/BB-Memory/memory-store.js');return(await s.getTimeline('newchat947')).length;}),1);
  await page.evaluate(async()=>{const c=await import('/BB-Memory/memory-curator.js');await c.undoLastCuration('newchat947');});
  assert.equal(await page.evaluate(async()=>{const s=await import('/BB-Memory/memory-store.js');return(await s.getTimeline('newchat947')).length;}),0);
  await page.evaluate(()=>{SillyTavern.getContext().chatId='ui947';});
  const hitsSource=indexSource.slice(indexSource.indexOf('function renderEternalInjectionNote('),indexSource.indexOf('function getMilestoneHitGroups('));
  const sidebarSource=indexSource.slice(indexSource.indexOf('function updateSidebarHitList()'),indexSource.indexOf('// ═══════════════════════════════════════════════════════════',indexSource.indexOf('function updateSidebarHitList()')));
  await page.evaluate(({hitsSource,sidebarSource})=>{
   const host=document.createElement('div');host.innerHTML='<div id="bb_sidebar_hit_list"></div><div id="bb_hit_timestamp"></div>';document.body.appendChild(host);
   const esc=s=>{const el=document.createElement('span');el.textContent=String(s||'');return el.innerHTML;};
   const index=()=>({foreshadow:[],ongoing:[],ended:[]});
   const group=(label,icon,count,html)=>`<div>${label} ${count}${html}</div>`;
   const build=new Function('lastRetrievalResult','escapeHtml','getMilestoneHitGroups','renderHitGroup',hitsSource+'\n'+sidebarSource+';updateSidebarHitList();');
   build({timestamp:Date.now(),memoryCandidateCount:2,memoryNotInjectedCount:2,hits:[]},esc,index,group);
   if(!document.querySelector('#bb_sidebar_hit_list').textContent.includes('2 条未进入本轮预算')) throw new Error('零预算诊断丢失');
   build({timestamp:Date.now(),eternalInjectedCount:1,hits:[{title:'常驻实注入',memoryTier:'eternal',score:1,level:'L4'}]},esc,index,group);
  },{hitsSource,sidebarSource});
  assert.ok((await page.locator('#bb_sidebar_hit_list').innerText()).includes('记忆 1条'));
  assert.ok((await page.locator('#bb_sidebar_hit_list').innerText()).includes('常驻实注入'));
  const finalSize=await page.evaluate(()=>({scroll:document.documentElement.scrollWidth,width:innerWidth}));assert.ok(finalSize.scroll<=finalSize.width+1,JSON.stringify(finalSize));

  assert.deepEqual(errors,[]);
  console.log(`PASS ${width}px: suggestion preview/select/execute/reset, batch vector partial failure/ignore/restore; pending bulk promote and counters; biography, editable/category curation, timeline preview/edit/undo, real injection counts; no overflow or JS errors`);
  await page.close();
 }
}finally{await browser?.close();await new Promise(r=>server.close(r));}

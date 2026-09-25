import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const require = createRequire(process.env.BB_PLAYWRIGHT_MODULE || import.meta.url);
const { chromium } = require('playwright');
const root = fileURLToPath(new URL('../../', import.meta.url));
const output = resolve(root, '_tmp_v946_screens');
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
   const ctx={libs:{localforage:lf},extensionSettings:{},chatId:'ui946',characterId:0,chat:[],chatMetadata:{},saveSettingsDebounced(){},saveMetadataDebounced(){}};
   globalThis.SillyTavern={getContext:()=>ctx};globalThis.toastr={success(){},warning(){},info(){},error(){}};
   const store=await import('/BB-Memory/memory-store.js');store.updateSettings({autoBackupEnabled:false,autoGenEndpoint:'https://mock.invalid',embeddingEnabled:true,embeddingEndpoint:'https://mock.invalid'});
   const npc=await store.addNpcProfile('ui946',{name:'林澈',role:'医生',indexCard:'林澈是医生'});
   await store.addMemory('ui946',{title:'向量正常',content:'历史书'});
   await store.addMemory('ui946',{title:'向量失败',content:'坏向量'});
   let step=0;
   globalThis.fetch=async(url,opts)=>{
    const req=JSON.parse(opts.body);
    if(req.input){if(req.input.includes('坏向量'))throw new Error('模拟断网');return{ok:true,json:async()=>({data:[{embedding:[.1,.2,.3]}]})};}
    const content=step++===0 ? 'JSON_READ: '+JSON.stringify({tool:'detail',key:'npc:'+npc.id}) : '职业需要更正。\nJSON_ACTION: '+JSON.stringify({action:'update_entry',key:'npc:'+npc.id,patch:{role:'老师',indexCard:'林澈是老师'},reason:'用户确认林澈在学校任教，请同步身份和索引卡。'});
    return{ok:true,json:async()=>({choices:[{message:{content}}]})};
   };
   const agent=await import('/BB-Memory/memory-agent.js');agent.openAgent('ui946');
  });
  await page.locator('.bb-agent-input-row textarea').fill('林澈是老师，看看是否写错');
  await page.locator('[data-action="send"]').click();
  await page.waitForSelector('.bb-agent-proposal');
  assert.equal(await page.evaluate(async()=>{const s=await import('/BB-Memory/memory-store.js');return(await s.getNpcProfiles('ui946'))[0].role;}),'医生');
  await page.locator('.bb-agent-proposal summary span').click();
  assert.ok((await page.locator('.bb-agent-proposal').innerText()).includes('原值：医生'));
  await page.screenshot({path:join(output,`agent-${width}.png`)});
  const layout=await page.locator('.bb-agent-panel').evaluate(el=>({width:el.getBoundingClientRect().width,scroll:el.scrollWidth,client:el.clientWidth,bottom:el.getBoundingClientRect().bottom}));
  assert.ok(layout.scroll<=layout.client+1 && layout.width<=width && layout.bottom<=900,JSON.stringify(layout));
  await page.locator('.bb-agent-proposal input').check();
  await page.getByRole('button',{name:'执行所选建议',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('.bb-agent-status').textContent.includes('执行完成'));
  assert.equal(await page.evaluate(async()=>{const s=await import('/BB-Memory/memory-store.js');return(await s.getNpcProfiles('ui946'))[0].role;}),'老师');
  assert.equal(await page.locator('.bb-agent-proposal').count(),0);
  await page.getByRole('button',{name:'重置对话',exact:true}).click();
  assert.ok((await page.locator('.bb-agent-status').innerText()).includes('已重置'));
  await page.locator('[data-action="close"]').click();
  await page.evaluate(async()=>{
   const health=await import('/BB-Memory/memory-health-check.js');
   const host=document.createElement('div');host.id='health-host';host.style.cssText='max-width:50rem;margin:auto;padding:1rem';document.body.appendChild(host);
   const refresh=async()=>{host.replaceChildren(health.buildHealthCheckPanel('ui946',await health.runHealthCheck('ui946'),{onRefresh:refresh}));};await refresh();
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
  const sizes=await page.evaluate(()=>({scroll:document.documentElement.scrollWidth,width:innerWidth}));assert.ok(sizes.scroll<=sizes.width+1,JSON.stringify(sizes));
  const indexSource = await readFile(resolve(root, 'BB-Memory/index.js'),'utf8');
  const maintenanceUI = indexSource.slice(indexSource.indexOf('function showMaintenancePopup('), indexSource.indexOf('function registerSlashCommands()'));
  await page.evaluate(async source=>{
   document.querySelector('#health-host').remove();
   const st=await import('/BB-Memory/memory-store.js');const mt=await import('/BB-Memory/memory-maintainer.js');const ht=await import('/BB-Memory/memory-health-check.js');
   await st.addItem('ui946',{name:'积灰物品一',memoryTier:'transient',status:'held'});
   await st.addItem('ui946',{name:'积灰物品二',memoryTier:'transient',status:'held'});
   const esc=s=>{const el=document.createElement('span');el.textContent=s;return el.innerHTML;};
   const notify=(msg,type)=>globalThis.toastr[type||'info'](msg);
   const feedback=async(btn,fn)=>{btn.disabled=true;try{return await fn();}finally{btn.disabled=false;}};
   const args=['performMaintenance','dismissMaintenanceRemind','getMaintenanceResolved','clearMaintenanceResolved','runHealthCheck','buildHealthCheckPanel','escapeHtml','showToast','withFeedback'];
   const make=new Function(...args,source.replaceAll("import('./","import('/BB-Memory/")+';return showMaintenancePopup;');
   const show=make(mt.performMaintenance,mt.dismissMaintenanceRemind,mt.getMaintenanceResolved,mt.clearMaintenanceResolved,ht.runHealthCheck,ht.buildHealthCheckPanel,esc,notify,feedback);
   show('ui946',await mt.checkMaintenanceNeeded('ui946'));
  }, maintenanceUI);
  const pending=page.locator('.bb-maint-category').filter({hasText:'积灰物品'});
  assert.equal(await pending.locator('.bb-maint-issue-item').count(),2);
  await pending.getByRole('button',{name:'一键升稳定',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('.bb-maint-batch-result')?.textContent.includes('成功 2'));
  assert.equal(await page.locator('.bb-maint-issue-item').count(),0);
  await page.getByRole('button',{name:'已维护',exact:true}).click();
  assert.ok((await page.locator('.bb-maint-body').innerText()).includes('成功 2'));
  await page.getByRole('button',{name:'待维护 (0)',exact:true}).click();
  assert.equal(await page.locator('.bb-maint-issue-item').count(),0);
  await page.screenshot({path:join(output,`pending-${width}.png`)});
  await page.locator('.bb-maint-close-btn').click();
  assert.deepEqual(errors,[]);
  console.log(`PASS ${width}px: suggestion preview/select/execute/reset, batch vector partial failure/ignore/restore; pending bulk promote and counters; no overflow or JS errors`);
  await page.close();
 }
}finally{await browser?.close();await new Promise(r=>server.close(r));}

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createServer } from 'node:http';
import { resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const index = readFileSync(new URL('../index.js',import.meta.url),'utf8').replace(/\r\n/g,'\n');
const settingsHtml = readFileSync(new URL('../settings.html',import.meta.url),'utf8');
function functionSource(name) {
    const expression = new RegExp(`^(?:async )?function ${name}\\(`,'m');
    const match = expression.exec(index); assert.ok(match,`Missing actual function ${name}`);
    const end = index.indexOf('\n}',match.index); assert.ok(end>match.index,name);
    return index.slice(match.index,end+2);
}
function constSource(name) {
    const start = index.indexOf(`const ${name} = `); assert.ok(start>=0,name);
    const end = index.indexOf(';\n',start); assert.ok(end>start,name);
    return index.slice(start,end+1);
}
const interceptorStart = index.indexOf('globalThis.bbMemoryInterceptor = async function');
const interceptorEnd = index.indexOf('\n};',interceptorStart)+3;
assert.ok(interceptorStart>=0 && interceptorEnd>interceptorStart);
const interceptorSource = index.slice(interceptorStart,interceptorEnd);
const bank = new Map(), listeners = new Map(), prompts = new Map();
const lf = {async getItem(k){return structuredClone(bank.get(k)??null)},async setItem(k,v){bank.set(k,structuredClone(v));return v},async removeItem(k){bank.delete(k)},async keys(){return [...bank.keys()]}};
let saves = 0;
const ctx = {chatId:'interceptor950',chat:[{is_user:true,mes:'查看角色物品和记忆'}],chatMetadata:{},extensionSettings:{},libs:{localforage:lf},saveSettingsDebounced(){},saveMetadataDebounced(){},saveChatDebounced(){saves++},setExtensionPrompt(key,text){prompts.set(key,text)},event_types:{MESSAGE_RECEIVED:'message_received'},eventSource:{on(event,callback){listeners.set(event,callback)},removeListener(event){listeners.delete(event)}}};
globalThis.SillyTavern = {getContext:()=>ctx}; globalThis.window = globalThis;
globalThis.toastr = {info(){},success(){},warning(){},error(){}};
globalThis.fetch = async url=>{assert.equal(url,'/api/users/me');return {ok:true,json:async()=>({handle:'interceptor-test',created:1})}};
const store = await import('../memory-store.js');
const us = await import('../user-storage.js');
const retriever = await import('../retriever.js');
const extraction = await import('../extraction-context.js');
await us.initializeUserStorage();
store.updateSettings({enabled:true,migratedFromV4:true,autoBackupEnabled:false,embeddingEnabled:false,realtimeEnabled:false,timelineSummaryEnabled:true,entityDetailInjectionMaxChars:2000,extractionRecentMemoryCount:0,tokenBudget:1000,tokenBudgetMode:'elastic',maxResults:10});
const giant = '极长资料'.repeat(4000);
const expectedIds = {npc:{},item:{},milestone:{},mem:{},timeline:{}};
for (const [suffix,text] of [['short','短资料'],['giant',giant]]) {
    expectedIds.npc[suffix] = (await store.addNpcProfile(ctx.chatId,{name:`NPC_${suffix}`,npcTier:'minor',indexCard:text})).id;
    expectedIds.item[suffix] = (await store.addItem(ctx.chatId,{name:`ITEM_${suffix}`,significance:text})).id;
    expectedIds.milestone[suffix] = (await store.addMilestone(ctx.chatId,{event:`MILESTONE_${suffix} ${text}`,summary:text,injectionMode:'vector',status:'ongoing'})).id;
    expectedIds.mem[suffix] = (await store.addMemory(ctx.chatId,{title:`MEMORY_${suffix}`,content:text,summary:text,memoryTier:'stable',importance:0.5})).id;
    expectedIds.timeline[suffix] = (await store.upsertTimeline(ctx.chatId,{id:`tl_${suffix}`,name:`TIMELINE_${suffix}`,summary:text,priority:'medium',status:'ongoing',entries:[{event:text}]})).id;
}
let noData = false, actualBuild;
const hitFrames = [];
const sandbox = {
    console, structuredClone, SillyTavern:globalThis.SillyTavern,
    getSettings:store.getSettings, getCharacterWorldRealWorldRef:()=>'',
    getNpcProfiles:async id=>noData?[]:store.getNpcProfiles(id), getItems:async id=>noData?[]:store.getItems(id),
    getMilestones:async id=>noData?[]:store.getMilestones(id), getMemories:async id=>noData?[]:store.getMemories(id),
    getTimeline:async id=>noData?[]:store.getTimeline(id),getClueBoard:async()=>({nodes:[]}),getMap:async()=>({locations:{}}),getRealtimeMemories:async()=>[],
    setPluginHiddenState:()=>false, migrateV4ToV5:async()=>{}, hydrateCollectionEmbeddings:async()=>{},hydrateMapEmbeddings:async()=>{},autoMaintainSilent:async()=>{},
    getNpcForInjection:rows=>rows.map(row=>({...row,_bbInjectMode:'full'})),getItemsForInjection:rows=>rows.map(row=>({...row,_bbInjectMode:'full'})),
    getMilestonesForInjection:rows=>({foreshadow:[],ongoing:rows,ended:[]}),getTimelineForInjection:retriever.getTimelineForInjection,
    getResidentMemories:()=>[],getRelevantMemories:rows=>rows.map(memory=>({memory,score:0.8,level:'L3'})),mergeExpandedRelevantResults:(_rows,_query,results)=>results,
    buildMemoryInjectionPrompt:async options=>{actualBuild=await retriever.buildMemoryInjectionPrompt(options);return actualBuild},
    buildHitFrameKey:()=> 'test-frame',isMetaDialogueHitFrame:()=>false,recordInjectionHitFrame:async(_id,_message,_key,records)=>hitFrames.push(records),
    captureInjectionContext:extraction.captureInjectionContext,updateSidebarHitList(){},showToast(){},setTimeout(){},
    getPendingAutoCandidates:()=>[],clearPendingAutoCandidates(){},showFloatingReviewPanel(){},
};
vm.createContext(sandbox);
vm.runInContext(`${constSource('INJECTION_KEY')}\n${constSource('REALTIME_INJECTION_KEY')}\n${constSource('POSITION_IN_CHAT')}\n${constSource('ROLE_SYSTEM')}\n${constSource('MAX_IN_CHAT_DEPTH')}\nlet lastRetrievalResult=null;\n${functionSource('getLongTermInjectionDepth')}\n${functionSource('mergeResidentMemoryResults')}\n${functionSource('clearInjection')}\n${functionSource('clearGenerationInjection')}\n${interceptorSource}`,sandbox);
let checks=0;
async function test(name,fn){await fn();checks++;console.log('PASS '+name)}
const statsKey = {npc:'npcIds',item:'itemIds',mem:'memoryIds',milestone:'milestoneIds',timeline:'timelineIds'};
await test('真实拦截器记录实际预算ID，复制chat时写回原ctx消息',async()=>{
    const original = ctx.chat[0], copy = structuredClone(ctx.chat);
    await sandbox.bbMemoryInterceptor(copy,8192,null,'normal');
    const record = original.extra.bbMemoryInjectionContext;
    assert.ok(saves>0); assert.equal(copy[0].extra?.bbMemoryInjectionContext,undefined);
    for (const [pillar,key] of Object.entries(statsKey)) {
        assert.equal(actualBuild.stats[key].length,1,`${pillar}: ${JSON.stringify(actualBuild.stats)}`);
        assert.equal(actualBuild.stats[key][0],expectedIds[pillar].short);
        assert.deepEqual(record.entriesByPillar[pillar],actualBuild.stats[key]);
    }
    assert.ok(actualBuild.truncated.length); assert.ok(prompts.get('bb_memory_injection').includes('<BBMemory>'));
});
await test('响应事件独立绑定，提取窗口全部五类精确保留预算命中',async()=>{
    extraction.initInjectionContextTracking();
    ctx.chat.push({is_user:false,mes:'模型回复',swipe_id:0}); listeners.get('message_received')(1);
    const context = await extraction.buildExtractionContext(ctx.chatId,{sourceFloor:1});
    for (const [pillar,key] of Object.entries(statsKey)) {
        assert.deepEqual(context.injectedIds[pillar],actualBuild.stats[key]);
        assert.ok(context.entries[pillar].every(entry=>entry.id!==expectedIds[pillar].giant));
    }
    assert.deepEqual(context.recentMemoryIds,[]); extraction.stopInjectionContextTracking();
});
await test('disabled及noData清空本轮上下文与提示，不残留上一轮ID',async()=>{
    ctx.chat.push({is_user:true,mes:'本轮停用'}); extraction.captureInjectionContext(ctx.chatId,ctx.chat.at(-1),{mem:[{id:'old'}]});
    store.updateSettings({enabled:false}); await sandbox.bbMemoryInterceptor(structuredClone(ctx.chat),8192,null,'normal');
    assert.deepEqual(ctx.chat.at(-1).extra.bbMemoryInjectionContext.entriesByPillar,{});
    assert.equal(prompts.get('bb_memory_injection'),''); assert.equal(prompts.get('bb_memory_realtime_injection'),'');
    ctx.chat.push({is_user:true,mes:'本轮无数据'}); extraction.captureInjectionContext(ctx.chatId,ctx.chat.at(-1),{npc:[{id:'old'}]});
    store.updateSettings({enabled:true}); noData=true; await sandbox.bbMemoryInterceptor(structuredClone(ctx.chat),8192,null,'normal');
    assert.deepEqual(ctx.chat.at(-1).extra.bbMemoryInjectionContext.entriesByPillar,{}); assert.equal(prompts.get('bb_memory_injection'),'');
    noData=false;
});

const controls = [
    ['extractionUpdateConfirm','bb_extraction_update_confirm','checkbox',false],
    ['extractionRecentMemoryCount','bb_extraction_recent_memory_count','number',7],
    ['timelineSummaryReminderExchanges','bb_timeline_summary_reminder_exchanges','number',9],
    ['dailyMemoryScoreMultiplier','bb_daily_memory_score_multiplier','number',0.2],
    ['dailyMemoryFullSimilarity','bb_daily_memory_full_similarity','number',0.98],
    ['eventTimeOrder','bb_event_time_order','text','第一纪元\n第二纪元'],
];
const bindLines = index.split('\n').filter(line=>controls.some(([,id])=>line.includes(`('#${id}',`)) && /^\s*bind(?:Checkbox|Input|Select)\(/.test(line)).join('\n');
assert.equal(bindLines.split('\n').length,controls.length);
const exportHookStart = index.indexOf("    document.querySelector('#bb_export_extract_settings_btn')?.addEventListener");
const exportHookEnd = index.indexOf('\n    // 数字/文本输入',exportHookStart);
assert.ok(exportHookStart>=0 && exportHookEnd>exportHookStart);
const hookSource = index.slice(exportHookStart,exportHookEnd);
const settingsSource = ['SETTINGS_EXPORT_VERSION','SETTINGS_EXPORT_KEYS','SETTING_CONTROL_BINDINGS'].map(constSource).join('\n')+'\n'+['bindCheckbox','bindInput','bindSelect','sanitizeApiProfilesForExport','mergeImportedApiProfiles','buildSettingsExportPayload','normalizeImportedSettingsPayload','syncSettingsControls','restoreApiSettings'].map(functionSource).join('\n')+'\n'+bindLines+'\n'+hookSource;
const root = fileURLToPath(new URL('../../',import.meta.url));
const server = createServer(async(req,res)=>{
    try {
        const pathname=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
        if(pathname==='/'){res.setHeader('Content-Type','text/html; charset=utf-8');res.end('<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/BB-Memory/style.css"><body>'+settingsHtml+'</body></html>');return;}
        const file=resolve(root,'.'+pathname);if(!file.startsWith(resolve(root)+'\\')){res.writeHead(403).end();return;}
        res.setHeader('Content-Type',extname(file)==='.js'?'text/javascript; charset=utf-8':extname(file)==='.css'?'text/css; charset=utf-8':'text/plain; charset=utf-8');res.end(await readFile(file));
    }catch{res.writeHead(404).end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
let browser;
try {
    const require=createRequire(process.env.BB_PLAYWRIGHT_MODULE || import.meta.url); const {chromium}=require('playwright');
    browser=await chromium.launch({headless:true,...(process.env.BB_BROWSER_CHANNEL?{channel:process.env.BB_BROWSER_CHANNEL}:{})});
    const page=await browser.newPage({viewport:{width:390,height:850}});
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.evaluate(async({settingsSource})=>{
        const settingsBank = new Map(), settingsOwner = {};
        const lf={async getItem(k){return settingsBank.get(k)??null},async setItem(k,v){settingsBank.set(k,structuredClone(v));return v},async removeItem(k){settingsBank.delete(k)}};
        const ctx={extensionSettings:settingsOwner,libs:{localforage:lf},chatId:'settings-ui',chat:[],chatMetadata:{},saveSettingsDebounced(){}};
        globalThis.SillyTavern={getContext:()=>ctx};globalThis.fetch=async url=>{if(url==='/api/users/me')return {ok:true,json:async()=>({handle:'settings-ui',created:1})};throw new Error(url)};
        const store=await import('/BB-Memory/memory-store.js');
        Object.assign(globalThis,{getSettings:store.getSettings,updateSettings:store.updateSettings,normalizePromptTemplatePatch:value=>value||{},getPromptTemplateAllowedKeys:()=>[],syncExtractionTagControls(){},renderPromptTemplateList(){},refreshProfileDropdown(){},refreshEmbeddingProfileDropdown(){},initAutoGenerator(){},stopAutoGenerator(){},showToast(message){globalThis.lastToast=message},downloadTextFile(name,text){globalThis.settingsDownload={name,text}}});
        new Function(settingsSource+'\nglobalThis.settingsHooks={syncSettingsControls,buildSettingsExportPayload,normalizeImportedSettingsPayload};\nsyncSettingsControls();')();
        document.querySelectorAll('.inline-drawer-content,.bb-settings-section-body').forEach(el=>{el.style.display='block'});
    },{settingsSource});
    await test('真实settings模板控件回填、change保存、导出及文件导入hook往返',async()=>{
        for(const [key,id,type,value] of controls){
            const input=page.locator('#'+id);assert.equal(await input.count(),1);
            const defaults=await page.evaluate(key=>getSettings()[key],key);
            if(type==='checkbox'){assert.equal(await input.isChecked(),defaults);await input.setChecked(value,{force:true});}
            else{assert.equal(await input.inputValue(),String(defaults));await input.evaluate((el,value)=>{el.value=String(value);el.dispatchEvent(new Event('change',{bubbles:true}))},value);}
            assert.deepEqual(await page.evaluate(key=>getSettings()[key],key),value);
        }
        await page.locator('#bb_export_extract_settings_btn').evaluate(el=>el.click());
        const exported=await page.evaluate(()=>JSON.parse(settingsDownload.text));assert.equal(exported.version,'9.5.0');
        for(const [key,,,value] of controls)assert.deepEqual(exported.settings[key],value);
        assert.equal(exported.settings.timelineSummaryScope,'all_with_milestones');assert.ok(Object.hasOwn(exported.settings,'timelineSummaryTimelineId'));
        const imported={type:'bb-memory-settings',settings:{extractionUpdateConfirm:true,extractionRecentMemoryCount:0,timelineSummaryReminderExchanges:1,dailyMemoryScoreMultiplier:0,dailyMemoryFullSimilarity:1,eventTimeOrder:'太阳纪元\n银月纪元',timelineSummaryScope:'selected_all',timelineSummaryTimelineId:'chosen-line'}};
        await page.locator('#bb_import_extract_settings_file').setInputFiles({name:'v950-settings.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(imported))});
        await page.waitForFunction(()=>String(globalThis.lastToast).includes('设置导入完成'));
        for(const [key,id,type] of controls){assert.deepEqual(await page.evaluate(key=>getSettings()[key],key),imported.settings[key]);if(type==='checkbox')assert.equal(await page.locator('#'+id).isChecked(),true);else assert.equal(await page.locator('#'+id).inputValue(),String(imported.settings[key]));}
        assert.equal(await page.evaluate(()=>getSettings().timelineSummaryScope),'selected_all');assert.equal(await page.evaluate(()=>getSettings().timelineSummaryTimelineId),'chosen-line');
        assert.ok(await page.locator('#bb_extraction_update_confirm').evaluate(el=>el.closest('.bb-settings-section-body')!==null));
        for(const [,id] of controls) assert.ok(await page.locator('#'+id).evaluate(el=>el.getBoundingClientRect().width>0));
    });
    await page.close();
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
console.log(`${checks} actual interceptor/settings regression groups passed`);

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const bank = new Map();
const lf = { async getItem(k) { return structuredClone(bank.get(k) ?? null); }, async setItem(k,v) { bank.set(k,structuredClone(v)); return v; }, async removeItem(k) { bank.delete(k); } };
const ctx = { chatId: 'test947', chat: [], characters: [], characterId: 0, chatMetadata: {}, extensionSettings: {}, libs: { localforage: lf }, saveSettingsDebounced(){}, saveMetadataDebounced(){} };
globalThis.SillyTavern = { getContext: () => ctx }; globalThis.window = globalThis;
globalThis.toastr = { success(){}, info(){}, warning(){}, error(){} };
const store = await import('../memory-store.js');
const core = await import('../memory-agent-core.js');
const protocol = await import('../agent-protocol.js');
const retriever = await import('../retriever.js');
const maint = await import('../maintenance-actions.js');
const health = await import('../memory-health-check.js');
const timelines = await import('../timeline-compression.js');
const bio = await import('../npc-biography.js');
const curator = await import('../memory-curator.js');
const { classifyCurationOps } = await import('../curation-editor.js');
store.updateSettings({ autoBackupEnabled:false, autoGenEndpoint:'https://mock.invalid', embeddingEnabled:false });
let replies=[], calls=[];
globalThis.fetch=async(url,options)=>{ const body=JSON.parse(options.body);calls.push({api:'custom',body}); const next=replies.shift(); assert.notEqual(next,undefined,'unexpected API request'); return { ok:true,json:async()=>({choices:[{message:{content:typeof next==='function'?next(body):next}}]}) }; };
ctx.generateRaw=async body=>{calls.push({api:'main',body});const next=replies.shift();assert.notEqual(next,undefined);return typeof next==='function'?next(body):next;};
let checks=0;
async function test(label,fn){await fn();checks++;console.log('PASS '+label);}
const npc=await store.addNpcProfile(ctx.chatId,{name:'林澈',role:'医生',personality:'喜欢旧书'});
await test('多行、中文冒号、代码围栏、转义大括号与结构化响应',async()=>{
 const a=protocol.parseAgentResponse('核查\n```json\nJSON_READ：\n{\n"tool":"detail",\n"key":"npc:x"\n}\n```\nJSON_ACTION: {"action":"update_entry","patch":{"role":"带\\\"引号{文本}"}}');
 assert.equal(a.reads.length,1);assert.equal(a.specs.length,1);assert.deepEqual(a.errors,[]);assert.equal(a.answer,'核查');
 const b=protocol.parseAgentResponse(JSON.stringify({answer:'建议',reads:[{tool:'list'}],actions:[{action:'maintenance'}]}));assert.equal(b.reads.length,1);assert.equal(b.specs.length,1);assert.equal(b.answer,'建议');
 assert.equal(protocol.parseAgentResponse('JSON_ACTION: {坏JSON}').errors.length,1);
});
await test('未读原文建议可通过校验反馈修复，最终只生成待执行建议',async()=>{
 const spec={action:'update_entry',key:`npc:${npc.id}`,patch:{role:'老师'},reason:'用户核实'};
 replies=['JSON_ACTION:\n'+JSON.stringify(spec,null,2),body=>{assert.ok(body.messages.at(-1).content.includes('尚未读取完整原文'));return JSON.stringify({reads:[{tool:'detail',key:`npc:${npc.id}`}]});},JSON.stringify({answer:'应更正',actions:[spec]})];
 const result=await core.runAgentQuery(ctx.chatId,'林澈其实是老师');assert.equal(result.proposals.length,1);assert.equal((await store.getNpcProfiles(ctx.chatId))[0].role,'医生');
 await core.executeAgentProposals(ctx.chatId,[1]);assert.equal((await store.getNpcProfiles(ctx.chatId))[0].role,'老师');
});
await test('常驻记忆不挤占普通记忆候选；最终统计与注入正文一致',async()=>{
 const resident=Array.from({length:20},(_,i)=>({memory:{id:`r${i}`,content:'常驻'+i,memoryTier:'eternal'},score:1,level:'L4'}));
 const normal={memory:{id:'ordinary',content:'普通命中原文',memoryTier:'stable'},score:.6,level:'L3'};
 const merged=retriever.mergeExpandedRelevantResults([], '', [...resident,normal],new Set(),12,3);
 assert.ok(merged.some(r=>r.memory.id==='ordinary'));
 const result=await retriever.buildMemoryInjectionPrompt({relevantResults:merged,settings:{...store.getSettings(),tokenBudget:4000}});
 assert.equal(result.stats.memoryCount,21);assert.ok(result.text.includes('普通命中原文'));assert.equal(result.stats.memoryIds.length,21);
 const limited=await retriever.buildMemoryInjectionPrompt({relevantResults:[normal],settings:{...store.getSettings(),tokenBudget:1,tokenBudgetMode:'strict_total'}});
 assert.equal(limited.stats.memoryCount,0);assert.ok(!limited.text.includes('普通命中原文'));
});
await test('拦截器保留零预算诊断，并清除上轮注入正文',async()=>{
 const source=readFileSync(new URL('../index.js',import.meta.url),'utf8');
 const interceptor=source.slice(source.indexOf('globalThis.bbMemoryInterceptor = async function'),source.indexOf('\nfunction clearInjection()'));
 const mergeStart=source.indexOf('function mergeResidentMemoryResults(');
 const merge=source.slice(mergeStart,source.indexOf('\nfunction ',mergeStart+10));
 const settings={...store.getSettings(),enabled:true,migratedFromV4:true,embeddingEnabled:false,tokenBudget:1,tokenBudgetMode:'strict_total',extractionConfirmMode:'semi'};
 const entry={id:'budget-only',title:'永恒',content:'预算不足时不应假装已经注入',memoryTier:'eternal',status:'active'};
 const noop=()=>{}, empty=async()=>[];
 const dependencies={...retriever,getSettings:()=>settings,getCharacterWorldRealWorldRef:()=>'',getNpcProfiles:empty,getItems:empty,getMilestones:empty,getMemories:async()=>[entry],getTimeline:empty,getClueBoard:async()=>null,getMap:async()=>({locations:{}}),getRealtimeMemories:empty,hydrateCollectionEmbeddings:noop,hydrateMapEmbeddings:noop,autoMaintainSilent:noop,mergeResidentMemoryResults:null,buildHitFrameKey:()=> 'budget',isMetaDialogueHitFrame:()=>false,recordInjectionHitFrame:noop,updateSidebarHitList:noop,INJECTION_KEY:'long',REALTIME_INJECTION_KEY:'realtime',POSITION_IN_CHAT:1,ROLE_SYSTEM:0};
 delete dependencies.mergeResidentMemoryResults;
 const prompts=new Map([['long','过时注入'],['realtime','过时实时注入']]);
 const previous=ctx.setExtensionPrompt;ctx.setExtensionPrompt=(key,text)=>prompts.set(key,text);
 try {
  const harness=new Function(...Object.keys(dependencies),`let lastRetrievalResult; function clearInjection(){lastRetrievalResult=null;} ${merge}\n${interceptor}\nreturn {run:globalThis.bbMemoryInterceptor,getResult:()=>lastRetrievalResult};`)(...Object.values(dependencies));
  await harness.run([{is_user:true,mes:'查看记忆'}],4096,null,'normal');
  const result=harness.getResult();assert.equal(result.memoryCandidateCount,1);assert.equal(result.hits.length,0);assert.equal(result.memoryNotInjectedCount,1);
  assert.equal(prompts.get('long'),'');assert.equal(prompts.get('realtime'),'');
 } finally {ctx.setExtensionPrompt=previous;}
});
await test('地图两跳、根分支3、后续分支2，环路及同区域不外溢',async()=>{
 const names=['城门','北路','南路','西路','北一','北二','北三','遥远城','远郊'];
 const locations=Object.fromEntries(names.map((name,i)=>[String(i),{id:String(i),name,region:'王国',edges:[],memoryTier:'stable'}]));
 locations[0].edges=[1,2,3].map(to=>({toId:String(to)}));locations[1].edges=[4,5,6].map(to=>({toId:String(to)}));locations[4].edges=[{toId:'0'},{toId:'8'}];
 const result=await retriever.buildMemoryInjectionPrompt({settings:{...store.getSettings(),tokenBudget:4000,mapInjectionMax:20,mapFallbackInjectionMax:0},mapData:{locations},queryText:'城门'});
 assert.ok(result.text.includes('北一'));assert.ok(result.text.includes('北二'));assert.ok(result.text.includes('西路'));
 for(const name of ['北三','遥远城','远郊'])assert.ok(!result.text.includes(name),name);
 assert.deepEqual(new Set(result.stats.mapLocationIds),new Set(['0','1','2','3','4','5']));
 const none=await retriever.buildMemoryInjectionPrompt({settings:{...store.getSettings(),mapInjectionMax:0},mapData:{locations},queryText:'城门'});assert.equal(none.stats.mapCount,0);
});
await test('维护按钮由单条同源定义；积灰物品常驻写入 core',async()=>{
 const buttons=maint.pendingMaintenanceButtons('dusty_item');assert.ok(buttons.some(b=>b.op==='item_to_core'));
 for(const type of ['stale','thread_empty','missing_embedding','map_isolated_location'])for(const b of health.getActionButtonsForIssue({type})) assert.ok(maint.availableMaintenanceOps({type}).includes(b.op));
 const item=await store.addItem(ctx.chatId,{name:'佩剑',memoryTier:'transient'});
 const result=await maint.executeMaintenanceBatch(ctx.chatId,[{source:'pending',type:'dusty_item',collection:'item',id:item.id,item}], 'item_to_core');
 assert.equal(result.succeeded.length,1);assert.equal((await store.getItems(ctx.chatId))[0].memoryTier,'core');
 store.updateSettings({itemFallbackInjectionProbability:0});assert.ok(retriever.getItemsForInjection(await store.getItems(ctx.chatId),'毫不相关').some(e=>e.id===item.id));
});
await test('分类全局上限5种加其他；AI标签转义之前始终当文本',async()=>{
 const ops=Array.from({length:9},(_,i)=>({issueCategory:i===0?'<测试>':'问题'+i}));
 const categories=classifyCurationOps(ops,5);assert.equal(categories.length,6);assert.equal(ops.filter(o=>o.issueCategory==='其他').length,4);
 const source={id:'cat',content:'原内容'};
 const parsed=curator.parseCurationOps(JSON.stringify({ops:[{op:'rewrite',pillar:'mem',ids:['cat'],issueCategory:'时间缺失',result:{content:'新内容'}}]}),{groups:[{pillar:'mem',entries:[source]}]});
 assert.equal(parsed.ops[0].issueCategory,'时间缺失');
});
const thread=await store.upsertTimeline(ctx.chatId,{name:'出征',summary:'出征前的准备工作以及此后的战事',status:'ongoing',entries:['招募大批士兵并登记造册','任命各队队长并进行训练','铸造兵器并分配给各营','率领军队正式出征前线'].map(event=>({event,period:'五月初三午后',status:'ended'}))});
const draft={summary:'筹备后出征',entries:[{event:'主角统筹出征准备',sourceIndices:[0,1,2]},{event:'军队出征',sourceIndices:[3]}]};
await test('条数或字数超过阈值均提醒故事线压缩',async()=>{
 store.updateSettings({timelineCompressionEntryThreshold:4,timelineCompressionCharThreshold:10000});
 const {checkMaintenanceNeeded}=await import('../memory-maintainer.js');
 assert.ok((await checkMaintenanceNeeded(ctx.chatId)).issues.some(i=>i.type==='long_timeline'&&i.item.id===thread.id));
 store.updateSettings({timelineCompressionEntryThreshold:99,timelineCompressionCharThreshold:20});
 assert.ok((await checkMaintenanceNeeded(ctx.chatId)).issues.some(i=>i.type==='long_timeline'));
});
await test('压缩先返回摘要及内部条目草稿，不写原文；支持手改、清向量、撤销',async()=>{
 replies=[JSON.stringify(draft)];const generated=await timelines.generateTimelineCompression(ctx.chatId,[thread.id]);assert.equal(generated.ops.length,1);
 assert.equal((await store.getTimeline(ctx.chatId))[0].entries.length,4);
 const op=generated.ops[0];op.result.entries[0].event='林澈统筹出征准备';
 const applied=await curator.applyCurationOps(ctx.chatId,[op],{forceAuth:'auto'});assert.equal(applied.applied.length,1);
 const saved=(await store.getTimeline(ctx.chatId))[0];assert.equal(saved.entries.length,2);assert.equal(saved.entries[0].event,'林澈统筹出征准备');assert.equal(saved.status,'ongoing');
 await curator.undoLastCuration(ctx.chatId);assert.equal((await store.getTimeline(ctx.chatId))[0].entries.length,4);
});
await test('压缩拒绝漏事件、倒序、超长原文；失效建议不能覆盖新改动',async()=>{
 for(const coverage of [[0,2,3],[3,2,1,0]]){
  replies=[JSON.stringify({summary:'概括',entries:[{event:'统筹准备',sourceIndices:coverage}]})];
  const result=await timelines.generateTimelineCompression(ctx.chatId,[thread.id]);assert.equal(result.ops.length,0);assert.match(result.failures[0],/覆盖不完整|顺序/);
 }
 replies=[JSON.stringify({summary:'概括',entries:[...draft.entries,{event:'凭空新事件',sourceIndices:[]}]})];
 assert.equal((await timelines.generateTimelineCompression(ctx.chatId,[thread.id])).ops.length,0);
 const long=await store.upsertTimeline(ctx.chatId,{name:'超长故事线',entries:[{event:'长'.repeat(3000)}]});
 store.updateSettings({timelineCompressionContextChars:2000});const callsBefore=calls.length;
 assert.match((await timelines.generateTimelineCompression(ctx.chatId,[long.id])).failures[0],/输入上限/);assert.equal(calls.length,callsBefore);
 store.updateSettings({timelineCompressionContextChars:60000});
 replies=[JSON.stringify(draft)];const {ops}=await timelines.generateTimelineCompression(ctx.chatId,[thread.id]);
 await store.upsertTimeline(ctx.chatId,{id:thread.id,summary:'用户另改'});
 const failed=await curator.applyCurationOps(ctx.chatId,ops,{forceAuth:'auto'});assert.equal(failed.applied.length,0);assert.match(failed.failed[0].error,/其它操作/);
});
await test('小传只读取选定资料；预设仅取正文；主/副 API 路由及1000字限制',async()=>{
 ctx.characters=[{data:{character_book:{entries:[{content:'内嵌世界书'}]}}}];
 ctx.loadWorldInfo=async name=>({entries:{a:{content:name+'选定资料'},b:{content:'禁用资料',disable:true}}});
 ctx.mainApi='openai';ctx.chatCompletionSettings={api_key:'不得读取配置字段',prompts:[{identifier:'one',content:'启用预设'},{identifier:'two',content:'禁用预设'}],prompt_order:[{character_id:100001,order:[{identifier:'one',enabled:true},{identifier:'two',enabled:false}]}]};
 const options={biographyUseWorldBook:true,biographyWorldBooks:['旧城'],biographyUsePreset:true,biographyUseMemory:false};
 const context=await bio.collectBiographyContext(ctx.chatId,npc,options);assert.ok(context.text.includes('旧城选定资料'));assert.ok(context.text.includes('启用预设'));assert.ok(!context.text.includes('不得读取'));assert.ok(!context.text.includes('禁用'));assert.ok(!context.text.includes('医生'));
 replies=['他收好学生遗落的旧书，将书角轻轻抚平。'];const generated=await bio.generateNpcBiography(ctx.chatId,npc.id,'展现温柔',{...options,biographyApi:'main'});assert.equal(calls.at(-1).api,'main');assert.ok(calls.at(-1).body.systemPrompt.includes('1000'));assert.ok(!calls.at(-1).body.systemPrompt.includes('JSON格式'));assert.ok(generated.text.length<=1000);
 assert.ok(!(await store.getNpcProfiles(ctx.chatId))[0].biography);
 replies=['长'.repeat(1001),'短小传'];const short=await bio.generateNpcBiography(ctx.chatId,npc.id,'',{biographyApi:'custom',biographyUseMemory:false});assert.equal(short.text,'短小传');assert.equal(calls.at(-1).api,'custom');
 replies=['长'.repeat(1001),'长'.repeat(1001)];await assert.rejects(()=>bio.generateNpcBiography(ctx.chatId,npc.id,'',{biographyUseMemory:false}),/仍超过/);
});
await test('人物小传保存字段可导入导出且不覆盖NPC身份',async()=>{
 const n=await store.addNpcProfile(ctx.chatId,{name:'小传测试',biography:'一页旧书',role:'老师'});assert.equal(n.biography,'一页旧书');
 const exported=await store.exportMemories(ctx.chatId);assert.ok(JSON.stringify(exported).includes('一页旧书'));
 await store.updateNpcProfile(ctx.chatId,n.id,{biography:'半页旧书'});const fresh=(await store.getNpcProfiles(ctx.chatId)).find(x=>x.id===n.id);assert.equal(fresh.role,'老师');
});
await test('v9.4.7新增参数仍具备存储、导出、UI绑定',async()=>{
 const version=JSON.parse(readFileSync(new URL('../manifest.json',import.meta.url))).version;
 assert.equal(JSON.parse(await store.exportMemories(ctx.chatId)).version,version);
 const index=readFileSync(new URL('../index.js',import.meta.url),'utf8');
 for(const key of ['mapNeighborDepth','mapRootNeighborLimit','mapBranchLimit','mapDescriptionMaxChars','timelineCompressionEntryThreshold','timelineCompressionCharThreshold','timelineCompressionTargetEntries','timelineCompressionContextChars','timelineCompressionMaxTokens','timelineCompressionApi','curationCategoryLimit']){
  assert.ok(Object.hasOwn(store.DEFAULT_SETTINGS,key));assert.ok(index.includes(`'${key}'`));assert.ok(index.includes(`${key}: ['#`));
 }
});
console.log(`v9.4.7: ${checks} regression groups passed (mock API).`);

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const bank = new Map();
const lf = {
    async getItem(k) { return structuredClone(bank.get(k) ?? null); },
    async setItem(k,v) { bank.set(k,structuredClone(v)); return v; },
    async removeItem(k) { bank.delete(k); },
    async keys() { return [...bank.keys()]; },
    async iterate(fn) { for (const [k,v] of bank) { const result=fn(structuredClone(v),k); if(result!==undefined)return result; } },
};
let account={handle:'alice',created:1}; let unavailable=false;
const ctx={chatId:'shared',characterId:0,characters:[{name:'相同角色',avatar:'same.png'}],chat:[],chatMetadata:{},extensionSettings:{},libs:{localforage:lf},saveSettingsDebounced(){},saveMetadataDebounced(){}};
globalThis.SillyTavern={getContext:()=>ctx};globalThis.window=globalThis;
globalThis.toastr={info(){},warning(){},success(){},error(){}};
globalThis.fetch=async url=> {assert.equal(url,'/api/users/me');return {ok:!unavailable,json:async()=>({...account})};};
const us=await import('../user-storage.js');
const store=await import('../memory-store.js');const slots=await import('../memory-slots.js');
const identity=await import('../slot-identity.js');const curator=await import('../memory-curator.js');
const summary=await import('../story-summary.js');const {parseSummaryJson}=await import('../story-summary-plan.js');
await us.initializeUserStorage();store.updateSettings({autoBackupEnabled:false,embeddingEnabled:false,timelineSummarySplitRetries:0});
let checks=0;
async function test(name,fn){await fn();console.log('PASS '+name);checks++;}
await test('旧未归属键不可读取/扫描；全部新写入含账号作用域',async()=>{
    bank.set('bb_memory_slot_char:same.png_default',{memories:[{id:'secret',title:'other account'}]});
    bank.set('bb_memory_slot_list_char:same.png',['default']);
    bank.set('bb_mem_chat_shared',[{id:'private'}]);
    assert.deepEqual(await store.getMemories('shared'),[]);
    const scan=await identity.scanSlotNamespaces();assert.equal(scan.namespaces.length,0);assert.equal(scan.unresolved.length,0);
    await store.addMemory('shared',{title:'Alice private',content:'secret'});
    await slots.saveToSlot('char:same.png','shared','default');
    assert.equal((await slots.listSlots('char:same.png')).find(s=>s.name==='default').count,1);
    assert.equal(bank.get('bb_mem_chat_shared')[0].id,'private');
    assert.ok([...bank.keys()].some(k=>k.startsWith('bb_user_v1_')&&k.endsWith('bb_memory_slot_char:same.png_default')));
});
await test('两账号同角色同聊天同default：读、写、列举、删除隔离',async()=>{
    const bob=await import('../user-storage.js?bob');account={handle:'bob',created:2};
    await bob.initializeUserStorage();const b=bob.getUserLocalForage();
    assert.equal(await b.getItem('bb_memory_slot_char:same.png_default'),null);
    assert.deepEqual(await b.keys(),[]);
    await b.setItem('bb_memory_slot_char:same.png_default',{memories:[{id:'bob'}]});
    const listed=[];await b.iterate((v,k)=>{listed.push(k);});assert.equal(listed.length,1);
    await b.removeItem('bb_memory_slot_char:same.png_default');
    account={handle:'alice',created:1};assert.equal((await us.getUserLocalForage().getItem('bb_memory_slot_char:same.png_default')).memories[0].title,'Alice private');
});
await test('身份接口失败不回退default；旧页检测切号后拒绝写入',async()=>{
    const fail=await import('../user-storage.js?failed');unavailable=true;
    await assert.rejects(()=>fail.getUserLocalForage().setItem('x',1),/账号/);unavailable=false;
    const old=await import('../user-storage.js?old');await old.initializeUserStorage();const adapter=old.getUserLocalForage();
    account={handle:'bob',created:2};await assert.rejects(()=>old.initializeUserStorage({verify:true}),/账号/);
    await assert.rejects(()=>adapter.setItem('x','wrong'),/账号/);account={handle:'alice',created:1};
});
await test('升级启动与空库备份不删除旧云端资料；超限保留已有备份',async()=>{
    const before=structuredClone(ctx.chatMetadata);
    const old='trusted cloud backup';
    ctx.chatMetadata={bb_memory_v5_backup:old,bb_memory_slot_data_default:'legacy trusted slot'};
    await store.cleanupChatMetadataBloat();assert.equal(ctx.chatMetadata.bb_memory_slot_data_default,'legacy trusted slot');
    ctx.chatId='empty';const empty=await store.exportMemoriesToChatMetadata('empty');
    assert.equal(empty.reason,'empty-local-data');assert.equal(ctx.chatMetadata.bb_memory_v5_backup,old);
    await store.addMemory('empty',{title:'big',content:'字'.repeat(140000)});
    store.updateSettings({chatMetadataBackupMaxKb:128});
    assert.equal((await store.exportMemoriesToChatMetadata('empty')).reason,'size-limit');
    assert.equal(ctx.chatMetadata.bb_memory_v5_backup,old);ctx.chatId='shared';ctx.chatMetadata=before;
    store.updateSettings({chatMetadataBackupMaxKb:2048});
});
let requestCount=0,inflight=0,maxInflight=0,mutate=null,badPlan=false,failedThread='',truncated=false;
const received=[];
const sourceOf=prompt=>JSON.parse(prompt.split('（当前片段）\n')[1].split('\n## 本次执行约束')[0]);
ctx.generateRaw=async body=>{
    requestCount++;
    received.push(body.prompt);
    if(body.prompt.startsWith('阶段 1：')){
        const source=JSON.parse(body.prompt.split('原始上下文：')[1].split('\n只返回')[0]);
        const catalog=JSON.parse(body.prompt.split('故事目录（只用于跨段识别）：')[1].split('\n原始上下文')[0]);
        const groups=source.timeline.map(t=>({key:t.id,name:t.name,timelineIds:[t.id],milestoneIds:source.milestones.filter(m=>m.event.startsWith(t.name)).map(m=>m.id)}));
        const assigned=new Set(groups.flatMap(g=>g.milestoneIds));
        const others=[];
        for(const m of source.milestones.filter(m=>!assigned.has(m.id))){
            const story=catalog.find(c=>m.event.startsWith(c.name));
            if(story)groups.push({key:story.key,name:story.name,timelineIds:[],milestoneIds:[m.id]});else others.push(m);
        }
        if(others.length)groups.push({key:'other',name:'其他',timelineIds:[],milestoneIds:others.map(m=>m.id)});
        if(badPlan)groups[0].timelineIds.push('missing');
        return JSON.stringify({groups});
    }
    inflight++;maxInflight=Math.max(maxInflight,inflight);
    try {
        await new Promise(r=>setTimeout(r,5));
        const source=sourceOf(body.prompt);
        if(mutate) return mutate(source,body);
        if(source.timeline.some(t=>t.id===failedThread))return '{"timeline":[';
        if(truncated&&source.timeline.reduce((n,t)=>n+t.entries.length,0)>1)return '<think>thinking forever';
        const target=body.prompt.match(/允许修改：([^。]+)。/)[1];
        let timeline=target==='只修改里程碑'?[]:source.timeline.map(t=>({id:t.id,summary:'已总结 '+t.name,entries:t.entries.map((e,n)=>({event:e.event+'（总结）',period:e.period,sourceIndices:[n]}))}));
        if(!source.timeline.length&&source.milestones.length&&target!=='只修改里程碑'&&body.prompt.includes('可依据本片段里程碑生成'))timeline=[{name:'其他',summary:'新故事',entries:source.milestones.map(m=>({event:m.event,refId:m.id}))}];
        return '<think>思考</think>\n'+JSON.stringify({timeline,milestones:target==='只修改时间线'?[]:source.milestones.map(m=>({id:m.id,event:m.event+'（总结）',summary:m.summary,storyTime:m.storyTime}))});
    } finally {inflight--;}
};
const m1=await store.addMilestone('shared',{event:'北征关键节点',summary:'准备北征',storyTime:'123年1月1日10点'});
const m2=await store.addMilestone('shared',{event:'建城关键节点',summary:'开始建城',storyTime:'123年2月1日'});
const t1=await store.upsertTimeline('shared',{name:'北征',summary:'北征原文',entries:[{event:'招募',period:'123年1月1日10点',refId:m1.id},{event:'出征',period:'123年1月5日12点',refId:m1.id}]});
const t2=await store.upsertTimeline('shared',{name:'建城',summary:'建城原文',entries:[{event:'建城',period:'123年2月1日',refId:m2.id}]});
await test('先规划后按故事并行，三种写入范围，生成只存草稿',async()=>{
    for(const target of ['timeline','milestone','both']){
        maxInflight=0;const before=await store.getTimeline('shared');
        const generated=await summary.generateJointSummary('shared',{target});
        assert.equal(generated.failures.length,0);assert.equal(generated.groups.length,2);assert.equal(maxInflight,2);
        assert.deepEqual(new Set(generated.ops.map(o=>o.pillar)),new Set(target==='both'?['timeline','milestone']:[target]));
        assert.deepEqual(await store.getTimeline('shared'),before);
        assert.equal((await summary.getJointSummaryDraft('shared')).ops.length,generated.ops.length);
    }
});
await test('保存编辑后的建议、单次撤销恢复两柱、日期保留',async()=>{
    const before=[await store.getTimeline('shared'),await store.getMilestones('shared')];
    const {ops}=await summary.generateJointSummary('shared',{target:'both'});
    ops.find(o=>o.pillar==='timeline').result.summary='手动编辑';
    const result=await summary.applyJointSummary('shared',ops,'both');assert.equal(result.applied.length,4);assert.equal(result.failed.length,0);
    assert.equal((await store.getTimeline('shared')).find(t=>t.id===t1.id).entries[0].period,'123年1月1日');
    await curator.undoLastCuration('shared');assert.deepEqual([await store.getTimeline('shared'),await store.getMilestones('shared')],before);
});
await test('无目标事件数限制：较多事件可保留，超长资料分批，片段拼接不乱序',async()=>{
    const original=await store.getTimeline('shared');
    await store.upsertTimeline('shared',{...t1,entries:Array.from({length:12},(_,n)=>({event:`第${n}件`+'事'.repeat(420),period:`123年1月${n+1}日`,refId:m1.id}))});
    store.updateSettings({timelineSummarySegmentChars:2000,timelineCompressionContextChars:2500});
    received.length=0;
    const {ops,failures}=await summary.generateJointSummary('shared',{target:'timeline'});assert.equal(failures.length,0,JSON.stringify(failures));
    for(const prompt of received.filter(p=>p.includes('## 阶段 2：')&&sourceOf(p).timeline.some(t=>t.id===t1.id)))assert.ok(prompt.includes('北征关键节点'),'分片仍应有对应里程碑上下文');
    const draft=ops.find(o=>o.ids[0]===t1.id);assert.equal(draft.result.entries.length,12);
    draft.result.entries.forEach((e,n)=>assert.ok(e.event.startsWith(`第${n}件`)));
    assert.equal((await summary.applyJointSummary('shared',[draft],'timeline')).failed.length,0);await curator.undoLastCuration('shared');
    await store.upsertTimeline('shared',original.find(t=>t.id===t1.id));
    store.updateSettings({timelineSummarySegmentChars:16000,timelineCompressionContextChars:60000});
});
await test('截断自动拆小重试；失败故事不覆盖，成功故事可审核',async()=>{
    truncated=true;store.updateSettings({timelineSummarySplitRetries:2});
    let draft=await summary.generateJointSummary('shared',{target:'timeline'});assert.equal(draft.failures.length,0);assert.equal(draft.ops.length,2);truncated=false;
    failedThread=t1.id;draft=await summary.generateJointSummary('shared',{target:'both'});
    assert.ok(draft.failures.length);assert.ok(!draft.ops.some(o=>o.ids[0]===t1.id));assert.ok(draft.ops.some(o=>o.ids[0]===t2.id));
    failedThread='';store.updateSettings({timelineSummarySplitRetries:0});
});
await test('非法分段拒绝；未知ID、漏事件和越权输出逐段拦截',async()=>{
    badPlan=true;await assert.rejects(()=>summary.generateJointSummary('shared'),/分段/);badPlan=false;
    for(const mode of ['id','coverage','scope']){
        mutate=source=>JSON.stringify(mode==='scope'?{timeline:[],milestones:[{id:source.milestones[0]?.id,event:'越权'}]}:{timeline:source.timeline.map(t=>({id:mode==='id'?'missing':t.id,summary:'x',entries:[{event:'x',sourceIndices:[99]}]}))});
        const draft=await summary.generateJointSummary('shared',{target:'timeline'});assert.equal(draft.ops.length,0);assert.ok(draft.failures.length);
    }mutate=null;
});
await test('副API预算传递，finish_reason=length拒绝看似完整的JSON',async()=>{
    const originalFetch=globalThis.fetch;let usedBudget=0;
    store.updateSettings({timelineCompressionApi:'custom',autoGenEndpoint:'https://mock.invalid/v1/chat/completions',timelineCompressionMaxTokens:65536});
    globalThis.fetch=async(url,options)=>{
        if(url==='/api/users/me')return originalFetch(url,options);
        const body=JSON.parse(options.body);usedBudget=body.max_tokens;
        const prompt=body.messages.at(-1).content;
        return {ok:true,json:async()=>({choices:[{finish_reason:prompt.startsWith('阶段 1：')?'stop':'length',message:{content:await ctx.generateRaw({prompt})}}]})};
    };
    try {
        const draft=await summary.generateJointSummary('shared',{target:'both'});
        assert.equal(usedBudget,65536);assert.equal(draft.ops.length,0);assert.ok(draft.failures.every(f=>f.error.includes('token 上限')));
    } finally {globalThis.fetch=originalFetch;store.updateSettings({timelineCompressionApi:'main',timelineCompressionMaxTokens:64000});}
});
await test('草稿原文修改后禁止覆盖；审核应用范围再次校验',async()=>{
    const draft=await summary.generateJointSummary('shared',{target:'both'});
    const op=draft.ops.find(o=>o.ids[0]===t1.id);
    await store.upsertTimeline('shared',{...((await store.getTimeline('shared')).find(t=>t.id===t1.id)),summary:'新原文'});
    assert.equal((await summary.applyJointSummary('shared',[op],'timeline')).failed.length,1);
    await assert.rejects(()=>summary.applyJointSummary('shared',[op],'milestone'),/范围/);
});
await test('无时间线时从里程碑分段创建；可撤销新增',async()=>{
    ctx.chatId='new';await store.addMilestone('new',{event:'新故事',summary:'出发'});
    const draft=await summary.generateJointSummary('new',{target:'both'});assert.equal(draft.failures.length,0);
    assert.equal((await summary.applyJointSummary('new',draft.ops,'both')).failed.length,0);assert.equal((await store.getTimeline('new')).length,1);
    await curator.undoLastCuration('new');assert.equal((await store.getTimeline('new')).length,0);ctx.chatId='shared';
});
await test('模型调用中切聊天不保存；思考清理与不完整JSON拒绝',async()=>{
    mutate=()=>{ctx.chatId='other';return '{}';};await assert.rejects(()=>summary.generateJointSummary('shared'),/聊天已切换/);mutate=null;ctx.chatId='shared';
    assert.deepEqual(parseSummaryJson('<think>x</think>```json\n{"x":1}\n```'),{x:1});assert.throws(()=>parseSummaryJson('{"x":'),/完整 JSON/);
    assert.throws(()=>parseSummaryJson('<think>{"timeline":[]}'),/思考段/);
});
await test('v9.4.9设置与版本；旧事件数参数退出，64000默认预算',async()=>{
    assert.equal(JSON.parse(readFileSync(new URL('../manifest.json',import.meta.url))).version,'9.4.9');
    assert.equal(store.DEFAULT_SETTINGS.timelineCompressionMaxTokens,64000);assert.equal(store.DEFAULT_SETTINGS.timelineCompressionTargetEntries,undefined);
    for(const file of ['index.js','settings.html','memory-organization.js']){
        const text=readFileSync(new URL('../'+file,import.meta.url),'utf8');
        assert.ok(!text.includes('timelineCompressionTargetEntries'));assert.ok(!text.includes('bb_timeline_compression_target_entries'));
    }
});
console.log(`v9.4.9: ${checks} regression groups passed; ${requestCount} mock model requests.`);

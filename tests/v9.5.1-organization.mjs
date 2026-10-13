import assert from 'node:assert/strict';
const bank = new Map(); let failWrite = null;
const lf = { async getItem(k) { return structuredClone(bank.get(k) ?? null); }, async setItem(k,v) { if(failWrite?.(k,v)) throw new Error('模拟存储写入失败'); bank.set(k,structuredClone(v)); return v; }, async removeItem(k) { bank.delete(k); }, async keys() { return [...bank.keys()]; } };
const ctx = { chatId:'organization951', chat:[], chatMetadata:{}, extensionSettings:{}, libs:{localforage:lf}, saveSettingsDebounced(){}, saveMetadataDebounced(){} };
globalThis.SillyTavern = { getContext:()=>ctx }; globalThis.window = globalThis;
globalThis.toastr = { info(){}, warning(){}, success(){}, error(){} };
globalThis.fetch = async url => { assert.equal(url,'/api/users/me'); return {ok:true,json:async()=>({handle:'organization-test',created:1})}; };
const store = await import('../memory-store.js');
const storage = await import('../user-storage.js');
const organization = await import('../timeline-organization.js');
const curator = await import('../memory-curator.js');
await storage.initializeUserStorage();
store.updateSettings({autoBackupEnabled:false,embeddingEnabled:false,timelineCompressionApi:'main',timelineCompressionContextChars:60000,timelineCompressionMaxTokens:64000});
let checks=0, mutate=null, received=[], apiCalls=0;
const sourceOf = prompt => JSON.parse(prompt.split('## 完整时间线与里程碑资料\n')[1].split('\n## 输出规范')[0]);
ctx.generateRaw = async ({prompt,responseLength}) => {
    apiCalls++; assert.equal(responseLength,64000);
    const source = sourceOf(prompt); received.push(source);
    await new Promise(resolve=>setTimeout(resolve,1));
    if(mutate) return mutate(source,prompt);
    if(prompt.includes('{"assignments":')) return JSON.stringify({assignments:source.milestones.filter(m=>!m.archived && !m.timelineId).map(m=>({milestoneId:m.id,timelineId:source.timeline.find(t=>t.status!=='archived').id,reason:'属于公园故事'}))});
    const ts=source.timeline.filter(t=>!t.archived && t.status!=='archived').slice(0,2);
    return JSON.stringify({merges:[{ids:ts.map(t=>t.id),keepId:ts[0].id,result:{name:'A 与 B 的公园之行',summary:'相约在公园见面后一起游玩'},reason:'同一次公园之行'}]});
};
async function test(name,fn){await fn();checks++;console.log('PASS '+name);}
const t1 = await store.upsertTimeline(ctx.chatId,{name:'公园邀约',summary:'A 与 B 约定在公园见面',type:'emotional',entries:[{period:'银月历3年1月1日',event:'约定公园见面',refId:'ref-one',note:'原文细节'}],tags:[{name:'约定',weight:.9}],lastSummarizedAt:1700000000000});
const t2 = await store.upsertTimeline(ctx.chatId,{name:'公园游玩',summary:'A 与 B 在公园游玩',entries:[{period:'银月历3年1月2日',event:'公园游玩',refId:'ref-two'}],tags:[{name:'约定',weight:.2},{name:'亲密',weight:.8}],lastSummarizedAt:1710000000000});
const t3 = await store.upsertTimeline(ctx.chatId,{name:'后续约会',summary:'第三次约会',parentThreadId:t2.id,entries:[{event:'另一次约会'}]});
const archived = await store.upsertTimeline(ctx.chatId,{name:'旧故事',status:'archived',entries:[{event:'归档原事件'}]});
const m1 = await store.addMilestone(ctx.chatId,{event:'首次公园见面',summary:'原文不改',storyTime:'银月历3年1月1日',tags:[{name:'里程碑原标签'}]});
const m2 = await store.addMilestone(ctx.chatId,{event:'公园牵手',timelineId:t2.id,participants:['A','B']});
const m3 = await store.addMilestone(ctx.chatId,{event:'归档的公园细节',timelineId:t2.id,archived:true});
const untouched = await store.addMilestone(ctx.chatId,{event:'别处事件',timelineId:t3.id});
await test('完整资料包含所有时间线/事件和归档参考，行政总结时间不参与AI',async()=>{
    const originalT=await store.getTimeline(ctx.chatId), originalM=await store.getMilestones(ctx.chatId);
    received=[];const progress=[];
    const draft=await organization.generateTimelineOrganization(ctx.chatId,{mode:'tags',onProgress:m=>progress.push(m)});
    assert.equal(draft.ops.length,1);assert.ok(draft.ops.every(op=>op.forceConfirm && op.selected===false));
    assert.equal(received[0].timeline.length,4);assert.equal(received[0].milestones.length,4);
    assert.deepEqual(received[0].timeline[1].entries,t2.entries);assert.equal(received[0].timeline[3].entries[0].event,'归档原事件');
    assert.ok(received[0].timeline.every(t=>!Object.hasOwn(t,'lastSummarizedAt')));assert.ok(progress.length>=3);
    assert.deepEqual(await store.getTimeline(ctx.chatId),originalT);assert.deepEqual(await store.getMilestones(ctx.chatId),originalM);
    assert.equal((await organization.getTimelineOrganizationDraft(ctx.chatId,{mode:'tags'})).ops[0].result.timelineId,t1.id);
});
await test('标签建议允许新增、调整和取消，但采纳仅改选中标签并可整批撤销',async()=>{
    mutate=()=>JSON.stringify({assignments:[{milestoneId:m1.id,timelineId:t1.id,reason:'首次见面'}, {milestoneId:m2.id,timelineId:t1.id,reason:'归属调整'},{milestoneId:untouched.id,timelineId:'',reason:'取消不合适标签'}]});
    const draft=await organization.generateTimelineOrganization(ctx.chatId,{mode:'tags'});mutate=null;
    assert.equal(draft.ops.length,3);
    const before=await store.getMilestones(ctx.chatId),progress=[];
    const applied=await organization.applyTimelineOrganization(ctx.chatId,[draft.ops[0]],{mode:'tags',allowed:draft.allowed,onProgress:m=>progress.push(m)});
    assert.equal(applied.applied.length,1);assert.ok(progress.every(m=>typeof m==='string'));
    const after=await store.getMilestones(ctx.chatId), changed=after.find(m=>m.id===m1.id);
    assert.equal(changed.timelineId,t1.id);for(const field of ['event','summary','storyTime','tags'])assert.deepEqual(changed[field],m1[field]);
    assert.deepEqual(after.find(m=>m.id===m2.id),before.find(m=>m.id===m2.id));assert.equal(after.find(m=>m.id===untouched.id).timelineId,t3.id);
    assert.equal((await curator.undoLastCuration(ctx.chatId)).ok,true);assert.deepEqual(await store.getMilestones(ctx.chatId),before);
});
await test('两种整理草稿独立保留，无建议和无效输出不覆盖旧草稿',async()=>{
    const tags=await organization.getTimelineOrganizationDraft(ctx.chatId,{mode:'tags'});
    const merge=await organization.generateTimelineOrganization(ctx.chatId,{mode:'merge'});
    assert.equal((await organization.getTimelineOrganizationDraft(ctx.chatId)).mode,'merge');
    assert.deepEqual(await organization.getTimelineOrganizationDraft(ctx.chatId,{mode:'tags'}),tags);
    mutate=()=>JSON.stringify({merges:[]});const none=await organization.generateTimelineOrganization(ctx.chatId,{mode:'merge'});assert.equal(none.ops.length,0);assert.match(none.summary,/没有适用/);
    assert.deepEqual(await organization.getTimelineOrganizationDraft(ctx.chatId,{mode:'merge'}),merge);
    mutate=()=>'{"merges":[';await assert.rejects(()=>organization.generateTimelineOrganization(ctx.chatId,{mode:'merge'}),/完整 JSON/);mutate=null;
    assert.deepEqual(await organization.getTimelineOrganizationDraft(ctx.chatId,{mode:'merge'}),merge);
});
await test('模型虚构ID、归档目标、重复/重叠合并和越权字段均拒绝',async()=>{
    const timeline=await store.getTimeline(ctx.chatId),ms=await store.getMilestones(ctx.chatId);
    for(const assignments of [[{milestoneId:'missing',timelineId:t1.id}],[{milestoneId:m1.id,timelineId:'missing'}],[{milestoneId:m1.id,timelineId:archived.id}],[{milestoneId:m3.id,timelineId:t1.id}],[{milestoneId:m1.id,timelineId:t1.id},{milestoneId:m1.id,timelineId:t2.id}],[{milestoneId:m1.id,timelineId:t1.id,event:'越权改写'}]]) {
        await assert.rejects(()=>organization.parseTimelineOrganizationDraft({assignments},timeline,ms,'tags'));
    }
    const valid={ids:[t1.id,t2.id],keepId:t1.id,result:{name:'公园之行',summary:'同一事件'}};
    for(const merges of [[{...valid,ids:[t1.id,t1.id]}],[{...valid,ids:[t1.id,'missing']}],[{...valid,keepId:t3.id}],[{...valid,ids:[t1.id,archived.id]}],[valid,{...valid,ids:[t2.id,t3.id],keepId:t3.id}],[{...valid,result:{...valid.result,entries:[]}}]]) {
        await assert.rejects(()=>organization.parseTimelineOrganizationDraft({merges},timeline,ms,'merge'));
    }
});
await test('审核编辑仍限定字段与有效ID，不允许删除合并原事件或标签',async()=>{
    const draft=await organization.generateTimelineOrganization(ctx.chatId,{mode:'merge'}),op=draft.ops[0];
    assert.throws(()=>organization.validateTimelineOrganizationOp({...op,result:{...op.result,entries:[]}},'merge',draft.allowed),/保留全部原事件/);
    assert.throws(()=>organization.validateTimelineOrganizationOp({...op,result:{...op.result,tags:[]}},'merge',draft.allowed),/保留原时间线/);
    assert.throws(()=>organization.validateTimelineOrganizationOp({...op,result:{...op.result,name:''}},'merge',draft.allowed),/名称不能为空/);
    assert.throws(()=>organization.validateTimelineOrganizationOp({...op,result:{...op.result,priority:'invalid'}},'merge',draft.allowed),/priority/);
    const tags=(await organization.generateTimelineOrganization(ctx.chatId,{mode:'tags'})).ops[0];
    assert.throws(()=>organization.validateTimelineOrganizationOp({...tags,result:{timelineId:'missing'}},'tags'),/有效/);
    assert.throws(()=>organization.validateTimelineOrganizationOp({...tags,result:{timelineId:t1.id,event:'越权'}},'tags'),/只允许/);
});
await test('合并完整保留事件、标签、最大总结时间，重映射里程碑与子线父级并整体撤销',async()=>{
    const beforeT=await store.getTimeline(ctx.chatId), beforeM=await store.getMilestones(ctx.chatId);
    const draft=await organization.generateTimelineOrganization(ctx.chatId,{mode:'merge'}),op=draft.ops[0];
    assert.ok(op.notes.some(n=>n.includes('公园牵手')&&n.includes('公园游玩')));
    assert.ok(op.notes.some(n=>n.includes('后续约会')));
    const applied=await organization.applyTimelineOrganization(ctx.chatId,[op],{mode:'merge',allowed:draft.allowed});
    assert.equal(applied.ok,true);assert.equal(applied.applied.length,1);assert.equal(applied.repairedCount,2);
    const afterT=await store.getTimeline(ctx.chatId), afterM=await store.getMilestones(ctx.chatId), survivor=afterT.find(t=>t.id===t1.id);
    assert.equal(afterT.length,3);assert.equal(survivor.name,'A 与 B 的公园之行');assert.deepEqual(survivor.entries,[...t1.entries,...t2.entries]);
    assert.deepEqual(survivor.tags,[{name:'约定',weight:.9},{name:'亲密',weight:.8}]);assert.equal(survivor.lastSummarizedAt,t2.lastSummarizedAt);
    assert.equal(afterT.find(t=>t.id===t3.id).parentThreadId,t1.id);
    assert.equal(afterM.find(m=>m.id===m2.id).timelineId,t1.id);assert.equal(afterM.find(m=>m.id===m3.id).timelineId,t1.id);assert.equal(afterM.find(m=>m.id===untouched.id).timelineId,t3.id);
    assert.equal((await curator.undoLastCuration(ctx.chatId)).ok,true);
    assert.deepEqual(await store.getTimeline(ctx.chatId),beforeT);assert.deepEqual(await store.getMilestones(ctx.chatId),beforeM);
});
await test('合并保留方属于被吸收父线时不会保留悬空或自身父引用',async()=>{
    await store.upsertTimeline(ctx.chatId,{id:t1.id,parentThreadId:t2.id});
    const draft=await organization.generateTimelineOrganization(ctx.chatId,{mode:'merge'});
    const applied=await organization.applyTimelineOrganization(ctx.chatId,draft.ops,{mode:'merge',allowed:draft.allowed});assert.equal(applied.ok,true);
    assert.equal((await store.getTimeline(ctx.chatId)).find(t=>t.id===t1.id).parentThreadId,null);
    assert.equal((await curator.undoLastCuration(ctx.chatId)).ok,true);
    await store.upsertTimeline(ctx.chatId,{id:t1.id,parentThreadId:null});
});
await test('跨祖孙合并不会令外部中间父线与保留方形成环',async()=>{
    const beforeT=await store.getTimeline(ctx.chatId);
    await store.upsertTimeline(ctx.chatId,{id:t2.id,parentThreadId:t1.id});
    await store.upsertTimeline(ctx.chatId,{id:t3.id,parentThreadId:t2.id});
    mutate=()=>JSON.stringify({merges:[{ids:[t1.id,t3.id],keepId:t1.id,result:{name:'祖孙合并线',summary:'保持父级无环'}}]});
    const draft=await organization.generateTimelineOrganization(ctx.chatId,{mode:'merge'});mutate=null;
    const applied=await organization.applyTimelineOrganization(ctx.chatId,draft.ops,{mode:'merge',allowed:draft.allowed});assert.equal(applied.ok,true);
    const after=await store.getTimeline(ctx.chatId);assert.equal(after.find(t=>t.id===t1.id).parentThreadId,null);assert.equal(after.find(t=>t.id===t2.id).parentThreadId,t1.id);
    assert.equal((await curator.undoLastCuration(ctx.chatId)).ok,true);
    await store.saveTimeline(ctx.chatId,beforeT);
});
await test('标签源与目标、合并来源或关联集合变化会拒绝陈旧草稿',async()=>{
    const draft=await organization.generateTimelineOrganization(ctx.chatId,{mode:'tags'});
    await store.updateMilestone(ctx.chatId,m1.id,{event:'用户编辑新事实'});
    await assert.rejects(()=>organization.applyTimelineOrganization(ctx.chatId,draft.ops,{mode:'tags',allowed:draft.allowed}),/已被修改/);
    await store.updateMilestone(ctx.chatId,m1.id,{event:m1.event});
    const tags=await organization.generateTimelineOrganization(ctx.chatId,{mode:'tags'});
    await store.upsertTimeline(ctx.chatId,{id:t1.id,summary:'目的线新情节'});
    await assert.rejects(()=>organization.applyTimelineOrganization(ctx.chatId,tags.ops,{mode:'tags',allowed:tags.allowed}),/已被修改/);
    await store.upsertTimeline(ctx.chatId,{id:t1.id,summary:t1.summary});
    const merge=await organization.generateTimelineOrganization(ctx.chatId,{mode:'merge'});
    const late=await store.addMilestone(ctx.chatId,{event:'审核期间新增标签',timelineId:t2.id});
    await assert.rejects(()=>organization.applyTimelineOrganization(ctx.chatId,merge.ops,{mode:'merge',allowed:merge.allowed}),/集合已变化/);
    await store.removeMilestone(ctx.chatId,late.id);
    const child=await store.upsertTimeline(ctx.chatId,{name:'后来子线',parentThreadId:t2.id});
    await assert.rejects(()=>organization.applyTimelineOrganization(ctx.chatId,merge.ops,{mode:'merge',allowed:merge.allowed}),/父级引用集合/);
    await store.removeTimeline(ctx.chatId,child.id);
});
await test('完整资料超过预算会明确拒绝，不截断、不调用AI、不覆盖原草稿',async()=>{
    const before=await organization.getTimelineOrganizationDraft(ctx.chatId,{mode:'merge'}), beforeCalls=apiCalls;
    const giant=await store.upsertTimeline(ctx.chatId,{name:'超长故事',entries:[{event:'情节'.repeat(2000)}]});
    store.updateSettings({timelineCompressionContextChars:2000});
    await assert.rejects(()=>organization.generateTimelineOrganization(ctx.chatId,{mode:'merge'}),/未截断/);
    assert.equal(apiCalls,beforeCalls);assert.deepEqual(await organization.getTimelineOrganizationDraft(ctx.chatId,{mode:'merge'}),before);
    await store.removeTimeline(ctx.chatId,giant.id);store.updateSettings({timelineCompressionContextChars:60000});
});
await test('同聊天并发任务拒绝重复，聊天切换后丢弃异步结果',async()=>{
    const first=organization.generateTimelineOrganization(ctx.chatId,{mode:'tags'});
    await assert.rejects(()=>organization.generateTimelineOrganization(ctx.chatId,{mode:'merge'}),/已有时间线整理任务/);await first;
    mutate=()=>{ctx.chatId='switched';return JSON.stringify({assignments:[]})};
    await assert.rejects(()=>organization.generateTimelineOrganization('organization951',{mode:'tags'}),/聊天已切换/);ctx.chatId='organization951';mutate=null;
});
await test('合并标签写失败时整批恢复，草稿和未选条目保持原样',async()=>{
    const draft=await organization.generateTimelineOrganization(ctx.chatId,{mode:'merge'});
    const beforeT=await store.getTimeline(ctx.chatId),beforeM=await store.getMilestones(ctx.chatId);
    let once=true;failWrite=(key)=>{if(once && key.includes('bb_milestone_chat_organization951')){once=false;return true}return false};
    const applied=await organization.applyTimelineOrganization(ctx.chatId,draft.ops,{mode:'merge',allowed:draft.allowed});failWrite=null;
    assert.equal(applied.ok,false);assert.equal(applied.rolledBack,true);assert.deepEqual(applied.applied,[]);assert.match(applied.summary,/已恢复/);
    assert.deepEqual(await store.getTimeline(ctx.chatId),beforeT);assert.deepEqual(await store.getMilestones(ctx.chatId),beforeM);
    assert.deepEqual(await organization.getTimelineOrganizationDraft(ctx.chatId,{mode:'merge'}),draft);
});
await test('部分柱撤销写失败时保留快照，恢复存储后可再次完整撤销',async()=>{
    const draft=await organization.generateTimelineOrganization(ctx.chatId,{mode:'merge'}),beforeT=await store.getTimeline(ctx.chatId),beforeM=await store.getMilestones(ctx.chatId);
    const applied=await organization.applyTimelineOrganization(ctx.chatId,draft.ops,{mode:'merge',allowed:draft.allowed});assert.equal(applied.ok,true);
    failWrite=key=>key.includes('bb_milestone_chat_organization951');
    const partial=await curator.undoLastCuration(ctx.chatId,{snapshotId:applied.snapshotId});failWrite=null;
    assert.equal(partial.ok,false);assert.ok((await curator.listCurationSnapshots(ctx.chatId)).some(s=>s.id===applied.snapshotId));
    const retried=await curator.undoLastCuration(ctx.chatId,{snapshotId:applied.snapshotId});assert.equal(retried.ok,true);
    assert.deepEqual(await store.getTimeline(ctx.chatId),beforeT);assert.deepEqual(await store.getMilestones(ctx.chatId),beforeM);
});
await test('账号聊天清库移除两种草稿及最新指针',async()=>{
    await organization.generateTimelineOrganization(ctx.chatId,{mode:'tags'});
    await organization.generateTimelineOrganization(ctx.chatId,{mode:'merge'});
    assert.ok(await organization.getTimelineOrganizationDraft(ctx.chatId,{mode:'tags'}));assert.ok(await organization.getTimelineOrganizationDraft(ctx.chatId,{mode:'merge'}));
    await store.clearAllData(ctx.chatId);
    assert.equal(await organization.getTimelineOrganizationDraft(ctx.chatId,{mode:'tags'}),null);assert.equal(await organization.getTimelineOrganizationDraft(ctx.chatId,{mode:'merge'}),null);
    assert.equal(await organization.getTimelineOrganizationDraft(ctx.chatId),null);
});
console.log(checks+' timeline organization regression groups passed');

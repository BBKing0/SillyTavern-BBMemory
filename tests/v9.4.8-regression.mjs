import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const bank = new Map();
const lf = { async getItem(k) { return structuredClone(bank.get(k) ?? null); }, async setItem(k,v) { bank.set(k,structuredClone(v)); return v; }, async removeItem(k) { bank.delete(k); } };
const ctx = { chatId:'v948', chat:[], chatMetadata:{}, extensionSettings:{}, libs:{localforage:lf}, saveSettingsDebounced(){}, saveMetadataDebounced(){} };
globalThis.SillyTavern = { getContext:() => ctx }; globalThis.window = globalThis;
globalThis.toastr = { info(){},warning(){},success(){},error(){} };
const store = await import('../memory-store.js');
const summary = await import('../story-summary.js');
const curator = await import('../memory-curator.js');
const rt = await import('../realtime-memory.js');
const retriever = await import('../retriever.js');
store.updateSettings({ autoBackupEnabled:false, embeddingEnabled:false, realtimeSettledRetentionFloors:500 });
let reply, prompt, calls=0, checks=0;
ctx.generateRaw = async body => { calls++; prompt = body.prompt; return typeof reply === 'function' ? reply(body) : JSON.stringify(reply); };
const test = async (name, fn) => { await fn(); checks++; console.log('PASS '+name); };
const ms = await store.addMilestone(ctx.chatId, { event:'北征关键节点',summary:'连续五天训练队伍，完成准备后正式北征',storyTime:'123年1月1日10点',status:'ended' });
const thread = await store.upsertTimeline(ctx.chatId,{name:'北征',summary:'连续几天招募队伍并训练随后出征',status:'ongoing',entries:[
    { period:'123年1月1日10点',event:'第一天招兵训练',status:'ended',refId:ms.id },
    { period:'123年1月5日12点',event:'第五天继续训练',status:'ended',refId:ms.id },
]});
const timelineDraft = () => ({ id:thread.id,summary:'训练完成',entries:[{ period:'123年1月1日-5日',event:'连续五天训练队伍',sourceIndices:[0,1] }] });
const milestoneDraft = () => ({ id:ms.id,event:'完成北征准备',summary:'训练完成后北征',storyTime:'123年1月1日-5日' });
await test('三种范围均发送时间线与里程碑，预览不落库，未获准柱拒绝',async()=>{
    for (const target of ['timeline','milestone','both']) {
        reply={timeline:target==='milestone'?[]:[timelineDraft()],milestones:target==='timeline'?[]:[milestoneDraft()]};
        const generated=await summary.generateJointSummary(ctx.chatId,{target});
        assert.ok(prompt.includes('北征关键节点'));assert.ok(prompt.includes('第一天招兵训练'));
        assert.ok(prompt.includes('123年1月1日-5日'));assert.ok(prompt.includes('删除无必要的小时'));
        assert.deepEqual(new Set(generated.ops.map(o=>o.pillar)),new Set(target==='both'?['timeline','milestone']:[target]));
        assert.equal((await store.getTimeline(ctx.chatId))[0].entries.length,2);
    }
    reply={timeline:[timelineDraft()],milestones:[milestoneDraft()]};
    await assert.rejects(()=>summary.generateJointSummary(ctx.chatId,{target:'timeline'}),/未获准/);
    await assert.rejects(()=>summary.generateJointSummary(ctx.chatId,{target:'milestone'}),/未获准/);
});
await test('日期与区间保留；漏回period从来源恢复，时分秒去除',async()=>{
    assert.equal(summary.coarseStoryDate('123年1月1日10点'),'123年1月1日');
    assert.equal(summary.coarseStoryDate('123年1月1日10:12:30'),'123年1月1日');
    assert.equal(summary.coarseStoryDate('123年1月1日-5日'),'123年1月1日-5日');
    assert.equal(summary.coarseStoryDate('123年12月31日—124年1月2日'),'123年12月31日—124年1月2日');
    assert.equal(summary.coarseStoryDate('123年1月1日10点—123年1月5日12点'),'123年1月1日—123年1月5日');
    const value=timelineDraft();delete value.entries[0].period;reply={timeline:[value]};
    const result=await summary.generateJointSummary(ctx.chatId,{target:'timeline'});
    assert.equal(result.ops[0].result.entries[0].period,'123年1月1日—123年1月5日');
    assert.equal(result.ops[0].result.entries[0].refId,ms.id);
});
await test('联合保存与单次撤销同时恢复两柱；状态和ID不变',async()=>{
    reply={timeline:[timelineDraft()],milestones:[milestoneDraft()]};
    const before=[await store.getTimeline(ctx.chatId),await store.getMilestones(ctx.chatId)];
    const {ops}=await summary.generateJointSummary(ctx.chatId,{target:'both'});
    const applied=await summary.applyJointSummary(ctx.chatId,ops,'both');assert.equal(applied.applied.length,2);
    assert.equal((await store.getTimeline(ctx.chatId))[0].entries[0].period,'123年1月1日-5日');
    assert.equal((await store.getMilestones(ctx.chatId))[0].event,'完成北征准备');
    assert.equal((await store.getTimeline(ctx.chatId))[0].status,'ongoing');
    await curator.undoLastCuration(ctx.chatId);
    assert.deepEqual([await store.getTimeline(ctx.chatId),await store.getMilestones(ctx.chatId)],before);
});
await test('只改里程碑不会改时间线；应用层再次检查范围',async()=>{
    reply={milestones:[milestoneDraft()]};const {ops}=await summary.generateJointSummary(ctx.chatId,{target:'milestone'});
    const before=await store.getTimeline(ctx.chatId);
    await assert.rejects(()=>summary.applyJointSummary(ctx.chatId,ops,'timeline'),/范围/);
    await summary.applyJointSummary(ctx.chatId,ops,'milestone');assert.deepEqual(await store.getTimeline(ctx.chatId),before);
    await curator.undoLastCuration(ctx.chatId);
});
await test('未知ID、漏事件、重复、输入超限、切换聊天均不写库',async()=>{
    reply={timeline:[{...timelineDraft(),id:'missing'}]};await assert.rejects(()=>summary.generateJointSummary(ctx.chatId),/ID/);
    reply={timeline:[timelineDraft(),timelineDraft()]};await assert.rejects(()=>summary.generateJointSummary(ctx.chatId),/重复/);
    reply={timeline:[{...timelineDraft(),entries:[{event:'遗漏',sourceIndices:[1]}]}]};await assert.rejects(()=>summary.generateJointSummary(ctx.chatId),/覆盖不完整/);
    reply=()=>{ctx.chatId='other';return JSON.stringify({timeline:[timelineDraft()]});};await assert.rejects(()=>summary.generateJointSummary('v948'),/聊天已切换/);ctx.chatId='v948';
    const huge=await store.addMilestone(ctx.chatId,{event:'很长',summary:'长'.repeat(3000)});
    store.updateSettings({timelineCompressionContextChars:2000});const before=calls;
    await assert.rejects(()=>summary.generateJointSummary(ctx.chatId),/输入上限/);assert.equal(calls,before);
    store.updateSettings({timelineCompressionContextChars:60000});await store.removeMilestone(ctx.chatId,huge.id);
});
await test('新时间线与里程碑共同审核保存，可一次撤销新增与更新',async()=>{
    ctx.chatId='new948';const node=await store.addMilestone(ctx.chatId,{event:'出发',summary:'从村庄出发',storyTime:'1年1月1日'});
    reply={timeline:[{name:'旅途',summary:'踏上旅程',entries:[{event:'出发',refId:node.id}]}],milestones:[{id:node.id,event:'启程',summary:'离开村庄'}]};
    const {ops}=await summary.generateJointSummary(ctx.chatId,{target:'both'});
    assert.equal((await store.getTimeline(ctx.chatId)).length,0);
    const result=await summary.applyJointSummary(ctx.chatId,ops,'both');assert.equal(result.applied.length,2);
    await curator.undoLastCuration(ctx.chatId);assert.equal((await store.getTimeline(ctx.chatId)).length,0);assert.equal((await store.getMilestones(ctx.chatId))[0].event,'出发');ctx.chatId='v948';
});
await test('本地结算不调API、不写长期库；旧auto配置和直接晋升也被拒绝',async()=>{
    const detail=await store.addRealtimeMemory(ctx.chatId,{text:'乘公交抵达',kind:'transport',createdFloor:1,lastSeenFloor:1,sceneKey:'A',settleState:'active'});
    const schedule=await store.addRealtimeMemory(ctx.chatId,{text:'上午，训练',kind:'schedule',dayLabel:'第一天',settleState:'active'});
    store.updateSettings({realtimePromotionMode:'auto'});
    const before=[await store.getNpcProfiles(ctx.chatId),await store.getItems(ctx.chatId),await store.getMilestones(ctx.chatId),await store.getMemories(ctx.chatId)];
    const callsBefore=calls;
    const promote=await rt.applySettleDecisions(ctx.chatId,[{id:detail.id,action:'promote',pillar:'mem',fields:{content:'不应写入'}}]);assert.equal(promote.ok,false);
    const report=await rt.settleRealtimeMemories(ctx.chatId,{manual:true,currentFloor:2});assert.equal(report.ok,true);assert.equal(calls,callsBefore);
    assert.deepEqual([await store.getNpcProfiles(ctx.chatId),await store.getItems(ctx.chatId),await store.getMilestones(ctx.chatId),await store.getMemories(ctx.chatId)],before);
    const entries=await store.getRealtimeMemories(ctx.chatId);assert.equal(entries.find(e=>e.id===detail.id).settleState,'settled');assert.equal(entries.find(e=>e.id===schedule.id).settleState,'active');
    await rt.undoLastSettlement(ctx.chatId);assert.equal((await store.getRealtimeMemories(ctx.chatId)).find(e=>e.id===detail.id).settleState,'active');
});
await test('注入仅保留有效临时细节；TTL边界、场景切换、pending、历史晋升过滤，日程独立',async()=>{
    ctx.chat=Array(13).fill({});
    const base={kind:'detail',settleState:'active',createdFloor:0,lastSeenFloor:0,sceneKey:'A'};
    const entries=[{...base,id:'ttl',text:'已到期'},{...base,id:'valid',text:'有效提醒',lastSeenFloor:1},{...base,id:'pending',text:'待结算不注入',settleState:'pending_settle',lastSeenFloor:12},{...base,id:'promoted',text:'历史晋升',promotedTo:{id:'old'},lastSeenFloor:12},{...base,id:'schedule',kind:'schedule',text:'上午，练剑',dayKey:'d1',dayLabel:'第一天'}];
    const result=retriever.getRealtimeForInjection(entries,{...store.getSettings(),realtimeSceneChangeSettle:false});
    const text=JSON.stringify(result);assert.ok(text.includes('有效提醒'));assert.ok(text.includes('练剑'));
    for(const excluded of ['已到期','待结算不注入','历史晋升'])assert.ok(!text.includes(excluded));
    const scene=retriever.getRealtimeForInjection([{...base,id:'a',text:'旧场景'},{...base,id:'b',text:'新场景',sceneKey:'B',lastSeenFloor:12}],store.getSettings());assert.ok(!JSON.stringify(scene).includes('旧场景'));
    ctx.chat=[];
});
await test('手动恢复从当前楼层重新计时，来源楼层不变',async()=>{
    ctx.chat=Array(30).fill({});
    const detail=await store.addRealtimeMemory(ctx.chatId,{kind:'detail',text:'恢复提醒',sourceFloor:1,lastSeenFloor:1,settleState:'settled'});
    await rt.reactivateRealtimeMemory(ctx.chatId,detail.id);
    const entry=(await store.getRealtimeMemories(ctx.chatId)).find(e=>e.id===detail.id);
    assert.equal(entry.sourceFloor,1);assert.equal(entry.lastSeenFloor,29);assert.equal(entry.settleState,'active');
    assert.ok(JSON.stringify(retriever.getRealtimeForInjection([entry],store.getSettings())).includes('恢复提醒'));ctx.chat=[];
});
await test('v9.4.8版本、设置导出绑定和统一悬浮入口',async()=>{
    assert.equal(JSON.parse(readFileSync(new URL('../manifest.json',import.meta.url))).version,'9.4.8');
    const index=readFileSync(new URL('../index.js',import.meta.url),'utf8');
    assert.ok(index.includes("'timelineSummaryTarget'"));assert.ok(index.includes("timelineSummaryTarget: ['#"));
    assert.ok(index.includes('<span>记忆整理</span>'));assert.equal(store.DEFAULT_SETTINGS.realtimePromotionMode,'disabled');
});
console.log(`v9.4.8: ${checks} regression groups passed (mock ST/API).`);

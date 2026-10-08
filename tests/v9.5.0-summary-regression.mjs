import assert from 'node:assert/strict';
const bank = new Map();
const lf = { async getItem(k) { return structuredClone(bank.get(k) ?? null); }, async setItem(k,v) { bank.set(k,structuredClone(v)); return v; }, async removeItem(k) { bank.delete(k); }, async keys() { return [...bank.keys()]; } };
const ctx = { chatId:'summary950', chat:[], chatMetadata:{}, extensionSettings:{}, libs:{localforage:lf}, saveSettingsDebounced(){}, saveMetadataDebounced(){} };
globalThis.SillyTavern = { getContext:()=>ctx }; globalThis.window = globalThis;
globalThis.toastr = { info(){}, warning(){}, success(){}, error(){} };
globalThis.fetch = async url => { assert.equal(url,'/api/users/me'); return { ok:true, json:async()=>({handle:'summary-test',created:1}) }; };
const store = await import('../memory-store.js');
const us = await import('../user-storage.js');
const summary = await import('../story-summary.js');
const plan = await import('../story-summary-plan.js');
const curator = await import('../memory-curator.js');
await us.initializeUserStorage();
store.updateSettings({autoBackupEnabled:false,embeddingEnabled:false,timelineSummaryTarget:'both',timelineSummaryScope:'all_with_milestones',timelineSummarySplitRetries:0,timelineSummaryParallel:4});
let checks = 0, mutate = null, inflight = 0, maxInflight = 0;
const received = [];
const sourceOf = prompt => JSON.parse(prompt.split('（当前片段）\n')[1].split('\n## 本次执行约束')[0]);
ctx.generateRaw = async ({prompt}) => {
    const source = sourceOf(prompt); received.push(source);
    inflight++; maxInflight = Math.max(maxInflight,inflight);
    try {
        await new Promise(resolve=>setTimeout(resolve,5));
        if (mutate) return mutate(source,prompt);
        const target = prompt.match(/允许修改：([^。]+)。/)[1];
        let timeline = target === '只修改里程碑' ? [] : source.timeline.map(t => ({id:t.id,summary:'总结 '+t.name,entries:t.entries.map((e,i)=>({period:e.period,event:e.event+' 已总结',sourceIndices:[i]}))}));
        if (!source.timeline.length && source.milestones.length && target !== '只修改里程碑' && prompt.includes('可依据本片段里程碑生成')) timeline = [{name:'里程碑故事',summary:'根据节点生成',entries:source.milestones.map(m=>({event:m.event,period:m.storyTime,refId:m.id}))}];
        return JSON.stringify({timeline,milestones:target === '只修改时间线' ? [] : source.milestones.map(m=>({id:m.id,event:m.event+' 已总结',summary:m.summary || '节点总结',storyTime:m.storyTime || ''}))});
    } finally { inflight--; }
};
async function test(name, fn) { await fn(); checks++; console.log('PASS '+name); }
const t1 = await store.upsertTimeline(ctx.chatId,{name:'北征',summary:'北征原文',entries:[{event:'招募',period:'123年1月1日10点'},{event:'出征',period:'123年1月5日12点'}]});
const t2 = await store.upsertTimeline(ctx.chatId,{name:'建城',summary:'建城原文',entries:[{event:'建城',period:'123年2月1日'}]});
const m1 = await store.addMilestone(ctx.chatId,{event:'北征转折',summary:'同盟',storyTime:'123年1月5日',timelineId:t1.id});
const m2 = await store.addMilestone(ctx.chatId,{event:'建城转折',summary:'奠基',timelineId:t2.id});
const other = await store.addMilestone(ctx.chatId,{event:'未知线节点',timelineId:'missing'});
const legacy = await store.addMilestone(ctx.chatId,{event:'旧版唯一关联'});
const ambiguous = await store.addMilestone(ctx.chatId,{event:'旧版两线关联'});
await store.upsertTimeline(ctx.chatId,{...t1,entries:[{...t1.entries[0],refId:legacy.id},{...t1.entries[1],refId:ambiguous.id}]});
await store.upsertTimeline(ctx.chatId,{...t2,entries:[{...t2.entries[0],refId:ambiguous.id}]});
const rows = await store.getTimeline(ctx.chatId), milestones = await store.getMilestones(ctx.chatId);
await test('标签优先、旧唯一引用兼容、无效与多线引用归其他',()=>{
    assert.equal(plan.milestoneTimelineId(m1,rows),t1.id);
    assert.equal(plan.milestoneTimelineId(legacy,rows),t1.id);
    assert.equal(plan.milestoneTimelineId(other,rows),'');
    assert.equal(plan.milestoneTimelineId(ambiguous,rows),'');
    assert.equal(plan.milestoneTimelineId({...legacy,timelineId:t2.id},rows),t2.id);
    const groups = plan.buildSummaryGroups(rows,milestones);
    assert.equal(groups.length,3);
    assert.deepEqual(groups.at(-1).milestoneIds,[other.id,ambiguous.id]);
});
await test('单线失效/已归档及非法范围立即拒绝',()=>{
    assert.throws(()=>summary.selectSummarySources(rows,milestones,{scope:'selected_linked',timelineId:'missing'}),/有效/);
    assert.throws(()=>summary.selectSummarySources(rows.map(t=>({...t,archived:true})),milestones,{scope:'selected_all',timelineId:t1.id}),/有效/);
    assert.throws(()=>summary.selectSummarySources(rows,milestones,{scope:'bad'}),/无效/);
    assert.throws(()=>summary.selectSummarySources(rows,milestones,{ids:['missing']}),/不存在/);
});
const expected = {
    selected_linked:{timeline:[t1.id],milestone:[m1.id,legacy.id]},
    selected_all:{timeline:[t1.id],milestone:milestones.map(m=>m.id)},
    all_threads:{timeline:[t1.id,t2.id],milestone:[]},
    all_with_milestones:{timeline:[t1.id,t2.id],milestone:milestones.map(m=>m.id)},
};
await test('四资料范围严格限定获准ID，逐线调用且生成只存草稿',async()=>{
    const beforeT = await store.getTimeline(ctx.chatId), beforeM = await store.getMilestones(ctx.chatId);
    for (const [scope,allowed] of Object.entries(expected)) {
        received.length = 0; maxInflight = 0;
        const draft = await summary.generateJointSummary(ctx.chatId,{scope,timelineId:t1.id});
        assert.deepEqual(draft.failures,[]);
        for (const pillar of ['timeline','milestone']) assert.deepEqual(new Set(draft.ops.filter(o=>o.pillar===pillar).map(o=>o.ids[0])),new Set(allowed[pillar]));
        assert.equal(maxInflight,1);
        assert.ok(received.every(source=>source.timeline.length<=1));
        if (scope === 'all_threads') assert.ok(received.every(source=>!source.milestones.length));
        assert.deepEqual(await store.getTimeline(ctx.chatId),beforeT);
        assert.deepEqual(await store.getMilestones(ctx.chatId),beforeM);
        assert.equal((await summary.getJointSummaryDraft(ctx.chatId)).scope,scope);
    }
});
await test('范围与允许修改冲突有明确错误',async()=>{
    await assert.rejects(()=>summary.generateJointSummary(ctx.chatId,{scope:'all_threads',target:'milestone'}),/不包含里程碑/);
});
await test('模型跨线ID被拒绝，原文及既有可用草稿不变',async()=>{
    const before = await summary.getJointSummaryDraft(ctx.chatId);
    mutate = source=>JSON.stringify({timeline:source.timeline.map(t=>({id:t.id,summary:'错误',entries:t.entries.map((e,i)=>({event:e.event,sourceIndices:[i]}))})),milestones:[{id:m2.id,event:'越界'}]});
    const draft = await summary.generateJointSummary(ctx.chatId,{scope:'selected_linked',timelineId:t1.id});
    assert.equal(draft.ops.length,0); assert.ok(draft.failures[0].error.includes('里程碑 ID'));
    assert.deepEqual(await summary.getJointSummaryDraft(ctx.chatId),before); mutate = null;
});
await test('事件顺序或覆盖不完整拒绝整条线',async()=>{
    mutate = source=>JSON.stringify({timeline:source.timeline.map(t=>({id:t.id,summary:'错误覆盖',entries:[{event:'漏失',sourceIndices:[1,0]}]})),milestones:[]});
    const draft = await summary.generateJointSummary(ctx.chatId,{scope:'selected_linked',timelineId:t1.id,target:'timeline'});
    assert.equal(draft.ops.length,0); assert.ok(draft.failures.some(f=>f.error.includes('顺序'))); mutate = null;
});
await test('失败片段不部分覆盖一条线，其他线建议仍可审核',async()=>{
    mutate = source=>source.timeline.some(t=>t.id===t1.id) ? '{"timeline":[' : JSON.stringify({timeline:source.timeline.map(t=>({id:t.id,summary:'建城总结',entries:t.entries.map((e,i)=>({event:e.event,sourceIndices:[i]}))})),milestones:[]});
    const draft = await summary.generateJointSummary(ctx.chatId,{scope:'all_threads'});
    assert.deepEqual(draft.ops.map(o=>o.ids[0]),[t2.id]); assert.ok(draft.failures.length); mutate = null;
});
await test('审核应用再次校验范围，采纳后可整批撤销',async()=>{
    const draft = await summary.generateJointSummary(ctx.chatId,{scope:'selected_linked',timelineId:t1.id});
    const beforeT = await store.getTimeline(ctx.chatId), beforeM = await store.getMilestones(ctx.chatId);
    await assert.rejects(()=>summary.applyJointSummary(ctx.chatId,[{...draft.ops[0],ids:[t2.id]}],draft.target,{allowed:draft.allowed}),/范围之外/);
    const applied = await summary.applyJointSummary(ctx.chatId,draft.ops,draft.target,{allowed:draft.allowed});
    assert.equal(applied.applied.length,3); assert.deepEqual(applied.failed,[]);
    assert.equal((await store.getTimeline(ctx.chatId)).find(t=>t.id===t1.id).entries[0].period,'123年1月1日');
    const undo = await curator.undoLastCuration(ctx.chatId); assert.equal(undo.ok,true);
    assert.deepEqual(await store.getTimeline(ctx.chatId),beforeT); assert.deepEqual(await store.getMilestones(ctx.chatId),beforeM);
});
await test('审核期间原条目改变时拒绝旧建议',async()=>{
    const draft = await summary.generateJointSummary(ctx.chatId,{scope:'selected_linked',timelineId:t1.id});
    await store.updateMilestone(ctx.chatId,m1.id,{event:'用户修改后事实'});
    const op = draft.ops.find(o=>o.pillar==='milestone' && o.ids[0]===m1.id);
    const applied = await summary.applyJointSummary(ctx.chatId,[op],draft.target,{allowed:draft.allowed});
    assert.equal(applied.applied.length,0); assert.ok(applied.failed[0].error.includes('修改'));
    assert.equal((await store.getMilestones(ctx.chatId)).find(m=>m.id===m1.id).event,'用户修改后事实');
});
await test('长线分片顺序回组，一片失败时不保留部分覆盖建议',async()=>{
    ctx.chatId = 'split-story';
    const t = await store.upsertTimeline(ctx.chatId,{name:'长线',summary:'原文',entries:[0,1,2].map(i=>({period:`银月历3年${i+1}月1日`,event:`阶段${i} `+'情节'.repeat(520)}))});
    store.updateSettings({timelineSummarySegmentChars:2000,timelineSummarySplitRetries:0});
    received.length = 0; maxInflight = 0;
    const draft = await summary.generateJointSummary(ctx.chatId,{scope:'all_threads'});
    assert.equal(draft.ops.length,1); assert.equal(draft.ops[0].result.entries.length,3);
    assert.equal(received.length,3); assert.ok(maxInflight>1);
    assert.deepEqual(draft.ops[0].result.entries.map(e=>e.period),t.entries.map(e=>e.period));
    mutate = source=>source.timeline[0].entries[0].event.startsWith('阶段1') ? '{"timeline":[' : JSON.stringify({timeline:source.timeline.map(t=>({id:t.id,summary:'有效片段',entries:t.entries.map((e,i)=>({event:e.event,period:e.period,sourceIndices:[i]}))})),milestones:[]});
    const failed = await summary.generateJointSummary(ctx.chatId,{scope:'all_threads'});
    assert.equal(failed.failures.length,1); assert.equal(failed.ops.length,0);
    assert.equal((await summary.getJointSummaryDraft(ctx.chatId)).ops[0].result.entries.length,3);
    assert.deepEqual((await store.getTimeline(ctx.chatId))[0],t); mutate = null;
});
await test('超大单条明确拒绝，不截断原文或覆盖可用草稿',async()=>{
    const before = await summary.getJointSummaryDraft(ctx.chatId);
    const giant = await store.upsertTimeline(ctx.chatId,{name:'超限',summary:'原文',entries:[{event:'情节'.repeat(2500)}]});
    await assert.rejects(()=>summary.generateJointSummary(ctx.chatId,{scope:'all_threads',ids:[giant.id]}),/单条原文/);
    assert.deepEqual(await summary.getJointSummaryDraft(ctx.chatId),before);
    store.updateSettings({timelineSummarySegmentChars:16000});
});
await test('同聊天总结不重复启动，切换聊天丢弃异步结果',async()=>{
    const first = summary.generateJointSummary(ctx.chatId,{scope:'all_threads'});
    await assert.rejects(()=>summary.generateJointSummary(ctx.chatId,{scope:'all_threads'}),/已有总结任务/);
    await first;
    mutate = ()=>{ctx.chatId='switched';return JSON.stringify({timeline:[],milestones:[]})};
    await assert.rejects(()=>summary.generateJointSummary('split-story',{scope:'all_threads'}),/聊天已切换/);
    mutate = null;
});
await test('无时间线时全里程碑仍可生成、采纳并撤销新线',async()=>{
    ctx.chatId = 'no-threads'; const m = await store.addMilestone(ctx.chatId,{event:'首次相遇',storyTime:'银月历3年冬'});
    const draft = await summary.generateJointSummary(ctx.chatId,{scope:'all_with_milestones'});
    assert.equal(draft.failures.length,0); assert.equal(draft.ops.length,2);
    assert.ok(draft.ops.some(o=>o.isNewTimeline));
    const applied = await summary.applyJointSummary(ctx.chatId,draft.ops,draft.target,{allowed:draft.allowed});
    assert.equal(applied.applied.length,2); assert.equal((await store.getTimeline(ctx.chatId)).length,1);
    assert.equal((await curator.undoLastCuration(ctx.chatId)).ok,true);
    assert.equal((await store.getTimeline(ctx.chatId)).length,0);
    assert.equal((await store.getMilestones(ctx.chatId))[0].event,m.event);
});
console.log(`${checks} summary regression groups passed`);

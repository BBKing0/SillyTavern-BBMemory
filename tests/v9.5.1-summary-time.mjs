import assert from 'node:assert/strict';
const bank = new Map();
let failTimelineWrite = false;
const lf = {
    async getItem(key) { return structuredClone(bank.get(key) ?? null); },
    async setItem(key, value) {
        if (failTimelineWrite && key.includes('bb_timeline_chat_timestamp951')) {
            failTimelineWrite = false; throw new Error('模拟时间线存储失败');
        }
        bank.set(key, structuredClone(value)); return value;
    },
    async removeItem(key) { bank.delete(key); },
    async keys() { return [...bank.keys()]; },
};
const ctx = { chatId:'timestamp951', chat:[], chatMetadata:{}, extensionSettings:{}, libs:{localforage:lf}, saveSettingsDebounced(){}, saveMetadataDebounced(){} };
globalThis.SillyTavern = { getContext:()=>ctx }; globalThis.window = globalThis;
globalThis.toastr = { info(){}, warning(){}, success(){}, error(){} };
globalThis.fetch = async url => { assert.equal(url,'/api/users/me'); return {ok:true,json:async()=>({handle:'summary-time',created:1})}; };
const store = await import('../memory-store.js');
const storage = await import('../user-storage.js');
const summary = await import('../story-summary.js');
const plan = await import('../story-summary-plan.js');
const curator = await import('../memory-curator.js');
const retriever = await import('../retriever.js');
await storage.initializeUserStorage();
store.updateSettings({autoBackupEnabled:false,embeddingEnabled:false,timelineSummaryTarget:'both',timelineSummaryScope:'all_with_milestones',timelineSummarySplitRetries:0});
const oldTime = 1700000000000;
let checks = 0, breakResponse = false;
const prompts = [];
ctx.generateRaw = async ({prompt}) => {
    prompts.push(prompt);
    assert.ok(!prompt.includes('lastSummarizedAt'));
    assert.ok(!prompt.includes(String(oldTime)));
    if (breakResponse) return '{"timeline":[';
    const source = JSON.parse(prompt.split('（当前片段）\n')[1].split('\n## 本次执行约束')[0]);
    const target = prompt.match(/允许修改：([^。]+)。/)[1];
    let timeline = target === '只修改里程碑' ? [] : source.timeline.map(t=>({id:t.id,summary:'归纳后的公园之行',lastSummarizedAt:1,entries:t.entries.map((e,i)=>({event:e.event+' 完成',sourceIndices:[i],period:e.period}))}));
    if (!source.timeline.length && target !== '只修改里程碑') timeline = [{name:'相遇',summary:'首次相遇',entries:source.milestones.map(m=>({event:m.event,refId:m.id}))}];
    return JSON.stringify({timeline,milestones:target === '只修改时间线' ? [] : source.milestones.map(m=>({id:m.id,event:m.event+' 完成'}))});
};
async function test(name, run) { await run(); checks++; console.log('PASS '+name); }
await test('旧数据与无效时间显示未总结，不能从修改时间推断',async()=>{
    await storage.getUserLocalForage().setItem('bb_timeline_chat_legacy951',[
        {id:'legacy',name:'旧线',summary:'旧摘要',entries:[],createdAt:oldTime,updatedAt:oldTime},
        {id:'invalid',name:'无效线',entries:[],lastSummarizedAt:'invalid'},
    ]);
    assert.deepEqual((await store.getTimeline('legacy951')).map(t=>t.lastSummarizedAt),[null,null]);
});
const line = await store.upsertTimeline(ctx.chatId,{name:'公园之行',summary:'见面后游玩',tags:['旅行'],entries:[{event:'约定见面',period:'银月历3年1月1日10点'},{event:'公园游玩',period:'银月历3年1月2日'}]});
assert.equal(line.lastSummarizedAt,null);
assert.equal(line.tags[0].name,'旅行');
await store.upsertTimeline(ctx.chatId,{id:line.id,lastSummarizedAt:oldTime});
const node = await store.addMilestone(ctx.chatId,{event:'第一次约会',timelineId:line.id});
const readLine = async () => (await store.getTimeline('timestamp951')).find(t=>t.id===line.id);
await test('生成和保存草稿不改变时间，取消采纳不落库',async()=>{
    const before = await readLine();
    const draft = await summary.generateJointSummary(ctx.chatId,{scope:'all_threads'});
    assert.equal(draft.ops.length,1);
    assert.ok(!('lastSummarizedAt' in draft.ops[0].result));
    assert.ok(!('lastSummarizedAt' in (await summary.getJointSummaryDraft(ctx.chatId)).ops[0].result));
    assert.deepEqual(await readLine(),before);
    const signal = AbortSignal.abort();
    await assert.rejects(()=>summary.applyJointSummary(ctx.chatId,draft.ops,draft.target,{allowed:draft.allowed,signal}),/停止/);
    assert.deepEqual(await readLine(),before);
});
await test('输出失败、原文冲突和存储失败不刷新上次总结时间',async()=>{
    breakResponse = true;
    const failed = await summary.generateJointSummary(ctx.chatId,{scope:'all_threads'});
    assert.equal(failed.ops.length,0); assert.ok(failed.failures.length); breakResponse = false;
    assert.equal((await readLine()).lastSummarizedAt,oldTime);
    const stale = await summary.generateJointSummary(ctx.chatId,{scope:'all_threads'});
    await store.upsertTimeline(ctx.chatId,{id:line.id,name:'用户修改了名称'});
    const refused = await summary.applyJointSummary(ctx.chatId,stale.ops,stale.target,{allowed:stale.allowed});
    assert.equal(refused.applied.length,0); assert.equal(refused.failed.length,1);
    assert.equal((await readLine()).lastSummarizedAt,oldTime);
    const fresh = await summary.generateJointSummary(ctx.chatId,{scope:'all_threads'});
    failTimelineWrite = true;
    const storageFailed = await summary.applyJointSummary(ctx.chatId,fresh.ops,fresh.target,{allowed:fresh.allowed});
    assert.equal(storageFailed.applied.length,0); assert.equal(storageFailed.failed.length,1);
    assert.equal((await readLine()).lastSummarizedAt,oldTime);
});
await test('采纳记录真实现实时间，手动编辑保留，撤销恢复原时间',async()=>{
    const draft = await summary.generateJointSummary(ctx.chatId,{scope:'all_threads'});
    const before = await readLine(), startedAt = Date.now();
    const accepted = await summary.applyJointSummary(ctx.chatId,draft.ops,draft.target,{allowed:draft.allowed});
    assert.equal(accepted.applied.length,1);
    const saved = await readLine();
    assert.ok(saved.lastSummarizedAt >= startedAt && saved.lastSummarizedAt <= Date.now());
    assert.equal(saved.entries[0].period,'银月历3年1月1日');
    await store.upsertTimeline(ctx.chatId,{id:line.id,priority:'high'});
    assert.equal((await readLine()).lastSummarizedAt,saved.lastSummarizedAt);
    const undo = await curator.undoLastCuration(ctx.chatId); assert.equal(undo.ok,true);
    assert.deepEqual(await readLine(),before);
});
await test('仅采纳里程碑总结不改变时间线的总结时间',async()=>{
    const before = await readLine();
    const draft = await summary.generateJointSummary(ctx.chatId,{scope:'all_with_milestones',target:'milestone'});
    const accepted = await summary.applyJointSummary(ctx.chatId,draft.ops,draft.target,{allowed:draft.allowed});
    assert.equal(accepted.applied.length,1);
    assert.deepEqual(await readLine(),before);
    assert.equal((await curator.undoLastCuration(ctx.chatId)).ok,true);
});
await test('时间戳不进入角色上下文、总结原文或整理提示词',async()=>{
    const timeline = await store.getTimeline(ctx.chatId);
    assert.ok(!JSON.stringify(plan.summarySources(timeline,[node])).includes('lastSummarizedAt'));
    const section = retriever.getTimelineForInjection(timeline);
    const injected = await retriever.buildMemoryInjectionPrompt({timeline:section,settings:store.getSettings()});
    assert.ok(section.text.includes('公园')); assert.ok(injected.text.includes('公园'));
    for (const text of [section.text,injected.text,curator.formatGroupsForPrompt([{pillar:'timeline',entries:timeline}]),...prompts]) {
        assert.ok(!text.includes('lastSummarizedAt')); assert.ok(!text.includes(String(oldTime)));
    }
});
await test('导出、服务器备份和导入保留时间；重复导入取最新有效时间',async()=>{
    const exported = JSON.parse(await store.exportMemories(ctx.chatId));
    assert.equal(exported.version,'9.5.1');
    assert.equal(exported.data.timeline[0].lastSummarizedAt,oldTime);
    await store.exportMemoriesToChatMetadata(ctx.chatId);
    const backup = JSON.parse(ctx.chatMetadata.bb_memory_v5_backup);
    assert.equal(backup.data.timeline[0].lastSummarizedAt,oldTime);
    await store.importMemories('restored951',JSON.stringify(exported));
    assert.equal((await store.getTimeline('restored951'))[0].lastSummarizedAt,oldTime);
    exported.data.timeline[0].lastSummarizedAt = oldTime+1000;
    await store.importMemories('restored951',JSON.stringify(exported));
    assert.equal((await store.getTimeline('restored951'))[0].lastSummarizedAt,oldTime+1000);
    delete exported.data.timeline[0].lastSummarizedAt;
    await store.importMemories('restored951',JSON.stringify(exported));
    assert.equal((await store.getTimeline('restored951'))[0].lastSummarizedAt,oldTime+1000);
});
await test('从里程碑新生成时间线仅采纳时记时间，撤销移除新线',async()=>{
    ctx.chatId='new-time951'; await store.addMilestone(ctx.chatId,{event:'首次相遇'});
    const draft = await summary.generateJointSummary(ctx.chatId,{scope:'all_with_milestones'});
    assert.equal((await store.getTimeline(ctx.chatId)).length,0);
    const start = Date.now();
    const accepted = await summary.applyJointSummary(ctx.chatId,draft.ops,draft.target,{allowed:draft.allowed});
    assert.equal(accepted.failed.length,0);
    const newLine = (await store.getTimeline(ctx.chatId))[0];
    assert.ok(newLine.lastSummarizedAt >= start && newLine.lastSummarizedAt <= Date.now());
    assert.equal((await curator.undoLastCuration(ctx.chatId)).ok,true);
    assert.equal((await store.getTimeline(ctx.chatId)).length,0);
});
await test('清库移除时间线整理草稿',async()=>{
    const keys = ['bb_timeline_organization_draft_chat_'+ctx.chatId,'bb_timeline_organization_draft_chat_'+ctx.chatId+'_tags','bb_timeline_organization_draft_chat_'+ctx.chatId+'_merge','bb_timeline_organization_draft_latest_chat_'+ctx.chatId];
    for (const key of keys) await storage.getUserLocalForage().setItem(key,{ops:[{}]});
    await store.clearAllData(ctx.chatId);
    for (const key of keys) assert.equal(await storage.getUserLocalForage().getItem(key),null);
});
console.log(checks+' summary timestamp groups passed');

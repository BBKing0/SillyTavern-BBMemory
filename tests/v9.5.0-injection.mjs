import assert from 'node:assert/strict';
const bank = new Map();
const lf = {
    async getItem(k) { return structuredClone(bank.get(k) ?? null); },
    async setItem(k, v) { bank.set(k, structuredClone(v)); return v; },
    async removeItem(k) { bank.delete(k); },
    async keys() { return [...bank.keys()]; },
};
const ctx = { chatId: 'v950', chat: [], chatMetadata: {}, extensionSettings: {}, libs: { localforage: lf }, saveSettingsDebounced() {} };
globalThis.SillyTavern = { getContext: () => ctx };
globalThis.fetch = async url => { assert.equal(url, '/api/users/me'); return { ok: true, json: async () => ({ handle: 'v950', created: 1 }) }; };
const store = await import('../memory-store.js');
const retriever = await import('../retriever.js');
await (await import('../user-storage.js')).initializeUserStorage();
store.updateSettings({ tokenBudget: 10000, tokenBudgetMode: 'resident_unlimited', floorRecentWindow: 6 });
const base = { id: 'daily', title: '晚安吻', content: 'FULL_ONLY_DETAIL', summary: 'SUMMARY_ONLY', verbatim: 'DIALOGUE_ONLY', memoryTier: 'core', sourceFloor: 2, tags: [{ name: '日常' }], createdAt: Date.now(), embedding: [1, 0] };
assert.deepEqual(retriever.getResidentMemories([base]), []);
assert.equal(retriever.chooseInjectionLevel(base, 1, true), 'L2');
assert.equal(retriever.chooseInjectionLevel(base, 0, false, 0.96), 'L3');
const ordinary = { ...base, tags: [], memoryTier: 'stable' };
assert.ok(retriever.calculateMemoryScore(base, '晚安吻').total < retriever.calculateMemoryScore({ ...base, tags: [{ name: '晚安吻' }] }, '晚安吻').total);
for (const queryEmbedding of [null, [0, 1]]) {
    const result = await retriever.buildMemoryInjectionPrompt({ relevantResults: [{ memory: base, score: 1, level: 'L4' }], settings: store.getSettings(), chatLength: 3, queryEmbedding });
    assert.ok(result.text.includes('SUMMARY_ONLY'));
    assert.ok(!result.text.includes('FULL_ONLY_DETAIL'));
    assert.ok(!result.text.includes('DIALOGUE_ONLY'));
}
const full = await retriever.buildMemoryInjectionPrompt({ relevantResults: [{ memory: base, score: 0.2, level: 'L2' }], settings: store.getSettings(), chatLength: 3, queryEmbedding: [1, 0] });
assert.ok(full.text.includes('FULL_ONLY_DETAIL'));
assert.ok(full.text.includes('DIALOGUE_ONLY'));
const dailyTransient = await retriever.buildMemoryInjectionPrompt({ relevantResults: [{ memory: { ...base, memoryTier: 'transient' }, score: 0.2, level: 'L2' }], settings: store.getSettings(), chatLength: 3, queryEmbedding: [1, 0] });
assert.ok(dailyTransient.text.includes('FULL_ONLY_DETAIL'));
const npc = await store.addNpcProfile('v950', { name: '骑士', storyTime: '第二纪元2年' });
const item = await store.addItem('v950', { name: '剑', storyTime: '第二纪元3年' });
assert.equal(npc.storyTime, '第二纪元2年'); assert.equal(item.storyTime, '第二纪元3年');
const tl = await store.upsertTimeline('v950', { name: '北征' });
await store.importMemories('v950', JSON.stringify({ version: '9.5.0', schema: 'bb-memory-vector-ref-v1', data: { milestones: [{ id: 'import-node', event: '出征', timelineId: 'external-timeline' }], timeline: [{ id: 'external-timeline', name: '北征', entries: [] }] } }));
assert.equal((await store.getMilestones('v950'))[0].timelineId, tl.id);
const exported = JSON.parse(await store.exportMemories('v950'));
assert.equal(exported.version, '9.5.0');
assert.equal(exported.data.milestones[0].timelineId, tl.id);
const curator = await import('../memory-curator.js');
const second = await store.upsertTimeline('v950', { name: '南征', entries: [{ event: '南征开始' }] });
const linked = await store.addMilestone('v950', { event: '南征节点', timelineId: second.id });
const beforeTimeline = await store.getTimeline('v950');
const merge = curator.parseCurationOps(JSON.stringify({ ops: [{ op: 'merge', pillar: 'timeline', ids: [tl.id, second.id], keepId: tl.id, result: { name: '征途', summary: '南北征途', entries: [{ event: '合并征途' }] } }] }), { entries: { timeline: beforeTimeline } });
assert.equal(merge.rejected.length, 0);
const applied = await curator.applyCurationOps('v950', merge.ops, { forceAuth: 'auto' });
assert.equal(applied.failed.length, 0);
assert.equal((await store.getMilestones('v950')).find(m => m.id === linked.id).timelineId, tl.id);
await curator.undoLastCuration('v950');
assert.equal((await store.getMilestones('v950')).find(m => m.id === linked.id).timelineId, second.id);
const legacyNode = await store.addMilestone('v950', { event: '未分线节点' });
const legacyOp = curator.parseCurationOps(JSON.stringify({ ops: [{ op: 'rewrite', pillar: 'milestone', ids: [legacyNode.id], result: { event: '旧草稿可更新' } }] }), { entries: { milestone: [legacyNode] } }).ops[0];
delete legacyOp.sourceEntries[0].timelineId;
assert.equal((await curator.applyCurationOps('v950', [legacyOp], { forceAuth: 'auto' })).failed.length, 0);
console.log('PASS v9.5.0 daily summary/full-vector boundary, entity times, milestone import label remapping');

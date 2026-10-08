import assert from 'node:assert/strict';

const bank = new Map();
const lf = {
    async getItem(key) { return structuredClone(bank.get(key) ?? null); },
    async setItem(key, value) { bank.set(key, structuredClone(value)); return value; },
    async removeItem(key) { bank.delete(key); },
    async keys() { return [...bank.keys()]; },
    async iterate(fn) { for (const [key, value] of bank) { const result = fn(structuredClone(value), key); if (result !== undefined) return result; } },
};
const ctx = { chatId: 'extract', characterId: 0, characters: [{ name: 'player', avatar: 'player.png' }],
    chat: [], chatMetadata: {}, extensionSettings: {}, libs: { localforage: lf },
    saveSettingsDebounced() {}, saveMetadataDebounced() {}, saveChatDebounced() {} };
globalThis.SillyTavern = { getContext: () => ctx };
globalThis.window = globalThis;
globalThis.toastr = { info() {}, warning() {}, success() {}, error() {} };
globalThis.bbMemoryShowToast = () => {};
globalThis.fetch = async url => {
    assert.equal(url, '/api/users/me');
    return { ok: true, json: async () => ({ handle: 'extraction-test', created: 1 }) };
};
const storage = await import('../user-storage.js');
await storage.initializeUserStorage();
const store = await import('../memory-store.js');
const contextApi = await import('../extraction-context.js');
const updates = await import('../extraction-updates.js');
const generator = await import('../auto-generator.js');
const curator = await import('../memory-curator.js');
store.updateSettings({ autoBackupEnabled: false, embeddingEnabled: false, autoGenMode: 'main',
    extractionUpdateConfirm: false, extractionRecentMemoryCount: 5 });
let checks = 0;
async function test(name, fn) { await fn(); console.log('PASS ' + name); checks++; }

const npc = await store.addNpcProfile('extract', { name: 'Lin', role: 'investigator', personality: 'cautious', status: 'alive',
    relationships: [{ name: 'player', type: 'ally', attitude: 'neutral' }] });
const hiddenNpc = await store.addNpcProfile('extract', { name: 'Never injected', role: 'merchant' });
const item = await store.addItem('extract', { name: 'key', owner: 'player', status: 'held', keepPermanent: true });
const memories = [];
for (let index = 0; index < 7; index++) memories.push(await store.addMemory('extract', {
    title: 'fact ' + index, content: 'fact content ' + index, createdAt: 1000 + index, storyTime: 'day ' + index,
}));
const user = { is_user: true, mes: 'I give the key to Lin.' };
const ai = { is_user: false, mes: 'Lin keeps the key.', swipe_id: 0 };
ctx.chat = [user, ai];
contextApi.captureInjectionContext('extract', user, { npc: [npc], items: [item], memories: [memories[0]] });
contextApi.bindInjectionContextToResponse('extract', ai, user);
let extractionContext;
await test('Context has actual injected IDs plus five recent memories only', async () => {
    extractionContext = await contextApi.buildExtractionContext('extract', { sourceFloor: 1 });
    assert.deepEqual(extractionContext.injectedIds.npc, [npc.id]);
    assert.ok(!extractionContext.entries.npc.some(entry => entry.id === hiddenNpc.id));
    assert.equal(extractionContext.recentMemoryIds.length, 5);
    assert.equal(extractionContext.entries.mem.length, 6);
    assert.ok(extractionContext.entries.item.some(entry => entry.id === item.id));
    assert.ok(!contextApi.formatExtractionContext(extractionContext).includes('embeddingRef'));
});
await test('Reroll preserves each response swipe injection record', async () => {
    contextApi.captureInjectionContext('extract', user, { npc: [hiddenNpc] }, { generationType: 'swipe' });
    ai.swipe_id = 1; ai.mes = 'A different reply.';
    contextApi.bindInjectionContextToResponse('extract', ai, user);
    const second = await contextApi.buildExtractionContext('extract', { sourceFloor: 1 });
    assert.deepEqual(second.injectedIds.npc, [hiddenNpc.id]);
    ai.swipe_id = 0; ai.mes = 'Lin keeps the key.';
    const first = await contextApi.buildExtractionContext('extract', { sourceFloor: 1 });
    assert.deepEqual(first.injectedIds.npc, [npc.id]);
});
await test('Edited user text invalidates stale injection IDs', async () => {
    const before = user.mes; user.mes = 'Edited user request.';
    const context = await contextApi.buildExtractionContext('extract', { sourceFloor: 1 });
    assert.equal(context.entries.npc.length, 0); user.mes = before;
});
await test('Automatic extraction switch does not stop per-response injection tracking', async () => {
    const listeners = new Map();
    ctx.eventTypes = { MESSAGE_RECEIVED: 'received', MESSAGE_SENT: 'sent' };
    ctx.eventSource = {
        on(event, fn) { if (!listeners.has(event)) listeners.set(event, new Set()); listeners.get(event).add(fn); },
        removeListener(event, fn) { listeners.get(event)?.delete(fn); },
    };
    contextApi.initInjectionContextTracking();
    generator.initAutoGenerator(); generator.stopAutoGenerator();
    assert.equal(listeners.get('received').size, 1);
    assert.equal(listeners.get('sent').size, 0);
    store.updateSettings({ autoGenEnabled: false });
    contextApi.captureInjectionContext('extract', user, { npc: [npc] });
    for (const listener of listeners.get('received')) listener(1);
    assert.ok(ai.extra.bbMemoryInjectionBySwipe['0']);
    contextApi.stopInjectionContextTracking();
    assert.equal(listeners.get('received').size, 0);
});
await test('Unknown old swipe cannot borrow latest user injection snapshot', async () => {
    const unknownAi = { is_user: false, mes: 'Old untracked reply.', swipe_id: 0, swipes: ['Old untracked reply.', 'Latest reply.'] };
    ctx.chat = [user, unknownAi];
    contextApi.captureInjectionContext('extract', user, { npc: [hiddenNpc] });
    const unknown = await contextApi.buildExtractionContext('extract', { sourceFloor: 1 });
    assert.equal(unknown.injectedIds.npc.length, 0);
    ctx.chat = [user, ai];
});
await test('Consecutive AI replies sharing a user retain both injection contexts', async () => {
    const ai2 = { is_user: false, mes: 'Second group member replies.', swipe_id: 0 };
    ctx.chat = [user, ai, ai2];
    contextApi.captureInjectionContext('extract', user, { npc: [npc] });
    contextApi.bindInjectionContextToResponse('extract', ai, user);
    contextApi.captureInjectionContext('extract', user, { npc: [hiddenNpc] });
    contextApi.bindInjectionContextToResponse('extract', ai2, user);
    const group = await contextApi.buildExtractionContext('extract', { sourceFloors: [1, 2] });
    assert.deepEqual(new Set(group.injectedIds.npc), new Set([npc.id, hiddenNpc.id]));
    ctx.chat = [user, ai];
    contextApi.captureInjectionContext('extract', user, { npc: [npc], items: [item], memories: [memories[0]] });
    contextApi.bindInjectionContextToResponse('extract', ai, user);
});

const raw = (pillar, id, result, extra = {}) => ({ op: 'update', pillar, ids: [id], result, reason: 'The current conversation explicitly changes this fact.', ...extra });
await test('Unknown or non-injected IDs and missing reasons cannot be written', async () => {
    let parsed = await updates.parseExtractionUpdates([raw('npc', hiddenNpc.id, { role: 'king' }, { changeKind: 'identity' })], extractionContext);
    assert.equal(parsed.ops.length, 0); assert.ok(parsed.rejected.length);
    parsed = await updates.parseExtractionUpdates([{ ...raw('item', item.id, { owner: 'Lin' }), reason: '' }], extractionContext);
    assert.equal(parsed.ops.length, 0);
});
await test('Permanent item can change owner/status/quantity and cannot be deleted', async () => {
    const parsed = await updates.parseExtractionUpdates([raw('item', item.id, { name: 'key', owner: 'Lin', status: 'held', quantity: 1 })], extractionContext);
    assert.equal(parsed.ops.length, 1);
    assert.equal(parsed.ops[0].result.quantity, 1);
    assert.equal((await updates.applyExtractionUpdates('extract', parsed.ops)).failed.length, 0);
    assert.equal((await store.getItems('extract')).find(entry => entry.id === item.id).owner, 'Lin');
    const current = await contextApi.buildExtractionContext('extract', { sourceFloor: 1 });
    const deleted = await updates.parseExtractionUpdates([{ op: 'delete', pillar: 'item', ids: [item.id], reason: 'used' }], current);
    assert.equal(deleted.ops.length, 0);
    await curator.undoLastCuration('extract');
    assert.equal((await store.getItems('extract')).find(entry => entry.id === item.id).owner, 'player');
});
await test('NPC actions and locations do not update profiles; attitudes and persistent status do', async () => {
    const action = await updates.parseExtractionUpdates([raw('npc', npc.id, { status: 'eating', location: 'kitchen' }, { changeKind: 'action' })], extractionContext);
    assert.equal(action.ops.length, 0);
    const disguised = await updates.parseExtractionUpdates([raw('npc', npc.id, { status: 'walking', location: 'street' }, { changeKind: 'identity' })], extractionContext);
    assert.equal(disguised.ops.length, 0);
    const attitude = await updates.parseExtractionUpdates([raw('npc', npc.id, { relationships: [{ name: 'player', type: 'ally', attitude: 'trusting' }] }, { changeKind: 'attitude' })], extractionContext);
    assert.equal(attitude.ops.length, 1);
    const status = await updates.parseExtractionUpdates([raw('npc', npc.id, { status: 'dead' }, { changeKind: 'persistent_status' })], extractionContext);
    assert.equal(status.ops.length, 1);
});
await test('Daily and eternal memories reject update/merge/delete', async () => {
    const daily = await store.addMemory('extract', { title: 'goodnight', content: 'A repeated kiss.', tags: [{ name: '\u65e5\u5e38', weight: 0.6 }] });
    const eternal = await store.addMemory('extract', { title: 'oath', content: 'A permanent oath.', memoryTier: 'eternal' });
    contextApi.captureInjectionContext('extract', user, { memories: [daily, eternal, memories[0]] });
    contextApi.bindInjectionContextToResponse('extract', ai, user);
    const context = await contextApi.buildExtractionContext('extract', { sourceFloor: 1 });
    for (const target of [daily, eternal]) {
        for (const op of [raw('mem', target.id, { content: 'Replaced' }),
            { op: 'delete', pillar: 'mem', ids: [target.id], reason: 'cleanup' },
            { op: 'merge', pillar: 'mem', ids: [target.id, memories[0].id], keepId: target.id, result: { content: 'Merged' }, reason: 'same' }]) {
            const parsed = await updates.parseExtractionUpdates([op], context);
            assert.equal(parsed.ops.length, 0); assert.ok(parsed.rejected.length);
        }
    }
    contextApi.captureInjectionContext('extract', user, { npc: [npc], items: [item], memories: [memories[0]] });
    contextApi.bindInjectionContextToResponse('extract', ai, user);
});
await test('AI cannot modify system fields; only writable fields survive', async () => {
    const parsed = await updates.parseExtractionUpdates([raw('mem', memories[0].id, {
        title: 'updated title', content: 'updated content', id: 'hijack', hitScore: 999, memoryTier: 'eternal', sourceChatId: 'another',
    })], extractionContext);
    assert.equal(parsed.ops.length, 1);
    for (const field of ['id', 'hitScore', 'memoryTier', 'sourceChatId']) assert.ok(!(field in parsed.ops[0].result));
});
await test('Concurrent manual changes and chat switching reject stale AI writes', async () => {
    const parsed = await updates.parseExtractionUpdates([raw('mem', memories[0].id, { content: 'AI changed content' })], extractionContext);
    await store.updateMemory('extract', memories[0].id, { content: 'User changed content' });
    await assert.rejects(() => updates.applyExtractionUpdates('extract', parsed.ops), /编辑|修改/);
    await store.updateMemory('extract', memories[0].id, { content: memories[0].content });
    ctx.chatId = 'another';
    await assert.rejects(() => updates.applyExtractionUpdates('extract', parsed.ops), /聊天已切换/);
    await assert.rejects(() => contextApi.buildExtractionContext('extract', { sourceFloor: 1 }), /聊天已切换/);
    ctx.chatId = 'extract';
});
await test('Same entity with high vector score is skipped without merging; independent names remain separate', async () => {
    const before = await store.getNpcProfiles('extract');
    const same = await generator.saveEntityWithDedup('extract', 'npc', { name: 'Lin', personality: 'cooking', embedding: [1, 0] });
    assert.equal(same.action, 'skipped'); assert.deepEqual(await store.getNpcProfiles('extract'), before);
    const another = await generator.saveEntityWithDedup('extract', 'npc', { name: 'Distinct Lin', role: 'another investigator', embedding: [1, 0] });
    assert.equal(another.action, 'created');
});
await test('Saving new candidates cannot update timeline by matching name or memory by similarity', async () => {
    const timeline = await store.upsertTimeline('extract', { name: 'investigation', summary: 'original', entries: [] });
    const result = await generator.saveExtractedCandidates('extract', [
        { pillar: 'timeline', payload: { name: 'investigation', summary: 'unreviewed summary' } },
        { pillar: 'memory', payload: { title: 'fact 0', content: 'different event with similar words', storyTime: 'another day', embedding: [1, 0] } },
    ]);
    assert.equal(result.skipped, 1); assert.equal(result.memories, 1); assert.equal(result.merged, 0);
    assert.equal((await store.getTimeline('extract')).find(entry => entry.id === timeline.id).summary, 'original');
});
await test('Manual extraction sends injected entries and recent memories, then applies explicit ops', async () => {
    let prompt = '';
    ctx.generateRaw = async body => {
        prompt = body.prompt;
        return JSON.stringify({ memories: [{ n: 'new fact', c: 'A new independent fact.', st: 'day 9', g: ['test'] }],
            npc: [], items: [], milestones: [], locations: [], timeline: [],
            ops: [raw('item', item.id, { name: 'key', owner: 'Lin', status: 'held', quantity: 1 })] });
    };
    const result = await generator.extractFromContext('extract', user.mes + '\n' + ai.mes, { floors: [1] });
    assert.ok(!result.failed, result.error);
    assert.equal(result.memories, 1); assert.equal(result.appliedUpdates, 1);
    assert.ok(prompt.includes(item.id)); assert.ok(prompt.includes('recentMemoryIds')); assert.ok(prompt.includes('changeKind'));
    assert.equal((await store.getItems('extract')).find(entry => entry.id === item.id).owner, 'Lin');
});
await test('Parallel extraction calls preserve both independent new entries', async () => {
    let sequence = 0, inflight = 0, maximum = 0;
    ctx.generateRaw = async () => {
        const current = ++sequence; inflight++; maximum = Math.max(maximum, inflight);
        await new Promise(resolve => setTimeout(resolve, 15)); inflight--;
        return JSON.stringify({ memories: [{ n: 'parallel ' + current, c: 'Parallel independent event ' + current, st: 'day ' + current }], ops: [] });
    };
    const results = await Promise.all([
        generator.extractFromContext('extract', user.mes + ai.mes, { floors: [1] }),
        generator.extractFromContext('extract', user.mes + ai.mes, { floors: [1] }),
    ]);
    assert.equal(maximum, 2); assert.ok(results.every(result => !result.failed));
    const saved = await store.getMemories('extract');
    assert.equal(saved.filter(entry => entry.title.startsWith('parallel ')).length, 2);
});
await test('Disabling confirmation applies valid short rewrites without opening review', async () => {
    await store.updateMemory('extract', memories[0].id, { content: 'A very long existing fact. '.repeat(20) });
    const context = await contextApi.buildExtractionContext('extract', { sourceFloor: 1 });
    const parsed = await updates.parseExtractionUpdates([raw('mem', memories[0].id, { content: 'A short fact.' })], context);
    assert.equal(parsed.ops[0].forceConfirm, true);
    globalThis.document = { getElementById() { throw new Error('review must stay closed'); } };
    const result = await updates.processExtractionUpdates('extract', [raw('mem', memories[0].id, { content: 'A short fact.' })], context);
    assert.equal(result.applied, 1); assert.equal(result.pending, 0);
    delete globalThis.document;
});
await test('Existing review overlay preserves queued draft and exposes resumable review result', async () => {
    store.updateSettings({ extractionUpdateConfirm: true });
    globalThis.document = { getElementById() { return {}; } };
    const context = await contextApi.buildExtractionContext('extract', { sourceFloor: 1 });
    const before = await store.getItems('extract');
    const result = await updates.processExtractionUpdates('extract', [raw('item', item.id, { owner: 'player' })], context);
    assert.equal(result.pending, 1);
    const resumed = await updates.reviewPendingExtractionUpdates('extract');
    assert.equal(resumed.pending, 1); assert.ok(resumed.summary.includes('待审核'));
    assert.equal((await updates.listPendingExtractionUpdates('extract')).length, 1);
    assert.deepEqual(await store.getItems('extract'), before);
    await storage.getUserLocalForage().removeItem('bb_extraction_update_drafts_chat_extract');
    assert.equal((await updates.reviewPendingExtractionUpdates('extract')).summary, '暂无待审核变更');
    store.updateSettings({ extractionUpdateConfirm: false }); delete globalThis.document;
});
await test('Existing map location descriptions and reverse edges are never overwritten by extraction', async () => {
    const map = await import('../map-store.js');
    const location = await map.addLocation('extract', { name: 'station', description: 'User original station', edges: [] });
    contextApi.captureInjectionContext('extract', user, { locations: [location] });
    contextApi.bindInjectionContextToResponse('extract', ai, user);
    const context = await contextApi.buildExtractionContext('extract', { sourceFloor: 1 });
    assert.equal(context.entries.location[0].id, location.id);
    const before = await map.getLocations('extract');
    const result = await generator.saveExtractedCandidates('extract', [
        { pillar: 'location', payload: { name: 'station', description: 'AI overwrite', edges: [] } },
        { pillar: 'location', payload: { name: 'new alley', description: 'new place', edges: [{ toName: 'station', distance: 'near' }] } },
    ]);
    assert.equal(result.locations, 1);
    const after = await map.getLocations('extract');
    assert.deepEqual(after.find(entry => entry.id === location.id), before.find(entry => entry.id === location.id));
    assert.equal(after.find(entry => entry.name === 'new alley').edges[0].toId, location.id);
});
console.log(`Extraction regression passed: ${checks} checks`);

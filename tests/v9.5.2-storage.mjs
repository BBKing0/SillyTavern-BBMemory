import assert from 'node:assert/strict';

const bank = new Map();
const localforage = {
    async getItem(key) { return structuredClone(bank.get(key) ?? null); },
    async setItem(key, value) { bank.set(key, structuredClone(value)); return value; },
    async removeItem(key) { bank.delete(key); },
    async keys() { return [...bank.keys()]; },
};
const ctx = {
    chatId: 'storage952', chat: [], chatMetadata: {}, extensionSettings: {}, libs: { localforage },
    saveSettingsDebounced() {}, saveMetadataDebounced() {},
};
globalThis.SillyTavern = { getContext: () => ctx };
globalThis.window = globalThis;
globalThis.toastr = { success() {}, warning() {}, info() {}, error() {} };
globalThis.fetch = async url => {
    assert.equal(url, '/api/users/me');
    return { ok: true, json: async () => ({ handle: 'storage952', created: 1 }) };
};

const store = await import('../memory-store.js');
const storage = await import('../user-storage.js');
const slots = await import('../memory-slots.js');
await storage.initializeUserStorage();
store.updateSettings({ autoBackupEnabled: false, embeddingEnabled: false });

let checks = 0;
async function test(name, run) { await run(); checks++; console.log('PASS ' + name); }
const values = ['always', 'summary', 'matched'];
const getPriorities = async chatId => (await store.getMemories(chatId)).map(memory => memory.eternalInjectionPriority);

await test('旧设置自动补充默认值，新增设置限制枚举和数值边界', async () => {
    assert.equal(store.getSettings().eternalInjectionMode, 'matched');
    assert.equal(store.getSettings().eternalUnmatchedMode, 'none');
    assert.equal(store.getSettings().eternalMatchThreshold, 0.62);
    assert.equal(store.getSettings().realtimeInjectionDepth, 2);
    store.updateSettings({ eternalInjectionMode: 'invalid', eternalUnmatchedMode: 'invalid', eternalMatchThreshold: 2, realtimeInjectionDepth: 150 });
    assert.equal(store.getSettings().eternalInjectionMode, 'matched');
    assert.equal(store.getSettings().eternalUnmatchedMode, 'none');
    assert.equal(store.getSettings().eternalMatchThreshold, 1);
    assert.equal(store.getSettings().realtimeInjectionDepth, 100);
    store.updateSettings({ eternalInjectionMode: 'priority', eternalUnmatchedMode: 'summary', eternalMatchThreshold: -1, realtimeInjectionDepth: 0 });
    assert.equal(store.getSettings().eternalInjectionMode, 'priority');
    assert.equal(store.getSettings().eternalUnmatchedMode, 'summary');
    assert.equal(store.getSettings().eternalMatchThreshold, 0);
    assert.equal(store.getSettings().realtimeInjectionDepth, 1);
    store.updateSettings({ eternalMatchThreshold: 'bad', realtimeInjectionDepth: 'bad' });
    assert.equal(store.getSettings().eternalMatchThreshold, 0.62);
    assert.equal(store.getSettings().realtimeInjectionDepth, 2);
    for (const empty of [null, undefined, '', '  ']) {
        store.updateSettings({ eternalMatchThreshold: empty, realtimeInjectionDepth: empty });
        assert.equal(store.getSettings().eternalMatchThreshold, 0.62);
        assert.equal(store.getSettings().realtimeInjectionDepth, 2);
        // getSettings 也覆盖旧配置/外部设置直接赋值的读取路径。
        const settings = ctx.extensionSettings.bb_memory;
        settings.eternalMatchThreshold = empty;
        settings.realtimeInjectionDepth = empty;
        assert.equal(store.getSettings().eternalMatchThreshold, 0.62);
        assert.equal(store.getSettings().realtimeInjectionDepth, 2);
    }
});

await test('新建和修改保留逐条优先级，缺省或非法值规范化为仅命中', async () => {
    for (const value of values) {
        const memory = await store.addMemory(ctx.chatId, { title: value, content: '独立的永恒记忆 ' + value, memoryTier: 'eternal', eternalInjectionPriority: value });
        assert.equal(memory.eternalInjectionPriority, value);
        const updated = await store.updateMemory(ctx.chatId, memory.id, { summary: '摘要 ' + value });
        assert.equal(updated.eternalInjectionPriority, value);
    }
    const implicit = await store.addMemory('defaults952', { title: '未设置', memoryTier: 'eternal' });
    assert.equal(implicit.eternalInjectionPriority, 'matched');
    const explicit = await store.updateMemory('defaults952', implicit.id, { eternalInjectionPriority: 'always' });
    assert.equal(explicit.eternalInjectionPriority, 'always');
    const invalid = await store.updateMemory('defaults952', implicit.id, { eternalInjectionPriority: 'invalid' });
    assert.equal(invalid.eternalInjectionPriority, 'matched');
    assert.equal((await store.addMemory('defaults952', { title: '非法新建', eternalInjectionPriority: 'invalid' })).eternalInjectionPriority, 'matched');
});

let exported;
await test('JSON 导出导入往返全部优先级，重复导入保留当前用户选择', async () => {
    exported = JSON.parse(await store.exportMemories(ctx.chatId));
    assert.equal(exported.version, '9.5.2');
    assert.deepEqual(exported.data.memories.map(memory => memory.eternalInjectionPriority), values);
    await store.importMemories('json952', JSON.stringify(exported));
    assert.deepEqual(await getPriorities('json952'), values);
    const duplicate = structuredClone(exported);
    duplicate.data.memories.forEach(memory => { memory.eternalInjectionPriority = 'always'; });
    await store.importMemories('json952', JSON.stringify(duplicate));
    assert.deepEqual(await getPriorities('json952'), values);
    duplicate.data.memories.forEach(memory => { delete memory.eternalInjectionPriority; });
    await store.importMemories('json952', JSON.stringify(duplicate));
    assert.deepEqual(await getPriorities('json952'), values);
});

await test('旧资料未选优先级时接受导入选择，旧版和非法导入使用默认值', async () => {
    await storage.getUserLocalForage().setItem('bb_mem_chat_legacy952', [{ id: 'legacy', title: '旧记忆', content: '旧内容', memoryTier: 'eternal' }]);
    await store.importMemories('legacy952', JSON.stringify({ memories: [{ id: 'legacy', title: '旧记忆', content: '旧内容', memoryTier: 'eternal', eternalInjectionPriority: 'summary' }] }));
    assert.deepEqual(await getPriorities('legacy952'), ['summary']);
    await store.importMemories('old-import952', JSON.stringify({ memories: [
        { title: '未选', content: '第一条', memoryTier: 'eternal' },
        { title: '非法', content: '第二条', memoryTier: 'eternal', eternalInjectionPriority: 'invalid' },
    ] }));
    assert.deepEqual(await getPriorities('old-import952'), ['matched', 'matched']);
});

await test('聊天服务器备份恢复保留全部优先级', async () => {
    const backupResult = await store.exportMemoriesToChatMetadata(ctx.chatId);
    assert.equal(backupResult.skipped, false);
    const backup = JSON.parse(ctx.chatMetadata.bb_memory_v5_backup);
    assert.equal(backup.version, '9.5.2');
    assert.deepEqual(backup.data.memories.map(memory => memory.eternalInjectionPriority), values);
    const restored = await store.importMemoriesFromChatMetadata('metadata952');
    assert.equal(restored.restored, 3);
    assert.deepEqual(await getPriorities('metadata952'), values);
});

await test('本地存档槽在正常加载及重建 ID 时均保留逐条优先级', async () => {
    const saved = await slots.saveToSlot('character952', ctx.chatId, 'priority952', { syncCloud: false, bindChat: false });
    assert.deepEqual(saved.data.memories.map(memory => memory.eternalInjectionPriority), values);
    await slots.loadFromSlot('character952', 'slot952', 'priority952', { bindChat: false });
    assert.deepEqual(await getPriorities('slot952'), values);
    const beforeIds = (await store.getMemories('slot952')).map(memory => memory.id);
    await slots.loadFromSlot('character952', 'slot952', 'priority952', { bindChat: false });
    assert.deepEqual(await getPriorities('slot952'), values);
    assert.ok((await store.getMemories('slot952')).every(memory => !beforeIds.includes(memory.id)));
});

console.log(`v9.5.2 storage: ${checks} checks passed`);

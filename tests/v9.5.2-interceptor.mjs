import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
function functionSource(name) {
    const start = new RegExp(`^(?:async )?function ${name}\\(`, 'm').exec(source)?.index;
    assert.ok(start !== undefined, name);
    const end = source.indexOf('\n}', start);
    return source.slice(start, end + 2);
}
function constSource(name) {
    const start = source.indexOf(`const ${name} = `), end = source.indexOf(';\n', start);
    assert.ok(start >= 0 && end > start, name);
    return source.slice(start, end + 1);
}
const start = source.indexOf('globalThis.bbMemoryInterceptor = async function');
const end = source.indexOf('\n};', start) + 3;
const bank = new Map(), prompts = new Map();
const lf = {
    async getItem(key) { return structuredClone(bank.get(key) ?? null); },
    async setItem(key, value) { bank.set(key, structuredClone(value)); return value; },
    async removeItem(key) { bank.delete(key); },
    async keys() { return [...bank.keys()]; },
};
const ctx = { chatId: 'injection952', chat: [{ is_user: true, mes: '月台' }], chatMetadata: {}, extensionSettings: {}, libs: { localforage: lf }, saveSettingsDebounced() {}, saveChatDebounced() {}, setExtensionPrompt(key, text, position, depth) { prompts.set(key, { text, position, depth }); } };
globalThis.SillyTavern = { getContext: () => ctx };
globalThis.fetch = async url => { assert.equal(url, '/api/users/me'); return { ok: true, json: async () => ({ handle: 'injection952', created: 1 }) }; };
const store = await import('../memory-store.js');
const retrieval = await import('../retriever.js');
const extraction = await import('../extraction-context.js');
await (await import('../user-storage.js')).initializeUserStorage();
store.updateSettings({ enabled: true, migratedFromV4: true, autoBackupEnabled: false, embeddingEnabled: false, realtimeEnabled: false, timelineSummaryEnabled: false, tokenBudget: 10000, tokenBudgetMode: 'resident_unlimited', maxResults: 3 });
const match = await store.addMemory(ctx.chatId, { title: '月台', content: 'MATCHED_FULL', summary: 'MATCHED_SUMMARY', memoryTier: 'eternal', sourceFloor: 0 });
const unrelated = [];
for (let i = 0; i < 51; i++) unrelated.push(await store.addMemory(ctx.chatId, { title: `旧事${i}`, content: `UNRELATED_DETAIL_${i}`, summary: `UNRELATED_SUMMARY_${i}`, memoryTier: 'eternal', sourceFloor: 0 }));
let actual, frame = [], onHydrate = null;
const sandbox = {
    ...store, ...retrieval, console, SillyTavern: globalThis.SillyTavern,
    getCharacterWorldRealWorldRef: () => '', getClueBoard: async () => ({ nodes: [] }), getMap: async () => ({ locations: {} }),
    setPluginHiddenState: () => false, hydrateCollectionEmbeddings: async () => { if (onHydrate) { const callback = onHydrate; onHydrate = null; callback(); } }, hydrateMapEmbeddings: async () => {}, autoMaintainSilent: async () => {},
    buildMemoryInjectionPrompt: async options => { actual = await retrieval.buildMemoryInjectionPrompt(options); return actual; },
    buildHitFrameKey: () => 'frame952', isMetaDialogueHitFrame: () => false,
    recordInjectionHitFrame: async (_id, _message, _key, records) => { frame = records; },
    captureInjectionContext: extraction.captureInjectionContext,
    updateSidebarHitList() {}, showToast() {}, setTimeout() {}, getPendingAutoCandidates: () => [], clearPendingAutoCandidates() {}, showFloatingReviewPanel() {},
};
vm.createContext(sandbox);
vm.runInContext([
    ...['INJECTION_KEY', 'REALTIME_INJECTION_KEY', 'POSITION_IN_CHAT', 'ROLE_SYSTEM', 'MAX_IN_CHAT_DEPTH'].map(constSource),
    'let lastRetrievalResult = null;',
    ...['getLongTermInjectionDepth', 'getRealtimeInjectionDepth', 'mergeResidentMemoryResults', 'clearInjection', 'clearGenerationInjection', 'renderEternalInjectionNote'].map(functionSource),
    source.slice(start, end),
].join('\n'), sandbox);
const run = async (type = 'normal') => { await sandbox.bbMemoryInterceptor(structuredClone(ctx.chat), 8192, null, type); return vm.runInContext('lastRetrievalResult', sandbox); };
let checks = 0;
async function test(name, fn) { await fn(); checks++; console.log('PASS ' + name); }
await test('52条永恒默认仅注入真实命中，追踪和提取上下文对应实际ID', async () => {
    const result = await run();
    assert.deepEqual(actual.stats.memoryIds, [match.id]);
    assert.equal(result.eternalInjectedCount, 1); assert.equal(result.eternalFullCount, 1); assert.equal(result.eternalSummaryCount, 0);
    assert.equal(frame.length, 1); assert.equal(frame[0].id, match.id);
    assert.deepEqual(ctx.chat[0].extra.bbMemoryInjectionContext.entriesByPillar.mem, [match.id]);
    assert.ok(prompts.get('bb_memory_injection').text.includes('MATCHED_FULL'));
    assert.ok(!actual.text.includes('UNRELATED_'));
    assert.ok(sandbox.renderEternalInjectionNote(result).includes('全文 1 / 摘要 0'));
});
await test('未命中摘要受条数限制，近期来源和重roll不扩成全文', async () => {
    store.updateSettings({ eternalUnmatchedMode: 'summary' });
    for (const type of ['normal', 'swipe']) {
        const result = await run(type);
        assert.equal(result.eternalInjectedCount, 3); assert.equal(result.eternalFullCount, 1); assert.equal(result.eternalSummaryCount, 2);
        assert.ok(actual.text.includes('MATCHED_FULL')); assert.ok(actual.text.includes('UNRELATED_SUMMARY_'));
        assert.ok(!actual.text.includes('UNRELATED_DETAIL_'));
        assert.equal(frame.length, 1); assert.equal(frame[0].id, match.id);
    }
});
await test('全部全文恢复全部52条，严格预算仍可裁剪且统计真实', async () => {
    store.updateSettings({ eternalInjectionMode: 'all' });
    let result = await run();
    assert.equal(result.eternalInjectedCount, 52); assert.equal(result.eternalSummaryCount, 0);
    assert.equal(actual.stats.memoryIds.length, 52); assert.ok(actual.text.includes('UNRELATED_DETAIL_50'));
    store.updateSettings({ tokenBudgetMode: 'strict_total', tokenBudget: 1 });
    result = await run();
    assert.equal(result.eternalInjectedCount, 0); assert.equal(frame.length, 0);
    assert.equal(prompts.get('bb_memory_injection').text, '');
    assert.ok(Object.values(ctx.chat[0].extra.bbMemoryInjectionContext.entriesByPillar).every(ids => ids.length === 0));
});
await test('异步等待期间改策略只在下轮生效，本轮层级与命中统计一致', async () => {
    store.updateSettings({ eternalInjectionMode: 'matched', eternalUnmatchedMode: 'summary', tokenBudgetMode: 'resident_unlimited', tokenBudget: 10000 });
    onHydrate = () => store.updateSettings({ eternalInjectionMode: 'all' });
    let result = await run();
    assert.equal(result.eternalInjectionMode, 'matched'); assert.equal(result.eternalFullCount, 1); assert.equal(result.eternalSummaryCount, 2);
    assert.ok(!actual.text.includes('UNRELATED_DETAIL_')); assert.equal(frame.length, 1);
    assert.deepEqual(actual.stats.memoryInjections.filter(entry => entry.level === 'L2').map(entry => entry.matched), [false, false]);
    onHydrate = () => store.updateSettings({ eternalInjectionMode: 'matched', eternalUnmatchedMode: 'none' });
    result = await run();
    assert.equal(result.eternalInjectionMode, 'all'); assert.equal(result.eternalFullCount, 52); assert.equal(result.eternalSummaryCount, 0);
});
await test('逐条优先级区分常驻全文、未命中摘要和仅命中，并保留核心常驻', async () => {
    store.updateSettings({ eternalInjectionMode: 'priority', tokenBudgetMode: 'resident_unlimited', tokenBudget: 10000 });
    await store.updateMemory(ctx.chatId, unrelated[0].id, { eternalInjectionPriority: 'always' });
    await store.updateMemory(ctx.chatId, unrelated[1].id, { eternalInjectionPriority: 'summary' });
    const core = await store.addMemory(ctx.chatId, { title: '基本设定', content: 'CORE_DETAIL', memoryTier: 'core' });
    const result = await run();
    assert.equal(result.eternalInjectedCount, 3); assert.equal(result.eternalFullCount, 2); assert.equal(result.eternalSummaryCount, 1);
    assert.ok(actual.text.includes('UNRELATED_DETAIL_0')); assert.ok(actual.text.includes('UNRELATED_SUMMARY_1'));
    assert.ok(!actual.text.includes('UNRELATED_DETAIL_1')); assert.ok(!actual.text.includes('UNRELATED_SUMMARY_2'));
    assert.ok(actual.stats.memoryIds.includes(core.id)); assert.equal(actual.stats.memoryCount, 4);
});
await test('只有未命中永恒时清空上轮提示与命中上下文', async () => {
    ctx.chatId = 'unmatched-only952';
    await store.addMemory(ctx.chatId, { title: '旧设定', content: '无关往事', memoryTier: 'eternal' });
    store.updateSettings({ eternalInjectionMode: 'matched', eternalUnmatchedMode: 'none' });
    const result = await run();
    assert.equal(result.hits.length, 0); assert.equal(frame.length, 0);
    assert.equal(prompts.get('bb_memory_injection').text, '');
    assert.ok(Object.values(ctx.chat[0].extra.bbMemoryInjectionContext.entriesByPillar).every(ids => ids.length === 0));
});
console.log(`${checks} actual eternal interceptor regression groups passed`);

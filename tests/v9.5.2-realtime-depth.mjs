import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const index = readFileSync(new URL('../index.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
function functionSource(name) {
    const start = new RegExp(`^(?:async )?function ${name}\\(`, 'm').exec(index)?.index;
    assert.ok(start !== undefined, `Missing actual function ${name}`);
    const end = index.indexOf('\n}', start);
    assert.ok(end > start, name);
    return index.slice(start, end + 2);
}
function constSource(name) {
    const start = index.indexOf(`const ${name} = `);
    const end = index.indexOf(';\n', start);
    assert.ok(start >= 0 && end > start, name);
    return index.slice(start, end + 1);
}
const interceptorStart = index.indexOf('globalThis.bbMemoryInterceptor = async function');
const interceptorEnd = index.indexOf('\n};', interceptorStart) + 3;
assert.ok(interceptorStart >= 0 && interceptorEnd > interceptorStart);

let settings = { enabled: true, migratedFromV4: true, realtimeEnabled: true, maxResults: 10 };
let realtimeText = '实时细节：她仍穿着红色外套';
const prompts = new Map();
const ctx = {
    chatId: 'realtime-depth-952', chat: [], extensionSettings: {},
    setExtensionPrompt(key, text, position, depth, scan, role) {
        prompts.set(key, { text, position, depth, scan, role });
    },
};
globalThis.SillyTavern = { getContext: () => ctx };
// Use real exported retrieval helpers, so the extracted production interceptor can
// use the same helpers as the extension while persistence and AI work stay stubbed.
const retriever = await import('../retriever.js');
const sandbox = {
    ...retriever, console, Number, SillyTavern: globalThis.SillyTavern,
    getSettings: () => settings, getCharacterWorldRealWorldRef: () => '',
    getNpcProfiles: async () => [], getItems: async () => [], getMilestones: async () => [],
    getMemories: async () => [], getTimeline: async () => [], getClueBoard: async () => ({ nodes: [] }),
    getMap: async () => ({ locations: {} }), getRealtimeMemories: async () => [{ id: 'detail' }],
    setPluginHiddenState: () => false, migrateV4ToV5: async () => {},
    hydrateCollectionEmbeddings: async () => {}, hydrateMapEmbeddings: async () => {},
    autoMaintainSilent: async () => {}, getNpcForInjection: () => [], getItemsForInjection: () => [],
    getMilestonesForInjection: () => ({ foreshadow: [], ongoing: [], ended: [] }),
    getTimelineForInjection: () => ({ text: '', timeline: [] }),
    buildMemoryInjectionPrompt: async () => ({
        text: '', realtimeText: settings.realtimeEnabled === false ? '' : realtimeText,
        tokenEstimate: 20, tokenBudget: 300, truncated: [],
        stats: { npcIds: [], itemIds: [], milestoneIds: [], timelineIds: [], memoryIds: [], mapLocationIds: [] },
    }),
    buildHitFrameKey: () => 'depth-test', isMetaDialogueHitFrame: () => false,
    recordInjectionHitFrame: async () => {}, captureInjectionContext: () => {},
    updateSidebarHitList: () => {}, showToast: () => {}, setTimeout: () => {},
    getPendingAutoCandidates: () => [], clearPendingAutoCandidates: () => {}, showFloatingReviewPanel: () => {},
};
vm.createContext(sandbox);
vm.runInContext([
    ...['INJECTION_KEY', 'REALTIME_INJECTION_KEY', 'POSITION_IN_CHAT', 'ROLE_SYSTEM', 'MAX_IN_CHAT_DEPTH'].map(constSource),
    'let lastRetrievalResult = null;',
    ...['getLongTermInjectionDepth', 'getRealtimeInjectionDepth', 'mergeResidentMemoryResults', 'clearInjection', 'clearGenerationInjection'].map(functionSource),
    index.slice(interceptorStart, interceptorEnd),
].join('\n'), sandbox);

// Verified native ST contract: openai.js populationInjectionPrompts() reverses
// history after splice(depth + totalInsertedMessages); script.js doChatInject()
// uses the same direction and clamps to the available history length.
// Sources: https://github.com/SillyTavern/SillyTavern/blob/release/public/scripts/openai.js
//          https://github.com/SillyTavern/SillyTavern/blob/release/public/script.js
function nativeInChatOrder(history, depth) {
    const reversed = history.map(message => message.mes).reverse();
    reversed.splice(depth, 0, 'REALTIME');
    return reversed.reverse();
}
const user = mes => ({ is_user: true, mes });
const assistant = mes => ({ is_user: false, mes });
let checks = 0;
async function test(name, fn) {
    await fn();
    checks++;
    console.log('PASS ' + name);
}
await test('默认深度 1，越界、无效及小数设置规范化', () => {
    for (const [value, expected] of [[undefined, 1], [null, 1], ['', 1], ['bad', 1], [Infinity, 1], [1, 1], [0, 1], [-3, 1], ['7', 7], [3.9, 3], [101, 100]]) {
        assert.equal(sandbox.getRealtimeInjectionDepth({ realtimeInjectionDepth: value }), expected, String(value));
    }
    assert.equal(sandbox.getRealtimeInjectionDepth(undefined), 1);
});
await test('真实拦截器 normal / swipe / regenerate / continue / impersonate 使用独立 system depth 1', async () => {
    for (const type of ['normal', 'swipe', 'regenerate', 'continue', 'impersonate']) {
        ctx.chat = [user('旧输入'), assistant('旧回复'), user('当前输入')];
        if (type !== 'normal') ctx.chat.push(assistant('待重写或续写回复'));
        if (type === 'regenerate') ctx.chat.pop();
        const coreChat = structuredClone(ctx.chat);
        if (type === 'swipe') coreChat.pop();
        await sandbox.bbMemoryInterceptor(coreChat, 8192, null, type);
        const prompt = prompts.get('bb_memory_realtime_injection');
        assert.equal(prompt.depth, 1, type);
        assert.equal(prompt.position, 1); assert.equal(prompt.scan, false); assert.equal(prompt.role, 0);
        assert.match(prompt.text, /^<BBMemory>\n实时细节：/);
    }
});
await test('预设尾部后置处理，不参与 in-chat 深度计数', () => {
    const history = [assistant('上一条回复'), user('当前输入')];
    assert.deepEqual([...nativeInChatOrder(history, 1), '预设尾部'], ['上一条回复', 'REALTIME', '当前输入', '预设尾部']);
    assert.deepEqual([...nativeInChatOrder(history, 2), '预设尾部'], ['REALTIME', '上一条回复', '当前输入', '预设尾部']);
    const ordinary = [user('旧输入'), assistant('旧回复'), user('当前输入')];
    assert.deepEqual(nativeInChatOrder(ordinary, 1), ['旧输入', '旧回复', 'REALTIME', '当前输入']);
    assert.deepEqual(nativeInChatOrder(ordinary, 2), ['旧输入', 'REALTIME', '旧回复', '当前输入']);
});
await test('短历史保留默认深度并由 ST 插到最新用户之前', async () => {
    for (const history of [[user('当前输入')], [assistant('开场白'), user('当前输入')]]) {
        ctx.chat = history;
        await sandbox.bbMemoryInterceptor(structuredClone(history), 8192, null, 'normal');
        const prompt = prompts.get('bb_memory_realtime_injection');
        assert.equal(prompt.depth, 1);
        const order = nativeInChatOrder(history, prompt.depth);
        assert.equal(order.at(-2), 'REALTIME');
        assert.equal(order.at(-1), '当前输入');
    }
});
await test('自定义深度生效，关闭或没有细节会清空旧注入', async () => {
    ctx.chat = [user('当前输入')];
    settings = { ...settings, realtimeInjectionDepth: 7 };
    await sandbox.bbMemoryInterceptor(structuredClone(ctx.chat), 8192, null, 'normal');
    assert.equal(prompts.get('bb_memory_realtime_injection').depth, 7);
    realtimeText = '';
    await sandbox.bbMemoryInterceptor(structuredClone(ctx.chat), 8192, null, 'normal');
    assert.equal(prompts.get('bb_memory_realtime_injection').text, '');
    realtimeText = '新实时细节'; settings.realtimeEnabled = false;
    await sandbox.bbMemoryInterceptor(structuredClone(ctx.chat), 8192, null, 'normal');
    assert.equal(prompts.get('bb_memory_realtime_injection').text, '');
    settings.enabled = false;
    await sandbox.bbMemoryInterceptor(structuredClone(ctx.chat), 8192, null, 'normal');
    assert.equal(prompts.get('bb_memory_realtime_injection').text, '');
});
await test('无用户输入清空提示，quiet 保持既有跳过行为', async () => {
    settings.enabled = true; settings.realtimeEnabled = true;
    ctx.chat = [user('当前输入')];
    await sandbox.bbMemoryInterceptor(structuredClone(ctx.chat), 8192, null, 'normal');
    const beforeQuiet = prompts.get('bb_memory_realtime_injection');
    await sandbox.bbMemoryInterceptor(structuredClone(ctx.chat), 8192, null, 'quiet');
    assert.equal(prompts.get('bb_memory_realtime_injection'), beforeQuiet);
    ctx.chat = [assistant('开场白')];
    await sandbox.bbMemoryInterceptor(structuredClone(ctx.chat), 8192, null, 'normal');
    assert.equal(prompts.get('bb_memory_realtime_injection').text, '');
});
console.log(`${checks} realtime injection depth regression groups passed`);

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
    const start = index.indexOf(`const ${name} = `), end = index.indexOf(';\n', start);
    assert.ok(start >= 0 && end > start, name);
    return index.slice(start, end + 1);
}
const interceptorStart = index.indexOf('globalThis.bbMemoryInterceptor = async function');
const interceptorEnd = index.indexOf('\n};', interceptorStart) + 3;
assert.ok(interceptorStart >= 0 && interceptorEnd > interceptorStart);

const bank = new Map(), prompts = new Map();
const localforage = {
    async getItem(key) { return structuredClone(bank.get(key) ?? null); },
    async setItem(key, value) { bank.set(key, structuredClone(value)); return value; },
    async removeItem(key) { bank.delete(key); },
    async keys() { return [...bank.keys()]; },
};
let settingsSaves = 0, persistedSettings, domWrites = 0, loadData = true;
const ctx = {
    chatId: 'injection-order953', chat: [], chatMetadata: {}, extensionSettings: {}, libs: { localforage },
    saveSettingsDebounced() {
        settingsSaves++;
        persistedSettings = structuredClone(this.extensionSettings.bb_memory);
    },
    saveChatDebounced() {},
    setExtensionPrompt(key, text, position, depth, scan, role) { prompts.set(key, { key, text, position, depth, scan, role }); },
};
globalThis.SillyTavern = { getContext: () => ctx };
globalThis.fetch = async url => {
    assert.equal(url, '/api/users/me');
    return { ok: true, json: async () => ({ handle: 'injection-order953', created: 1 }) };
};
const store = await import('../memory-store.js');
const retrieval = await import('../retriever.js');
const extraction = await import('../extraction-context.js');
await (await import('../user-storage.js')).initializeUserStorage();

let actualBuild, actualQuery, retrievalQuery, captureUser;
const sandbox = {
    ...store, ...retrieval, console, SillyTavern: globalThis.SillyTavern,
    getCharacterWorldRealWorldRef: () => '',
    getMemories: async id => loadData ? store.getMemories(id) : [],
    getRealtimeMemories: async id => loadData ? store.getRealtimeMemories(id) : [],
    getClueBoard: async () => ({ nodes: [] }), getMap: async () => ({ locations: {} }),
    // Calling the old safety net with filtered/copy indices could affect another
    // original DOM floor. Treat any call as a regression, including hidden races.
    setPluginHiddenState() { domWrites++; throw new Error('Interceptor must not modify original message visibility or DOM'); },
    hydrateCollectionEmbeddings: async () => {}, hydrateMapEmbeddings: async () => {}, autoMaintainSilent: async () => {},
    getRelevantMemories(memories, query, options) {
        retrievalQuery = query;
        return retrieval.getRelevantMemories(memories, query, options);
    },
    async buildMemoryInjectionPrompt(options) {
        actualQuery = options.queryText;
        actualBuild = await retrieval.buildMemoryInjectionPrompt(options);
        return actualBuild;
    },
    buildHitFrameKey: () => 'order953', isMetaDialogueHitFrame: () => false,
    recordInjectionHitFrame: async () => {},
    captureInjectionContext(chatId, message, entries, options) {
        captureUser = message;
        return extraction.captureInjectionContext(chatId, message, entries, options);
    },
    updateSidebarHitList() {}, showToast() {}, setTimeout() {},
    getPendingAutoCandidates: () => [], clearPendingAutoCandidates() {}, showFloatingReviewPanel() {},
};
vm.createContext(sandbox);
vm.runInContext([
    ...['INJECTION_KEY', 'REALTIME_INJECTION_KEY', 'POSITION_IN_CHAT', 'ROLE_SYSTEM', 'MAX_IN_CHAT_DEPTH'].map(constSource),
    'let lastRetrievalResult = null;',
    ...['getLongTermInjectionDepth', 'getRealtimeInjectionDepth', 'mergeResidentMemoryResults', 'clearInjection', 'clearGenerationInjection'].map(functionSource),
    index.slice(interceptorStart, interceptorEnd),
].join('\n'), sandbox);

const user = mes => ({ name: 'User', is_user: true, is_system: false, mes });
const assistant = mes => ({ name: 'Character', is_user: false, is_system: false, mes });
const bodyAndIdentity = chat => chat.map(({ name, is_user, is_system, mes }) => ({ name, is_user, is_system, mes }));

// Native ST Chat Completion contract, including simultaneous extension prompts:
// script.js filters is_system before asynchronously copying coreChat, then pops
// the assistant for swipe; openai.js populationInjectionPrompts splices grouped
// system prompts into reversed history at depth + totalInsertedMessages.
// getExtensionPrompt sorts keys; overflow depths clamp to history length.
// Story String and post-history preset prompts are outside this history count.
// https://github.com/SillyTavern/SillyTavern/blob/release/public/script.js
// https://github.com/SillyTavern/SillyTavern/blob/release/public/scripts/openai.js
function nativeChatCompletionMessages(coreChat, { continuePrefill = false } = {}) {
    const reversed = coreChat.map(message => ({ role: message.is_user ? 'user' : 'assistant', content: message.mes })).reverse();
    // CC removes the message to continue before injection when prefill is enabled,
    // then appends it in its control messages after the history and preset prompts.
    const prefill = continuePrefill && reversed.length ? reversed.shift() : null;
    const historyLength = reversed.length;
    const active = [...prompts.values()].filter(prompt => prompt.text.trim() && prompt.position === 1).sort((a, b) => a.key.localeCompare(b.key));
    let totalInsertedMessages = 0;
    for (let depth = 0; depth <= historyLength; depth++) {
        const group = active.filter(prompt => Math.min(historyLength, prompt.depth) === depth);
        if (!group.length) continue;
        assert.ok(group.every(prompt => prompt.role === 0 && prompt.scan === false));
        reversed.splice(depth + totalInsertedMessages, 0, { role: 'system', content: group.map(prompt => prompt.text).join('\n') });
        totalInsertedMessages++;
    }
    return [{ role: 'system', content: 'STORY_STRING' }, ...reversed.reverse(), { role: 'system', content: 'PRESET_TAIL' }, ...(prefill ? [prefill] : [])];
}
function order(messages) {
    return messages.map(message => {
        const longTerm = message.content.includes('LONG_TERM_DETAIL');
        const realtime = message.content.includes('REALTIME_DETAIL');
        if (longTerm || realtime) {
            assert.equal(message.role, 'system');
            return longTerm && realtime ? 'LONG+REALTIME' : longTerm ? 'LONG' : 'REALTIME';
        }
        return message.content;
    });
}
async function run(type = 'normal', coreChat = structuredClone(ctx.chat.filter(message => !message.is_system))) {
    const rawRefs = [...ctx.chat], rawSnapshot = bodyAndIdentity(ctx.chat);
    const result = await sandbox.bbMemoryInterceptor(coreChat, 8192, null, type);
    assert.equal(result, coreChat, 'Interceptor returns the original generation array');
    assert.deepEqual(bodyAndIdentity(ctx.chat), rawSnapshot, 'Original chat body and roles are unchanged');
    rawRefs.forEach((message, i) => assert.equal(ctx.chat[i], message, 'Original chat message object is retained'));
    assert.equal(domWrites, 0, 'No original DOM visibility operation');
    return coreChat;
}

let checks = 0;
async function test(name, fn) { await fn(); checks++; console.log('PASS ' + name); }

await test('旧深度仅升级一次并持久化，新安装及自定义值保持正确', () => {
    for (const [previous, expected] of [[undefined, 1], [2, 1], ['2', 1], [1, 1], [7, 7], [100, 100]]) {
        delete ctx.extensionSettings.bb_memory;
        if (previous !== undefined) ctx.extensionSettings.bb_memory = { realtimeInjectionDepth: previous };
        const savesBefore = settingsSaves;
        assert.equal(store.getSettings().realtimeInjectionDepth, expected);
        assert.equal(store.getSettings().realtimeDepthV953, true);
        assert.equal(settingsSaves, savesBefore + 1, 'Upgrade persists exactly once');
        assert.equal(persistedSettings.realtimeInjectionDepth, expected);
        assert.equal(persistedSettings.realtimeDepthV953, true);
        ctx.extensionSettings.bb_memory = structuredClone(persistedSettings);
        assert.equal(store.getSettings().realtimeInjectionDepth, expected);
        assert.equal(settingsSaves, savesBefore + 1, 'Reloaded migrated settings do not save again');
        store.updateSettings({ realtimeInjectionDepth: 2 });
        const manualSaves = settingsSaves;
        assert.equal(store.getSettings().realtimeInjectionDepth, 2, 'Explicit depth 2 survives later reads');
        ctx.extensionSettings.bb_memory = structuredClone(persistedSettings);
        assert.equal(store.getSettings().realtimeInjectionDepth, 2, 'Explicit depth 2 survives reload');
        assert.equal(settingsSaves, manualSaves);
    }
    delete ctx.extensionSettings.bb_memory;
    store.updateSettings({ enabled: true, migratedFromV4: true, autoBackupEnabled: false, embeddingEnabled: false,
        realtimeEnabled: true, timelineSummaryEnabled: false, tokenBudget: 10000, tokenBudgetMode: 'resident_unlimited' });
});

const coreMemory = await store.addMemory(ctx.chatId, { title: '长期设定', content: 'LONG_TERM_DETAIL', indexCard: 'LONG_TERM_DETAIL', memoryTier: 'core' });
await store.addRealtimeMemory(ctx.chatId, { kind: 'detail', text: 'REALTIME_DETAIL', createdFloor: 2, lastSeenFloor: 2 });

await test('实际检索采用最新输入，长期及实时同时注入的最终顺序精确', async () => {
    ctx.chat = [user('旧用户输入'), assistant('旧AI回复'), user('最新用户输入')];
    const coreChat = structuredClone(ctx.chat), refs = [...coreChat], before = bodyAndIdentity(coreChat);
    await run('normal', coreChat);
    assert.equal(actualQuery, '最新用户输入');
    assert.equal(retrievalQuery, '最新用户输入');
    assert.equal(captureUser, ctx.chat[2], 'Tracking belongs to the latest original user message');
    assert.deepEqual(captureUser.extra.bbMemoryInjectionContext.entriesByPillar.mem, [coreMemory.id]);
    assert.deepEqual(bodyAndIdentity(coreChat), before);
    refs.forEach((message, i) => assert.equal(coreChat[i], message));
    assert.ok(actualBuild.text.includes('LONG_TERM_DETAIL'));
    assert.ok(actualBuild.realtimeText.includes('REALTIME_DETAIL'));
    assert.equal(prompts.get('bb_memory_injection').depth, 3);
    assert.equal(prompts.get('bb_memory_realtime_injection').depth, 1);
    assert.deepEqual(order(nativeChatCompletionMessages(coreChat)), ['STORY_STRING', 'LONG', '旧用户输入', '旧AI回复', 'REALTIME', '最新用户输入', 'PRESET_TAIL']);
});

await test('ST 原生过滤隐藏历史后，深度基于实际可发送的聊天', async () => {
    ctx.chat = [
        { ...user('已隐藏旧用户'), is_system: true, _bbmem_extracted: true },
        { ...assistant('已隐藏旧AI'), is_system: true, _bbmem_hideSource: 'plugin', _bbmem_autoHidden: true },
        user('可见旧用户'), assistant('可见旧AI'), user('最新用户输入'),
    ];
    const coreChat = await run();
    assert.deepEqual(coreChat.map(message => message.mes), ['可见旧用户', '可见旧AI', '最新用户输入']);
    assert.equal(prompts.get('bb_memory_injection').depth, 3);
    assert.equal(actualQuery, '最新用户输入');
    assert.deepEqual(order(nativeChatCompletionMessages(coreChat)), ['STORY_STRING', 'LONG', '可见旧用户', '可见旧AI', 'REALTIME', '最新用户输入', 'PRESET_TAIL']);
});

await test('异步文件映射期间提取完成，剪除带旧标记的副本且不改原聊天/DOM', async () => {
    ctx.chat = [user('已提取旧用户'), assistant('已提取旧AI'), user('最新用户输入')];
    // Matches ST timing: visibility filtering precedes await appendFileContent;
    // copying the message properties happens after that await resolves.
    const visible = ctx.chat.filter(message => !message.is_system);
    let releaseFiles;
    const filesReady = new Promise(resolve => { releaseFiles = resolve; });
    const mapping = Promise.all(visible.map(async message => {
        const mes = await filesReady.then(() => message.mes);
        return { ...structuredClone(message), mes };
    }));
    Object.assign(ctx.chat[0], { _bbmem_extracted: true, is_system: true });
    Object.assign(ctx.chat[1], { _bbmem_hideSource: 'plugin', _bbmem_autoHidden: true, is_system: true });
    releaseFiles();
    const coreChat = await mapping, latestCopy = coreChat[2];
    assert.equal(coreChat.length, 3, 'ST filtering already happened before extraction completed');
    const originalsBefore = structuredClone(ctx.chat.slice(0, 2));
    await run('normal', coreChat);
    assert.deepEqual(coreChat, [latestCopy], 'Both old extracted/hidden copies are removed');
    assert.deepEqual(ctx.chat.slice(0, 2), originalsBefore, 'Original hidden records remain intact');
    assert.equal(actualQuery, '最新用户输入');
    assert.equal(captureUser, ctx.chat[2]);
    assert.equal(prompts.get('bb_memory_injection').depth, 1);
    assert.deepEqual(order(nativeChatCompletionMessages(coreChat)), ['STORY_STRING', 'LONG+REALTIME', '最新用户输入', 'PRESET_TAIL']);
});

await test('只清理完成和插件隐藏标记，未提取/手动恢复的副本正常保留', async () => {
    ctx.chat = [
        { ...user('旧用户输入'), _bbmem_extracted: false, _bbmem_hideSource: 'plugin', _bbmem_autoHidden: false },
        assistant('旧AI回复'), user('最新用户输入'),
    ];
    const coreChat = await run();
    assert.deepEqual(coreChat.map(message => message.mes), ['旧用户输入', '旧AI回复', '最新用户输入']);
    assert.deepEqual(order(nativeChatCompletionMessages(coreChat)), ['STORY_STRING', 'LONG', '旧用户输入', '旧AI回复', 'REALTIME', '最新用户输入', 'PRESET_TAIL']);
});

await test('单条和两条短历史，合并同深度 system 时仍保留最新输入在尾部之前', async () => {
    for (const history of [[user('最新用户输入')], [assistant('开场白'), user('最新用户输入')]]) {
        ctx.chat = history;
        const coreChat = await run();
        assert.equal(actualQuery, '最新用户输入');
        assert.equal(prompts.get('bb_memory_realtime_injection').depth, 1);
        const messages = nativeChatCompletionMessages(coreChat);
        assert.deepEqual(order(messages), history.length === 1
            ? ['STORY_STRING', 'LONG+REALTIME', '最新用户输入', 'PRESET_TAIL']
            : ['STORY_STRING', 'LONG', '开场白', 'REALTIME', '最新用户输入', 'PRESET_TAIL']);
        assert.equal(messages.at(-2).role, 'user');
    }
});

await test('swipe/regenerate 用 ST 删除待生成 AI 后的 coreChat，continue 保留原生位置和最新输入', async () => {
    for (const type of ['swipe', 'regenerate']) {
        ctx.chat = [user('旧用户输入'), assistant('旧AI回复'), user('最新用户输入'), assistant('待重写AI')];
        if (type === 'regenerate') ctx.chat.pop(); // ST removes the old response before building coreChat.
        const coreChat = structuredClone(ctx.chat.filter(message => !message.is_system));
        if (type === 'swipe') coreChat.pop(); // ST only pops the generation copy for swipe.
        await run(type, coreChat);
        assert.equal(actualQuery, '最新用户输入');
        assert.deepEqual(order(nativeChatCompletionMessages(coreChat)), ['STORY_STRING', 'LONG', '旧用户输入', '旧AI回复', 'REALTIME', '最新用户输入', 'PRESET_TAIL']);
    }
    ctx.chat = [user('旧用户输入'), assistant('旧AI回复'), user('最新用户输入'), assistant('待续写AI')];
    const coreChat = await run('continue');
    assert.equal(actualQuery, '最新用户输入');
    assert.deepEqual(order(nativeChatCompletionMessages(coreChat)), ['STORY_STRING', 'LONG', '旧用户输入', '旧AI回复', '最新用户输入', 'REALTIME', '待续写AI', 'PRESET_TAIL']);
    assert.equal(coreChat[2].mes, '最新用户输入');
    assert.deepEqual(order(nativeChatCompletionMessages(coreChat, { continuePrefill: true })), ['STORY_STRING', 'LONG', '旧用户输入', '旧AI回复', 'REALTIME', '最新用户输入', 'PRESET_TAIL', '待续写AI']);
    assert.equal(coreChat.at(-1).mes, '待续写AI', 'Native prefill assembly must not remove the stored generation target');
});

await test('升级后的自定义深度 2 生效，关闭实时/总开关及空数据均无旧注入残留', async () => {
    ctx.chat = [user('旧用户输入'), assistant('旧AI回复'), user('最新用户输入')];
    store.updateSettings({ realtimeInjectionDepth: 2 });
    let coreChat = await run();
    assert.equal(prompts.get('bb_memory_realtime_injection').depth, 2);
    assert.deepEqual(order(nativeChatCompletionMessages(coreChat)), ['STORY_STRING', 'LONG', '旧用户输入', 'REALTIME', '旧AI回复', '最新用户输入', 'PRESET_TAIL']);
    store.updateSettings({ realtimeEnabled: false });
    coreChat = await run();
    assert.equal(prompts.get('bb_memory_realtime_injection').text, '');
    assert.deepEqual(order(nativeChatCompletionMessages(coreChat)), ['STORY_STRING', 'LONG', '旧用户输入', '旧AI回复', '最新用户输入', 'PRESET_TAIL']);
    store.updateSettings({ realtimeEnabled: true, realtimeInjectionDepth: 1 });
    await run();
    store.updateSettings({ enabled: false });
    await run();
    assert.equal(prompts.get('bb_memory_injection').text, '');
    assert.equal(prompts.get('bb_memory_realtime_injection').text, '');
    assert.deepEqual(ctx.chat[2].extra.bbMemoryInjectionContext.entriesByPillar, {});
    store.updateSettings({ enabled: true });
    await run();
    loadData = false;
    await run();
    assert.equal(prompts.get('bb_memory_injection').text, '');
    assert.equal(prompts.get('bb_memory_realtime_injection').text, '');
    assert.deepEqual(ctx.chat[2].extra.bbMemoryInjectionContext.entriesByPillar, {});
    assert.deepEqual(order(nativeChatCompletionMessages(coreChat)), ['STORY_STRING', '旧用户输入', '旧AI回复', '最新用户输入', 'PRESET_TAIL']);
});

console.log(`v9.5.3 actual injection order: ${checks} regression groups passed`);

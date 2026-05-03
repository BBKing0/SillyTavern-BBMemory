/**
 * memory-store.js —— BB-Memory 的"笔记本"
 *
 * 职责：管理记忆数据的增删改查（CRUD）。
 * 数据存储在 SillyTavern 的 extensionSettings 中，
 * 会随 SillyTavern 设置自动保存到服务端。
 *
 * 数据结构：
 *   extensionSettings['bb_memory'] = {
 *       enabled: true,
 *       maxResults: 5,
 *       injectionDepth: 4,
 *       injectionTemplate: '...',
 *       chats: {
 *           [chatId]: [
 *               { id, content, keywords, createdAt, source }
 *           ]
 *       }
 *   }
 */

// ═══ 模块名（用作 extensionSettings 的 key）═══
export const MODULE_NAME = 'bb_memory';

// ═══ 默认设置 ═══
export const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    maxResults: 5,
    injectionDepth: 4,
    injectionTemplate: '[角色记忆]\n{{memories}}',
});

// ═══ 获取/初始化设置 ═══

export function getSettings() {
    const { extensionSettings } = SillyTavern.getContext();

    if (!extensionSettings[MODULE_NAME]) {
        extensionSettings[MODULE_NAME] = { ...DEFAULT_SETTINGS, chats: {} };
    }

    const s = extensionSettings[MODULE_NAME];
    for (const [key, val] of Object.entries(DEFAULT_SETTINGS)) {
        if (s[key] === undefined) s[key] = val;
    }
    if (!s.chats) s.chats = {};

    return s;
}

export function updateSettings(patch) {
    const s = getSettings();
    Object.assign(s, patch);
    SillyTavern.getContext().saveSettingsDebounced();
}

// ═══ 记忆 CRUD ═══

function generateId() {
    return `bb_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

function extractKeywords(text) {
    return text
        .toLowerCase()
        .split(/[\s,，。！？!?、；;：:""''（）()\[\]{}·\n\r\t]+/)
        .map(t => t.trim())
        .filter(t => t.length >= 2)
        .filter((v, i, a) => a.indexOf(v) === i)
        .slice(0, 20);
}

export function getMemories(chatId) {
    const s = getSettings();
    return s.chats[chatId] || [];
}

export function addMemory(chatId, content, source = 'manual') {
    const s = getSettings();
    if (!s.chats[chatId]) s.chats[chatId] = [];

    const entry = {
        id: generateId(),
        content: content.trim(),
        keywords: extractKeywords(content),
        createdAt: Date.now(),
        source,
    };

    s.chats[chatId].push(entry);
    SillyTavern.getContext().saveSettingsDebounced();
    return entry;
}

export function removeMemory(chatId, memoryId) {
    const s = getSettings();
    if (!s.chats[chatId]) return false;

    const before = s.chats[chatId].length;
    s.chats[chatId] = s.chats[chatId].filter(m => m.id !== memoryId);

    if (s.chats[chatId].length < before) {
        SillyTavern.getContext().saveSettingsDebounced();
        return true;
    }
    return false;
}

export function updateMemory(chatId, memoryId, newContent) {
    const s = getSettings();
    const list = s.chats[chatId];
    if (!list) return null;

    const entry = list.find(m => m.id === memoryId);
    if (!entry) return null;

    entry.content = newContent.trim();
    entry.keywords = extractKeywords(newContent);
    SillyTavern.getContext().saveSettingsDebounced();
    return entry;
}

export function clearMemories(chatId) {
    const s = getSettings();
    s.chats[chatId] = [];
    SillyTavern.getContext().saveSettingsDebounced();
}

export function exportMemories(chatId) {
    const memories = getMemories(chatId);
    return JSON.stringify(memories, null, 2);
}

export function importMemories(chatId, jsonString) {
    const parsed = JSON.parse(jsonString);
    if (!Array.isArray(parsed)) throw new Error('导入数据格式错误：应为数组');

    const s = getSettings();
    if (!s.chats[chatId]) s.chats[chatId] = [];

    let count = 0;
    for (const item of parsed) {
        if (item.content && typeof item.content === 'string') {
            s.chats[chatId].push({
                id: generateId(),
                content: item.content.trim(),
                keywords: item.keywords || extractKeywords(item.content),
                createdAt: item.createdAt || Date.now(),
                source: item.source || 'import',
            });
            count++;
        }
    }

    SillyTavern.getContext().saveSettingsDebounced();
    return count;
}

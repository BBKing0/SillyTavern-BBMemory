/**
 * memory-store.js —— BB-Memory 的"笔记本"（数据持久化层）
 *
 * ═══════════════════════════════════════════════════════════
 *  代码小课堂
 * ═══════════════════════════════════════════════════════════
 *
 * 这个文件是什么？
 *   想象一个巨大的笔记本，每一页都是一条"记忆"。
 *   这个文件负责：往笔记本里写新记忆、翻页查找、划掉不要的、修改写错的。
 *
 * 用了哪些编程概念？
 *   - async/await：因为记忆数据存在浏览器的"数据库"(IndexedDB)里，
 *     读写需要等待，所以用 async 表示"这是个需要等的操作"
 *   - localforage：SillyTavern 内置的数据库工具，能存大量数据
 *   - JSON：数据的格式，类似表格，有行有列
 *   - export：让其他文件能用这个文件里的函数
 *
 * 关键函数：
 *   - getSettings()：读取用户的配置（开关、参数等）
 *   - getMemories(chatId)：获取某个聊天的所有记忆
 *   - addMemory(...)：添加一条新记忆
 *   - removeMemory(...)：删除一条记忆
 *   - updateMemory(...)：修改一条记忆
 *   - decayMemories(...)：模拟遗忘——时间越久，记忆越淡
 *   - reinforceMemory(...)：被回忆起时，记忆变得更牢固
 *   - migrateFromSettings()：把旧版本数据搬到新系统
 *
 * ═══════════════════════════════════════════════════════════
 */

// ═══ 模块名（用作 extensionSettings 的 key）═══
export const MODULE_NAME = 'bb_memory';

// ═══ localforage 的存储前缀 ═══
const STORAGE_PREFIX = 'bb_memory_chat_';

// ═══ 默认设置（只存轻量配置，不存记忆数据）═══
export const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    maxResults: 5,
    injectionDepth: 4,
    injectionTemplate: '[角色长期记忆]\n{{memories}}',
    // 记忆衰减设置
    decayEnabled: true,
    decayRate: 0.05,         // 每次衰减减少的强度
    decayInterval: 10,       // 每隔多少条消息触发一次衰减
    minStrength: 0.1,        // 最低记忆强度（不会完全遗忘）
    // AI 自动生成设置
    autoGenEnabled: false,
    autoGenMode: 'main',     // 'main' = 用主API的quiet prompt, 'custom' = 自定义API
    autoGenEndpoint: '',
    autoGenApiKey: '',
    autoGenModel: '',
    autoGenPrompt: '',
    // 记忆类型开关
    typeEnabled: {
        event: true,
        timeline: true,
        item: true,
        npc: true,
        location: true,
        relationship: true,
    },
    // 统计
    messageCountSinceDecay: 0,
});

// ═══ 获取 localforage 实例 ═══
function getLocalForage() {
    return SillyTavern.libs.localforage;
}

// ═══ 获取/初始化设置 ═══

export function getSettings() {
    const { extensionSettings } = SillyTavern.getContext();

    if (!extensionSettings[MODULE_NAME]) {
        extensionSettings[MODULE_NAME] = structuredClone(DEFAULT_SETTINGS);
    }

    const s = extensionSettings[MODULE_NAME];

    // 确保所有默认键都存在（升级兼容）
    for (const [key, val] of Object.entries(DEFAULT_SETTINGS)) {
        if (s[key] === undefined) {
            s[key] = typeof val === 'object' && val !== null ? structuredClone(val) : val;
        }
    }

    return s;
}

export function updateSettings(patch) {
    const s = getSettings();
    Object.assign(s, patch);
    SillyTavern.getContext().saveSettingsDebounced();
}

// ═══ 记忆数据的 localforage 存取 ═══

function storageKey(chatId) {
    return `${STORAGE_PREFIX}${chatId}`;
}

/**
 * 获取指定聊天的所有记忆（异步，从 IndexedDB 读取）
 */
export async function getMemories(chatId) {
    if (!chatId) return [];
    const lf = getLocalForage();
    const data = await lf.getItem(storageKey(chatId));
    return Array.isArray(data) ? data : [];
}

/**
 * 保存指定聊天的记忆数组到 IndexedDB
 */
async function saveMemories(chatId, memories) {
    const lf = getLocalForage();
    await lf.setItem(storageKey(chatId), memories);
}

// ═══ ID 生成 ═══

function generateId() {
    return `bb_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

// ═══ 关键词提取 ═══

export function extractKeywords(text) {
    return text
        .toLowerCase()
        .split(/[\s,，。！？!?、；;：:""''（）()\[\]{}·\n\r\t]+/)
        .map(t => t.trim())
        .filter(t => t.length >= 2)
        .filter((v, i, a) => a.indexOf(v) === i)
        .slice(0, 20);
}

// ═══ 记忆 CRUD ═══

/**
 * 添加一条新记忆
 * @param {string} chatId - 聊天ID
 * @param {string} content - 记忆内容
 * @param {string} type - 记忆类型：event/timeline/item/npc/location/relationship
 * @param {string} source - 来源：manual/auto/import/worldbook
 * @param {object} options - 额外选项（tags, importance, emotionalValence, metadata）
 * @returns {object} 新创建的记忆条目
 */
export async function addMemory(chatId, content, type = 'event', source = 'manual', options = {}) {
    const memories = await getMemories(chatId);

    const entry = {
        id: generateId(),
        type,
        content: content.trim(),
        keywords: extractKeywords(content),
        tags: options.tags || [],
        importance: options.importance ?? 0.5,
        emotionalValence: options.emotionalValence ?? 0.0,
        strength: 1.0,
        accessCount: 0,
        lastAccessedAt: null,
        createdAt: Date.now(),
        source,
        metadata: options.metadata || {},
    };

    memories.push(entry);
    await saveMemories(chatId, memories);
    return entry;
}

/**
 * 删除一条记忆
 */
export async function removeMemory(chatId, memoryId) {
    const memories = await getMemories(chatId);
    const filtered = memories.filter(m => m.id !== memoryId);

    if (filtered.length < memories.length) {
        await saveMemories(chatId, filtered);
        return true;
    }
    return false;
}

/**
 * 更新一条记忆的内容
 */
export async function updateMemory(chatId, memoryId, updates) {
    const memories = await getMemories(chatId);
    const entry = memories.find(m => m.id === memoryId);
    if (!entry) return null;

    if (typeof updates === 'string') {
        entry.content = updates.trim();
        entry.keywords = extractKeywords(updates);
    } else {
        if (updates.content !== undefined) {
            entry.content = updates.content.trim();
            entry.keywords = extractKeywords(updates.content);
        }
        if (updates.type !== undefined) entry.type = updates.type;
        if (updates.tags !== undefined) entry.tags = updates.tags;
        if (updates.importance !== undefined) entry.importance = updates.importance;
        if (updates.emotionalValence !== undefined) entry.emotionalValence = updates.emotionalValence;
        if (updates.metadata !== undefined) entry.metadata = updates.metadata;
    }

    await saveMemories(chatId, memories);
    return entry;
}

/**
 * 清空指定聊天的所有记忆
 */
export async function clearMemories(chatId) {
    await saveMemories(chatId, []);
}

// ═══ 记忆强度机制（模拟人脑遗忘与巩固）═══

/**
 * 记忆衰减：模拟艾宾浩斯遗忘曲线
 * 每条记忆的 strength 会随时间降低，但不会低于 minStrength
 */
export async function decayMemories(chatId) {
    const settings = getSettings();
    if (!settings.decayEnabled) return;

    const memories = await getMemories(chatId);
    if (!memories.length) return;

    const { decayRate, minStrength } = settings;

    for (const memory of memories) {
        if (memory.strength > minStrength) {
            // 重要记忆衰减更慢
            const importanceFactor = 1 - (memory.importance || 0.5) * 0.5;
            const decay = decayRate * importanceFactor;
            memory.strength = Math.max(minStrength, memory.strength - decay);
        }
    }

    await saveMemories(chatId, memories);
}

/**
 * 记忆巩固：当记忆被检索到时，增强其强度
 */
export async function reinforceMemory(chatId, memoryId) {
    const memories = await getMemories(chatId);
    const entry = memories.find(m => m.id === memoryId);
    if (!entry) return;

    entry.strength = Math.min(1.0, entry.strength + 0.1);
    entry.accessCount = (entry.accessCount || 0) + 1;
    entry.lastAccessedAt = Date.now();

    await saveMemories(chatId, memories);
}

/**
 * 批量巩固多条记忆（检索结果用）
 */
export async function reinforceMemories(chatId, memoryIds) {
    if (!memoryIds.length) return;

    const memories = await getMemories(chatId);
    const now = Date.now();

    for (const id of memoryIds) {
        const entry = memories.find(m => m.id === id);
        if (entry) {
            entry.strength = Math.min(1.0, entry.strength + 0.1);
            entry.accessCount = (entry.accessCount || 0) + 1;
            entry.lastAccessedAt = now;
        }
    }

    await saveMemories(chatId, memories);
}

// ═══ 导入/导出 ═══

export async function exportMemories(chatId) {
    const memories = await getMemories(chatId);
    return JSON.stringify(memories, null, 2);
}

export async function importMemories(chatId, jsonString) {
    const parsed = JSON.parse(jsonString);
    if (!Array.isArray(parsed)) throw new Error('导入数据格式错误：应为数组');

    const memories = await getMemories(chatId);
    let count = 0;

    for (const item of parsed) {
        if (item.content && typeof item.content === 'string') {
            memories.push({
                id: generateId(),
                type: item.type || 'event',
                content: item.content.trim(),
                keywords: item.keywords || extractKeywords(item.content),
                tags: item.tags || [],
                importance: item.importance ?? 0.5,
                emotionalValence: item.emotionalValence ?? 0.0,
                strength: item.strength ?? 1.0,
                accessCount: 0,
                lastAccessedAt: null,
                createdAt: item.createdAt || Date.now(),
                source: item.source || 'import',
                metadata: item.metadata || {},
            });
            count++;
        }
    }

    await saveMemories(chatId, memories);
    return count;
}

// ═══ v1 数据迁移 ═══

/**
 * 将旧版 v1 存储在 extensionSettings.bb_memory.chats 中的数据
 * 迁移到 localforage（IndexedDB）
 */
export async function migrateFromSettings() {
    const { extensionSettings } = SillyTavern.getContext();
    const oldData = extensionSettings[MODULE_NAME];

    if (!oldData || !oldData.chats) return 0;

    const chats = oldData.chats;
    let totalMigrated = 0;

    for (const [chatId, oldMemories] of Object.entries(chats)) {
        if (!Array.isArray(oldMemories) || !oldMemories.length) continue;

        const existing = await getMemories(chatId);
        const existingIds = new Set(existing.map(m => m.id));

        for (const oldMem of oldMemories) {
            if (existingIds.has(oldMem.id)) continue;

            existing.push({
                id: oldMem.id || generateId(),
                type: oldMem.type || 'event',
                content: oldMem.content || '',
                keywords: oldMem.keywords || [],
                tags: (oldMem.keywords || []).map(k => ({ name: k, weight: 0.5 })),
                importance: 0.5,
                emotionalValence: 0.0,
                strength: 0.8,
                accessCount: 0,
                lastAccessedAt: null,
                createdAt: oldMem.createdAt || Date.now(),
                source: oldMem.source || 'manual',
                metadata: {},
            });
            totalMigrated++;
        }

        if (totalMigrated > 0) {
            await saveMemories(chatId, existing);
        }
    }

    // 迁移完成后，清理旧数据
    if (totalMigrated > 0) {
        delete oldData.chats;
        SillyTavern.getContext().saveSettingsDebounced();
        console.log(`[BB-Memory] 已从旧版迁移 ${totalMigrated} 条记忆到 IndexedDB`);
    }

    return totalMigrated;
}

// ═══ 工具函数 ═══

/**
 * 获取记忆统计信息
 */
export async function getMemoryStats(chatId) {
    const memories = await getMemories(chatId);
    const stats = {
        total: memories.length,
        byType: {},
        bySource: {},
        avgStrength: 0,
        avgImportance: 0,
    };

    if (!memories.length) return stats;

    let strengthSum = 0;
    let importanceSum = 0;

    for (const m of memories) {
        stats.byType[m.type] = (stats.byType[m.type] || 0) + 1;
        stats.bySource[m.source] = (stats.bySource[m.source] || 0) + 1;
        strengthSum += m.strength || 0;
        importanceSum += m.importance || 0;
    }

    stats.avgStrength = strengthSum / memories.length;
    stats.avgImportance = importanceSum / memories.length;

    return stats;
}

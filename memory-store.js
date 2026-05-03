/**
 * memory-store.js —— BB-Memory 的"笔记本"（数据持久化层）
 *
 * v2.2 变更：
 *   - 记忆条目升级为 27+ 字段的认知记忆结构
 *   - 惰性迁移：首次读取旧数据时自动转换为新格式
 *   - addMemory 支持新旧类型名（自动映射）
 *   - updateMemory 支持任意字段更新
 */

import { LEGACY_TYPE_MAP } from './memory-types.js';

// ═══ 模块名（用作 extensionSettings 的 key）═══
export const MODULE_NAME = 'bb_memory';

// ═══ localforage 的存储前缀 ═══
const STORAGE_PREFIX = 'bb_memory_chat_';

// ═══ 默认设置 ═══
export const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    maxResults: 5,
    injectionDepth: 4,
    injectionTemplate: '[角色长期记忆]\n{{memories}}',
    // 记忆衰减
    decayEnabled: true,
    decayRate: 0.05,
    decayInterval: 10,
    minStrength: 0.1,
    // AI 自动生成
    autoGenEnabled: false,
    autoGenMode: 'main',
    autoGenEndpoint: '',
    autoGenApiKey: '',
    autoGenModel: '',
    autoGenPrompt: '',
    // 认知类型开关（v2.2 升级为四类）
    typeEnabled: {
        fact: true,
        episode: true,
        emotion: true,
        habit: true,
    },
    // 消息稳定化
    shortTermWindow: 5,
    // 统计
    messageCountSinceDecay: 0,
});

// ═══ SillyTavern 接口 ═══

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

    for (const [key, val] of Object.entries(DEFAULT_SETTINGS)) {
        if (s[key] === undefined) {
            s[key] = typeof val === 'object' && val !== null ? structuredClone(val) : val;
        }
    }

    // v2.2: 确保 typeEnabled 包含新认知类型键
    if (s.typeEnabled && s.typeEnabled.fact === undefined) {
        s.typeEnabled.fact = true;
        s.typeEnabled.episode = true;
        s.typeEnabled.emotion = true;
        s.typeEnabled.habit = true;
    }

    return s;
}

export function updateSettings(patch) {
    const s = getSettings();
    Object.assign(s, patch);
    SillyTavern.getContext().saveSettingsDebounced();
}

// ═══ localforage 存取 ═══

function storageKey(chatId) {
    return `${STORAGE_PREFIX}${chatId}`;
}

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

// ═══════════════════════════════════════════════════════════
//  v2.0 → v2.2 惰性迁移
// ═══════════════════════════════════════════════════════════

/**
 * 将旧格式记忆条目转换为 v2.2 新格式。
 * 旧字段全部保留（通过 ...entry 展开），新字段补充默认值。
 */
function migrateMemoryEntry(entry) {
    if (entry.cognitiveType) return entry;

    const mapped = LEGACY_TYPE_MAP[entry.type] || { cognitiveType: 'fact', categoryPath: '' };
    const meta = entry.metadata || {};

    return {
        // 保留所有旧字段
        ...entry,
        // ── 新增核心字段 ──
        cognitiveType: mapped.cognitiveType,
        categoryPath: mapped.categoryPath,
        legacyType: entry.type || '',
        title: '',
        summary: '',
        compressed: '',
        verbatim: '',
        // ── 结构化信息（从 metadata 中提取） ──
        subject: meta.npcName || meta.person1 || meta.owner || '',
        target: meta.person2 || '',
        actors: meta.participants || [],
        location: meta.location || meta.locationName || '',
        // ── 状态与可信度 ──
        truthStatus: 'confirmed',
        visibility: 'public',
        confidence: 1.0,
        emotionalWeight: Math.abs(entry.emotionalValence || 0),
        status: 'active',
        pinned: false,
        // ── 来源追溯 ──
        sourceMessageIds: [],
        sourceExchangeHash: '',
        // ── 时间戳 ──
        updatedAt: entry.createdAt || Date.now(),
        // ── 变更历史 & 隐藏备注 ──
        history: [],
        hiddenNotes: '',
    };
}

// ═══════════════════════════════════════════════════════════
//  记忆读取（含惰性迁移）
// ═══════════════════════════════════════════════════════════

/**
 * 获取指定聊天的所有记忆。
 * 如果检测到旧格式条目，会自动迁移并回写。
 */
export async function getMemories(chatId) {
    if (!chatId) return [];
    const lf = getLocalForage();
    const data = await lf.getItem(storageKey(chatId));
    if (!Array.isArray(data)) return [];

    let needsMigration = false;
    const memories = data.map(entry => {
        if (!entry.cognitiveType) {
            needsMigration = true;
            return migrateMemoryEntry(entry);
        }
        return entry;
    });

    if (needsMigration) {
        await saveMemories(chatId, memories);
        console.log(`[BB-Memory] 已将 ${chatId} 的记忆迁移到 v2.2 认知格式`);
    }

    return memories;
}

// ═══════════════════════════════════════════════════════════
//  记忆 CRUD
// ═══════════════════════════════════════════════════════════

/**
 * 添加一条新记忆
 *
 * @param {string} chatId - 聊天ID
 * @param {string} content - 记忆内容
 * @param {string} cognitiveType - 认知类型或旧版类型（自动映射）
 * @param {string} source - 来源：manual / auto / import / worldbook
 * @param {object} options - 额外字段
 */
export async function addMemory(chatId, content, cognitiveType = 'episode', source = 'manual', options = {}) {
    const memories = await getMemories(chatId);

    // 兼容旧类型名：如果传入的是 v2.0 类型，自动映射
    let resolvedType = cognitiveType;
    let categoryPath = options.categoryPath || '';
    let legacyType = options.legacyType || '';

    if (LEGACY_TYPE_MAP[cognitiveType]) {
        const mapped = LEGACY_TYPE_MAP[cognitiveType];
        legacyType = cognitiveType;
        resolvedType = mapped.cognitiveType;
        if (!categoryPath) categoryPath = mapped.categoryPath;
    }

    const now = Date.now();

    const entry = {
        id: generateId(),
        // ── 类型 ──
        cognitiveType: resolvedType,
        categoryPath,
        legacyType,
        // ── 内容层 ──
        title: options.title || '',
        content: content.trim(),
        summary: options.summary || '',
        compressed: options.compressed || '',
        verbatim: options.verbatim || '',
        keywords: extractKeywords(content),
        // ── 结构化信息 ──
        tags: options.tags || [],
        subject: options.subject || '',
        target: options.target || '',
        actors: options.actors || [],
        location: options.location || '',
        // ── 状态 ──
        truthStatus: options.truthStatus || 'confirmed',
        visibility: options.visibility || 'public',
        confidence: options.confidence ?? 1.0,
        importance: options.importance ?? 0.5,
        emotionalWeight: options.emotionalWeight ?? 0.0,
        strength: 1.0,
        status: options.status || 'active',
        pinned: options.pinned || false,
        // ── 来源 ──
        source,
        sourceMessageIds: options.sourceMessageIds || [],
        sourceExchangeHash: options.sourceExchangeHash || '',
        // ── 时间 ──
        createdAt: now,
        updatedAt: now,
        lastAccessedAt: null,
        accessCount: 0,
        // ── 变更历史 & 隐藏备注 ──
        history: [],
        hiddenNotes: options.hiddenNotes || '',
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
 * 更新一条记忆（支持任意字段）
 */
export async function updateMemory(chatId, memoryId, updates) {
    const memories = await getMemories(chatId);
    const entry = memories.find(m => m.id === memoryId);
    if (!entry) return null;

    if (typeof updates === 'string') {
        entry.content = updates.trim();
        entry.keywords = extractKeywords(updates);
    } else {
        // 保护不可覆盖的字段
        const { id: _id, createdAt: _ca, ...safeUpdates } = updates;
        Object.assign(entry, safeUpdates);

        if (updates.content !== undefined) {
            entry.content = entry.content.trim();
            entry.keywords = extractKeywords(entry.content);
        }
    }

    entry.updatedAt = Date.now();
    await saveMemories(chatId, memories);
    return entry;
}

/**
 * 清空指定聊天的所有记忆
 */
export async function clearMemories(chatId) {
    await saveMemories(chatId, []);
}

// ═══════════════════════════════════════════════════════════
//  记忆强度机制
// ═══════════════════════════════════════════════════════════

export async function decayMemories(chatId) {
    const settings = getSettings();
    if (!settings.decayEnabled) return;

    const memories = await getMemories(chatId);
    if (!memories.length) return;

    const { decayRate, minStrength } = settings;

    for (const memory of memories) {
        // 已固定的记忆不衰减
        if (memory.pinned) continue;
        if (memory.strength > minStrength) {
            const importanceFactor = 1 - (memory.importance || 0.5) * 0.5;
            const decay = decayRate * importanceFactor;
            memory.strength = Math.max(minStrength, memory.strength - decay);
        }
    }

    await saveMemories(chatId, memories);
}

export async function reinforceMemory(chatId, memoryId) {
    const memories = await getMemories(chatId);
    const entry = memories.find(m => m.id === memoryId);
    if (!entry) return;

    entry.strength = Math.min(1.0, entry.strength + 0.1);
    entry.accessCount = (entry.accessCount || 0) + 1;
    entry.lastAccessedAt = Date.now();

    await saveMemories(chatId, memories);
}

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

// ═══════════════════════════════════════════════════════════
//  导入/导出
// ═══════════════════════════════════════════════════════════

export async function exportMemories(chatId) {
    const memories = await getMemories(chatId);
    return JSON.stringify(memories, null, 2);
}

export async function importMemories(chatId, jsonString) {
    const parsed = JSON.parse(jsonString);
    if (!Array.isArray(parsed)) throw new Error('导入数据格式错误：应为数组');

    const memories = await getMemories(chatId);
    const now = Date.now();
    let count = 0;

    for (const item of parsed) {
        if (!item.content || typeof item.content !== 'string') continue;

        // 新格式直接使用，旧格式自动迁移
        const entry = item.cognitiveType
            ? { ...item, id: generateId(), createdAt: item.createdAt || now, updatedAt: item.updatedAt || now }
            : migrateMemoryEntry({
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
                createdAt: item.createdAt || now,
                source: item.source || 'import',
                metadata: item.metadata || {},
            });

        // 确保关键字段存在
        if (!entry.keywords) entry.keywords = extractKeywords(entry.content);
        if (!entry.source) entry.source = 'import';

        memories.push(entry);
        count++;
    }

    await saveMemories(chatId, memories);
    return count;
}

// ═══════════════════════════════════════════════════════════
//  v1 → v2 数据迁移（从 extensionSettings 迁移到 localforage）
// ═══════════════════════════════════════════════════════════

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

            // v1 条目先用旧结构 push，getMemories 的惰性迁移会在下次读取时转换
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

    if (totalMigrated > 0) {
        delete oldData.chats;
        SillyTavern.getContext().saveSettingsDebounced();
        console.log(`[BB-Memory] 已从旧版迁移 ${totalMigrated} 条记忆到 IndexedDB`);
    }

    return totalMigrated;
}

// ═══════════════════════════════════════════════════════════
//  统计
// ═══════════════════════════════════════════════════════════

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
        const typeKey = m.cognitiveType || m.type || 'fact';
        stats.byType[typeKey] = (stats.byType[typeKey] || 0) + 1;
        stats.bySource[m.source] = (stats.bySource[m.source] || 0) + 1;
        strengthSum += m.strength || 0;
        importanceSum += m.importance || 0;
    }

    stats.avgStrength = strengthSum / memories.length;
    stats.avgImportance = importanceSum / memories.length;

    return stats;
}

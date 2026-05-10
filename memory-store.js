/**
 * memory-store.js —— BB-Memory 的"笔记本"（数据持久化层）
 *
 * v2.2 变更：认知记忆结构 + 惰性迁移 + 通用 CRUD
 * v2.3 变更：事实更新（带历史）+ hiddenNotes 结构化 + truthStatus 扩展
 */

import { LEGACY_TYPE_MAP } from './memory-types.js';

// ═══ 模块名（用作 extensionSettings 的 key）═══
export const MODULE_NAME = 'bb_memory';

// ═══ localforage 的存储前缀 ═══
const STORAGE_PREFIX = 'bb_memory_chat_';

// ═══ 默认设置 ═══
export const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
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
    // v4.0.0: 向量化语义检索（需配置独立的 Embedding API，默认关闭）
    embeddingEnabled: false,
    embeddingEndpoint: '',
    embeddingApiKey: '',
    embeddingModel: 'text-embedding-3-small',
    // v4.1.0: 语义去重与聚类
    dedupEnabled: true,
    mergeSimilarityThreshold: 0.85,
    reduceSimilarityThreshold: 0.60,
    clusterEnabled: true,
    clusterTagThreshold: 8,
    // v4.1.0: 故事时间
    calendarDescription: '',
    autoGenContextPrompt: '',
    autoGenMaxExchanges: 3,
    maxMemoriesPerExchange: 3,
    // v2.9.8: 提取确认模式与滑动窗口
    extractionConfirmMode: 'semi',       // 'active' | 'semi' | 'auto'
    activeConfirmStyle: 'popup',         // 'popup' | 'toast'（仅 active 模式有效）
    contextWindowExchanges: 5,           // 滑动窗口保留的 exchange 数（2-20）
    // v2.9.9: 总结模式与 NPC 排除
    summaryMode: 'roleplay',             // 'self'（代入式） | 'roleplay'（扮演式）
    excludedNpcs: '',                    // 逗号分隔的不总结 NPC 列表
    currentSlotName: 'default',          // 当前使用的存档槽名
    // v3.0.0: 批量提取模式
    extractionBatchMode: 'single',       // 'single'（逐层提取） | 'batch'（批量提取）
    // 认知类型开关（v2.2 升级为四类）
    typeEnabled: {
        fact: true,
        episode: true,
        emotion: true,
        habit: true,
    },
    // 消息稳定化
    shortTermWindow: 5,
    // v2.4: 注入 token 预算与检索
    tokenBudget: 800,
    maxResults: 10,
    // v2.5: 维护阈值
    maintenanceThreshold: 50,
    // 统计
    messageCountSinceDecay: 0,
    // 调试
    debugLogging: false,
    // v4.4.0: 时间线总结
    timelineSummaryEnabled: true,
    // v4.4.0: 自动备份
    autoBackupEnabled: false,
    lastBackupTimestamp: 0,
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

export async function saveMemoriesData(chatId, memories) {
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
        truthStatus: 'true',
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
        hiddenNotes: [],
    };
}

/**
 * v2.2 → v2.3 微迁移：修正 hiddenNotes 和 truthStatus 格式
 */
function migrateToV23(entry) {
    let changed = false;

    // hiddenNotes: string → array
    if (typeof entry.hiddenNotes === 'string') {
        entry.hiddenNotes = entry.hiddenNotes
            ? [{ id: generateId(), type: 'note', content: entry.hiddenNotes,
                 allowInjection: true, revealPolicy: 'never', revealCondition: '',
                 createdAt: entry.createdAt || Date.now() }]
            : [];
        changed = true;
    }

    // truthStatus: 'confirmed' → 'true'
    if (entry.truthStatus === 'confirmed') {
        entry.truthStatus = 'true';
        changed = true;
    }

    if (!Array.isArray(entry.history)) {
        entry.history = [];
        changed = true;
    }

    // v2.4: resident 字段
    if (entry.resident === undefined) {
        entry.resident = false;
        changed = true;
    }

    return changed;
}

/**
 * v2.6：NPC/物品分级、索引卡、关联记忆 ID
 */
function migrateToV26(entry) {
    let changed = false;

    if (entry.npcTier === undefined) {
        entry.npcTier = '';
        changed = true;
    }
    if (entry.itemTier === undefined) {
        entry.itemTier = '';
        changed = true;
    }
    if (entry.indexCard === undefined) {
        entry.indexCard = '';
        changed = true;
    }
    if (!Array.isArray(entry.relatedMemoryIds)) {
        entry.relatedMemoryIds = [];
        changed = true;
    }
    if (entry.standaloneArchive === undefined) {
        entry.standaloneArchive = true;
        changed = true;
    }

    return changed;
}

/**
 * v4.0.0：embedding 字段迁移
 */
function migrateToVEmbedding(entry) {
    if (entry.embedding === undefined) {
        entry.embedding = null;
        return true;
    }
    return false;
}

function migrateToV41(entry) {
    let changed = false;
    if (entry.storyTime === undefined) { entry.storyTime = ''; changed = true; }
    if (entry.storyTimeSort === undefined) { entry.storyTimeSort = null; changed = true; }
    if (entry.isClusterSummary === undefined) { entry.isClusterSummary = false; changed = true; }
    if (entry.clusterTag === undefined) { entry.clusterTag = ''; changed = true; }
    if (entry.clusterChildIds === undefined) { entry.clusterChildIds = []; changed = true; }
    if (entry.clusterParentId === undefined) { entry.clusterParentId = ''; changed = true; }
    return changed;
}

function migrateToV44(entry) {
    let changed = false;
    if (entry.isTimelineSummary === undefined) { entry.isTimelineSummary = false; changed = true; }
    if (entry.timelineGroupKey === undefined) { entry.timelineGroupKey = ''; changed = true; }
    if (entry.timelineDayStart === undefined) { entry.timelineDayStart = null; changed = true; }
    if (entry.timelineDayEnd === undefined) { entry.timelineDayEnd = null; changed = true; }
    return changed;
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
        // v2.2 → v2.3 微迁移
        if (migrateToV23(entry)) {
            needsMigration = true;
        }
        if (migrateToV26(entry)) {
            needsMigration = true;
        }
        if (migrateToVEmbedding(entry)) {
            needsMigration = true;
        }
        if (migrateToV41(entry)) {
            needsMigration = true;
        }
        if (migrateToV44(entry)) {
            needsMigration = true;
        }
        return entry;
    });

    if (needsMigration) {
        await saveMemoriesData(chatId, memories);
        console.log(`[BB-Memory] 已将 ${chatId} 的记忆迁移到新格式`);
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
        truthStatus: options.truthStatus || 'true',
        visibility: options.visibility || 'public',
        confidence: options.confidence ?? 1.0,
        importance: options.importance ?? 0.5,
        emotionalWeight: options.emotionalWeight ?? 0.0,
        strength: 1.0,
        status: options.status || 'active',
        pinned: options.pinned || false,
        resident: options.resident || false,
        // ── v2.6 实体分级（路人少占 token）──
        npcTier: options.npcTier ?? '',
        itemTier: options.itemTier ?? '',
        indexCard: options.indexCard || '',
        relatedMemoryIds: Array.isArray(options.relatedMemoryIds) ? options.relatedMemoryIds : [],
        standaloneArchive: options.standaloneArchive !== undefined ? options.standaloneArchive : true,
        // ── v4.0.0: 语义向量 ──
        embedding: options.embedding ?? null,
        // ── v4.1.0: 故事时间 ──
        storyTime: options.storyTime || '',
        storyTimeSort: options.storyTimeSort ?? null,
        // ── v4.1.0: 标签聚类 ──
        isClusterSummary: options.isClusterSummary || false,
        clusterTag: options.clusterTag || '',
        clusterChildIds: Array.isArray(options.clusterChildIds) ? options.clusterChildIds : [],
        clusterParentId: options.clusterParentId || '',
        // ── v4.4.0: 时间线总结 ──
        isTimelineSummary: options.isTimelineSummary || false,
        timelineGroupKey: options.timelineGroupKey || '',
        timelineDayStart: options.timelineDayStart ?? null,
        timelineDayEnd: options.timelineDayEnd ?? null,
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
        hiddenNotes: Array.isArray(options.hiddenNotes) ? options.hiddenNotes : [],
    };

    memories.push(entry);
    await saveMemoriesData(chatId, memories);
    scheduleAutoBackup(chatId);
    return entry;
}

/**
 * 删除一条记忆
 */
export async function removeMemory(chatId, memoryId) {
    const memories = await getMemories(chatId);
    const filtered = memories.filter(m => m.id !== memoryId);

    if (filtered.length < memories.length) {
        await saveMemoriesData(chatId, filtered);
        scheduleAutoBackup(chatId);
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
    await saveMemoriesData(chatId, memories);
    scheduleAutoBackup(chatId);
    return entry;
}

// ═══════════════════════════════════════════════════════════
//  事实更新（带历史版本保留）
// ═══════════════════════════════════════════════════════════

/**
 * 更新记忆内容并将旧版本存入 history 数组。
 * 适用于事实随剧情推进需要修正的场景。
 */
export async function updateFactContent(chatId, memoryId, newContent, options = {}) {
    const memories = await getMemories(chatId);
    const entry = memories.find(m => m.id === memoryId);
    if (!entry) return null;

    if (!Array.isArray(entry.history)) entry.history = [];

    entry.history.push({
        content: entry.content,
        summary: entry.summary || '',
        truthStatus: entry.truthStatus || 'true',
        changedAt: Date.now(),
        reason: options.reason || '',
    });

    entry.content = newContent.trim();
    entry.keywords = extractKeywords(newContent);
    if (options.summary !== undefined) entry.summary = options.summary;
    if (options.truthStatus !== undefined) entry.truthStatus = options.truthStatus;
    if (options.verbatim !== undefined) entry.verbatim = options.verbatim;
    entry.updatedAt = Date.now();

    await saveMemoriesData(chatId, memories);
    scheduleAutoBackup(chatId);
    return entry;
}

// ═══════════════════════════════════════════════════════════
//  hiddenNotes CRUD
// ═══════════════════════════════════════════════════════════

/**
 * 向一条记忆添加隐藏备注
 */
export async function addHiddenNote(chatId, memoryId, note) {
    const memories = await getMemories(chatId);
    const entry = memories.find(m => m.id === memoryId);
    if (!entry) return null;

    if (!Array.isArray(entry.hiddenNotes)) entry.hiddenNotes = [];

    const noteEntry = {
        id: generateId(),
        type: note.type || 'note',
        content: (note.content || '').trim(),
        allowInjection: note.allowInjection ?? true,
        revealPolicy: note.revealPolicy || 'never',
        revealCondition: note.revealCondition || '',
        createdAt: Date.now(),
    };

    entry.hiddenNotes.push(noteEntry);
    entry.updatedAt = Date.now();
    await saveMemoriesData(chatId, memories);
    return noteEntry;
}

/**
 * 从一条记忆中删除指定隐藏备注
 */
export async function removeHiddenNote(chatId, memoryId, noteId) {
    const memories = await getMemories(chatId);
    const entry = memories.find(m => m.id === memoryId);
    if (!entry || !Array.isArray(entry.hiddenNotes)) return false;

    const before = entry.hiddenNotes.length;
    entry.hiddenNotes = entry.hiddenNotes.filter(n => n.id !== noteId);

    if (entry.hiddenNotes.length < before) {
        entry.updatedAt = Date.now();
        await saveMemoriesData(chatId, memories);
        return true;
    }
    return false;
}

/**
 * 清空指定聊天的所有记忆
 */
export async function clearMemories(chatId) {
    await saveMemoriesData(chatId, []);
    scheduleAutoBackup(chatId);
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
        if (memory.pinned) continue;
        if (memory.status === 'archived' || memory.status === 'deleted') continue;
        if (memory.strength > minStrength) {
            const importanceFactor = 1 - (memory.importance || 0.5) * 0.5;
            const decay = decayRate * importanceFactor;
            memory.strength = Math.max(minStrength, memory.strength - decay);
        }
    }

    await saveMemoriesData(chatId, memories);
}

export async function reinforceMemory(chatId, memoryId) {
    const memories = await getMemories(chatId);
    const entry = memories.find(m => m.id === memoryId);
    if (!entry) return;

    entry.strength = Math.min(1.0, entry.strength + 0.1);
    entry.accessCount = (entry.accessCount || 0) + 1;
    entry.lastAccessedAt = Date.now();

    await saveMemoriesData(chatId, memories);
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

    await saveMemoriesData(chatId, memories);
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

    await saveMemoriesData(chatId, memories);
    scheduleAutoBackup(chatId);
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
            await saveMemoriesData(chatId, existing);
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

// ═══════════════════════════════════════════════════════════
//  v4.4.0: 自动备份（跨设备同步）
// ═══════════════════════════════════════════════════════════

const BACKUP_METADATA_KEY = 'bb_memory_backup';
let backupTimer = null;

/**
 * 将当前聊天记忆导出到 chatMetadata（ST 服务器存储，跨设备可用）
 */
export async function exportMemoriesToChatMetadata(chatId) {
    if (!chatId) return { count: 0, size: 0 };

    const memories = await getMemories(chatId);
    const json = JSON.stringify(memories);
    const size = new TextEncoder().encode(json).length;

    try {
        const ctx = SillyTavern.getContext();
        if (ctx.chatMetadata) {
            ctx.chatMetadata[BACKUP_METADATA_KEY] = json;
            // v4.4.3: 必须保存聊天才能将 chatMetadata 持久化到 ST 服务器
            if (typeof ctx.saveChat === 'function') {
                ctx.saveChat();
            } else if (typeof ctx.saveChatDebounced === 'function') {
                ctx.saveChatDebounced();
            }
        }

        const settings = getSettings();
        settings.lastBackupTimestamp = Date.now();
        ctx.saveSettingsDebounced();

        if (settings.debugLogging) {
            console.log(`[BB-Memory] 备份到 chatMetadata: ${memories.length} 条, ${(size / 1024).toFixed(1)} KB`);
        }
    } catch (e) {
        console.warn('[BB-Memory] 备份到 chatMetadata 失败:', e);
    }

    return { count: memories.length, size };
}

/**
 * 从 chatMetadata 恢复记忆（启动时检查其他设备同步的数据）
 */
export async function importMemoriesFromChatMetadata(chatId) {
    if (!chatId) return { restored: 0, skipped: 0 };

    try {
        const ctx = SillyTavern.getContext();
        const backupJson = ctx.chatMetadata?.[BACKUP_METADATA_KEY];
        if (!backupJson) return { restored: 0, skipped: 0 };

        const backupMemories = JSON.parse(backupJson);
        if (!Array.isArray(backupMemories)) return { restored: 0, skipped: 0 };

        const existing = await getMemories(chatId);
        const existingIds = new Set(existing.map(m => m.id));

        let restored = 0;
        let skipped = 0;

        for (const mem of backupMemories) {
            if (!mem.id || !mem.content) continue;
            if (existingIds.has(mem.id)) {
                skipped++;
                continue;
            }
            existing.push(mem);
            restored++;
        }

        if (restored > 0) {
            await saveMemoriesData(chatId, existing);
            console.log(`[BB-Memory] 从 chatMetadata 恢复: ${restored} 条新记忆, ${skipped} 条已存在`);
        }

        return { restored, skipped };
    } catch (e) {
        console.warn('[BB-Memory] 从 chatMetadata 恢复失败:', e);
        return { restored: 0, skipped: 0 };
    }
}

/**
 * 安排延迟自动备份（记忆变更后 5 秒触发）
 */
export function scheduleAutoBackup(chatId) {
    const settings = getSettings();
    if (!settings.autoBackupEnabled) return;
    if (!chatId) return;

    if (backupTimer) clearTimeout(backupTimer);
    backupTimer = setTimeout(() => {
        exportMemoriesToChatMetadata(chatId).catch(e => {
            console.warn('[BB-Memory] 自动备份失败:', e);
        });
    }, 5000);
}

/**
 * memory-store.js —— BB-Memory v5.0 数据持久化层
 *
 * 四柱架构：NPC档案 / 物品栏 / 时间线 / 记忆条目 各自独立存储。
 * 含 v4→v5 迁移、升降格系统、跨设备备份同步。
 */

import { normalizeNpcTier, normalizeItemTier } from './entity-tiers.js';

// ═══ 模块名与存储键 ═══
export const MODULE_NAME = 'bb_memory';

const STORAGE_KEYS = {
    npc:      'bb_npc_chat_',
    item:     'bb_item_chat_',
    timeline: 'bb_timeline_chat_',
    mem:      'bb_mem_chat_',
    map:      'bb_map_chat_',           // v8.7.0 地图记忆
    threads:  'bb_timeline_threads_',   // v6.7.0 命名线程系统
};

const OLD_STORAGE_KEY = 'bb_memory_chat_';

// ═══ 默认设置 ═══
export const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    injectionTemplate: '[BB-Memory 长期记忆]\n{{memories}}',
    // 检索
    tokenBudget: 800,
    maxResults: 10,
    // v8.0.0 各柱注入上限（独立于 maxResults，后者仅控制记忆条目）
    npcInjectionMax: 8,
    itemInjectionMax: 5,
    timelineEndedMax: 3,
    mapInjectionMax: 8,             // v8.7.0 地图地点注入上限
    worldRealWorldRef: '',           // v8.7.1 全局现实原型参考
    floorRecentWindow: 6,            // 近 N 轮内的记忆用完整内容
    clueBoardInjectionEnabled: true,  // 线索板是否注入给 AI
    // AI 自动生成
    autoGenEnabled: false,
    autoGenMode: 'main',           // 'main' | 'custom'
    autoGenEndpoint: '',
    autoGenApiKey: '',
    autoGenModel: '',
    autoGenMaxExchanges: 3,
    maxMemoriesPerExchange: 3,
    extractionConfirmMode: 'semi', // 'active' | 'semi' | 'auto'
    activeConfirmStyle: 'popup',   // 'popup' | 'toast'
    contextWindowExchanges: 3,
    batchExtractionCount: 2,         // v8.0.0 每次并行请求的 exchange 数
    sourceRollbackFloorWindow: 10,   // 更新回滚快照保留的最近楼层数
    extractedMsgDisplay: 'hidden', // 'hidden' | 'transparent' | 'visible'
    extractionStyle: 'auto',             // 'auto' | 'daily' | 'drama' | 'custom'
    customExtractionBias: '',            // 自定义风格偏置（extractionStyle=custom 时生效）
    // 自定义提示词（v7.7.1）
    customCorePrinciples: '',            // 自定义核心原则（空=使用默认）
    customExtractionDimensions: '',      // 自定义提取维度（空=使用默认）
    customPromptTemplates: {},           // v9.1.3 统一提示词模板覆盖：{ templateKey: text }
    // Embedding
    embeddingEnabled: false,
    embeddingEndpoint: '',
    embeddingApiKey: '',
    embeddingModel: 'text-embedding-3-small',
    // 语义去重
    dedupEnabled: true,
    mergeSimilarityThreshold: 0.85,
    reduceSimilarityThreshold: 0.60,
    // 故事时间
    calendarDescription: '',
    // 升降格与维护
    diversityLimitPerTag: 5,       // 同一标签最多 N 条 core
    promotionCooldownRounds: 15,   // 升格冷却轮数
    hitScorePromoteThreshold: 20,  // 模糊/稳固记忆升级所需命中计数
    hitScoreEternalThreshold: 40,  // 核心记忆升级为永恒所需命中计数
    hitScoreDemoteThreshold: 20,   // 稳固/核心记忆降级所需未命中计数
    entityTierPromoteThreshold: 20,// NPC/物品等级升级所需命中计数
    entityTierDemoteThreshold: 20, // NPC/物品等级降级所需未命中计数
    maintenanceMode: 'semi',       // 'auto' | 'semi' | 'manual'
    maintenanceMemThreshold: 20,   // 记忆维护阈值
    maintenanceNpcThreshold: 5,    // NPC 维护阈值
    maintenanceItemThreshold: 20,  // 物品维护阈值
    // 记忆体检
    healthCheckDuplicateThreshold: 0.95,   // 近似重复检测阈值
    healthCheckIsolationThreshold: 0.30,   // 语义孤立检测阈值
    healthCheckStaleDays: 7,               // 长期休眠判定天数
    healthCheckStaleHitThreshold: 3,       // 休眠命中次数阈值
    healthCheckThreadStaleDays: 30,        // 线程长期停滞判定天数
    healthCheckClueStaleDays: 14,          // 线索板多久未更新时提醒
    // 时间线总结
    timelineSummaryEnabled: true,
    maxActiveThreads: 5,               // v6.7.0 活跃线程最大注入数
    // 自动备份
    autoBackupEnabled: false,
    chatMetadataBackupMaxKb: 2048,
    cloudBackupIncludeEmbeddings: false,
    lastBackupTimestamp: 0,
    // v8.2.3 API 预设配置
    apiProfiles: [],
    activeApiProfile: '',
    activityLog: [],             // 最近提醒/报错/关键行为，供仪表盘展示
    // v8.6.0 记忆分类
    categories: [],              // 分类名称列表
    enabledCategories: {},       // { name: true/false } 每个分类的注入开关（空=全部显示）
    // 存档槽
    currentSlotName: 'default',
    // 系统
    schemaVersion: '5.0',
    migratedFromV4: false,
    // 统计
    messageCountSinceDecay: 0,
    // 调试
    debugLogging: false,
});

// ═══ SillyTavern 接口 ═══

function getLocalForage() {
    return SillyTavern.libs.localforage;
}

function getContext() {
    return SillyTavern.getContext();
}

// ═══ 设置管理 ═══

export function getSettings() {
    const { extensionSettings } = getContext();
    if (!extensionSettings[MODULE_NAME]) {
        extensionSettings[MODULE_NAME] = structuredClone(DEFAULT_SETTINGS);
    }
    const s = extensionSettings[MODULE_NAME];
    // 合并新默认值
    for (const [key, val] of Object.entries(DEFAULT_SETTINGS)) {
        if (!(key in s)) s[key] = typeof val === 'object' ? structuredClone(val) : val;
    }
    return s;
}

export function updateSettings(patch) {
    const s = getSettings();
    Object.assign(s, patch);
    const ctx = getContext();
    if (typeof ctx.saveSettingsDebounced === 'function') ctx.saveSettingsDebounced();
    return s;
}

// ═══ 工具函数 ═══

function generateId() {
    return 'bb_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
}

function normalizeHitScore(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    return Math.max(-999, Math.min(999, Math.trunc(n)));
}

function defaultActiveTier(value) {
    return value || 'stable';
}

function storageKey(type, chatId) {
    return STORAGE_KEYS[type] + chatId;
}

// ═══════════════════════════════════════════════════════════
//  通用存取
// ═══════════════════════════════════════════════════════════

async function loadCollection(type, chatId) {
    if (!chatId) return [];
    const lf = getLocalForage();
    const data = await lf.getItem(storageKey(type, chatId));
    return Array.isArray(data) ? data : [];
}

async function saveCollection(type, chatId, data) {
    const lf = getLocalForage();
    await lf.setItem(storageKey(type, chatId), data);
}

const SOURCE_ROLLBACK_KEY = '_bbmemSourceRollback';

function deepClonePlain(value) {
    if (!value || typeof value !== 'object') return value;
    try {
        return JSON.parse(JSON.stringify(value));
    } catch {
        return { ...value };
    }
}

function cloneForSourceRollback(entry) {
    const copy = deepClonePlain(entry);
    if (!copy || typeof copy !== 'object') return null;
    delete copy.embedding;
    delete copy[SOURCE_ROLLBACK_KEY];
    return copy;
}

function getSourceRollbackFloorWindow() {
    const value = Number(getSettings().sourceRollbackFloorWindow);
    if (!Number.isFinite(value)) return 10;
    return Math.max(0, Math.min(200, Math.floor(value)));
}

function normalizeSourceFloor(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function stripUpdateSourceAttribution(patch) {
    const next = { ...patch };
    delete next.source;
    delete next.sourceExchange;
    delete next.sourceFloor;
    delete next.creationFloor;
    delete next.sourceMessageHash;
    delete next.sourceChatId;
    return next;
}

function pruneStaleSourceRollback(entry, currentFloor) {
    const rollback = entry?.[SOURCE_ROLLBACK_KEY];
    const rollbackFloor = normalizeSourceFloor(rollback?.sourceFloor);
    if (!rollback || rollbackFloor === null || currentFloor === null) return;
    const windowFloors = getSourceRollbackFloorWindow();
    if (rollbackFloor > currentFloor - windowFloors) return;

    const previous = rollback.previous || {};
    if (entry.sourceExchange === rollback.exchange) {
        entry.source = previous.source || entry.source;
        entry.sourceExchange = previous.sourceExchange || '';
        entry.sourceFloor = normalizeSourceFloor(previous.sourceFloor) ?? -1;
        entry.creationFloor = normalizeSourceFloor(previous.creationFloor) ?? entry.creationFloor;
        entry.sourceMessageHash = previous.sourceMessageHash || '';
        entry.sourceChatId = previous.sourceChatId || entry.sourceChatId || '';
    }
    delete entry[SOURCE_ROLLBACK_KEY];
}

function attachSourceRollback(entry, patch) {
    const exchange = patch?.sourceExchange;
    if (!entry || !exchange) return patch;
    const currentFloor = normalizeSourceFloor(patch.sourceFloor);
    pruneStaleSourceRollback(entry, currentFloor);
    if (getSourceRollbackFloorWindow() <= 0) return stripUpdateSourceAttribution(patch);
    if (entry[SOURCE_ROLLBACK_KEY]?.exchange === exchange) return patch;
    return {
        ...patch,
        [SOURCE_ROLLBACK_KEY]: {
            exchange,
            sourceFloor: currentFloor,
            createdAt: Date.now(),
            previous: cloneForSourceRollback(entry),
        },
    };
}

function restoreSourceRollback(current, rollback) {
    const previous = deepClonePlain(rollback?.previous);
    if (!previous || typeof previous !== 'object') return null;
    previous.id = previous.id || current.id;
    previous.embedding = previous.embedding ?? null;
    delete previous[SOURCE_ROLLBACK_KEY];
    return previous;
}

function rollbackCollectionByExchange(entries, exchangeHash) {
    let removed = 0;
    let restored = 0;
    let changed = false;
    const next = [];

    for (const entry of entries) {
        const rollback = entry?.[SOURCE_ROLLBACK_KEY];
        if (rollback?.exchange === exchangeHash) {
            const restoredEntry = restoreSourceRollback(entry, rollback);
            if (restoredEntry) {
                next.push(restoredEntry);
                restored++;
                changed = true;
                continue;
            }
        }
        if (entry?.sourceExchange === exchangeHash) {
            removed++;
            changed = true;
            continue;
        }
        next.push(entry);
    }

    return { entries: next, removed, restored, changed };
}

// ═══ v7.8.0 按聊天存储的日历描述 ═══

const CALENDAR_KEY = 'bb_calendar_chat_';

/**
 * 获取当前聊天的日历描述（per-chat，跟随角色切换）
 */
export function getCalendarDescription(chatId) {
    if (!chatId) return '';
    const lf = getLocalForage();
    // 异步读，但为兼容同步调用者返回 Promise
    return lf.getItem(CALENDAR_KEY + chatId).then(v => (typeof v === 'string') ? v : '');
}

/**
 * 设置当前聊天的日历描述
 */
export async function setCalendarDescription(chatId, value) {
    if (!chatId) return;
    const lf = getLocalForage();
    if (value && value.trim()) {
        await lf.setItem(CALENDAR_KEY + chatId, value.trim());
    } else {
        await lf.removeItem(CALENDAR_KEY + chatId);
    }
}

// ═══════════════════════════════════════════════════════════
//  NPC 档案 CRUD
// ═══════════════════════════════════════════════════════════

export async function getNpcProfiles(chatId) {
    return loadCollection('npc', chatId);
}

export async function addNpcProfile(chatId, data) {
    const profiles = await getNpcProfiles(chatId);
    const now = Date.now();
    const entry = {
        id: generateId(),
        name: data.name || '',
        role: data.role || '',
        personality: data.personality || '',
        appearance: data.appearance || '',
        status: data.status || '',
        location: data.location || '',
        relationships: Array.isArray(data.relationships) ? data.relationships : [],
        notes: Array.isArray(data.notes) ? data.notes : [],
        indexCard: data.indexCard || '',
        embedding: data.embedding ?? null,
        npcTier: normalizeNpcTier(data.npcTier) || 'minor',
        category: data.category || null,
        tags: Array.isArray(data.tags) ? data.tags : [],
        hitCount: data.hitCount || 0,
        hitScore: normalizeHitScore(data.hitScore),
        memoryTier: defaultActiveTier(data.memoryTier),
        archived: data.archived || false,
        createdAt: now,
        updatedAt: now,
        lastHitAt: null,
        source: data.source || 'manual',
        sourceExchange: data.sourceExchange || '',
        sourceFloor: typeof data.sourceFloor === 'number' ? data.sourceFloor : -1,
        creationFloor: typeof data.creationFloor === 'number' ? data.creationFloor : (typeof data.sourceFloor === 'number' ? data.sourceFloor : -1),
        sourceMessageHash: data.sourceMessageHash || '',
        sourceChatId: data.sourceChatId || '',
    };
    profiles.push(entry);
    await saveCollection('npc', chatId, profiles);
    scheduleAutoBackup(chatId);
    return entry;
}

/**
 * 添加或更新 NPC 档案（按 name 匹配合并）
 */
export async function upsertNpcProfile(chatId, data) {
    const profiles = await getNpcProfiles(chatId);
    const existing = profiles.find(p => p.name.toLowerCase() === (data.name || '').toLowerCase());
    if (existing) {
        return updateNpcProfile(chatId, existing.id, data);
    }
    return addNpcProfile(chatId, data);
}

export async function updateNpcProfile(chatId, id, patch) {
    const profiles = await getNpcProfiles(chatId);
    const entry = profiles.find(p => p.id === id);
    if (!entry) return null;
    patch = attachSourceRollback(entry, patch);
    const { id: _id, createdAt: _ca, ...safe } = patch;
    Object.assign(entry, safe);
    entry.updatedAt = Date.now();
    if (patch.npcTier) entry.npcTier = normalizeNpcTier(patch.npcTier) || entry.npcTier;
    await saveCollection('npc', chatId, profiles);
    scheduleAutoBackup(chatId);
    return entry;
}

export async function removeNpcProfile(chatId, id) {
    const profiles = await getNpcProfiles(chatId);
    const filtered = profiles.filter(p => p.id !== id);
    if (filtered.length < profiles.length) {
        await saveCollection('npc', chatId, filtered);
        scheduleAutoBackup(chatId);
        return true;
    }
    return false;
}

// ═══════════════════════════════════════════════════════════
//  物品栏 CRUD
// ═══════════════════════════════════════════════════════════

export async function getItems(chatId) {
    return loadCollection('item', chatId);
}

export async function addItem(chatId, data) {
    const items = await getItems(chatId);
    const now = Date.now();
    const entry = {
        id: generateId(),
        name: data.name || '',
        owner: data.owner || '',
        location: data.location || '',       // v8.7.0 物品所在地点
        status: data.status || 'held',       // held | used | lost | destroyed
        significance: data.significance || '',
        embedding: data.embedding ?? null,
        keepPermanent: data.keepPermanent || false,
        itemTier: normalizeItemTier(data.itemTier) || 'consumable',
        category: data.category || null,
        tags: Array.isArray(data.tags) ? data.tags : [],
        hitCount: data.hitCount || 0,
        hitScore: normalizeHitScore(data.hitScore),
        memoryTier: defaultActiveTier(data.memoryTier),
        archived: data.archived || false,
        createdAt: now,
        updatedAt: now,
        lastHitAt: null,
        source: data.source || 'manual',
        sourceExchange: data.sourceExchange || '',
        sourceFloor: typeof data.sourceFloor === 'number' ? data.sourceFloor : -1,
        creationFloor: typeof data.creationFloor === 'number' ? data.creationFloor : (typeof data.sourceFloor === 'number' ? data.sourceFloor : -1),
        sourceMessageHash: data.sourceMessageHash || '',
        sourceChatId: data.sourceChatId || '',
    };
    items.push(entry);
    await saveCollection('item', chatId, items);
    scheduleAutoBackup(chatId);
    return entry;
}

/**
 * 添加或更新物品（按 name 匹配合并）
 */
export async function upsertItem(chatId, data) {
    const items = await getItems(chatId);
    const existing = items.find(i => i.name.toLowerCase() === (data.name || '').toLowerCase());
    if (existing) {
        return updateItem(chatId, existing.id, data);
    }
    return addItem(chatId, data);
}

export async function updateItem(chatId, id, patch) {
    const items = await getItems(chatId);
    const entry = items.find(i => i.id === id);
    if (!entry) return null;
    patch = attachSourceRollback(entry, patch);
    const { id: _id, createdAt: _ca, ...safe } = patch;
    Object.assign(entry, safe);
    entry.updatedAt = Date.now();
    if (patch.itemTier) entry.itemTier = normalizeItemTier(patch.itemTier) || entry.itemTier;
    await saveCollection('item', chatId, items);
    scheduleAutoBackup(chatId);
    return entry;
}

export async function removeItem(chatId, id) {
    const items = await getItems(chatId);
    const filtered = items.filter(i => i.id !== id);
    if (filtered.length < items.length) {
        await saveCollection('item', chatId, filtered);
        scheduleAutoBackup(chatId);
        return true;
    }
    return false;
}

// ═══════════════════════════════════════════════════════════
//  时间线 CRUD
// ═══════════════════════════════════════════════════════════

export async function getTimeline(chatId) {
    return loadCollection('timeline', chatId);
}

export async function addTimelineEntry(chatId, data) {
    const timeline = await getTimeline(chatId);
    const now = Date.now();
    const entry = {
        id: generateId(),
        storyTime: data.storyTime || '',
        storyTimeSort: data.storyTimeSort ?? null,
        event: data.event || '',
        summary: data.summary || '',
        participants: Array.isArray(data.participants) ? data.participants : [],
        location: data.location || '',
        isActive: data.isActive !== undefined ? data.isActive : true,
        status: data.status || 'ongoing',   // ongoing | ended | foreshadow
        category: data.category || null,
        impact: data.impact || '',
        tags: Array.isArray(data.tags) ? data.tags : [],
        hitCount: data.hitCount || 0,
        hitScore: normalizeHitScore(data.hitScore),
        memoryTier: defaultActiveTier(data.memoryTier),
        archived: data.archived || false,
        relatedEventIds: Array.isArray(data.relatedEventIds) ? data.relatedEventIds : [],
        subEntries: Array.isArray(data.subEntries) ? data.subEntries : [],  // v8.0.0 子条目
        embedding: data.embedding ?? null,
        createdAt: now,
        updatedAt: now,
        lastHitAt: null,
        source: data.source || 'manual',
        sourceExchange: data.sourceExchange || '',
        sourceFloor: typeof data.sourceFloor === 'number' ? data.sourceFloor : -1,
        creationFloor: typeof data.creationFloor === 'number' ? data.creationFloor : (typeof data.sourceFloor === 'number' ? data.sourceFloor : -1),
        sourceMessageHash: data.sourceMessageHash || '',
        sourceChatId: data.sourceChatId || '',
    };
    timeline.push(entry);
    // 按 storyTimeSort 排序
    timeline.sort((a, b) => (a.storyTimeSort ?? 0) - (b.storyTimeSort ?? 0));
    await saveCollection('timeline', chatId, timeline);
    scheduleAutoBackup(chatId);
    return entry;
}

/**
 * 更新或合并时间线条目（按 event 摘要 + isActive 去重）
 */
export async function upsertTimelineEntry(chatId, data) {
    const timeline = await getTimeline(chatId);
    // 查找同名进行中事件
    const existing = timeline.find(t =>
        t.isActive && t.event.toLowerCase() === (data.event || '').toLowerCase()
    );
    if (existing) {
        const patch = { ...data };
        if (data.summary) {
            patch.summary = existing.summary + ' → ' + data.summary;
        }
        patch.updatedAt = Date.now();
        return updateTimelineEntry(chatId, existing.id, patch);
    }
    return addTimelineEntry(chatId, data);
}

export async function updateTimelineEntry(chatId, id, patch) {
    const timeline = await getTimeline(chatId);
    const entry = timeline.find(t => t.id === id);
    if (!entry) return null;
    patch = attachSourceRollback(entry, patch);
    const { id: _id, createdAt: _ca, ...safe } = patch;
    Object.assign(entry, safe);
    entry.updatedAt = Date.now();
    if (typeof patch.isActive === 'boolean' && !patch.isActive) {
        entry.isActive = false;
        entry.status = 'ended';
    }
    await saveCollection('timeline', chatId, timeline);
    scheduleAutoBackup(chatId);
    return entry;
}

export async function removeTimelineEntry(chatId, id) {
    const timeline = await getTimeline(chatId);
    const filtered = timeline.filter(t => t.id !== id);
    if (filtered.length < timeline.length) {
        await saveCollection('timeline', chatId, filtered);
        scheduleAutoBackup(chatId);
        return true;
    }
    return false;
}

// ═══════════════════════════════════════════════════════════
//  v6.7.0 命名线程系统 (Timeline Threads)
// ═══════════════════════════════════════════════════════════

/**
 * 获取所有时间线线程
 */
export async function getTimelineThreads(chatId) {
    return loadCollection('threads', chatId);
}

/**
 * 保存时间线线程（全量替换）
 */
export async function saveTimelineThreads(chatId, threads) {
    await saveCollection('threads', chatId, threads);
    scheduleAutoBackup(chatId);
}

/**
 * 更新或新增一个线程
 * @param {string} chatId
 * @param {object} threadData - { id?, name, type, status, priority, parentThreadId, entries, embedding }
 */
export async function upsertTimelineThread(chatId, threadData) {
    const threads = await getTimelineThreads(chatId);
    const now = Date.now();

    if (threadData.id) {
        const existing = threads.find(t => t.id === threadData.id);
        if (existing) {
            const { id: _id, createdAt: _ca, ...safe } = threadData;
            Object.assign(existing, safe);
            existing.updatedAt = now;
            await saveTimelineThreads(chatId, threads);
            return existing;
        }
    }

    const thread = {
        id: threadData.id || generateId(),
        name: threadData.name || '',
        type: threadData.type || 'plot',        // plot | emotional | side | world
        status: threadData.status || 'ongoing',  // ongoing | paused | ended | archived | resident
        priority: threadData.priority || 'medium', // high | medium | low
        parentThreadId: threadData.parentThreadId || null,
        summary: threadData.summary || '',        // v7.3.0 线程一句话总结
        entries: Array.isArray(threadData.entries) ? threadData.entries : [],
        embedding: threadData.embedding || null,
        createdAt: now,
        updatedAt: now,
    };
    threads.push(thread);
    await saveTimelineThreads(chatId, threads);
    return thread;
}

/**
 * 删除一个线程
 */
export async function removeTimelineThread(chatId, threadId) {
    const threads = await getTimelineThreads(chatId);
    const filtered = threads.filter(t => t.id !== threadId);
    if (filtered.length < threads.length) {
        await saveTimelineThreads(chatId, filtered);
        return true;
    }
    return false;
}

// ═══════════════════════════════════════════════════════════
//  记忆条目 CRUD
// ═══════════════════════════════════════════════════════════

export async function getMemories(chatId) {
    return loadCollection('mem', chatId);
}

export async function addMemory(chatId, data) {
    const memories = await getMemories(chatId);
    const now = Date.now();
    const entry = {
        id: generateId(),
        title: data.title || '',
        type: data.type || 'event',           // event | emotion | habit | fact
        summary: data.summary || '',
        storyTime: data.storyTime || '',
        storyTimeSort: data.storyTimeSort ?? null,
        content: (data.content || '').trim(),
        verbatim: data.verbatim || '',
        subject: data.subject || '',
        target: data.target || '',
        importance: typeof data.importance === 'number' ? Math.max(0, Math.min(1, data.importance)) : 0.5,
        emotionalWeight: typeof data.emotionalWeight === 'number' ? Math.max(0, Math.min(1, data.emotionalWeight)) : 0.0,
        tags: Array.isArray(data.tags) ? data.tags : [],
        embedding: data.embedding ?? null,
        hiddenNotes: Array.isArray(data.hiddenNotes) ? data.hiddenNotes : [],
        truthStatus: data.truthStatus || 'true',
        hitCount: data.hitCount || 0,
        hitScore: normalizeHitScore(data.hitScore),
        memoryTier: defaultActiveTier(data.memoryTier),
        category: data.category || null,
        archived: data.archived || false,
        relatedMemoryIds: Array.isArray(data.relatedMemoryIds) ? data.relatedMemoryIds : [],
        isTimelineSummary: data.isTimelineSummary || false,
        timelineGroupKey: data.timelineGroupKey || '',
        createdAt: now,
        updatedAt: now,
        lastHitAt: null,
        lastPromotedAt: null,                 // 上次升格时间戳（冷却用）
        source: data.source || 'manual',
        sourceMessageIds: Array.isArray(data.sourceMessageIds) ? data.sourceMessageIds : [],
        sourceExchange: data.sourceExchange || '',
        sourceFloor: typeof data.sourceFloor === 'number' ? data.sourceFloor : -1,
        creationFloor: typeof data.creationFloor === 'number' ? data.creationFloor : (typeof data.sourceFloor === 'number' ? data.sourceFloor : -1),
        sourceMessageHash: data.sourceMessageHash || '',
        sourceChatId: data.sourceChatId || '',
    };
    memories.push(entry);
    await saveCollection('mem', chatId, memories);
    scheduleAutoBackup(chatId);
    return entry;
}

export async function updateMemory(chatId, id, patch) {
    const memories = await getMemories(chatId);
    const entry = memories.find(m => m.id === id);
    if (!entry) return null;
    patch = attachSourceRollback(entry, patch);
    const { id: _id, createdAt: _ca, ...safe } = patch;
    Object.assign(entry, safe);
    entry.updatedAt = Date.now();
    if (patch.importance !== undefined) {
        entry.importance = Math.max(0, Math.min(1, patch.importance));
    }
    await saveCollection('mem', chatId, memories);
    scheduleAutoBackup(chatId);
    return entry;
}

export async function removeMemory(chatId, id) {
    const memories = await getMemories(chatId);
    const filtered = memories.filter(m => m.id !== id);
    if (filtered.length < memories.length) {
        await saveCollection('mem', chatId, filtered);
        scheduleAutoBackup(chatId);
        return true;
    }
    return false;
}

// ═══════════════════════════════════════════════════════════
//  v7.6.0 统一归档系统
// ═══════════════════════════════════════════════════════════

/**
 * 判断条目是否已归档
 * 向后兼容：记忆条目的 status === 'archived' 也视为归档
 */
export function isArchived(entry) {
    if (!entry) return false;
    if (entry.archived === true) return true;
    if (entry.status === 'archived') return true;
    return false;
}

/**
 * 归档指定条目（支持四柱 + 线程）
 * @param {string} chatId
 * @param {string} type - 'npc' | 'item' | 'timeline' | 'mem' | 'thread'
 * @param {string} id
 */
export async function archiveEntry(chatId, type, id) {
    switch (type) {
        case 'npc': return updateNpcProfile(chatId, id, { archived: true });
        case 'item': return updateItem(chatId, id, { archived: true });
        case 'timeline': return updateTimelineEntry(chatId, id, { archived: true, isActive: false });
        case 'thread': return upsertTimelineThread(chatId, { id, status: 'archived' });
        case 'map': { const { archiveLocation } = await import('./map-store.js'); return archiveLocation(chatId, id); }
        default: return updateMemory(chatId, id, { archived: true, status: 'archived' });
    }
}

/**
 * 从归档恢复条目（保持原等级不变）
 * @param {string} chatId
 * @param {string} type - 'npc' | 'item' | 'timeline' | 'mem' | 'thread'
 * @param {string} id
 */
export async function restoreEntry(chatId, type, id) {
    switch (type) {
        case 'npc': return updateNpcProfile(chatId, id, { archived: false });
        case 'item': return updateItem(chatId, id, { archived: false });
        case 'timeline': return updateTimelineEntry(chatId, id, { archived: false, isActive: true, status: 'ongoing' });
        case 'thread': return upsertTimelineThread(chatId, { id, status: 'ongoing' });
        case 'map': { const { restoreLocation } = await import('./map-store.js'); return restoreLocation(chatId, id); }
        default: return updateMemory(chatId, id, { archived: false, status: 'active' });
    }
}

// ═══════════════════════════════════════════════════════════
//  v8.6.0 记忆分类管理
// ═══════════════════════════════════════════════════════════

/**
 * 添加新分类
 */
export async function addCategory(categoryName) {
    const name = (categoryName || '').trim();
    if (!name) return false;
    const settings = getSettings();
    if (settings.categories.includes(name)) return false;
    settings.categories = [...settings.categories, name];
    await updateSettings(settings);
    return true;
}

/**
 * 删除分类，所有该分类下的条目恢复为 null（通用）
 */
export async function removeCategory(chatId, categoryName) {
    const settings = getSettings();
    const name = (categoryName || '').trim();
    if (!name) return false;
    settings.categories = settings.categories.filter(c => c !== name);
    delete settings.enabledCategories[name];
    await updateSettings(settings);

    // 将四柱中属于该分类的条目重置为 null
    const pillars = ['npc', 'item', 'timeline', 'mem'];
    for (const type of pillars) {
        const items = await loadCollection(type, chatId);
        let changed = false;
        for (const item of items) {
            if (item.category === name) { item.category = null; changed = true; }
        }
        if (changed) await saveCollection(type, chatId, items);
    }
    return true;
}

/**
 * 重命名分类
 */
export async function renameCategory(chatId, oldName, newName) {
    const settings = getSettings();
    const trimmedNew = (newName || '').trim();
    if (!trimmedNew || !oldName) return false;
    const idx = settings.categories.indexOf(oldName);
    if (idx === -1) return false;

    settings.categories[idx] = trimmedNew;
    if (settings.enabledCategories[oldName] !== undefined) {
        settings.enabledCategories[trimmedNew] = settings.enabledCategories[oldName];
        delete settings.enabledCategories[oldName];
    }
    await updateSettings(settings);

    // 更新四柱中属于该分类的条目
    const pillars = ['npc', 'item', 'timeline', 'mem'];
    for (const type of pillars) {
        const items = await loadCollection(type, chatId);
        let changed = false;
        for (const item of items) {
            if (item.category === oldName) { item.category = trimmedNew; changed = true; }
        }
        if (changed) await saveCollection(type, chatId, items);
    }
    return true;
}

/**
 * 切换分类的注入开关
 */
export async function toggleCategory(categoryName, enabled) {
    const settings = getSettings();
    const name = (categoryName || '').trim();
    if (!name || !settings.categories.includes(name)) return false;
    settings.enabledCategories[name] = !!enabled;
    // 清理不存在的分类残留
    for (const key of Object.keys(settings.enabledCategories)) {
        if (!settings.categories.includes(key)) delete settings.enabledCategories[key];
    }
    await updateSettings(settings);
    return true;
}

/**
 * 获取分类统计信息
 */
export async function getCategoryStats(chatId) {
    const stats = {};
    const pillars = [
        { type: 'npc', label: 'NPC' },
        { type: 'item', label: '物品' },
        { type: 'timeline', label: '时间线' },
        { type: 'mem', label: '记忆' },
    ];
    for (const p of pillars) {
        const items = await loadCollection(p.type, chatId);
        for (const item of items) {
            const cat = item.category || '(通用)';
            if (!stats[cat]) stats[cat] = { npc: 0, item: 0, timeline: 0, mem: 0 };
            stats[cat][p.type]++;
        }
    }
    return stats;
}

// ═══════════════════════════════════════════════════════════
//  升降格系统
// ═══════════════════════════════════════════════════════════

const TIER_ORDER = ['transient', 'stable', 'core', 'eternal'];
const PROMOTE_THRESHOLDS = { stable: 3, core: 8 };
const DEMOTE_MISS_ROUNDS = { core: 30, stable: 20 };    // N 轮未命中触发降格 (v7.8.0 stable 60→20)
const MAINTENANCE_MISS_ROUNDS = 30;                      // transient 未命中提醒
const PROMOTION_COOLDOWN_MS = 15 * 60 * 1000;            // 15 分钟冷却（模拟"轮"）

/**
 * 记录命中（interceptor 检索到某条记忆/NPC/物品时调用）
 * 自动处理升格。
 */
async function legacyRecordHit(chatId, collection, id) {
    let items;
    switch (collection) {
        case 'npc': items = await getNpcProfiles(chatId); break;
        case 'item': items = await getItems(chatId); break;
        case 'timeline': items = await getTimeline(chatId); break;
        case 'mem': items = await getMemories(chatId); break;
        case 'map': {
            const { getMap, setMap } = await import('./map-store.js');
            const map = await getMap(chatId);
            const entry = map?.locations?.[id];
            if (!entry) return null;
            entry.hitCount = (entry.hitCount || 0) + 1;
            entry.lastHitAt = Date.now();
            entry.updatedAt = Date.now();
            await setMap(chatId, map);
            return entry;
        }
        default: return null;
    }
    const entry = items.find(e => e.id === id);
    if (!entry) return null;

    entry.hitCount = (entry.hitCount || 0) + 1;
    entry.lastHitAt = Date.now();

    // 检查升格
    const currentTier = entry.memoryTier || 'transient';
    const currentIdx = TIER_ORDER.indexOf(currentTier);

    if (currentTier !== 'eternal' && currentIdx < TIER_ORDER.length - 1) {
        const nextTier = TIER_ORDER[currentIdx + 1];
        const threshold = PROMOTE_THRESHOLDS[nextTier];
        if (threshold && entry.hitCount >= threshold) {
            // 冷却检查
            const cooldown = getSettings().promotionCooldownRounds * 60 * 1000;
            if (!entry.lastPromotedAt || (Date.now() - entry.lastPromotedAt) > cooldown) {
                // 多样性检查
                if (await checkDiversityLimit(chatId, collection, entry, nextTier)) {
                    entry.memoryTier = nextTier;
                    entry.lastPromotedAt = Date.now();
                    if (getSettings().debugLogging) {
                        console.log(`[BB-Memory] 升格: ${entry.name || entry.title || entry.id} → ${nextTier}`);
                    }
                }
            }
        }
    }

    const saveFn = {
        npc: (d) => saveCollection('npc', chatId, d),
        item: (d) => saveCollection('item', chatId, d),
        timeline: (d) => saveCollection('timeline', chatId, d),
        mem: (d) => saveCollection('mem', chatId, d),
    }[collection];

    await saveFn(items);
    return entry;
}

/**
 * 批量记录命中
 */
async function legacyRecordHits(chatId, hits) {
    for (const hit of hits) {
        await legacyRecordHit(chatId, hit.collection, hit.id);
    }
}

const MEMORY_TIER_ORDER_V905 = ['transient', 'stable', 'core', 'eternal'];
const NPC_TIER_ORDER_V905 = ['background', 'minor', 'important', 'core'];
const ITEM_TIER_ORDER_V905 = ['background', 'consumable', 'clue', 'equipped', 'key'];

function getPositiveSetting(key, fallback) {
    const n = Number(getSettings()[key]);
    return Number.isFinite(n) && n > 0 ? Math.trunc(n) : fallback;
}

function isEntryActiveForHitCycle(entry) {
    return entry && !isArchived(entry) && entry.status !== 'deleted';
}

function bumpHitScore(entry, delta, now) {
    const before = normalizeHitScore(entry.hitScore);
    entry.hitScore = normalizeHitScore(before + delta);
    if (delta > 0) {
        entry.hitCount = (entry.hitCount || 0) + 1;
        entry.lastHitAt = now;
    }
    entry.updatedAt = now;
    return entry.hitScore !== before || delta > 0;
}

async function applyMemoryTierScore(chatId, collection, entry, delta, now) {
    if (!isEntryActiveForHitCycle(entry)) return false;
    const tier = entry.memoryTier || 'stable';
    if (tier === 'transient' && delta < 0) return false;
    let changed = bumpHitScore(entry, delta, now);
    if (tier === 'eternal') return changed;

    const promoteThreshold = getPositiveSetting('hitScorePromoteThreshold', 20);
    const eternalThreshold = getPositiveSetting('hitScoreEternalThreshold', 40);
    const demoteThreshold = getPositiveSetting('hitScoreDemoteThreshold', 20);

    if (delta > 0) {
        let nextTier = '';
        const threshold = tier === 'core' ? eternalThreshold : promoteThreshold;
        if (entry.hitScore >= threshold) {
            const idx = MEMORY_TIER_ORDER_V905.indexOf(tier);
            if (idx >= 0 && idx < MEMORY_TIER_ORDER_V905.length - 1) {
                nextTier = MEMORY_TIER_ORDER_V905[idx + 1];
            }
        }
        if (nextTier && await checkDiversityLimit(chatId, collection, entry, nextTier)) {
            entry.memoryTier = nextTier;
            entry.hitScore = 0;
            entry.lastPromotedAt = now;
            entry.updatedAt = now;
            changed = true;
            if (getSettings().debugLogging) {
                console.log(`[BB-Memory] tier up: ${entry.name || entry.title || entry.id} -> ${nextTier}`);
            }
        }
    } else if (delta < 0 && entry.hitScore <= -demoteThreshold) {
        const idx = MEMORY_TIER_ORDER_V905.indexOf(tier);
        if (idx > 0) {
            entry.memoryTier = MEMORY_TIER_ORDER_V905[idx - 1];
            entry.hitScore = 0;
            entry.updatedAt = now;
            changed = true;
            if (getSettings().debugLogging) {
                console.log(`[BB-Memory] tier down: ${entry.name || entry.title || entry.id} -> ${entry.memoryTier}`);
            }
        }
    }
    return changed;
}

function applyOrderedEntityTierScore(entry, delta, tierKey, order, now) {
    if (!isEntryActiveForHitCycle(entry)) return false;
    if (entry.keepPermanent && delta < 0) return false;
    const current = entry[tierKey] || order[1];
    const idx = order.indexOf(current);
    if (idx < 0) return false;
    if (idx === 0 && delta < 0) return false;
    let changed = bumpHitScore(entry, delta, now);

    const promoteThreshold = getPositiveSetting('entityTierPromoteThreshold', 20);
    const demoteThreshold = getPositiveSetting('entityTierDemoteThreshold', 20);

    if (delta > 0 && entry.hitScore >= promoteThreshold && idx < order.length - 1) {
        entry[tierKey] = order[idx + 1];
        entry.hitScore = 0;
        entry.updatedAt = now;
        changed = true;
    } else if (delta < 0 && entry.hitScore <= -demoteThreshold && idx > 0) {
        entry[tierKey] = order[idx - 1];
        entry.hitScore = 0;
        entry.updatedAt = now;
        changed = true;
    }
    return changed;
}

async function recordMapHits(chatId, ids, now) {
    if (!ids.size) return;
    const { getMap, setMap } = await import('./map-store.js');
    const map = await getMap(chatId);
    let changed = false;
    for (const id of ids) {
        const entry = map?.locations?.[id];
        if (!entry || entry.archived) continue;
        entry.hitCount = (entry.hitCount || 0) + 1;
        entry.lastHitAt = now;
        entry.updatedAt = now;
        changed = true;
    }
    if (changed) await setMap(chatId, map);
}

export async function recordHit(chatId, collection, id) {
    const result = await recordHits(chatId, [{ collection, id }], { countMisses: false });
    return result?.updated?.find(e => e.collection === collection && e.id === id)?.entry || null;
}

export async function recordHits(chatId, hits, options = {}) {
    const now = Date.now();
    const countMisses = options.countMisses === true;
    const hitSets = {
        npc: new Set(),
        item: new Set(),
        timeline: new Set(),
        mem: new Set(),
        map: new Set(),
    };

    for (const hit of hits || []) {
        if (!hit?.id || !hitSets[hit.collection]) continue;
        hitSets[hit.collection].add(hit.id);
    }

    const collections = [
        { name: 'npc', loader: getNpcProfiles, saver: (d) => saveCollection('npc', chatId, d), apply: (entry, delta) => applyOrderedEntityTierScore(entry, delta, 'npcTier', NPC_TIER_ORDER_V905, now) },
        { name: 'item', loader: getItems, saver: (d) => saveCollection('item', chatId, d), apply: (entry, delta) => applyOrderedEntityTierScore(entry, delta, 'itemTier', ITEM_TIER_ORDER_V905, now) },
        { name: 'timeline', loader: getTimeline, saver: (d) => saveCollection('timeline', chatId, d), apply: (entry, delta) => applyMemoryTierScore(chatId, 'timeline', entry, delta, now) },
        { name: 'mem', loader: getMemories, saver: (d) => saveCollection('mem', chatId, d), apply: (entry, delta) => applyMemoryTierScore(chatId, 'mem', entry, delta, now) },
    ];

    const updated = [];
    for (const cfg of collections) {
        const items = await cfg.loader(chatId);
        let changed = false;
        const ids = hitSets[cfg.name];
        if (!countMisses && ids.size === 0) continue;

        for (const entry of items) {
            if (!isEntryActiveForHitCycle(entry)) continue;
            const isHit = ids.has(entry.id);
            if (!isHit && !countMisses) continue;
            const delta = isHit ? 1 : -1;
            if (await cfg.apply(entry, delta)) {
                changed = true;
                updated.push({ collection: cfg.name, id: entry.id, entry });
            }
        }
        if (changed) await cfg.saver(items);
    }

    await recordMapHits(chatId, hitSets.map, now);
    if (updated.length) scheduleAutoBackup(chatId);
    return { updated, skipped: false };
}

/**
 * 多样性保护：同一标签的 core 记忆不超上限
 */
async function checkDiversityLimit(chatId, collection, entry, targetTier) {
    if (targetTier !== 'core') return true;
    const settings = getSettings();
    const limit = settings.diversityLimitPerTag || 5;

    // 提取条目标签
    const entryTags = (entry.tags || []).map(t => typeof t === 'string' ? t : t.name).filter(Boolean);
    if (!entryTags.length) return true;

    let allItems;
    switch (collection) {
        case 'npc': allItems = await getNpcProfiles(chatId); break;
        case 'item': allItems = await getItems(chatId); break;
        case 'timeline': allItems = await getTimeline(chatId); break;
        case 'mem': allItems = await getMemories(chatId); break;
        default: return true;
    }

    for (const tag of entryTags) {
        const count = allItems.filter(item => {
            if (item.id === entry.id) return false;
            if (item.memoryTier !== 'core' && item.memoryTier !== 'eternal') return false;
            const itemTags = (item.tags || []).map(t => typeof t === 'string' ? t : t.name);
            return itemTags.includes(tag);
        }).length;
        if (count >= limit) {
            if (getSettings().debugLogging) {
                console.log(`[BB-Memory] 多样性限制: 标签"${tag}"已有 ${count} 条 core，阻止升格`);
            }
            return false;
        }
    }
    return true;
}

/**
 * 检查降格（在拦截器中每轮调用）
 * 长期未命中 → 自动降格
 */
async function legacyCheckDemotions(chatId) {
    const settings = getSettings();
    const now = Date.now();
    const roundMs = 60 * 1000; // 近似每轮 1 分钟

    const collections = [
        { name: 'npc', loader: getNpcProfiles, saver: (d) => saveCollection('npc', chatId, d) },
        { name: 'item', loader: getItems, saver: (d) => saveCollection('item', chatId, d) },
        { name: 'timeline', loader: getTimeline, saver: (d) => saveCollection('timeline', chatId, d) },
        { name: 'mem', loader: getMemories, saver: (d) => saveCollection('mem', chatId, d) },
    ];

    const results = { demoted: [], maintenanceCandidates: [] };

    for (const { name, loader, saver } of collections) {
        const items = await loader(chatId);
        let changed = false;

        for (const item of items) {
            if (item.memoryTier === 'eternal') continue;

            const lastHit = item.lastHitAt || item.createdAt;
            const roundsSinceHit = Math.floor((now - lastHit) / roundMs);

            if (item.memoryTier === 'core' && roundsSinceHit >= DEMOTE_MISS_ROUNDS.core) {
                item.memoryTier = 'stable';
                item.updatedAt = now;
                changed = true;
                results.demoted.push({ collection: name, id: item.id, from: 'core', to: 'stable' });
                if (settings.debugLogging) {
                    console.log(`[BB-Memory] 降格: ${item.name || item.title || item.id} core→stable (${roundsSinceHit}轮未命中)`);
                }
            } else if (item.memoryTier === 'stable' && roundsSinceHit >= DEMOTE_MISS_ROUNDS.stable) {
                item.memoryTier = 'transient';
                item.updatedAt = now;
                changed = true;
                results.demoted.push({ collection: name, id: item.id, from: 'stable', to: 'transient' });
            } else if (item.memoryTier === 'transient' && roundsSinceHit >= MAINTENANCE_MISS_ROUNDS) {
                results.maintenanceCandidates.push({ collection: name, item });
            }
        }

        if (changed) await saver(items);
    }

    return results;
}

export async function checkDemotions(chatId) {
    return { demoted: [], maintenanceCandidates: [], mode: 'hitScore', chatId };
}

// ═══════════════════════════════════════════════════════════
//  批量清除
// ═══════════════════════════════════════════════════════════

export async function clearAllData(chatId) {
    const lf = getLocalForage();
    await Promise.all([
        lf.removeItem(storageKey('npc', chatId)),
        lf.removeItem(storageKey('item', chatId)),
        lf.removeItem(storageKey('timeline', chatId)),
        lf.removeItem(storageKey('mem', chatId)),
        lf.removeItem(storageKey('map', chatId)),
        lf.removeItem(storageKey('threads', chatId)),
        lf.removeItem('bb_clue_board_' + chatId),
        lf.removeItem('bb_calendar_chat_' + chatId),
        lf.removeItem('bb_memory_exchanges_' + chatId),
    ]);
    const ctx = getContext();
    if (!ctx.chatMetadata) ctx.chatMetadata = {};
    ctx.chatMetadata[BACKUP_METADATA_KEY] = JSON.stringify({
        version: '9.1.3',
        timestamp: Date.now(),
        npc: [],
        items: [],
        timeline: [],
        memories: [],
        threads: [],
        map: { locations: {} },
        clueBoard: { nodes: [], connections: [] },
    });
    await saveChatMetadata(ctx);
}

/**
 * 按 exchange hash 删除关联的记忆条目（支持 ROLL 后清理）
 */
export async function deleteByExchange(chatId, exchangeHash) {
    if (!exchangeHash) return { npc: 0, items: 0, timeline: 0, memories: 0, map: 0 };
    const [npc, items, timeline, memories] = await Promise.all([
        getNpcProfiles(chatId), getItems(chatId), getTimeline(chatId), getMemories(chatId),
    ]);
    const npcResult = rollbackCollectionByExchange(npc, exchangeHash);
    const itemResult = rollbackCollectionByExchange(items, exchangeHash);
    const timelineResult = rollbackCollectionByExchange(timeline, exchangeHash);
    const memoryResult = rollbackCollectionByExchange(memories, exchangeHash);
    const removed = {
        npc: npcResult.removed + npcResult.restored,
        items: itemResult.removed + itemResult.restored,
        timeline: timelineResult.removed + timelineResult.restored,
        memories: memoryResult.removed + memoryResult.restored,
        map: 0,
        deleted: {
            npc: npcResult.removed,
            items: itemResult.removed,
            timeline: timelineResult.removed,
            memories: memoryResult.removed,
            map: 0,
        },
        restored: {
            npc: npcResult.restored,
            items: itemResult.restored,
            timeline: timelineResult.restored,
            memories: memoryResult.restored,
            map: 0,
        },
    };

    try {
        const { getMap, setMap } = await import('./map-store.js');
        const map = await getMap(chatId);
        const locations = map?.locations || {};
        const removedIds = new Set();
        let mapChanged = false;

        for (const [id, loc] of Object.entries(locations)) {
            const rollback = loc?.[SOURCE_ROLLBACK_KEY];
            if (rollback?.exchange === exchangeHash) {
                const restoredLoc = restoreSourceRollback(loc, rollback);
                if (restoredLoc) {
                    restoredLoc.id = id;
                    locations[id] = restoredLoc;
                    removed.map++;
                    removed.restored.map++;
                    mapChanged = true;
                    continue;
                }
            }
            if (loc?.sourceExchange === exchangeHash) {
                delete locations[id];
                removedIds.add(id);
                removed.map++;
                removed.deleted.map++;
                mapChanged = true;
            }
        }

        if (removedIds.size) {
            for (const loc of Object.values(locations)) {
                if (!Array.isArray(loc.edges)) continue;
                const nextEdges = loc.edges.filter(edge => !removedIds.has(edge.toId));
                if (nextEdges.length !== loc.edges.length) {
                    loc.edges = nextEdges;
                    mapChanged = true;
                }
            }
        }

        if (mapChanged) await setMap(chatId, map, { skipBackup: true });
    } catch { /* ignore map rollback when map module is unavailable */ }

    const saves = [];
    if (npcResult.changed) saves.push(saveCollection('npc', chatId, npcResult.entries));
    if (itemResult.changed) saves.push(saveCollection('item', chatId, itemResult.entries));
    if (timelineResult.changed) saves.push(saveCollection('timeline', chatId, timelineResult.entries));
    if (memoryResult.changed) saves.push(saveCollection('mem', chatId, memoryResult.entries));
    if (saves.length) await Promise.all(saves);
    if (saves.length || removed.map) scheduleAutoBackup(chatId);
    return removed;
}

async function deleteByExchangeLegacy(chatId, exchangeHash) {
    if (!exchangeHash) return { npc: 0, items: 0, timeline: 0, memories: 0, map: 0 };
    const [npc, items, timeline, memories] = await Promise.all([
        getNpcProfiles(chatId), getItems(chatId), getTimeline(chatId), getMemories(chatId),
    ]);
    const filterOut = (arr) => arr.filter(e => e.sourceExchange === exchangeHash);
    const removed = {
        npc: filterOut(npc).length,
        items: filterOut(items).length,
        timeline: filterOut(timeline).length,
        memories: filterOut(memories).length,
        map: 0,
    };
    try {
        const { getLocations, removeLocation } = await import('./map-store.js');
        const locs = await getLocations(chatId);
        const matchedLocs = locs.filter(e => e.sourceExchange === exchangeHash);
        for (const loc of matchedLocs) {
            if (await removeLocation(chatId, loc.id)) removed.map++;
        }
    } catch { /* 地图模块不可用时忽略 */ }
    await Promise.all([
        saveCollection('npc', chatId, npc.filter(e => e.sourceExchange !== exchangeHash)),
        saveCollection('item', chatId, items.filter(e => e.sourceExchange !== exchangeHash)),
        saveCollection('timeline', chatId, timeline.filter(e => e.sourceExchange !== exchangeHash)),
        saveCollection('mem', chatId, memories.filter(e => e.sourceExchange !== exchangeHash)),
    ]);
    scheduleAutoBackup(chatId);
    return removed;
}

/**
 * v6.1.0: 换楼刷新 — 将当前聊天所有记忆的 sourceFloor 统一设为 -1（旧聊天记忆）
 * 用于玩家"换楼"（开新聊天）后，将旧楼层的记忆标记为无特定楼层来源
 */
export async function refreshAllSourceFloors(chatId) {
    const [npc, items, timeline, memories] = await Promise.all([
        getNpcProfiles(chatId), getItems(chatId), getTimeline(chatId), getMemories(chatId),
    ]);
    const stats = { npc: 0, items: 0, timeline: 0, memories: 0 };
    for (const e of npc) { if (typeof e.sourceFloor === 'number' && e.sourceFloor >= 0) { e.sourceFloor = -1; stats.npc++; } }
    for (const e of items) { if (typeof e.sourceFloor === 'number' && e.sourceFloor >= 0) { e.sourceFloor = -1; stats.items++; } }
    for (const e of timeline) { if (typeof e.sourceFloor === 'number' && e.sourceFloor >= 0) { e.sourceFloor = -1; stats.timeline++; } }
    for (const e of memories) { if (typeof e.sourceFloor === 'number' && e.sourceFloor >= 0) { e.sourceFloor = -1; stats.memories++; } }
    await Promise.all([
        saveCollection('npc', chatId, npc),
        saveCollection('item', chatId, items),
        saveCollection('timeline', chatId, timeline),
        saveCollection('mem', chatId, memories),
    ]);
    return stats;
}

// ═══════════════════════════════════════════════════════════
//  统计
// ═══════════════════════════════════════════════════════════

export async function getMemoryStats(chatId) {
    const [npc, items, timeline, memories] = await Promise.all([
        getNpcProfiles(chatId),
        getItems(chatId),
        getTimeline(chatId),
        getMemories(chatId),
    ]);

    const byTier = (arr) => {
        const counts = { transient: 0, stable: 0, core: 0, eternal: 0 };
        for (const e of arr) {
            const t = e.memoryTier || 'transient';
            if (counts[t] !== undefined) counts[t]++;
        }
        return counts;
    };

    return {
        npc: { total: npc.length, byTier: byTier(npc) },
        items: { total: items.length, byTier: byTier(items) },
        timeline: { total: timeline.length, byTier: byTier(timeline) },
        memories: { total: memories.length, byTier: byTier(memories) },
    };
}

// ═══════════════════════════════════════════════════════════
//  跨设备备份同步
// ═══════════════════════════════════════════════════════════

const BACKUP_METADATA_KEY = 'bb_memory_v5_backup';
const LEGACY_SLOT_DATA_PREFIX = 'bb_memory_slot_data_';
const MIN_CHAT_METADATA_BACKUP_KB = 128;
const MAX_CHAT_METADATA_BACKUP_KB = 8192;

function getChatMetadataBackupLimit() {
    const configured = Number(getSettings().chatMetadataBackupMaxKb);
    const kb = Number.isFinite(configured) && configured > 0 ? configured : 2048;
    return Math.max(MIN_CHAT_METADATA_BACKUP_KB, Math.min(MAX_CHAT_METADATA_BACKUP_KB, kb)) * 1024;
}

function countBackupEntries(backup) {
    const mapCount = Object.keys(backup.map?.locations || {}).length;
    const clueCount = Array.isArray(backup.clueBoard?.nodes) ? backup.clueBoard.nodes.length : 0;
    return (backup.npc?.length || 0)
        + (backup.items?.length || 0)
        + (backup.timeline?.length || 0)
        + (backup.memories?.length || 0)
        + (backup.threads?.length || 0)
        + mapCount
        + clueCount;
}

function stripEmbedding(entry) {
    if (!entry || typeof entry !== 'object') return entry;
    const copy = { ...entry };
    delete copy.embedding;
    return copy;
}

function stripEmbeddings(entries) {
    return Array.isArray(entries) ? entries.map(stripEmbedding) : [];
}

function stripMapEmbeddings(map) {
    if (!map || typeof map !== 'object') return map;
    if (!map.locations || typeof map.locations !== 'object') return map;
    const locations = {};
    for (const [id, loc] of Object.entries(map.locations)) {
        locations[id] = stripEmbedding(loc);
    }
    return { ...map, locations };
}

function countBackupEmbeddings(backup) {
    const hasEmbedding = (entry) => Array.isArray(entry?.embedding) && entry.embedding.length > 0;
    let count = 0;
    for (const key of ['npc', 'items', 'timeline', 'memories', 'threads']) {
        count += (backup[key] || []).filter(hasEmbedding).length;
    }
    count += Object.values(backup.map?.locations || {}).filter(hasEmbedding).length;
    return count;
}

function isLegacySlotDataKey(key) {
    if (!key.startsWith(LEGACY_SLOT_DATA_PREFIX)) return false;
    const rest = key.slice(LEGACY_SLOT_DATA_PREFIX.length);
    return !rest.includes('__');
}

function purgeLegacySlotDataFromChatMetadata(ctx) {
    if (!ctx?.chatMetadata) return { removed: 0, size: 0 };
    let removed = 0;
    let size = 0;
    for (const key of Object.keys(ctx.chatMetadata)) {
        if (!isLegacySlotDataKey(key)) continue;
        const raw = ctx.chatMetadata[key];
        size += typeof raw === 'string' ? raw.length : 0;
        delete ctx.chatMetadata[key];
        removed++;
    }
    return { removed, size };
}

async function saveChatMetadata(ctx) {
    if (!ctx) return false;
    if (typeof ctx.saveMetadataDebounced === 'function') {
        ctx.saveMetadataDebounced();
        return true;
    }
    if (typeof ctx.saveMetadata === 'function') {
        await Promise.resolve(ctx.saveMetadata());
        return true;
    }
    if (typeof ctx.saveChatDebounced === 'function') {
        ctx.saveChatDebounced();
        return true;
    }
    if (typeof ctx.saveChat === 'function') {
        await Promise.resolve(ctx.saveChat());
        return true;
    }
    return false;
}

export async function cleanupChatMetadataBloat() {
    const ctx = getContext();
    const cleanup = purgeLegacySlotDataFromChatMetadata(ctx);
    const backup = ctx.chatMetadata?.[BACKUP_METADATA_KEY];
    const limit = getChatMetadataBackupLimit();
    if (typeof backup === 'string' && backup.length > limit) {
        cleanup.removed++;
        cleanup.size += backup.length;
        cleanup.backupRemoved = true;
        delete ctx.chatMetadata[BACKUP_METADATA_KEY];
    }
    if (cleanup.removed > 0) await saveChatMetadata(ctx);
    return cleanup;
}

export async function exportMemoriesToChatMetadata(chatId, options = {}) {
    const [{ getMap }, { getClueBoard }] = await Promise.all([
        import('./map-store.js'),
        import('./clue-board.js'),
    ]);
    const [npc, items, timeline, memories, threads, map, clueBoard] = await Promise.all([
        getNpcProfiles(chatId),
        getItems(chatId),
        getTimeline(chatId),
        getMemories(chatId),
        getTimelineThreads(chatId),
        getMap(chatId),
        getClueBoard(chatId),
    ]);

    const includeEmbeddings = options.includeEmbeddings === true;
    const backup = {
        version: '9.1.3',
        timestamp: Date.now(),
        embeddingsIncluded: includeEmbeddings,
        npc: includeEmbeddings ? npc : stripEmbeddings(npc),
        items: includeEmbeddings ? items : stripEmbeddings(items),
        timeline: includeEmbeddings ? timeline : stripEmbeddings(timeline),
        memories: includeEmbeddings ? memories : stripEmbeddings(memories),
        threads: includeEmbeddings ? threads : stripEmbeddings(threads),
        map: includeEmbeddings ? map : stripMapEmbeddings(map),
        clueBoard,
    };
    backup.embeddingCount = includeEmbeddings ? countBackupEmbeddings(backup) : 0;

    const json = JSON.stringify(backup);
    const ctx = getContext();

    if (!ctx.chatMetadata) ctx.chatMetadata = {};
    const cleanup = purgeLegacySlotDataFromChatMetadata(ctx);
    const limit = getChatMetadataBackupLimit();
    const count = countBackupEntries(backup);

    if (json.length > limit) {
        if (ctx.chatMetadata[BACKUP_METADATA_KEY]) delete ctx.chatMetadata[BACKUP_METADATA_KEY];
        await saveChatMetadata(ctx);
        return {
            count,
            size: json.length,
            limit,
            skipped: true,
            reason: 'size-limit',
            cleanup,
            embeddingsIncluded: includeEmbeddings,
            embeddingCount: backup.embeddingCount,
        };
    }

    ctx.chatMetadata[BACKUP_METADATA_KEY] = json;

    await saveChatMetadata(ctx);

    const settings = getSettings();
    settings.lastBackupTimestamp = Date.now();
    updateSettings({ lastBackupTimestamp: settings.lastBackupTimestamp });

    return { count, size: json.length, limit, skipped: false, cleanup, embeddingsIncluded: includeEmbeddings, embeddingCount: backup.embeddingCount };
}

async function restoreMapBackup(chatId, backupMap) {
    const idMap = new Map();
    if (!backupMap || typeof backupMap !== 'object' || !backupMap.locations) {
        return { restored: 0, skipped: 0, idMap };
    }

    const { getMap, setMap } = await import('./map-store.js');
    const current = await getMap(chatId);
    const locations = current?.locations && typeof current.locations === 'object' ? { ...current.locations } : {};
    const existingIds = new Set(Object.keys(locations));
    const existingNames = new Map();
    for (const loc of Object.values(locations)) {
        const key = (loc.name || '').toLowerCase().trim();
        if (key) existingNames.set(key, loc);
    }

    let restored = 0;
    let skipped = 0;
    const addedIds = [];
    for (const raw of Object.values(backupMap.locations || {})) {
        if (!raw || typeof raw !== 'object') continue;
        const oldId = raw.id;
        const nameKey = (raw.name || '').toLowerCase().trim();
        if (oldId && existingIds.has(oldId)) {
            idMap.set(oldId, oldId);
            skipped++;
            continue;
        }
        const duplicate = nameKey ? existingNames.get(nameKey) : null;
        if (duplicate) {
            if (oldId) idMap.set(oldId, duplicate.id);
            skipped++;
            continue;
        }

        const loc = { ...raw };
        if (!loc.id || existingIds.has(loc.id)) loc.id = generateId();
        locations[loc.id] = loc;
        existingIds.add(loc.id);
        if (nameKey) existingNames.set(nameKey, loc);
        if (oldId) idMap.set(oldId, loc.id);
        addedIds.push(loc.id);
        restored++;
    }

    for (const locId of addedIds) {
        const loc = locations[locId];
        if (loc.parentId && idMap.has(loc.parentId)) loc.parentId = idMap.get(loc.parentId);
        if (Array.isArray(loc.edges)) {
            loc.edges = loc.edges
                .map(edge => ({ ...edge, toId: idMap.get(edge.toId) || edge.toId }))
                .filter(edge => edge.toId && locations[edge.toId]);
        } else {
            loc.edges = [];
        }
    }

    await setMap(chatId, { ...backupMap, locations }, { skipBackup: true });
    return { restored, skipped, idMap };
}

async function restoreClueBoardBackup(chatId, backupBoard, idMaps = {}) {
    const nodeIdMap = new Map();
    if (!backupBoard || typeof backupBoard !== 'object') {
        return { restored: 0, skipped: 0, idMap: nodeIdMap };
    }

    const { getClueBoard, setClueBoard } = await import('./clue-board.js');
    const current = await getClueBoard(chatId);
    const nodes = Array.isArray(current?.nodes) ? [...current.nodes] : [];
    const connections = Array.isArray(current?.connections) ? [...current.connections] : [];
    const existingNodeIds = new Set(nodes.map(n => n.id).filter(Boolean));
    const existingNodeKeys = new Map();
    for (const node of nodes) {
        const key = `${node.refType || ''}|${node.refId || ''}|${(node.label || '').toLowerCase().trim()}`;
        existingNodeKeys.set(key, node);
    }

    let restored = 0;
    let skipped = 0;
    for (const raw of (backupBoard.nodes || [])) {
        if (!raw || typeof raw !== 'object') continue;
        const node = { ...raw };
        const refMap = idMaps[node.refType];
        if (node.refId && refMap?.has(node.refId)) node.refId = refMap.get(node.refId);
        const oldNodeId = raw.id;
        const key = `${node.refType || ''}|${node.refId || ''}|${(node.label || '').toLowerCase().trim()}`;

        if (oldNodeId && existingNodeIds.has(oldNodeId)) {
            nodeIdMap.set(oldNodeId, oldNodeId);
            skipped++;
            continue;
        }
        const duplicate = existingNodeKeys.get(key);
        if (duplicate) {
            if (oldNodeId) nodeIdMap.set(oldNodeId, duplicate.id);
            skipped++;
            continue;
        }
        if (!node.id || existingNodeIds.has(node.id)) node.id = generateId();
        nodes.push(node);
        existingNodeIds.add(node.id);
        existingNodeKeys.set(key, node);
        if (oldNodeId) nodeIdMap.set(oldNodeId, node.id);
        restored++;
    }

    for (const node of nodes) {
        if (node.parentId && nodeIdMap.has(node.parentId)) node.parentId = nodeIdMap.get(node.parentId);
    }

    const existingConnKeys = new Set(connections.map(c => `${c.fromNodeId}|${c.toNodeId}|${c.type || ''}|${c.label || ''}`));
    for (const raw of (backupBoard.connections || [])) {
        if (!raw || typeof raw !== 'object') continue;
        const conn = {
            ...raw,
            fromNodeId: nodeIdMap.get(raw.fromNodeId) || raw.fromNodeId,
            toNodeId: nodeIdMap.get(raw.toNodeId) || raw.toNodeId,
        };
        if (!existingNodeIds.has(conn.fromNodeId) || !existingNodeIds.has(conn.toNodeId)) {
            skipped++;
            continue;
        }
        const key = `${conn.fromNodeId}|${conn.toNodeId}|${conn.type || ''}|${conn.label || ''}`;
        if (existingConnKeys.has(key)) {
            skipped++;
            continue;
        }
        if (!conn.id || connections.some(c => c.id === conn.id)) conn.id = generateId();
        connections.push(conn);
        existingConnKeys.add(key);
        restored++;
    }

    await setClueBoard(chatId, { nodes, connections, updatedAt: backupBoard.updatedAt || Date.now() }, { skipBackup: true });
    return { restored, skipped, idMap: nodeIdMap };
}

async function restoreBackupPayload(chatId, backup) {
    if (!backup || typeof backup !== 'object') return { restored: 0, skipped: 0, merged: 0 };
    let restored = 0, skipped = 0, merged = 0;
    const importOptions = { externalInit: isExternalInitPayload(backup) };
    const idMaps = {};
    const restorePart = async (type, entries, loader, keyFn, transform = null) => {
        const idMap = new Map();
        idMaps[type] = idMap;
        if (!Array.isArray(entries) || entries.length === 0) return;

        const existing = await loader(chatId);
        const next = [...existing];
        const existingIds = new Set(existing.map(e => e.id).filter(Boolean));
        const existingById = new Map(existing.map(e => [e.id, e]).filter(([id]) => id));
        const existingKeys = new Map();
        for (const entry of existing) {
            const key = keyFn(entry);
            if (key) existingKeys.set(key, entry);
        }

        let changed = false;
        for (const raw of entries) {
            if (!raw || typeof raw !== 'object') continue;
            const oldId = raw.id;
            if (oldId && existingIds.has(oldId)) {
                const duplicate = existingById.get(oldId);
                if (duplicate && mergeImportedEntryInPlace(type, duplicate, transform ? transform({ ...raw }) : raw, importOptions)) {
                    merged++;
                    changed = true;
                } else {
                    skipped++;
                }
                idMap.set(oldId, oldId);
                continue;
            }

            const key = keyFn(raw);
            const duplicate = key ? existingKeys.get(key) : null;
            if (duplicate) {
                if (mergeImportedEntryInPlace(type, duplicate, transform ? transform({ ...raw }) : raw, importOptions)) {
                    merged++;
                    changed = true;
                } else {
                    skipped++;
                }
                if (oldId) idMap.set(oldId, duplicate.id);
                continue;
            }

            const entry = normalizeImportedEntry(type, transform ? transform({ ...raw }) : { ...raw }, importOptions);
            if (!entry.id || existingIds.has(entry.id)) entry.id = generateId();
            existingIds.add(entry.id);
            existingById.set(entry.id, entry);
            const nextKey = keyFn(entry);
            if (nextKey) existingKeys.set(nextKey, entry);
            next.push(entry);
            if (oldId) idMap.set(oldId, entry.id);
            restored++;
            changed = true;
        }

        if (changed) await saveCollection(type, chatId, next);
    };

    await restorePart('npc', backup.npc, getNpcProfiles, e => (e.name || '').toLowerCase().trim());
    await restorePart('item', backup.items, getItems, e => (e.name || '').toLowerCase().trim());
    await restorePart('timeline', backup.timeline, getTimeline, e => `${(e.event || '').toLowerCase().trim()}|${e.storyTime || ''}`);
    await restorePart('mem', backup.memories, getMemories, e => `${(e.title || '').toLowerCase().trim()}|${(e.content || '').toLowerCase().trim().slice(0, 80)}`);
    await restorePart('threads', backup.threads, getTimelineThreads, e => (e.name || '').toLowerCase().trim(), thread => {
        if (thread.parentThreadId && idMaps.threads?.has(thread.parentThreadId)) {
            thread.parentThreadId = idMaps.threads.get(thread.parentThreadId);
        }
        if (Array.isArray(thread.entries) && idMaps.timeline) {
            thread.entries = thread.entries.map(entry => ({
                ...entry,
                refId: idMaps.timeline.get(entry.refId) || entry.refId,
            }));
        }
        return thread;
    });
    if (idMaps.threads?.size > 0) {
        const threads = await getTimelineThreads(chatId);
        let changed = false;
        for (const thread of threads) {
            if (thread.parentThreadId && idMaps.threads.has(thread.parentThreadId)) {
                thread.parentThreadId = idMaps.threads.get(thread.parentThreadId);
                changed = true;
            }
        }
        if (changed) await saveCollection('threads', chatId, threads);
    }

    const mapResult = await restoreMapBackup(chatId, backup.map || backup.mapData);
    restored += mapResult.restored;
    skipped += mapResult.skipped;

    const clueResult = await restoreClueBoardBackup(chatId, backup.clueBoard || backup.clues, {
        ...idMaps,
        items: idMaps.item,
        memory: idMaps.mem,
        memories: idMaps.mem,
        map: mapResult.idMap,
    });
    restored += clueResult.restored;
    skipped += clueResult.skipped;

    return { restored, skipped, merged };
}

export async function importMemoriesFromChatMetadata(chatId) {
    const ctx = getContext();
    const json = ctx.chatMetadata?.[BACKUP_METADATA_KEY];
    if (!json) return { restored: 0, skipped: 0, merged: 0 };

    let backup;
    try {
        backup = JSON.parse(json);
    } catch {
        return { restored: 0, skipped: 0, merged: 0, error: 'JSON 解析失败' };
    }

    const result = await restoreBackupPayload(chatId, backup);
    result.embeddingsIncluded = backup.embeddingsIncluded === true;
    result.embeddingCount = countBackupEmbeddings(backup);

    // v8.2.7 恢复后清除 chatMetadata 中的备份数据，避免聊天文件持续膨胀
    if (ctx.chatMetadata?.[BACKUP_METADATA_KEY]) {
        delete ctx.chatMetadata[BACKUP_METADATA_KEY];
        await saveChatMetadata(ctx);
    }

    return result;
}

// ═══════════════════════════════════════════════════════════
//  自动备份调度
// ═══════════════════════════════════════════════════════════

let backupTimers = new Map();
let lastAutoBackupTime = 0;

export function scheduleAutoBackup(chatId) {
    const settings = getSettings();
    if (!settings.autoBackupEnabled) return;
    if (!chatId) return;

    const existing = backupTimers.get(chatId);
    if (existing) clearTimeout(existing);

    // v8.2.0 防抖延长到 30s，添加最小间隔 5min，减少频繁写入
    const timer = setTimeout(() => {
        const now = Date.now();
        if (now - lastAutoBackupTime < 300000) {
            backupTimers.delete(chatId);
            return;
        }
        lastAutoBackupTime = now;
        exportMemoriesToChatMetadata(chatId).catch(() => {});
        backupTimers.delete(chatId);
    }, 30000);

    backupTimers.set(chatId, timer);
}

// ═══════════════════════════════════════════════════════════
//  v4 → v5 迁移
// ═══════════════════════════════════════════════════════════

const LEGACY_TYPE_MAP = {
    event:        { type: 'event',   category: 'npc' },
    timeline:     { type: 'event',   category: 'timeline' },
    item:         { type: 'fact',    category: 'item' },
    npc:          { type: 'fact',    category: 'npc' },
    location:     { type: 'fact',    category: 'timeline' },
    relationship: { type: 'fact',    category: 'npc' },
};

export async function migrateV4ToV5(chatId) {
    const settings = getSettings();
    if (settings.migratedFromV4) return { migrated: false, reason: '已迁移' };

    const lf = getLocalForage();
    const oldData = await lf.getItem(OLD_STORAGE_KEY + chatId);
    if (!Array.isArray(oldData) || oldData.length === 0) {
        settings.migratedFromV4 = true;
        updateSettings({ migratedFromV4: true });
        return { migrated: false, reason: '无旧数据' };
    }

    const npcMap = new Map();     // name → merged NPC data
    const itemMap = new Map();    // name → merged item data
    const timelineEntries = [];
    const memoryEntries = [];

    for (const entry of oldData) {
        const cp = entry.categoryPath || '';
        const legacy = LEGACY_TYPE_MAP[entry.type] || { type: 'event', category: 'mem' };

        if (cp.startsWith('npc.') || legacy.category === 'npc') {
            // → NPC 档案
            const name = entry.subject || entry.title || '';
            if (!name) {
                // 无名称的 NPC 记忆 → 转为普通记忆
                memoryEntries.push(convertToMemory(entry));
                continue;
            }
            const key = name.toLowerCase();
            if (npcMap.has(key)) {
                const existing = npcMap.get(key);
                existing.notes.push(entry.summary || entry.content);
                if (entry.importance > existing.importance) existing.importance = entry.importance;
                if (entry.npcTier && (!existing.npcTier || existing.npcTier === 'minor')) {
                    existing.npcTier = normalizeNpcTier(entry.npcTier) || existing.npcTier;
                }
                existing.tags = mergeTags(existing.tags, entry.tags);
            } else {
                npcMap.set(key, {
                    name,
                    role: entry.metadata?.role || '',
                    personality: entry.metadata?.personality || '',
                    appearance: entry.metadata?.appearance || '',
                    status: entry.metadata?.status || '',
                    location: entry.location || '',
                    relationships: [],
                    notes: [entry.summary || entry.content].filter(Boolean),
                    indexCard: entry.indexCard || '',
                    npcTier: normalizeNpcTier(entry.npcTier) || 'minor',
                    tags: normalizeTags(entry.tags),
                    hitCount: entry.accessCount || 0,
                    memoryTier: entry.resident ? 'core' : (entry.pinned ? 'eternal' : 'transient'),
                    createdAt: entry.createdAt || Date.now(),
                    updatedAt: entry.updatedAt || Date.now(),
                    lastHitAt: entry.lastAccessedAt || null,
                    source: entry.source || 'migration',
                });
            }
        } else if (cp.startsWith('item.') || legacy.category === 'item') {
            // → 物品栏
            const name = entry.subject || entry.title || '';
            if (!name) {
                memoryEntries.push(convertToMemory(entry));
                continue;
            }
            const key = name.toLowerCase();
            if (itemMap.has(key)) {
                const existing = itemMap.get(key);
                if (entry.itemTier && (!existing.itemTier || existing.itemTier === 'consumable')) {
                    existing.itemTier = normalizeItemTier(entry.itemTier) || existing.itemTier;
                }
                existing.tags = mergeTags(existing.tags, entry.tags);
            } else {
                itemMap.set(key, {
                    name,
                    owner: entry.metadata?.owner || entry.target || '',
                    status: entry.metadata?.status || (entry.status === 'archived' ? 'lost' : 'held'),
                    significance: entry.summary || entry.content,
                    keepPermanent: entry.pinned || false,
                    itemTier: normalizeItemTier(entry.itemTier) || 'consumable',
                    tags: normalizeTags(entry.tags),
                    hitCount: entry.accessCount || 0,
                    memoryTier: entry.resident ? 'core' : (entry.pinned ? 'eternal' : 'transient'),
                    createdAt: entry.createdAt || Date.now(),
                    updatedAt: entry.updatedAt || Date.now(),
                    lastHitAt: entry.lastAccessedAt || null,
                    source: entry.source || 'migration',
                });
            }
        } else if (cp.startsWith('episode.') || cp.startsWith('location.') || legacy.category === 'timeline') {
            // → 时间线
            timelineEntries.push({
                storyTime: entry.storyTime || '',
                storyTimeSort: entry.storyTimeSort ?? (entry.createdAt || Date.now()),
                event: entry.title || entry.summary?.slice(0, 40) || entry.content?.slice(0, 40) || '',
                summary: entry.summary || entry.content,
                participants: [entry.subject, entry.target].filter(Boolean),
                location: entry.location || '',
                isActive: entry.status !== 'archived',
                status: entry.isTimelineSummary ? 'ended' : 'ongoing',
                impact: '',
                tags: normalizeTags(entry.tags),
                hitCount: entry.accessCount || 0,
                memoryTier: entry.resident ? 'core' : (entry.pinned ? 'eternal' : 'transient'),
                relatedEventIds: [],
                createdAt: entry.createdAt || Date.now(),
                updatedAt: entry.updatedAt || Date.now(),
                lastHitAt: entry.lastAccessedAt || null,
                source: entry.source || 'migration',
            });
        } else {
            // → 记忆条目
            memoryEntries.push(convertToMemory(entry));
        }
    }

    // 存储
    const npcList = [...npcMap.values()];
    const itemList = [...itemMap.values()];

    await Promise.all([
        saveCollection('npc', chatId, npcList),
        saveCollection('item', chatId, itemList),
        saveCollection('timeline', chatId, timelineEntries),
        saveCollection('mem', chatId, memoryEntries),
    ]);

    settings.migratedFromV4 = true;
    updateSettings({ migratedFromV4: true });

    console.log(`[BB-Memory] v4→v5 迁移完成: ${npcList.length} NPC, ${itemList.length} 物品, ${timelineEntries.length} 时间线, ${memoryEntries.length} 记忆`);
    return {
        migrated: true,
        npc: npcList.length,
        items: itemList.length,
        timeline: timelineEntries.length,
        memories: memoryEntries.length,
    };
}

function convertToMemory(entry) {
    return {
        title: entry.title || '',
        type: entry.cognitiveType || 'event',
        summary: entry.summary || '',
        storyTime: entry.storyTime || '',
        storyTimeSort: entry.storyTimeSort ?? null,
        content: entry.content || '',
        verbatim: entry.verbatim || '',
        subject: entry.subject || '',
        target: entry.target || '',
        importance: entry.importance || 0.5,
        emotionalWeight: entry.emotionalWeight || 0.0,
        tags: normalizeTags(entry.tags),
        embedding: entry.embedding || null,
        hiddenNotes: Array.isArray(entry.hiddenNotes) ? entry.hiddenNotes : [],
        truthStatus: entry.truthStatus || 'true',
        hitCount: entry.accessCount || 0,
        memoryTier: entry.resident ? 'core' : (entry.pinned ? 'eternal' : 'transient'),
        relatedMemoryIds: entry.relatedMemoryIds || [],
        isTimelineSummary: entry.isTimelineSummary || false,
        timelineGroupKey: entry.timelineGroupKey || '',
        createdAt: entry.createdAt || Date.now(),
        updatedAt: entry.updatedAt || Date.now(),
        lastHitAt: entry.lastAccessedAt || null,
        lastPromotedAt: null,
        source: entry.source || 'migration',
        sourceMessageIds: entry.sourceMessageIds || [],
    };
}

function normalizeTags(tags) {
    if (!Array.isArray(tags)) return [];
    return tags.map(t => typeof t === 'string' ? { name: t, weight: 0.6 } : { name: t.name || '', weight: t.weight || 0.6 });
}

function mergeTags(existing, incoming) {
    const names = new Set(existing.map(t => t.name));
    for (const t of normalizeTags(incoming)) {
        if (!names.has(t.name)) {
            existing.push(t);
            names.add(t.name);
        }
    }
    return existing;
}

// ═══════════════════════════════════════════════════════════
//  v5 兼容旧接口（给其他模块过渡用）
// ═══════════════════════════════════════════════════════════

/**
 * 兼容旧的 exportMemories / importMemories JSON 导出
 */
function isExternalInitPayload(data) {
    const version = String(data?.version || '');
    const generator = String(data?.generator || '');
    return version.includes('external-init') || generator.includes('bbmemory-initializer.html');
}

function normalizeStableTier(tier, forceStable = false) {
    if (!forceStable) return tier || 'transient';
    if (tier === 'core' || tier === 'eternal') return tier;
    return 'stable';
}

function normalizeImportedThreadEntries(entries) {
    if (!Array.isArray(entries)) return [];
    return entries.map(entry => {
        if (typeof entry === 'string') {
            const event = entry.trim();
            return event ? { refId: '', period: '', event, status: 'ended', note: '' } : null;
        }
        if (!entry || typeof entry !== 'object') return null;
        const event = String(entry.event || entry.title || entry.summary || entry.note || '').trim();
        if (!event) return null;
        const status = ['ongoing', 'ended', 'milestone'].includes(entry.status) ? entry.status : 'ended';
        return {
            ...entry,
            refId: String(entry.refId || '').trim(),
            period: String(entry.period || entry.storyTime || entry.time || '').trim(),
            event,
            status,
            note: String(entry.note || '').trim(),
        };
    }).filter(Boolean);
}

function normalizeImportedEntry(type, raw, options = {}) {
    const entry = { ...(raw || {}) };
    const forceStable = options.externalInit === true;
    if (Array.isArray(entry.tags)) entry.tags = normalizeTags(entry.tags);
    if (type === 'mem') {
        entry.title = entry.title || entry.summary || '';
        entry.summary = entry.summary || entry.content || entry.title || '';
        entry.content = (entry.content || entry.summary || entry.title || '').trim();
        entry.hiddenNotes = Array.isArray(entry.hiddenNotes) ? entry.hiddenNotes : [];
        entry.memoryTier = normalizeStableTier(entry.memoryTier || entry.tier, forceStable);
        if (forceStable) {
            if (entry.status === 'archived' && entry.archived !== true) entry.status = 'active';
            entry.archived = entry.archived === true ? true : false;
        }
    } else if (type === 'threads') {
        entry.entries = normalizeImportedThreadEntries(entry.entries);
    } else if (['npc', 'item', 'timeline'].includes(type)) {
        entry.memoryTier = normalizeStableTier(entry.memoryTier, forceStable);
        if (forceStable && entry.archived !== true) entry.archived = false;
    }
    return entry;
}

function mergeTextField(base, incoming) {
    const a = String(base || '').trim();
    const b = String(incoming || '').trim();
    if (!a) return b;
    if (!b || a.includes(b)) return a;
    if (b.includes(a)) return b;
    return `${a}\n${b}`;
}

function mergeUniqueObjects(existing, incoming, keyFn) {
    const out = Array.isArray(existing) ? [...existing] : [];
    const seen = new Set(out.map(keyFn).filter(Boolean));
    for (const item of Array.isArray(incoming) ? incoming : []) {
        const key = keyFn(item);
        if (!key || seen.has(key)) continue;
        out.push(item);
        seen.add(key);
    }
    return out;
}

function tierRank(tier) {
    return ({ transient: 0, stable: 1, core: 2, eternal: 3 })[tier] ?? 0;
}

function mergeImportedEntryInPlace(type, base, incoming, options = {}) {
    let changed = false;
    const normalized = normalizeImportedEntry(type, incoming, options);
    const textFields = {
        npc: ['role', 'personality', 'appearance', 'status', 'location', 'indexCard'],
        item: ['owner', 'status', 'location', 'significance'],
        timeline: ['storyTime', 'event', 'summary', 'location', 'impact'],
        mem: ['title', 'summary', 'content', 'verbatim', 'subject', 'target', 'storyTime'],
        threads: ['name', 'type', 'status', 'priority', 'summary'],
    }[type] || [];

    for (const key of textFields) {
        if (normalized[key] === undefined || normalized[key] === '') continue;
        const next = ['summary', 'content', 'significance', 'personality', 'appearance', 'impact'].includes(key)
            ? mergeTextField(base[key], normalized[key])
            : (base[key] || normalized[key]);
        if (next !== base[key]) {
            base[key] = next;
            changed = true;
        }
    }

    if (Array.isArray(normalized.tags)) {
        const before = Array.isArray(base.tags) ? base.tags.length : 0;
        base.tags = mergeTags(Array.isArray(base.tags) ? base.tags : [], normalized.tags);
        if (base.tags.length !== before) changed = true;
    }
    if ((!Array.isArray(base.embedding) || base.embedding.length === 0) && Array.isArray(normalized.embedding) && normalized.embedding.length > 0) {
        base.embedding = normalized.embedding;
        changed = true;
    }
    if (type === 'mem') {
        if (tierRank(normalized.memoryTier) > tierRank(base.memoryTier)) {
            base.memoryTier = normalized.memoryTier;
            changed = true;
        }
        if (typeof normalized.importance === 'number' && normalized.importance > (base.importance || 0)) {
            base.importance = normalized.importance;
            changed = true;
        }
        if (typeof normalized.emotionalWeight === 'number' && normalized.emotionalWeight > (base.emotionalWeight || 0)) {
            base.emotionalWeight = normalized.emotionalWeight;
            changed = true;
        }
        const notes = mergeUniqueObjects(base.hiddenNotes, normalized.hiddenNotes, n => `${n.type || ''}|${n.content || ''}`);
        if (notes.length !== (base.hiddenNotes || []).length) changed = true;
        base.hiddenNotes = notes;
        if (options.externalInit && base.archived && normalized.archived === false) {
            base.archived = false;
            if (base.status === 'archived') base.status = 'active';
            changed = true;
        }
    } else if (type === 'threads') {
        const entries = mergeUniqueObjects(base.entries, normalized.entries, e => `${e.period || ''}|${e.event || ''}|${e.status || ''}`);
        if (entries.length !== (base.entries || []).length) changed = true;
        base.entries = entries;
    } else if (type === 'timeline') {
        const participants = mergeUniqueObjects(base.participants, normalized.participants, v => String(v));
        if (participants.length !== (base.participants || []).length) changed = true;
        base.participants = participants;
        if (normalized.status === 'ongoing' || normalized.status === 'foreshadow') {
            if (base.status !== normalized.status) changed = true;
            base.status = normalized.status;
            base.isActive = normalized.status === 'ongoing';
        }
    }
    if (changed) base.updatedAt = Date.now();
    return changed;
}

export async function exportMemories(chatId) {
    const [{ getMap }, { getClueBoard }] = await Promise.all([
        import('./map-store.js'),
        import('./clue-board.js'),
    ]);
    const [npc, items, timeline, memories, threads, map, clueBoard] = await Promise.all([
        getNpcProfiles(chatId), getItems(chatId), getTimeline(chatId), getMemories(chatId),
        getTimelineThreads(chatId), getMap(chatId), getClueBoard(chatId),
    ]);
    return JSON.stringify({
        version: '9.1.3',
        npc,
        items,
        timeline,
        memories,
        threads,
        map,
        clueBoard,
    });
}

export async function importMemories(chatId, jsonString) {
    let data = JSON.parse(jsonString);
    if (Array.isArray(data)) {
        data = { version: 'legacy-array-import', memories: data };
    }
    const result = await restoreBackupPayload(chatId, data);
    return (result.restored || 0) + (result.merged || 0);
}

/**
 * 兼容旧的 updateFactContent（记忆更新 + 历史）
 */
export async function updateFactContent(chatId, id, newContent, options = {}) {
    const memories = await getMemories(chatId);
    const entry = memories.find(m => m.id === id);
    if (!entry) return null;

    entry.hiddenNotes = Array.isArray(entry.hiddenNotes) ? entry.hiddenNotes : [];
    entry.hiddenNotes.push({
        id: generateId(),
        type: 'note',
        content: `[旧版本] ${entry.content}`,
        allowInjection: false,
        createdAt: Date.now(),
    });

    entry.content = newContent.trim();
    if (options.summary) entry.summary = options.summary;
    if (options.truthStatus) entry.truthStatus = options.truthStatus;
    entry.updatedAt = Date.now();

    await saveCollection('mem', chatId, memories);
    scheduleAutoBackup(chatId);
    return entry;
}

export async function addHiddenNote(chatId, memoryId, note) {
    const memories = await getMemories(chatId);
    const entry = memories.find(m => m.id === memoryId);
    if (!entry) return null;
    if (!Array.isArray(entry.hiddenNotes)) entry.hiddenNotes = [];
    const noteEntry = {
        id: generateId(),
        type: note.type || 'note',
        content: note.content || '',
        allowInjection: note.allowInjection !== undefined ? note.allowInjection : true,
        revealPolicy: note.revealPolicy || 'never',
        revealCondition: note.revealCondition || '',
        createdAt: Date.now(),
    };
    entry.hiddenNotes.push(noteEntry);
    await saveCollection('mem', chatId, memories);
    scheduleAutoBackup(chatId);
    return noteEntry;
}

export async function removeHiddenNote(chatId, memoryId, noteId) {
    const memories = await getMemories(chatId);
    const entry = memories.find(m => m.id === memoryId);
    if (!entry) return false;
    if (!Array.isArray(entry.hiddenNotes)) return false;
    const before = entry.hiddenNotes.length;
    entry.hiddenNotes = entry.hiddenNotes.filter(n => n.id !== noteId);
    if (entry.hiddenNotes.length < before) {
        await saveCollection('mem', chatId, memories);
        scheduleAutoBackup(chatId);
        return true;
    }
    return false;
}

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
};

const OLD_STORAGE_KEY = 'bb_memory_chat_';

// ═══ 默认设置 ═══
export const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    injectionTemplate: '[BB-Memory 长期记忆]\n{{memories}}',
    // 检索
    tokenBudget: 800,
    maxResults: 10,
    shortTermWindow: 5,
    // AI 自动生成
    autoGenEnabled: false,
    autoGenMode: 'main',           // 'main' | 'custom'
    autoGenEndpoint: '',
    autoGenApiKey: '',
    autoGenModel: '',
    autoGenPrompt: '',             // 自定义提取提示词（覆盖默认）
    autoGenMaxExchanges: 3,
    maxMemoriesPerExchange: 3,
    extractionConfirmMode: 'semi', // 'active' | 'semi' | 'auto'
    activeConfirmStyle: 'popup',   // 'popup' | 'toast'
    contextWindowExchanges: 3,
    extractionMode: 'staged',        // 'staged' | 'merged'
    // Embedding
    embeddingEnabled: false,
    embeddingEndpoint: '',
    embeddingApiKey: '',
    embeddingModel: 'text-embedding-3-small',
    // 语义去重
    dedupEnabled: true,
    mergeSimilarityThreshold: 0.85,
    reduceSimilarityThreshold: 0.60,
    // 聚类
    clusterEnabled: true,
    clusterTagThreshold: 8,
    // 故事时间
    calendarDescription: '',
    // 升降格与维护
    diversityLimitPerTag: 5,       // 同一标签最多 N 条 core
    promotionCooldownRounds: 15,   // 升格冷却轮数
    maintenanceMemThreshold: 20,   // 记忆维护阈值
    maintenanceNpcThreshold: 5,    // NPC 维护阈值
    maintenanceItemThreshold: 20,  // 物品维护阈值
    // 时间线总结
    timelineSummaryEnabled: true,
    // 自动备份
    autoBackupEnabled: false,
    lastBackupTimestamp: 0,
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

export function extractKeywords(text) {
    if (!text) return [];
    const tokens = text
        .toLowerCase()
        .split(/[\s,，。！？!?、；;：:""''「」（）()\[\]{}·\n\r\t]+/)
        .map(t => t.trim())
        .filter(t => t.length >= 2);
    return [...new Set(tokens)].slice(0, 20);
}

function generateId() {
    return 'bb_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
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
        npcTier: normalizeNpcTier(data.npcTier) || 'minor',
        tags: Array.isArray(data.tags) ? data.tags : [],
        hitCount: data.hitCount || 0,
        memoryTier: data.memoryTier || 'transient',
        createdAt: now,
        updatedAt: now,
        lastHitAt: null,
        source: data.source || 'manual',
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
        status: data.status || 'held',       // held | used | lost | destroyed
        significance: data.significance || '',
        keepPermanent: data.keepPermanent || false,
        itemTier: normalizeItemTier(data.itemTier) || 'consumable',
        tags: Array.isArray(data.tags) ? data.tags : [],
        hitCount: data.hitCount || 0,
        memoryTier: data.memoryTier || 'transient',
        createdAt: now,
        updatedAt: now,
        lastHitAt: null,
        source: data.source || 'manual',
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
        impact: data.impact || '',
        tags: Array.isArray(data.tags) ? data.tags : [],
        hitCount: data.hitCount || 0,
        memoryTier: data.memoryTier || 'transient',
        relatedEventIds: Array.isArray(data.relatedEventIds) ? data.relatedEventIds : [],
        createdAt: now,
        updatedAt: now,
        lastHitAt: null,
        source: data.source || 'manual',
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
        memoryTier: data.memoryTier || 'transient',
        relatedMemoryIds: Array.isArray(data.relatedMemoryIds) ? data.relatedMemoryIds : [],
        isTimelineSummary: data.isTimelineSummary || false,
        timelineGroupKey: data.timelineGroupKey || '',
        createdAt: now,
        updatedAt: now,
        lastHitAt: null,
        lastPromotedAt: null,                 // 上次升格时间戳（冷却用）
        source: data.source || 'manual',
        sourceMessageIds: Array.isArray(data.sourceMessageIds) ? data.sourceMessageIds : [],
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
//  升降格系统
// ═══════════════════════════════════════════════════════════

const TIER_ORDER = ['transient', 'stable', 'core', 'eternal'];
const PROMOTE_THRESHOLDS = { stable: 3, core: 8 };
const DEMOTE_MISS_ROUNDS = { core: 30, stable: 60 };    // N 轮未命中触发降格
const MAINTENANCE_MISS_ROUNDS = 30;                      // transient 未命中提醒
const PROMOTION_COOLDOWN_MS = 15 * 60 * 1000;            // 15 分钟冷却（模拟"轮"）

/**
 * 记录命中（interceptor 检索到某条记忆/NPC/物品时调用）
 * 自动处理升格。
 */
export async function recordHit(chatId, collection, id) {
    let items;
    switch (collection) {
        case 'npc': items = await getNpcProfiles(chatId); break;
        case 'item': items = await getItems(chatId); break;
        case 'timeline': items = await getTimeline(chatId); break;
        case 'mem': items = await getMemories(chatId); break;
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
export async function recordHits(chatId, hits) {
    for (const hit of hits) {
        await recordHit(chatId, hit.collection, hit.id);
    }
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
export async function checkDemotions(chatId) {
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
    ]);
}

/**
 * v5 兼容旧接口名称
 */
export async function clearMemories(chatId) {
    return clearAllData(chatId);
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

export async function exportMemoriesToChatMetadata(chatId) {
    const [npc, items, timeline, memories] = await Promise.all([
        getNpcProfiles(chatId),
        getItems(chatId),
        getTimeline(chatId),
        getMemories(chatId),
    ]);

    const backup = {
        version: '5.0',
        timestamp: Date.now(),
        npc,
        items,
        timeline,
        memories,
    };

    const json = JSON.stringify(backup);
    const ctx = getContext();

    if (!ctx.chatMetadata) ctx.chatMetadata = {};
    ctx.chatMetadata[BACKUP_METADATA_KEY] = json;

    if (typeof ctx.saveChat === 'function') {
        ctx.saveChat();
    } else if (typeof ctx.saveChatDebounced === 'function') {
        ctx.saveChatDebounced();
    }

    const settings = getSettings();
    settings.lastBackupTimestamp = Date.now();
    updateSettings({ lastBackupTimestamp: settings.lastBackupTimestamp });

    return { count: npc.length + items.length + timeline.length + memories.length, size: json.length };
}

export async function importMemoriesFromChatMetadata(chatId) {
    const ctx = getContext();
    const json = ctx.chatMetadata?.[BACKUP_METADATA_KEY];
    if (!json) return { restored: 0, skipped: 0 };

    let backup;
    try {
        backup = JSON.parse(json);
    } catch {
        return { restored: 0, skipped: 0, error: 'JSON 解析失败' };
    }

    let restored = 0, skipped = 0;

    // 恢复 NPC
    if (Array.isArray(backup.npc)) {
        const existing = await getNpcProfiles(chatId);
        const existingIds = new Set(existing.map(e => e.id));
        const existingNames = new Set(existing.map(e => e.name.toLowerCase()));
        for (const entry of backup.npc) {
            if (existingIds.has(entry.id) || existingNames.has((entry.name || '').toLowerCase())) {
                skipped++;
            } else {
                const { id: _id, ...data } = entry;
                await addNpcProfile(chatId, { ...data, id: undefined });
                restored++;
            }
        }
    }

    // 恢复物品
    if (Array.isArray(backup.items)) {
        const existing = await getItems(chatId);
        const existingIds = new Set(existing.map(e => e.id));
        const existingNames = new Set(existing.map(e => e.name.toLowerCase()));
        for (const entry of backup.items) {
            if (existingIds.has(entry.id) || existingNames.has((entry.name || '').toLowerCase())) {
                skipped++;
            } else {
                const { id: _id, ...data } = entry;
                await addItem(chatId, { ...data, id: undefined });
                restored++;
            }
        }
    }

    // 恢复时间线
    if (Array.isArray(backup.timeline)) {
        const existing = await getTimeline(chatId);
        const existingIds = new Set(existing.map(e => e.id));
        for (const entry of backup.timeline) {
            if (existingIds.has(entry.id)) { skipped++; continue; }
            const { id: _id, ...data } = entry;
            await addTimelineEntry(chatId, { ...data, id: undefined });
            restored++;
        }
    }

    // 恢复记忆
    if (Array.isArray(backup.memories)) {
        const existing = await getMemories(chatId);
        const existingIds = new Set(existing.map(e => e.id));
        for (const entry of backup.memories) {
            if (existingIds.has(entry.id)) { skipped++; continue; }
            const { id: _id, ...data } = entry;
            await addMemory(chatId, { ...data, id: undefined });
            restored++;
        }
    }

    return { restored, skipped };
}

// ═══════════════════════════════════════════════════════════
//  自动备份调度
// ═══════════════════════════════════════════════════════════

let backupTimers = new Map();

export function scheduleAutoBackup(chatId) {
    const settings = getSettings();
    if (!settings.autoBackupEnabled) return;
    if (!chatId) return;

    const existing = backupTimers.get(chatId);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
        exportMemoriesToChatMetadata(chatId).catch(() => {});
        backupTimers.delete(chatId);
    }, 5000);

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
export async function exportMemories(chatId) {
    const [npc, items, timeline, memories] = await Promise.all([
        getNpcProfiles(chatId), getItems(chatId), getTimeline(chatId), getMemories(chatId),
    ]);
    return JSON.stringify({ version: '5.0', npc, items, timeline, memories }, null, 2);
}

export async function importMemories(chatId, jsonString) {
    const data = JSON.parse(jsonString);
    let count = 0;
    if (Array.isArray(data.npc)) {
        for (const e of data.npc) { await addNpcProfile(chatId, e); count++; }
    }
    if (Array.isArray(data.items)) {
        for (const e of data.items) { await addItem(chatId, e); count++; }
    }
    if (Array.isArray(data.timeline)) {
        for (const e of data.timeline) { await addTimelineEntry(chatId, e); count++; }
    }
    if (Array.isArray(data.memories)) {
        for (const e of data.memories) { await addMemory(chatId, e); count++; }
    }
    // 兼容旧格式（单数组）
    if (!data.npc && !data.items && !data.timeline && !data.memories && Array.isArray(data)) {
        for (const e of data) { await addMemory(chatId, e); count++; }
    }
    return count;
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
        return true;
    }
    return false;
}

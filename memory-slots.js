/**
 * memory-slots.js —— BB-Memory 存档槽管理
 *
 * v2.9 新增：同一角色共享的存档槽系统
 * - 槽数据按角色ID组织，不同聊天但同角色可共用
 * - 默认槽为 "default"，始终存在
 * - 操作：保存 / 加载 / 新建 / 删除 / 列表
 *
 * v8.2.0 移除 chatMetadata 远程槽同步：
 * - 槽位数据仅存储在 localforage（本机），不再写入 chatMetadata
 * - 跨设备数据同步通过手动备份 (bb_memory_v5_backup) 完成
 * - 此举大幅减小聊天文件体积，并消除存档操作中的 saveChat 阻塞
 */

import { getSettings, updateSettings } from './memory-store.js';
import {
    buildVectorPack,
    countEmbeddingRefs,
    importVectorPack,
    normalizeDataEmbeddingsToRefs,
    stripRuntimeEmbeddings,
} from './vector-store.js';
import {
    getStableCharacterId,
    getAcceptableCharIdsSync,
} from './slot-identity.js';

// ═══ localforage 访问 ═══

function getLocalForage() {
    const ctx = SillyTavern.getContext();
    return ctx?.libs?.localforage || globalThis.localforage || globalThis.SillyTavern?.libs?.localforage;
}

// ═══ 存储键 ═══

const SLOT_PREFIX = 'bb_memory_slot_';
const CHAT_SLOT_BINDINGS_VERSION = 1;
const CLOUD_VECTOR_SLOT_KEY_PREFIX = 'bb_memory_cloud_vector_slot_';

// v9.2.0 存储键：旧时间条目已改为里程碑，旧时间线程已改为时间线
const NPC_KEY = 'bb_npc_chat_';
const ITEM_KEY = 'bb_item_chat_';
const MILESTONE_KEY = 'bb_milestone_chat_';
const TIMELINE_KEY = 'bb_timeline_chat_';
const MEMORY_KEY = 'bb_mem_chat_';
const LEGACY_THREAD_KEY = 'bb_timeline_threads_';
const MAP_KEY = 'bb_map_chat_';
const CLUE_BOARD_KEY = 'bb_clue_board_';

function looksLikeLegacyMilestoneList(data) {
    return Array.isArray(data) && data.some(entry =>
        entry && typeof entry === 'object'
        && (entry.event || entry.storyTime || entry.impact)
        && !entry.name
        && !Array.isArray(entry.entries)
    );
}

function slotKey(charId, slotName) {
    return `${SLOT_PREFIX}${charId}_${slotName}`;
}

function normalizeBindingId(value) {
    const text = String(value ?? '').trim();
    return text || null;
}

function normalizeChatSlotBindings(raw) {
    const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const rawEntries = source.entries && typeof source.entries === 'object' && !Array.isArray(source.entries)
        ? source.entries
        : source;
    const entries = {};

    for (const [charKey, chatMap] of Object.entries(rawEntries || {})) {
        const charId = normalizeBindingId(charKey);
        if (!charId || !chatMap || typeof chatMap !== 'object' || Array.isArray(chatMap)) continue;

        const cleanMap = {};
        for (const [chatKey, rawEntry] of Object.entries(chatMap)) {
            const chatId = normalizeBindingId(chatKey);
            if (!chatId) continue;
            const slotName = typeof rawEntry === 'string'
                ? rawEntry.trim()
                : String(rawEntry?.slotName || '').trim();
            if (!slotName) continue;
            cleanMap[chatId] = {
                slotName,
                updatedAt: Number(rawEntry?.updatedAt) || 0,
            };
        }

        if (Object.keys(cleanMap).length) entries[charId] = cleanMap;
    }

    return { version: CHAT_SLOT_BINDINGS_VERSION, entries };
}

export function getChatSlotBinding(charId, chatId) {
    const c = normalizeBindingId(charId);
    const ch = normalizeBindingId(chatId);
    if (!c || !ch) return null;
    const bindings = normalizeChatSlotBindings(getSettings().chatSlotBindings);
    return bindings.entries?.[c]?.[ch] || null;
}

export function getBoundSlotName(charId, chatId) {
    return getChatSlotBinding(charId, chatId)?.slotName || '';
}

export function bindChatToSlot(charId, chatId, slotName, options = {}) {
    const c = normalizeBindingId(charId);
    const ch = normalizeBindingId(chatId);
    const name = String(slotName || 'default').trim() || 'default';
    if (!c || !ch) return null;

    const bindings = normalizeChatSlotBindings(getSettings().chatSlotBindings);
    const existing = bindings.entries?.[c]?.[ch] || null;
    if (existing?.slotName && options.overwrite === false) {
        if (options.updateCurrent !== false) updateSettings({ currentSlotName: existing.slotName });
        return existing;
    }

    if (!bindings.entries[c]) bindings.entries[c] = {};
    const entry = { slotName: name, updatedAt: Date.now() };
    bindings.entries[c][ch] = entry;

    const patch = { chatSlotBindings: bindings };
    if (options.updateCurrent !== false) patch.currentSlotName = name;
    updateSettings(patch);
    return entry;
}

export function clearChatSlotBinding(charId, chatId) {
    const c = normalizeBindingId(charId);
    const ch = normalizeBindingId(chatId);
    if (!c || !ch) return false;

    const bindings = normalizeChatSlotBindings(getSettings().chatSlotBindings);
    if (!bindings.entries?.[c]?.[ch]) return false;
    delete bindings.entries[c][ch];
    if (!Object.keys(bindings.entries[c]).length) delete bindings.entries[c];
    updateSettings({ chatSlotBindings: bindings });
    return true;
}

export function clearSlotBindingsForSlot(charId, slotName) {
    const c = normalizeBindingId(charId);
    const name = String(slotName || '').trim();
    if (!c || !name) return 0;

    const bindings = normalizeChatSlotBindings(getSettings().chatSlotBindings);
    const chatMap = bindings.entries?.[c];
    if (!chatMap) return 0;

    let removed = 0;
    for (const [chatId, entry] of Object.entries(chatMap)) {
        if (entry?.slotName === name) {
            delete chatMap[chatId];
            removed++;
        }
    }
    if (!Object.keys(chatMap).length) delete bindings.entries[c];
    if (removed) updateSettings({ chatSlotBindings: bindings });
    return removed;
}

function clonePlain(value) {
    if (!value || typeof value !== 'object') return value;
    try {
        return JSON.parse(JSON.stringify(value));
    } catch {
        return Array.isArray(value) ? [...value] : { ...value };
    }
}

function createEmptySlotData() {
    const now = Date.now();
    return {
        npc: [],
        items: [],
        milestones: [],
        timeline: [],
        memories: [],
        map: { locations: {} },
        clueBoard: { nodes: [], connections: [], updatedAt: 0 },
        _slotEmpty: true,
        _slotCreatedAt: now,
        _slotUpdatedAt: now,
        _slotBoundChatId: '',
    };
}

/**
 * v9.3.1 槽归属守卫。
 *
 * 分支串档 bug 的成因：切换窗口时自动保存把「未绑定聊天」的数据
 * 覆盖写进了全局 currentSlotName 指向的槽（往往是上一个聊天的槽），
 * 于是分支 if 的内容盖掉了正剧存档。
 *
 * 这里从槽这一侧再上一道锁：槽记录自己属于哪个聊天，
 * 来源聊天不一致时拒绝自动覆盖。
 */
function assertSlotOwnership(existing, chatId, slotName, options = {}) {
    if (options.force === true) return;
    const expect = options.expectChatId;
    if (!expect) return;
    const owner = existing?._slotBoundChatId;
    if (!owner) return;
    if (String(owner) === String(expect)) return;
    throw new Error(
        `存档 "${slotName}" 当前归属聊天「${String(owner).slice(0, 32)}」，`
        + `与来源聊天「${String(chatId).slice(0, 32)}」不一致，已阻止覆盖写入`
    );
}

// ═══ v5 四柱数据读写 ═══

async function readAllPillarData(chatId) {
    const lf = getLocalForage();
    const [npc, items, rawMilestones, rawTimeline, memories, legacyThreads, map, clueBoard] = await Promise.all([
        lf.getItem(NPC_KEY + chatId),
        lf.getItem(ITEM_KEY + chatId),
        lf.getItem(MILESTONE_KEY + chatId),
        lf.getItem(TIMELINE_KEY + chatId),
        lf.getItem(MEMORY_KEY + chatId),
        lf.getItem(LEGACY_THREAD_KEY + chatId),
        lf.getItem(MAP_KEY + chatId),
        lf.getItem(CLUE_BOARD_KEY + chatId),
    ]);
    const legacyMilestones = looksLikeLegacyMilestoneList(rawTimeline) ? rawTimeline : [];
    const timeline = looksLikeLegacyMilestoneList(rawTimeline)
        ? (Array.isArray(legacyThreads) ? legacyThreads : [])
        : (Array.isArray(rawTimeline) ? rawTimeline : (Array.isArray(legacyThreads) ? legacyThreads : []));
    const data = {
        npc: Array.isArray(npc) ? npc : [],
        items: Array.isArray(items) ? items : [],
        milestones: Array.isArray(rawMilestones) && rawMilestones.length ? rawMilestones : legacyMilestones,
        timeline,
        memories: Array.isArray(memories) ? memories : [],
        map: normalizeMapData(map),
        clueBoard: normalizeClueBoardData(clueBoard),
    };
    await normalizeDataEmbeddingsToRefs(chatId, data);
    return stripRuntimeEmbeddings(data);
}

async function writeAllPillarData(chatId, data) {
    const lf = getLocalForage();
    const normalized = normalizeSlotData(data);
    await importVectorPack(chatId, data?.vectorPack);
    await normalizeDataEmbeddingsToRefs(chatId, normalized);
    const clean = stripRuntimeEmbeddings(normalized);
    await Promise.all([
        lf.setItem(NPC_KEY + chatId, clean.npc),
        lf.setItem(ITEM_KEY + chatId, clean.items),
        lf.setItem(MILESTONE_KEY + chatId, clean.milestones),
        lf.setItem(TIMELINE_KEY + chatId, clean.timeline),
        lf.setItem(MEMORY_KEY + chatId, clean.memories),
        lf.removeItem(LEGACY_THREAD_KEY + chatId),
        lf.setItem(MAP_KEY + chatId, clean.map),
        lf.setItem(CLUE_BOARD_KEY + chatId, clean.clueBoard),
    ]);
}

function normalizeMapData(map) {
    const safe = (map && typeof map === 'object' && map.locations && typeof map.locations === 'object')
        ? map
        : { locations: {} };
    const cloned = clonePlain(safe) || { locations: {} };
    if (!cloned.locations || typeof cloned.locations !== 'object') cloned.locations = {};
    return cloned;
}

function normalizeClueBoardData(board) {
    return clonePlain({
        nodes: Array.isArray(board?.nodes) ? board.nodes : [],
        connections: Array.isArray(board?.connections) ? board.connections : [],
        updatedAt: board?.updatedAt || 0,
    });
}

function normalizeSlotData(raw) {
    if (raw?.schema === 'bb-memory-vector-ref-v1' && raw.data && typeof raw.data === 'object') {
        const data = normalizeSlotData(raw.data);
        data.vectorPack = raw.vectorPack || raw.data.vectorPack || null;
        return data;
    }
    const now = Date.now();
    if (Array.isArray(raw)) {
        return { ...createEmptySlotData(), memories: clonePlain(raw), _slotEmpty: raw.length === 0 };
    }
    if (!raw || typeof raw !== 'object') {
        return createEmptySlotData();
    }
    const rawTimelineLooksLegacy = looksLikeLegacyMilestoneList(raw.timeline);
    const milestones = Array.isArray(raw.milestones)
        ? clonePlain(raw.milestones)
        : (rawTimelineLooksLegacy && Array.isArray(raw.timeline) ? clonePlain(raw.timeline) : []);
    const timeline = rawTimelineLooksLegacy
        ? (Array.isArray(raw.threads) ? clonePlain(raw.threads) : [])
        : (Array.isArray(raw.timeline) ? clonePlain(raw.timeline) : (Array.isArray(raw.threads) ? clonePlain(raw.threads) : []));
    const normalized = {
        npc: Array.isArray(raw.npc) ? clonePlain(raw.npc) : [],
        items: Array.isArray(raw.items) ? clonePlain(raw.items) : [],
        milestones,
        timeline,
        memories: Array.isArray(raw.memories) ? clonePlain(raw.memories) : [],
        map: normalizeMapData(raw.map || raw.mapData),
        clueBoard: normalizeClueBoardData(raw.clueBoard || raw.clues),
        _slotEmpty: raw._slotEmpty === true,
        _slotCreatedAt: raw._slotCreatedAt || raw.createdAt || now,
        _slotUpdatedAt: raw._slotUpdatedAt || raw.updatedAt || now,
        _slotBoundChatId: raw._slotBoundChatId || '',
    };
    normalized._slotEmpty =
        normalized.npc.length + normalized.items.length + normalized.milestones.length + normalized.timeline.length + normalized.memories.length +
        Object.keys(normalized.map.locations || {}).length + normalized.clueBoard.nodes.length === 0;
    return normalized;
}

function totalCount(data) {
    if (!data) return 0;
    // Support old format (flat array) and new format (pillar object)
    if (Array.isArray(data)) return data.length;
    const normalized = normalizeSlotData(data);
    return normalized.npc.length
        + normalized.items.length
        + normalized.milestones.length
        + normalized.timeline.length
        + normalized.memories.length
        + Object.keys(normalized.map.locations || {}).length
        + normalized.clueBoard.nodes.length;
}

function countSlotEmbeddings(data) {
    if (!data || typeof data !== 'object') return 0;
    const normalized = normalizeSlotData(data);
    return countEmbeddingRefs(normalized);
}

function buildCloudSlotPayload(data) {
    const normalized = normalizeSlotData(data);
    return stripRuntimeEmbeddings(stripSlotEmbeddings(normalized));
}

export async function getChatSlotDataSummary(chatId) {
    const data = await readAllPillarData(chatId);
    return {
        count: totalCount(data),
        embeddingCount: countSlotEmbeddings(data),
        data,
    };
}

// ═══ 角色ID获取 ═══

/**
 * v9.3.1 起返回**稳定**角色 ID（char:<avatar> / group:<groupId>）。
 *
 * v9.3.0 及更早使用 ctx.characterId —— 那是 characters 数组下标，
 * 导入/删除角色后会平移，导致整个存档命名空间失联（存档"消失"），
 * 甚至跨角色覆盖写入。详见 slot-identity.js 文件头。
 */
export function getCharacterId() {
    return getStableCharacterId();
}

// ═══ 槽列表 ═══

/**
 * 列出该角色的所有存档槽（合并本地 + chatMetadata 远程槽）
 * v8.5.1 合并远程槽索引，实现跨设备槽可见
 */
export async function listSlots(charId) {
    if (!charId) return [];
    const lf = getLocalForage();
    const slots = [];
    const localByName = new Map();

    // 优先从索引读取（O(1) 查询），避免 lf.iterate 全库扫描
    const known = await lf.getItem('bb_memory_slot_list_' + charId);
    if (Array.isArray(known) && known.length > 0) {
        for (const name of known) {
            const data = await lf.getItem(slotKey(charId, name));
            if (data === null || data === undefined) continue;
            const slot = {
                name,
                count: totalCount(data),
                key: slotKey(charId, name),
                remote: false,
                localAvailable: true,
                localCount: totalCount(data),
                embeddingCount: countSlotEmbeddings(data),
                createdAt: data?._slotCreatedAt || data?.createdAt || 0,
                updatedAt: data?._slotUpdatedAt || data?.updatedAt || 0,
            };
            slots.push(slot);
            localByName.set(name, slot);
        }
    } else {
        // 索引缺失时回退到全库扫描
        try {
            await lf.iterate((value, key) => {
                const prefix = `${SLOT_PREFIX}${charId}_`;
                if (key.startsWith(prefix)) {
                    const slotName = key.slice(prefix.length);
                    const count = totalCount(value);
                    const slot = {
                        name: slotName,
                        count,
                        key,
                        remote: false,
                        localAvailable: true,
                        localCount: count,
                        embeddingCount: countSlotEmbeddings(value),
                        createdAt: value?._slotCreatedAt || value?.createdAt || 0,
                        updatedAt: value?._slotUpdatedAt || value?.updatedAt || 0,
                    };
                    slots.push(slot);
                    localByName.set(slotName, slot);
                }
            });
        } catch { /* ignore */ }
    }

    if (!slots.find(s => s.name === 'default')) {
        const defaultSlot = { name: 'default', count: 0, key: slotKey(charId, 'default'), remote: false, localAvailable: false, localCount: 0, virtualLocal: true };
        slots.unshift(defaultSlot);
        localByName.set('default', defaultSlot);
    }

    // v9.0.6 slot payloads may exist in chatMetadata; embeddings are included only by explicit user action.
    const remoteIndex = getRemoteSlotIndex(charId);
    for (const [name, meta] of Object.entries(remoteIndex.slots || {})) {
        const total = (meta.npc || 0) + (meta.items || 0) + (meta.milestones || 0) + (meta.timeline || 0) + (meta.mem || 0) + (meta.map || 0) + (meta.clues || 0);
        const remotePayloadAvailable = slotPayloadExistsInChatMetadata(charId, name);
        const local = localByName.get(name);
        if (local) {
            local.remoteAvailable = true;
            local.remotePayloadAvailable = remotePayloadAvailable;
            local.remoteIndexOnly = local.localAvailable === false ? !remotePayloadAvailable : false;
            if (local.localAvailable === false) {
                local.remote = true;
                local.remoteOnly = true;
                local.count = total;
                local.localCount = 0;
            }
            local.remoteCount = total;
            local.remoteTs = meta.ts || 0;
            local.remoteEmbeddings = meta.embeddings || 0;
            continue;
        }
        slots.push({
            name,
            count: total,
            key: slotKey(charId, name),
            remote: true,
            localAvailable: false,
            remoteOnly: true,
            remoteIndexOnly: !remotePayloadAvailable,
            remoteAvailable: true,
            remotePayloadAvailable,
            remoteCount: total,
            remoteEmbeddings: meta.embeddings || 0,
            remoteTs: meta.ts || 0,
        });
    }

    return slots;
}

/**
 * 更新槽列表索引
 */
async function updateSlotIndex(charId, slots) {
    try {
        const names = slots
            .filter(s => s.localAvailable !== false && !s.remoteIndexOnly)
            .map(s => s.name);
        await getLocalForage().setItem('bb_memory_slot_list_' + charId, names);
    } catch { /* ignore */ }
}

// ═══ 槽操作 ═══

/**
 * 将当前聊天记忆保存到指定槽（覆盖式）
 * v8.5.1 同步槽数据到 chatMetadata 实现跨设备共享
 */
export async function saveToSlot(charId, chatId, slotName, options = {}) {
    if (!charId || !chatId) throw new Error('无法获取角色或聊天ID');

    const data = await readAllPillarData(chatId);
    const lf = getLocalForage();
    const existing = await lf.getItem(slotKey(charId, slotName));
    assertSlotOwnership(existing, chatId, slotName, options);
    const now = Date.now();
    data._slotEmpty = totalCount(data) === 0;
    data._slotCreatedAt = existing?._slotCreatedAt || existing?.createdAt || now;
    data._slotUpdatedAt = now;
    data._slotBoundChatId = String(chatId);
    await normalizeDataEmbeddingsToRefs(chatId, data);
    const cleanData = stripRuntimeEmbeddings(data);
    await lf.setItem(slotKey(charId, slotName), cleanData);
    if (options.bindChat !== false) bindChatToSlot(charId, chatId, slotName);

    const slots = await listSlots(charId);
    if (!slots.find(s => s.name === slotName)) {
        slots.push({ name: slotName, count: totalCount(data), key: slotKey(charId, slotName) });
    }
    await updateSlotIndex(charId, slots);

    const syncCloud = options.syncCloud !== false;
    let dataSynced = false;
    let indexSynced = false;
    let jsonSize = 0;
    if (syncCloud) {
        dataSynced = await pushSlotDataToChatMetadata(charId, slotName, cleanData, options.context || null);
        indexSynced = await syncSlotIndexToChatMetadata(charId);
        jsonSize = JSON.stringify(buildCloudSlotPayload(cleanData)).length;
    }

    return {
        count: totalCount(cleanData),
        data: cleanData,
        cloudSynced: indexSynced,
        cloudDataSynced: dataSynced,
        cloudDataSize: jsonSize,
        embeddingsIncluded: false,
        embeddingCount: countSlotEmbeddings(cleanData),
    };
}

export async function cloneSlot(charId, sourceSlotName, targetSlotName, options = {}) {
    if (!charId) throw new Error('无法获取角色ID');
    const sourceName = String(sourceSlotName || '').trim();
    const targetName = String(targetSlotName || '').trim();
    if (!sourceName) throw new Error('来源存档名不能为空');
    if (!targetName) throw new Error('新存档名不能为空');
    if (sourceName === targetName) throw new Error('新存档名不能与来源存档相同');

    const lf = getLocalForage();
    const existing = await lf.getItem(slotKey(charId, targetName));
    if (existing !== null && existing !== undefined) {
        throw new Error(`存档 "${targetName}" 已存在`);
    }
    const remoteIndex = getRemoteSlotIndex(charId);
    if (remoteIndex.slots?.[targetName]) {
        throw new Error(`云端已存在同名存档 "${targetName}"，请换一个名称`);
    }

    let raw = await lf.getItem(slotKey(charId, sourceName));
    if (raw === null || raw === undefined) {
        const pulled = await pullSlotFromChatMetadata(charId, sourceName);
        if (pulled !== null && pulled !== undefined) raw = await lf.getItem(slotKey(charId, sourceName));
    }
    if (raw === null || raw === undefined) {
        throw new Error(`未找到来源存档 "${sourceName}"，或云端仅保留索引但没有可加载数据`);
    }

    const now = Date.now();
    const data = normalizeSlotData(raw);
    data._slotEmpty = totalCount(data) === 0;
    data._slotCreatedAt = now;
    data._slotUpdatedAt = now;
    data._slotBranchedFrom = sourceName;
    // v9.3.1 副本不继承来源槽的归属聊天，否则 if 分支会"继承"正剧的归属，
    // 之后的自动保存就会写回正剧存档（分支串档 bug 的一条路径）。
    data._slotBoundChatId = String(options.boundChatId || '');
    await normalizeDataEmbeddingsToRefs('', data);
    const cleanData = stripRuntimeEmbeddings(data);
    await lf.setItem(slotKey(charId, targetName), cleanData);

    const slots = await listSlots(charId);
    if (!slots.find(s => s.name === targetName)) {
        slots.push({ name: targetName, count: totalCount(data), key: slotKey(charId, targetName) });
    }
    await updateSlotIndex(charId, slots);

    const syncCloud = options.syncCloud !== false;
    let dataSynced = false;
    let indexSynced = false;
    let jsonSize = 0;
    if (syncCloud) {
        dataSynced = await pushSlotDataToChatMetadata(charId, targetName, cleanData, options.context || null);
        indexSynced = await syncSlotIndexToChatMetadata(charId);
        jsonSize = JSON.stringify(buildCloudSlotPayload(cleanData)).length;
    }

    return {
        name: targetName,
        source: sourceName,
        count: totalCount(cleanData),
        data: cleanData,
        cloudSynced: indexSynced,
        cloudDataSynced: dataSynced,
        cloudDataSize: jsonSize,
        embeddingsIncluded: false,
        embeddingCount: countSlotEmbeddings(cleanData),
    };
}

/**
 * 从指定槽加载数据到当前聊天（覆盖当前聊天数据）
 * v8.2.0 仅在当前聊天已有数据时重新生成 ID 以避免冲突
 */
export async function loadFromSlot(charId, chatId, slotName, options = {}) {
    if (!charId || !chatId) throw new Error('无法获取角色或聊天ID');

    const lf = getLocalForage();
    let raw = await lf.getItem(slotKey(charId, slotName));

    // Pull cloud data only when there is no local slot. A deliberate local empty
    // slot must stay empty, otherwise stale cloud data can leak maps/timeline into it.
    let pulledFromCloud = false;
    if (raw === null || raw === undefined) {
        const pulled = await pullSlotFromChatMetadata(charId, slotName);
        if (pulled !== null && pulled !== undefined) {
            raw = await lf.getItem(slotKey(charId, slotName));
            pulledFromCloud = true;
        }
    }

    if (raw === null || raw === undefined) {
        throw new Error(`存档 "${slotName}" 没有本地数据，云端也没有可加载的完整数据；当前记忆未被覆盖`);
    }

    // 兼容旧格式（扁平记忆数组）和新格式（五柱对象，v8.9.0 含地图/线索板）
    let data = normalizeSlotData(raw);

    // 检查当前聊天是否已有数据，仅在有冲突风险时重新生成 ID
    const currentData = await readAllPillarData(chatId);
    const hasExistingData = currentData.npc.length > 0 || currentData.items.length > 0 ||
        currentData.milestones.length > 0 || currentData.timeline.length > 0 || currentData.memories.length > 0 ||
        Object.keys(currentData.map.locations || {}).length > 0 ||
        currentData.clueBoard.nodes.length > 0;

    if (hasExistingData && options.preserveIds !== true) {
        const oldIds = {
            npc: data.npc.map(e => e.id),
            item: data.items.map(e => e.id),
            milestone: data.milestones.map(e => e.id),
            mem: data.memories.map(e => e.id),
            timeline: data.timeline.map(e => e.id),
        };

        const now = Date.now();
        const newId = (i) => `bb_${now + i}_${Math.random().toString(36).slice(2, 7)}`;
        data.npc = data.npc.map((e, i) => ({ ...e, id: newId(i) }));
        data.items = data.items.map((e, i) => ({ ...e, id: newId(i + data.npc.length) }));
        data.milestones = data.milestones.map((e, i) => ({ ...e, id: newId(i + data.npc.length + data.items.length) }));
        data.memories = data.memories.map((e, i) => ({ ...e, id: newId(i + data.npc.length + data.items.length + data.milestones.length) }));
        data.timeline = data.timeline.map((e, i) => ({ ...e, id: newId(i + data.npc.length + data.items.length + data.milestones.length + data.memories.length) }));
        // v8.9.0 重映射时间线与线索板引用，修复 ID 重生后引用断裂
        const idMaps = {
            npc: new Map(oldIds.npc.map((id, i) => [id, data.npc[i]?.id])),
            item: new Map(oldIds.item.map((id, i) => [id, data.items[i]?.id])),
            milestone: new Map(oldIds.milestone.map((id, i) => [id, data.milestones[i]?.id])),
            mem: new Map(oldIds.mem.map((id, i) => [id, data.memories[i]?.id])),
            timeline: new Map(oldIds.timeline.map((id, i) => [id, data.timeline[i]?.id])),
        };
        idMaps.items = idMaps.item;
        idMaps.memory = idMaps.mem;
        idMaps.memories = idMaps.mem;
        const milestoneIdMap = idMaps.milestone;
        if (milestoneIdMap.size > 0 || idMaps.timeline.size > 0) {
            for (const thread of data.timeline) {
                if (thread.parentThreadId && idMaps.timeline.has(thread.parentThreadId)) {
                    thread.parentThreadId = idMaps.timeline.get(thread.parentThreadId);
                }
                if (Array.isArray(thread.entries)) {
                    for (const entry of thread.entries) {
                        if (entry.refId && milestoneIdMap.has(entry.refId)) {
                            entry.refId = milestoneIdMap.get(entry.refId);
                        }
                    }
                }
            }
        }
        for (const node of data.clueBoard.nodes) {
            const refType = node.refType === 'timeline' ? 'milestone' : node.refType;
            const map = idMaps[refType];
            if (node.refId && map?.has(node.refId)) {
                node.refId = map.get(node.refId);
            }
        }
    }

    await writeAllPillarData(chatId, data);
    if (options.bindChat !== false) {
        bindChatToSlot(charId, chatId, slotName);
        // v9.3.1 槽反向记录归属聊天，后续自动保存据此拒绝跨聊天覆盖
        await claimSlotForChat(charId, slotName, chatId);
    }

    // v9.0.3: 从云端拉取的数据缺少 embedding，后台补全
    if (pulledFromCloud) {
        scheduleSlotReembed(chatId);
    }

    return { count: totalCount(data), data, pulledFromCloud, embeddingCount: countSlotEmbeddings(data) };
}

/**
 * v9.3.1 在槽数据上记录归属聊天。
 * 只改元字段，不触碰四柱内容，避免任何数据风险。
 */
export async function claimSlotForChat(charId, slotName, chatId) {
    if (!charId || !slotName || !chatId) return false;
    const lf = getLocalForage();
    try {
        const raw = await lf.getItem(slotKey(charId, slotName));
        if (raw === null || raw === undefined || typeof raw !== 'object' || Array.isArray(raw)) return false;
        if (String(raw._slotBoundChatId || '') === String(chatId)) return true;
        raw._slotBoundChatId = String(chatId);
        await lf.setItem(slotKey(charId, slotName), raw);
        return true;
    } catch {
        return false;
    }
}

/**
 * 读取槽当前归属的聊天 ID（无归属返回空串）。
 */
export async function getSlotOwnerChatId(charId, slotName) {
    if (!charId || !slotName) return '';
    const lf = getLocalForage();
    try {
        const raw = await lf.getItem(slotKey(charId, slotName));
        return String(raw?._slotBoundChatId || '');
    } catch {
        return '';
    }
}

/**
 * 创建新的空存档槽
 */
export async function createEmptySlot(charId, slotName) {
    if (!charId) throw new Error('无法获取角色ID');
    if (!slotName || !slotName.trim()) throw new Error('槽名不能为空');

    const name = slotName.trim();
    const lf = getLocalForage();
    const existing = await lf.getItem(slotKey(charId, name));
    if (existing !== null && existing !== undefined) {
        throw new Error(`存档 "${name}" 已存在`);
    }
    const remoteIndex = getRemoteSlotIndex(charId);
    if (remoteIndex.slots?.[name]) {
        throw new Error(`云端已存在同名存档 "${name}"，请先拉取云端存档`);
    }

    await lf.setItem(slotKey(charId, name), createEmptySlotData());
    const slots = await listSlots(charId);
    // v8.2.5 修复：listSlots 优先走索引读取，新槽尚未入索引，需手动补入
    if (!slots.find(s => s.name === name)) {
        slots.push({ name, count: 0, key: slotKey(charId, name) });
    }
    await updateSlotIndex(charId, slots);

    await removeSlotDataFromChatMetadata(name, null, charId);
    const indexSynced = await syncSlotIndexToChatMetadata(charId);

    return { name, cloudSynced: indexSynced, cloudDataSynced: false };
}

/**
 * 删除指定存档槽
 * v8.2.0 仅从 localforage 删除，不涉及 chatMetadata
 */
export async function deleteSlot(charId, slotName) {
    if (!charId) throw new Error('无法获取角色ID');
    if (slotName === 'default') throw new Error('不能删除默认存档');

    const lf = getLocalForage();
    await lf.removeItem(slotKey(charId, slotName));

    const slots = await listSlots(charId);
    await updateSlotIndex(charId, slots.filter(s => s.name !== slotName));

    // v8.5.1 同步到 chatMetadata + 清理远程槽数据
    await syncSlotIndexToChatMetadata(charId, { removeSlotName: slotName });
    await removeSlotDataFromChatMetadata(slotName, null, charId);
    clearSlotBindingsForSlot(charId, slotName);
    if ((getSettings().currentSlotName || 'default') === slotName) {
        updateSettings({ currentSlotName: 'default' });
    }
}

/**
 * 获取指定槽中的记忆数量
 */
export async function getSlotCount(charId, slotName) {
    if (!charId) return 0;
    const lf = getLocalForage();
    const data = await lf.getItem(slotKey(charId, slotName));
    return totalCount(data);
}

/**
 * 导出指定槽的数据为 JSON 文件下载
 */
export async function exportSlot(charId, slotName) {
    if (!charId) throw new Error('无法获取角色ID');

    const lf = getLocalForage();
    let raw = await lf.getItem(slotKey(charId, slotName));

    if (raw === null || raw === undefined) {
        const pulled = await pullSlotFromChatMetadata(charId, slotName);
        if (pulled !== null && pulled !== undefined) {
            raw = await lf.getItem(slotKey(charId, slotName));
        }
    }

    if (raw === null || raw === undefined) {
        throw new Error(`存档 "${slotName}" 没有本地数据，云端也没有可导出的完整数据`);
    }

    const data = normalizeSlotData(raw);
    if (data.vectorPack) await importVectorPack('', data.vectorPack);
    await normalizeDataEmbeddingsToRefs('', data);
    const cleanData = stripRuntimeEmbeddings(stripSlotEmbeddings(data));
    const vectorPack = await buildVectorPack('', cleanData, { sourceSlot: slotName });
    const archive = {
        version: '9.3.1',
        schema: 'bb-memory-vector-ref-v1',
        exportedAt: Date.now(),
        source: 'slot',
        slotName,
        data: cleanData,
        vectorPack,
    };
    const blob = new Blob([JSON.stringify(archive, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `BB-Memory-${slotName}-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    return totalCount(cleanData);
}

// ═══════════════════════════════════════════════════════════
//  v8.5.1 chatMetadata 槽同步（跨设备共享）
// ═══════════════════════════════════════════════════════════

const SLOT_INDEX_KEY = 'bb_memory_slot_index';
const SLOT_DATA_PREFIX = 'bb_memory_slot_data_';

function encodeSlotPart(value) {
    return encodeURIComponent(String(value ?? ''));
}

function scopedSlotDataKey(charId, slotName) {
    return `${SLOT_DATA_PREFIX}${encodeSlotPart(charId)}__${encodeSlotPart(slotName)}`;
}

function legacySlotDataKey(slotName) {
    return SLOT_DATA_PREFIX + slotName;
}

/**
 * v9.3.1 除稳定 ID 作用域键外，还要读取已认领的历史命名空间作用域键，
 * 否则升级后旧的 chatMetadata 槽数据会全部读不到。
 * 注意：写入永远只用稳定 ID（scopedSlotDataKey(charId, ...) 为第一个元素）。
 */
function getSlotDataKeys(charId, slotName) {
    const keys = [];
    if (charId !== null && charId !== undefined) {
        keys.push(scopedSlotDataKey(charId, slotName));
        for (const alt of getAcceptableCharIdsSync(charId)) {
            if (String(alt) !== String(charId)) keys.push(scopedSlotDataKey(alt, slotName));
        }
    }
    keys.push(legacySlotDataKey(slotName));
    return [...new Set(keys)];
}

function slotPayloadExistsInChatMetadata(charId, slotName, context = null) {
    const ctx = context || getSTContext();
    if (!ctx || !ctx.chatMetadata) return false;
    return getSlotDataKeys(charId, slotName).some(key => {
        const raw = ctx.chatMetadata[key];
        return typeof raw === 'string' && raw.trim().length > 0;
    });
}

function getSTContext() {
    try { return SillyTavern.getContext(); } catch { return null; }
}

async function saveChatMeta(ctx) {
    if (!ctx) return false;
    let requested = false;
    if (typeof ctx.saveMetadataDebounced === 'function') {
        ctx.saveMetadataDebounced();
        requested = true;
    }
    if (!requested && typeof ctx.saveMetadata === 'function') {
        await Promise.resolve(ctx.saveMetadata());
        requested = true;
    }
    if (typeof ctx.saveChatDebounced === 'function') {
        ctx.saveChatDebounced();
        requested = true;
    }
    if (!requested && typeof ctx.saveChat === 'function') {
        await Promise.resolve(ctx.saveChat());
        requested = true;
    }
    return requested;
}

/**
 * 获取单个槽的各柱计数
 */
async function getSlotPillarCounts(charId, slotName) {
    const lf = getLocalForage();
    const data = await lf.getItem(slotKey(charId, slotName));
    if (Array.isArray(data)) {
        return { npc: 0, items: 0, milestones: 0, timeline: 0, mem: data.length, map: 0, clues: 0, embeddings: countSlotEmbeddings(data) };
    }
    if (!data || typeof data !== 'object') {
        return { npc: 0, items: 0, milestones: 0, timeline: 0, mem: 0, map: 0, clues: 0, embeddings: 0 };
    }
    const normalized = normalizeSlotData(data);
    return {
        npc: normalized.npc.length,
        items: normalized.items.length,
        milestones: normalized.milestones.length,
        timeline: normalized.timeline.length,
        mem: normalized.memories.length,
        map: Object.keys(normalized.map.locations || {}).length,
        clues: normalized.clueBoard.nodes.length,
        embeddings: countSlotEmbeddings(normalized),
    };
}

/**
 * 将槽索引元数据同步到 chatMetadata（轻量，仅名称+计数+时间戳）
 */
async function syncSlotIndexToChatMetadata(charId, options = {}) {
    const ctx = getSTContext();
    if (!ctx) return false;
    if (!ctx.chatMetadata) ctx.chatMetadata = {};

    const previousIndex = getRemoteSlotIndex(charId);
    const slots = await listSlots(charId);
    const index = { charId, slots: { ...(previousIndex.slots || {}) } };
    if (options.removeSlotName) delete index.slots[options.removeSlotName];
    for (const s of slots) {
        if (s.localAvailable === false || s.remoteIndexOnly) continue;
        const counts = await getSlotPillarCounts(charId, s.name);
        index.slots[s.name] = {
            ts: Date.now(),
            ...counts,
            payloadAvailable: slotPayloadExistsInChatMetadata(charId, s.name, ctx),
        };
    }
    ctx.chatMetadata[SLOT_INDEX_KEY] = JSON.stringify(index);
    return saveChatMeta(ctx);
}

/**
 * Remove legacy full slot payloads from chatMetadata. Slot sync is index-only now.
 */
async function removeSlotDataFromChatMetadata(slotName = null, context = null, charId = null) {
    const ctx = context || getSTContext();
    if (!ctx) return false;
    if (!ctx.chatMetadata) ctx.chatMetadata = {};

    let changed = false;
    const allowedKeys = slotName ? new Set(getSlotDataKeys(charId, slotName)) : null;
    for (const key of Object.keys(ctx.chatMetadata)) {
        if (!key.startsWith(SLOT_DATA_PREFIX)) continue;
        if (allowedKeys && !allowedKeys.has(key)) continue;
        delete ctx.chatMetadata[key];
        changed = true;
    }
    return changed ? saveChatMeta(ctx) : true;
}

/**
 * 将槽完整数据推送到 chatMetadata（跨设备共享）
 * v9.0.2 恢复数据同步，默认去除 embedding 向量以控制体积
 * v9.0.3 添加大小上限守卫，超过 chatMetadataBackupMaxKb 限制则跳过
 * v9.3.0 固定为文本+embeddingRef，同步向量请使用单一云端向量槽
 */
async function pushSlotDataToChatMetadata(charId, slotName, data, context = null) {
    const ctx = context || getSTContext();
    if (!ctx) return false;
    if (!ctx.chatMetadata) ctx.chatMetadata = {};

    const payload = buildCloudSlotPayload(data);
    payload._cloudEmbeddingsIncluded = false;
    payload._cloudEmbeddingCount = countSlotEmbeddings(data);
    payload._cloudUpdatedAt = Date.now();
    const json = JSON.stringify(payload);
    const limit = getSlotDataSizeLimit();
    if (json.length > limit) {
        console.warn(`[BB-Memory] 槽 "${slotName}" 数据大小 ${(json.length / 1024).toFixed(1)}KB 超过上限 ${(limit / 1024).toFixed(0)}KB，跳过云端同步`);
        await removeSlotDataFromChatMetadata(slotName, ctx, charId);
        return false;
    }
    const key = scopedSlotDataKey(charId, slotName);
    ctx.chatMetadata[key] = json;
    const legacyKey = legacySlotDataKey(slotName);
    if (legacyKey !== key && ctx.chatMetadata[legacyKey]) delete ctx.chatMetadata[legacyKey];
    return saveChatMeta(ctx);
}

function getSlotDataSizeLimit() {
    try {
        const ctx = getSTContext();
        const kb = Number(ctx?.extensionSettings?.bb_memory?.chatMetadataBackupMaxKb) || 2048;
        return Math.max(128, Math.min(8192, kb)) * 1024;
    } catch { return 2048 * 1024; }
}

function cloudVectorSlotKey(charId) {
    return CLOUD_VECTOR_SLOT_KEY_PREFIX + String(charId || 'global');
}

function getCloudVectorSlotSizeLimit() {
    try {
        const ctx = getSTContext();
        const kb = Number(ctx?.extensionSettings?.bb_memory?.cloudVectorSlotMaxKb)
            || Number(ctx?.extensionSettings?.bb_memory?.chatMetadataBackupMaxKb)
            || 2048;
        return Math.max(128, Math.min(16384, kb)) * 1024;
    } catch { return 2048 * 1024; }
}

export function getCloudVectorSlot(charId) {
    const ctx = getSTContext();
    const raw = ctx?.chatMetadata?.[cloudVectorSlotKey(charId)];
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? { ...parsed, size: raw.length } : null;
    } catch {
        return null;
    }
}

export async function pushSlotVectorsToCloud(charId, slotName) {
    if (!charId) throw new Error('无法获取角色ID');
    const name = String(slotName || '').trim();
    if (!name) throw new Error('存档名不能为空');
    const ctx = getSTContext();
    if (!ctx) throw new Error('无法访问 SillyTavern 上下文');
    if (!ctx.chatMetadata) ctx.chatMetadata = {};

    const lf = getLocalForage();
    let data = await lf.getItem(slotKey(charId, name));
    if (data === null || data === undefined) {
        const pulled = await pullSlotFromChatMetadata(charId, name);
        if (pulled) data = await lf.getItem(slotKey(charId, name));
    }
    if (data === null || data === undefined) throw new Error(`未找到本地存档 "${name}"`);

    const normalized = normalizeSlotData(data);
    await normalizeDataEmbeddingsToRefs('', normalized);
    const vectorPack = await buildVectorPack('', normalized, { sourceSlot: name });
    const payload = {
        version: '9.3.1',
        schema: 'bb-memory-cloud-vector-slot-v1',
        charId,
        slotName: name,
        count: totalCount(normalized),
        embeddingCount: vectorPack.records.length,
        vectorPack,
        updatedAt: Date.now(),
    };
    const json = JSON.stringify(payload);
    const limit = getCloudVectorSlotSizeLimit();
    if (json.length > limit) {
        return { synced: false, skipped: true, reason: 'size-limit', size: json.length, limit, ...payload };
    }
    ctx.chatMetadata[cloudVectorSlotKey(charId)] = json;
    await saveChatMeta(ctx);
    return { synced: true, skipped: false, size: json.length, limit, ...payload };
}

export async function pullCloudVectors(charId) {
    const payload = getCloudVectorSlot(charId);
    if (!payload?.vectorPack) return { imported: 0, skipped: 0, payload: null };
    const result = await importVectorPack('', payload.vectorPack);
    return { ...result, payload };
}

/**
 * v9.0.3 后台补全从云端拉取的存档缺失的 embedding 向量
 * fire-and-forget：不阻塞 loadFromSlot 返回
 */
async function scheduleSlotReembed(chatId) {
    try {
        const ctx = getSTContext();
        const s = ctx?.extensionSettings?.bb_memory || {};
        if (!s.embeddingEnabled || !s.embeddingEndpoint) return;

        const data = await readAllPillarData(chatId);
        const pillars = [
            { key: 'npc', entries: data.npc, collection: 'npc', label: 'NPC' },
            { key: 'items', entries: data.items, collection: 'item', label: '物品' },
            { key: 'milestones', entries: data.milestones, collection: 'milestone', label: '里程碑' },
            { key: 'timeline', entries: data.timeline, collection: 'timeline', label: '时间线' },
            { key: 'memories', entries: data.memories, collection: 'mem', label: '记忆' },
            { key: 'map', entries: Object.values(data.map?.locations || {}), collection: 'map', label: '地图' },
        ];

        const needs = pillars.map(p => ({
            ...p,
            missing: p.entries.filter(e => e && !e.embeddingRef?.id && !e.embedding),
        }));
        const total = needs.reduce((sum, n) => sum + n.missing.length, 0);
        if (total === 0) return;

        console.log(`[BB-Memory] 后台补向量：共 ${total} 条需要向量化`);

        // fire-and-forget
        (async () => {
            let done = 0;
            let failed = 0;
            try {
                const ag = await import('./auto-generator.js');
                for (const n of needs) {
                    if (n.missing.length === 0) continue;
                    const result = await ag.embedExistingMemories(chatId, n.missing, null, n.collection);
                    done += result.updated || 0;
                    failed += result.failed || 0;
                }
            } catch (e) {
                console.warn('[BB-Memory] 后台补向量异常:', e.message);
                failed += total - done;
            }
            if (done > 0) {
                const msg = `存档向量补全完成：成功 ${done} 条` + (failed > 0 ? `，失败 ${failed} 条` : '');
                console.log(`[BB-Memory] ${msg}`);
                try {
                    const ctx2 = getSTContext();
                    if (typeof ctx2?.toastr?.success === 'function') {
                        ctx2.toastr.success(msg, 'BB-Memory 存档同步');
                    }
                } catch { /* ignore */ }
            }
        })();
    } catch (e) {
        console.warn('[BB-Memory] scheduleSlotReembed 启动失败:', e.message);
    }
}

function stripSlotEmbeddings(data) {
    if (!data || typeof data !== 'object') return data;
    const strip = (entry) => {
        if (!entry || typeof entry !== 'object') return entry;
        const { embedding, ...rest } = entry;
        return rest;
    };
    const stripMap = (map) => {
        const normalized = normalizeMapData(map);
        const locations = {};
        for (const [id, loc] of Object.entries(normalized.locations || {})) {
            locations[id] = strip(loc);
        }
        return { ...normalized, locations };
    };
    return {
        npc: Array.isArray(data.npc) ? data.npc.map(strip) : [],
        items: Array.isArray(data.items) ? data.items.map(strip) : [],
        milestones: Array.isArray(data.milestones) ? data.milestones.map(strip) : [],
        timeline: Array.isArray(data.timeline) ? data.timeline.map(strip) : [],
        memories: Array.isArray(data.memories) ? data.memories.map(strip) : [],
        map: stripMap(data.map),
        clueBoard: data.clueBoard || { nodes: [], connections: [], updatedAt: 0 },
        _slotEmpty: data._slotEmpty === true,
        _slotCreatedAt: data._slotCreatedAt || data.createdAt || Date.now(),
        _slotUpdatedAt: data._slotUpdatedAt || data.updatedAt || Date.now(),
    };
}

/**
 * 从 chatMetadata 读取远程槽索引
 */
export function getRemoteSlotIndex(charId) {
    const ctx = getSTContext();
    if (!ctx || !ctx.chatMetadata) return { slots: {} };
    const raw = ctx.chatMetadata[SLOT_INDEX_KEY];
    if (!raw) return { slots: {} };
    try {
        const parsed = JSON.parse(raw);
        // v9.3.1 升级后本地 charId 变为稳定 ID，而已有 chatMetadata 里仍是旧下标。
        // 接受稳定 ID 以及所有已认领的历史命名空间，避免云端槽整体失联。
        if (parsed?.charId !== undefined && charId !== undefined && charId !== null) {
            const acceptable = new Set(getAcceptableCharIdsSync(charId).map(String));
            acceptable.add(String(charId));
            if (!acceptable.has(String(parsed.charId))) return { slots: {} };
        }
        return parsed && parsed.slots ? parsed : { slots: {} };
    } catch {
        return { slots: {} };
    }
}

/**
 * 从 chatMetadata 拉取槽数据到 localforage
 * 返回写入的条目数，失败返回 null
 */
export async function pullSlotFromChatMetadata(charId, slotName) {
    const ctx = getSTContext();
    if (!ctx || !ctx.chatMetadata) return null;

    let raw = null;
    for (const key of getSlotDataKeys(charId, slotName)) {
        if (ctx.chatMetadata[key]) {
            raw = ctx.chatMetadata[key];
            break;
        }
    }
    if (!raw) return null;

    let data;
    try { data = JSON.parse(raw); } catch { return null; }

    const normalized = normalizeSlotData(data);

    const lf = getLocalForage();
    await lf.setItem(slotKey(charId, slotName), normalized);

    // 更新槽索引，确保 listSlots 能立即找到
    const known = await lf.getItem('bb_memory_slot_list_' + charId);
    const names = Array.isArray(known) ? known : [];
    if (!names.includes(slotName)) {
        names.push(slotName);
        await lf.setItem('bb_memory_slot_list_' + charId, names);
    }

    return totalCount(normalized);
}

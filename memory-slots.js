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

// ═══ localforage 访问 ═══

function getLocalForage() {
    return SillyTavern.libs.localforage;
}

// ═══ 存储键 ═══

const SLOT_PREFIX = 'bb_memory_slot_';

// v5 四柱存储键
const PILLAR_KEYS = ['bb_npc_chat_', 'bb_item_chat_', 'bb_timeline_chat_', 'bb_mem_chat_'];
const PILLAR_NAMES = ['npc', 'items', 'timeline', 'memories'];

// v7.5.0 时间线线程存储键（独立于四柱）
const THREAD_KEY = 'bb_timeline_threads_';
const MAP_KEY = 'bb_map_chat_';
const CLUE_BOARD_KEY = 'bb_clue_board_';

function slotKey(charId, slotName) {
    return `${SLOT_PREFIX}${charId}_${slotName}`;
}

// ═══ v5 四柱数据读写 ═══

async function readAllPillarData(chatId) {
    const lf = getLocalForage();
    const [npc, items, timeline, memories, threads, map, clueBoard] = await Promise.all([
        ...PILLAR_KEYS.map(k => lf.getItem(k + chatId)),
        lf.getItem(THREAD_KEY + chatId),
        lf.getItem(MAP_KEY + chatId),
        lf.getItem(CLUE_BOARD_KEY + chatId),
    ]);
    return {
        npc: Array.isArray(npc) ? npc : [],
        items: Array.isArray(items) ? items : [],
        timeline: Array.isArray(timeline) ? timeline : [],
        memories: Array.isArray(memories) ? memories : [],
        threads: Array.isArray(threads) ? threads : [],
        map: normalizeMapData(map),
        clueBoard: normalizeClueBoardData(clueBoard),
    };
}

async function writeAllPillarData(chatId, data) {
    const lf = getLocalForage();
    const normalized = normalizeSlotData(data);
    await Promise.all([
        lf.setItem(PILLAR_KEYS[0] + chatId, normalized.npc),
        lf.setItem(PILLAR_KEYS[1] + chatId, normalized.items),
        lf.setItem(PILLAR_KEYS[2] + chatId, normalized.timeline),
        lf.setItem(PILLAR_KEYS[3] + chatId, normalized.memories),
        lf.setItem(THREAD_KEY + chatId, normalized.threads),
        lf.setItem(MAP_KEY + chatId, normalized.map),
        lf.setItem(CLUE_BOARD_KEY + chatId, normalized.clueBoard),
    ]);
}

function normalizeMapData(map) {
    return (map && typeof map === 'object' && map.locations && typeof map.locations === 'object')
        ? { ...map, locations: map.locations }
        : { locations: {} };
}

function normalizeClueBoardData(board) {
    return {
        nodes: Array.isArray(board?.nodes) ? board.nodes : [],
        connections: Array.isArray(board?.connections) ? board.connections : [],
        updatedAt: board?.updatedAt || 0,
    };
}

function normalizeSlotData(raw) {
    if (Array.isArray(raw)) {
        return { npc: [], items: [], timeline: [], memories: raw, threads: [], map: { locations: {} }, clueBoard: { nodes: [], connections: [], updatedAt: 0 } };
    }
    if (!raw || typeof raw !== 'object') {
        return { npc: [], items: [], timeline: [], memories: [], threads: [], map: { locations: {} }, clueBoard: { nodes: [], connections: [], updatedAt: 0 } };
    }
    return {
        npc: Array.isArray(raw.npc) ? raw.npc : [],
        items: Array.isArray(raw.items) ? raw.items : [],
        timeline: Array.isArray(raw.timeline) ? raw.timeline : [],
        memories: Array.isArray(raw.memories) ? raw.memories : [],
        threads: Array.isArray(raw.threads) ? raw.threads : [],
        map: normalizeMapData(raw.map || raw.mapData),
        clueBoard: normalizeClueBoardData(raw.clueBoard || raw.clues),
    };
}

function totalCount(data) {
    if (!data) return 0;
    // Support old format (flat array) and new format (pillar object)
    if (Array.isArray(data)) return data.length;
    const normalized = normalizeSlotData(data);
    return normalized.npc.length
        + normalized.items.length
        + normalized.timeline.length
        + normalized.memories.length
        + normalized.threads.length
        + Object.keys(normalized.map.locations || {}).length
        + normalized.clueBoard.nodes.length;
}

// ═══ 角色ID获取 ═══

export function getCharacterId() {
    try {
        const ctx = SillyTavern.getContext();
        if (ctx.characterId !== undefined && ctx.characterId !== null) {
            return String(ctx.characterId);
        }
        if (ctx.characters && ctx.characterId !== undefined) {
            return String(ctx.characterId);
        }
    } catch { /* ignore */ }
    return null;
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
            const slot = { name, count: totalCount(data), key: slotKey(charId, name), remote: false, localCount: totalCount(data) };
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
                    const slot = { name: slotName, count, key, remote: false, localCount: count };
                    slots.push(slot);
                    localByName.set(slotName, slot);
                }
            });
        } catch { /* ignore */ }
    }

    if (!slots.find(s => s.name === 'default')) {
        const defaultSlot = { name: 'default', count: 0, key: slotKey(charId, 'default'), remote: false, localCount: 0, virtualLocal: true };
        slots.unshift(defaultSlot);
        localByName.set('default', defaultSlot);
    }

    // v8.9.15 keep chatMetadata slot sync index-only. Full slot payloads stay in localforage.
    const remoteIndex = getRemoteSlotIndex(charId);
    for (const [name, meta] of Object.entries(remoteIndex.slots || {})) {
        const total = (meta.npc || 0) + (meta.items || 0) + (meta.timeline || 0) + (meta.mem || 0) + (meta.threads || 0) + (meta.map || 0) + (meta.clues || 0);
        const local = localByName.get(name);
        if (local) {
            local.remoteAvailable = true;
            local.remoteCount = total;
            local.remoteTs = meta.ts || 0;
            continue;
        }
        slots.push({
            name,
            count: total,
            key: slotKey(charId, name),
            remote: false,
            remoteIndexOnly: true,
            remoteAvailable: true,
            remoteCount: total,
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
            .filter(s => !s.remoteIndexOnly)
            .map(s => s.name);
        await getLocalForage().setItem('bb_memory_slot_list_' + charId, names);
    } catch { /* ignore */ }
}

// ═══ 槽操作 ═══

/**
 * 将当前聊天记忆保存到指定槽（覆盖式）
 * v8.5.1 同步槽数据到 chatMetadata 实现跨设备共享
 */
export async function saveToSlot(charId, chatId, slotName) {
    if (!charId || !chatId) throw new Error('无法获取角色或聊天ID');

    const data = await readAllPillarData(chatId);
    const lf = getLocalForage();
    await lf.setItem(slotKey(charId, slotName), data);

    const slots = await listSlots(charId);
    await updateSlotIndex(charId, slots);

    const dataSynced = await pushSlotDataToChatMetadata(slotName, data);
    const indexSynced = await syncSlotIndexToChatMetadata(charId);

    return { count: totalCount(data), data, cloudSynced: indexSynced, cloudDataSynced: dataSynced };
}

/**
 * 从指定槽加载数据到当前聊天（覆盖当前聊天数据）
 * v8.2.0 仅在当前聊天已有数据时重新生成 ID 以避免冲突
 */
export async function loadFromSlot(charId, chatId, slotName) {
    if (!charId || !chatId) throw new Error('无法获取角色或聊天ID');

    const lf = getLocalForage();
    let raw = await lf.getItem(slotKey(charId, slotName));

    // v9.0.2: 本地数据为空时尝试从 chatMetadata 拉取（跨设备同步）
    if (!raw || totalCount(raw) === 0) {
        const pulled = await pullSlotFromChatMetadata(charId, slotName);
        if (pulled && pulled > 0) {
            raw = await lf.getItem(slotKey(charId, slotName));
        }
    }

    // 兼容旧格式（扁平记忆数组）和新格式（五柱对象，v8.9.0 含地图/线索板）
    let data = normalizeSlotData(raw);

    // 检查当前聊天是否已有数据，仅在有冲突风险时重新生成 ID
    const currentData = await readAllPillarData(chatId);
    const hasExistingData = currentData.npc.length > 0 || currentData.items.length > 0 ||
        currentData.timeline.length > 0 || currentData.memories.length > 0 ||
        currentData.threads.length > 0 || Object.keys(currentData.map.locations || {}).length > 0 ||
        currentData.clueBoard.nodes.length > 0;

    if (hasExistingData) {
        const oldIds = {
            npc: data.npc.map(e => e.id),
            item: data.items.map(e => e.id),
            timeline: data.timeline.map(e => e.id),
            mem: data.memories.map(e => e.id),
            thread: data.threads.map(e => e.id),
        };

        const now = Date.now();
        const newId = (i) => `bb_${now + i}_${Math.random().toString(36).slice(2, 7)}`;
        data.npc = data.npc.map((e, i) => ({ ...e, id: newId(i) }));
        data.items = data.items.map((e, i) => ({ ...e, id: newId(i + data.npc.length) }));
        data.timeline = data.timeline.map((e, i) => ({ ...e, id: newId(i + data.npc.length + data.items.length) }));
        data.memories = data.memories.map((e, i) => ({ ...e, id: newId(i + data.npc.length + data.items.length + data.timeline.length) }));
        data.threads = data.threads.map((e, i) => ({ ...e, id: newId(i + data.npc.length + data.items.length + data.timeline.length + data.memories.length) }));

        // v8.9.0 重映射线程与线索板引用，修复 ID 重生后引用断裂
        const idMaps = {
            npc: new Map(oldIds.npc.map((id, i) => [id, data.npc[i]?.id])),
            item: new Map(oldIds.item.map((id, i) => [id, data.items[i]?.id])),
            timeline: new Map(oldIds.timeline.map((id, i) => [id, data.timeline[i]?.id])),
            mem: new Map(oldIds.mem.map((id, i) => [id, data.memories[i]?.id])),
            thread: new Map(oldIds.thread.map((id, i) => [id, data.threads[i]?.id])),
        };
        idMaps.items = idMaps.item;
        idMaps.memory = idMaps.mem;
        idMaps.memories = idMaps.mem;
        const timelineIdMap = idMaps.timeline;
        if (timelineIdMap.size > 0) {
            for (const thread of data.threads) {
                if (thread.parentThreadId && idMaps.thread.has(thread.parentThreadId)) {
                    thread.parentThreadId = idMaps.thread.get(thread.parentThreadId);
                }
                if (Array.isArray(thread.entries)) {
                    for (const entry of thread.entries) {
                        if (entry.refId && timelineIdMap.has(entry.refId)) {
                            entry.refId = timelineIdMap.get(entry.refId);
                        }
                    }
                }
            }
        }
        for (const node of data.clueBoard.nodes) {
            const map = idMaps[node.refType];
            if (node.refId && map?.has(node.refId)) {
                node.refId = map.get(node.refId);
            }
        }
    }

    await writeAllPillarData(chatId, data);

    return { count: totalCount(data), data };
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
    if (existing !== null) {
        throw new Error(`存档 "${name}" 已存在`);
    }
    const remoteIndex = getRemoteSlotIndex(charId);
    if (remoteIndex.slots?.[name]) {
        throw new Error(`云端已存在同名存档 "${name}"，请先拉取云端存档`);
    }

    await lf.setItem(slotKey(charId, name), []);
    const slots = await listSlots(charId);
    // v8.2.5 修复：listSlots 优先走索引读取，新槽尚未入索引，需手动补入
    if (!slots.find(s => s.name === name)) {
        slots.push({ name, count: 0, key: slotKey(charId, name) });
    }
    await updateSlotIndex(charId, slots);

    await removeSlotDataFromChatMetadata(name);
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
    await removeSlotDataFromChatMetadata(slotName);
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

    // v9.0.2: 本地数据为空时尝试从 chatMetadata 拉取（跨设备同步）
    if (!raw || totalCount(raw) === 0) {
        const pulled = await pullSlotFromChatMetadata(charId, slotName);
        if (pulled && pulled > 0) {
            raw = await lf.getItem(slotKey(charId, slotName));
        }
    }

    const data = normalizeSlotData(raw);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `BB-Memory-${slotName}-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    return totalCount(data);
}

// ═══════════════════════════════════════════════════════════
//  v8.5.1 chatMetadata 槽同步（跨设备共享）
// ═══════════════════════════════════════════════════════════

const SLOT_INDEX_KEY = 'bb_memory_slot_index';
const SLOT_DATA_PREFIX = 'bb_memory_slot_data_';

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
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        return { npc: 0, items: 0, timeline: 0, mem: 0, threads: 0, map: 0, clues: 0 };
    }
    const normalized = normalizeSlotData(data);
    return {
        npc: normalized.npc.length,
        items: normalized.items.length,
        timeline: normalized.timeline.length,
        mem: normalized.memories.length,
        threads: normalized.threads.length,
        map: Object.keys(normalized.map.locations || {}).length,
        clues: normalized.clueBoard.nodes.length,
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
        if (s.remoteIndexOnly) continue;
        const counts = await getSlotPillarCounts(charId, s.name);
        index.slots[s.name] = { ts: Date.now(), ...counts };
    }
    ctx.chatMetadata[SLOT_INDEX_KEY] = JSON.stringify(index);
    return saveChatMeta(ctx);
}

/**
 * Remove legacy full slot payloads from chatMetadata. Slot sync is index-only now.
 */
async function removeSlotDataFromChatMetadata(slotName = null, context = null) {
    const ctx = context || getSTContext();
    if (!ctx) return false;
    if (!ctx.chatMetadata) ctx.chatMetadata = {};

    let changed = false;
    for (const key of Object.keys(ctx.chatMetadata)) {
        if (!key.startsWith(SLOT_DATA_PREFIX)) continue;
        if (slotName && key !== SLOT_DATA_PREFIX + slotName) continue;
        delete ctx.chatMetadata[key];
        changed = true;
    }
    return changed ? saveChatMeta(ctx) : true;
}

/**
 * 将槽完整数据推送到 chatMetadata（跨设备共享）
 * v9.0.2 恢复数据同步，去除 embedding 向量以控制体积
 */
async function pushSlotDataToChatMetadata(slotName, data, context = null) {
    const ctx = context || getSTContext();
    if (!ctx) return false;
    if (!ctx.chatMetadata) ctx.chatMetadata = {};

    const stripped = stripSlotEmbeddings(data);
    ctx.chatMetadata[SLOT_DATA_PREFIX + slotName] = JSON.stringify(stripped);
    return saveChatMeta(ctx);
}

function stripSlotEmbeddings(data) {
    if (!data || typeof data !== 'object') return data;
    const strip = (entry) => {
        if (!entry || typeof entry !== 'object') return entry;
        const { embedding, ...rest } = entry;
        return rest;
    };
    return {
        npc: Array.isArray(data.npc) ? data.npc.map(strip) : [],
        items: Array.isArray(data.items) ? data.items.map(strip) : [],
        timeline: Array.isArray(data.timeline) ? data.timeline.map(strip) : [],
        memories: Array.isArray(data.memories) ? data.memories.map(strip) : [],
        threads: Array.isArray(data.threads) ? data.threads.map(strip) : [],
        map: data.map && typeof data.map === 'object' ? data.map : { locations: {} },
        clueBoard: data.clueBoard || { nodes: [], connections: [], updatedAt: 0 },
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

    const raw = ctx.chatMetadata[SLOT_DATA_PREFIX + slotName];
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

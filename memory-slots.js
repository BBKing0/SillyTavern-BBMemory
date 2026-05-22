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

function slotKey(charId, slotName) {
    return `${SLOT_PREFIX}${charId}_${slotName}`;
}

// ═══ v5 四柱数据读写 ═══

async function readAllPillarData(chatId) {
    const lf = getLocalForage();
    const [npc, items, timeline, memories, threads] = await Promise.all([
        ...PILLAR_KEYS.map(k => lf.getItem(k + chatId)),
        lf.getItem(THREAD_KEY + chatId),
    ]);
    return {
        npc: Array.isArray(npc) ? npc : [],
        items: Array.isArray(items) ? items : [],
        timeline: Array.isArray(timeline) ? timeline : [],
        memories: Array.isArray(memories) ? memories : [],
        threads: Array.isArray(threads) ? threads : [],
    };
}

async function writeAllPillarData(chatId, data) {
    const lf = getLocalForage();
    await Promise.all([
        lf.setItem(PILLAR_KEYS[0] + chatId, data.npc || []),
        lf.setItem(PILLAR_KEYS[1] + chatId, data.items || []),
        lf.setItem(PILLAR_KEYS[2] + chatId, data.timeline || []),
        lf.setItem(PILLAR_KEYS[3] + chatId, data.memories || []),
        lf.setItem(THREAD_KEY + chatId, data.threads || []),
    ]);
}

function totalCount(data) {
    if (!data) return 0;
    // Support old format (flat array) and new format (pillar object)
    if (Array.isArray(data)) return data.length;
    return (data.npc?.length || 0) + (data.items?.length || 0) + (data.timeline?.length || 0) + (data.memories?.length || 0) + (data.threads?.length || 0);
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
    const localNames = new Set();

    // 优先从索引读取（O(1) 查询），避免 lf.iterate 全库扫描
    const known = await lf.getItem('bb_memory_slot_list_' + charId);
    if (Array.isArray(known) && known.length > 0) {
        for (const name of known) {
            const data = await lf.getItem(slotKey(charId, name));
            slots.push({ name, count: totalCount(data), key: slotKey(charId, name), remote: false });
            localNames.add(name);
        }
    } else {
        // 索引缺失时回退到全库扫描
        try {
            await lf.iterate((value, key) => {
                const prefix = `${SLOT_PREFIX}${charId}_`;
                if (key.startsWith(prefix)) {
                    const slotName = key.slice(prefix.length);
                    const count = totalCount(value);
                    slots.push({ name: slotName, count, key, remote: false });
                    localNames.add(slotName);
                }
            });
        } catch { /* ignore */ }
    }

    if (!slots.find(s => s.name === 'default')) {
        slots.unshift({ name: 'default', count: 0, key: slotKey(charId, 'default'), remote: false });
        localNames.add('default');
    }

    // v8.5.1 合并 chatMetadata 远程槽
    const remoteIndex = getRemoteSlotIndex(charId);
    for (const [name, meta] of Object.entries(remoteIndex.slots || {})) {
        if (localNames.has(name)) continue; // 本地已有，跳过
        const total = (meta.npc || 0) + (meta.items || 0) + (meta.timeline || 0) + (meta.mem || 0) + (meta.threads || 0);
        slots.push({
            name,
            count: total,
            key: slotKey(charId, name),
            remote: true,
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
        const names = slots.map(s => s.name);
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

    // v8.5.1 同步到 chatMetadata（后台执行，不阻塞返回）
    syncSlotIndexToChatMetadata(charId).catch(() => {});
    syncSlotDataToChatMetadata(charId, slotName).catch(() => {});

    return { count: totalCount(data), data };
}

/**
 * 从指定槽加载数据到当前聊天（覆盖当前聊天数据）
 * v8.2.0 仅在当前聊天已有数据时重新生成 ID 以避免冲突
 */
export async function loadFromSlot(charId, chatId, slotName) {
    if (!charId || !chatId) throw new Error('无法获取角色或聊天ID');

    const lf = getLocalForage();
    let raw = await lf.getItem(slotKey(charId, slotName));

    // 兼容旧格式（扁平记忆数组）和新格式（五柱对象，v7.5.0 含 threads）
    let data;
    if (Array.isArray(raw)) {
        data = { npc: [], items: [], timeline: [], memories: raw, threads: [] };
    } else if (raw && typeof raw === 'object') {
        data = {
            npc: Array.isArray(raw.npc) ? raw.npc : [],
            items: Array.isArray(raw.items) ? raw.items : [],
            timeline: Array.isArray(raw.timeline) ? raw.timeline : [],
            memories: Array.isArray(raw.memories) ? raw.memories : [],
            threads: Array.isArray(raw.threads) ? raw.threads : [],
        };
    } else {
        data = { npc: [], items: [], timeline: [], memories: [], threads: [] };
    }

    // 检查当前聊天是否已有数据，仅在有冲突风险时重新生成 ID
    const currentData = await readAllPillarData(chatId);
    const hasExistingData = currentData.npc.length > 0 || currentData.items.length > 0 ||
        currentData.timeline.length > 0 || currentData.memories.length > 0;

    if (hasExistingData) {
        // v8.5.1 保存旧 timeline ID 用于 refId 重映射，防止引用断裂
        const oldTimelineIds = data.timeline.map(e => e.id);

        const now = Date.now();
        const newId = (i) => `bb_${now + i}_${Math.random().toString(36).slice(2, 7)}`;
        data.npc = data.npc.map((e, i) => ({ ...e, id: newId(i) }));
        data.items = data.items.map((e, i) => ({ ...e, id: newId(i + data.npc.length) }));
        data.timeline = data.timeline.map((e, i) => ({ ...e, id: newId(i + data.npc.length + data.items.length) }));
        data.memories = data.memories.map((e, i) => ({ ...e, id: newId(i + data.npc.length + data.items.length + data.timeline.length) }));
        data.threads = data.threads.map((e, i) => ({ ...e, id: newId(i + data.npc.length + data.items.length + data.timeline.length + data.memories.length) }));

        // v8.5.1 重映射 thread entries 中的 refId，修复 ID 重生后引用断裂
        const timelineIdMap = new Map();
        for (let i = 0; i < oldTimelineIds.length; i++) {
            timelineIdMap.set(oldTimelineIds[i], data.timeline[i].id);
        }
        if (timelineIdMap.size > 0) {
            for (const thread of data.threads) {
                if (Array.isArray(thread.entries)) {
                    for (const entry of thread.entries) {
                        if (entry.refId && timelineIdMap.has(entry.refId)) {
                            entry.refId = timelineIdMap.get(entry.refId);
                        }
                    }
                }
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

    await lf.setItem(slotKey(charId, name), []);
    const slots = await listSlots(charId);
    // v8.2.5 修复：listSlots 优先走索引读取，新槽尚未入索引，需手动补入
    if (!slots.find(s => s.name === name)) {
        slots.push({ name, count: 0, key: slotKey(charId, name) });
    }
    await updateSlotIndex(charId, slots);

    // v8.5.1 同步到 chatMetadata
    syncSlotIndexToChatMetadata(charId).catch(() => {});

    return name;
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
    syncSlotIndexToChatMetadata(charId).catch(() => {});
    (async () => {
        const ctx = getSTContext();
        if (ctx?.chatMetadata) {
            delete ctx.chatMetadata[SLOT_DATA_PREFIX + slotName];
            saveChatMeta(ctx);
        }
    })().catch(() => {});
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
    const raw = await lf.getItem(slotKey(charId, slotName));

    let data;
    if (Array.isArray(raw)) {
        data = { npc: [], items: [], timeline: [], memories: raw, threads: [] };
    } else if (raw && typeof raw === 'object') {
        data = {
            npc: Array.isArray(raw.npc) ? raw.npc : [],
            items: Array.isArray(raw.items) ? raw.items : [],
            timeline: Array.isArray(raw.timeline) ? raw.timeline : [],
            memories: Array.isArray(raw.memories) ? raw.memories : [],
            threads: Array.isArray(raw.threads) ? raw.threads : [],
        };
    } else {
        data = { npc: [], items: [], timeline: [], memories: [], threads: [] };
    }

    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
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

function saveChatMeta(ctx) {
    if (!ctx) return;
    if (typeof ctx.saveChatDebounced === 'function') {
        ctx.saveChatDebounced();
    } else if (typeof ctx.saveChat === 'function') {
        ctx.saveChat();
    }
}

/**
 * 获取单个槽的各柱计数
 */
async function getSlotPillarCounts(charId, slotName) {
    const lf = getLocalForage();
    const data = await lf.getItem(slotKey(charId, slotName));
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        return { npc: 0, items: 0, timeline: 0, mem: 0, threads: 0 };
    }
    return {
        npc: data.npc?.length || 0,
        items: data.items?.length || 0,
        timeline: data.timeline?.length || 0,
        mem: data.memories?.length || 0,
        threads: data.threads?.length || 0,
    };
}

/**
 * 将槽索引元数据同步到 chatMetadata（轻量，仅名称+计数+时间戳）
 */
async function syncSlotIndexToChatMetadata(charId) {
    const ctx = getSTContext();
    if (!ctx) return;
    if (!ctx.chatMetadata) ctx.chatMetadata = {};

    const slots = await listSlots(charId);
    const index = { slots: {} };
    for (const s of slots) {
        if (s.remote) continue;
        const counts = await getSlotPillarCounts(charId, s.name);
        index.slots[s.name] = { ts: Date.now(), ...counts };
    }
    ctx.chatMetadata[SLOT_INDEX_KEY] = JSON.stringify(index);
    saveChatMeta(ctx);
}

/**
 * 将单个槽的完整数据同步到 chatMetadata
 */
async function syncSlotDataToChatMetadata(charId, slotName) {
    const ctx = getSTContext();
    if (!ctx) return;
    if (!ctx.chatMetadata) ctx.chatMetadata = {};

    const lf = getLocalForage();
    const data = await lf.getItem(slotKey(charId, slotName));
    if (data) {
        ctx.chatMetadata[SLOT_DATA_PREFIX + slotName] = JSON.stringify(data);
    } else {
        delete ctx.chatMetadata[SLOT_DATA_PREFIX + slotName];
    }
    saveChatMeta(ctx);
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

    let normalized;
    if (Array.isArray(data)) {
        normalized = { npc: [], items: [], timeline: [], memories: data, threads: [] };
    } else if (data && typeof data === 'object') {
        normalized = {
            npc: Array.isArray(data.npc) ? data.npc : [],
            items: Array.isArray(data.items) ? data.items : [],
            timeline: Array.isArray(data.timeline) ? data.timeline : [],
            memories: Array.isArray(data.memories) ? data.memories : [],
            threads: Array.isArray(data.threads) ? data.threads : [],
        };
    } else {
        return null;
    }

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

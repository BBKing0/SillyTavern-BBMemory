/**
 * memory-slots.js —— BB-Memory 存档槽管理
 *
 * v2.9 新增：同一角色共享的存档槽系统
 * - 槽数据按角色ID组织，不同聊天但同角色可共用
 * - 默认槽为 "default"，始终存在
 * - 操作：保存 / 加载 / 新建 / 删除 / 列表
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

// ═══ v7.8.0 跨设备角色指纹 ═══

function simpleHash(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) {
        h = ((h << 5) - h) + str.charCodeAt(i);
        h |= 0;
    }
    return Math.abs(h).toString(36);
}

/**
 * 获取角色指纹（name + description_hash），跨设备稳定标识
 */
function getCharFingerprint() {
    try {
        const ctx = SillyTavern.getContext();
        const char = ctx.characters && ctx.characters[ctx.characterId];
        if (char && char.name) {
            return char.name + '_' + simpleHash((char.description || '').slice(0, 500));
        }
    } catch { /* ignore */ }
    return null;
}

// ═══ v7.8.0 chatMetadata 远端槽同步 ═══

function getRemoteSlotsData() {
    try {
        const ctx = SillyTavern.getContext();
        return ctx.chatMetadata?.bb_memory_slots || {};
    } catch { return {}; }
}

async function saveRemoteSlotsData(slots) {
    try {
        const ctx = SillyTavern.getContext();
        ctx.chatMetadata = ctx.chatMetadata || {};
        ctx.chatMetadata.bb_memory_slots = slots;
        if (typeof ctx.saveChat === 'function') await ctx.saveChat();
    } catch { /* ignore */ }
}

/**
 * 从 chatMetadata 读取远端槽列表，合并到本地槽
 */
async function mergeRemoteSlots(charId, localSlots) {
    const fp = getCharFingerprint();
    if (!fp) return localSlots;
    const remote = getRemoteSlotsData();
    const rSlots = remote[fp] || {};
    const result = [...localSlots];
    for (const [name, data] of Object.entries(rSlots)) {
        if (!result.find(s => s.name === name)) {
            result.push({ name, count: totalCount(data), key: null, _remote: true });
        }
    }
    return result;
}

/**
 * v8.0.0 从 chatMetadata 主动同步远端槽数据到本地 localforage
 * 解决跨设备登录后槽数据不互通的问题
 */
export async function syncSlotsFromRemote(charId) {
    if (!charId) return 0;
    const fp = getCharFingerprint();
    if (!fp) return 0;
    const remote = getRemoteSlotsData();
    const rSlots = remote[fp] || {};
    let synced = 0;
    const lf = getLocalForage();
    for (const [name, data] of Object.entries(rSlots)) {
        if (!data || typeof data !== 'object') continue;
        const key = slotKey(charId, name);
        try {
            const existing = await lf.getItem(key);
            if (existing === null || existing === undefined) {
                await lf.setItem(key, data);
                synced++;
            }
        } catch { /* ignore */ }
    }
    return synced;
}

// ═══ 槽列表 ═══

/**
 * 列出该角色的所有存档槽
 */
export async function listSlots(charId) {
    if (!charId) return [];
    const lf = getLocalForage();
    const prefix = `${SLOT_PREFIX}${charId}_`;
    const slots = [];

    try {
        await lf.iterate((value, key) => {
            if (key.startsWith(prefix)) {
                const slotName = key.slice(prefix.length);
                const count = totalCount(value);
                slots.push({ name: slotName, count, key });
            }
        });
    } catch {
        const known = await lf.getItem('bb_memory_slot_list_' + charId);
        if (Array.isArray(known)) {
            for (const name of known) {
                const data = await lf.getItem(slotKey(charId, name));
                slots.push({ name, count: totalCount(data), key: slotKey(charId, name) });
            }
        }
    }

    if (!slots.find(s => s.name === 'default')) {
        slots.unshift({ name: 'default', count: 0, key: slotKey(charId, 'default') });
    }

    // v7.8.0 合并 chatMetadata 远端槽
    return mergeRemoteSlots(charId, slots);
}

/**
 * 更新槽列表索引（回退用途）
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
 */
export async function saveToSlot(charId, chatId, slotName) {
    if (!charId || !chatId) throw new Error('无法获取角色或聊天ID');

    const data = await readAllPillarData(chatId);
    const lf = getLocalForage();
    await lf.setItem(slotKey(charId, slotName), data);

    // v7.8.0 同步到 chatMetadata（跨设备）
    const fp = getCharFingerprint();
    if (fp) {
        const remote = getRemoteSlotsData();
        if (!remote[fp]) remote[fp] = {};
        remote[fp][slotName] = data;
        await saveRemoteSlotsData(remote);
    }

    const slots = await listSlots(charId);
    await updateSlotIndex(charId, slots);

    return { count: totalCount(data), data };
}

/**
 * 从指定槽加载数据到当前聊天（覆盖当前聊天数据）
 */
export async function loadFromSlot(charId, chatId, slotName) {
    if (!charId || !chatId) throw new Error('无法获取角色或聊天ID');

    const lf = getLocalForage();
    let raw = await lf.getItem(slotKey(charId, slotName));

    // v7.8.0 本地无数据时从 chatMetadata 远端加载
    if (raw === null || raw === undefined) {
        const fp = getCharFingerprint();
        if (fp) {
            const remote = getRemoteSlotsData();
            const rSlot = remote[fp]?.[slotName];
            if (rSlot && typeof rSlot === 'object') {
                raw = rSlot;
                // 同步到本地
                await lf.setItem(slotKey(charId, slotName), raw);
            }
        }
    }

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

    // 重新生成ID避免冲突
    const now = Date.now();
    const newId = (i) => `bb_${now + i}_${Math.random().toString(36).slice(2, 7)}`;
    data.npc = data.npc.map((e, i) => ({ ...e, id: newId(i) }));
    data.items = data.items.map((e, i) => ({ ...e, id: newId(i + data.npc.length) }));
    data.timeline = data.timeline.map((e, i) => ({ ...e, id: newId(i + data.npc.length + data.items.length) }));
    data.memories = data.memories.map((e, i) => ({ ...e, id: newId(i + data.npc.length + data.items.length + data.timeline.length) }));
    data.threads = data.threads.map((e, i) => ({ ...e, id: newId(i + data.npc.length + data.items.length + data.timeline.length + data.memories.length) }));

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
    await updateSlotIndex(charId, slots);

    return name;
}

/**
 * 删除指定存档槽
 */
export async function deleteSlot(charId, slotName) {
    if (!charId) throw new Error('无法获取角色ID');
    if (slotName === 'default') throw new Error('不能删除默认存档');

    const lf = getLocalForage();
    await lf.removeItem(slotKey(charId, slotName));

    // v7.8.0 同步删除远端
    const fp = getCharFingerprint();
    if (fp) {
        const remote = getRemoteSlotsData();
        if (remote[fp]) {
            delete remote[fp][slotName];
            if (Object.keys(remote[fp]).length === 0) delete remote[fp];
            await saveRemoteSlotsData(remote);
        }
    }

    const slots = await listSlots(charId);
    await updateSlotIndex(charId, slots.filter(s => s.name !== slotName));
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

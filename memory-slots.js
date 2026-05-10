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

const STORAGE_PREFIX = 'bb_memory_chat_';
const SLOT_PREFIX = 'bb_memory_slot_';

function chatStorageKey(chatId) {
    return String(STORAGE_PREFIX) + (chatId);
}

function slotKey(charId, slotName) {
    return String(SLOT_PREFIX) + (charId) + "_" + (slotName);
}

// ═══ 直接读写 localforage ═══

async function readChatMemories(chatId) {
    const lf = getLocalForage();
    const data = await lf.getItem(chatStorageKey(chatId));
    return Array.isArray(data) ? data : [];
}

async function writeChatMemories(chatId, memories) {
    const lf = getLocalForage();
    await lf.setItem(chatStorageKey(chatId), memories);
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
 * 列出该角色的所有存档槽
 */
export async function listSlots(charId) {
    if (!charId) return [];
    const lf = getLocalForage();
    const prefix = String(SLOT_PREFIX) + (charId) + "_";
    const slots = [];

    try {
        await lf.iterate((value, key) => {
            if (key.startsWith(prefix)) {
                const slotName = key.slice(prefix.length);
                const count = Array.isArray(value) ? value.length : 0;
                slots.push({ name: slotName, count, key });
            }
        });
    } catch {
        // 回退：使用槽列表索引
        const known = await lf.getItem('bb_memory_slot_list_' + charId);
        if (Array.isArray(known)) {
            for (const name of known) {
                const data = await lf.getItem(slotKey(charId, name));
                slots.push({ name, count: Array.isArray(data) ? data.length : 0, key: slotKey(charId, name) });
            }
        }
    }

    // 确保 "default" 始终在列表中
    if (!slots.find(s => s.name === 'default')) {
        slots.unshift({ name: 'default', count: 0, key: slotKey(charId, 'default') });
    }

    return slots;
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

    const memories = await readChatMemories(chatId);
    const lf = getLocalForage();
    await lf.setItem(slotKey(charId, slotName), memories);

    const slots = await listSlots(charId);
    await updateSlotIndex(charId, slots);

    return memories.length;
}

/**
 * 从指定槽加载记忆到当前聊天（覆盖当前聊天记忆）
 */
export async function loadFromSlot(charId, chatId, slotName) {
    if (!charId || !chatId) throw new Error('无法获取角色或聊天ID');

    const lf = getLocalForage();
    const data = await lf.getItem(slotKey(charId, slotName));
    const memories = Array.isArray(data) ? data : [];

    // 重新生成ID避免冲突后写入
    const migrated = memories.map((m, i) => ({
        ...m,
        id: "bb_" + (Date.now() + i) + "_" + (Math.random().toString(36).slice(2, 7)),
    }));
    await writeChatMemories(chatId, migrated);

    return migrated.length;
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
        throw new Error("存档 \"" + (name) + "\" 已存在");
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
    return Array.isArray(data) ? data.length : 0;
}

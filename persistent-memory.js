/**
 * persistent-memory.js —— BB-Memory 常驻记忆系统
 *
 * v2.9.5 新增：独立于条目式记忆的常驻档案系统
 * - 三类档案：NPC（人物）、Item（物品）、Timeline（时间线）
 * - 始终注入到 AI 提示词中，不受检索过滤影响
 * - 存储键：bb_memory_persistent_<chatId>
 */

// ═══ localforage 访问 ═══

function getLocalForage() {
    return SillyTavern.libs.localforage;
}

// ═══ 存储键 ═══

const PERSISTENT_PREFIX = 'bb_memory_persistent_';

function persistentKey(chatId) {
    return `${PERSISTENT_PREFIX}${chatId}`;
}

// ═══ CRUD ═══

/**
 * 获取所有常驻记忆
 * @param {string} chatId
 * @returns {Promise<Array>}
 */
export async function getPersistentMemories(chatId) {
    if (!chatId) return [];
    try {
        const lf = getLocalForage();
        const data = await lf.getItem(persistentKey(chatId));
        return Array.isArray(data) ? data : [];
    } catch (e) {
        console.error('[BB-Memory] 读取常驻记忆失败:', e);
        return [];
    }
}

/**
 * 添加常驻记忆
 * @param {string} chatId
 * @param {'npc'|'item'|'timeline'} category
 * @param {string} name
 * @param {string} content
 * @param {number} [order]
 * @returns {Promise<object>} 新条目
 */
export async function addPersistentMemory(chatId, category, name, content, order) {
    const all = await getPersistentMemories(chatId);
    const now = Date.now();
    const entry = {
        id: `p_${now}_${Math.random().toString(36).slice(2, 7)}`,
        category,
        name: name.trim(),
        content: content.trim(),
        order: order ?? all.length,
        createdAt: now,
        updatedAt: now,
    };
    all.push(entry);
    await savePersistentMemories(chatId, all);
    return entry;
}

/**
 * 更新常驻记忆
 * @param {string} chatId
 * @param {string} id
 * @param {object} updates - 要更新的字段
 */
export async function updatePersistentMemory(chatId, id, updates) {
    const all = await getPersistentMemories(chatId);
    const idx = all.findIndex(e => e.id === id);
    if (idx === -1) return null;
    all[idx] = { ...all[idx], ...updates, updatedAt: Date.now() };
    await savePersistentMemories(chatId, all);
    return all[idx];
}

/**
 * 删除常驻记忆
 * @param {string} chatId
 * @param {string} id
 */
export async function removePersistentMemory(chatId, id) {
    const all = await getPersistentMemories(chatId);
    const filtered = all.filter(e => e.id !== id);
    if (filtered.length === all.length) return false;
    await savePersistentMemories(chatId, filtered);
    return true;
}

/**
 * 按类别筛选常驻记忆
 * @param {string} chatId
 * @param {'npc'|'item'|'timeline'} category
 * @returns {Promise<Array>}
 */
export async function getPersistentMemoriesByCategory(chatId, category) {
    const all = await getPersistentMemories(chatId);
    return all.filter(e => e.category === category);
}

/**
 * 保存常驻记忆列表
 */
async function savePersistentMemories(chatId, data) {
    try {
        const lf = getLocalForage();
        await lf.setItem(persistentKey(chatId), data);
    } catch (e) {
        console.error('[BB-Memory] 保存常驻记忆失败:', e);
    }
}

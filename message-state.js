/**
 * message-state.js —— BB-Memory 的"消息管理员"（消息稳定化机制）
 *
 * 职责：
 *   1. 自动隐藏超出短期窗口的消息（使用 SillyTavern 原生 is_hidden）
 *   2. 标记每条消息的隐藏来源（插件/用户）和提取状态
 *   3. 计算 exchange（用户消息 + AI 回复）的唯一指纹，防止重复提取
 *   4. 提供可提取 exchange 的查询接口
 */

import { getSettings } from './memory-store.js';

const EXCHANGE_STORE_PREFIX = 'bb_memory_exchanges_';
const LOG_TAG = '[BB-Memory]';

// ═══════════════════════════════════════════════════════════
//  SillyTavern API 辅助
// ═══════════════════════════════════════════════════════════

function getContext() {
    return SillyTavern.getContext();
}

function getChatId() {
    try {
        const ctx = getContext();
        if (ctx.chatId) return String(ctx.chatId);
        if (ctx.characters && ctx.characterId !== undefined) {
            const char = ctx.characters[ctx.characterId];
            if (char?.chat) return String(char.chat);
        }
    } catch { /* ignore */ }
    return null;
}

function getLocalForage() {
    return SillyTavern.libs.localforage;
}

function saveChat() {
    try {
        const ctx = getContext();
        if (typeof ctx.saveChatConditional === 'function') {
            ctx.saveChatConditional();
        } else if (typeof ctx.saveChatDebounced === 'function') {
            ctx.saveChatDebounced();
        } else if (typeof ctx.saveChat === 'function') {
            ctx.saveChat();
        }
    } catch (e) {
        console.warn(`${LOG_TAG} 保存聊天失败:`, e);
    }
}

// ═══════════════════════════════════════════════════════════
//  Exchange 指纹（Hash）
// ═══════════════════════════════════════════════════════════

/**
 * cyrb53 变体哈希 —— 快速、低碰撞的字符串指纹算法
 */
function cyrb53Hash(str) {
    let h1 = 0xdeadbeef;
    let h2 = 0x41c6ce57;
    for (let i = 0; i < str.length; i++) {
        const ch = str.charCodeAt(i);
        h1 = Math.imul(h1 ^ ch, 2654435761);
        h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
    h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
    h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    const combined = 4294967296 * (2097151 & h2) + (h1 >>> 0);
    return 'ex_' + combined.toString(36);
}

/**
 * 为一个 exchange（用户消息 + AI 回复）计算唯一指纹。
 * 相同的用户消息 + 相同的 AI 回复 → 相同的 hash → 不会重复提取。
 */
export function computeExchangeHash(userText, aiText) {
    const u = (userText || '').trim();
    const a = (aiText || '').trim();
    const combined = `U[${u.length}]${u.slice(0, 500)}|||A[${a.length}]${a.slice(0, 500)}`;
    return cyrb53Hash(combined);
}

// ═══════════════════════════════════════════════════════════
//  已处理 Exchange 的持久化存储
// ═══════════════════════════════════════════════════════════

async function getProcessedSet(chatId) {
    if (!chatId) return new Set();
    const lf = getLocalForage();
    const data = await lf.getItem(`${EXCHANGE_STORE_PREFIX}${chatId}`);
    return new Set(Array.isArray(data) ? data : []);
}

async function saveProcessedSet(chatId, hashSet) {
    if (!chatId) return;
    const lf = getLocalForage();
    await lf.setItem(`${EXCHANGE_STORE_PREFIX}${chatId}`, [...hashSet]);
}

/**
 * 检查某个 exchange 是否已经被处理过
 */
export async function isExchangeProcessed(chatId, hash) {
    const set = await getProcessedSet(chatId);
    return set.has(hash);
}

/**
 * 将 exchange hash 标记为已处理
 */
export async function markExchangeProcessed(chatId, hash) {
    const set = await getProcessedSet(chatId);
    set.add(hash);
    await saveProcessedSet(chatId, set);
}

// ═══════════════════════════════════════════════════════════
//  消息可见性同步（核心：自动隐藏机制）
// ═══════════════════════════════════════════════════════════

/**
 * 扫描当前聊天，将超出短期窗口的消息自动隐藏。
 *
 * 规则：
 *   - index 0（角色问候语）永远不隐藏
 *   - 系统消息(is_system)跳过
 *   - 短期窗口内的消息不动
 *   - 窗口外、尚未隐藏的消息 → 设为 is_hidden=true, _bbmem_hideSource='plugin'
 *   - 窗口外、已经隐藏但没有我们标记的 → 视为用户手动隐藏, _bbmem_hideSource='user'
 *
 * @param {number} [windowOverride] - 覆盖短期窗口大小
 * @returns {Promise<{ hiddenCount: number }>} 本次新隐藏的消息数
 */
export async function syncMessageVisibility(windowOverride) {
    const ctx = getContext();
    const chat = ctx.chat;
    if (!chat || chat.length <= 1) return { hiddenCount: 0 };

    const settings = getSettings();
    const windowSize = windowOverride ?? settings.shortTermWindow ?? 5;

    // cutoff: 从这个 index 开始（不含）到末尾是短期窗口
    const cutoff = Math.max(1, chat.length - windowSize);

    let hiddenCount = 0;
    let changed = false;

    for (let i = 1; i < chat.length; i++) {
        const msg = chat[i];

        // 跳过系统消息
        if (msg.is_system) continue;

        if (i < cutoff) {
            // ── 这条消息在短期窗口之外 ──
            if (!msg.is_hidden) {
                // 还没被隐藏 → 由插件隐藏
                msg.is_hidden = true;
                msg._bbmem_hideSource = 'plugin';
                hiddenCount++;
                changed = true;
            } else if (!msg._bbmem_hideSource) {
                // 已经被隐藏，但没有我们的标记 → 是用户/其他方式隐藏的
                msg._bbmem_hideSource = 'user';
                changed = true;
            }
        }
        // 窗口内的消息：不做任何操作
    }

    if (changed) {
        saveChat();
    }

    if (hiddenCount > 0) {
        console.log(`${LOG_TAG} 自动隐藏了 ${hiddenCount} 条消息（保留最近 ${windowSize} 条）`);
    }

    return { hiddenCount };
}

// ═══════════════════════════════════════════════════════════
//  可提取 Exchange 查询
// ═══════════════════════════════════════════════════════════

/**
 * 查找所有可以进入记忆提取流程的 exchange。
 *
 * 条件：
 *   1. AI 消息的 _bbmem_hideSource === 'plugin'（插件自动隐藏的）
 *   2. AI 消息的 _bbmem_extracted !== true（还没被提取过）
 *   3. exchange 的指纹不在已处理集合中
 *
 * 每个 exchange = AI 回复 + 它前面最近的一条用户消息
 *
 * @returns {Promise<Array<{
 *   userMessage: string,
 *   aiMessage: string,
 *   hash: string,
 *   userIndex: number,
 *   aiIndex: number
 * }>>}
 */
export async function getExtractableExchanges() {
    const chatId = getChatId();
    if (!chatId) return [];

    const ctx = getContext();
    const chat = ctx.chat;
    if (!chat || chat.length <= 1) return [];

    const processedSet = await getProcessedSet(chatId);
    const exchanges = [];

    for (let i = 1; i < chat.length; i++) {
        const msg = chat[i];

        // 只关注 AI 消息
        if (msg.is_user) continue;
        // 只处理插件自动隐藏的
        if (msg._bbmem_hideSource !== 'plugin') continue;
        // 已经提取过的跳过
        if (msg._bbmem_extracted) continue;

        // 向前找最近的用户消息，组成 exchange
        let userText = '';
        let userIndex = -1;
        for (let j = i - 1; j >= 0; j--) {
            if (chat[j].is_user && chat[j].mes) {
                userText = chat[j].mes;
                userIndex = j;
                break;
            }
        }

        const aiText = msg.mes || '';
        const hash = computeExchangeHash(userText, aiText);

        // 指纹已存在 → 跳过（标记为已提取以加速后续扫描）
        if (processedSet.has(hash)) {
            msg._bbmem_extracted = true;
            continue;
        }

        exchanges.push({
            userMessage: userText,
            aiMessage: aiText,
            hash,
            userIndex,
            aiIndex: i,
        });
    }

    return exchanges;
}

/**
 * 将一个 exchange 标记为已提取完成：
 *   - 在 AI 消息对象上设置 _bbmem_extracted = true
 *   - 将 hash 加入已处理集合
 */
export async function markExchangeExtracted(aiIndex, hash) {
    const chatId = getChatId();
    if (!chatId) return;

    const ctx = getContext();
    const chat = ctx.chat;

    if (chat && chat[aiIndex]) {
        chat[aiIndex]._bbmem_extracted = true;
        saveChat();
    }

    await markExchangeProcessed(chatId, hash);
}

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
        // v4.4.2: 优先直接保存，避免 saveChatConditional 在有条件时跳过
        // is_hidden 等变更必须持久化，否则刷新后丢失
        if (typeof ctx.saveChat === 'function') {
            ctx.saveChat();
        } else if (typeof ctx.saveChatDebounced === 'function') {
            ctx.saveChatDebounced();
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
 * v2.9.8: 扫描当前聊天，基于 exchange 窗口自动隐藏消息。
 *
 * 规则：
 *   - 从末尾向前数 N 个可见 exchange 保留，其余隐藏
 *   - index 0（角色问候语）永远不隐藏
 *   - 系统消息(is_system)跳过
 *   - 隐藏来源：_bbmem_hideSource='plugin'（插件隐藏）或 'user'（用户手动隐藏）
 *
 * @param {number} [windowOverride] - 覆盖 exchange 窗口大小
 * @returns {Promise<{ hiddenCount: number }>} 本次新隐藏的消息数
 */
export async function syncMessageVisibility(windowOverride) {
    const ctx = getContext();
    const chat = ctx.chat;
    if (!chat || chat.length <= 1) return { hiddenCount: 0 };

    const settings = getSettings();
    const windowExchanges = windowOverride ?? settings.contextWindowExchanges ?? 5;

    // 从末尾反向计数 exchange（AI 消息），找到窗口截止位置
    let visibleExchangeCount = 0;
    let cutoff = chat.length;
    for (let i = chat.length - 1; i >= 1; i--) {
        const msg = chat[i];
        if (msg.is_system || msg.is_user || msg.is_hidden) continue;
        visibleExchangeCount++;
        if (visibleExchangeCount >= windowExchanges) {
            cutoff = i;
            break;
        }
    }

    let hiddenCount = 0;
    let changed = false;

    for (let i = 1; i < cutoff; i++) {
        const msg = chat[i];
        if (msg.is_system) continue;

        if (!msg.is_hidden && !msg._bbmem_extracted) {
            msg._bbmem_pendingExtraction = true;
            hiddenCount++;
            changed = true;
        } else if (msg.is_hidden && !msg._bbmem_hideSource) {
            msg._bbmem_hideSource = 'user';
            changed = true;
        }
    }

    if (changed) {
        saveChat();
    }

    if (hiddenCount > 0) {
        console.log(`${LOG_TAG} 自动隐藏了 ${hiddenCount} 条消息（保留最近 ${windowExchanges} 个 exchange）`);
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
        // 只处理标记为待提取的
        if (!msg._bbmem_pendingExtraction) continue;
        // 已经提取过的跳过
        if (msg._bbmem_extracted) continue;
        // v2.9.8: 元标记消息跳过
        if (msg._bbmem_meta_marker) continue;

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
        chat[aiIndex]._bbmem_pendingExtraction = false;
        if (!chat[aiIndex].is_hidden) {
            chat[aiIndex].is_hidden = true;
            chat[aiIndex]._bbmem_hideSource = 'plugin';
        }
        saveChat();
    }

    await markExchangeProcessed(chatId, hash);
}

/**
 * v2.9.8: 隐藏一个 exchange（用户消息 + AI 回复）
 * 标记为插件隐藏，使其在聊天界面不可见
 * @param {number} userIndex - 用户消息索引
 * @param {number} aiIndex - AI 消息索引
 * @returns {boolean} 是否实际隐藏了消息
 */
export function hideExchange(userIndex, aiIndex) {
    const ctx = getContext();
    const chat = ctx.chat;
    if (!chat) return false;

    let changed = false;
    if (chat[userIndex] && !chat[userIndex].is_hidden) {
        chat[userIndex].is_hidden = true;
        chat[userIndex]._bbmem_hideSource = 'plugin';
        changed = true;
    }
    if (chat[aiIndex] && !chat[aiIndex].is_hidden) {
        chat[aiIndex].is_hidden = true;
        chat[aiIndex]._bbmem_hideSource = 'plugin';
        changed = true;
    }

    if (changed) saveChat();
    return changed;
}

/**
 * v2.9.8: 刷新聊天消息上的提取标记、隐藏状态和元标记按钮
 * 扫描 SillyTavern 聊天 DOM，为已提取/元标记的消息添加视觉标记和隐藏样式
 */
export function refreshExtractionMarkers() {
    const ctx = getContext();
    const chat = ctx.chat;
    if (!chat) return;

    let changed = false;
    const msgBlocks = document.querySelectorAll('.mes');
    msgBlocks.forEach(block => {
        // 移除旧标记
        const existingMarker = block.querySelector('.bb-extract-marker');
        if (existingMarker) existingMarker.remove();
        const existingMetaBtn = block.querySelector('.bb-meta-toggle-btn');
        if (existingMetaBtn) existingMetaBtn.remove();

        const mesId = block.getAttribute('mesid');
        if (mesId == null) return;
        const idx = parseInt(mesId, 10);
        if (isNaN(idx) || idx < 0 || idx >= chat.length) return;

        const msg = chat[idx];

        // ── 元标记按钮（所有消息都添加）──
        // v2.9.9: 清晰的双图标区分 — 🗃️ 可提取 / 🤖 元指令
        const metaBtn = document.createElement('button');
        metaBtn.className = 'bb-meta-toggle-btn';
        if (msg._bbmem_meta_marker) {
            metaBtn.title = '🤖 元指令 — 点击取消标记（恢复可提取）';
            metaBtn.innerHTML = '🤖';
            metaBtn.style.opacity = '1';
            metaBtn.style.color = 'var(--SmartThemeEmColor, #888)';
        } else {
            metaBtn.title = '🗃️ 可提取 — 点击标记为元指令（不提取）';
            metaBtn.innerHTML = '🗃️';
            metaBtn.style.opacity = '0.5';
            metaBtn.style.color = 'var(--SmartThemeQuoteColor, #4caf50)';
        }
        // 插入到 mes_buttons 行或 mes_block 中
        const btnRow = block.querySelector('.mes_buttons');
        if (btnRow) {
            btnRow.appendChild(metaBtn);
        } else {
            const contentEl = block.querySelector('.mes_block') || block;
            contentEl.appendChild(metaBtn);
        }

        // ── 提取标记 ──
        if (msg._bbmem_extracted) {
            const marker = document.createElement('span');
            marker.className = 'bb-extract-marker';
            marker.title = '此消息已被 BB-Memory 提取';
            marker.innerHTML = '<i class="fa-solid fa-circle-check"></i>';
            const contentEl = block.querySelector('.mes_text') || block.querySelector('.mes_block') || block;
            contentEl.appendChild(marker);
        }

        // ── 隐藏已提取/元标记的消息 ──
        if (msg._bbmem_extracted || msg._bbmem_meta_marker) {
            if (!block.classList.contains('bb-extracted-hidden')) {
                block.classList.add('bb-extracted-hidden');
            }
            // v4.2.0: 数据级隐藏 — 确保 AI 上下文也不可见
            if (!msg.is_hidden) {
                msg.is_hidden = true;
                msg._bbmem_hideSource = 'plugin';
                changed = true;
            }
        } else {
            block.classList.remove('bb-extracted-hidden');
        }
    });

    if (changed) saveChat();
}

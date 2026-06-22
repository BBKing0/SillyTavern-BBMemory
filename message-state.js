/**
 * message-state.js —— BB-Memory 的"消息管理员"（消息稳定化机制）
 *
 * 职责：
 *   1. 自动隐藏已处理消息（使用 SillyTavern 原生 is_system 隐藏标记）
 *   2. 标记每条消息的隐藏来源（插件/用户）和提取状态
 *   3. 计算 exchange（用户消息 + AI 回复）的唯一指纹，防止重复提取
 *   4. 提供可提取 exchange 的查询接口
 */

import { getSettings, recordHits } from './memory-store.js';

const EXCHANGE_STORE_PREFIX = 'bb_memory_exchanges_';
const LOG_TAG = '[BB-Memory]';
const MESSAGE_UID_KEY = '_bbmem_messageUid';
let lastExtractionMarkAt = 0;

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
    const ctx = getContext();
    return ctx?.libs?.localforage || globalThis.localforage || globalThis.SillyTavern?.libs?.localforage;
}

function saveChat() {
    try {
        const ctx = getContext();
        // ST 原生隐藏通过 is_system 持久化；优先使用官方隐藏函数同款保存路径。
        if (typeof ctx.saveChatConditional === 'function') {
            const result = ctx.saveChatConditional();
            if (result?.catch) result.catch((err) => console.warn(`${LOG_TAG} 保存聊天失败:`, err));
        } else if (typeof ctx.saveChat === 'function') {
            ctx.saveChat();
        } else if (typeof ctx.saveChatDebounced === 'function') {
            ctx.saveChatDebounced();
        }
    } catch (e) {
        console.warn(`${LOG_TAG} 保存聊天失败:`, e);
    }
}

function clearHitFrameMetadata(msg) {
    if (!msg || typeof msg !== 'object') return false;
    let changed = false;
    for (const key of ['_bbmem_hitFrameKey', '_bbmem_hitRecords', '_bbmem_hitRecordedAt', '_bbmem_hitAppliedKey', '_bbmem_hitRecordingKey']) {
        if (Object.prototype.hasOwnProperty.call(msg, key)) {
            delete msg[key];
            changed = true;
        }
    }
    return changed;
}

function nextExtractionMarkAt() {
    const now = Date.now();
    lastExtractionMarkAt = Math.max(now, lastExtractionMarkAt + 1);
    return lastExtractionMarkAt;
}

function parseHitFrameRecords(records) {
    if (!Array.isArray(records)) return [];
    const hits = [];
    for (const raw of records) {
        const text = String(raw || '');
        const pos = text.indexOf(':');
        if (pos <= 0) continue;
        const collection = text.slice(0, pos);
        const id = text.slice(pos + 1);
        if (!collection || !id) continue;
        hits.push({ collection, id });
    }
    return hits;
}

async function flushHitFrameMetadata(chatId, msg, hash) {
    if (!chatId || !msg || typeof msg !== 'object') return false;
    if (!Object.prototype.hasOwnProperty.call(msg, '_bbmem_hitRecords')) return false;
    const hits = parseHitFrameRecords(msg._bbmem_hitRecords);
    const frameKey = msg._bbmem_hitFrameKey || hash || '';
    try {
        if (msg._bbmem_hitAppliedKey !== frameKey && msg._bbmem_hitRecordingKey !== frameKey) {
            await recordHits(chatId, hits, { countMisses: true, frameKey });
        }
    } catch (err) {
        console.warn(`${LOG_TAG} 命中升降格记录失败:`, err?.message || err);
    }
    clearHitFrameMetadata(msg);
    return true;
}

function syncMessageBlockHiddenState(index, hidden) {
    if (!Number.isInteger(index) || index < 0) return;
    try {
        const block = document.querySelector(`.mes[mesid="${index}"]`);
        if (block) block.setAttribute('is_system', String(Boolean(hidden)));
    } catch { /* ignore */ }
}

function isPluginHidden(msg) {
    return !!msg && msg._bbmem_hideSource === 'plugin'
        && (msg.is_system === true || msg.is_hidden === true || msg._bbmem_autoHidden === true);
}

function isRealSystemMessage(msg) {
    return !!msg && msg.is_system === true && msg._bbmem_hideSource !== 'plugin';
}

export function setPluginHiddenState(msg, index, hidden) {
    if (!msg || typeof msg !== 'object') return false;
    let changed = false;
    if (hidden) {
        if (msg.is_system !== true) {
            msg.is_system = true;
            changed = true;
        }
        if (Object.prototype.hasOwnProperty.call(msg, 'is_hidden')) {
            delete msg.is_hidden;
            changed = true;
        }
        if (msg._bbmem_hideSource !== 'plugin') {
            msg._bbmem_hideSource = 'plugin';
            changed = true;
        }
        if (msg._bbmem_autoHidden !== true) {
            msg._bbmem_autoHidden = true;
            changed = true;
        }
        syncMessageBlockHiddenState(index, true);
        return changed;
    }

    if (msg._bbmem_hideSource !== 'plugin') return false;
    if (msg.is_system === true) {
        msg.is_system = false;
        changed = true;
    }
    if (Object.prototype.hasOwnProperty.call(msg, 'is_hidden')) {
        delete msg.is_hidden;
        changed = true;
    }
    if (Object.prototype.hasOwnProperty.call(msg, '_bbmem_hideSource')) {
        delete msg._bbmem_hideSource;
        changed = true;
    }
    if (Object.prototype.hasOwnProperty.call(msg, '_bbmem_autoHidden')) {
        delete msg._bbmem_autoHidden;
        changed = true;
    }
    syncMessageBlockHiddenState(index, false);
    return changed;
}

function hideAsPlugin(msg, index = null) {
    if (!msg || typeof msg !== 'object') return false;
    return setPluginHiddenState(msg, index, true);
}

function shouldStayHiddenAfterExtraction(msg) {
    if (!msg || typeof msg !== 'object') return false;
    if (msg._bbmem_extracted === true) return true;
    if (msg._bbmem_autoHidden === true) return true;
    return msg._bbmem_skipped === true && (msg._bbmem_meta_marker || msg._bbmem_meta_pair);
}

function enforceCompletedMessageHiding(chat) {
    if (!Array.isArray(chat)) return { hiddenCount: 0, changed: false };
    let hiddenCount = 0;
    let changed = false;
    for (let i = 0; i < chat.length; i++) {
        const msg = chat[i];
        if (!shouldStayHiddenAfterExtraction(msg)) continue;
        if (hideAsPlugin(msg, i)) hiddenCount++;
        if (msg._bbmem_pendingExtraction) {
            delete msg._bbmem_pendingExtraction;
            changed = true;
        }
    }
    return { hiddenCount, changed: changed || hiddenCount > 0 };
}

function refreshExtractionMarkersSoon() {
    refreshExtractionMarkers();
    setTimeout(() => refreshExtractionMarkers(), 150);
    setTimeout(() => refreshExtractionMarkers(), 800);
}

function applyExtractedDisplay(msg, displayMode, options = {}, index = null) {
    if (!msg || typeof msg !== 'object') return false;
    const { forceHide = false, forceVisible = false } = options;
    if (forceHide || displayMode === 'hidden') {
        return hideAsPlugin(msg, index);
    }
    if (forceVisible && isPluginHidden(msg)) {
        return setPluginHiddenState(msg, index, false);
    }
    return false;
}

function setPairedUserMetaFlag(chat, aiIndex, enabled) {
    if (!Array.isArray(chat)) return { userIndex: -1, userText: '' };
    const prev = findPreviousUser(chat, aiIndex);
    if (prev.userIndex >= 0 && chat[prev.userIndex]) {
        if (enabled) {
            chat[prev.userIndex]._bbmem_meta_pair = true;
        } else {
            delete chat[prev.userIndex]._bbmem_meta_pair;
        }
    }
    return prev;
}

function ensureMessageUid(msg) {
    if (!msg || typeof msg !== 'object') return { uid: '', changed: false };
    if (!msg[MESSAGE_UID_KEY]) {
        msg[MESSAGE_UID_KEY] = 'bbm_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
        return { uid: msg[MESSAGE_UID_KEY], changed: true };
    }
    return { uid: msg[MESSAGE_UID_KEY], changed: false };
}

function isAiMessage(msg) {
    return msg && !msg.is_user && !isRealSystemMessage(msg);
}

function findPreviousUser(chat, aiIndex) {
    for (let j = aiIndex - 1; j >= 0; j--) {
        if (chat[j]?.is_user && chat[j].mes) {
            return { userIndex: j, userText: chat[j].mes || '' };
        }
    }
    return { userIndex: -1, userText: '' };
}

function getOpeningContextIndices(chat, userIndex) {
    if (userIndex <= 0) return [];
    const indices = [];
    for (let i = 0; i < userIndex; i++) {
        const msg = chat[i];
        if (!isAiMessage(msg) || !msg.mes) continue;
        const prev = findPreviousUser(chat, i);
        if (prev.userIndex === -1) indices.push(i);
    }
    return indices;
}

function formatFloorRanges(floors) {
    const sorted = [...new Set(floors)]
        .filter(n => Number.isInteger(n) && n >= 0)
        .sort((a, b) => a - b);
    if (!sorted.length) return '无';
    const parts = [];
    let start = sorted[0];
    let prev = sorted[0];
    for (let i = 1; i < sorted.length; i++) {
        const n = sorted[i];
        if (n === prev + 1) {
            prev = n;
            continue;
        }
        parts.push(start === prev ? String(start) : `${start}-${prev}`);
        start = prev = n;
    }
    parts.push(start === prev ? String(start) : `${start}-${prev}`);
    return parts.join('、');
}

function isExtractedLike(msg) {
    return msg?._bbmem_extracted === true
        || (isPluginHidden(msg) && !msg?._bbmem_skipped && !msg?._bbmem_meta_marker);
}

// ═══════════════════════════════════════════════════════════
//  Exchange 指纹（Hash）
// ═══════════════════════════════════════════════════════════

/**
 * cyrb53 变体哈希 —— 快速、低碰撞的字符串指纹算法
 */
export function cyrb53Hash(str) {
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
 * v6.1.6: 从已处理集合中移除 hash，用于重新提取
 */
export async function unmarkExchangeProcessed(chatId, hash) {
    if (!chatId || !hash) return;
    const set = await getProcessedSet(chatId);
    if (set.has(hash)) {
        set.delete(hash);
        await saveProcessedSet(chatId, set);
    }
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
 * v2.9.8: 扫描当前聊天，基于 exchange 窗口把旧消息送入提取队列。
 *
 * 规则：
 *   - 从末尾向前数 N 个尚未处理的 exchange 保留，其余进入待提取队列
 *   - 开场白不单独提取，会并入第一个用户+AI exchange 的上下文
 *   - 真实系统消息(is_system 且非插件隐藏)跳过
 *   - 隐藏来源：_bbmem_hideSource='plugin'（插件隐藏）或 'user'（用户手动隐藏）
 *
 * @param {number} [windowOverride] - 覆盖 exchange 窗口大小
 * @returns {Promise<{ hiddenCount: number, pendingCount: number }>} 本次新隐藏/入队的消息数
 */
export async function syncMessageVisibility(windowOverride) {
    const ctx = getContext();
    const chat = ctx.chat;
    if (!chat || chat.length <= 1) return { hiddenCount: 0 };

    const settings = getSettings();
    const windowExchanges = windowOverride ?? settings.contextWindowExchanges ?? 5;
    let hiddenCount = 0;
    let pendingCount = 0;
    let changed = false;

    const enforced = enforceCompletedMessageHiding(chat);
    hiddenCount += enforced.hiddenCount;
    changed = changed || enforced.changed;

    // 从末尾反向计数“尚未处理”的 AI 回复，找到窗口截止位置。
    // 已提取 / 已跳过 / 元对话不再占用短期窗口，避免窗口被旧楼层卡住。
    let visibleExchangeCount = 0;
    let cutoff = -1;
    let newestAiIndex = -1;
    for (let i = chat.length - 1; i >= 0; i--) {
        if (isAiMessage(chat[i])) {
            newestAiIndex = i;
            break;
        }
    }
    const skipNewestAiForWindow = newestAiIndex === chat.length - 1;
    for (let i = chat.length - 1; i >= 0; i--) {
        const msg = chat[i];
        if (!isAiMessage(msg)) continue;
        if (skipNewestAiForWindow && i === newestAiIndex) continue;
        if (msg._bbmem_extracted || msg._bbmem_skipped || msg._bbmem_meta_marker) continue;
        if (isPluginHidden(msg)) continue;
        visibleExchangeCount++;
        if (visibleExchangeCount >= windowExchanges) {
            cutoff = i;
            break;
        }
    }

    if (cutoff < 0) {
        if (changed) saveChat();
        return { hiddenCount, pendingCount };
    }

    // 将窗口外的完整 exchange 标记为待提取；开场白不单独提取，会并入首个用户+AI exchange。
    for (let i = 0; i < cutoff; i++) {
        const msg = chat[i];
        if (!isAiMessage(msg)) continue;

        if (msg._bbmem_meta_marker) {
            // 元对话在短期窗口内保留可见；一旦进入提取窗口，直接标记为已跳过并隐藏整组 exchange。
            if (!msg._bbmem_skipped || !isPluginHidden(msg)) {
                const prev = findPreviousUser(chat, i);
                const hash = msg._bbmem_exchangeHash || computeExchangeHash(prev.userText || '', msg.mes || '');
                if (prev.userIndex >= 0) {
                    await markExchangeMetaSkipped(prev.userIndex, i, hash, msg._bbmem_meta_reason || 'manual');
                    hiddenCount++;
                } else {
                    msg._bbmem_skipped = true;
                    if (hideAsPlugin(msg, i)) hiddenCount++;
                    changed = true;
                }
                changed = true;
            }
        } else if (msg._bbmem_skipped && !isPluginHidden(msg)) {
            // 已跳过的消息超出窗口后自动隐藏
            hideAsPlugin(msg, i);
            hiddenCount++;
            changed = true;
        } else if (!isPluginHidden(msg) && !msg._bbmem_extracted && !msg._bbmem_pendingExtraction && !msg._bbmem_skipped) {
            const prev = findPreviousUser(chat, i);
            if (prev.userIndex === -1) continue;
            msg._bbmem_pendingExtraction = true;
            if (chat[prev.userIndex] && !chat[prev.userIndex]._bbmem_extracted && !chat[prev.userIndex]._bbmem_skipped) {
                chat[prev.userIndex]._bbmem_pendingExtraction = true;
            }
            pendingCount++;
            changed = true;
        } else if (msg.is_system && !msg._bbmem_hideSource) {
            msg._bbmem_hideSource = 'user';
            changed = true;
        }
    }

    if (changed) {
        saveChat();
    }

    if (hiddenCount > 0 || pendingCount > 0) {
        console.log(`${LOG_TAG} 楼层同步：标记待提取 ${pendingCount} 条，隐藏跳过/元对话 ${hiddenCount} 条（保留最近 ${windowExchanges} 个 exchange）`);
    }

    return { hiddenCount, pendingCount };
}

// ═══════════════════════════════════════════════════════════
//  可提取 Exchange 查询
// ═══════════════════════════════════════════════════════════

/**
 * 查找所有可以进入记忆提取流程的 exchange。
 *
 * 条件：
 *   1. AI 消息已被窗口同步标记为 _bbmem_pendingExtraction
 *   2. AI 消息的 _bbmem_extracted !== true（还没被提取过）
 *   3. exchange 的指纹不在已处理集合中
 *
 * 每个 exchange = AI 回复 + 它前面最近的一条用户消息；开场白会作为首个 exchange 的额外上下文。
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
    let changed = false;

    for (let i = 0; i < chat.length; i++) {
        const msg = chat[i];

        // 只关注 AI 消息
        if (!isAiMessage(msg)) continue;
        // 只处理标记为待提取的
        if (!msg._bbmem_pendingExtraction) continue;
        // 已经提取过的跳过
        if (msg._bbmem_extracted) continue;
        // v2.9.8: 元标记消息跳过
        if (msg._bbmem_meta_marker) continue;

        // 向前找最近的用户消息，组成 exchange；没有用户消息的开场白不单独提取。
        const { userIndex, userText } = findPreviousUser(chat, i);
        if (userIndex === -1) {
            delete msg._bbmem_pendingExtraction;
            changed = true;
            continue;
        }

        const openingIndices = getOpeningContextIndices(chat, userIndex)
            .filter(idx => !chat[idx]?._bbmem_extracted && !chat[idx]?._bbmem_skipped && !chat[idx]?._bbmem_meta_marker);
        const openingText = openingIndices
            .map(idx => `【开场白 ${idx}楼】${chat[idx].mes || ''}`)
            .join('\n');
        const userMessage = openingText ? `${openingText}\n\n${userText}` : userText;

        const aiText = msg.mes || '';
        const hash = computeExchangeHash(userText, aiText);

        // 指纹已存在 → 跳过（标记为已提取以加速后续扫描）
        if (processedSet.has(hash)) {
            const displayMode = getSettings().extractedMsgDisplay || 'hidden';
            const extractedAt = nextExtractionMarkAt();
            await flushHitFrameMetadata(chatId, chat[userIndex], hash);
            msg._bbmem_extracted = true;
            msg._bbmem_extractedAt = extractedAt;
            delete msg._bbmem_pendingExtraction;
            applyExtractedDisplay(msg, displayMode, { forceHide: true }, i);
            clearHitFrameMetadata(msg);
            if (chat[userIndex]) {
                chat[userIndex]._bbmem_extracted = true;
                chat[userIndex]._bbmem_extractedAt = extractedAt;
                delete chat[userIndex]._bbmem_pendingExtraction;
                applyExtractedDisplay(chat[userIndex], displayMode, { forceHide: true }, userIndex);
                clearHitFrameMetadata(chat[userIndex]);
            }
            for (const idx of openingIndices) {
                if (chat[idx]) {
                    chat[idx]._bbmem_extracted = true;
                    chat[idx]._bbmem_extractedAt = extractedAt;
                    delete chat[idx]._bbmem_pendingExtraction;
                    applyExtractedDisplay(chat[idx], displayMode, { forceHide: true }, idx);
                    clearHitFrameMetadata(chat[idx]);
                }
            }
            changed = true;
            continue;
        }

        exchanges.push({
            userMessage,
            aiMessage: aiText,
            hash,
            userIndex,
            aiIndex: i,
            extraIndices: openingIndices,
        });
    }

    if (changed) saveChat();
    return exchanges;
}

/**
 * 将一个 exchange 标记为已提取完成：
 *   - 在 AI 消息对象上设置 _bbmem_extracted = true
 *   - 将 hash 加入已处理集合
 */
export async function markExchangeExtracted(userIndex, aiIndex, hash, extraIndices = []) {
    const chatId = getChatId();
    if (!chatId) return;

    const ctx = getContext();
    const chat = ctx.chat;

    const settings = getSettings();
    const displayMode = settings.extractedMsgDisplay || 'hidden';

    if (chat) {
        const extractedAt = nextExtractionMarkAt();
        await flushHitFrameMetadata(chatId, chat[userIndex], hash);
        const markExtracted = (idx) => {
            if (!chat[idx]) return;
            chat[idx]._bbmem_extracted = true;
            chat[idx]._bbmem_extractedAt = extractedAt;
            delete chat[idx]._bbmem_pendingExtraction;
            delete chat[idx]._bbmem_skipped;
            chat[idx]._bbmem_exchangeHash = hash;
            clearHitFrameMetadata(chat[idx]);
            applyExtractedDisplay(chat[idx], displayMode, { forceHide: true }, idx);
        };
        markExtracted(aiIndex);
        markExtracted(userIndex);
        for (const idx of extraIndices || []) markExtracted(idx);
        saveChat();
        refreshExtractionMarkersSoon();
    }

    await markExchangeProcessed(chatId, hash);
}

/**
 * 将 exchange 标记为纯元对话跳过：
 *   - 不进入提取队列
 *   - hash 加入已处理集合，避免反复请求 AI
 *   - 保留元对话标记，用户取消标记后可重新入队
 */
export async function markExchangeMetaSkipped(userIndex, aiIndex, hash, reason = 'auto', extraIndices = []) {
    const chatId = getChatId();
    if (!chatId) return;

    const ctx = getContext();
    const chat = ctx.chat;

    if (chat) {
        const markSkipped = (idx, markMeta = false) => {
            if (!chat[idx]) return;
            if (markMeta) {
                chat[idx]._bbmem_meta_marker = true;
                chat[idx]._bbmem_meta_reason = reason;
            } else {
                chat[idx]._bbmem_meta_pair = true;
            }
            chat[idx]._bbmem_skipped = true;
            chat[idx]._bbmem_extracted = false;
            delete chat[idx]._bbmem_pendingExtraction;
            chat[idx]._bbmem_exchangeHash = hash;
            clearHitFrameMetadata(chat[idx]);
            hideAsPlugin(chat[idx], idx);
        };
        markSkipped(aiIndex, true);
        markSkipped(userIndex, false);
        for (const idx of extraIndices || []) markSkipped(idx, false);
        saveChat();
        refreshExtractionMarkersSoon();
    }

    await markExchangeProcessed(chatId, hash);
}

export function getExtractionFloorStatus() {
    const ctx = getContext();
    const chat = ctx.chat || [];
    const extracted = [];
    const pending = [];
    const skipped = [];
    const meta = [];
    const unextracted = [];
    const extractedTimes = [];

    for (let i = 0; i < chat.length; i++) {
        const msg = chat[i];
        if (!msg || isRealSystemMessage(msg)) continue;
        if (msg._bbmem_meta_marker || msg._bbmem_meta_pair) {
            meta.push(i);
        } else if (msg._bbmem_skipped) {
            skipped.push(i);
        } else if (msg._bbmem_pendingExtraction && !msg._bbmem_extracted) {
            pending.push(i);
        } else if (isExtractedLike(msg)) {
            extracted.push(i);
            extractedTimes.push({ floor: i, at: Number(msg._bbmem_extractedAt) || 0 });
        } else {
            unextracted.push(i);
        }
    }

    let latestExtracted = [];
    const newestAt = extractedTimes.reduce((max, item) => Math.max(max, item.at || 0), 0);
    if (newestAt > 0) {
        latestExtracted = extractedTimes.filter(item => item.at === newestAt).map(item => item.floor);
    } else if (extracted.length) {
        const sorted = [...extracted].sort((a, b) => a - b);
        const end = sorted[sorted.length - 1];
        latestExtracted = [end];
        for (let i = sorted.length - 2; i >= 0; i--) {
            if (sorted[i] === latestExtracted[0] - 1) latestExtracted.unshift(sorted[i]);
            else break;
        }
    }

    const parts = [];
    parts.push(`已提取楼层 ${formatFloorRanges(extracted)}`);
    if (pending.length) parts.push(`正在提取楼层 ${formatFloorRanges(pending)}`);
    if (unextracted.length) parts.push(`未提取楼层 ${formatFloorRanges(unextracted)}`);
    if (meta.length) parts.push(`元对话楼层 ${formatFloorRanges(meta)}`);
    if (skipped.length) parts.push(`已跳过楼层 ${formatFloorRanges(skipped)}`);

    return {
        total: extracted.length + pending.length + skipped.length + meta.length + unextracted.length,
        extracted,
        pending,
        skipped,
        meta,
        unextracted,
        extractedText: formatFloorRanges(extracted),
        pendingText: formatFloorRanges(pending),
        skippedText: formatFloorRanges(skipped),
        metaText: formatFloorRanges(meta),
        unextractedText: formatFloorRanges(unextracted),
        latestExtracted,
        latestExtractedText: formatFloorRanges(latestExtracted),
        summary: parts.join('；'),
        compact: `已提取 ${extracted.length} / 待提取 ${pending.length} / 未提取 ${unextracted.length}`,
    };
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
    if (chat[userIndex]) changed = hideAsPlugin(chat[userIndex], userIndex) || changed;
    if (chat[aiIndex]) changed = hideAsPlugin(chat[aiIndex], aiIndex) || changed;

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

    const chatId = getChatId();

    let changed = false;
    const msgBlocks = document.querySelectorAll('.mes');
    msgBlocks.forEach(block => {
        // 移除旧标记
        const existingMarker = block.querySelector('.bb-extract-marker');
        if (existingMarker) existingMarker.remove();
        const existingMetaBtn = block.querySelector('.bb-meta-toggle-btn');
        if (existingMetaBtn) existingMetaBtn.remove();
        const existingFloorActions = block.querySelector('.bb-floor-actions');
        if (existingFloorActions) existingFloorActions.remove();

        const mesId = block.getAttribute('mesid');
        if (mesId == null) return;
        const idx = parseInt(mesId, 10);
        if (isNaN(idx) || idx < 0 || idx >= chat.length) return;

        const msg = chat[idx];
        if (msg._bbmem_extracted && clearHitFrameMetadata(msg)) {
            changed = true;
        }

        // ── 元标记按钮（所有消息都添加）──
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
        const btnRow = block.querySelector('.mes_buttons');
        if (btnRow) {
            btnRow.appendChild(metaBtn);
        } else {
            const contentEl = block.querySelector('.mes_block') || block;
            contentEl.appendChild(metaBtn);
        }

        // 元标记按钮点击事件
        metaBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            msg._bbmem_meta_marker = !msg._bbmem_meta_marker;
            if (!msg._bbmem_meta_marker) {
                // 取消元标记：恢复消息为待提取状态
                setPluginHiddenState(msg, idx, false);
                delete msg._bbmem_meta_pair;
                msg._bbmem_pendingExtraction = true;
                msg._bbmem_extracted = false;
                msg._bbmem_skipped = false;
                msg._bbmem_meta_reason = undefined;
                let userText = '';
                for (let j = idx - 1; j >= 0; j--) {
                    if (chat[j].is_user && chat[j].mes) { userText = chat[j].mes; break; }
                }
                const hash = msg._bbmem_exchangeHash || computeExchangeHash(userText, msg.mes || '');
                await unmarkExchangeProcessed(chatId, hash);
                const prev = setPairedUserMetaFlag(chat, idx, false);
                if (prev.userIndex >= 0 && chat[prev.userIndex]) {
                    setPluginHiddenState(chat[prev.userIndex], prev.userIndex, false);
                    chat[prev.userIndex]._bbmem_skipped = false;
                }
            } else {
                delete msg._bbmem_pendingExtraction;
                msg._bbmem_extracted = false;
                msg._bbmem_skipped = false;
                const prev = setPairedUserMetaFlag(chat, idx, true);
                if (prev.userIndex >= 0) {
                    msg._bbmem_exchangeHash = msg._bbmem_exchangeHash || computeExchangeHash(prev.userText || '', msg.mes || '');
                }
            }
            try { saveChat(); } catch {}
            refreshExtractionMarkers();
            showInlineToast(block, msg._bbmem_meta_marker ? '已标记为元对话，进入提取窗口后会跳过' : '已恢复为可提取楼层', 'info');
        });

        // ── 楼层操作按钮容器 ──
        const floorActions = document.createElement('span');
        floorActions.className = 'bb-floor-actions';
        const markerTarget = block.querySelector('.mes_text') || block.querySelector('.mes_block') || block;

        // ── 提取标记 ──
        if (msg._bbmem_pendingExtraction && !msg._bbmem_extracted) {
            const marker = document.createElement('span');
            marker.className = 'bb-extract-marker bb-extract-pending';
            marker.title = 'BB-Memory 正在提取此消息...';
            marker.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
            markerTarget.appendChild(marker);

            // 跳过按钮
            const skipBtn = document.createElement('button');
            skipBtn.className = 'bb-floor-btn bb-floor-skip';
            skipBtn.title = '跳过提取该楼层';
            skipBtn.innerHTML = '<i class="fa-solid fa-forward"></i>';
            skipBtn.addEventListener('click', async (e) => {
                e.stopPropagation();
                msg._bbmem_pendingExtraction = false;
                msg._bbmem_skipped = true;
                saveChat();
                refreshExtractionMarkers();
            });
            floorActions.appendChild(skipBtn);

        } else if (msg._bbmem_skipped && !msg._bbmem_extracted) {
            // 已跳过状态：显示跳过标记 + 重入队列按钮
            const marker = document.createElement('span');
            marker.className = 'bb-extract-marker bb-extract-skipped';
            marker.title = '该楼层已被跳过提取';
            marker.innerHTML = '<i class="fa-solid fa-forward-step"></i>';
            markerTarget.appendChild(marker);

            const requeueBtn = document.createElement('button');
            requeueBtn.className = 'bb-floor-btn bb-floor-requeue';
            requeueBtn.title = '重新加入提取队列';
            requeueBtn.innerHTML = '<i class="fa-solid fa-rotate-left"></i>';
            requeueBtn.addEventListener('click', async (e) => {
                e.stopPropagation();
                msg._bbmem_pendingExtraction = true;
                msg._bbmem_skipped = false;
                setPluginHiddenState(msg, idx, false);
                saveChat();
                refreshExtractionMarkers();
            });
            floorActions.appendChild(requeueBtn);

        } else if (msg._bbmem_extracted) {
            const marker = document.createElement('span');
            marker.className = 'bb-extract-marker';
            marker.title = '此消息已被 BB-Memory 提取 (v6.1)';
            marker.innerHTML = '<i class="fa-solid fa-circle-check"></i>';
            markerTarget.appendChild(marker);

            // 重新提取按钮
            const reExtractBtn = document.createElement('button');
            reExtractBtn.className = 'bb-floor-btn bb-floor-re-extract';
            reExtractBtn.title = '重新提取该楼层记忆';
            reExtractBtn.innerHTML = '<i class="fa-solid fa-rotate"></i>';
            reExtractBtn.addEventListener('click', async (e) => {
                e.stopPropagation();
                reExtractBtn.disabled = true;
                reExtractBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
                try {
                    let userText = '';
                    for (let j = idx - 1; j >= 0; j--) {
                        if (chat[j].is_user && chat[j].mes) { userText = chat[j].mes; break; }
                    }
                    const hash = computeExchangeHash(userText, msg.mes || '');
                    const store = await import('./memory-store.js');
                    await store.deleteByExchange(chatId, hash);
                    await unmarkExchangeProcessed(chatId, hash); // v6.1.6: 清除已处理标记
                    msg._bbmem_extracted = false;
                    msg._bbmem_pendingExtraction = true;
                    saveChat();
                    const ag = await import('./auto-generator.js');
                    ag.onMessageReceived(idx);
                    refreshExtractionMarkers();
                } catch (err) {
                    console.warn('[BB-Memory] 重新提取失败:', err.message);
                    reExtractBtn.disabled = false;
                    reExtractBtn.innerHTML = '<i class="fa-solid fa-rotate"></i>';
                    showInlineToast(block, '重新提取失败: ' + err.message, 'error');
                }
            });
            floorActions.appendChild(reExtractBtn);

            // 删除楼层关联记忆按钮
            const delBtn = document.createElement('button');
            delBtn.className = 'bb-floor-btn bb-floor-del';
            delBtn.title = '查看并删除该楼层关联的记忆';
            delBtn.innerHTML = '<i class="fa-solid fa-trash"></i>';
            delBtn.addEventListener('click', async (e) => {
                e.stopPropagation();
                delBtn.disabled = true;
                delBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
                try {
                    let userText = '';
                    for (let j = idx - 1; j >= 0; j--) {
                        if (chat[j].is_user && chat[j].mes) { userText = chat[j].mes; break; }
                    }
                    const hash = computeExchangeHash(userText, msg.mes || '');
                    const store = await import('./memory-store.js');
                    // v6.1.6: 先加载关联记忆展示给用户
                    const [npc, items, timeline, memories] = await Promise.all([
                        store.getNpcProfiles(chatId), store.getItems(chatId),
                        store.getTimeline(chatId), store.getMemories(chatId),
                    ]);
                    const matched = {
                        npc: npc.filter(e => e.sourceExchange === hash),
                        items: items.filter(e => e.sourceExchange === hash),
                        timeline: timeline.filter(e => e.sourceExchange === hash),
                        memories: memories.filter(e => e.sourceExchange === hash),
                    };
                    await showDeleteFloorDialog(chatId, hash, matched, async () => {
                        const removed = await store.deleteByExchange(chatId, hash);
                        await unmarkExchangeProcessed(chatId, hash);
                        const total = removed.npc + removed.items + removed.timeline + removed.memories + (removed.map || 0);
                        const deletedTotal = Object.values(removed.deleted || {}).reduce((sum, n) => sum + (Number(n) || 0), 0);
                        const restoredTotal = Object.values(removed.restored || {}).reduce((sum, n) => sum + (Number(n) || 0), 0);
                        msg._bbmem_extracted = false;
                        msg._bbmem_pendingExtraction = true;
                        saveChat();
                        showInlineToast(block, `已处理 ${total} 条关联数据（删除 ${deletedTotal} / 回滚 ${restoredTotal}；NPC:${removed.npc} 物品:${removed.items} 时间线:${removed.timeline} 地点:${removed.map || 0} 记忆:${removed.memories}）`, 'success');
                        refreshExtractionMarkers();
                    });
                } catch (err) {
                    console.warn('[BB-Memory] 删除楼层记忆失败:', err.message);
                    showInlineToast(block, '删除失败: ' + err.message, 'error');
                } finally {
                    delBtn.disabled = false;
                    delBtn.innerHTML = '<i class="fa-solid fa-trash"></i>';
                }
            });
            floorActions.appendChild(delBtn);
        }

        if (floorActions.children.length > 0) {
            markerTarget.appendChild(floorActions);
        }

        // ── 根据提取/跳过状态同步真实隐藏状态；显示模式只通过外层 CSS 临时预览 ──
        const forceMetaHidden = (msg._bbmem_meta_marker || msg._bbmem_meta_pair) && msg._bbmem_skipped;
        const forceExtractedHidden = msg._bbmem_extracted || msg._bbmem_autoHidden || forceMetaHidden;
        const pluginHidden = isPluginHidden(msg);
        if (forceExtractedHidden || pluginHidden) {
            block.classList.remove('bb-extracted-transparent');
            if (!block.classList.contains('bb-extracted-hidden')) {
                block.classList.add('bb-extracted-hidden');
            }
            if (forceExtractedHidden && !isPluginHidden(msg)) {
                hideAsPlugin(msg, idx);
                changed = true;
            }
        } else {
            block.classList.remove('bb-extracted-hidden', 'bb-extracted-transparent');
        }

        // v6.1: 存储 exchange hash 到 DOM 用于删除检测
        if (msg._bbmem_exchangeHash) {
            const uidResult = ensureMessageUid(msg);
            if (uidResult.changed) changed = true;
            block.setAttribute('data-bb-exchange-hash', msg._bbmem_exchangeHash);
            if (uidResult.uid) block.setAttribute('data-bb-message-uid', uidResult.uid);
        } else {
            block.removeAttribute('data-bb-exchange-hash');
            block.removeAttribute('data-bb-message-uid');
        }
    });

    if (changed) saveChat();
}

// v6.1.6: 删除楼层关联记忆的确认弹窗
async function showDeleteFloorDialog(chatId, hash, matched, onConfirm) {
    const totalAll = matched.npc.length + matched.items.length + matched.timeline.length + matched.memories.length;
    if (totalAll === 0) {
        showInlineToast(null, '该楼层没有关联的记忆条目', 'info');
        return;
    }

    // 移除旧弹窗
    const existing = document.querySelector('.bb-delete-dialog-overlay');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.className = 'bb-delete-dialog-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:99999;display:flex;align-items:center;justify-content:center;';

    const panel = document.createElement('div');
    panel.style.cssText = 'background:var(--SmartThemeBlurTintColor,#1e1e2e);border:1px solid var(--SmartThemeBorderColor,#45475a);border-radius:12px;padding:20px;max-width:560px;width:90vw;max-height:70vh;display:flex;flex-direction:column;box-shadow:0 8px 32px rgba(0,0,0,0.5);';

    // 头部
    panel.innerHTML = `
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:16px;flex-shrink:0;">
            <i class="fa-solid fa-trash" style="color:#ef5350;"></i>
            <div style="flex:1;"><strong>删除楼层关联记忆</strong></div>
            <span style="font-size:0.85em;opacity:0.7;">${totalAll} 条</span>
        </div>
        <div style="flex:1;overflow-y:auto;min-height:0;font-size:0.85em;"></div>
        <div style="display:flex;gap:8px;margin-top:16px;flex-shrink:0;">
            <button class="bb-dialog-btn-cancel" style="flex:1;padding:8px;border:1px solid var(--SmartThemeBorderColor,#45475a);border-radius:6px;background:transparent;color:inherit;cursor:pointer;">取消</button>
            <button class="bb-dialog-btn-del" style="flex:1;padding:8px;border:none;border-radius:6px;background:#ef5350;color:#fff;cursor:pointer;font-weight:600;">全部删除</button>
        </div>
    `;

    const body = panel.querySelector('div:nth-child(2)');
    const pillars = [
        { key: 'npc', icon: 'fa-user', label: 'NPC角色', color: '#64b5f6', entries: matched.npc, fields: ['name','tier','role'] },
        { key: 'items', icon: 'fa-box', label: '物品', color: '#ffb74d', entries: matched.items, fields: ['name','status','tier'] },
        { key: 'timeline', icon: 'fa-clock', label: '时间线', color: '#81c784', entries: matched.timeline, fields: ['event','storyTime'] },
        { key: 'memories', icon: 'fa-brain', label: '记忆条目', color: '#ce93d8', entries: matched.memories, fields: ['title','type','tier'] },
    ];

    for (const p of pillars) {
        if (!p.entries.length) continue;
        const section = document.createElement('details');
        section.open = true;
        section.style.cssText = 'margin-bottom:8px;';
        section.innerHTML = `<summary style="cursor:pointer;padding:4px 0;color:${p.color};">
            <i class="fa-solid ${p.icon}"></i> ${p.label} <strong>(${p.entries.length})</strong>
        </summary>`;
        const list = document.createElement('ul');
        list.style.cssText = 'margin:4px 0 0 16px;padding:0;list-style:none;';
        for (const e of p.entries) {
            const parts = p.fields.map(f => e[f] || '-').join(' · ');
            const li = document.createElement('li');
            li.style.cssText = 'padding:2px 0;opacity:0.85;';
            li.textContent = parts;
            list.appendChild(li);
        }
        section.appendChild(list);
        body.appendChild(section);
    }

    overlay.appendChild(panel);
    document.body.appendChild(overlay);

    return new Promise((resolve) => {
        const cleanup = () => { overlay.remove(); resolve(); };
        panel.querySelector('.bb-dialog-btn-cancel').addEventListener('click', cleanup);
        panel.querySelector('.bb-dialog-btn-del').addEventListener('click', async () => {
            panel.querySelector('.bb-dialog-btn-del').disabled = true;
            panel.querySelector('.bb-dialog-btn-del').textContent = '删除中...';
            await onConfirm();
            cleanup();
        });
        overlay.addEventListener('click', (ev) => { if (ev.target === overlay) cleanup(); });
    });
}

function showInlineToast(nearBlock, message, type) {
    const existing = document.querySelector('.bb-inline-toast');
    if (existing) existing.remove();
    const toast = document.createElement('div');
    toast.className = 'bb-inline-toast';
    toast.textContent = message;
    toast.style.cssText = `
        position:fixed;bottom:100px;left:50%;transform:translateX(-50%);z-index:99999;
        padding:8px 16px;border-radius:6px;font-size:0.85em;pointer-events:none;
        background:${type === 'error' ? '#f44336' : '#4caf50'};color:#fff;
        box-shadow:0 2px 8px rgba(0,0,0,0.3);
    `;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 3000);
}

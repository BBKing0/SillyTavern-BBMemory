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
    for (let i = chat.length - 1; i >= 0; i--) {
        const msg = chat[i];
        if (msg.is_user || msg.is_hidden) continue;
        visibleExchangeCount++;
        if (visibleExchangeCount >= windowExchanges) {
            cutoff = i;
            break;
        }
    }

    let hiddenCount = 0;
    let changed = false;

    // v6.1.5: 只标记最靠近窗口的一个 exchange（从 cutoff 向左扫描，找到即停）
    // 避免初始加载时一次性标记所有历史消息
    for (let i = cutoff - 1; i >= 0; i--) {
        const msg = chat[i];
        if (msg.is_system || msg.is_user) continue;

        if (!msg.is_hidden && !msg._bbmem_extracted && !msg._bbmem_pendingExtraction) {
            msg._bbmem_pendingExtraction = true;
            hiddenCount++;
            changed = true;
            break;  // 只标记一个
        }
    }

    // 修复隐藏消息的来源标记（独立遍历）
    for (let i = 0; i < cutoff; i++) {
        const msg = chat[i];
        if (msg.is_system || msg.is_user) continue;
        if (msg.is_hidden && !msg._bbmem_hideSource) {
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

    for (let i = 0; i < chat.length; i++) {
        const msg = chat[i];

        // 只关注 AI 消息
        if (msg.is_user || msg.is_system) continue;
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
        chat[aiIndex]._bbmem_exchangeHash = hash; // v6.1: 用于消息删除时自动清理
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
                saveChat();
                refreshExtractionMarkers();
            });
            floorActions.appendChild(skipBtn);

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
                        const total = removed.npc + removed.items + removed.timeline + removed.memories;
                        msg._bbmem_extracted = false;
                        msg._bbmem_pendingExtraction = false;
                        saveChat();
                        showInlineToast(block, `已删除 ${total} 条记忆（NPC:${removed.npc} 物品:${removed.items} 时间线:${removed.timeline} 记忆:${removed.memories}）`, 'success');
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

        // ── 隐藏已提取/元标记的消息（待提取的不隐藏）──
        if (msg._bbmem_extracted || msg._bbmem_meta_marker) {
            if (!block.classList.contains('bb-extracted-hidden')) {
                block.classList.add('bb-extracted-hidden');
            }
            if (!msg.is_hidden) {
                msg.is_hidden = true;
                msg._bbmem_hideSource = 'plugin';
                changed = true;
            }
        } else {
            block.classList.remove('bb-extracted-hidden');
        }

        // v6.1: 存储 exchange hash 到 DOM 用于删除检测
        if (msg._bbmem_exchangeHash) {
            block.setAttribute('data-bb-exchange-hash', msg._bbmem_exchangeHash);
        } else {
            block.removeAttribute('data-bb-exchange-hash');
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

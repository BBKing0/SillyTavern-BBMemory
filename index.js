/**
 * index.js —— BB-Memory v8.4.1 主入口
 *
 * 四柱架构编排器：NPC档案 / 物品栏 / 时间线 / 记忆条目。
 * 负责初始化、拦截器、UI、斜杠命令。
 */

// ═══ 导入 ═══
import {
    MODULE_NAME, DEFAULT_SETTINGS, getSettings, updateSettings,
    getNpcProfiles, addNpcProfile, updateNpcProfile, removeNpcProfile, upsertNpcProfile,
    getItems, addItem, updateItem, removeItem, upsertItem,
    getTimeline, addTimelineEntry, updateTimelineEntry, removeTimelineEntry, upsertTimelineEntry,
    getTimelineThreads, saveTimelineThreads, upsertTimelineThread, removeTimelineThread,
    getMemories, addMemory, updateMemory, removeMemory,
    clearAllData, deleteByExchange, getMemoryStats, refreshAllSourceFloors,
    exportMemoriesToChatMetadata, importMemoriesFromChatMetadata,
    migrateV4ToV5, recordHits, checkDemotions,
    exportMemories, importMemories, updateFactContent, addHiddenNote, removeHiddenNote,
    scheduleAutoBackup,
    getCalendarDescription, setCalendarDescription,
} from './memory-store.js';

import {
    getRelevantMemories, getResidentMemories, buildMemoryInjectionPrompt,
    mergeExpandedRelevantResults, simpleSearch,
    getNpcForInjection, getItemsForInjection, getTimelineForInjection, getThreadSummaryForInjection,
} from './retriever.js';

import { MEMORY_TYPES, TRUTH_STATUS } from './memory-types.js';
import { NPC_TIERS, ITEM_TIERS, expandMemoriesForEntityKeyword } from './entity-tiers.js';

import {
    initAutoGenerator, stopAutoGenerator, extractFromContext, saveExtractedMemories,
    setAutoExtractProgressCallback, getPendingAutoCandidates, clearPendingAutoCandidates,
    callEmbeddingApi, embedExistingMemories,
    lastExtractFailedFloor, clearLastExtractFailedFloor,
    testApiConnection,
} from './auto-generator.js';

import {
    syncMessageVisibility, refreshExtractionMarkers,
    markExchangeExtracted, hideExchange, unmarkExchangeProcessed,
} from './message-state.js';

import { getClueBoard } from './clue-board.js';

import {
    checkMaintenanceNeeded, dismissMaintenanceRemind,
    performMaintenance, autoMaintainSilent,
    fuzzyMemory, archiveMemory, restoreMemory,
    regenerateThreadSummary,
    getMaintenanceResolved, clearMaintenanceResolved,
} from './memory-maintainer.js';

import { runHealthCheck, buildHealthCheckPanel } from './memory-health-check.js';

import { openAssistant } from './memory-assistant.js';
import { openMemoryManager } from './memory-manager.js';
import { getCharacterId, listSlots, saveToSlot, loadFromSlot, createEmptySlot, deleteSlot } from './memory-slots.js';

// ═══ 常量 ═══
const INJECTION_KEY = 'bb_memory_injection';
const POSITION_IN_CHAT = 1; // in-chat
const ROLE_SYSTEM = 0;

// ═══ 全局状态 ═══
let lastRetrievalResult = null;
let settingsPanelMounted = false;

// ═══════════════════════════════════════════════════════════
//  拦截器（核心）
// ═══════════════════════════════════════════════════════════

globalThis.bbMemoryInterceptor = async function (chat, contextSize, abort, type) {
    if (type === 'quiet') return chat;

    const settings = getSettings();
    if (!settings.enabled) { clearInjection(); return chat; }

    const ctx = SillyTavern.getContext();
    const chatId = ctx.chatId || (ctx.chat?.[0]?.chatId) || null;
    if (!chatId) { clearInjection(); return chat; }

    // v8.2.1 检测重roll：chat 末尾已是 AI 消息 → 正在覆盖已有回复
    let isReroll = false;
    for (let i = chat.length - 1; i >= 0; i--) {
        if (chat[i].is_user) break;
        if (!chat[i].is_system && chat[i].mes?.trim()) { isReroll = true; break; }
    }

    // 1. 提取最后一条用户消息
    let userMessage = '';
    for (let i = chat.length - 1; i >= 0; i--) {
        if (chat[i].is_user && chat[i].mes?.trim()) {
            userMessage = chat[i].mes.trim();
            break;
        }
    }
    if (!userMessage) { clearInjection(); return chat; }

    // 2. 上下文隐藏安全网 —— 只隐藏已提取的消息
    for (const msg of chat) {
        if (msg._bbmem_extracted && !msg.is_hidden) {
            msg.is_hidden = true;
            msg._bbmem_hideSource = 'plugin';
        }
    }

    // 3. 迁移检查
    if (!settings.migratedFromV4) {
        try { await migrateV4ToV5(chatId); } catch (e) { /* ignore */ }
    }

    // 4. 加载数据
    const [npc, items, timeline, memories, threads, clueBoard] = await Promise.all([
        getNpcProfiles(chatId), getItems(chatId), getTimeline(chatId), getMemories(chatId),
        getTimelineThreads(chatId),
        getClueBoard(chatId),
    ]);

    const hasData = npc.length + items.length + timeline.length + memories.length + threads.length > 0;
    if (!hasData) { clearInjection(); return chat; }

    // 5. 降格检查
    try { await checkDemotions(chatId); } catch (e) { /* ignore */ }
    try { await autoMaintainSilent(chatId); } catch (e) { /* ignore */ }

    // 6. Embedding（如有）
    let queryEmbedding = null;
    if (settings.embeddingEnabled && settings.embeddingEndpoint) {
        try {
            queryEmbedding = await callEmbeddingApi(userMessage, 3000);
        } catch { /* 降级到关键词 */ }
    }

    // 7. 检索各支柱
    const npcForInjection = getNpcForInjection(npc, userMessage);
    const itemsForInjection = getItemsForInjection(items, userMessage);
    const tlForInjection = getTimelineForInjection(timeline);
    const threadSummary = settings.timelineSummaryEnabled
        ? getThreadSummaryForInjection(threads, settings.maxActiveThreads || 5)
        : { text: '', threads: [] };
    const residentMems = getResidentMemories(memories);
    // v8.2.2 重roll 时扩大候选集 + 同分段局部 shuffle，保证质量不下降
    const relevantResults = getRelevantMemories(memories, userMessage, {
        maxResults: isReroll ? (settings.maxResults || 10) + 3 : (settings.maxResults || 10),
        minScore: settings.minScoreThreshold ?? 0.05,
        queryEmbedding,
    });
    const excludeIds = new Set([...npcForInjection.map(n => n.id), ...residentMems.map(m => m.id)]);
    for (const r of relevantResults) excludeIds.add(r.memory.id);
    const merged = mergeExpandedRelevantResults(memories, userMessage, relevantResults, excludeIds, 12, settings.maxResults, queryEmbedding);

    // v8.2.2 重roll 时仅对 L2/L3 同分段做局部 swap（相邻分数互换），不全局洗牌
    if (isReroll && merged.length > 2) {
        const l4 = merged.filter(r => r.level === 'L4');
        const rest = merged.filter(r => r.level !== 'L4');
        // 相邻分数分段两两 swap（保持整体质量顺序，仅微调同分段内位置）
        for (let i = 0; i < rest.length - 1; i++) {
            if (Math.abs(rest[i].score - rest[i + 1].score) < 0.08) {
                if (Math.random() < 0.5) [rest[i], rest[i + 1]] = [rest[i + 1], rest[i]];
            }
        }
        merged.length = 0;
        merged.push(...l4, ...rest);
    }

    if (!npcForInjection.length && !itemsForInjection.length &&
        !tlForInjection.ongoing.length && !tlForInjection.ended.length && !merged.length && !threadSummary.text) {
        clearInjection(); return chat;
    }

    // 8. 记录命中
    const hitRecords = [];
    for (const n of npcForInjection) hitRecords.push({ collection: 'npc', id: n.id });
    for (const i of itemsForInjection) hitRecords.push({ collection: 'item', id: i.id });
    for (const r of merged) hitRecords.push({ collection: 'mem', id: r.memory.id });
    recordHits(chatId, hitRecords).catch(() => {});

    // 9. 构建注入文本
    const { text, tokenEstimate, stats, truncated, tokenBudget } = await buildMemoryInjectionPrompt({
        npcProfiles: npcForInjection,
        items: itemsForInjection,
        timeline: tlForInjection,
        threadSummary,
        relevantResults: merged,
        settings,
        chatLength: chat.length,
        clueBoard,
    });

    // 10. 注入
    const injectionText = (settings.injectionTemplate || '[BB-Memory 长期记忆]\n{{memories}}')
        .replace('{{memories}}', text);
    ctx.setExtensionPrompt(INJECTION_KEY, injectionText, POSITION_IN_CHAT, 4, ROLE_SYSTEM);

    if (truncated.length > 0) {
        console.warn(`[BB-Memory] 注入token预算(${tokenBudget})不足，以下区块被截断: ${truncated.join(', ')} | 已用~${tokenEstimate} tokens`);
    }

    if (settings.debugLogging) {
        const prefix = isReroll ? '[BB-Memory] 重roll注入' : '[BB-Memory] 注入';
        console.log(`${prefix}: 线程${stats.threadCount} NPC${stats.npcCount} 物品${stats.itemCount} 时间线${stats.timelineCount} 记忆${stats.memoryCount} | ~${tokenEstimate} tokens`);
    }

    // 11. 存储命中追踪
    lastRetrievalResult = {
        chatId, timestamp: Date.now(),
        hits: merged.map(r => ({ id: r.memory.id, title: r.memory.title, type: r.memory.type, score: r.score, level: r.level, cognitiveType: r.memory.cognitiveType })),
        npcHits: npcForInjection.map(n => ({ id: n.id, name: n.name, npcTier: n.npcTier })),
        itemHits: itemsForInjection.map(i => ({ id: i.id, name: i.name, itemTier: i.itemTier })),
        timelineHits: {
            ongoing: tlForInjection.ongoing.map(t => ({ id: t.id, title: t.title, status: t.status })),
            ended: tlForInjection.ended.map(t => ({ id: t.id, title: t.title, status: t.status })),
        },
        stats,
    };
    // 同步侧边栏命中列表
    setTimeout(() => updateSidebarHitList(), 50);

    // 12. Active 模式：显示审核面板
    if (settings.extractionConfirmMode === 'active' && settings.activeConfirmStyle === 'popup') {
        const pending = getPendingAutoCandidates();
        if (pending.length) {
            showFloatingReviewPanel(chatId, pending);
            clearPendingAutoCandidates();
        }
    }

    // ST 原生跳过 is_hidden 消息，已由 syncMessageVisibility 处理

    return chat;
};

function clearInjection() {
    try {
        SillyTavern.getContext().setExtensionPrompt(INJECTION_KEY, '', POSITION_IN_CHAT, 0, ROLE_SYSTEM);
    } catch { /* ignore */ }
}

// ═══════════════════════════════════════════════════════════
//  悬浮审核面板（Active 模式）
// ═══════════════════════════════════════════════════════════

function showFloatingReviewPanel(chatId, candidates) {
    if (!candidates.length) return;
    // 简化实现：使用 ST 的确认弹窗
    const ctx = SillyTavern.getContext();
    const lines = candidates.slice(0, 5).map((c, i) =>
        `${i + 1}. [${c.type || 'event'}] ${c.title || c.summary?.slice(0, 40) || '(无标题)'}`
    ).join('\n');
    if (typeof ctx.callPopup === 'function') {
        ctx.callPopup(`[BB-Memory] 提取到 ${candidates.length} 条候选记忆：\n${lines}\n是否保存？`, 'confirm')
            .then(result => {
                if (result) saveExtractedMemories(chatId, candidates.map(c => ({ ...c, _selected: true })));
            });
    }
}

// ═══════════════════════════════════════════════════════════
//  UI 辅助
// ═══════════════════════════════════════════════════════════

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = String(text || '');
    return div.innerHTML;
}

function getExtensionFolder() {
    // 从 import.meta.url 解析扩展目录路径，不依赖 ST 核心模块的静态导入
    try {
        const url = String(import.meta.url);
        let m = url.match(/\/scripts\/extensions\/(.+?)\/index\.mjs(?:\?|[#]|$)/i);
        if (!m) m = url.match(/\/scripts\/extensions\/(.+?)\/index\.js(?:\?|[#]|$)/i);
        if (!m) m = url.match(/\/scripts\/extensions\/(.+?)\/[^/]+\.(?:js|mjs)(?:\?|[#]|$)/i);
        if (m?.[1]) return m[1];
    } catch { /* 忽略 */ }
    // 最终回退：假定为标准 third-party 安装路径
    return 'third-party/BB-Memory';
}

// ═══════════════════════════════════════════════════════════
//  初始化记忆（新功能）
// ═══════════════════════════════════════════════════════════

function promptFloorRange() {
    return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.className = 'bb-floor-select-overlay';
        const dialog = document.createElement('div');
        dialog.className = 'bb-mem-form-popup bb-floor-select-popup';
        dialog.innerHTML = `
            <div style="font-size:1.1em;font-weight:bold;margin-bottom:12px;color:var(--SmartThemeTextColor,#ddd);">
                <i class="fa-solid fa-layer-group"></i> 手动提取 — 选择楼层范围
            </div>
            <div style="font-size:0.8em;opacity:0.6;margin-bottom:10px;color:var(--SmartThemeTextColor,#ddd);">
                输入楼层范围（如 <b>0-10</b>），留空则提取最近 8 轮对话
            </div>
            <input id="bb_floor_range_input" type="text" placeholder="如 0-10（留空=最近8轮）"
                style="width:100%;padding:8px 10px;border-radius:6px;border:1px solid var(--SmartThemeBorderColor,#555);background:var(--SmartThemeInputColor,#1a1a2e);color:var(--SmartThemeTextColor,#ddd);font-size:0.95em;box-sizing:border-box;margin-bottom:14px;" />
            <div style="display:flex;gap:8px;justify-content:flex-end;">
                <button id="bb_floor_range_cancel" class="menu_button" style="opacity:0.6;">取消</button>
                <button id="bb_floor_range_ok" class="menu_button" style="background:var(--SmartThemeQuoteColor,#4caf50);color:#fff;">开始提取</button>
            </div>
        `;
        overlay.appendChild(dialog);
        document.body.appendChild(overlay);

        const input = dialog.querySelector('#bb_floor_range_input');
        const okBtn = dialog.querySelector('#bb_floor_range_ok');
        const cancelBtn = dialog.querySelector('#bb_floor_range_cancel');

        const cleanup = (value) => {
            overlay.remove();
            resolve(value);
        };

        okBtn.addEventListener('click', () => cleanup(input.value.trim()));
        cancelBtn.addEventListener('click', () => cleanup(''));
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') cleanup(input.value.trim());
            if (e.key === 'Escape') cleanup('');
        });
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) cleanup('');
        });
        setTimeout(() => input.focus(), 100);
    });
}

async function handleInitMemory(chatId, rangeStr = '') {
    const ctx = SillyTavern.getContext();

    // 收集上下文
    let contextText = '';

    // 角色卡信息
    try {
        if (ctx.characters && ctx.characterId !== undefined) {
            const char = ctx.characters[ctx.characterId];
            if (char) {
                contextText += `【角色卡】\n角色名：${char.name || ''}\n`;
                if (char.description) contextText += `描述：${char.description}\n`;
                if (char.personality) contextText += `性格：${char.personality}\n`;
                if (char.first_mes) contextText += `开场白：${char.first_mes}\n`;
                contextText += '\n';
            }
        }
    } catch { /* ignore */ }

    // 世界书
    try {
        if (ctx.worldInfo && ctx.worldInfo.entries) {
            const entries = Object.values(ctx.worldInfo.entries);
            contextText += `【世界书】\n${entries.map(e => `${e.key?.join(',') || ''}: ${e.content}`).join('\n')}\n\n`;
        }
    } catch { /* ignore */ }

    // 聊天记录 — 支持楼层范围
    let sourceFloor = undefined;
    try {
        const chat = ctx.chat || [];
        let messages;
        if (rangeStr && rangeStr.includes('-')) {
            const parts = rangeStr.split('-');
            const start = Math.max(0, parseInt(parts[0], 10) || 0);
            const end = Math.min(chat.length - 1, parseInt(parts[1], 10) || chat.length - 1);
            messages = chat.slice(start, end + 1).filter(m => m.mes?.trim());
            sourceFloor = start; // 标记为范围起始楼层
        } else {
            messages = chat.filter(m => m.mes?.trim()).slice(-8);
        }
        if (messages.length) {
            contextText += `【最近对话】\n${messages.map(m => `${m.is_user ? '用户' : m.name || '角色'}: ${m.mes}`).join('\n')}`;
        }
    } catch { /* ignore */ }

    if (!contextText.trim()) {
        throw new Error('没有可用的上下文（角色卡、世界书、对话记录均为空）');
    }

    // 使用分阶段提取
    const progressEl = createProgressToast('初始化记忆: 准备中...');

    const updateProgress = (info) => {
        if (progressEl) progressEl.textContent = `初始化记忆: ${info.progress || ''}`;
    };

    const sourceInfo = typeof sourceFloor === 'number' ? { sourceFloor } : {};
    const results = await extractFromContext(chatId, contextText, { onProgress: updateProgress, sourceInfo });

    if (progressEl) {
        progressEl.textContent = `初始化完成！NPC ${results.npc} / 物品 ${results.items} / 时间线 ${results.timeline} / 记忆 ${results.memories}`;
        setTimeout(() => progressEl.remove(), 3000);
    }

    showToast(`初始化完成！NPC ${results.npc} / 物品 ${results.items} / 时间线 ${results.timeline} / 记忆 ${results.memories}`, 'success');
    return results;
}

// v8.2.3 暴露给 memory-manager.js 使用
globalThis.bbPromptFloorRange = promptFloorRange;
globalThis.bbHandleInitMemory = handleInitMemory;

function createProgressToast(text) {
    try {
        const ctx = SillyTavern.getContext();
        if (typeof ctx.toastr?.info === 'function') {
            const el = document.createElement('div');
            el.textContent = text;
            ctx.toastr.info(el, '', { timeOut: 0, extendedTimeOut: 0 });
            return el;
        }
    } catch { /* ignore */ }
    return null;
}

function showToast(msg, type = 'info') {
    // v8.2.7 fallback: toastr 不可用时用 showTopNotification
    try {
        const ctx = SillyTavern.getContext();
        if (typeof ctx.toastr?.[type] === 'function') {
            ctx.toastr[type](msg, '', { timeOut: 3000 });
            return;
        }
    } catch { /* ignore */ }
    showTopNotification(msg, type);
}

// v8.0.0 顶部浮动通知（比 toastr 更显眼，用于重要操作反馈）
function showTopNotification(msg, type = 'info') {
    // 先尝试 toastr
    try {
        const ctx = SillyTavern.getContext();
        if (typeof ctx.toastr?.[type] === 'function') {
            ctx.toastr[type](msg, '', { timeOut: 3500 });
        }
    } catch { /* ignore */ }

    // 创建顶部浮动通知
    let container = document.getElementById('bb_notification_container');
    if (!container) {
        container = document.createElement('div');
        container.id = 'bb_notification_container';
        container.style.cssText = 'position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:999999;display:flex;flex-direction:column;gap:8px;max-width:400px;width:90%;pointer-events:none;';
        document.body.appendChild(container);
    }

    const colors = { success: '#4caf50', error: '#f44336', info: '#2196f3', warning: '#ff9800' };
    const notif = document.createElement('div');
    notif.style.cssText = `background:${colors[type] || colors.info};color:#fff;padding:12px 18px;border-radius:8px;font-size:0.92em;box-shadow:0 4px 16px rgba(0,0,0,0.35);animation:bbNotifIn 0.35s ease;text-align:center;pointer-events:auto;font-weight:500;`;
    notif.textContent = msg;

    container.appendChild(notif);

    setTimeout(() => {
        notif.style.opacity = '0';
        notif.style.transform = 'translateY(-10px)';
        notif.style.transition = 'opacity 0.3s, transform 0.3s';
        setTimeout(() => { notif.remove(); }, 300);
    }, 3500);
}

// v8.1.0 错误弹窗（提取/向量化失败时显示详细信息）
function showErrorPopup(title, message, details = '') {
    // 同时 toast
    try {
        const ctx = SillyTavern.getContext();
        if (typeof ctx.toastr?.error === 'function') {
            ctx.toastr.error(title + ': ' + message, '', { timeOut: 5000 });
        }
    } catch { /* ignore */ }

    // 弹窗
    const overlay = document.createElement('div');
    overlay.className = 'bb-error-popup-overlay';
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

    const dialog = document.createElement('div');
    dialog.className = 'bb-error-popup-dialog';
    dialog.innerHTML = `
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px;">
            <i class="fa-solid fa-circle-exclamation" style="color:#f44336;font-size:1.3em;"></i>
            <span style="font-weight:bold;font-size:1.05em;color:#f44336;">${escapeHtml(title)}</span>
        </div>
        <div style="font-size:0.9em;margin-bottom:6px;color:var(--SmartThemeBodyColor,#ddd);">${escapeHtml(message)}</div>
        ${details ? `<div style="font-size:0.78em;opacity:0.6;margin-bottom:6px;word-break:break-all;max-height:80px;overflow-y:auto;background:rgba(0,0,0,0.2);padding:8px;border-radius:6px;">${escapeHtml(details)}</div>` : ''}
        <div style="font-size:0.75em;opacity:0.4;margin-bottom:12px;">请检查相关 API 配置后重试</div>
        <button class="menu_button" style="width:100%;">关闭</button>
    `;
    dialog.querySelector('button').addEventListener('click', () => overlay.remove());

    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
}

// 全局暴露，供 auto-generator.js 调用
globalThis.bbShowErrorPopup = showErrorPopup;

// ═══════════════════════════════════════════════════════════
//  设置面板绑定
// ═══════════════════════════════════════════════════════════

function pickExtensionsSettingsContainer() {
    return document.getElementById('extensions_settings2')
        || document.getElementById('extensions_settings')
        || document.querySelector('#extensionsPane #extensions_settings2')
        || document.querySelector('#extensionsPane #extensions_settings');
}

async function mountExtensionSettingsHtml(html, maxAttempts = 50, delayMs = 100) {
    for (let i = 0; i < maxAttempts; i++) {
        const container = pickExtensionsSettingsContainer();
        if (container) {
            container.insertAdjacentHTML('beforeend', html);
            return true;
        }
        await new Promise(r => setTimeout(r, delayMs));
    }
    console.error('[BB-Memory] 未找到扩展设置容器 (#extensions_settings / #extensions_settings2)，无法在酒馆界面显示设置');
    return false;
}

function restoreApiSettings(settings) {
    const fields = {
        '#bb_auto_gen_endpoint': 'autoGenEndpoint',
        '#bb_auto_gen_api_key': 'autoGenApiKey',
        '#bb_auto_gen_model': 'autoGenModel',
        '#bb_embedding_endpoint': 'embeddingEndpoint',
        '#bb_embedding_api_key': 'embeddingApiKey',
        '#bb_embedding_model': 'embeddingModel',
    };
    for (const [sel, key] of Object.entries(fields)) {
        const el = document.querySelector(sel);
        if (el) el.value = settings[key] || '';
    }
}

function bindSidebarEvents() {
    const settings = getSettings();

    // 基础开关
    bindCheckbox('#bb_memory_enabled', 'enabled');
    bindCheckbox('#bb_auto_gen_enabled', 'autoGenEnabled', (checked) => {
        if (checked) initAutoGenerator(); else stopAutoGenerator();
    });
    bindCheckbox('#bb_embedding_enabled', 'embeddingEnabled');
    bindCheckbox('#bb_dedup_enabled', 'dedupEnabled');
    bindCheckbox('#bb_debug_logging', 'debugLogging');
    bindCheckbox('#bb_timeline_summary_enabled', 'timelineSummaryEnabled');
    bindCheckbox('#bb_auto_backup_enabled', 'autoBackupEnabled');

    // v7.9.0 自动备份状态指示器
    const updateAutoBackupStatus = () => {
        const el = document.querySelector('#bb_auto_backup_status');
        if (!el) return;
        const enabled = getSettings().autoBackupEnabled;
        el.innerHTML = enabled
            ? '<i class="fa-solid fa-circle" style="color:#4caf50;"></i> 自动备份已开启（5秒防抖）'
            : '<i class="fa-solid fa-circle" style="color:#ff9800;"></i> 自动备份已关闭';
    };
    document.querySelector('#bb_auto_backup_enabled')?.addEventListener('change', updateAutoBackupStatus);
    updateAutoBackupStatus();

    // 选择器
    bindSelect('#bb_auto_gen_mode', 'autoGenMode');
    bindSelect('#bb_extraction_confirm_mode', 'extractionConfirmMode');
    bindSelect('#bb_active_confirm_style', 'activeConfirmStyle');

    // v7.7.1 提取模式固定为合并提取，移除 extractionMode 选择器

    // 提取风格
    bindSelect('#bb_extraction_style', 'extractionStyle');
    const styleSelect = document.querySelector('#bb_extraction_style');
    const customBiasSection = document.querySelector('#bb_custom_bias_section');
    const customBiasTextarea = document.querySelector('#bb_custom_extraction_bias');

    // 自定义偏置区域显示/隐藏
    const toggleCustomBias = () => {
        if (styleSelect && customBiasSection) {
            customBiasSection.style.display = styleSelect.value === 'custom' ? '' : 'none';
        }
    };
    if (styleSelect) {
        styleSelect.addEventListener('change', toggleCustomBias);
        toggleCustomBias(); // 初始状态
    }

    // 自定义偏置文本绑定（手动处理）
    if (customBiasTextarea) {
        customBiasTextarea.value = getSettings().customExtractionBias || '';
        customBiasTextarea.addEventListener('change', () => {
            updateSettings({ customExtractionBias: customBiasTextarea.value });
        });
    }

    // v7.7.1 自定义提示词绑定
    bindInput('#bb_custom_core_principles', 'customCorePrinciples', 'string');
    bindInput('#bb_custom_extraction_dimensions', 'customExtractionDimensions', 'string');

    // 恢复默认按钮
    document.querySelector('#bb_reset_core_principles')?.addEventListener('click', () => {
        updateSettings({ customCorePrinciples: '' });
        const ta = document.querySelector('#bb_custom_core_principles');
        if (ta) ta.value = '';
        showToast('核心原则已恢复为默认', 'info');
    });
    document.querySelector('#bb_reset_extraction_dimensions')?.addEventListener('click', () => {
        updateSettings({ customExtractionDimensions: '' });
        const ta = document.querySelector('#bb_custom_extraction_dimensions');
        if (ta) ta.value = '';
        showToast('提取维度已恢复为默认', 'info');
    });

    // 数字/文本输入
    bindInput('#bb_context_window', 'contextWindowExchanges', 'number');
    bindInput('#bb_batch_extraction', 'batchExtractionCount', 'number');
    bindInput('#bb_token_budget', 'tokenBudget', 'number');
    bindInput('#bb_max_results', 'maxResults', 'number');
    bindInput('#bb_npc_injection_max', 'npcInjectionMax', 'number');
    bindInput('#bb_item_injection_max', 'itemInjectionMax', 'number');
    bindInput('#bb_timeline_ended_max', 'timelineEndedMax', 'number');
    bindInput('#bb_maintenance_mem_threshold', 'maintenanceMemThreshold', 'number');
    bindInput('#bb_maintenance_npc_threshold', 'maintenanceNpcThreshold', 'number');
    bindInput('#bb_maintenance_item_threshold', 'maintenanceItemThreshold', 'number');
    bindSelect('#bb_maintenance_mode', 'maintenanceMode');
    bindInput('#bb_diversity_limit', 'diversityLimitPerTag', 'number');
    bindInput('#bb_max_active_threads', 'maxActiveThreads', 'number');
    bindInput('#bb_health_check_duplicate_threshold', 'healthCheckDuplicateThreshold', 'number');
    bindInput('#bb_health_check_isolation_threshold', 'healthCheckIsolationThreshold', 'number');
    bindInput('#bb_health_check_stale_days', 'healthCheckStaleDays', 'number');
    bindInput('#bb_health_check_stale_hit_threshold', 'healthCheckStaleHitThreshold', 'number');
    bindInput('#bb_injection_template', 'injectionTemplate', 'string');
    // API 配置字段绑定
    bindInput('#bb_auto_gen_endpoint', 'autoGenEndpoint', 'string');
    bindInput('#bb_auto_gen_api_key', 'autoGenApiKey', 'string');
    bindInput('#bb_auto_gen_model', 'autoGenModel', 'string');
    bindInput('#bb_embedding_endpoint', 'embeddingEndpoint', 'string');
    bindInput('#bb_embedding_api_key', 'embeddingApiKey', 'string');
    bindInput('#bb_embedding_model', 'embeddingModel', 'string');
    // v7.8.0 日历描述改为 per-chat 存储
    const calTextarea = document.querySelector('#bb_calendar_description');
    if (calTextarea) {
        // 加载当前聊天的日历
        (async () => {
            const chatId = getChatId();
            if (chatId) {
                const val = await getCalendarDescription(chatId);
                calTextarea.value = val || '';
            }
        })();
        calTextarea.addEventListener('change', async () => {
            const chatId = getChatId();
            if (chatId) await setCalendarDescription(chatId, calTextarea.value);
        });
    }

    // 按钮
    document.querySelector('#bb_memory_backup_now')?.addEventListener('click', async function () {
        const chatId = getChatId();
        if (!chatId) return;
        const origHTML = this.innerHTML;
        this.disabled = true;
        this.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 备份中...';
        try {
            const result = await exportMemoriesToChatMetadata(chatId);
            showToast(`备份完成：${result.count} 条 (${(result.size/1024).toFixed(1)}KB) → 已保存到服务器`, 'success');
        } catch (e) {
            showToast(`备份失败: ${e.message}`, 'error');
        } finally {
            this.disabled = false;
            this.innerHTML = origHTML;
        }
    });
    document.querySelector('#bb_memory_restore_now')?.addEventListener('click', async function () {
        const chatId = getChatId();
        if (!chatId) return;
        const origHTML = this.innerHTML;
        this.disabled = true;
        this.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 恢复中...';
        try {
            const result = await importMemoriesFromChatMetadata(chatId);
            if (result.restored === 0 && result.skipped === 0) {
                showToast('暂无备份数据可恢复', 'info');
            } else {
                showToast(`恢复完成：${result.restored} 条新增，${result.skipped} 条跳过`, 'success');
            }
        } catch (e) {
            showToast(`恢复失败: ${e.message}`, 'error');
        } finally {
            this.disabled = false;
            this.innerHTML = origHTML;
        }
    });
    document.querySelector('#bb_init_memory_btn')?.addEventListener('click', async () => {
        const chatId = getChatId();
        if (!chatId) { showToast('请先进入角色对话', 'warning'); return; }
        const range = await promptFloorRange();
        if (range === '') return;
        try {
            const results = await handleInitMemory(chatId, range);
            showToast(`初始化完成！NPC ${results.npc} / 物品 ${results.items} / 时间线 ${results.timeline} / 记忆 ${results.memories}`, 'success');
        } catch (e) {
            showToast(`初始化失败: ${e.message}`, 'error');
        }
    });

    // v5.5: 记忆管家 → 完整管理器
    document.querySelector('#bb_memory_manage_btn')?.addEventListener('click', () => {
        const chatId = getChatId();
        if (!chatId) { showToast('请先进入角色对话', 'warning'); return; }
        openMemoryManager(chatId);
    });

    // v5.5: 记忆维护
    document.querySelector('#bb_memory_extract_btn')?.addEventListener('click', async () => {
        const chatId = getChatId();
        if (!chatId) { showToast('请先进入角色对话', 'warning'); return; }
        const range = await promptFloorRange();
        if (range === '') return; // 用户取消
        showToast('正在收集上下文并提取记忆...', 'info');
        try {
            const results = await handleInitMemory(chatId, range);
            showToast(`提取完成！NPC ${results.npc} / 物品 ${results.items} / 时间线 ${results.timeline} / 记忆 ${results.memories}`, 'success');
        } catch (e) {
            showToast(`提取失败: ${e.message}`, 'error');
        }
    });

    // v5.3: 标记消息
    document.querySelector('#bb_memory_meta_btn')?.addEventListener('click', () => {
        const ctx = SillyTavern.getContext();
        const chat = ctx.chat;
        if (!chat || chat.length < 2) { showToast('聊天消息不足', 'warning'); return; }
        let aiIdx = -1;
        for (let i = chat.length - 1; i >= 0; i--) {
            if (!chat[i].is_user && !chat[i].is_system) { aiIdx = i; break; }
        }
        if (aiIdx === -1) { showToast('未找到 AI 消息', 'warning'); return; }
        chat[aiIdx]._bbmem_meta_marker = !chat[aiIdx]._bbmem_meta_marker;
        if (!chat[aiIdx]._bbmem_meta_marker) {
            // 取消元标记：恢复消息为待提取状态
            chat[aiIdx].is_hidden = false;
            chat[aiIdx]._bbmem_hideSource = undefined;
            chat[aiIdx]._bbmem_pendingExtraction = true;
            chat[aiIdx]._bbmem_extracted = false;
        }
        try { ctx.saveChatDebounced(); } catch {}
        setTimeout(() => refreshExtractionMarkers(), 100);
        const label = chat[aiIdx]._bbmem_meta_marker ? '已标记为元指令（不提取）' : '已标记为可提取';
        showToast(label, 'info');
    });
    document.querySelector('#bb_memory_toggle_vis_btn')?.addEventListener('click', () => {
        cycleExtractedVisibility();
    });

    // v5.5: 记忆维护按钮
    document.querySelector('#bb_memory_maintenance_btn')?.addEventListener('click', async () => {
        const chatId = getChatId();
        if (!chatId) return;
        try {
            const result = await checkMaintenanceNeeded(chatId);
            showMaintenancePopup(chatId, result);
        } catch (e) {
            console.warn('[BB-Memory] 维护检查异常:', e.message);
            showToast('维护检查出错: ' + e.message, 'error');
            // 仍然打开面板（空数据模式）
            showMaintenancePopup(chatId, { issues: [], issueCount: 0, totalItems: 0, needed: false });
        }
    });
    // v6.7.0 刷新时间线总结
    document.querySelector('#bb_thread_refresh_btn')?.addEventListener('click', async () => {
        const chatId = getChatId();
        if (!chatId) return;
        showToast('正在生成时间线总结...', 'info');
        try {
            const result = await regenerateThreadSummary(chatId);
            if (result.threadCount > 0) {
                showToast(`时间线总结完成：${result.threadCount} 条线程`, 'success');
            } else {
                showToast('时间线总结完成：本轮无需更新', 'info');
            }
        } catch (e) {
            console.warn('[BB-Memory] 线程总结失败:', e.message);
            showToast('线程总结失败: ' + e.message, 'error');
        }
    });
    // v7.9.0 换楼刷新（从悬浮窗移到侧边栏）
    document.querySelector('#bb_floor_refresh_btn')?.addEventListener('click', async () => {
        const chatId = getChatId();
        if (!chatId) { showToast('请先进入角色对话', 'warning'); return; }
        const stats = await refreshAllSourceFloors(chatId);
        const total = stats.npc + stats.items + stats.timeline + stats.memories;
        if (total === 0) {
            showToast('当前没有需要刷新的楼层记忆', 'info');
        } else {
            showToast(`已标记 ${total} 条记忆为旧聊天来源（NPC:${stats.npc} 物品:${stats.items} 时间线:${stats.timeline} 记忆:${stats.memories}）`, 'success');
        }
    });
    document.querySelector('#bb_clue_board_btn')?.addEventListener('click', () => {
        const chatId = getChatId();
        if (!chatId) { showToast('请先进入角色对话', 'warning'); return; }
        import('./clue-board.js').then(m => m.openClueBoard(chatId));
    });
    document.querySelector('#bb_agent_btn')?.addEventListener('click', () => {
        const chatId = getChatId();
        if (!chatId) { showToast('请先进入角色对话', 'warning'); return; }
        import('./memory-agent.js').then(m => m.openAgent(chatId));
    });

    // ═══ v8.6.0 记忆分类 ═══

    // 分类开关由 refreshCategoryUI 动态渲染，此处不绑定静态元素

    document.querySelector('#bb_add_category_btn')?.addEventListener('click', async () => {
        const input = document.querySelector('#bb_new_category_name');
        const name = input?.value?.trim();
        if (!name) { showToast('请输入分类名称', 'warning'); return; }
        const { addCategory } = await import('./memory-store.js');
        const ok = await addCategory(name);
        if (ok) { input.value = ''; refreshCategoryUI(); showToast(`分类「${name}」已添加`, 'success'); }
        else { showToast(`分类「${name}」已存在或无效`, 'warning'); }
    });

    document.querySelector('#bb_rename_category_btn')?.addEventListener('click', async () => {
        const select = document.querySelector('#bb_category_rename_select');
        const input = document.querySelector('#bb_category_rename_input');
        const oldName = select?.value;
        const newName = input?.value?.trim();
        if (!oldName) { showToast('请选择要重命名的分类', 'warning'); return; }
        if (!newName) { showToast('请输入新名称', 'warning'); return; }
        const chatId = getChatId();
        if (!chatId) return;
        const { renameCategory } = await import('./memory-store.js');
        const ok = await renameCategory(chatId, oldName, newName);
        if (ok) { input.value = ''; refreshCategoryUI(); showToast(`已重命名为「${newName}」`, 'success'); }
        else { showToast('重命名失败', 'error'); }
    });

    document.querySelector('#bb_category_rename_select')?.addEventListener('change', function () {
        const input = document.querySelector('#bb_category_rename_input');
        if (input) input.value = this.value;
    });

    async function refreshCategoryUI() {
        const { getSettings, toggleCategory, removeCategory, getCategoryStats } = await import('./memory-store.js');
        const settings = getSettings();
        const chatId = getChatId();
        if (!chatId) return;

        // 分类开关 checkbox 列表
        const togglesDiv = document.querySelector('#bb_category_toggles');
        if (togglesDiv) {
            if (!settings.categories || settings.categories.length === 0) {
                togglesDiv.innerHTML = '<div style="opacity:0.4;font-size:0.8em;">暂无分类，请添加</div>';
            } else {
                let stats = {};
                try { stats = await getCategoryStats(chatId); } catch { /* ignore */ }
                const enabled = settings.enabledCategories || {};
                togglesDiv.innerHTML = settings.categories.map(cat => {
                    const s = stats[cat] || {};
                    const total = (s.mem || 0) + (s.npc || 0) + (s.item || 0) + (s.timeline || 0);
                    const checked = enabled[cat] === true ? 'checked' : '';
                    return `<label style="display:flex;align-items:center;gap:6px;padding:3px 0;cursor:pointer;font-size:0.85em;">
                        <input type="checkbox" class="bb-cat-toggle" data-cat="${escapeHtml(cat)}" ${checked} style="cursor:pointer;" />
                        <span style="flex:1;">${escapeHtml(cat)}</span>
                        <small style="opacity:0.5;">${total}条</small>
                        <button class="menu_button bb-cat-del-btn" data-cat="${escapeHtml(cat)}" style="font-size:0.65em;padding:1px 5px;opacity:0.4;">✕</button>
                    </label>`;
                }).join('');
                // 绑定开关事件
                togglesDiv.querySelectorAll('.bb-cat-toggle').forEach(cb => {
                    cb.addEventListener('change', async function () {
                        await toggleCategory(this.dataset.cat, this.checked);
                        showToast(`「${this.dataset.cat}」${this.checked ? '已开启注入' : '已关闭注入'}`, 'success');
                    });
                });
                // 绑定删除按钮
                togglesDiv.querySelectorAll('.bb-cat-del-btn').forEach(btn => {
                    btn.addEventListener('click', async (e) => {
                        e.preventDefault(); e.stopPropagation();
                        const catName = btn.dataset.cat;
                        if (!confirm(`确定删除分类「${catName}」？\n该分类下的所有条目将变为"通用"。`)) return;
                        await removeCategory(chatId, catName);
                        refreshCategoryUI();
                        showToast(`分类「${catName}」已删除`, 'success');
                    });
                });
            }
        }

        // 重命名选择框
        const renameSel = document.querySelector('#bb_category_rename_select');
        if (renameSel) {
            renameSel.innerHTML = '<option value="">— 选择分类 —</option>';
            for (const cat of (settings.categories || [])) {
                renameSel.innerHTML += `<option value="${escapeHtml(cat)}">${escapeHtml(cat)}</option>`;
            }
        }

        // 分类统计列表
        const list = document.querySelector('#bb_category_list');
        if (list) {
            if (!settings.categories || settings.categories.length === 0) {
                list.innerHTML = '';
            } else {
                let stats = {};
                try { stats = await getCategoryStats(chatId); } catch { /* ignore */ }
                list.innerHTML = settings.categories.map(cat => {
                    const s = stats[cat] || {};
                    const total = (s.mem || 0) + (s.npc || 0) + (s.item || 0) + (s.timeline || 0);
                    return `<div style="display:flex;align-items:center;gap:4px;font-size:0.75em;opacity:0.6;padding:2px 0;">📁 ${escapeHtml(cat)} — 记忆${s.mem||0} NPC${s.npc||0} 物品${s.item||0} 时间线${s.timeline||0}</div>`;
                }).join('');
            }
        }
    }
    // 初次加载时刷新分类UI
    refreshCategoryUI();

    document.querySelector('#bb_embedding_reindex_btn')?.addEventListener('click', async () => {
        const chatId = getChatId();
        if (!chatId) return;
        const memories = await getMemories(chatId);
        await embedExistingMemories(memories, (done, total) => {
            if (done % 10 === 0) console.log(`[BB-Memory] Reindex: ${done}/${total}`);
        });
        showToast(`Reindex 完成：${memories.length} 条`, 'success');
    });

    // ═══ v8.2.3 API 测试连接 ═══

    document.querySelector('#bb_api_test_connection')?.addEventListener('click', async () => {
        const btn = document.querySelector('#bb_api_test_connection');
        const origHTML = btn.innerHTML;
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 测试中...';
        try {
            const ep = document.querySelector('#bb_auto_gen_endpoint')?.value?.trim();
            const key = document.querySelector('#bb_auto_gen_api_key')?.value?.trim();
            const model = document.querySelector('#bb_auto_gen_model')?.value?.trim();
            if (!ep) { showToast('请先填写 API 端点', 'warning'); return; }
            const result = await testApiConnection(ep, key, model);
            if (result.ok) {
                showToast(`连接成功！延迟 ${result.latency}ms`, 'success');
            } else {
                showToast(`连接失败: ${result.error} (${result.latency}ms)`, 'error');
            }
        } catch (e) {
            showToast(`测试异常: ${e.message}`, 'error');
        } finally {
            btn.disabled = false;
            btn.innerHTML = origHTML;
        }
    });

    document.querySelector('#bb_embedding_test_btn')?.addEventListener('click', async () => {
        const btn = document.querySelector('#bb_embedding_test_btn');
        const origHTML = btn.innerHTML;
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 测试中...';
        try {
            const ep = document.querySelector('#bb_embedding_endpoint')?.value?.trim();
            const key = document.querySelector('#bb_embedding_api_key')?.value?.trim();
            const model = document.querySelector('#bb_embedding_model')?.value?.trim();
            if (!ep) { showToast('请先填写 Embedding API 端点', 'warning'); return; }
            // Embedding 端点用 embedding 格式测试
            const start = Date.now();
            const resp = await fetch(ep, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
                body: JSON.stringify({ model, input: 'test' }),
            });
            const latency = Date.now() - start;
            if (resp.ok) {
                showToast(`连接成功！延迟 ${latency}ms`, 'success');
            } else {
                const errText = await resp.text().catch(() => '');
                showToast(`连接失败: HTTP ${resp.status} (${latency}ms)`, 'error');
            }
        } catch (e) {
            showToast(`测试异常: ${e.message}`, 'error');
        } finally {
            btn.disabled = false;
            btn.innerHTML = origHTML;
        }
    });

    // ═══ v8.2.3 API 预设管理 ═══

    const profileSelect = document.querySelector('#bb_api_profile_select');
    const refreshProfileDropdown = () => {
        if (!profileSelect) return;
        const s = getSettings();
        const profiles = s.apiProfiles || [];
        profileSelect.innerHTML = '<option value="">-- 未选择 --</option>' +
            profiles.map((p, i) => `<option value="${i}">${escapeHtml(p.name)}</option>`).join('');
        if (s.activeApiProfile && profiles.some(p => p.name === s.activeApiProfile)) {
            const idx = profiles.findIndex(p => p.name === s.activeApiProfile);
            profileSelect.value = String(idx);
        }
    };

    profileSelect?.addEventListener('change', () => {
        const idx = profileSelect.value;
        if (idx === '') return;
        const s = getSettings();
        const p = s.apiProfiles?.[parseInt(idx)];
        if (!p) return;
        const epEl = document.querySelector('#bb_auto_gen_endpoint');
        const keyEl = document.querySelector('#bb_auto_gen_api_key');
        const modelEl = document.querySelector('#bb_auto_gen_model');
        if (epEl) epEl.value = p.endpoint || '';
        if (keyEl) keyEl.value = p.key || '';
        if (modelEl) modelEl.value = p.model || '';
        // v8.2.5 修复：bindInput 监听的是 change 事件，必须用 change 而非 input
        if (epEl) epEl.dispatchEvent(new Event('change', { bubbles: true }));
        if (keyEl) keyEl.dispatchEvent(new Event('change', { bubbles: true }));
        if (modelEl) modelEl.dispatchEvent(new Event('change', { bubbles: true }));
        // v8.2.7 Embedding API 预设同步 —— 旧预设无字段时清空输入框
        const embEpEl = document.querySelector('#bb_embedding_endpoint');
        const embKeyEl = document.querySelector('#bb_embedding_api_key');
        const embModelEl = document.querySelector('#bb_embedding_model');
        if (embEpEl) { embEpEl.value = p.embeddingEndpoint || ''; embEpEl.dispatchEvent(new Event('change', { bubbles: true })); }
        if (embKeyEl) { embKeyEl.value = p.embeddingKey || ''; embKeyEl.dispatchEvent(new Event('change', { bubbles: true })); }
        if (embModelEl) { embModelEl.value = p.embeddingModel || ''; embModelEl.dispatchEvent(new Event('change', { bubbles: true })); }
        updateSettings({ activeApiProfile: p.name });
        showToast(`已切换至预设: ${p.name}`, 'info');
        // v8.2.7 同步 Embedding 预设下拉框
        refreshEmbeddingProfileDropdown();
    });

    // v8.2.7 Embedding 预设下拉框 —— 与 AI 预设共享数据源
    const embProfileSelect = document.querySelector('#bb_embedding_profile_select');
    function refreshEmbeddingProfileDropdown() {
        if (!embProfileSelect) return;
        const s = getSettings();
        const profiles = s.apiProfiles || [];
        embProfileSelect.innerHTML = '<option value="">-- 未选择 --</option>' +
            profiles.map((p, i) => `<option value="${i}">${escapeHtml(p.name)}</option>`).join('');
    };

    embProfileSelect?.addEventListener('change', () => {
        const idx = embProfileSelect.value;
        if (idx === '') return;
        const s = getSettings();
        const p = s.apiProfiles?.[parseInt(idx)];
        if (!p) return;
        const epEl = document.querySelector('#bb_auto_gen_endpoint');
        const keyEl = document.querySelector('#bb_auto_gen_api_key');
        const modelEl = document.querySelector('#bb_auto_gen_model');
        if (epEl) { epEl.value = p.endpoint || ''; epEl.dispatchEvent(new Event('change', { bubbles: true })); }
        if (keyEl) { keyEl.value = p.key || ''; keyEl.dispatchEvent(new Event('change', { bubbles: true })); }
        if (modelEl) { modelEl.value = p.model || ''; modelEl.dispatchEvent(new Event('change', { bubbles: true })); }
        const embEpEl = document.querySelector('#bb_embedding_endpoint');
        const embKeyEl = document.querySelector('#bb_embedding_api_key');
        const embModelEl = document.querySelector('#bb_embedding_model');
        if (embEpEl) { embEpEl.value = p.embeddingEndpoint || ''; embEpEl.dispatchEvent(new Event('change', { bubbles: true })); }
        if (embKeyEl) { embKeyEl.value = p.embeddingKey || ''; embKeyEl.dispatchEvent(new Event('change', { bubbles: true })); }
        if (embModelEl) { embModelEl.value = p.embeddingModel || ''; embModelEl.dispatchEvent(new Event('change', { bubbles: true })); }
        updateSettings({ activeApiProfile: p.name });
        refreshProfileDropdown();
        showToast(`已切换至预设: ${p.name}`, 'info');
    });

    document.querySelector('#bb_api_profile_save')?.addEventListener('click', async () => {
        const name = prompt('请输入预设名称：');
        if (!name || !name.trim()) return;
        const ep = document.querySelector('#bb_auto_gen_endpoint')?.value?.trim() || '';
        const key = document.querySelector('#bb_auto_gen_api_key')?.value?.trim() || '';
        const model = document.querySelector('#bb_auto_gen_model')?.value?.trim() || '';
        // v8.2.5 Embedding API 也纳入预设
        const embEp = document.querySelector('#bb_embedding_endpoint')?.value?.trim() || '';
        const embKey = document.querySelector('#bb_embedding_api_key')?.value?.trim() || '';
        const embModel = document.querySelector('#bb_embedding_model')?.value?.trim() || '';
        if (!ep) { showToast('请先填写 API 端点', 'warning'); return; }

        const s = getSettings();
        const profiles = s.apiProfiles || [];
        const existing = profiles.findIndex(p => p.name === name.trim());
        const entry = { name: name.trim(), endpoint: ep, key, model, embeddingEndpoint: embEp, embeddingKey: embKey, embeddingModel: embModel };
        if (existing >= 0) {
            profiles[existing] = entry;
        } else {
            profiles.push(entry);
        }
        updateSettings({ apiProfiles: profiles, activeApiProfile: name.trim() });
        refreshProfileDropdown();
        refreshEmbeddingProfileDropdown();
        showToast(`预设"${name.trim()}"已保存`, 'success');
    });

    document.querySelector('#bb_api_profile_del')?.addEventListener('click', () => {
        const idx = profileSelect?.value;
        if (idx === '' || idx === null) { showToast('请先选择要删除的预设', 'warning'); return; }
        const s = getSettings();
        const profiles = s.apiProfiles || [];
        const p = profiles[parseInt(idx)];
        if (!p) return;
        if (!confirm(`确定删除预设"${p.name}"？`)) return;
        profiles.splice(parseInt(idx), 1);
        const newActive = s.activeApiProfile === p.name ? '' : s.activeApiProfile;
        updateSettings({ apiProfiles: profiles, activeApiProfile: newActive });
        refreshProfileDropdown();
        refreshEmbeddingProfileDropdown();
        showToast(`预设"${p.name}"已删除`, 'info');
    });

    // v8.2.7 初始化两个预设下拉框
    refreshProfileDropdown();
    refreshEmbeddingProfileDropdown();

}

// ═══ 折叠设置面板 ═══

function initCollapsibleSettings() {
    document.querySelectorAll('.bb-settings-section-header').forEach(header => {
        header.addEventListener('click', () => {
            const body = header.nextElementSibling;
            const chevron = header.querySelector('.bb-settings-chevron i');
            const isCollapsed = body.style.display === 'none';

            body.style.display = isCollapsed ? '' : 'none';
            if (chevron) {
                if (isCollapsed) {
                    chevron.classList.remove('fa-chevron-right');
                    chevron.classList.add('fa-chevron-down');
                } else {
                    chevron.classList.remove('fa-chevron-down');
                    chevron.classList.add('fa-chevron-right');
                }
            }

            const sectionKey = header.dataset.section;
            const s = getSettings();
            if (!s._collapsedSections) s._collapsedSections = {};
            s._collapsedSections[sectionKey] = !isCollapsed;
            updateSettings({ _collapsedSections: s._collapsedSections });
        });
    });

    // 恢复折叠状态
    const s = getSettings();
    const collapsed = s._collapsedSections || {};
    document.querySelectorAll('.bb-settings-section-header').forEach(header => {
        const key = header.dataset.section;
        if (collapsed[key]) {
            const body = header.nextElementSibling;
            if (body) body.style.display = 'none';
            const chevron = header.querySelector('.bb-settings-chevron i');
            if (chevron) {
                chevron.classList.remove('fa-chevron-down');
                chevron.classList.add('fa-chevron-right');
            }
        }
    });
}

function bindCheckbox(selector, settingKey, onChange) {
    const el = document.querySelector(selector);
    if (!el) return;
    el.checked = getSettings()[settingKey];
    el.addEventListener('change', () => {
        updateSettings({ [settingKey]: el.checked });
        if (onChange) onChange(el.checked);
    });
}

function bindSelect(selector, settingKey) {
    const el = document.querySelector(selector);
    if (!el) return;
    el.value = getSettings()[settingKey] || '';
    el.addEventListener('change', () => updateSettings({ [settingKey]: el.value }));
}

function bindInput(selector, settingKey, type) {
    const el = document.querySelector(selector);
    if (!el) return;
    const val = getSettings()[settingKey];
    el.value = val ?? '';
    el.addEventListener('change', () => {
        const v = type === 'number' ? Number(el.value) : el.value;
        updateSettings({ [settingKey]: v });
    });
}

function getChatId() {
    try {
        const ctx = SillyTavern.getContext();
        return ctx.chatId || (ctx.chat?.[0]?.chatId) || null;
    } catch { return null; }
}

// ═══ 反馈包装器 ═══

function withFeedback(btn, fn, { loadingText, successText, errorText } = {}) {
    if (btn.disabled) return Promise.resolve();
    const origHTML = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> ${loadingText || '处理中...'}`;
    const restore = () => { btn.disabled = false; btn.innerHTML = origHTML; };
    return fn()
        .then(r => { if (successText) showToast(successText, 'success'); restore(); return r; })
        .catch(e => { if (errorText) showToast(`${errorText}: ${e.message}`, 'error'); else showToast(e.message, 'error'); restore(); throw e; });
}

// ═══ 记忆维护面板 ═══

function showMaintenancePopup(chatId, result) {
    const existing = document.querySelector('.bb-maint-overlay');
    if (existing) existing.remove();

    const issues = result?.issues || [];
    const issueCount = result?.issueCount ?? issues.length;
    const totalItems = result?.totalItems ?? 0;
    const overlay = document.createElement('div');
    overlay.className = 'bb-maint-overlay';

    const panel = document.createElement('div');
    panel.className = 'bb-maint-panel';
    panel.style.cssText = 'display:flex;flex-direction:column;max-height:80vh;';

    // Header
    const header = document.createElement('div');
    header.className = 'bb-maint-header';
    header.style.cssText = 'display:flex;align-items:center;gap:12px;padding:16px 20px;border-bottom:1px solid var(--SmartThemeBorderColor,#45475a);flex-shrink:0;';
    header.innerHTML = `
        <i class="fa-solid fa-toolbox"></i>
        <div style="display:flex;flex-direction:column;flex:1;">
            <div style="display:flex;align-items:center;gap:8px;">
                <strong>记忆维护</strong>
                <span class="bb-maint-cat-count" style="font-size:0.85em;">${issueCount}条待处理</span>
            </div>
            <p style="margin:4px 0 0;font-size:0.85em;opacity:0.7;">共 ${totalItems} 条条目</p>
        </div>
        <button class="bb-maint-close-btn" style="background:none;border:none;color:inherit;font-size:24px;cursor:pointer;opacity:0.6;line-height:1;padding:0 4px;">&times;</button>
    `;
    panel.appendChild(header);

    // Tab bar
    const tabBar = document.createElement('div');
    tabBar.style.cssText = 'display:flex;border-bottom:1px solid var(--SmartThemeBorderColor,#45475a);flex-shrink:0;';
    const pendingBtn = document.createElement('button');
    pendingBtn.textContent = `待维护 (${issueCount})`;
    pendingBtn.style.cssText = 'flex:1;padding:10px;border:none;background:var(--SmartThemeBlurTintColor,#2a2a3e);color:inherit;cursor:pointer;font-size:0.9em;font-weight:600;border-bottom:2px solid #fab387;';
    const resolvedBtn = document.createElement('button');
    resolvedBtn.textContent = '已维护';
    resolvedBtn.style.cssText = 'flex:1;padding:10px;border:none;background:transparent;color:inherit;cursor:pointer;font-size:0.9em;opacity:0.6;border-bottom:2px solid transparent;';
    tabBar.appendChild(pendingBtn);
    tabBar.appendChild(resolvedBtn);
    const healthBtn = document.createElement('button');
    healthBtn.textContent = '体检';
    healthBtn.title = '记忆健康检查 — 数据完整性、孤立条目、近似重复等';
    healthBtn.style.cssText = 'flex:1;padding:10px;border:none;background:transparent;color:inherit;cursor:pointer;font-size:0.9em;opacity:0.6;border-bottom:2px solid transparent;';
    tabBar.appendChild(healthBtn);
    panel.appendChild(tabBar);

    // Body
    const body = document.createElement('div');
    body.className = 'bb-maint-body';
    body.style.cssText = 'flex:1;overflow-y:auto;padding:12px 20px;min-height:0;';
    panel.appendChild(body);

    overlay.appendChild(panel);
    document.body.appendChild(overlay);

    const close = () => { document.removeEventListener('keydown', onKeyDown); overlay.remove(); };
    header.querySelector('.bb-maint-close-btn').addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    const onKeyDown = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKeyDown);

    const issueTypeDefs = {
        idle_transient_memory: { icon: 'fa-regular fa-clock', label: '瞬时记忆（长期未命中）' },
        status_changed_item:   { icon: 'fa-solid fa-box',     label: '状态变更的物品' },
        compressible_timeline: { icon: 'fa-solid fa-compress', label: '可压缩的时间线' },
        low_tier_npc:          { icon: 'fa-solid fa-user',     label: '低优先级NPC' },
        foreshadow:            { icon: 'fa-solid fa-eye',      label: '待确认伏笔' },
    };

    function refreshBadges() {
        const total = body.querySelectorAll('.bb-maint-issue-item').length;
        const badgeEl = header.querySelector('.bb-maint-cat-count');
        if (badgeEl) badgeEl.textContent = total + '条待处理';
        pendingBtn.textContent = `待维护 (${total})`;
        // 移除空的分类
        body.querySelectorAll('.bb-maint-category').forEach(cat => {
            if (!cat.querySelector('.bb-maint-issue-item')) cat.remove();
        });
        if (total === 0) {
            body.innerHTML = '<div style="text-align:center;padding:40px;opacity:0.6;">所有待维护项已处理</div>';
        }
    }

    function renderPending() {
        pendingBtn.style.cssText = 'flex:1;padding:10px;border:none;background:var(--SmartThemeBlurTintColor,#2a2a3e);color:inherit;cursor:pointer;font-size:13px;font-weight:600;border-bottom:2px solid #fab387;';
        resolvedBtn.style.cssText = 'flex:1;padding:10px;border:none;background:transparent;color:inherit;cursor:pointer;font-size:13px;opacity:0.6;border-bottom:2px solid transparent;';
        healthBtn.style.cssText = 'flex:1;padding:10px;border:none;background:transparent;color:inherit;cursor:pointer;font-size:0.9em;opacity:0.6;border-bottom:2px solid transparent;';
        body.innerHTML = '';

        const grouped = {};
        for (const iss of issues) {
            if (!grouped[iss.type]) grouped[iss.type] = [];
            grouped[iss.type].push(iss);
        }

        if (issues.length === 0) {
            body.innerHTML = `<div style="text-align:center;padding:40px;opacity:0.6;">
                <i class="fa-solid fa-circle-check" style="font-size:2em;color:#4caf50;display:block;margin-bottom:12px;"></i>
                记忆状态良好，没有待维护项
            </div>`;
            return;
        }

        // Legend
        const legend = document.createElement('div');
        legend.className = 'bb-maint-legend';
        legend.style.cssText = 'padding:0 0 12px;border:none;display:flex;gap:14px;flex-wrap:wrap;font-size:0.8em;opacity:0.7;';
        legend.innerHTML = [
            ['#4caf50','保留'],['#2196f3','升级'],['#ff9800','降级'],['#f44336','删除'],['#9c27b0','压缩']
        ].map(([c,l]) => `<span style="display:inline-flex;align-items:center;gap:4px;"><span style="width:8px;height:8px;border-radius:50%;background:${c};display:inline-block;"></span>${l}</span>`).join('');
        body.appendChild(legend);

        for (const [type, typeIssues] of Object.entries(grouped)) {
            const meta = issueTypeDefs[type] || { icon: 'fa-solid fa-circle', label: type };
            const cat = document.createElement('div');
            cat.className = 'bb-maint-category';

            const catHeader = document.createElement('div');
            catHeader.className = 'bb-maint-cat-header';
            catHeader.style.cssText = 'display:flex;align-items:center;gap:8px;padding:8px 0;cursor:pointer;';
            catHeader.innerHTML = `<i class="${meta.icon}"></i><span style="flex:1;font-size:0.9em;font-weight:500;">${meta.label}</span><span class="bb-maint-cat-count">${typeIssues.length}条</span><i class="fa-solid fa-chevron-down" style="font-size:0.75em;opacity:0.5;"></i>`;

            const itemList = document.createElement('div');
            itemList.className = 'bb-maint-cat-items';

            for (const iss of typeIssues) {
                const item = iss.item;
                const label = item.name || item.title || item.event || item.id;
                const itemDiv = document.createElement('div');
                itemDiv.className = 'bb-maint-issue-item';
                itemDiv.dataset.collection = iss.collection;
                itemDiv.dataset.id = item.id;
                itemDiv.style.cssText = 'display:flex;align-items:center;padding:6px 0;gap:8px;border-bottom:1px solid var(--SmartThemeBorderColor,rgba(255,255,255,0.05));';

                const infoDiv = document.createElement('div');
                infoDiv.style.cssText = 'display:flex;flex-direction:column;flex:1;min-width:0;gap:2px;';
                infoDiv.innerHTML = `<span class="bb-maint-issue-title" style="font-size:0.85em;">${escapeHtml(label)}</span><span class="bb-maint-issue-reason" style="font-size:0.75em;opacity:0.5;">${escapeHtml(iss.reason || '')}</span>`;

                const actionDiv = document.createElement('div');
                actionDiv.style.cssText = 'display:flex;gap:3px;flex-shrink:0;';

                const addBtn = (op, color, text) => {
                    const btn = document.createElement('button');
                    btn.style.cssText = `padding:2px 6px;border:1px solid ${color};background:transparent;color:${color};border-radius:4px;cursor:pointer;font-size:0.75em;`;
                    btn.textContent = text;
                    btn.addEventListener('mouseenter', () => { btn.style.background = color + '22'; });
                    btn.addEventListener('mouseleave', () => { btn.style.background = 'transparent'; });
                    btn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        withFeedback(btn, async () => {
                            await performMaintenance(chatId, [{ collection: iss.collection, id: item.id, op }]);
                            itemDiv.remove();
                            // 同步移除 result.issues 中的对应项
                            const idx = result.issues.findIndex(i => i.item.id === item.id && i.collection === iss.collection);
                            if (idx >= 0) result.issues.splice(idx, 1);
                            refreshBadges();
                        }, { successText: `${text}: ${label}` });
                    });
                    actionDiv.appendChild(btn);
                };
                addBtn('keep', '#4caf50', '保留');
                addBtn('promote', '#2196f3', '升级');
                addBtn('demote', '#ff9800', '降级');
                addBtn('delete', '#f44336', '删除');
                if (type === 'compressible_timeline') {
                    addBtn('compress_timeline', '#9c27b0', '压缩');
                }

                itemDiv.appendChild(infoDiv);
                itemDiv.appendChild(actionDiv);
                itemList.appendChild(itemDiv);
            }

            catHeader.addEventListener('click', () => {
                const hidden = itemList.style.display === 'none';
                itemList.style.display = hidden ? '' : 'none';
                const chevron = catHeader.querySelector('.fa-chevron-down');
                if (chevron) chevron.style.transform = hidden ? '' : 'rotate(-90deg)';
            });

            cat.appendChild(catHeader);
            cat.appendChild(itemList);
            body.appendChild(cat);
        }

        // Bottom actions
        const bottomBar = document.createElement('div');
        bottomBar.style.cssText = 'display:flex;gap:8px;padding:12px 0 0;flex-wrap:wrap;border-top:1px solid var(--SmartThemeBorderColor,#45475a);margin-top:8px;';
        const keepAllBtn = document.createElement('button');
        keepAllBtn.className = 'bb-maint-btn-auto menu_button';
        keepAllBtn.textContent = '全部保留';
        keepAllBtn.addEventListener('click', () => {
            withFeedback(keepAllBtn, async () => {
                const items = body.querySelectorAll('.bb-maint-issue-item');
                const actions = [...items].map(el => ({ collection: el.dataset.collection, id: el.dataset.id, op: 'keep' }));
                const res = await performMaintenance(chatId, actions);
                body.innerHTML = '<div style="text-align:center;padding:40px;opacity:0.6;">所有待维护项已保留</div>';
                // 同步更新 result.issues
                const actionIds = new Set(actions.map(a => a.id));
                result.issues = result.issues.filter(i => !actionIds.has(i.item.id));
                refreshBadges();
            }, { loadingText: '正在全部保留...', successText: '已全部保留' });
        });
        const laterBtn = document.createElement('button');
        laterBtn.className = 'bb-maint-btn-later menu_button';
        laterBtn.textContent = '稍后提醒(24h)';
        laterBtn.addEventListener('click', () => { dismissMaintenanceRemind(); close(); showToast('24小时内不再提醒', 'info'); });
        bottomBar.appendChild(keepAllBtn);
        bottomBar.appendChild(laterBtn);
        body.appendChild(bottomBar);
    }

    function renderResolved() {
        resolvedBtn.style.cssText = 'flex:1;padding:10px;border:none;background:var(--SmartThemeBlurTintColor,#2a2a3e);color:inherit;cursor:pointer;font-size:0.9em;font-weight:600;border-bottom:2px solid #fab387;';
        pendingBtn.style.cssText = 'flex:1;padding:10px;border:none;background:transparent;color:inherit;cursor:pointer;font-size:0.9em;opacity:0.6;border-bottom:2px solid transparent;';
        healthBtn.style.cssText = 'flex:1;padding:10px;border:none;background:transparent;color:inherit;cursor:pointer;font-size:0.9em;opacity:0.6;border-bottom:2px solid transparent;';
        body.innerHTML = '';

        const resolved = getMaintenanceResolved(chatId);
        if (!resolved.length) {
            body.innerHTML = '<div style="text-align:center;padding:40px;opacity:0.6;">暂无已维护记录</div>';
            return;
        }
        for (let i = resolved.length - 1; i >= 0; i--) {
            const entry = resolved[i];
            const d = new Date(entry.resolvedAt);
            const timeStr = d.toLocaleString();
            // 展示详细操作内容
            const r = entry.results || {};
            const parts = [];
            if (r.kept) parts.push(`保留 ${r.kept} 条`);
            if (r.deleted) parts.push(`删除 ${r.deleted} 条`);
            if (r.promoted) parts.push(`升级 ${r.promoted} 条`);
            if (r.demoted) parts.push(`降级 ${r.demoted} 条`);
            if (r.compressed) parts.push(`压缩 ${r.compressed} 条`);
            const detail = parts.length ? parts.join(' · ') : `${entry.actions || 0} 条已处理`;

            const row = document.createElement('div');
            row.style.cssText = 'display:flex;align-items:center;padding:8px 12px;border-bottom:1px solid var(--SmartThemeBorderColor,#45475a);font-size:0.85em;gap:8px;';
            row.innerHTML = `<span style="opacity:0.5;min-width:20px;">#${resolved.length - i}</span><span style="flex:1;">${escapeHtml(detail)}</span><span style="opacity:0.4;font-size:0.8em;white-space:nowrap;">${escapeHtml(timeStr)}</span>`;
            body.appendChild(row);
        }
        const clearBtn = document.createElement('button');
        clearBtn.className = 'menu_button'; clearBtn.textContent = '清空已维护'; clearBtn.style.cssText = 'margin-top:12px;';
        clearBtn.addEventListener('click', () => {
            withFeedback(clearBtn, async () => {
                clearMaintenanceResolved(chatId);
                body.innerHTML = '<div style="text-align:center;padding:40px;opacity:0.6;">已清空</div>';
            }, { successText: '已清空' });
        });
        body.appendChild(clearBtn);
    }

    async function renderHealthCheck() {
        pendingBtn.style.cssText = 'flex:1;padding:10px;border:none;background:transparent;color:inherit;cursor:pointer;font-size:0.9em;opacity:0.6;border-bottom:2px solid transparent;';
        resolvedBtn.style.cssText = 'flex:1;padding:10px;border:none;background:transparent;color:inherit;cursor:pointer;font-size:0.9em;opacity:0.6;border-bottom:2px solid transparent;';
        healthBtn.style.cssText = 'flex:1;padding:10px;border:none;background:var(--SmartThemeBlurTintColor,#2a2a3e);color:inherit;cursor:pointer;font-size:0.9em;font-weight:600;border-bottom:2px solid #a6e3a1;';

        body.innerHTML = '<div style="text-align:center;padding:40px;"><i class="fa-solid fa-spinner fa-spin" style="font-size:2em;"></i><p style="margin-top:12px;opacity:0.6;">正在体检...</p></div>';

        try {
            const healthResult = await runHealthCheck(chatId);
            body.innerHTML = '';
            body.appendChild(buildHealthCheckPanel(chatId, healthResult, {
                onRefresh: renderHealthCheck,
                onAction: () => { /* 操作后无需刷新面板，单项操作后条目已移除 */ },
            }));
        } catch (e) {
            body.innerHTML = `<div style="text-align:center;padding:40px;opacity:0.6;color:#f44338;">
                <i class="fa-solid fa-circle-exclamation" style="font-size:2em;"></i>
                <p style="margin-top:12px;">体检异常: ${escapeHtml(e.message)}</p>
            </div>`;
        }
    }

    pendingBtn.addEventListener('click', renderPending);
    resolvedBtn.addEventListener('click', renderResolved);
    healthBtn.addEventListener('click', renderHealthCheck);
    renderPending();
}

// ═══════════════════════════════════════════════════════════
//  斜杠命令
// ═══════════════════════════════════════════════════════════

function registerSlashCommands() {
    const ctx = SillyTavern.getContext();
    const addCmd = (name, callback, helpText) => {
        try {
            if (typeof ctx.SlashCommandParser?.addCommandObject === 'function') {
                ctx.SlashCommandParser.addCommandObject({
                    name, callback,
                    aliases: [],
                    helpText: helpText || '',
                    returns: '',
                });
            } else if (typeof ctx.registerSlashCommand === 'function') {
                ctx.registerSlashCommand(name, callback, [], helpText);
            }
        } catch (e) {
            console.warn(`[BB-Memory] 注册命令 ${name} 失败:`, e.message);
        }
    };

    addCmd('bb-init', async (args) => {
        const chatId = getChatId();
        if (!chatId) { showToast('请先进入角色对话', 'warning'); return; }
        // 支持参数传楼层范围，如 /bb-init 0-10；无参数则弹窗
        const range = (args && args.trim()) ? args.trim() : await promptFloorRange();
        if (range === '') return;
        try {
            const results = await handleInitMemory(chatId, range);
            showToast(`初始化：NPC${results.npc}/物品${results.items}/时间线${results.timeline}/记忆${results.memories}`, 'success');
        } catch (e) {
            showToast(`初始化失败: ${e.message}`, 'error');
        }
    }, '初始化 BB-Memory 记忆（可选参数: 楼层范围如 0-10）');

    addCmd('bb-backup', async () => {
        const chatId = getChatId();
        if (!chatId) return;
        const result = await exportMemoriesToChatMetadata(chatId);
        showToast(`备份完成：${result.count} 条 (${(result.size/1024).toFixed(1)}KB)`, 'success');
    }, '手动备份记忆到服务器');

    addCmd('bb-restore', async () => {
        const chatId = getChatId();
        if (!chatId) return;
        const result = await importMemoriesFromChatMetadata(chatId);
        showToast(`恢复：${result.restored} 新增，${result.skipped} 跳过`, 'success');
    }, '从服务器恢复记忆');

    addCmd('bb-stats', async () => {
        const chatId = getChatId();
        if (!chatId) return;
        const stats = await getMemoryStats(chatId);
        const msg = `BB-Memory 统计：\nNPC: ${stats.npc.total} | 物品: ${stats.items.total} | 时间线: ${stats.timeline.total} | 记忆: ${stats.memories.total}`;
        showToast(msg, 'info');
    }, '查看记忆统计');

    addCmd('bb-manage', () => {
        const chatId = getChatId();
        if (!chatId) return;
        openAssistant(chatId, 'dashboard');
    }, '打开记忆管家面板');

    addCmd('bb-maintenance', async () => {
        const chatId = getChatId();
        if (!chatId) return;
        try {
            const result = await checkMaintenanceNeeded(chatId);
            showMaintenancePopup(chatId, result);
        } catch (e) {
            console.warn('[BB-Memory] 维护检查异常:', e.message);
            showToast('维护检查出错: ' + e.message, 'error');
            showMaintenancePopup(chatId, { issues: [], issueCount: 0, totalItems: 0, needed: false });
        }
    }, '打开记忆维护面板');

    addCmd('bb-clear', async () => {
        const chatId = getChatId();
        if (!chatId) return;
        const confirmed = await new Promise(resolve => {
            if (typeof ctx.callPopup === 'function') {
                ctx.callPopup('[BB-Memory] 确定要清空所有记忆数据吗？此操作不可恢复。', 'confirm').then(r => resolve(r));
            } else {
                resolve(confirm('确定要清空所有记忆数据吗？'));
            }
        });
        if (confirmed) {
            await clearAllData(chatId);
            showToast('所有记忆已清空', 'warning');
        }
    }, '清空当前聊天的所有记忆');

    addCmd('bb-delete-floor', async (args) => {
        const chatId = getChatId();
        if (!chatId) { showToast('请先进入角色对话', 'warning'); return; }
        const floor = parseInt(args, 10);
        if (isNaN(floor)) { showToast('用法: /bb-delete-floor <楼层号>', 'warning'); return; }
        // 查找该楼层 AI 消息的 exchange hash
        const ctx2 = SillyTavern.getContext();
        const chat = ctx2.chat || [];
        if (floor < 0 || floor >= chat.length) { showToast(`楼层 ${floor} 不存在`, 'warning'); return; }
        const msg = chat[floor];
        if (!msg || msg.is_user) { showToast(`第 ${floor} 层不是AI消息`, 'warning'); return; }
        // 查找前一条用户消息，计算 exchange hash
        let userMsg = '';
        for (let j = floor - 1; j >= 0; j--) {
            if (chat[j].is_user && chat[j].mes) { userMsg = chat[j].mes; break; }
        }
        const { computeExchangeHash, unmarkExchangeProcessed, refreshExtractionMarkers } = await import('./message-state.js');
        const exchangeHash = computeExchangeHash(userMsg, msg.mes || '');
        const result = await deleteByExchange(chatId, exchangeHash);
        await unmarkExchangeProcessed(chatId, exchangeHash);
        msg._bbmem_extracted = false;
        msg._bbmem_skipped = false;
        msg._bbmem_pendingExtraction = true;
        try { ctx2.saveChatDebounced(); } catch {}
        refreshExtractionMarkers();
        showToast(`已删除: NPC${result.npc}/物品${result.items}/时间线${result.timeline}/记忆${result.memories}`, 'success');
    }, '删除指定楼层的所有关联记忆');

    addCmd('bb-re-extract', async (args) => {
        const chatId = getChatId();
        if (!chatId) { showToast('请先进入角色对话', 'warning'); return; }
        const floor = parseInt(args, 10);
        if (isNaN(floor)) { showToast('用法: /bb-re-extract <楼层号>', 'warning'); return; }
        const ctx2 = SillyTavern.getContext();
        const chat = ctx2.chat || [];
        if (floor < 0 || floor >= chat.length) { showToast(`楼层 ${floor} 不存在`, 'warning'); return; }
        const aiMsg = chat[floor];
        if (!aiMsg || aiMsg.is_user) { showToast(`第 ${floor} 层不是AI消息`, 'warning'); return; }
        // 向前查找用户消息配对
        let userMsg = '';
        for (let j = floor - 1; j >= 0; j--) {
            if (chat[j].is_user && chat[j].mes) { userMsg = chat[j].mes; break; }
        }
        // 先删除旧记忆，再重新提取
        const { computeExchangeHash } = await import('./message-state.js');
        const exchangeHash = computeExchangeHash(userMsg, aiMsg.mes || '');
        await deleteByExchange(chatId, exchangeHash);
        await unmarkExchangeProcessed(chatId, exchangeHash); // v6.1.6
        // 清除提取标记以便重新提取
        aiMsg._bbmem_extracted = false;
        aiMsg._bbmem_pendingExtraction = true;
        try { ctx2.saveChatDebounced(); } catch {}
        // 触发提取
        showToast('正在重新提取...', 'info');
        const { onMessageReceived } = await import('./auto-generator.js');
        onMessageReceived(floor);
    }, '删除并重新提取指定楼层的记忆');

    addCmd('bb-floor-refresh', async () => {
        const chatId = getChatId();
        if (!chatId) { showToast('请先进入角色对话', 'warning'); return; }
        const stats = await refreshAllSourceFloors(chatId);
        const total = stats.npc + stats.items + stats.timeline + stats.memories;
        if (total === 0) {
            showToast('当前没有需要刷新的楼层记忆（所有记忆已标记为旧聊天来源）', 'info');
        } else {
            showToast(`楼层刷新完成！已标记 ${total} 条记忆为旧聊天来源（NPC:${stats.npc} 物品:${stats.items} 时间线:${stats.timeline} 记忆:${stats.memories}）`, 'success');
        }
    }, '换楼刷新 — 将所有记忆的楼层标记为旧聊天来源（开新聊天后使用）');

    addCmd('bb-clue', async () => {
        const chatId = getChatId();
        if (!chatId) { showToast('请先进入角色对话', 'warning'); return; }
        const { openClueBoard } = await import('./clue-board.js');
        openClueBoard(chatId);
    }, '打开线索板 — 追踪线索、创建连线推理');

    addCmd('bb-agent', async () => {
        const chatId = getChatId();
        if (!chatId) { showToast('请先进入角色对话', 'warning'); return; }
        const { openAgent } = await import('./memory-agent.js');
        openAgent(chatId);
    }, '打开记忆管家 Agent — 用自然语言管理记忆');

    if (getSettings().debugLogging) {
        console.log('[BB-Memory] 斜杠命令已注册');
    }
}

// ═══════════════════════════════════════════════════════════
//  事件处理
// ═══════════════════════════════════════════════════════════

async function onChatChanged() {
    clearInjection();
    lastRetrievalResult = null;

    const chatId = getChatId();
    if (!chatId) return;

    const settings = getSettings();

    // 迁移检查
    if (!settings.migratedFromV4) {
        try { await migrateV4ToV5(chatId); } catch { /* ignore */ }
    }

    // 可见性同步
    setTimeout(() => {
        syncMessageVisibility().catch(() => {});
        refreshExtractionMarkers();
    }, 800);

    // v7.8.0 加载 per-chat 日历描述到 UI
    (async () => {
        const calTextarea = document.querySelector('#bb_calendar_description');
        if (calTextarea) {
            const val = await getCalendarDescription(chatId);
            calTextarea.value = val || '';
        }
    })();

    // 维护提醒（3秒后）
    setTimeout(async () => {
        try {
            const result = await checkMaintenanceNeeded(chatId);
            if (result.needed) {
                showToast(`记忆维护提醒：${result.issueCount} 条待处理。输入 /bb-maintenance 查看`, 'warning');
            }
        } catch { /* ignore */ }
    }, 3000);

    // 跨设备恢复（5秒后）
    if (settings.autoBackupEnabled) {
        setTimeout(async () => {
            try {
                const result = await importMemoriesFromChatMetadata(chatId);
                if (result.restored > 0 && settings.debugLogging) {
                    console.log(`[BB-Memory] 自动恢复: ${result.restored} 条`);
                }
            } catch { /* ignore */ }
        }, 5000);
    }
}

function onNewMessage() {
    if (!getSettings().autoGenEnabled) {
        syncMessageVisibility().catch(() => {});
    }
    setTimeout(() => refreshExtractionMarkers(), 300);
}

// ═══════════════════════════════════════════════════════════
//  悬浮球 (Floating Action Hub) —— v4.4.2 移植
// ═══════════════════════════════════════════════════════════

function renderHubHitItem(h, typeIcons, levelColors, dimmed) {
    const icon = typeIcons[h.cognitiveType] || 'fa-circle';
    const color = levelColors[h.level] || '#888';
    const scorePct = Math.round(h.score * 100);
    const shortTitle = (h.title || '').length > 14
        ? escapeHtml(h.title.slice(0, 14)) + '...'
        : escapeHtml(h.title);
    const opacityStyle = dimmed ? 'opacity:0.55;' : '';
    return `<div class="bb-hub-hit-item" title="${escapeHtml(h.title)}" style="${opacityStyle}">
        <i class="fa-solid ${icon}" style="color:${color};font-size:0.7em;"></i>
        <span class="bb-hub-hit-title">${shortTitle}</span>
        <span class="bb-hub-hit-level" style="color:${color}">${h.level}</span>
        <span class="bb-hub-hit-score">${scorePct}%</span>
    </div>`;
}

async function renderHubHitList(listEl, chatId) {
    const result = lastRetrievalResult;
    const typeIcons = { fact: 'fa-lightbulb', episode: 'fa-film', emotion: 'fa-heart', habit: 'fa-repeat' };
    const levelColors = { L4: '#ce93d8', L3: '#4fc3f7', L2: '#ffb74d', L1: '#9e9e9e' };

    if (!result || !result.hits || !result.hits.length) {
        listEl.innerHTML = '<div class="bb-hub-hit-item" style="opacity:0.5;justify-content:center;">暂无命中记忆</div>';
        return;
    }

    listEl.innerHTML = result.hits.map(h => renderHubHitItem(h, typeIcons, levelColors, false)).join('');
}

function injectFloatingHub() {
    if (document.getElementById('bb_floating_hub')) return;

    const hub = document.createElement('div');
    hub.id = 'bb_floating_hub';
    hub.className = 'bb-floating-hub';
    hub.innerHTML = '<i class="fa-solid fa-brain"></i><span class="bb-hub-badge" id="bb_hub_badge" style="display:none;">0</span>';

    // 菜单面板
    const menu = document.createElement('div');
    menu.id = 'bb_floating_menu';
    menu.className = 'bb-floating-menu';
    menu.style.display = 'none';
    menu.innerHTML = `
        <div class="bb-floating-menu-header">
            <i class="fa-solid fa-brain"></i> BB-Memory
        </div>
        <div class="bb-floating-menu-body">
            <div class="bb-floating-menu-item" id="bb_hub_slot_info">
                <i class="fa-solid fa-floppy-disk"></i>
                <span>存档: <strong>default</strong> · <strong>0</strong> 条</span>
            </div>
            <div class="bb-floating-menu-item bb-floating-menu-action" data-action="quick_save">
                <i class="fa-solid fa-floppy-disk"></i>
                <span>快速保存</span>
            </div>
            <div class="bb-floating-menu-item bb-floating-menu-action" id="bb_hub_hit_info" data-action="toggle_hit_list">
                <i class="fa-solid fa-bullseye"></i>
                <span>命中: <strong id="bb_hub_hit_count">-</strong> 条</span>
                <i class="fa-solid fa-chevron-down" style="margin-left:auto;font-size:0.7em;opacity:0.5;"></i>
            </div>
            <div id="bb_hub_hit_list" style="display:none;"></div>
            <div class="bb-floating-menu-item" id="bb_hub_extract_progress" style="display:flex;">
                <i class="fa-solid fa-moon"></i>
                <span id="bb_hub_extract_label">空闲</span>
            </div>
            <div class="bb-floating-menu-item bb-floating-menu-action" data-action="toggle_visibility">
                <i class="fa-solid fa-eye-slash"></i>
                <span>切换楼层可见</span>
            </div>
            <div class="bb-floating-menu-item bb-floating-menu-action" data-action="meta_last">
                <i class="fa-solid fa-tag"></i>
                <span>标记最后消息</span>
            </div>
            <div class="bb-floating-menu-item bb-floating-menu-action" data-action="manual_extract">
                <i class="fa-solid fa-wand-magic-sparkles"></i>
                <span>手动提取</span>
            </div>
            <div class="bb-floating-menu-item bb-floating-menu-action" id="bb_hub_retry_extract" data-action="retry_extract" style="display:none;">
                <i class="fa-solid fa-rotate-right" style="color:#ff9800;"></i>
                <span>重新提取第 <strong id="bb_hub_retry_floor">-</strong> 层</span>
            </div>
            <div class="bb-floating-menu-item bb-floating-menu-action" data-action="open_maintenance">
                <i class="fa-solid fa-toolbox"></i>
                <span>记忆维护</span>
            </div>
            <div class="bb-floating-menu-item bb-floating-menu-action" data-action="open_clue_board">
                <i class="fa-solid fa-magnifying-glass"></i>
                <span>线索板</span>
            </div>
            <div class="bb-floating-menu-item bb-floating-menu-action" data-action="open_agent">
                <i class="fa-solid fa-robot"></i>
                <span>记忆管家</span>
            </div>
            <div class="bb-floating-menu-item bb-floating-menu-action" data-action="open_manager">
                <i class="fa-solid fa-gear"></i>
                <span>记忆管理</span>
            </div>
        </div>
    `;

    hub.appendChild(menu);
    document.body.appendChild(hub);

    // 拖拽逻辑
    let dragging = false;
    let startX = 0, startY = 0, startLeft = 0, startTop = 0;
    let hasMoved = false;

    hub.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        dragging = true;
        hasMoved = false;
        startX = e.clientX;
        startY = e.clientY;
        const rect = hub.getBoundingClientRect();
        startLeft = rect.left;
        startTop = rect.top;
        hub.style.transition = 'none';
        e.preventDefault();
    });

    hub.addEventListener('touchstart', (e) => {
        dragging = true;
        hasMoved = false;
        const t = e.touches[0];
        startX = t.clientX;
        startY = t.clientY;
        const rect = hub.getBoundingClientRect();
        startLeft = rect.left;
        startTop = rect.top;
        hub.style.transition = 'none';
    }, { passive: false });

    document.addEventListener('mousemove', (e) => {
        if (!dragging) return;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        if (Math.abs(dx) > 3 || Math.abs(dy) > 3) hasMoved = true;
        let newLeft = startLeft + dx;
        let newTop = startTop + dy;
        newLeft = Math.max(0, Math.min(window.innerWidth - hub.offsetWidth, newLeft));
        newTop = Math.max(0, Math.min(window.innerHeight - hub.offsetHeight, newTop));
        hub.style.left = newLeft + 'px';
        hub.style.top = newTop + 'px';
    });

    document.addEventListener('touchmove', (e) => {
        if (!dragging) return;
        const t = e.touches[0];
        const dx = t.clientX - startX;
        const dy = t.clientY - startY;
        if (Math.abs(dx) > 3 || Math.abs(dy) > 3) hasMoved = true;
        let newLeft = startLeft + dx;
        let newTop = startTop + dy;
        newLeft = Math.max(0, Math.min(window.innerWidth - hub.offsetWidth, newLeft));
        newTop = Math.max(0, Math.min(window.innerHeight - hub.offsetHeight, newTop));
        hub.style.left = newLeft + 'px';
        hub.style.top = newTop + 'px';
    }, { passive: false });

    const endDrag = () => {
        dragging = false;
        hub.style.transition = '';
    };
    document.addEventListener('mouseup', endDrag);
    document.addEventListener('touchend', endDrag);

    // 点击展开菜单
    hub.addEventListener('click', (e) => {
        if (hasMoved) { e.preventDefault(); e.stopPropagation(); return; }
        if (menu.contains(e.target)) return;
        toggleFloatingMenu();
    });

    // 菜单项点击
    menu.addEventListener('click', async (e) => {
        const actionItem = e.target.closest('.bb-floating-menu-action');
        if (!actionItem) return;
        const action = actionItem.dataset.action;
        await handleFloatingMenuAction(action);
        if (action !== 'toggle_hit_list' && action !== 'toggle_visibility') {
            menu.style.display = 'none';
        }
    });

    // 点击其他区域关闭菜单
    document.addEventListener('click', (e) => {
        if (!menu.contains(e.target) && e.target !== hub && !hub.contains(e.target)) {
            menu.style.display = 'none';
        }
    });

    // 定期更新
    setInterval(() => refreshFloatingHubData(), 5000);
}

let floatingMenuVisible = false;
function toggleFloatingMenu() {
    const menu = document.getElementById('bb_floating_menu');
    const hub = document.getElementById('bb_floating_hub');
    if (!menu || !hub) return;
    floatingMenuVisible = !floatingMenuVisible;
    if (floatingMenuVisible) {
        const hubRect = hub.getBoundingClientRect();
        const menuWidth = 268;
        const menuMaxHeight = 320;
        const gap = 56;
        const edgeMargin = 16;

        if (hubRect.right + menuWidth > window.innerWidth - edgeMargin) {
            menu.style.left = 'auto';
            menu.style.right = '0';
        } else {
            menu.style.right = 'auto';
            menu.style.left = '0';
        }

        if (hubRect.top - menuMaxHeight - gap < edgeMargin) {
            menu.style.bottom = 'auto';
            menu.style.top = gap + 'px';
        } else {
            menu.style.top = 'auto';
            menu.style.bottom = gap + 'px';
        }

        menu.style.display = 'block';
        refreshFloatingHubData();
    } else {
        menu.style.display = 'none';
    }
}

async function refreshFloatingHubData() {
    const hitCountEl = document.getElementById('bb_hub_hit_count');
    if (hitCountEl) {
        // v8.2.3 显示当次检索实时命中数，而非历史累积 hitCount
        const r = lastRetrievalResult;
        if (r && r.timestamp) {
            const tlCount = (r.timelineHits?.ongoing?.length || 0) + (r.timelineHits?.ended?.length || 0);
            const total = (r.hits?.length || 0) + (r.npcHits?.length || 0) + (r.itemHits?.length || 0) + tlCount;
            hitCountEl.textContent = String(total);
        } else {
            hitCountEl.textContent = '-';
        }
    }
    // v8.2.1 提取失败重试按钮 & 进度文字
    const retryItem = document.getElementById('bb_hub_retry_extract');
    const retryFloor = document.getElementById('bb_hub_retry_floor');
    const extractLabel = document.getElementById('bb_hub_extract_label');
    // 需要动态 import 获取最新 lastExtractFailedFloor 值
    try {
        const { lastExtractFailedFloor: failedFloor } = await import('./auto-generator.js');
        if (retryItem && retryFloor) {
            if (failedFloor !== null && failedFloor !== undefined) {
                retryItem.style.display = 'flex';
                retryFloor.textContent = String(failedFloor);
            } else {
                retryItem.style.display = 'none';
            }
        }
        if (extractLabel) {
            extractLabel.textContent = (failedFloor !== null && failedFloor !== undefined)
                ? `提取失败: 第${failedFloor}层`
                : '空闲';
        }
    } catch { /* ignore */ }

    // v7.9.0 红点角标由提取失败控制，此处不做更新

    // 更新存档信息
    const slotInfo = document.getElementById('bb_hub_slot_info');
    if (slotInfo) {
        try {
            const chatId = getChatId();
            if (chatId) {
                const mems = await getMemories(chatId);
                const settings = getSettings();
                const slotName = settings.currentSlotName || 'default';
                slotInfo.innerHTML = `<i class="fa-solid fa-floppy-disk"></i> <span>存档: <strong>${escapeHtml(slotName)}</strong> · <strong>${mems.length}</strong> 条</span>`;
            }
        } catch { /* ignore */ }
    }

    // 更新可见性按钮图标（三态）
    const toggleItem = document.querySelector('.bb-floating-menu-action[data-action="toggle_visibility"] i');
    if (toggleItem) {
        const mode = getSettings().extractedMsgDisplay || 'hidden';
        if (mode === 'visible') toggleItem.className = 'fa-solid fa-eye';
        else if (mode === 'transparent') toggleItem.className = 'fa-solid fa-eye';
        else toggleItem.className = 'fa-solid fa-eye-slash';
    }

    // 命中列表展开时同步刷新
    const hitList = document.getElementById('bb_hub_hit_list');
    if (hitList && hitList.style.display !== 'none') {
        const chatId = getChatId();
        if (chatId) renderHubHitList(hitList, chatId);
    }
}

function cycleExtractedVisibility() {
    const settings = getSettings();
    const current = settings.extractedMsgDisplay || 'hidden';
    const next = current === 'hidden' ? 'transparent' : current === 'transparent' ? 'visible' : 'hidden';

    // 更新设置
    updateSettings({ extractedMsgDisplay: next });

    // 刷新 DOM 标记以应用新模式
    refreshExtractionMarkers();

    // 更新悬浮球图标
    const toggleItem = document.querySelector('.bb-floating-menu-action[data-action="toggle_visibility"] i');
    if (toggleItem) {
        toggleItem.className = next === 'hidden' ? 'fa-solid fa-eye-slash' : 'fa-solid fa-eye';
    }

    const labels = { hidden: '楼层已隐藏', transparent: '楼层半透明显示（可区分）', visible: '楼层完全可见' };
    showToast(labels[next], 'info');
}

async function handleFloatingMenuAction(action) {
    const chatId = getChatId();
    switch (action) {
        case 'toggle_visibility': {
            cycleExtractedVisibility();
            return;  // 不关闭菜单
        }
        case 'meta_last': {
            const ctx = SillyTavern.getContext();
            const chat = ctx.chat;
            if (!chat || chat.length < 2) {
                showToast('聊天消息不足', 'warning');
                return;
            }
            let aiIdx = -1;
            for (let i = chat.length - 1; i >= 0; i--) {
                if (!chat[i].is_user && !chat[i].is_system) { aiIdx = i; break; }
            }
            if (aiIdx === -1) { showToast('未找到 AI 消息', 'warning'); return; }
            chat[aiIdx]._bbmem_meta_marker = !chat[aiIdx]._bbmem_meta_marker;
            if (!chat[aiIdx]._bbmem_meta_marker) {
                // 取消元标记：恢复消息为待提取状态
                chat[aiIdx].is_hidden = false;
                chat[aiIdx]._bbmem_hideSource = undefined;
                chat[aiIdx]._bbmem_pendingExtraction = true;
                chat[aiIdx]._bbmem_extracted = false;
            }
            try { ctx.saveChatDebounced(); } catch {}
            setTimeout(() => refreshExtractionMarkers(), 100);
            const label = chat[aiIdx]._bbmem_meta_marker ? '🤖 已标记为元指令（不提取）' : '🗃️ 已标记为可提取';
            showToast(label, 'info');
            break;
        }
        case 'manual_extract': {
            if (!chatId) return;
            const menu = document.getElementById('bb_floating_menu');
            if (menu) { menu.style.display = 'none'; floatingMenuVisible = false; }
            const range = await promptFloorRange();
            if (range === '') return;
            showToast('正在提取记忆...', 'info');
            try {
                const results = await handleInitMemory(chatId, range);
                showToast(`提取完成！NPC ${results.npc} / 物品 ${results.items} / 时间线 ${results.timeline} / 记忆 ${results.memories}`, 'success');
                refreshSidebar();
            } catch (e) {
                showToast(`提取失败: ${e.message}`, 'error');
            }
            break;
        }
        // v8.2.1 重新提取失败楼层
        case 'retry_extract': {
            if (!chatId) return;
            try {
                const { lastExtractFailedFloor: floor, clearLastExtractFailedFloor: clear } = await import('./auto-generator.js');
                if (floor !== null && floor !== undefined) {
                    const ctx = SillyTavern.getContext();
                    const chat = ctx.chat;
                    if (chat && chat[floor]) {
                        chat[floor]._bbmem_extracted = false;
                        chat[floor]._bbmem_skipped = false;
                        chat[floor]._bbmem_pendingExtraction = true;
                    }
                    clear();
                    showToast(`正在重新提取第 ${floor} 层...`, 'info');
                    const { onMessageReceived } = await import('./auto-generator.js');
                    await onMessageReceived(floor);
                    showToast(`第 ${floor} 层重新提取完成`, 'success');
                }
            } catch (e) {
                showToast(`重新提取失败: ${e.message}`, 'error');
            }
            break;
        }
        case 'open_clue_board': {
            if (chatId) {
                import('./clue-board.js').then(m => m.openClueBoard(chatId));
            }
            break;
        }
        case 'open_agent': {
            if (chatId) {
                import('./memory-agent.js').then(m => m.openAgent(chatId));
            }
            break;
        }
        case 'open_manager': {
            if (chatId) openMemoryManager(chatId);
            break;
        }
        case 'quick_save': {
            if (!chatId) return;
            try {
                const charId = getCharacterId();
                if (!charId) { showTopNotification('无法获取角色ID', 'error'); break; }
                const slotName = getSettings().currentSlotName || 'default';
                const result = await saveToSlot(charId, chatId, slotName);
                const count = typeof result === 'object' ? result.count : result;
                showTopNotification(`已保存 ${count} 条到「${slotName}」`, 'success');
                setTimeout(() => refreshFloatingHubData(), 300);
            } catch (e) {
                showTopNotification(`快速保存失败: ${e.message}`, 'error');
            }
            break;
        }
        case 'open_maintenance': {
            if (!chatId) return;
            try {
                const result = await checkMaintenanceNeeded(chatId);
                showMaintenancePopup(chatId, result);
            } catch (e) {
                console.warn('[BB-Memory] 维护检查异常:', e.message);
                showMaintenancePopup(chatId, { issues: [], issueCount: 0, totalItems: 0, needed: false });
            }
            break;
        }
        case 'toggle_hit_list': {
            const hitList = document.getElementById('bb_hub_hit_list');
            const hitRow = document.getElementById('bb_hub_hit_info');
            if (!hitList || !hitRow) return;
            const chevron = hitRow.querySelector('.fa-chevron-down, .fa-chevron-up');
            if (hitList.style.display === 'none') {
                renderHubHitList(hitList, chatId);
                hitList.style.display = '';
                if (chevron) {
                    chevron.className = 'fa-solid fa-chevron-up';
                    chevron.style.cssText = 'margin-left:auto;font-size:0.7em;opacity:0.5;';
                }
            } else {
                hitList.style.display = 'none';
                if (chevron) {
                    chevron.className = 'fa-solid fa-chevron-down';
                    chevron.style.cssText = 'margin-left:auto;font-size:0.7em;opacity:0.5;';
                }
            }
            return;
        }
    }
}

// ═══════════════════════════════════════════════════════════
//  初始化
// ═══════════════════════════════════════════════════════════

async function init() {
    console.log('[BB-Memory] v8.4.1 初始化开始...');

    // 确保默认设置
    getSettings();

    // 挂载设置面板
    try {
        const folder = getExtensionFolder();
        const ctx = SillyTavern.getContext();
        if (typeof ctx.renderExtensionTemplateAsync === 'function') {
            const html = await Promise.race([
                ctx.renderExtensionTemplateAsync(folder, 'settings'),
                new Promise((_, reject) => setTimeout(() => reject(new Error('模板加载超时(8s)')), 8000))
            ]);
            await mountExtensionSettingsHtml(html);
            restoreApiSettings(getSettings());
            bindSidebarEvents();
            initCollapsibleSettings();
            settingsPanelMounted = true;
        }
    } catch (e) {
        console.warn('[BB-Memory] 设置面板挂载失败:', e.message);
    }

    // 初始化自动生成器
    if (getSettings().autoGenEnabled) {
        initAutoGenerator();
    }

    // 进度回调（同步悬浮球 + 侧边栏）
    setAutoExtractProgressCallback((info) => {
        if (getSettings().debugLogging) {
            console.log(`[BB-Memory] 提取进度: ${info.phase} ${info.current}/${info.total}${info.text ? ' - ' + info.text : ''}`);
        }
        const isDone = info.current >= info.total && info.total > 0;
        const isFailed = isDone && info.text && /失败|错误/.test(info.text);
        const label = info.text || (isDone ? '完成' : (info.phase ? (info.total > 0 ? Math.round((info.current / info.total) * 100) + '%' : '...') : ''));

        // 同步悬浮球进度 + v7.9.0 失败红点
        const hubRow = document.getElementById('bb_hub_extract_progress');
        const badge = document.getElementById('bb_hub_badge');
        if (hubRow) {
            const icon = hubRow.querySelector('i');
            const labelEl = document.getElementById('bb_hub_extract_label');
            if (isDone) {
                if (icon) {
                    icon.className = isFailed ? 'fa-solid fa-exclamation-triangle' : 'fa-solid fa-check-circle';
                    icon.style.color = isFailed ? '#f44336' : '#4caf50';
                }
                if (labelEl) labelEl.textContent = info.text || '完成';
                // 失败时显示红点
                if (badge) {
                    badge.textContent = '';
                    badge.style.display = isFailed ? 'block' : 'none';
                    badge.style.minWidth = isFailed ? '12px' : '';
                    badge.style.height = isFailed ? '12px' : '';
                    badge.style.borderRadius = isFailed ? '50%' : '';
                }
            } else if (info.phase) {
                if (icon) { icon.className = 'fa-solid fa-spinner fa-spin'; icon.style.color = ''; }
                if (labelEl) labelEl.textContent = label;
                if (badge) badge.style.display = 'none';
            } else {
                if (icon) { icon.className = 'fa-solid fa-moon'; icon.style.color = ''; }
                if (labelEl) labelEl.textContent = '空闲';
                if (badge) badge.style.display = 'none';
            }
        }

        // 同步侧边栏进度
        const sidebarRow = document.getElementById('bb_sidebar_extract_progress');
        if (sidebarRow) {
            const icon = sidebarRow.querySelector('i');
            const strong = sidebarRow.querySelector('strong');
            if (isDone) {
                if (icon) {
                    icon.className = isFailed ? 'fa-solid fa-exclamation-triangle' : 'fa-solid fa-check-circle';
                    icon.style.color = isFailed ? '#f44336' : '#4caf50';
                }
                if (strong) strong.textContent = info.text || '完成';
            } else if (info.phase) {
                if (icon) { icon.className = 'fa-solid fa-spinner fa-spin'; icon.style.color = ''; }
                if (strong) strong.textContent = label;
            } else {
                if (icon) { icon.className = 'fa-solid fa-moon'; icon.style.color = ''; }
                if (strong) strong.textContent = '空闲';
            }
        }

        // 同步维护面板进度（如有打开）
        const maintOverlay = document.querySelector('.bb-maint-overlay');
        if (maintOverlay) {
            const progressEl = maintOverlay.querySelector('.bb-maint-progress');
            if (progressEl) {
                if (isDone) {
                    progressEl.style.display = 'none';
                } else if (info.phase) {
                    progressEl.style.display = 'block';
                    const pct = info.total > 0 ? Math.round((info.current / info.total) * 100) : 0;
                    progressEl.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> ${info.text || ('提取进度: ' + info.phase + ' ' + info.current + '/' + info.total + ' (' + pct + '%)')}`;
                } else {
                    progressEl.style.display = 'none';
                }
            }
        }
    });

    // 注册命令
    registerSlashCommands();

    // 事件订阅
    try {
        const ctx = SillyTavern.getContext();
        const ev = ctx.eventSource;
        const eventTypes = ctx.eventTypes || ctx.event_types || {};

        const chatChanged = eventTypes.CHAT_CHANGED;
        if (chatChanged && ev) ev.on(chatChanged, onChatChanged);

        const msgReceived = eventTypes.MESSAGE_RECEIVED;
        if (msgReceived && ev && !getSettings().autoGenEnabled) {
            ev.on(msgReceived, onNewMessage);
        }
    } catch (e) {
        console.warn('[BB-Memory] 事件订阅失败:', e.message);
    }

    // 刷新 UI
    refreshSidebar();

    // 注入可拖拽悬浮球
    injectFloatingHub();

    // v6.1: 监听消息删除，自动清理关联记忆
    initMessageDeletionWatch();

    console.log('[BB-Memory] v8.4.1 初始化完成');
}

// v6.1: MutationObserver 监听 .mes 删除事件 → 自动清理关联记忆
function initMessageDeletionWatch() {
    const setup = () => {
        const chatArea = document.querySelector('#chat');
        if (!chatArea) {
            setTimeout(setup, 2000);
            return;
        }
        const observer = new MutationObserver((mutations) => {
            for (const m of mutations) {
                for (const node of m.removedNodes) {
                    if (node.nodeType !== 1) continue;
                    // 检查被移除的元素或其子元素中是否有带 exchange hash 的 .mes
                    const mesEls = node.classList?.contains('mes') ? [node] : [];
                    if (mesEls.length === 0 && node.querySelectorAll) {
                        node.querySelectorAll('.mes[data-bb-exchange-hash]').forEach(el => mesEls.push(el));
                    }
                    for (const mesEl of mesEls) {
                        const hash = mesEl.getAttribute('data-bb-exchange-hash');
                        if (hash) {
                            handleMessageDeletedByExchange(hash);
                        }
                    }
                }
            }
        });
        observer.observe(chatArea, { childList: true, subtree: true });
    };
    setup();
}

async function handleMessageDeletedByExchange(exchangeHash) {
    const chatId = getChatId();
    if (!chatId || !exchangeHash) return;
    try {
        const removed = await deleteByExchange(chatId, exchangeHash);
        const total = removed.npc + removed.items + removed.timeline + removed.memories;
        if (total > 0) {
            console.log(`[BB-Memory] 自动清理已删除楼层的关联记忆: NPC${removed.npc}/物品${removed.items}/时间线${removed.timeline}/记忆${removed.memories}`);
            showToast(`已自动清理 ${total} 条关联记忆`, 'info');
        }
    } catch (e) {
        console.warn('[BB-Memory] 自动清理失败:', e.message);
    }
}

function refreshSidebar() {
    // 更新侧边栏记忆计数
    const updateCount = async () => {
        const chatId = getChatId();
        if (!chatId) return;
        try {
            const stats = await getMemoryStats(chatId);
            const el = document.querySelector('#bb_memory_count');
            if (el) el.textContent = stats.memories.total;
        } catch { /* ignore */ }
    };
    updateCount();
    setInterval(updateCount, 30000); // 30秒刷新
}

function updateSidebarHitList() {
    const result = lastRetrievalResult;
    const listEl = document.getElementById('bb_sidebar_hit_list');
    const tsEl = document.getElementById('bb_hit_timestamp');
    if (!listEl) return;

    const hasAny = result && (
        (result.hits && result.hits.length) ||
        (result.npcHits && result.npcHits.length) ||
        (result.itemHits && result.itemHits.length) ||
        (result.timelineHits && (result.timelineHits.ongoing.length + result.timelineHits.ended.length))
    );

    if (!hasAny) {
        listEl.innerHTML = '<div style="opacity:0.4;text-align:center;font-size:0.8em;">暂无命中</div>';
        return;
    }

    if (tsEl) {
        const d = new Date(result.timestamp);
        tsEl.textContent = d.toLocaleTimeString();
    }

    const typeIcons = { fact: 'fa-lightbulb', episode: 'fa-film', emotion: 'fa-heart', habit: 'fa-repeat' };
    const levelColors = { L4: '#ce93d8', L3: '#4fc3f7', L2: '#ffb74d', L1: '#9e9e9e' };
    const tierColors = { core: '#ce93d8', important: '#4fc3f7', minor: '#ffb74d', background: '#9e9e9e', key: '#ce93d8', equipped: '#4fc3f7', clue: '#ffb74d', consumable: '#9e9e9e' };

    let html = '';

    // NPC 命中
    if (result.npcHits && result.npcHits.length) {
        html += `<div class="bb-hit-section-label"><i class="fa-solid fa-user"></i> NPC <span style="font-size:0.75em;opacity:0.6;">${result.npcHits.length}条</span></div>`;
        html += result.npcHits.map(n => {
            const color = tierColors[n.npcTier] || '#888';
            return `<div class="bb-hub-hit-item" title="${escapeHtml(n.name)}" style="cursor:default;">
                <i class="fa-solid fa-user" style="color:${color};font-size:0.7em;"></i>
                <span class="bb-hub-hit-title">${escapeHtml(n.name)}</span>
                <span class="bb-hub-hit-level" style="color:${color}">${n.npcTier || ''}</span>
            </div>`;
        }).join('');
    }

    // 物品命中
    if (result.itemHits && result.itemHits.length) {
        html += `<div class="bb-hit-section-label"><i class="fa-solid fa-box"></i> 物品 <span style="font-size:0.75em;opacity:0.6;">${result.itemHits.length}条</span></div>`;
        html += result.itemHits.map(i => {
            const color = tierColors[i.itemTier] || '#888';
            return `<div class="bb-hub-hit-item" title="${escapeHtml(i.name)}" style="cursor:default;">
                <i class="fa-solid fa-box" style="color:${color};font-size:0.7em;"></i>
                <span class="bb-hub-hit-title">${escapeHtml(i.name)}</span>
                <span class="bb-hub-hit-level" style="color:${color}">${i.itemTier || ''}</span>
            </div>`;
        }).join('');
    }

    // 时间线命中
    if (result.timelineHits) {
        const tlAll = [...(result.timelineHits.ongoing || []), ...(result.timelineHits.ended || [])];
        if (tlAll.length) {
            html += `<div class="bb-hit-section-label"><i class="fa-solid fa-timeline"></i> 时间线 <span style="font-size:0.75em;opacity:0.6;">${tlAll.length}条</span></div>`;
            html += tlAll.map(t => {
                const isOngoing = t.status === 'ongoing';
                const color = isOngoing ? '#4fc3f7' : '#9e9e9e';
                return `<div class="bb-hub-hit-item" title="${escapeHtml(t.title)}" style="cursor:default;">
                    <i class="fa-solid ${isOngoing ? 'fa-play' : 'fa-check'}" style="color:${color};font-size:0.7em;"></i>
                    <span class="bb-hub-hit-title">${escapeHtml((t.title || '').length > 18 ? t.title.slice(0, 18) + '...' : (t.title || ''))}</span>
                    <span class="bb-hub-hit-level" style="color:${color}">${isOngoing ? '进行中' : '已结束'}</span>
                </div>`;
            }).join('');
        }
    }

    // 记忆命中
    if (result.hits && result.hits.length) {
        html += `<div class="bb-hit-section-label"><i class="fa-solid fa-brain"></i> 记忆 <span style="font-size:0.75em;opacity:0.6;">${result.hits.length}条</span></div>`;
        html += result.hits.map(h => {
            const icon = typeIcons[h.cognitiveType] || 'fa-circle';
            const color = levelColors[h.level] || '#888';
            const scorePct = Math.round(h.score * 100);
            const shortTitle = (h.title || '').length > 18
                ? escapeHtml(h.title.slice(0, 18)) + '...'
                : escapeHtml(h.title);
            return `<div class="bb-hub-hit-item" title="${escapeHtml(h.title)}" style="cursor:default;">
                <i class="fa-solid ${icon}" style="color:${color};font-size:0.7em;"></i>
                <span class="bb-hub-hit-title">${shortTitle}</span>
                <span class="bb-hub-hit-level" style="color:${color}">${h.level}</span>
                <span class="bb-hub-hit-score">${scorePct}%</span>
            </div>`;
        }).join('');
    }

    listEl.innerHTML = html;
}

// ═══════════════════════════════════════════════════════════
//  全局 API（调试/控制台用）
// ═══════════════════════════════════════════════════════════

globalThis.bbMemoryExpandEntityKeyword = function (keyword, limit = 12) {
    // v5 兼容 API
    return expandMemoriesForEntityKeyword([], keyword, { limit });
};

globalThis.bbMemoryDebug = {
    getMemoryStats,
    getNpcProfiles,
    getItems,
    getTimeline,
    getMemories,
    lastRetrievalResult: () => lastRetrievalResult,
};

// ═══ 启动 ═══
let _bbInitCalled = false;
async function initOnce() {
    if (_bbInitCalled) return;
    _bbInitCalled = true;
    await init();
}

// v8.4.1: 兜底定时器，确保即使 APP_READY 未触发也能初始化
const FALLBACK_DELAY_MS = 10000;

try {
    const ctx = SillyTavern.getContext();
    const evType = ctx.eventTypes?.APP_READY || ctx.event_types?.APP_READY;
    if (evType && ctx.eventSource) {
        ctx.eventSource.once(evType, initOnce);
        // 兜底：如果 APP_READY 10 秒后仍未触发，直接初始化
        setTimeout(() => {
            if (!_bbInitCalled) {
                console.warn('[BB-Memory] APP_READY 超时(' + FALLBACK_DELAY_MS/1000 + 's)，使用兜底初始化');
                initOnce();
            }
        }, FALLBACK_DELAY_MS);
    } else {
        // 降级：DOM ready 后初始化
        if (document.readyState === 'complete') initOnce();
        else window.addEventListener('load', initOnce);
    }
} catch (e) {
    console.error('[BB-Memory] 启动失败:', e);
    if (document.readyState === 'complete') initOnce();
    else window.addEventListener('load', initOnce);
}

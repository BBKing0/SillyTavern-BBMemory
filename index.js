/**
 * index.js —— BB-Memory v5.0 主入口
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
    getMemories, addMemory, updateMemory, removeMemory,
    clearAllData, getMemoryStats,
    exportMemoriesToChatMetadata, importMemoriesFromChatMetadata,
    migrateV4ToV5, recordHits, checkDemotions,
    exportMemories, importMemories, updateFactContent, addHiddenNote, removeHiddenNote,
    scheduleAutoBackup, extractKeywords,
} from './memory-store.js';

import {
    getRelevantMemories, getResidentMemories, buildMemoryInjectionPrompt,
    mergeExpandedRelevantResults, simpleSearch, searchMemories,
    getNpcForInjection, getItemsForInjection, getTimelineForInjection,
} from './retriever.js';

import { MEMORY_TYPES, TRUTH_STATUS, HIDDEN_NOTE_TYPES } from './memory-types.js';
import { NPC_TIERS, ITEM_TIERS, expandMemoriesForEntityKeyword } from './entity-tiers.js';

import {
    initAutoGenerator, stopAutoGenerator, extractFromContext, saveExtractedMemories,
    setAutoExtractProgressCallback, getPendingAutoCandidates, clearPendingAutoCandidates,
    callEmbeddingApi, embedExistingMemories,
} from './auto-generator.js';

import {
    syncMessageVisibility, refreshExtractionMarkers,
    markExchangeExtracted, hideExchange,
} from './message-state.js';

import {
    MEMORY_STATUS, checkMaintenanceNeeded, dismissMaintenanceRemind,
    performMaintenance, buildMaintenanceHTML,
    fuzzyMemory, archiveMemory, restoreMemory, autoMaintain,
    generateTimelineSummary,
} from './memory-maintainer.js';

import { openAssistant } from './memory-assistant.js';

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

    // 1. 提取最后一条用户消息
    let userMessage = '';
    for (let i = chat.length - 1; i >= 0; i--) {
        if (chat[i].is_user && chat[i].mes?.trim()) {
            userMessage = chat[i].mes.trim();
            break;
        }
    }
    if (!userMessage) { clearInjection(); return chat; }

    // 2. 上下文隐藏安全网
    for (const msg of chat) {
        if ((msg._bbmem_extracted || msg._bbmem_hideSource === 'plugin') && !msg.is_hidden) {
            msg.is_hidden = true;
            msg._bbmem_hideSource = 'plugin';
        }
    }

    // 3. 迁移检查
    if (!settings.migratedFromV4) {
        try { await migrateV4ToV5(chatId); } catch (e) { /* ignore */ }
    }

    // 4. 加载数据
    const [npc, items, timeline, memories] = await Promise.all([
        getNpcProfiles(chatId), getItems(chatId), getTimeline(chatId), getMemories(chatId),
    ]);

    const hasData = npc.length + items.length + timeline.length + memories.length > 0;
    if (!hasData) { clearInjection(); return chat; }

    // 5. 降格检查
    try { await checkDemotions(chatId); } catch (e) { /* ignore */ }

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
    const residentMems = getResidentMemories(memories);
    const relevantResults = getRelevantMemories(memories, userMessage, {
        maxResults: settings.maxResults || 10,
        queryEmbedding,
    });
    const excludeIds = new Set([...npcForInjection.map(n => n.id), ...residentMems.map(m => m.id)]);
    for (const r of relevantResults) excludeIds.add(r.memory.id);
    const merged = mergeExpandedRelevantResults(memories, userMessage, relevantResults, excludeIds, 12, settings.maxResults, queryEmbedding);

    if (!npcForInjection.length && !itemsForInjection.length &&
        !tlForInjection.ongoing.length && !tlForInjection.ended.length && !merged.length) {
        clearInjection(); return chat;
    }

    // 8. 记录命中
    const hitRecords = [];
    for (const n of npcForInjection) hitRecords.push({ collection: 'npc', id: n.id });
    for (const i of itemsForInjection) hitRecords.push({ collection: 'item', id: i.id });
    for (const r of merged) hitRecords.push({ collection: 'mem', id: r.memory.id });
    recordHits(chatId, hitRecords).catch(() => {});

    // 9. 构建注入文本
    const { text, tokenEstimate, stats } = buildMemoryInjectionPrompt({
        npcProfiles: npcForInjection,
        items: itemsForInjection,
        timeline: tlForInjection,
        relevantResults: merged,
        settings,
    });

    // 10. 注入
    const injectionText = (settings.injectionTemplate || '[BB-Memory 长期记忆]\n{{memories}}')
        .replace('{{memories}}', text);
    ctx.setExtensionPrompt(INJECTION_KEY, injectionText, POSITION_IN_CHAT, 4, ROLE_SYSTEM);

    if (settings.debugLogging) {
        console.log(`[BB-Memory] 注入: NPC${stats.npcCount} 物品${stats.itemCount} 时间线${stats.timelineCount} 记忆${stats.memoryCount} | ~${tokenEstimate} tokens`);
    }

    // 11. 存储命中追踪
    lastRetrievalResult = {
        chatId, timestamp: Date.now(),
        hits: merged.map(r => ({ id: r.memory.id, title: r.memory.title, type: r.memory.type, score: r.score, level: r.level })),
        stats,
    };

    // 12. Active 模式：显示审核面板
    if (settings.extractionConfirmMode === 'active' && settings.activeConfirmStyle === 'popup') {
        const pending = getPendingAutoCandidates();
        if (pending.length) {
            showFloatingReviewPanel(chatId, pending);
            clearPendingAutoCandidates();
        }
    }

    // 13. v4.4.3: 上下文隐藏 —— 清空已提取消息的 mes
    const hiddenBackups = [];
    for (const msg of chat) {
        if (msg._bbmem_extracted || msg._bbmem_hideSource === 'plugin') {
            hiddenBackups.push({ msg, mes: msg.mes });
            msg.mes = '';
        }
    }
    if (hiddenBackups.length) {
        setTimeout(() => {
            for (const { msg, mes } of hiddenBackups) msg.mes = mes;
        }, 100);
    }

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
    // 从 import.meta.url 解析扩展目录路径，不依赖 ST 核心模块
    try {
        const url = String(import.meta.url);
        let m = url.match(/\/scripts\/extensions\/(.+?)\/index\.mjs(?:\?|[#]|$)/i);
        if (!m) m = url.match(/\/scripts\/extensions\/(.+?)\/index\.js(?:\?|[#]|$)/i);
        if (!m) m = url.match(/\/scripts\/extensions\/(.+?)\/[^/]+\.(?:js|mjs)(?:\?|[#]|$)/i);
        if (m?.[1]) return m[1];
    } catch { /* ignore */ }
    // 回退：ST API
    try {
        const ctx = SillyTavern.getContext();
        const ext = ctx.extensions?.find(e => e.name === 'BB-Memory' || e.display_name === 'BB-Memory');
        if (ext) {
            if (typeof ext.getFolder === 'function') return ext.getFolder();
            return ext.baseFolder || ext.folder || '';
        }
    } catch { /* ignore */ }
    return 'third-party/BB-Memory';
}

// ═══════════════════════════════════════════════════════════
//  可折叠设置面板
// ═══════════════════════════════════════════════════════════

function initCollapsibleSettings() {
    document.querySelectorAll('.bb-settings-section-header').forEach(header => {
        header.addEventListener('click', () => {
            const section = header.closest('.bb-settings-section');
            const body = section?.querySelector('.bb-settings-section-body');
            const chevron = header.querySelector('.bb-settings-chevron i');
            if (body) {
                const isHidden = body.style.display === 'none';
                body.style.display = isHidden ? '' : 'none';
                if (chevron) {
                    chevron.className = isHidden ? 'fa-solid fa-chevron-down' : 'fa-solid fa-chevron-right';
                }
            }
        });
    });
}

// ═══════════════════════════════════════════════════════════
//  浮动控制中心（v5.0 合并版：旧版状态 + 新版功能）
// ═══════════════════════════════════════════════════════════

let _hubExtractStatus = '空闲';
let _hubExtractPct = '';

function setHubExtractStatus(status, pct) {
    _hubExtractStatus = status;
    _hubExtractPct = pct;
    const statusEl = document.getElementById('bb_hub_extract_status');
    const pctEl = document.getElementById('bb_hub_extract_pct');
    if (statusEl) statusEl.textContent = status;
    if (pctEl) pctEl.textContent = pct ? ` ${pct}` : '';
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
            <i class="fa-solid fa-brain"></i> BB-Memory v5.0
        </div>
        <div class="bb-floating-menu-body">
            <div class="bb-floating-menu-item" id="bb_hub_slot_info">
                <i class="fa-solid fa-floppy-disk"></i>
                <span>存档: <strong>default</strong> · <strong>0</strong> 条</span>
            </div>
            <div class="bb-floating-menu-item bb-floating-menu-action" id="bb_hub_hit_info" data-action="toggle_hit_list">
                <i class="fa-solid fa-bullseye"></i>
                <span>命中: <strong id="bb_hub_hit_count">-</strong> 条</span>
                <i class="fa-solid fa-chevron-down" style="margin-left:auto;font-size:0.7em;opacity:0.5;"></i>
            </div>
            <div id="bb_hub_hit_list" style="display:none;"></div>
            <div class="bb-floating-menu-item" id="bb_hub_extract_progress">
                <i class="fa-solid fa-robot"></i>
                <span id="bb_hub_extract_status">空闲</span><strong id="bb_hub_extract_pct"></strong>
            </div>
            <div style="border-top:1px solid var(--SmartThemeBorderColor,#444);margin:4px 0;"></div>
            <div class="bb-floating-menu-item bb-floating-menu-action" data-action="open_manager">
                <i class="fa-solid fa-list"></i>
                <span>记忆管家</span>
            </div>
            <div class="bb-floating-menu-item bb-floating-menu-action" data-action="init_memory">
                <i class="fa-solid fa-rocket"></i>
                <span>初始化记忆</span>
            </div>
            <div class="bb-floating-menu-item bb-floating-menu-action" data-action="backup">
                <i class="fa-solid fa-cloud-upload"></i>
                <span>备份</span>
            </div>
            <div class="bb-floating-menu-item bb-floating-menu-action" data-action="restore">
                <i class="fa-solid fa-cloud-download"></i>
                <span>恢复</span>
            </div>
            <div class="bb-floating-menu-item bb-floating-menu-action" data-action="maintenance">
                <i class="fa-solid fa-broom"></i>
                <span>维护</span>
            </div>
            <div class="bb-floating-menu-item bb-floating-menu-action" data-action="stats">
                <i class="fa-solid fa-chart-bar"></i>
                <span>统计</span>
            </div>
            <div style="border-top:1px solid var(--SmartThemeBorderColor,#444);margin:4px 0;"></div>
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
        </div>`;

    hub.appendChild(menu);
    document.body.appendChild(hub);

    // ── 拖拽逻辑 ──
    let dragging = false, startX = 0, startY = 0, startLeft = 0, startTop = 0;
    let hasMoved = false;

    hub.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        dragging = true; hasMoved = false;
        startX = e.clientX; startY = e.clientY;
        const rect = hub.getBoundingClientRect();
        startLeft = rect.left; startTop = rect.top;
        hub.style.transition = 'none';
        e.preventDefault();
    });
    hub.addEventListener('touchstart', (e) => {
        dragging = true; hasMoved = false;
        const t = e.touches[0];
        startX = t.clientX; startY = t.clientY;
        const rect = hub.getBoundingClientRect();
        startLeft = rect.left; startTop = rect.top;
        hub.style.transition = 'none';
    }, { passive: false });

    document.addEventListener('mousemove', (e) => {
        if (!dragging) return;
        const dx = e.clientX - startX, dy = e.clientY - startY;
        if (Math.abs(dx) > 3 || Math.abs(dy) > 3) hasMoved = true;
        let l = startLeft + dx, t = startTop + dy;
        l = Math.max(0, Math.min(window.innerWidth - hub.offsetWidth, l));
        t = Math.max(0, Math.min(window.innerHeight - hub.offsetHeight, t));
        hub.style.left = l + 'px'; hub.style.top = t + 'px';
    });
    document.addEventListener('touchmove', (e) => {
        if (!dragging) return;
        const t = e.touches[0];
        const dx = t.clientX - startX, dy = t.clientY - startY;
        if (Math.abs(dx) > 3 || Math.abs(dy) > 3) hasMoved = true;
        let l = startLeft + dx, t = startTop + dy;
        l = Math.max(0, Math.min(window.innerWidth - hub.offsetWidth, l));
        t = Math.max(0, Math.min(window.innerHeight - hub.offsetHeight, t));
        hub.style.left = l + 'px'; hub.style.top = t + 'px';
    }, { passive: false });

    const endDrag = () => { dragging = false; hub.style.transition = ''; };
    document.addEventListener('mouseup', endDrag);
    document.addEventListener('touchend', endDrag);

    // 点击：无拖拽则展开菜单
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
        if (action !== 'toggle_hit_list') {
            menu.style.display = 'none';
        }
    });

    // 点击外部关闭
    document.addEventListener('click', (e) => {
        if (!menu.contains(e.target) && e.target !== hub && !hub.contains(e.target)) {
            menu.style.display = 'none';
        }
    });

    // 定期刷新状态
    setInterval(() => refreshFloatingHubData(), 5000);
}

// ── 菜单切换 ──
function toggleFloatingMenu() {
    const menu = document.getElementById('bb_floating_menu');
    const hub = document.getElementById('bb_floating_hub');
    if (!menu || !hub) return;
    if (menu.style.display === 'none') {
        const hubRect = hub.getBoundingClientRect();
        const menuWidth = 268, menuMaxHeight = 320, gap = 56, edgeMargin = 16;
        if (hubRect.right + menuWidth > window.innerWidth - edgeMargin) {
            menu.style.left = 'auto'; menu.style.right = '0';
        } else {
            menu.style.right = 'auto'; menu.style.left = '0';
        }
        if (hubRect.top - menuMaxHeight - gap < edgeMargin) {
            menu.style.bottom = 'auto'; menu.style.top = gap + 'px';
        } else {
            menu.style.top = 'auto'; menu.style.bottom = gap + 'px';
        }
        menu.style.display = 'block';
        refreshFloatingHubData();
    } else {
        menu.style.display = 'none';
    }
}

// ── 状态刷新 ──
async function refreshFloatingHubData() {
    const chatId = getChatId();
    if (!chatId) return;

    // 更新存档信息
    const slotInfo = document.getElementById('bb_hub_slot_info');
    if (slotInfo) {
        try {
            const mems = await getMemories(chatId);
            const settings = getSettings();
            const slotName = settings.currentSlotName || 'default';
            slotInfo.innerHTML = `<i class="fa-solid fa-floppy-disk"></i> <span>存档: <strong>${escapeHtml(slotName)}</strong> · <strong>${mems.length}</strong> 条</span>`;
        } catch { /* ignore */ }
    }

    // 更新命中数
    const hitCountEl = document.getElementById('bb_hub_hit_count');
    const badge = document.getElementById('bb_hub_badge');
    if (hitCountEl || badge) {
        const result = lastRetrievalResult;
        const count = result?.hits?.length || 0;
        if (hitCountEl) hitCountEl.textContent = String(count);
        if (badge) {
            badge.textContent = count > 99 ? '99+' : String(count);
            badge.style.display = count > 0 ? 'flex' : 'none';
        }
    }

    // 更新可见性图标
    const toggleItem = document.querySelector('.bb-floating-menu-action[data-action="toggle_visibility"] i');
    if (toggleItem) {
        const showing = document.body.classList.contains('bb-show-extracted');
        toggleItem.className = showing ? 'fa-solid fa-eye' : 'fa-solid fa-eye-slash';
    }

    // 命中列表展开时同步刷新
    const hitList = document.getElementById('bb_hub_hit_list');
    if (hitList && hitList.style.display !== 'none') {
        renderHubHitList(hitList, chatId);
    }
}

// ── 命中列表渲染 ──
function renderHubHitItem(h, typeIcons, levelColors, dimmed) {
    const icon = typeIcons[h.type] || typeIcons[h.cognitiveType] || 'fa-circle';
    const color = levelColors[h.level] || '#888';
    const scorePct = Math.round((h.score || 0) * 100);
    const shortTitle = (h.title || '').length > 14
        ? escapeHtml(h.title.slice(0, 14)) + '...'
        : escapeHtml(h.title);
    const opacityStyle = dimmed ? 'opacity:0.55;' : '';
    return `<div class="bb-hub-hit-item" title="${escapeHtml(h.title)}" style="${opacityStyle}">
        <i class="fa-solid ${icon}" style="color:${color};font-size:0.7em;"></i>
        <span class="bb-hub-hit-title">${shortTitle}</span>
        <span class="bb-hub-hit-level" style="color:${color}">${h.level || ''}</span>
        <span class="bb-hub-hit-score">${scorePct}%</span>
    </div>`;
}

async function renderHubHitList(listEl, chatId) {
    const result = lastRetrievalResult;
    const typeIcons = { event: 'fa-film', emotion: 'fa-heart', habit: 'fa-repeat', fact: 'fa-lightbulb' };
    const levelColors = { core: '#ce93d8', eternal: '#ce93d8', stable: '#4fc3f7', transient: '#9e9e9e' };

    if (!result?.hits?.length) {
        listEl.innerHTML = '<div class="bb-hub-hit-item" style="opacity:0.5;justify-content:center;">暂无命中记忆</div>';
        return;
    }

    let html = result.hits.map(h => renderHubHitItem(h, typeIcons, levelColors, false)).join('');

    // 追加未命中的高分记忆
    try {
        const allMemories = await getMemories(chatId);
        const hitIds = new Set(result.hits.map(h => h.id));
        const nonHitMemories = allMemories.filter(m => !hitIds.has(m.id));
        nonHitMemories.sort((a, b) => (b.importance || 0) * (b.hitCount || 0) - (a.importance || 0) * (a.hitCount || 0));
        const top5 = nonHitMemories.slice(0, 5);
        if (top5.length > 0) {
            html += '<div class="bb-hub-hit-item" style="opacity:0.4;justify-content:center;font-size:0.7em;border-top:1px solid var(--SmartThemeBorderColor,#444);margin-top:2px;padding-top:4px;">— 未命中高分记忆 —</div>';
            html += top5.map(m => renderHubHitItem({
                id: m.id, title: m.title || (m.content || '').slice(0, 30),
                type: m.type || 'fact',
                score: (m.importance || 0) * ((m.hitCount || 0) / 10),
                level: m.memoryTier || 'transient',
            }, typeIcons, levelColors, true)).join('');
        }
    } catch { /* ignore */ }

    listEl.innerHTML = html;
}

// ── 菜单动作处理 ──
async function handleFloatingMenuAction(action) {
    const chatId = getChatId();
    switch (action) {
        case 'toggle_visibility': {
            document.body.classList.toggle('bb-show-extracted');
            const showing = document.body.classList.contains('bb-show-extracted');
            showToast(showing ? '已显示被隐藏的楼层' : '已隐藏已提取的楼层', 'info');
            break;
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
            try { ctx.saveChatDebounced(); } catch {}
            setTimeout(() => refreshExtractionMarkers(), 100);
            showToast(chat[aiIdx]._bbmem_meta_marker ? '已标记为元指令（不提取）' : '已标记为可提取', 'info');
            break;
        }
        case 'manual_extract': {
            if (!chatId) return;
            showToast('手动提取功能开发中，请使用记忆管家面板', 'info');
            break;
        }
        case 'open_manager': {
            if (chatId) openAssistant(chatId, 'dashboard');
            break;
        }
        case 'init_memory': {
            if (!chatId) { showToast('请先进入角色对话', 'warning'); return; }
            try {
                const results = await handleInitMemory(chatId);
                showToast(`初始化完成！NPC ${results.npc} / 物品 ${results.items} / 时间线 ${results.timeline} / 记忆 ${results.memories}`, 'success');
            } catch (e) {
                showToast(`初始化失败: ${e.message}`, 'error');
            }
            break;
        }
        case 'backup': {
            if (!chatId) return;
            const result = await exportMemoriesToChatMetadata(chatId);
            showToast(`备份完成：${result.count} 条`, 'success');
            break;
        }
        case 'restore': {
            if (!chatId) return;
            const result = await importMemoriesFromChatMetadata(chatId);
            showToast(`恢复：${result.restored} 条新增，${result.skipped} 条跳过`, 'success');
            break;
        }
        case 'maintenance': {
            if (!chatId) return;
            const result = await checkMaintenanceNeeded(chatId);
            if (result.needed) {
                showMaintenancePopup(chatId, buildMaintenanceHTML(result));
            } else {
                showToast('当前无需维护', 'info');
            }
            break;
        }
        case 'stats': {
            if (!chatId) return;
            const stats = await getMemoryStats(chatId);
            showToast(`NPC: ${stats.npc.total} | 物品: ${stats.items.total} | 时间线: ${stats.timeline.total} | 记忆: ${stats.memories.total}`, 'info');
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
            break;
        }
    }
}

// ═══════════════════════════════════════════════════════════
//  世界书导入（v5 适配）
// ═══════════════════════════════════════════════════════════

async function handleWorldBookImport(chatId, jsonString) {
    const { importWorldBook } = await import('./world-book-importer.js');
    return importWorldBook(chatId, jsonString);
}

async function handleWorldBookImportWithAI(chatId, jsonString) {
    const { importWorldBookWithAI } = await import('./world-book-importer.js');
    return importWorldBookWithAI(chatId, jsonString);
}

// ═══════════════════════════════════════════════════════════
//  初始化记忆（新功能）
// ═══════════════════════════════════════════════════════════

async function handleInitMemory(chatId) {
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

    // 聊天记录
    try {
        const chat = ctx.chat || [];
        const recent = chat.filter(m => m.mes?.trim()).slice(-8);
        if (recent.length) {
            contextText += `【最近对话】\n${recent.map(m => `${m.is_user ? '用户' : m.name || '角色'}: ${m.mes}`).join('\n')}`;
        }
    } catch { /* ignore */ }

    if (!contextText.trim()) {
        throw new Error('没有可用的上下文（角色卡、世界书、对话记录均为空）');
    }

    // 使用分阶段提取
    const settings = getSettings();
    const progressEl = createProgressToast('初始化记忆');
    const updateProgress = (info) => {
        if (progressEl) progressEl.textContent = `初始化记忆: ${info.progress || ''}`;
    };

    const results = await extractFromContext(chatId, contextText, { onProgress: updateProgress });

    if (progressEl) progressEl.remove();

    const msg = `初始化完成：\nNPC: ${results.npc} 个\n物品: ${results.items} 个\n时间线: ${results.timeline} 条\n记忆: ${results.memories} 条`;
    showToast(msg, 'success');
    return results;
}

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
    try {
        const ctx = SillyTavern.getContext();
        if (typeof ctx.toastr?.[type] === 'function') {
            ctx.toastr[type](msg, '', { timeOut: 3000 });
        }
    } catch { /* ignore */ }
}

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
            // 移除旧面板（如果存在）
            const existing = container.querySelector('#bb_memory_root');
            if (existing) existing.remove();
            container.insertAdjacentHTML('beforeend', html);
            return true;
        }
        await new Promise(r => setTimeout(r, delayMs));
    }
    console.warn('[BB-Memory] 未找到扩展设置容器');
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
    bindCheckbox('#bb_auto_gen_enabled', 'autoGenEnabled');
    bindCheckbox('#bb_embedding_enabled', 'embeddingEnabled');
    bindCheckbox('#bb_dedup_enabled', 'dedupEnabled');
    bindCheckbox('#bb_cluster_enabled', 'clusterEnabled');
    bindCheckbox('#bb_debug_logging', 'debugLogging');
    bindCheckbox('#bb_timeline_summary_enabled', 'timelineSummaryEnabled');
    bindCheckbox('#bb_auto_backup_enabled', 'autoBackupEnabled');

    // 选择器
    bindSelect('#bb_auto_gen_mode', 'autoGenMode');
    bindSelect('#bb_extraction_confirm_mode', 'extractionConfirmMode');
    bindSelect('#bb_active_confirm_style', 'activeConfirmStyle');

    // 数字/文本输入
    bindInput('#bb_token_budget', 'tokenBudget', 'number');
    bindInput('#bb_max_results', 'maxResults', 'number');
    bindInput('#bb_maintenance_mem_threshold', 'maintenanceMemThreshold', 'number');
    bindInput('#bb_maintenance_npc_threshold', 'maintenanceNpcThreshold', 'number');
    bindInput('#bb_maintenance_item_threshold', 'maintenanceItemThreshold', 'number');
    bindInput('#bb_diversity_limit', 'diversityLimitPerTag', 'number');
    bindInput('#bb_injection_template', 'injectionTemplate', 'string');
    bindInput('#bb_calendar_description', 'calendarDescription', 'string');

    // 按钮
    document.querySelector('#bb_memory_backup_now')?.addEventListener('click', async () => {
        const chatId = getChatId();
        if (!chatId) return;
        const result = await exportMemoriesToChatMetadata(chatId);
        showToast(`备份完成：${result.count} 条`, 'success');
    });
    document.querySelector('#bb_memory_restore_now')?.addEventListener('click', async () => {
        const chatId = getChatId();
        if (!chatId) return;
        const result = await importMemoriesFromChatMetadata(chatId);
        showToast(`恢复：${result.restored} 条新增，${result.skipped} 条跳过`, 'success');
    });
    document.querySelector('#bb_init_memory_btn')?.addEventListener('click', async () => {
        const chatId = getChatId();
        if (!chatId) { showToast('请先进入角色对话', 'warning'); return; }
        try {
            const results = await handleInitMemory(chatId);
            showToast(`初始化完成！NPC ${results.npc} / 物品 ${results.items} / 时间线 ${results.timeline} / 记忆 ${results.memories}`, 'success');
        } catch (e) {
            showToast(`初始化失败: ${e.message}`, 'error');
        }
    });
    document.querySelector('#bb_memory_import_wb_btn')?.addEventListener('click', () => {
        pickFile('.json', async (text) => {
            const chatId = getChatId();
            if (!chatId) return;
            const count = await handleWorldBookImport(chatId, text);
            showToast(`直接导入：${count} 条`, 'success');
        });
    });
    document.querySelector('#bb_memory_import_wb_ai_btn')?.addEventListener('click', () => {
        pickFile('.json', async (text) => {
            const chatId = getChatId();
            if (!chatId) return;
            try {
                const count = await handleWorldBookImportWithAI(chatId, text);
                showToast(`AI 导入：${count} 条`, 'success');
            } catch (e) {
                showToast(`AI 导入失败: ${e.message}`, 'error');
            }
        });
    });
    document.querySelector('#bb_memory_manage_btn')?.addEventListener('click', () => {
        const chatId = getChatId();
        if (chatId) openAssistant(chatId, 'dashboard');
    });
    document.querySelector('#bb_memory_maintenance_btn')?.addEventListener('click', async () => {
        const chatId = getChatId();
        if (!chatId) return;
        const result = await checkMaintenanceNeeded(chatId);
        if (result.needed) {
            const html = buildMaintenanceHTML(result);
            showMaintenancePopup(chatId, html);
        } else {
            showToast('当前无需维护', 'info');
        }
    });
    document.querySelector('#bb_embedding_reindex_btn')?.addEventListener('click', async () => {
        const chatId = getChatId();
        if (!chatId) return;
        const memories = await getMemories(chatId);
        await embedExistingMemories(memories, (done, total) => {
            if (done % 10 === 0) console.log(`[BB-Memory] Reindex: ${done}/${total}`);
        });
        showToast(`Reindex 完成：${memories.length} 条`, 'success');
    });
}

function bindCheckbox(selector, settingKey) {
    const el = document.querySelector(selector);
    if (!el) return;
    el.checked = getSettings()[settingKey];
    el.addEventListener('change', () => updateSettings({ [settingKey]: el.checked }));
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

function pickFile(accept, callback) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.style.display = 'none';
    input.addEventListener('change', () => {
        const file = input.files?.[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => callback(reader.result);
        reader.readAsText(file);
        input.remove();
    });
    document.body.appendChild(input);
    input.click();
}

function getChatId() {
    try {
        const ctx = SillyTavern.getContext();
        return ctx.chatId || (ctx.chat?.[0]?.chatId) || null;
    } catch { return null; }
}

function showMaintenancePopup(chatId, html) {
    const ctx = SillyTavern.getContext();
    if (typeof ctx.callPopup !== 'function') return;

    // 简化实现：将 HTML 嵌入确认弹窗
    const popup = document.createElement('div');
    popup.innerHTML = html;
    popup.style.maxHeight = '70vh';
    popup.style.overflowY = 'auto';

    // 绑定维护按钮事件
    popup.querySelectorAll('.bb-maint-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            const item = btn.closest('.bb-maint-item');
            const id = item?.dataset.id;
            const collection = item?.dataset.collection;
            const op = btn.dataset.op;
            if (id && collection && op) {
                await performMaintenance(chatId, [{ collection, id, op }]);
                item.remove();
            }
        });
    });
    popup.querySelector('.keep-all')?.addEventListener('click', async () => {
        const actions = [...popup.querySelectorAll('.bb-maint-item')].map(item => ({
            collection: item.dataset.collection,
            id: item.dataset.id,
            op: 'keep',
        }));
        await performMaintenance(chatId, actions);
        popup.querySelector('.bb-maint-items')?.remove();
        showToast('已全部保留', 'success');
    });
    popup.querySelector('.dismiss')?.addEventListener('click', () => {
        dismissMaintenanceRemind();
        showToast('已稍后提醒', 'info');
    });

    ctx.callPopup(popup.innerHTML, 'text');
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
        try {
            const results = await handleInitMemory(chatId);
            showToast(`初始化：NPC${results.npc}/物品${results.items}/时间线${results.timeline}/记忆${results.memories}`, 'success');
        } catch (e) {
            showToast(`初始化失败: ${e.message}`, 'error');
        }
    }, '初始化 BB-Memory 记忆（从角色卡+世界书+对话）');

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
        const result = await checkMaintenanceNeeded(chatId);
        if (result.needed) {
            showMaintenancePopup(chatId, buildMaintenanceHTML(result));
        } else {
            showToast('当前无需维护', 'info');
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
//  初始化
// ═══════════════════════════════════════════════════════════

let _bbInitialized = false;

async function init() {
    if (_bbInitialized) return;
    _bbInitialized = true;
    console.log('[BB-Memory] v5.0 初始化开始...');

    // 确保默认设置
    getSettings();

    // 挂载设置面板
    try {
        const folder = getExtensionFolder();
        const ctx = SillyTavern.getContext();
        if (typeof ctx.renderExtensionTemplateAsync === 'function') {
            const html = await ctx.renderExtensionTemplateAsync(folder, 'settings');
            if (html && typeof html === 'string' && html.trim()) {
                const mounted = await mountExtensionSettingsHtml(html);
                if (mounted) {
                    restoreApiSettings(getSettings());
                    bindSidebarEvents();
                    initCollapsibleSettings();
                    settingsPanelMounted = true;
                }
            }
        }
    } catch (e) {
        console.warn('[BB-Memory] 设置面板挂载失败:', e.message);
    }

    // 注入浮动控制中心
    injectFloatingHub();

    // 初始化自动生成器
    if (getSettings().autoGenEnabled) {
        initAutoGenerator();
    }

    // 进度回调（同时更新悬浮球状态）
    setAutoExtractProgressCallback((info) => {
        setHubExtractStatus(info.phase || '提取中...', info.progress || '');
        if (getSettings().debugLogging) {
            console.log(`[BB-Memory] 提取进度: ${info.phase} ${info.current}/${info.total}`);
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

    console.log('[BB-Memory] v5.0 初始化完成');
}

function refreshSidebar() {
    // 更新侧边栏记忆计数
    const updateCount = async () => {
        const chatId = getChatId();
        if (!chatId) return;
        try {
            const stats = await getMemoryStats(chatId);
            const total = stats.npc.total + stats.items.total + stats.timeline.total + stats.memories.total;
            const el = document.querySelector('#bb_memory_count');
            if (el) el.textContent = total;
        } catch { /* ignore */ }
    };
    updateCount();
    setInterval(updateCount, 30000); // 30秒刷新
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
(function startup() {
    const ctx = SillyTavern.getContext();
    const ev = ctx.event_types ?? ctx.eventTypes;

    if (ctx.eventSource && ev?.APP_READY) {
        // 用 on() 而非 once()：APP_READY 是 sticky 事件，on() 在事件已触发后仍会立即执行回调
        ctx.eventSource.on(ev.APP_READY, () => init());
    } else if (document.readyState === 'complete' || document.readyState === 'interactive') {
        init();
    } else {
        window.addEventListener('load', () => init());
    }
})();

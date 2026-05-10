/**
 * BISECT TEST 4 — 全量 imports + 常量 + 拦截器
 */
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

console.log('[BB-Memory] ✅ imports done');

// ═══ 常量 ═══
const INJECTION_KEY = 'bb_memory_injection';
const POSITION_IN_CHAT = 1;
const ROLE_SYSTEM = 0;

// ═══ 全局状态 ═══
let lastRetrievalResult = null;
let settingsPanelMounted = false;

console.log('[BB-Memory] ✅ constants done');

// ═══ 拦截器 ═══
function clearInjection() {
    try {
        SillyTavern.getContext().setExtensionPrompt(INJECTION_KEY, '', POSITION_IN_CHAT, 0, ROLE_SYSTEM);
    } catch { /* ignore */ }
}

globalThis.bbMemoryInterceptor = async function (chat, contextSize, abort, type) {
    if (type === 'quiet') return chat;

    const settings = getSettings();
    if (!settings.enabled) { clearInjection(); return chat; }

    const ctx = SillyTavern.getContext();
    const chatId = ctx.chatId || (ctx.chat?.[0]?.chatId) || null;
    if (!chatId) { clearInjection(); return chat; }

    let userMessage = '';
    for (let i = chat.length - 1; i >= 0; i--) {
        if (chat[i].is_user && chat[i].mes?.trim()) {
            userMessage = chat[i].mes.trim();
            break;
        }
    }
    if (!userMessage) { clearInjection(); return chat; }

    for (const msg of chat) {
        if ((msg._bbmem_extracted || msg._bbmem_hideSource === 'plugin') && !msg.is_hidden) {
            msg.is_hidden = true;
            msg._bbmem_hideSource = 'plugin';
        }
    }

    if (!settings.migratedFromV4) {
        try { await migrateV4ToV5(chatId); } catch (e) { /* ignore */ }
    }

    const [npc, items, timeline, memories] = await Promise.all([
        getNpcProfiles(chatId), getItems(chatId), getTimeline(chatId), getMemories(chatId),
    ]);

    const hasData = npc.length + items.length + timeline.length + memories.length > 0;
    if (!hasData) { clearInjection(); return chat; }

    try { await checkDemotions(chatId); } catch (e) { /* ignore */ }

    let queryEmbedding = null;
    if (settings.embeddingEnabled && settings.embeddingEndpoint) {
        try { queryEmbedding = await callEmbeddingApi(userMessage, 3000); } catch { /* ignore */ }
    }

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

    const hitRecords = [];
    for (const n of npcForInjection) hitRecords.push({ collection: 'npc', id: n.id });
    for (const i of itemsForInjection) hitRecords.push({ collection: 'item', id: i.id });
    for (const r of merged) hitRecords.push({ collection: 'mem', id: r.memory.id });
    recordHits(chatId, hitRecords).catch(() => {});

    const { text, tokenEstimate, stats } = buildMemoryInjectionPrompt({
        npcProfiles: npcForInjection,
        items: itemsForInjection,
        timeline: tlForInjection,
        relevantResults: merged,
        settings,
    });

    const injectionText = (settings.injectionTemplate || '[BB-Memory 长期记忆]\n{{memories}}')
        .replace('{{memories}}', text);
    ctx.setExtensionPrompt(INJECTION_KEY, injectionText, POSITION_IN_CHAT, 4, ROLE_SYSTEM);

    if (settings.debugLogging) {
        console.log(`[BB-Memory] 注入: NPC${stats.npcCount} 物品${stats.itemCount} 时间线${stats.timelineCount} 记忆${stats.memoryCount} | ~${tokenEstimate} tokens`);
    }

    lastRetrievalResult = {
        chatId, timestamp: Date.now(),
        hits: merged.map(r => ({ id: r.memory.id, title: r.memory.title, type: r.memory.type, score: r.score, level: r.level })),
        stats,
    };

    if (settings.extractionConfirmMode === 'active' && settings.activeConfirmStyle === 'popup') {
        const pending = getPendingAutoCandidates();
        if (pending.length) {
            const ctx2 = SillyTavern.getContext();
            const lines = pending.slice(0, 5).map((c, i) =>
                `${i + 1}. [${c.type || 'event'}] ${c.title || c.summary?.slice(0, 40) || '(无标题)'}`
            ).join('\n');
            if (typeof ctx2.callPopup === 'function') {
                ctx2.callPopup(`[BB-Memory] 提取到 ${pending.length} 条候选记忆：\n${lines}\n是否保存？`, 'confirm')
                    .then(result => {
                        if (result) saveExtractedMemories(chatId, pending.map(c => ({ ...c, _selected: true })));
                    });
            }
            clearPendingAutoCandidates();
        }
    }

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

console.log('[BB-Memory] ✅ interceptor defined');
console.log('[BB-Memory] ✅ TEST 4 完成 — 全量 imports + 拦截器');

// ═══ UI 辅助（测试追加） ═══
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = String(text || '');
    return div.innerHTML;
}

function getExtensionFolder() {
    try {
        const url = String(import.meta.url);
        let m = url.match(/\/scripts\/extensions\/(.+?)\/index\.mjs(?:\?|[#]|$)/i);
        if (!m) m = url.match(/\/scripts\/extensions\/(.+?)\/index\.js(?:\?|[#]|$)/i);
        if (!m) m = url.match(/\/scripts\/extensions\/(.+?)\/[^/]+\.(?:js|mjs)(?:\?|[#]|$)/i);
        if (m?.[1]) return m[1];
    } catch { /* ignore */ }
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

console.log('[BB-Memory] ✅ TEST 5A — UI helpers added');

// ═══ 浮动控制中心 ═══
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
    const menu = document.createElement('div');
    menu.id = 'bb_floating_menu';
    menu.className = 'bb-floating-menu';
    menu.style.display = 'none';
    menu.innerHTML = '<div class="bb-floating-menu-header"><i class="fa-solid fa-brain"></i> BB-Memory v5.0</div><div class="bb-floating-menu-body"><div class="bb-floating-menu-item" id="bb_hub_slot_info"><i class="fa-solid fa-floppy-disk"></i><span>存档: <strong>default</strong> · <strong>0</strong> 条</span></div><div class="bb-floating-menu-item bb-floating-menu-action" id="bb_hub_hit_info" data-action="toggle_hit_list"><i class="fa-solid fa-bullseye"></i><span>命中: <strong id="bb_hub_hit_count">-</strong> 条</span><i class="fa-solid fa-chevron-down" style="margin-left:auto;font-size:0.7em;opacity:0.5;"></i></div><div id="bb_hub_hit_list" style="display:none;"></div><div class="bb-floating-menu-item" id="bb_hub_extract_progress"><i class="fa-solid fa-robot"></i><span id="bb_hub_extract_status">空闲</span><strong id="bb_hub_extract_pct"></strong></div><div style="border-top:1px solid var(--SmartThemeBorderColor,#444);margin:4px 0;"></div><div class="bb-floating-menu-item bb-floating-menu-action" data-action="open_manager"><i class="fa-solid fa-list"></i><span>记忆管家</span></div><div class="bb-floating-menu-item bb-floating-menu-action" data-action="init_memory"><i class="fa-solid fa-rocket"></i><span>初始化记忆</span></div><div class="bb-floating-menu-item bb-floating-menu-action" data-action="backup"><i class="fa-solid fa-cloud-upload"></i><span>备份</span></div><div class="bb-floating-menu-item bb-floating-menu-action" data-action="restore"><i class="fa-solid fa-cloud-download"></i><span>恢复</span></div><div class="bb-floating-menu-item bb-floating-menu-action" data-action="maintenance"><i class="fa-solid fa-broom"></i><span>维护</span></div><div class="bb-floating-menu-item bb-floating-menu-action" data-action="stats"><i class="fa-solid fa-chart-bar"></i><span>统计</span></div><div style="border-top:1px solid var(--SmartThemeBorderColor,#444);margin:4px 0;"></div><div class="bb-floating-menu-item bb-floating-menu-action" data-action="toggle_visibility"><i class="fa-solid fa-eye-slash"></i><span>切换楼层可见</span></div><div class="bb-floating-menu-item bb-floating-menu-action" data-action="meta_last"><i class="fa-solid fa-tag"></i><span>标记最后消息</span></div><div class="bb-floating-menu-item bb-floating-menu-action" data-action="manual_extract"><i class="fa-solid fa-wand-magic-sparkles"></i><span>手动提取</span></div></div>';
    hub.appendChild(menu);
    document.body.appendChild(hub);
    let dragging = false, startX = 0, startY = 0, startLeft = 0, startTop = 0, hasMoved = false;
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
    hub.addEventListener('click', (e) => {
        if (hasMoved) { e.preventDefault(); e.stopPropagation(); return; }
        if (menu.contains(e.target)) return;
        toggleFloatingMenu();
    });
    menu.addEventListener('click', async (e) => {
        const actionItem = e.target.closest('.bb-floating-menu-action');
        if (!actionItem) return;
        const action = actionItem.dataset.action;
        await handleFloatingMenuAction(action);
        if (action !== 'toggle_hit_list') menu.style.display = 'none';
    });
    document.addEventListener('click', (e) => {
        if (!menu.contains(e.target) && e.target !== hub && !hub.contains(e.target)) {
            menu.style.display = 'none';
        }
    });
    setInterval(() => refreshFloatingHubData(), 5000);
}

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

async function refreshFloatingHubData() {
    const chatId = getChatId();
    if (!chatId) return;
    const slotInfo = document.getElementById('bb_hub_slot_info');
    if (slotInfo) {
        try {
            const mems = await getMemories(chatId);
            const settings = getSettings();
            const slotName = settings.currentSlotName || 'default';
            slotInfo.innerHTML = '<i class="fa-solid fa-floppy-disk"></i> <span>存档: <strong>' + escapeHtml(slotName) + '</strong> · <strong>' + mems.length + '</strong> 条</span>';
        } catch { /* ignore */ }
    }
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
    const toggleItem = document.querySelector('.bb-floating-menu-action[data-action="toggle_visibility"] i');
    if (toggleItem) {
        const showing = document.body.classList.contains('bb-show-extracted');
        toggleItem.className = showing ? 'fa-solid fa-eye' : 'fa-solid fa-eye-slash';
    }
    const hitList = document.getElementById('bb_hub_hit_list');
    if (hitList && hitList.style.display !== 'none') {
        renderHubHitList(hitList, chatId);
    }
}

function renderHubHitItem(h, typeIcons, levelColors, dimmed) {
    const icon = typeIcons[h.type] || typeIcons[h.cognitiveType] || 'fa-circle';
    const color = levelColors[h.level] || '#888';
    const scorePct = Math.round((h.score || 0) * 100);
    const shortTitle = (h.title || '').length > 14 ? escapeHtml(h.title.slice(0, 14)) + '...' : escapeHtml(h.title);
    const opacityStyle = dimmed ? 'opacity:0.55;' : '';
    return '<div class="bb-hub-hit-item" title="' + escapeHtml(h.title) + '" style="' + opacityStyle + '"><i class="fa-solid ' + icon + '" style="color:' + color + ';font-size:0.7em;"></i><span class="bb-hub-hit-title">' + shortTitle + '</span><span class="bb-hub-hit-level" style="color:' + color + '">' + (h.level || '') + '</span><span class="bb-hub-hit-score">' + scorePct + '%</span></div>';
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
    try {
        const allMemories = await getMemories(chatId);
        const hitIds = new Set(result.hits.map(h => h.id));
        const nonHitMemories = allMemories.filter(m => !hitIds.has(m.id));
        nonHitMemories.sort((a, b) => (b.importance || 0) * (b.hitCount || 0) - (a.importance || 0) * (a.hitCount || 0));
        const top5 = nonHitMemories.slice(0, 5);
        if (top5.length > 0) {
            html += '<div class="bb-hub-hit-item" style="opacity:0.4;justify-content:center;font-size:0.7em;border-top:1px solid var(--SmartThemeBorderColor,#444);margin-top:2px;padding-top:4px;">— 未命中高分记忆 —</div>';
            html += top5.map(m => renderHubHitItem({ id: m.id, title: m.title || (m.content || '').slice(0, 30), type: m.type || 'fact', score: (m.importance || 0) * ((m.hitCount || 0) / 10), level: m.memoryTier || 'transient' }, typeIcons, levelColors, true)).join('');
        }
    } catch { /* ignore */ }
    listEl.innerHTML = html;
}

// 前置声明（handleFloatingMenuAction 引用的函数稍后定义）
function getChatId() {
    try { const ctx = SillyTavern.getContext(); return ctx.chatId || (ctx.chat?.[0]?.chatId) || null; } catch { return null; }
}
function showToast(msg, type) {
    try { const ctx = SillyTavern.getContext(); if (typeof ctx.toastr?.[type || 'info'] === 'function') ctx.toastr[type || 'info'](msg, '', { timeOut: 3000 }); } catch { /* ignore */ }
}
function showMaintenancePopup(chatId, html) {
    const ctx = SillyTavern.getContext();
    if (typeof ctx.callPopup !== 'function') return;
    ctx.callPopup(html, 'text');
}

async function handleFloatingMenuAction(action) {
    const chatId = getChatId();
    switch (action) {
        case 'toggle_visibility':
            document.body.classList.toggle('bb-show-extracted');
            showToast(document.body.classList.contains('bb-show-extracted') ? '已显示被隐藏的楼层' : '已隐藏已提取的楼层', 'info');
            break;
        case 'meta_last': {
            const ctx = SillyTavern.getContext();
            const chat = ctx.chat;
            if (!chat || chat.length < 2) { showToast('聊天消息不足', 'warning'); return; }
            let aiIdx = -1;
            for (let i = chat.length - 1; i >= 0; i--) { if (!chat[i].is_user && !chat[i].is_system) { aiIdx = i; break; } }
            if (aiIdx === -1) { showToast('未找到 AI 消息', 'warning'); return; }
            chat[aiIdx]._bbmem_meta_marker = !chat[aiIdx]._bbmem_meta_marker;
            try { ctx.saveChatDebounced(); } catch {}
            setTimeout(() => refreshExtractionMarkers(), 100);
            showToast(chat[aiIdx]._bbmem_meta_marker ? '已标记为元指令（不提取）' : '已标记为可提取', 'info');
            break;
        }
        case 'manual_extract': if (chatId) showToast('手动提取功能开发中，请使用记忆管家面板', 'info'); break;
        case 'open_manager': if (chatId) openAssistant(chatId, 'dashboard'); break;
        case 'backup': if (chatId) { const r = await exportMemoriesToChatMetadata(chatId); showToast('备份完成：' + r.count + ' 条', 'success'); } break;
        case 'restore': if (chatId) { const r = await importMemoriesFromChatMetadata(chatId); showToast('恢复：' + r.restored + ' 条新增', 'success'); } break;
        case 'maintenance': if (chatId) { const r = await checkMaintenanceNeeded(chatId); if (r.needed) showMaintenancePopup(chatId, buildMaintenanceHTML(r)); else showToast('当前无需维护', 'info'); } break;
        case 'stats': if (chatId) { const s = await getMemoryStats(chatId); showToast('NPC: ' + s.npc.total + ' | 物品: ' + s.items.total + ' | 时间线: ' + s.timeline.total + ' | 记忆: ' + s.memories.total, 'info'); } break;
        case 'toggle_hit_list': {
            const hitList = document.getElementById('bb_hub_hit_list');
            const hitRow = document.getElementById('bb_hub_hit_info');
            if (!hitList || !hitRow) return;
            const chevron = hitRow.querySelector('.fa-chevron-down, .fa-chevron-up');
            if (hitList.style.display === 'none') { renderHubHitList(hitList, chatId); hitList.style.display = ''; if (chevron) chevron.className = 'fa-solid fa-chevron-up'; }
            else { hitList.style.display = 'none'; if (chevron) chevron.className = 'fa-solid fa-chevron-down'; }
            break;
        }
    }
}

console.log('[BB-Memory] ✅ TEST 5B — Hub code added');

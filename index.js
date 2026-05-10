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

// TEST 5B-1: 仅变量声明
let _hubExtractStatus = '空闲';
let _hubExtractPct = '';
console.log('[BB-Memory] ✅ TEST 5B-1 — Hub variables');

// TEST 5B-3: setHubExtractStatus + 完整 injectFloatingHub（单行HTML，无模板字面量）
function setHubExtractStatus(status, pct) {
    _hubExtractStatus = status;
    _hubExtractPct = pct;
    const statusEl = document.getElementById('bb_hub_extract_status');
    const pctEl = document.getElementById('bb_hub_extract_pct');
    if (statusEl) statusEl.textContent = status;
    if (pctEl) pctEl.textContent = pct ? ' ' + pct : '';
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
    menu.innerHTML = '<div class="bb-floating-menu-header"><i class="fa-solid fa-brain"></i> BB-Memory v5.0</div><div class="bb-floating-menu-body"><div class="bb-floating-menu-item" id="bb_hub_slot_info"><i class="fa-solid fa-floppy-disk"></i><span>存档: <strong>default</strong> - <strong>0</strong> 条</span></div><div class="bb-floating-menu-item bb-floating-menu-action" id="bb_hub_hit_info" data-action="toggle_hit_list"><i class="fa-solid fa-bullseye"></i><span>命中: <strong id="bb_hub_hit_count">-</strong> 条</span><i class="fa-solid fa-chevron-down" style="margin-left:auto;font-size:0.7em;opacity:0.5;"></i></div><div id="bb_hub_hit_list" style="display:none;"></div><div class="bb-floating-menu-item" id="bb_hub_extract_progress"><i class="fa-solid fa-robot"></i><span id="bb_hub_extract_status">空闲</span><strong id="bb_hub_extract_pct"></strong></div><div style="border-top:1px solid var(--SmartThemeBorderColor,#444);margin:4px 0;"></div><div class="bb-floating-menu-item bb-floating-menu-action" data-action="open_manager"><i class="fa-solid fa-list"></i><span>记忆管家</span></div><div class="bb-floating-menu-item bb-floating-menu-action" data-action="init_memory"><i class="fa-solid fa-rocket"></i><span>初始化记忆</span></div><div class="bb-floating-menu-item bb-floating-menu-action" data-action="backup"><i class="fa-solid fa-cloud-upload"></i><span>备份</span></div><div class="bb-floating-menu-item bb-floating-menu-action" data-action="restore"><i class="fa-solid fa-cloud-download"></i><span>恢复</span></div><div class="bb-floating-menu-item bb-floating-menu-action" data-action="maintenance"><i class="fa-solid fa-broom"></i><span>维护</span></div><div class="bb-floating-menu-item bb-floating-menu-action" data-action="stats"><i class="fa-solid fa-chart-bar"></i><span>统计</span></div><div style="border-top:1px solid var(--SmartThemeBorderColor,#444);margin:4px 0;"></div><div class="bb-floating-menu-item bb-floating-menu-action" data-action="toggle_visibility"><i class="fa-solid fa-eye-slash"></i><span>切换楼层可见</span></div><div class="bb-floating-menu-item bb-floating-menu-action" data-action="meta_last"><i class="fa-solid fa-tag"></i><span>标记最后消息</span></div><div class="bb-floating-menu-item bb-floating-menu-action" data-action="manual_extract"><i class="fa-solid fa-wand-magic-sparkles"></i><span>手动提取</span></div></div>';

console.log('[BB-Memory] ✅ TEST 5B-CONFIRM — single-quote HTML (NO backtick)');
    hub.appendChild(menu);
    document.body.appendChild(hub);
    let dragging = false, startX = 0, startY = 0, startLeft = 0, startTop = 0, hasMoved = false;
    hub.addEventListener('mousedown', function (e) {
        if (e.button !== 0) return;
        dragging = true; hasMoved = false;
        startX = e.clientX; startY = e.clientY;
        var rect = hub.getBoundingClientRect();
        startLeft = rect.left; startTop = rect.top;
        hub.style.transition = 'none';
        e.preventDefault();
    });
    hub.addEventListener('touchstart', function (e) {
        dragging = true; hasMoved = false;
        var t = e.touches[0];
        startX = t.clientX; startY = t.clientY;
        var rect = hub.getBoundingClientRect();
        startLeft = rect.left; startTop = rect.top;
        hub.style.transition = 'none';
    }, { passive: false });
    document.addEventListener('mousemove', function (e) {
        if (!dragging) return;
        var dx = e.clientX - startX, dy = e.clientY - startY;
        if (Math.abs(dx) > 3 || Math.abs(dy) > 3) hasMoved = true;
        var l = startLeft + dx, t = startTop + dy;
        l = Math.max(0, Math.min(window.innerWidth - hub.offsetWidth, l));
        t = Math.max(0, Math.min(window.innerHeight - hub.offsetHeight, t));
        hub.style.left = l + 'px'; hub.style.top = t + 'px';
    });
    document.addEventListener('touchmove', function (e) {
        if (!dragging) return;
        var t = e.touches[0];
        var dx = t.clientX - startX, dy = t.clientY - startY;
        if (Math.abs(dx) > 3 || Math.abs(dy) > 3) hasMoved = true;
        var l = startLeft + dx, t = startTop + dy;
        l = Math.max(0, Math.min(window.innerWidth - hub.offsetWidth, l));
        t = Math.max(0, Math.min(window.innerHeight - hub.offsetHeight, t));
        hub.style.left = l + 'px'; hub.style.top = t + 'px';
    }, { passive: false });
    var endDrag = function () { dragging = false; hub.style.transition = ''; };
    document.addEventListener('mouseup', endDrag);
    document.addEventListener('touchend', endDrag);
    hub.addEventListener('click', function (e) {
        if (hasMoved) { e.preventDefault(); e.stopPropagation(); return; }
        if (menu.contains(e.target)) return;
        toggleFloatingMenu();
    });
    menu.addEventListener('click', async function (e) {
        var actionItem = e.target.closest('.bb-floating-menu-action');
        if (!actionItem) return;
        var action = actionItem.dataset.action;
        await handleFloatingMenuAction(action);
        if (action !== 'toggle_hit_list') menu.style.display = 'none';
    });
    document.addEventListener('click', function (e) {
        if (!menu.contains(e.target) && e.target !== hub && !hub.contains(e.target)) {
            menu.style.display = 'none';
        }
    });
    setInterval(function () { refreshFloatingHubData(); }, 5000);
}

// 占位桩函数（injectFloatingHub 引用但稍后完整定义）
function toggleFloatingMenu() {}
async function refreshFloatingHubData() {}
async function handleFloatingMenuAction(action) {}

console.log('[BB-Memory] ✅ TEST 5B-3 — injectFloatingHub (no template literals, no arrow funcs)');
